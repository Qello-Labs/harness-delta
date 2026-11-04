import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { Store } from '../src/store.js';
import { EventV2Schema } from '../src/flexible-contracts.js';
import { ingestCandidateObservation, projectCandidateObservation, candidateCostCoverage, type CandidateScope } from '../src/nested-candidate.js';
import { evaluateCostCoverage, productionCostProfiles } from '../src/cost-coverage.js';
import { lookupFileProfile } from '../src/adapter-profiles.js';
import { assignTask } from '../src/allocation.js';
import { recordRuntimeEvidence } from '../src/runtime-history.js';
import { aggregateTaskCost } from '../src/metrics.js';
import { makeFlexibleFixture } from './helpers/flexible-fixture.js';
import { seedFlexibleComparison } from './helpers/flexible-store.js';

const at = '2026-01-01T00:00:01Z';
const later = '2026-01-01T00:00:02Z';
function scope(product: 'codex' | 'claude_code' = 'codex'): CandidateScope {
  return {
    projectId: 'project-1',
    taskId: 'task-1',
    allowedRootTurnIds: ['turn-root'],
    sessions: [
      {
        sessionId: 'root',
        rootSessionId: 'root',
        parentSessionId: null,
        sourceId: 'source-root',
        product,
        nativeSessionId: 'native-root',
        processId: product === 'codex' ? null : 'process-1',
        agentId: null
      },
      {
        sessionId: 'child',
        rootSessionId: 'root',
        parentSessionId: 'root',
        sourceId: 'source-child',
        product,
        nativeSessionId: product === 'codex' ? 'native-child' : 'native-root',
        processId: product === 'codex' ? null : 'process-1',
        agentId: product === 'codex' ? null : 'agent-child'
      }
    ]
  };
}
const tokens = (input = 100) => ({
  input_tokens: input,
  cached_input_tokens: 20,
  cache_write_input_tokens: 10,
  output_tokens: 15,
  reasoning_output_tokens: 5,
  total_tokens: input + 15
});
function codex(child = false) {
  return {
    kind: 'codex_response',
    occurredAt: at,
    sessionMeta: {
      id: child ? 'native-child' : 'native-root',
      session_id: 'native-root',
      cli_version: '0.160.0',
      parent_thread_id: child ? 'native-root' : null,
      source: child ? { subagent: { thread_spawn: { parent_thread_id: 'native-root', depth: 1 } } } : 'exec'
    },
    turnContext: {
      turn_id: child ? 'turn-child' : 'turn-root',
      root_turn_id: child ? 'turn-root' : null,
      model: child ? 'child-model' : 'root-model',
      effort: child ? 'high' : 'low'
    },
    record: {
      thread_id: child ? 'native-child' : 'native-root',
      session_id: 'native-root',
      turn_id: child ? 'turn-child' : 'turn-root',
      root_turn_id: 'turn-root',
      response_id: child ? 'response-child' : 'response-root',
      usage: tokens(child ? 40 : 100),
      turn_token_usage: tokens(999),
      thread_token_usage: tokens(999)
    }
  };
}
function claude(child = false) {
  return {
    kind: 'claude_trace',
    productVersion: '2.1.288',
    processId: 'process-1',
    nativeSessionId: 'native-root',
    occurredAt: at,
    completed: true,
    span: {
      name: 'claude_code.llm_request',
      agent_id: child ? 'agent-child' : null,
      parent_agent_id: null,
      model: child ? 'child-model' : 'root-model',
      effort: child ? 'high' : null,
      request_id: child ? 'request-child' : 'request-root',
      client_request_id: child ? 'client-child' : 'client-root',
      input_tokens: 30,
      cache_read_tokens: 20,
      cache_creation_tokens: 10,
      output_tokens: 15,
      success: true,
      attempt: 1
    }
  };
}
function seed(store: Store, mapped: CandidateScope) {
  store.execute('INSERT INTO projects(id) VALUES (?)', [mapped.projectId]);
  store.execute("INSERT INTO tasks(id,project_id,state) VALUES (?,?,'active')", [mapped.taskId, mapped.projectId]);
  for (const s of mapped.sessions)
    store.execute('INSERT INTO sessions(id,task_id,project_id,parent_id,product,product_version) VALUES (?,?,?,?,?,?)', [
      s.sessionId,
      mapped.taskId,
      mapped.projectId,
      s.parentSessionId,
      s.product,
      s.product === 'codex' ? '0.160.0' : '2.1.288'
    ]);
}
const project = (input: unknown, child = false, mapped = scope()) => projectCandidateObservation(mapped, child ? 'source-child' : 'source-root', input, later);

