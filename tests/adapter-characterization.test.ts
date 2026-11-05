import { expect, test } from 'vitest';
import { parseSnapshot, type SourceScope } from '../src/adapters.js';
import { SourceFailure } from '../src/source-errors.js';
import { collectionFixture, jsonLines } from './helpers/collection-fixture.js';

const scope: SourceScope = {
  sessionId: 's1',
  projectRoot: '/synthetic',
  product: 'codex',
  version: '0.156.1'
};
const header = {
  type: 'session_meta',
  payload: { id: 's1', cwd: '/synthetic', cli_version: '0.156.1', source: 'exec' }
};
const text = (...rows: unknown[]) => `${rows.map(row => JSON.stringify(row)).join('\n')}\n`;
const count = (input: number, cached = 40, output = 30, reasoning = 0, at = '2026-01-01T00:00:01Z') => ({
  timestamp: at,
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: {
      total_token_usage: {
        input_tokens: input,
        cached_input_tokens: cached,
        output_tokens: output,
        reasoning_output_tokens: reasoning
      }
    }
  }
});
const model = (name = 'synthetic') => ({ type: 'turn_context', payload: { model: name } });
const claude: SourceScope = { ...scope, product: 'claude_code', version: '2.1.283' };
const common = { sessionId: 's1', cwd: '/synthetic', version: '2.1.283' };
const assistant = () => ({
  ...common,
  type: 'assistant',
  timestamp: '2026-01-01T00:00:01Z',
  message: {
    id: 'm1',
    model: 'synthetic',
    content: [],
    usage: { input_tokens: 20, cache_creation_input_tokens: 40, cache_read_input_tokens: 40, output_tokens: 30 }
  }
});

test('Codex token_count before a model advances the baseline and later availability does not recover it', () => {
  const early = parseSnapshot(text(header, count(100)), scope);
  expect(early.records).toEqual([]);
  expect(early.counters).toEqual([100, 40, 30, 0]);
  expect(early.counterAt).toBe('2026-01-01T00:00:01.000Z');
  expect(early.model).toBeNull();

  const same = parseSnapshot(text(header, count(100), model(), count(100, 40, 30, 0, '2026-01-01T00:00:02Z')), scope);
  expect(same.records).toEqual([]);
  expect(same.counters).toEqual([100, 40, 30, 0]);
  expect(same.model).toBe('synthetic');

  const later = parseSnapshot(text(header, count(100), model(), count(110, 40, 30, 0, '2026-01-01T00:00:02Z')), scope);
  expect(later.records).toHaveLength(1);
  expect(later.records[0]?.payload).toMatchObject({
    input_total: { status: 'observed', value: 10 },
    cached_input: { status: 'observed', value: 0 },
    output_total: { status: 'observed', value: 0 },
    reasoning_output: { status: 'observed', value: 0 }
  });
});

test('Codex first explicit zero emits once when the model is known', () => {
  const parsed = parseSnapshot(text(header, model(), count(0, 0, 0, 0), count(0, 0, 0, 0, '2026-01-01T00:00:02Z')), scope);
  expect(parsed.records).toHaveLength(1);
  expect(parsed.records[0]?.payload).toMatchObject({
    input_total: { value: 0 },
    cached_input: { value: 0 },
    output_total: { value: 0 },
    reasoning_output: { status: 'observed', value: 0 }
  });
  expect(parsed.continuityKey).toBeNull();
});

test('Codex counters keep advancing after a sticky block while the earlier record remains on the snapshot', () => {
  const parsed = parseSnapshot(
    text(
      header,
      model(),
      count(100, 40, 30, 0, '2026-01-01T00:00:01Z'),
      { type: 'compacted', payload: { message: 'PRIVATE_BLOCK' } },
      count(140, 40, 30, 0, '2026-01-01T00:00:02Z')
    ),
    scope
  );
  expect(parsed.blocked).toBe(true);
  expect(parsed.reasons).toEqual(['incomplete', 'unsupported']);
  expect(parsed.counters).toEqual([140, 40, 30, 0]);
  expect(parsed.counterAt).toBe('2026-01-01T00:00:02.000Z');
  expect(parsed.records).toHaveLength(1);
  expect(parsed.records[0]?.payload).toMatchObject({ input_total: { value: 100 } });
  expect(JSON.stringify(parsed)).not.toContain('PRIVATE_BLOCK');
});

test('a blocked Codex snapshot settles the earlier usage key and a later clean poll does not store it', () => {
  const fixture = collectionFixture('codex');
  try {
    fixture.life.start('t1');
    fixture.set(1);
    fixture.collector.tick('t1');
    const rows = [fixture.origin(2), ...fixture.usage(3, 1), { type: 'compacted', payload: { message: 'PRIVATE_BLOCK' } }];
    const blocked = jsonLines([fixture.header(), ...rows]);
    fixture.replace(blocked);
    fixture.set(4);
    fixture.collector.tick('t1');
    expect(fixture.store.eventCount()).toBe(0);
    expect(JSON.stringify(fixture.state())).not.toContain('PRIVATE_BLOCK');
    const cursor = fixture.store.get<{ checkpoint: string }>('SELECT checkpoint FROM cursors WHERE session_id = ?', ['s1']);
    const checkpoint = JSON.parse(cursor?.checkpoint ?? '{}') as { settledKeys: string[] };
    expect(checkpoint.settledKeys.length).toBeGreaterThan(0);
    const open = jsonLines([fixture.header(), fixture.origin(2), ...fixture.usage(3, 1)]);
    fixture.replace(open, {
      size: Buffer.byteLength(blocked) + 1,
      modified: Buffer.byteLength(blocked) + 1
    });
    fixture.set(5);
    fixture.collector.tick('t1');
    expect(fixture.store.eventCount()).toBe(0);
  } finally {
    fixture.cleanup();
  }
});

