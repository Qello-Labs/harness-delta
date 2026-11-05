import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { ingestClaudeTraceBatch } from '../src/claude-trace-candidate.js';
import { Store } from '../src/store.js';
import { lookupFileProfile } from '../src/adapter-profiles.js';
import { productionCostProfiles } from '../src/cost-coverage.js';
import { attrs, receivedAt, seedTraceScope, span, startedAt, traceScope, traces } from './helpers/claude-trace-fixture.js';

const window = { startedAt, receivedAt, generation: 0 };
test.each([undefined, '0', 0])('unfinished span end %s retains completed companion usage and records an incomplete gap', endTimeUnixNano => {
  const { store, ingest } = fixture();
  try {
    expect(ingest(traces([span(), { ...span(true), endTimeUnixNano }]))).toMatchObject({ requests: 1, inserted: 1, unattributed: 1 });
    expect(store.eventCount()).toBe(1);
    expect(store.all('SELECT reason FROM observation_gaps')).toContainEqual({ reason: 'incomplete' });
  } finally {
    store.close();
  }
});
function fixture() {
  const store = new Store(':memory:');
  seedTraceScope(store);
  const ingest = (input: unknown) => ingestClaudeTraceBatch(store, traceScope, () => input, window);
  return { store, ingest };
}
test('synthetic OTLP bridge attributes root/child once and records unknown continuity', () => {
  const { store, ingest } = fixture();
  try {
    expect(ingest(traces())).toEqual({ requests: 2, inserted: 2, excluded: 0, unattributed: 0 });
    expect(ingest(traces())).toMatchObject({ inserted: 0 });
    expect(store.eventCount()).toBe(2);
    const events = store.all<{ session_id: string; payload: string }>('SELECT session_id,payload FROM events');
    expect(events.map(e => e.session_id).sort()).toEqual(['child', 'root']);
    for (const e of events)
      expect(JSON.parse(e.payload)).toMatchObject({
        input_total: { value: 60 },
        cached_input: { value: 20 },
        output_total: { value: 15 },
        reasoning_output: { status: 'missing' }
      });
    const runtimes = store.all<{ payload: string }>('SELECT payload FROM runtime_evidence').map(r => JSON.parse(r.payload) as { effort: string | null });
    expect(runtimes.map(r => r.effort).sort()).toEqual(['high', null].sort());
    expect(store.all('SELECT reason FROM observation_gaps')).toEqual([{ reason: 'not_available' }]);
    expect(lookupFileProfile('claude_code', '2.1.288')).toBe('unsupported');
    expect(productionCostProfiles).toEqual([]);
  } finally {
    store.close();
  }
});
test('missing cache and effort stay missing while observed zeros remain zeros', () => {
  const { store, ingest } = fixture();
  try {
    ingest(traces([span(false, { input_tokens: 0, output_tokens: 0, cache_read_tokens: undefined, cache_creation_tokens: undefined, effort: undefined })]));
    const row = store.get<{ payload: string }>('SELECT payload FROM events')!;
    expect(JSON.parse(row.payload)).toMatchObject({
      input_total: { status: 'missing', value: null },
      output_total: { status: 'observed', value: 0 },
      cached_input: { status: 'missing', value: null }
    });
  } finally {
    store.close();
  }
});
test.each([
  { 'app.version': '2.1.283' },
  { 'harness_delta.process_id': 'foreign' },
  { 'session.id': 'foreign' },
  { input_tokens: -1 },
  { input_tokens: Number.MAX_SAFE_INTEGER + 1 },
  { cache_read_tokens: 1.5 },
  { effort: 'PRIVATE SECRET' }
])('malformed or contradictory known metadata fails closed: %j', patch => {
  const { store, ingest } = fixture();
  try {
    expect(() => ingest(traces([span(false, patch)]))).toThrow();
    expect(store.eventCount()).toBe(0);
  } finally {
    store.close();
  }
});
test('unmapped child and failed/retried spans never become root requests', () => {
  const { store, ingest } = fixture();
  try {
    expect(
      ingest(traces([span(true, { agent_id: 'unmapped' }), span(false, { success: false, request_id: undefined }), span(false, { attempt: 2 })]))
    ).toMatchObject({ requests: 0, inserted: 0, unattributed: 3 });
    expect(store.eventCount()).toBe(0);
    expect(store.all<{ reason: string }>('SELECT reason FROM observation_gaps').map(r => r.reason)).toContain('unknown_parent');
  } finally {
    store.close();
  }
});
test('later conflict rolls back earlier usage and every new gap', () => {
  const { store, ingest } = fixture();
  try {
    expect(() => ingest(traces([span(), span(true, { request_id: 'request-root' })]))).toThrow('candidate_conflict');
    expect(store.eventCount()).toBe(0);
    expect(store.all('SELECT * FROM runtime_evidence')).toEqual([]);
    expect(store.all('SELECT * FROM observation_gaps')).toEqual([]);
  } finally {
    store.close();
  }
});
test('private span/resource values and unrelated spans never persist', () => {
  const { store, ingest } = fixture();
  try {
    const s = span(false, {
      prompt: 'PRIVATE_SENTINEL',
      response: 'PRIVATE_SENTINEL',
      error: 'PRIVATE_SENTINEL',
      'user.email': 'PRIVATE_SENTINEL',
      query_source: 'PRIVATE_SENTINEL'
    });
    const body = traces([s, { ...span(), name: 'claude_code.tool', attributes: attrs({ tool_parameters: 'PRIVATE_SENTINEL' }) }]);
    ingest(body);
    expect(store.eventCount()).toBe(1);
    expect(
      JSON.stringify(store.all('SELECT payload FROM events')) +
        JSON.stringify(store.all('SELECT payload FROM runtime_evidence')) +
        JSON.stringify(store.all('SELECT * FROM observation_gaps'))
    ).not.toContain('PRIVATE_SENTINEL');
  } finally {
    store.close();
  }
});
test('invalid OTLP identity, timestamps and duplicate attributes reject the full batch', () => {
  const { store, ingest } = fixture();
  try {
    const s = span();
    for (const patch of [
      { traceId: 'bad' },
      { spanId: '0'.repeat(16) },
      { endTimeUnixNano: 'bad' },
      { startTimeUnixNano: s.endTimeUnixNano },
      { attributes: [...s.attributes, s.attributes[0]!] }
    ]) {
      expect(() => ingest(traces([{ ...s, ...patch }]))).toThrow('claude_trace_invalid_metadata');
    }
    expect(store.eventCount()).toBe(0);
  } finally {
    store.close();
  }
});
test('authorization, generation and explicit source validation precede read callback', () => {
  const { store } = fixture();
  let reads = 0;
  const read = () => {
    reads++;
    return traces();
  };
  try {
    for (const patch of [{ generation: 1 }, { receivedAt: startedAt, startedAt: receivedAt }])
      expect(() => ingestClaudeTraceBatch(store, traceScope, read, { ...window, ...patch })).toThrow();
    store.execute("INSERT INTO tombstones(kind,id,deleted_at) VALUES ('session','child',?)", [receivedAt]);
    expect(() => ingestClaudeTraceBatch(store, traceScope, read, window)).toThrow('candidate_inactive_scope');
    expect(reads).toBe(0);
  } finally {
    store.close();
  }
});
test('revocation during read and callback errors are sanitized', () => {
  const { store } = fixture();
  try {
    expect(() =>
      ingestClaudeTraceBatch(
        store,
        traceScope,
        () => {
          throw new Error('PRIVATE_SENTINEL');
        },
        window
      )
    ).toThrow(/^claude_trace_source_error$/);
    expect(() =>
      ingestClaudeTraceBatch(
        store,
        traceScope,
        () => {
          store.execute("UPDATE tasks SET generation=1 WHERE id='task-1'", []);
          return traces();
        },
        window
      )
    ).toThrow('claude_trace_scope_revoked');
    expect(store.eventCount()).toBe(0);
  } finally {
    store.close();
  }
});
test('old/future request intervals are excluded; restart never backfills unobserved requests', () => {
  const { store, ingest } = fixture();
  try {
    expect(
      ingest(
        traces([
          { ...span(), startTimeUnixNano: '1767225599000000000' },
          { ...span(true), endTimeUnixNano: '1767225604000000000' }
        ])
      )
    ).toMatchObject({ excluded: 2, inserted: 0 });
    expect(store.eventCount()).toBe(0);
    expect(store.all('SELECT reason FROM observation_gaps')).toContainEqual({ reason: 'offline' });
  } finally {
    store.close();
  }
});
test('provider identity replay survives database reopen without log accounting', () => {
  const root = mkdtempSync(join(tmpdir(), 'claude-trace-replay-'));
  const path = join(root, 'fixture.sqlite');
  let store = new Store(path);
  try {
    seedTraceScope(store);
    ingestClaudeTraceBatch(store, traceScope, () => traces(), window);
    store.close();
    store = new Store(path);
    expect(ingestClaudeTraceBatch(store, traceScope, () => traces(), window)).toMatchObject({ inserted: 0 });
    expect(store.eventCount()).toBe(2);
  } finally {
    store.close();
    rmSync(root, { force: true, recursive: true });
  }
});