test('Codex own-thread response usage preserves shared root and distinct child settings; mirrors never count', () => {
  const result = project(codex(true), true);
  expect(result.kind).toBe('usage');
  if (result.kind !== 'usage') throw new Error('expected_usage');
  expect(result.runtime).toMatchObject({ session_id: 'child', turn_id: 'turn-child', request_id: 'response-child', model: 'child-model', effort: 'high' });
  expect(result.event.payload).toMatchObject({
    input_total: { value: 40 },
    cached_input: { value: 20 },
    output_total: { value: 15 },
    reasoning_output: { value: 5 }
  });
  expect(result.event.payload.billing_components.map(c => c.reading.value)).toEqual([10, 20, 10, 15]);
  expect(project({ ...codex(true), record: { ...codex(true).record, thread_token_usage: tokens(123456) } }, true)).toEqual(result);
});

test('durable same-task parent/child replay across reopened DBs adds usage once and conflicts roll back', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nested-candidate-'));
  const path = join(dir, 'test.sqlite');
  let store = new Store(path);
  const mapped = scope();
  try {
    seed(store, mapped);
    expect(ingestCandidateObservation(store, mapped, 'source-root', () => codex(), later).kind).toBe('usage');
    ingestCandidateObservation(store, mapped, 'source-child', () => codex(true), later);
    store.close();
    store = new Store(path);
    expect(ingestCandidateObservation(store, mapped, 'source-child', () => codex(true), '2026-01-01T00:00:03Z')).toMatchObject({ inserted: false });
    expect(store.eventCount()).toBe(2);
    expect(store.get<{ value: number }>("SELECT sum(json_extract(payload,'$.input_total.value')) AS value FROM events")?.value).toBe(140);
    expect(store.all('SELECT * FROM runtime_evidence')).toHaveLength(2);
    const settingsConflict = codex(true);
    settingsConflict.turnContext.effort = 'low';
    expect(() => ingestCandidateObservation(store, mapped, 'source-child', () => settingsConflict, later)).toThrow('candidate_conflict');
    const conflict = codex(true);
    conflict.record.usage.input_tokens = 41;
    conflict.record.usage.total_tokens = 56;
    expect(() => ingestCandidateObservation(store, mapped, 'source-child', () => conflict, later)).toThrow('candidate_conflict');
    expect(store.eventCount()).toBe(2);
    const collision = codex(true);
    collision.record.response_id = 'response-root';
    expect(() => ingestCandidateObservation(store, mapped, 'source-child', () => collision, later)).toThrow('candidate_conflict');
    expect(store.all('SELECT * FROM runtime_evidence')).toHaveLength(2);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ancestor copies are excluded, foreign records and boundary mismatches fail closed', () => {
  const copy = { ...codex(true), record: codex().record };
  expect(project(copy, true)).toEqual({ kind: 'ignored', reason: 'ancestor_copy' });
  for (const record of [
    { ...copy.record, thread_id: 'foreign' },
    { ...codex(true).record, session_id: 'foreign' },
    { ...codex(true).record, turn_id: 'wrong' },
    { ...codex(true).record, root_turn_id: 'foreign-turn' }
  ]) {
    expect(() => project({ ...codex(true), record }, true)).toThrow('candidate_scope_mismatch');
  }
  expect(() => project({ ...codex(true), sessionMeta: { ...codex(true).sessionMeta, parent_thread_id: 'foreign' } }, true)).toThrow('candidate_scope_mismatch');
  expect(() =>
    project(
      { ...codex(true), sessionMeta: { ...codex(true).sessionMeta, source: { subagent: { thread_spawn: { parent_thread_id: 'native-root', depth: 2 } } } } },
      true
    )
  ).toThrow('candidate_scope_mismatch');
  expect(project({ ...codex(true), sessionMeta: { ...codex(true).sessionMeta, forked_from_id: 'native-root' } }, true)).toEqual({
    kind: 'unattributed',
    reason: 'unsupported_history'
  });
});

