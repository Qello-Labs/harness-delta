import { expect, test } from 'vitest';
import { parseSnapshot } from '../src/adapters.js';
const scope = { sessionId: 's1', projectRoot: '/synthetic', product: 'codex' as const, version: '0.156.1' };
const header = { type: 'session_meta', payload: { id: 's1', cwd: '/synthetic', cli_version: '0.156.1', source: 'exec' } };
const usage = (input = 100) => ({
  timestamp: '2026-01-01T00:00:01Z',
  type: 'event_msg',
  payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: 40, output_tokens: 30, reasoning_output_tokens: 0 } } }
});
const text = (...rows: unknown[]) => rows.map(r => JSON.stringify(r)).join('\n') + '\n';
test('verified cumulative counters preserve subsets, ignore private fields and identify replay', () => {
  const snapshot = parseSnapshot(text(header, usage(), usage()), scope);
  expect(snapshot.counters).toEqual([100, 40, 30, 0]);
  expect(snapshot.records).toHaveLength(0);
  expect(snapshot.reasons).toContain('incomplete');
});
test('scope/version/boundary checks fail closed without reflecting private input', () => {
  expect(() => parseSnapshot(text({ ...header, payload: { ...header.payload, id: 'OTHER_PRIVATE' } }, usage()), scope)).toThrow(/^scope_mismatch$/);
  expect(() => parseSnapshot(text(header, usage()), { ...scope, version: '9.9.9' })).toThrow(/^unsupported$/);
  const parsed = parseSnapshot(text(header, usage(), { type: 'compacted', payload: { message: 'PRIVATE' } }), scope);
  expect(parsed.blocked).toBe(true);
  expect(JSON.stringify(parsed)).not.toContain('PRIVATE');
});
test('structured completed commands count once; wrappers and pending lines do not count', () => {
  const command = {
    timestamp: '2026-01-01T00:00:02Z',
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      turn_id: 'turn1',
      started_at_ms: Date.parse('2026-01-01T00:00:01Z'),
      completed_at_ms: Date.parse('2026-01-01T00:00:02Z'),
      item: { type: 'CommandExecution', id: 'exec1', status: 'completed', exit_code: 0, command: 'PRIVATE' }
    }
  };
  const parsed = parseSnapshot(
    text(header, { timestamp: '2026-01-01T00:00:00Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn1' } }, command, command) +
      '{"private":',
    scope
  );
  expect(parsed.records).toHaveLength(1);
  expect(parsed.records[0]?.payload).toMatchObject({ kind: 'tool', execution: 'confirmed', outcome: 'completed' });
  expect(JSON.stringify(parsed)).not.toContain('PRIVATE');
});
test('Claude input components are summed once and repeated message ids are deduplicated', () => {
  const row = {
    type: 'assistant',
    sessionId: 's1',
    cwd: '/synthetic',
    version: '2.1.283',
    timestamp: '2026-01-01T00:00:01Z',
    message: {
      id: 'm1',
      model: 'synthetic',
      content: [{ type: 'text', text: 'PRIVATE' }],
      usage: { input_tokens: 20, cache_creation_input_tokens: 40, cache_read_input_tokens: 40, output_tokens: 30 }
    }
  };
  const parsed = parseSnapshot(text(row, row), { ...scope, product: 'claude_code', version: '2.1.283' });
  expect(parsed.records).toHaveLength(1);
  expect(parsed.records[0]?.payload).toMatchObject({
    input_total: { value: 100 },
    cached_input: { value: 40 },
    output_total: { value: 30 },
    reasoning_output: { status: 'unmeasurable' }
  });
  expect(JSON.stringify(parsed)).not.toContain('PRIVATE');
});