test('Codex preserves unsupported, scope_mismatch, and delta-only subset checks', () => {
  expect(() =>
    parseSnapshot(
      text({
        ...header,
        payload: { ...header.payload, cli_version: '0.158.0' }
      }),
      scope
    )
  ).toThrow(/^unsupported$/);
  expect(() => parseSnapshot(text(header, { ...header, payload: { ...header.payload, cli_version: '0.158.0' } }), scope)).toThrow(/^scope_mismatch$/);
  expect(() =>
    parseSnapshot(
      text(header, {
        timestamp: '2026-01-01T00:00:01Z',
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: '' }
      }),
      scope
    )
  ).toThrow(/^unsupported$/);
  const mismatched = parseSnapshot(
    text(
      header,
      { timestamp: '2026-01-01T00:00:01Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn1' } },
      { timestamp: '2026-01-01T00:00:02Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn2' } }
    ),
    scope
  );
  expect(mismatched.blocked).toBe(true);
  expect(() => parseSnapshot(text(header, model(), count(100), count(150, 100, 30, 0, '2026-01-01T00:00:02Z')), scope)).toThrow(/^unsupported$/);
  const hidden = parseSnapshot(text(header, count(50, 80)), scope);
  expect(hidden.records).toEqual([]);
  expect(hidden.counters).toEqual([50, 80, 30, 0]);
  expect(() =>
    parseSnapshot(
      text(header, {
        timestamp: '2026-01-01T00:00:01Z',
        type: 'event_msg',
        payload: { type: 'token_count', info: { total_token_usage: null } }
      }),
      scope
    )
  ).toThrow(/^unsupported$/);
  const absentInfo = parseSnapshot(
    text(header, {
      timestamp: '2026-01-01T00:00:01Z',
      type: 'event_msg',
      payload: { type: 'token_count', info: null }
    }),
    scope
  );
  expect(absentInfo.blocked).toBe(false);
  expect(absentInfo.counters).toBeNull();
});

test('Codex recognized non-usage types, ignored subtypes, forks, overlap, and model changes stay fail-closed', () => {
  for (const type of ['response_item', 'world_state', 'token_usage_record'] as const) {
    const parsed = parseSnapshot(text(header, { type, payload: { secret: 'PRIVATE_TYPE' } }), scope);
    expect(parsed.blocked).toBe(false);
    expect(JSON.stringify(parsed)).not.toContain('PRIVATE_TYPE');
  }
  const notice = parseSnapshot(
    text(header, {
      type: 'event_msg',
      payload: { type: 'notice', text: 'PRIVATE_EVENT' }
    }),
    scope
  );
  expect(notice.blocked).toBe(false);
  expect(notice.records).toEqual([]);
  expect(JSON.stringify(notice)).not.toContain('PRIVATE_EVENT');
  expect(parseSnapshot(text(header, { type: 'future_private_record' }), scope).blocked).toBe(true);
  expect(
    parseSnapshot(
      text(header, {
        type: 'event_msg',
        payload: { type: 'notice', forked_from_id: 'fork1' }
      }),
      scope
    ).blocked
  ).toBe(true);
  expect(
    parseSnapshot(
      text(
        header,
        { timestamp: '2026-01-01T00:00:01Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn1' } },
        { timestamp: '2026-01-01T00:00:02Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn2' } }
      ),
      scope
    ).blocked
  ).toBe(true);
  const changed = parseSnapshot(text(header, model('synthetic'), model('other-model')), scope);
  expect(changed.blocked).toBe(true);
  expect(changed.model).toBe('other-model');
  const ignoredRecord = parseSnapshot(
    text(header, model(), { type: 'token_usage_record', payload: { total_token_usage: { input_tokens: 999 } } }, count(100)),
    scope
  );
  expect(ignoredRecord.counters).toEqual([100, 40, 30, 0]);
  expect(JSON.stringify(ignoredRecord)).not.toContain('999');
});

test('Codex nonzero reasoning is unmeasurable and is not folded into output', () => {
  const parsed = parseSnapshot(text(header, model(), count(100, 0, 5, 1)), scope);
  expect(parsed.records[0]?.payload).toMatchObject({
    output_total: { status: 'observed', value: 5 },
    reasoning_output: { status: 'unmeasurable', value: null, reason: 'unsupported' }
  });
  expect(() => parseSnapshot(text(header, model(), count(100, 0, 5, 6)), scope)).toThrow(/^unsupported$/);
});

