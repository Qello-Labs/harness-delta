import { expect, test } from 'vitest';
import { parseSnapshot } from '../../src/sources/adapters.js';
const scope = { product: 'codex' as const, version: '0.158.0', projectRoot: '/synthetic', sessionId: 's1', projectId: 'p1', taskId: 't1' };
const at = (n: number) => new Date(Date.parse('2026-01-01T00:00:00Z') + n * 1000).toISOString();
const header = { type: 'session_meta', payload: { id: 's1', session_id: 's1', cwd: '/synthetic', cli_version: '0.158.0', source: 'exec' } };
export const context = (model: string, n: number) => ({
  type: 'turn_context',
  timestamp: at(n),
  payload: { turn_id: `turn-${n}`, root_turn_id: `turn-${n}`, model, cwd: '/synthetic', multi_agent_version: 'v1', collaboration_mode: { mode: 'default' } }
});
export const counter = (n: number, count: number) => ({
  type: 'event_msg',
  timestamp: at(n),
  payload: {
    type: 'token_count',
    info: { total_token_usage: { input_tokens: count, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: count, reasoning_output_tokens: 0 } }
  }
});
const text = (...rows: unknown[]) => [header, ...rows].map(x => JSON.stringify(x)).join('\n') + '\n';
test('switch_is_not_counter_reset', async () => {
  const source = text(context('model-a', 1), counter(2, 100), context('model-b', 3), counter(4, 120));
  expect(parseSnapshot(source, scope).blocked).toBe(true); // Legacy remains restrictive.
  const { parseFlexibleSnapshot } = await import('../../src/sources/adapters-flexible.js');
  const result = parseFlexibleSnapshot(source, scope, at(10));
  expect(result.blocked).toBe(false);
  expect(result.records).toHaveLength(2);
  expect(new Set(result.records.map(e => e.payload.epoch)).size).toBe(1);
});
test('cross_model_delta_has_no_price_attribution', async () => {
  const { parseFlexibleSnapshot } = await import('../../src/sources/adapters-flexible.js');
  const r = parseFlexibleSnapshot(text(context('model-a', 1), counter(2, 100), context('model-b', 3), counter(4, 120), counter(5, 130)), scope, at(10));
  expect(r.records[1]!.payload).toMatchObject({ attribution: 'ambiguous', model: null, billing_components: [] });
  expect(r.records[2]!.payload).toMatchObject({ attribution: 'verified', model: 'model-b' });
});
test('equal_counter_after_reset_is_new_event', async () => {
  const { parseFlexibleSnapshot } = await import('../../src/sources/adapters-flexible.js');
  const r = parseFlexibleSnapshot(text(context('model-a', 1), counter(2, 100), counter(3, 50), counter(4, 100)), scope, at(10));
  expect(r.records).toHaveLength(2);
  expect(r.records[0]!.id).not.toBe(r.records[1]!.id);
  expect(r.records[0]!.payload.epoch).not.toBe(r.records[1]!.payload.epoch);
  expect(r.gaps.some(g => g.reason === 'counter_reset')).toBe(true);
});
test('missing_effort_is_null', async () => {
  const { parseFlexibleSnapshot } = await import('../../src/sources/adapters-flexible.js');
  const r = parseFlexibleSnapshot(text(context('model-a', 1), counter(2, 100)), scope, at(10));
  expect(r.runtime[0]!.effort).toBeNull();
  expect(JSON.stringify(r)).not.toContain('PRIVATE');
});
test('child_or_compaction_without_semantics_yields_gap', async () => {
  const { parseFlexibleSnapshot } = await import('../../src/sources/adapters-flexible.js');
  for (const row of [{ type: 'compacted' }, { type: 'event_msg', payload: { type: 'sub_agent_activity', text: 'PRIVATE' } }]) {
    const r = parseFlexibleSnapshot(text(context('model-a', 1), counter(2, 100), row, counter(4, 150)), scope, at(10));
    expect(r.blocked).toBe(true);
    expect(r.gaps).not.toHaveLength(0);
    expect(r.records).toHaveLength(1);
  }
});

test('intervening_return_to_original_model_stays_ambiguous', async () => {
  const { parseFlexibleSnapshot } = await import('../../src/sources/adapters-flexible.js');
  const r = parseFlexibleSnapshot(text(context('model-a', 1), counter(2, 100), context('model-b', 3), context('model-a', 4), counter(5, 150)), scope, at(10));
  expect(r.records[1]!.payload).toMatchObject({ attribution: 'ambiguous', model: null, billing_components: [] });
});
test('known_fork_child_and_foreign_settings_remain_closed', async () => {
  const { parseFlexibleSnapshot } = await import('../../src/sources/adapters-flexible.js');
  expect(() => parseFlexibleSnapshot(text(), scope, at(10))).not.toThrow();
  const fork = { ...header, payload: { ...header.payload, forked_from_id: 'parent' } };
  expect(() => parseFlexibleSnapshot([fork, context('a', 1), counter(2, 100)].map(x => JSON.stringify(x)).join('\n') + '\n', scope, at(10))).toThrow(
    'unsupported'
  );
  const child = { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CollabAgentToolCall' } } };
  expect(parseFlexibleSnapshot(text(context('a', 1), child, counter(2, 100)), scope, at(10)).blocked).toBe(true);
  const foreign = { type: 'event_msg', payload: { type: 'thread_settings_applied', thread_id: 'other', thread_settings: { cwd: '/foreign', model: 'a' } } };
  expect(() => parseFlexibleSnapshot(text(context('a', 1), foreign, counter(2, 100)), scope, at(10))).toThrow('scope_mismatch');
});
test('claude_preserves_request_origin_and_accepts_auxiliary_rows', async () => {
  const { parseFlexibleSnapshot } = await import('../../src/sources/adapters-flexible.js');
  const common = { sessionId: 's1', cwd: '/synthetic', version: '2.1.283' };
  const user = { ...common, type: 'user', promptId: 'prompt-1', timestamp: at(1), message: { content: [] } };
  const assistant = {
    ...common,
    type: 'assistant',
    timestamp: at(5),
    message: {
      id: 'message-1',
      model: 'a',
      content: [],
      usage: { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 20 }
    }
  };
  const r = parseFlexibleSnapshot(
    [user, { type: 'progress', sessionId: 's1' }, assistant].map(x => JSON.stringify(x)).join('\n') + '\n',
    { ...scope, product: 'claude_code', version: '2.1.283' },
    at(6)
  );
  expect(r.runtime[0]!).toMatchObject({ occurred_at: at(1), boundary: 'request' });
  expect(r.records[0]!.occurred_at).toBe(at(5));
});
