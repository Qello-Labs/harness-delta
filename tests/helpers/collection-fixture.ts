import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Collector, type SourceBytes } from '../../src/collection.js';
import { Lifecycle } from '../../src/lifecycle.js';
import { Store } from '../../src/store.js';
import type { Event } from '../../src/contracts.js';

export const products = ['codex', 'claude_code'] as const;
export type Product = (typeof products)[number];
export const millis = (value: number) => new Date(Date.parse('2026-01-01T00:00:00Z') + value).toISOString();
export const jsonLines = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n';

/** Independently authored metadata-only source rows; no real session contents. */
export function collectionFixture(product: Product, requestedVersion?: string) {
  const root = mkdtempSync(join(tmpdir(), 'deferred-collection-'));
  const store = new Store(':memory:');
  let now = 0;
  let reads = 0;
  const clock = () => millis(now);
  const life = new Lifecycle(store, clock);
  const version = requestedVersion ?? (product === 'codex' ? '0.156.1' : '2.1.283');
  life.registerProject('p1', root);
  life.createTask('p1', 't1', { type: 'feature', expected_size: 'small', assignee: 'u1', product, model: 'synthetic', criterion_ids: ['c1'] });
  const common = (sessionId: string) => ({ sessionId, cwd: root, version });
  const header = (sessionId = 's1'): unknown =>
    product === 'codex'
      ? { type: 'session_meta', payload: { id: sessionId, cwd: root, source: 'exec', cli_version: version } }
      : { ...common(sessionId), type: 'attachment' };
  const origin = (start: number, id = 'turn1', sessionId = 's1'): unknown =>
    product === 'codex'
      ? { type: 'event_msg', timestamp: millis(start), payload: { type: 'task_started', turn_id: id } }
      : { ...common(sessionId), type: 'user', promptId: id, timestamp: millis(start), message: { content: [] } };
  const usage = (end: number, units = 1, id = 'message1', sessionId = 's1'): unknown[] =>
    product === 'codex'
      ? [
          {
            type: 'turn_context',
            payload: {
              model: 'synthetic',
              ...(version === '0.156.1' ? {} : { turn_id: id, collaboration_mode: { mode: 'default' }, multi_agent_version: 'disabled' })
            }
          },
          {
            type: 'event_msg',
            timestamp: millis(end),
            payload: {
              type: 'token_count',
              info: {
                total_token_usage: {
                  input_tokens: 100 * units,
                  cached_input_tokens: 40 * units,
                  output_tokens: 30 * units,
                  reasoning_output_tokens: 0,
                  ...(version === '0.156.1' ? {} : { cache_write_input_tokens: 0 })
                }
              }
            }
          }
        ]
      : [
          {
            ...common(sessionId),
            type: 'assistant',
            timestamp: millis(end),
            message: {
              id,
              model: 'synthetic',
              content: [],
              usage: { input_tokens: 20, cache_creation_input_tokens: 40, cache_read_input_tokens: 40, output_tokens: 30 }
            }
          }
        ];
  const close = (end: number, id = 'turn1'): unknown[] =>
    product === 'codex' ? [{ type: 'event_msg', timestamp: millis(end), payload: { type: 'task_complete', turn_id: id } }] : [];
  const turn = (start: number | null, end: number, units = 1, id = 'turn1', sessionId = 's1') => [
    ...(start === null ? [] : [origin(start, id, sessionId)]),
    ...usage(end, units, id, sessionId),
    ...(start === null ? [] : close(end, id))
  ];
  const invocation = (start: number, id = 'call1', sessionId = 's1'): unknown[] =>
    product === 'codex'
      ? []
      : [
          {
            ...common(sessionId),
            type: 'assistant',
            timestamp: millis(start),
            message: {
              id: `invoke-${id}`,
              model: 'synthetic',
              content: [{ type: 'tool_use', id, name: 'Bash', input: {} }],
              usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 }
            }
          }
        ];
  const completion = (start: number, end: number, id = 'call1', turnId = 'turn1', sessionId = 's1'): unknown =>
    product === 'codex'
      ? {
          type: 'event_msg',
          timestamp: millis(end),
          payload: {
            type: 'item_completed',
            turn_id: turnId,
            started_at_ms: Date.parse(millis(start)),
            completed_at_ms: Date.parse(millis(end)),
            item: { type: 'CommandExecution', id, exit_code: 0 }
          }
        }
      : {
          ...common(sessionId),
          type: 'user',
          timestamp: millis(end),
          toolUseResult: { stdout: '', stderr: '', interrupted: false },
          message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: false }] }
        };
  const sources = new Map<string, SourceBytes>();
  const pathFor = (sessionId: string) => join(root, `${sessionId}.jsonl`);
  const replace = (text: string, overrides: Partial<SourceBytes> = {}, sessionId = 's1') => {
    sources.set(pathFor(sessionId), { text, identity: sessionId, size: Buffer.byteLength(text), modified: Buffer.byteLength(text), ...overrides });
  };
  const rows = (...values: unknown[]) => replace(jsonLines([header(), ...values]));
  const link = (sessionId: string) => {
    life.linkSession('t1', sessionId, pathFor(sessionId), product, version);
    replace(jsonLines([header(sessionId)]), {}, sessionId);
  };
  link('s1');
  const read = (path: string): SourceBytes => {
    reads++;
    const source = sources.get(path);
    if (!source) throw new Error('synthetic_read_failure');
    return source;
  };
  const collector = new Collector(store, clock, read);
  const events = (kind: Event['payload']['kind'] = 'usage') =>
    store
      .all<{ payload: string }>('SELECT payload FROM events ORDER BY occurred_at, id')
      .map(row => JSON.parse(row.payload) as Event['payload'])
      .filter(payload => payload.kind === kind);
  const state = () => ({
    events: store.all('SELECT * FROM events ORDER BY id'),
    cursors: store.all('SELECT * FROM cursors ORDER BY session_id'),
    observations: store.all('SELECT * FROM observations ORDER BY id')
  });
  return {
    product,
    root,
    store,
    life,
    clock,
    collector,
    read,
    header,
    origin,
    usage,
    close,
    turn,
    invocation,
    completion,
    rows,
    replace,
    link,
    events,
    state,
    set: (value: number) => {
      now = value;
    },
    reads: () => reads,
    cleanup: () => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  };
}