test('a non-string compacted type does not block the Codex snapshot', () => {
  const parsed = parseSnapshot(text(header, { type: ['compacted'], payload: {} }, { type: 'event_msg', payload: { type: ['context_compacted'] } }), scope);
  expect(parsed.blocked).toBe(false);
  expect(parsed.reasons).toEqual(['incomplete']);
});

test('Codex partial tails are ignored and a malformed complete line keeps the fixed error', () => {
  const partial = parseSnapshot(`${text(header, count(100))}{"type":"compacted","payload":{"message":"PRIVATE_PARTIAL"}`, scope);
  expect(partial.blocked).toBe(false);
  expect(partial.counters).toEqual([100, 40, 30, 0]);
  expect(JSON.stringify(partial)).not.toContain('PRIVATE_PARTIAL');
  expect(() => parseSnapshot(`${text(header)}{bad}\n`, scope)).toThrow(SourceFailure);
  try {
    parseSnapshot(`${text(header)}{bad}\n`, scope);
  } catch (error) {
    expect(error).toBeInstanceOf(SourceFailure);
    expect((error as SourceFailure).category).toBe('invalid_json');
    expect((error as SourceFailure).message).toBe('source_error');
  }
});

test('Claude auxiliary identity, nested usage, sidechains, and Bash conflicts stay exact', () => {
  expect(() => parseSnapshot(text({ type: 'summary', sessionId: 'other' }), claude)).toThrow(/^scope_mismatch$/);
  const auxiliary = parseSnapshot(text({ ...common, type: 'summary', timestamp: '2026-01-01T00:00:01Z' }), claude);
  expect(auxiliary.records).toEqual([]);
  expect(auxiliary.blocked).toBe(false);
  expect(auxiliary.continuityKey).not.toBeNull();
  expect(() => parseSnapshot(text({ ...common, version: '2.1.284', type: 'summary' }), claude)).toThrow(/^unsupported$/);
  const nested = parseSnapshot(
    text({
      ...common,
      type: 'assistant',
      timestamp: '2026-01-01T00:00:01Z',
      message: {
        id: 'm1',
        model: 'synthetic',
        content: [{ type: 'text', text: 'PRIVATE' }, { usage: { input_tokens: 999, output_tokens: 999 } }],
        usage: { input_tokens: 20, cache_creation_input_tokens: 40, cache_read_input_tokens: 40, output_tokens: 30 }
      }
    }),
    claude
  );
  expect(nested.records).toHaveLength(1);
  expect(nested.records[0]?.payload).toMatchObject({
    input_total: { value: 100 },
    cached_input: { value: 40 },
    reasoning_output: { status: 'unmeasurable', value: null, reason: 'unsupported' }
  });
  expect(JSON.stringify(nested)).not.toContain('999');
  expect(JSON.stringify(nested)).not.toContain('PRIVATE');
  const side = parseSnapshot(text({ ...assistant(), isSidechain: true }), claude);
  expect(side.blocked).toBe(true);
  expect(side.reasons).toEqual(['incomplete', 'unsupported']);
  expect(side.records).toHaveLength(1);
  const bash = {
    ...common,
    type: 'assistant',
    timestamp: '2026-01-01T00:00:01Z',
    message: {
      id: 'm1',
      model: 'synthetic',
      content: [{ type: 'tool_use', id: 'call1', name: 'Bash', input: 'PRIVATE' }],
      usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 }
    }
  };
  const revised = structuredClone(bash);
  const block = revised.message.content[0];
  if (!block) throw new Error('expected bash block');
  block.id = 'call2';
  try {
    parseSnapshot(text(bash, revised), claude);
    throw new Error('expected record_conflict');
  } catch (error) {
    if (!(error instanceof SourceFailure)) throw error;
    expect(error.category).toBe('record_conflict');
    expect(error.message).toBe('source_error');
    expect(String(error)).not.toContain('PRIVATE');
  }
});

test('golden Codex and Claude record keys stay stable', () => {
  const codex = parseSnapshot(text(header, model(), count(100)), scope);
  const claudeRow = {
    ...common,
    type: 'assistant',
    timestamp: '2026-01-01T00:00:01Z',
    message: {
      id: 'm1',
      model: 'synthetic',
      content: [],
      usage: { input_tokens: 20, cache_creation_input_tokens: 40, cache_read_input_tokens: 40, output_tokens: 30 }
    }
  };
  const claudeParsed = parseSnapshot(text(claudeRow), claude);
  expect(codex.records.map(record => record.key)).toEqual(['d1c64a3ad96e871737a0271978abf19c49a3c5b6a577cd4a4dd13b898b26114b']);
  expect(codex.continuityKey).toBeNull();
  expect(claudeParsed.records.map(record => record.key)).toEqual(['8d9a86a1f2e9dac60a89aab31072e7185a90ce7be5bf3bbe8e4ed9d74e7d6afc']);
  expect(claudeParsed.continuityKey).toBe('5b942892220c15c31a8806e8f27db7b91895f7e8c7836b743d037b7100c1cd2f');
});