test('missing metadata stays unknown, observed zero is retained, invalid counters never become zero', () => {
  expect(project({ ...codex(), record: { ...codex().record, usage: null } })).toEqual({ kind: 'unattributed', reason: 'missing_usage' });
  expect(project({ ...codex(), turnContext: null })).toEqual({ kind: 'unattributed', reason: 'missing_runtime' });
  const zero = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 };
  const result = project({ ...codex(), turnContext: { ...codex().turnContext, effort: undefined }, record: { ...codex().record, usage: zero } });
  expect(result.kind === 'usage' && result.runtime.effort).toBeNull();
  expect(result.kind === 'usage' && result.event.payload.input_total).toEqual({ status: 'observed', value: 0, reason: null });
  for (const value of [null, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => project({ ...codex(), record: { ...codex().record, usage: { ...tokens(), cache_write_input_tokens: value } } })).toThrow(
      'candidate_invalid_metadata'
    );
  }
  expect(() => project({ ...codex(), record: { ...codex().record, usage: tokens(10) } })).toThrow('candidate_invalid_metadata');
  expect(() => project({ ...codex(), sessionMeta: { ...codex().sessionMeta, cli_version: '0.158.0' } })).toThrow('candidate_invalid_metadata');
});

test('mapping validation and active scope precede callback access, including revoked child scopes', () => {
  const store = new Store(':memory:');
  let reads = 0;
  const mapped = scope();
  const read = () => {
    reads++;
    return codex();
  };
  try {
    seed(store, mapped);
    for (const bad of [
      { ...mapped, taskId: 'foreign-task' },
      { ...mapped, projectId: 'foreign-project' },
      { ...mapped, sessions: mapped.sessions.map(s => ({ ...s, parentSessionId: s.sessionId === 'root' ? 'child' : 'root' })) },
      { ...mapped, sessions: mapped.sessions.map(s => ({ ...s, rootSessionId: 'foreign-root' })) },
      { ...mapped, sessions: mapped.sessions.map(s => ({ ...s, sourceId: 'same-source' })) }
    ]) {
      expect(() => ingestCandidateObservation(store, bad, 'source-root', read, later)).toThrow();
    }
    expect(() => ingestCandidateObservation(store, mapped, 'foreign-source', read, later)).toThrow();
    store.execute("INSERT INTO tombstones(kind,id,deleted_at) VALUES ('session','child',?)", [later]);
    expect(() => ingestCandidateObservation(store, mapped, 'source-root', read, later)).toThrow('candidate_inactive_scope');
    expect(reads).toBe(0);
  } finally {
    store.close();
  }
});

test('Claude predecoded completed trace uses authenticated session and explicit direct-child agent mapping', () => {
  const mapped = scope('claude_code');
  const result = project(claude(true), true, mapped);
  expect(result.kind).toBe('usage');
  if (result.kind !== 'usage') throw new Error('expected_usage');
  expect(result.runtime).toMatchObject({ session_id: 'child', model: 'child-model', effort: 'high', request_id: 'request-child' });
  expect(result.event.payload.input_total.value).toBe(60);
  expect(result.event.payload.billing_components.map(c => c.reading.value)).toEqual([30, 20, 10, 15]);
  expect(result.event.payload.reasoning_output.status).toBe('missing');
  expect(project(claude(), false, mapped).kind).toBe('usage');
  for (const patch of [
    { processId: 'foreign' },
    { nativeSessionId: 'foreign' },
    { span: { ...claude(true).span, agent_id: 'foreign' } },
    { span: { ...claude(true).span, parent_agent_id: 'unexpected' } }
  ]) {
    expect(() => project({ ...claude(true), ...patch }, true, mapped)).toThrow('candidate_scope_mismatch');
  }
  for (const patch of [{ completed: false }, { span: { ...claude(true).span, success: false } }, { span: { ...claude(true).span, attempt: 2 } }]) {
    expect(project({ ...claude(true), ...patch }, true, mapped)).toEqual({ kind: 'unattributed', reason: 'incomplete_request' });
  }
});