test('OTLP omitted default UNSET status accepts success while invalid explicit status does not', () => {
  const { store, ingest } = fixture();
  try {
    expect(ingest(traces([{ ...span(), status: undefined }]))).toMatchObject({ inserted: 1 });
    for (const status of [null, { code: 'ERROR' }, { code: null }, { code: -1 }]) {
      expect(() => ingest(traces([{ ...span(true), status }]))).toThrow('claude_trace_invalid_metadata');
    }
    expect(store.eventCount()).toBe(1);
  } finally {
    store.close();
  }
});
test('unknown/malformed process mapping never reads the payload; source channel collision blocks access', () => {
  const { store } = fixture();
  let reads = 0;
  const read = () => {
    reads++;
    return traces();
  };
  try {
    const foreign = { ...traceScope, sessions: traceScope.sessions.map(s => ({ ...s, product: 'codex' as const })) };
    expect(() => ingestClaudeTraceBatch(store, foreign, read, window)).toThrow();
    store.execute(
      "INSERT INTO otel_processes(id,run_id,project_id,task_id,launch_session_id,product,product_version,profile_id,generation,state,ordering,started_at,updated_at) VALUES ('p','r','project-1','task-1','root','claude_code','2.1.288','synthetic-profile',0,'listening','pending',?,?)",
      [startedAt, startedAt]
    );
    expect(() => ingestClaudeTraceBatch(store, traceScope, read, window)).toThrow('candidate_mixed_sources');
    expect(reads).toBe(0);
  } finally {
    store.close();
  }
});