test('scope changes and late completions from prior turns cannot enter a new observation', () => {
  expect(() => parseSnapshot(text(header, { ...header, payload: { ...header.payload, cwd: '/other' } }), scope)).toThrow('scope_mismatch');
  expect(() => parseSnapshot(text(header, { type: 'turn_context', payload: { model: 'synthetic', cwd: '/other' } }), scope)).toThrow('scope_mismatch');
  const rows = [
    header,
    { type: 'event_msg', timestamp: '2026-01-01T00:00:04Z', payload: { type: 'task_started', turn_id: 'new' } },
    {
      type: 'event_msg',
      timestamp: '2026-01-01T00:00:05Z',
      payload: {
        type: 'item_completed',
        turn_id: 'old',
        started_at_ms: Date.parse('2026-01-01T00:00:01Z'),
        completed_at_ms: Date.parse('2026-01-01T00:00:05Z'),
        item: { type: 'CommandExecution', id: 'exec1', exit_code: 0 }
      }
    }
  ];
  const parsed = parseSnapshot(text(...rows), scope);
  expect(parsed.blocked).toBe(true);
  expect(parsed.records).toHaveLength(0);
});
test('Claude tool results require per-message scope and retain their invocation origin', () => {
  const claudeScope = { ...scope, product: 'claude_code' as const, version: '2.1.283' };
  const common = { sessionId: 's1', cwd: '/synthetic', version: '2.1.283' };
  const prompt = { ...common, type: 'user', promptId: 'prompt1', timestamp: '2026-01-01T00:00:00Z', message: { content: 'PRIVATE' } };
  const call = {
    ...common,
    type: 'assistant',
    timestamp: '2026-01-01T00:00:01Z',
    message: {
      id: 'msg1',
      model: 'synthetic',
      usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 },
      content: [{ type: 'tool_use', id: 'call1', name: 'Bash', input: 'PRIVATE' }]
    }
  };
  const result = {
    type: 'user',
    timestamp: '2026-01-01T00:00:04Z',
    toolUseResult: { stdout: 'PRIVATE', stderr: '', interrupted: false },
    message: { content: [{ type: 'tool_result', tool_use_id: 'call1', is_error: false }] }
  };
  expect(() => parseSnapshot(text(prompt, call, result), claudeScope)).toThrow('scope_mismatch');
  const parsed = parseSnapshot(
    text(prompt, call, { ...prompt, promptId: 'prompt2', timestamp: '2026-01-01T00:00:03Z' }, { ...common, ...result }),
    claudeScope
  );
  expect(parsed.records.find(r => r.payload.kind === 'tool')?.turnStartedAt).toBe('2026-01-01T00:00:00.000Z');
});

test('counter decreases and unknown top-level records make the source unsupported', () => {
  expect(parseSnapshot(text(header, usage(100), usage(90)), scope).blocked).toBe(true);
  expect(parseSnapshot(text(header, { type: 'future_private_record', payload: { secret: 'PRIVATE' } }), scope).blocked).toBe(true);
});

test.each(['usage', 'timestamp', 'model'] as const)('Claude rejects a genuine %s revision after an intervening prompt', revision => {
  const common = { sessionId: 's1', cwd: '/synthetic', version: '2.1.283' };
  const prompt = { ...common, type: 'user', promptId: 'p1', timestamp: '2026-01-01T00:00:01Z', message: { content: [] } };
  const row = {
    ...common,
    type: 'assistant',
    timestamp: '2026-01-01T00:00:02Z',
    message: {
      id: 'm1',
      model: 'synthetic',
      content: [],
      usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 }
    }
  };
  const changed = structuredClone(row);
  if (revision === 'usage') changed.message.usage.output_tokens = 2;
  if (revision === 'timestamp') changed.timestamp = '2026-01-01T00:00:04Z';
  if (revision === 'model') changed.message.model = 'other';
  expect(() =>
    parseSnapshot(text(prompt, row, { ...prompt, promptId: 'p2', timestamp: '2026-01-01T00:00:03Z' }, changed), {
      ...scope,
      product: 'claude_code',
      version: '2.1.283'
    })
  ).toThrow(/^source_error$/);
});