test('Claude API logs require trace identity and correlation never adds a second request', () => {
  const mapped = scope('claude_code');
  const c = claude(true);
  const log = {
    eventName: 'claude_code.api_request',
    model: c.span.model,
    effort: c.span.effort,
    request_id: c.span.request_id,
    client_request_id: c.span.client_request_id,
    input_tokens: c.span.input_tokens,
    cache_read_tokens: c.span.cache_read_tokens,
    cache_creation_tokens: c.span.cache_creation_tokens,
    output_tokens: c.span.output_tokens
  };
  const store = new Store(':memory:');
  try {
    seed(store, mapped);
    expect(project({ kind: 'claude_api_log', ...log }, true, mapped)).toEqual({ kind: 'unattributed', reason: 'trace_identity_required' });
    ingestCandidateObservation(store, mapped, 'source-child', () => c, later);
    expect(ingestCandidateObservation(store, mapped, 'source-child', () => ({ ...c, correlatedLog: log }), later)).toMatchObject({ inserted: false });
    expect(store.eventCount()).toBe(1);
    expect(() => project({ ...c, correlatedLog: { ...log, output_tokens: 99 } }, true, mapped)).toThrow('candidate_conflict');
    expect(() => project({ ...c, span: { ...c.span, input_tokens: Number.MAX_SAFE_INTEGER } }, true, mapped)).toThrow('candidate_invalid_metadata');
  } finally {
    store.close();
  }
});

test('private fields are stripped before durable metadata, including names, paths and authentication values', () => {
  const store = new Store(':memory:');
  const mapped = scope();
  const privateFields = {
    prompt: 'PRIVATE_SENTINEL',
    response: 'PRIVATE_SENTINEL',
    cwd: 'PRIVATE_SENTINEL',
    agent_nickname: 'PRIVATE_SENTINEL',
    authorization: 'PRIVATE_SENTINEL'
  };
  try {
    seed(store, mapped);
    ingestCandidateObservation(
      store,
      mapped,
      'source-root',
      () => ({
        ...codex(),
        ...privateFields,
        sessionMeta: { ...codex().sessionMeta, ...privateFields },
        turnContext: { ...codex().turnContext, ...privateFields },
        record: { ...codex().record, ...privateFields }
      }),
      later
    );
    expect(JSON.stringify(store.all('SELECT payload FROM events')) + JSON.stringify(store.all('SELECT payload FROM runtime_evidence'))).not.toContain(
      'PRIVATE_SENTINEL'
    );
  } finally {
    store.close();
  }
});

test('missing child coverage remains unknown and production admissions remain closed', () => {
  const coverage = candidateCostCoverage(scope(), at, later, true);
  expect(coverage.facts.bounded_topology).toBe('unknown');
  expect(coverage.facts.request_universe).toBe('unknown');
  expect(coverage.facts.terminal_accounting).toBe('unknown');
  expect(evaluateCostCoverage(coverage).eligible).toBe(false);
  const projected = project(codex());
  if (projected.kind !== 'usage') throw new Error('expected_usage');
  const table = makeFlexibleFixture().priceTable;
  const nativeTable = { ...table, entries: table.entries.map(e => ({ ...e, product: 'codex' as const, model: 'root-model' })) };
  expect(aggregateTaskCost([projected.event], nativeTable, coverage).complete_amount).toBeNull();
  expect(productionCostProfiles).toEqual([]);
  expect(lookupFileProfile('codex', '0.160.0')).toBe('unsupported');
  expect(lookupFileProfile('claude_code', '2.1.288')).toBe('unsupported');
});

test('sticky synthetic assignment remains one allocation despite independent root/child runtime changes', () => {
  const store = new Store(':memory:');
  try {
    const f = seedFlexibleComparison(store);
    const deps = { clock: () => '2026-01-01T00:00:00Z', shuffle: (x: readonly string[]) => x };
    const before = assignTask(store, f.input, deps);
    store.execute("UPDATE tasks SET state='active' WHERE id='task-1'", []);
    store.execute("INSERT INTO sessions(id,task_id,project_id,product) VALUES ('session-1','task-1','project-1','synthetic')", []);
    store.execute("INSERT INTO sessions(id,task_id,project_id,parent_id,product) VALUES ('synthetic-child','task-1','project-1','session-1','synthetic')", []);
    recordRuntimeEvidence(store, f.runtime[0]!);
    recordRuntimeEvidence(store, { ...f.runtime[0]!, id: 'child-runtime', session_id: 'synthetic-child', model: 'different-model', effort: 'high' });
    const replay = assignTask(store, f.input, deps);
    expect(store.all('SELECT * FROM runtime_evidence')).toHaveLength(2);
    expect(replay.assignment_id).toBe(before.assignment_id);
    expect(store.all('SELECT * FROM comparison_assignments')).toHaveLength(1);
    expect(store.get<{ next_index: number }>("SELECT next_index FROM comparison_allocation_state WHERE stratum_id='stratum-user-1'")?.next_index).toBe(1);
  } finally {
    store.close();
  }
});