test('OTLP safe numeric intValue and integral doubleValue counters conform without unsafe coercion', () => {
  const { store, ingest } = fixture();
  try {
    const s = span();
    s.attributes = s.attributes.map(a =>
      a.key === 'input_tokens' ? { key: a.key, value: { intValue: 30 } } : a.key === 'output_tokens' ? { key: a.key, value: { doubleValue: 15 } } : a
    );
    expect(ingest(traces([s]))).toMatchObject({ inserted: 1 });
    expect(store.eventCount()).toBe(1);
  } finally {
    store.close();
  }
});
test('ambiguous OTLP AnyValue leaf types are rejected rather than resolved by precedence', () => {
  const { store, ingest } = fixture();
  try {
    const s = span();
    const attributes = s.attributes.map(a => (a.key === 'input_tokens' ? { key: a.key, value: { intValue: '30', doubleValue: 30 } } : a));
    expect(() => ingest(traces([{ ...s, attributes }]))).toThrow('claude_trace_invalid_metadata');
    expect(store.eventCount()).toBe(0);
  } finally {
    store.close();
  }
});
test('a trace batch accepts up to the native exporter batch size of 512 spans', () => {
  const { store, ingest } = fixture();
  try {
    const other = { ...span(), name: 'claude_code.tool' };
    expect(ingest(traces([span(), ...Array.from({ length: 511 }, () => other)]))).toMatchObject({ requests: 1, inserted: 1 });
    expect(() => ingest(traces([span(true), ...Array.from({ length: 512 }, () => other)]))).toThrow('claude_trace_invalid_metadata');
    expect(store.eventCount()).toBe(1);
  } finally {
    store.close();
  }
});