test.each(['paused', 'finalized'] as const)('task %s and database parent disagreement prohibit source access', state => {
  const store = new Store(':memory:');
  const mapped = scope();
  let reads = 0;
  const read = () => {
    reads++;
    return codex();
  };
  try {
    seed(store, mapped);
    store.execute('UPDATE tasks SET state=? WHERE id=?', [state, mapped.taskId]);
    expect(() => ingestCandidateObservation(store, mapped, 'source-root', read, later)).toThrow('candidate_inactive_scope');
    store.execute("UPDATE tasks SET state='active' WHERE id=?", [mapped.taskId]);
    store.execute("UPDATE sessions SET parent_id=NULL WHERE id='child'", []);
    expect(() => ingestCandidateObservation(store, mapped, 'source-root', read, later)).toThrow('candidate_scope_mismatch');
    expect(reads).toBe(0);
  } finally {
    store.close();
  }
});

test('missing Claude cache/usage stays missing and provider source errors are sanitized', () => {
  const mapped = scope('claude_code');
  const c = claude();
  const result = project({ ...c, span: { ...c.span, input_tokens: null, cache_creation_tokens: undefined, effort: undefined } }, false, mapped);
  if (result.kind !== 'usage') throw new Error('expected_usage');
  expect(result.runtime.effort).toBeNull();
  expect(result.event.payload.input_total).toEqual({ status: 'missing', value: null, reason: 'not_available' });
  const store = new Store(':memory:');
  try {
    seed(store, mapped);
    expect(() =>
      ingestCandidateObservation(
        store,
        mapped,
        'source-root',
        () => {
          throw new Error('PRIVATE_SENTINEL');
        },
        later
      )
    ).toThrow(/^candidate_source_error$/);
    expect(store.eventCount()).toBe(0);
  } finally {
    store.close();
  }
});

test('mixed legacy/other-channel usage is rejected before requesting candidate metadata', () => {
  const store = new Store(':memory:');
  const mapped = scope();
  let reads = 0;
  try {
    seed(store, mapped);
    const projected = project(codex());
    if (projected.kind !== 'usage') throw new Error('expected_usage');
    store.putEvent({
      ...projected.event,
      id: 'other-channel',
      source_key: 'other-channel',
      payload: { ...projected.event.payload, runtime_evidence_id: null, attribution: 'unknown' }
    });
    expect(() =>
      ingestCandidateObservation(
        store,
        mapped,
        'source-root',
        () => {
          reads++;
          return codex();
        },
        later
      )
    ).toThrow('candidate_mixed_sources');
    expect(reads).toBe(0);
    expect(store.eventCount()).toBe(1);
  } finally {
    store.close();
  }
});

test.each(['otel', 'managed'] as const)('existing %s accounting registration blocks callback access', channel => {
  const store = new Store(':memory:');
  const mapped = scope('claude_code');
  let reads = 0;
  try {
    seed(store, mapped);
    if (channel === 'otel')
      store.execute(
        "INSERT INTO otel_processes(id,run_id,project_id,task_id,launch_session_id,product,product_version,profile_id,generation,state,ordering,started_at,updated_at) VALUES ('p','r','project-1','task-1','root','claude_code','2.1.288','synthetic-profile',0,'listening','pending',?,?)",
        [at, at]
      );
    else
      store.execute(
        "INSERT INTO observation_runs(id,project_id,task_id,session_id,generation,profile_id,state,started_at,updated_at,input_facts,output_facts) VALUES ('r','project-1','task-1','root',0,'synthetic-managed-v1','ready',?,?,'{}','{}')",
        [at, at]
      );
    expect(() =>
      ingestCandidateObservation(
        store,
        mapped,
        'source-root',
        () => {
          reads++;
          return claude();
        },
        later
      )
    ).toThrow('candidate_mixed_sources');
    expect(reads).toBe(0);
  } finally {
    store.close();
  }
});

test('Claude trace/log private fields never persist and native session-version disagreement blocks access', () => {
  const store = new Store(':memory:');
  const mapped = scope('claude_code');
  const c = claude(true);
  let reads = 0;
  try {
    seed(store, mapped);
    ingestCandidateObservation(
      store,
      mapped,
      'source-child',
      () => ({
        ...c,
        prompt: 'PRIVATE_SENTINEL',
        span: { ...c.span, agent_name: 'PRIVATE_SENTINEL', query_source: 'PRIVATE_SENTINEL', instructions: 'PRIVATE_SENTINEL', response: 'PRIVATE_SENTINEL' }
      }),
      later
    );
    expect(JSON.stringify(store.all('SELECT payload FROM events')) + JSON.stringify(store.all('SELECT payload FROM runtime_evidence'))).not.toContain(
      'PRIVATE_SENTINEL'
    );
    store.execute("UPDATE sessions SET product_version='2.1.283' WHERE id='root'", []);
    expect(() =>
      ingestCandidateObservation(
        store,
        mapped,
        'source-child',
        () => {
          reads++;
          return c;
        },
        later
      )
    ).toThrow('candidate_scope_mismatch');
    expect(reads).toBe(0);
  } finally {
    store.close();
  }
});

test('Claude completed trace and documented correlated log accept absent optional client request IDs', () => {
  const c = claude(true);
  const mapped = scope('claude_code');
  const span = { ...c.span, client_request_id: undefined };
  const log = {
    eventName: 'claude_code.api_request',
    model: span.model,
    request_id: span.request_id,
    input_tokens: span.input_tokens,
    cache_read_tokens: span.cache_read_tokens,
    cache_creation_tokens: span.cache_creation_tokens,
    output_tokens: span.output_tokens,
    effort: span.effort
  };
  expect(project({ ...c, span }, true, mapped).kind).toBe('usage');
  expect(project({ ...c, span, correlatedLog: log }, true, mapped)).toEqual(project({ ...c, span }, true, mapped));
});

test('fictional priced same-task parent/child partial sum survives replay; missing child never means zero or complete cost', () => {
  const store = new Store(':memory:');
  const mapped = scope();
  const f = makeFlexibleFixture();
  const table = {
    ...f.priceTable,
    entries: ['root-model', 'child-model'].flatMap((model, index) =>
      (['ordinary_input', 'cache_read', 'cache_write', 'output'] as const).map(component => ({
        product: 'codex' as const,
        model,
        component,
        price_per_unit: String(index + 1)
      }))
    )
  };
  const coverage = candidateCostCoverage(mapped, at, later, true);
  const events = () =>
    store
      .all<{ id: string; project_id: string; task_id: string; session_id: string; source_key: string; occurred_at: string; payload: string }>(
        'SELECT * FROM events'
      )
      .map(row => EventV2Schema.parse({ ...row, payload: JSON.parse(row.payload) as unknown }));
  try {
    seed(store, mapped);
    ingestCandidateObservation(store, mapped, 'source-root', () => codex(), later);
    expect(aggregateTaskCost(events(), table, coverage)).toMatchObject({
      partial_amount: null,
      legacy_unverified_partial_amount: '0.115',
      complete_amount: null,
      usage_complete: false
    });
    ingestCandidateObservation(store, mapped, 'source-child', () => codex(true), later);
    expect(aggregateTaskCost(events(), table, coverage)).toMatchObject({
      partial_amount: null,
      legacy_unverified_partial_amount: '0.225',
      complete_amount: null,
      usage_complete: false
    });
    ingestCandidateObservation(store, mapped, 'source-child', () => codex(true), later);
    expect(aggregateTaskCost(events(), table, coverage)).toMatchObject({
      partial_amount: null,
      legacy_unverified_partial_amount: '0.225',
      complete_amount: null
    });
  } finally {
    store.close();
  }
});
