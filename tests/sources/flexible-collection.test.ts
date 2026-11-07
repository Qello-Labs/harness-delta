import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { Store } from '../../src/store.js';
import { Lifecycle } from '../../src/core/lifecycle.js';
import { Collector, type SourceReader } from '../../src/sources/collection.js';
import { parseFlexibleSnapshot } from '../../src/sources/adapters-flexible.js';
import { Deletion } from '../../src/deletion.js';
const at = (n: number) => new Date(Date.parse('2026-01-01T00:00:00Z') + n * 1000).toISOString();
function fixture(product: 'codex' | 'claude_code' = 'codex') {
  const version = product === 'codex' ? '0.158.0' : '2.1.283';
  const root = mkdtempSync(join(tmpdir(), 'flexible-collector-'));
  const store = new Store(':memory:');
  let now = 0;
  const lifecycle = new Lifecycle(store, () => at(now));
  lifecycle.registerProject('p1', root);
  lifecycle.createTask('p1', 't1', {
    schema_version: 2,
    type: 'feature',
    expected_size: 'small',
    assignee: 'u1',
    product,
    initial_model: null,
    criterion_ids: ['c1']
  });
  lifecycle.linkSession('t1', 's1', join(root, 'source.jsonl'), product, version);
  lifecycle.start('t1');
  const rows: unknown[] = [{ type: 'session_meta', payload: { id: 's1', session_id: 's1', cwd: root, cli_version: '0.158.0', source: 'exec' } }];
  const turn = (n: number, model: string, count: number) =>
    rows.push(
      { type: 'turn_context', timestamp: at(n), payload: { turn_id: `turn-${n}`, root_turn_id: `turn-${n}`, model, cwd: root } },
      {
        type: 'event_msg',
        timestamp: at(n + 1),
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: count, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: count, reasoning_output_tokens: 0 }
          }
        }
      }
    );
  const read = vi.fn<SourceReader>(() => ({
    text: rows.map(x => JSON.stringify(x)).join('\n') + '\n',
    identity: 'file-1',
    size: JSON.stringify(rows).length,
    modified: rows.length
  }));
  const collector = new Collector(
    store,
    () => at(now),
    read,
    (p, v) => (p === product && v === version ? parseFlexibleSnapshot : null)
  );
  return {
    root,
    store,
    lifecycle,
    rows,
    turn,
    read,
    collector,
    clock: () => at(now),
    set: (n: number) => {
      now = n;
    },
    cleanup: () => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  };
}
test('model_switch_keeps_task_active', () => {
  const f = fixture();
  try {
    f.turn(0, 'model-a', 100);
    f.set(2);
    expect(f.collector.tick('t1')).toEqual([]);
    f.turn(3, 'model-b', 120);
    f.set(5);
    expect(f.collector.tick('t1')).toEqual([]);
    expect(f.store.eventCount()).toBe(1);
    expect(f.lifecycle.state('t1')).toBe('active');
    expect(f.store.get<{ payload: string }>('SELECT payload FROM events')?.payload).toContain('ambiguous');
    f.collector.tick('t1');
    expect(f.store.eventCount()).toBe(1);
  } finally {
    f.cleanup();
  }
});
test('scope_is_checked_before_read', () => {
  const f = fixture();
  try {
    new Collector(f.store, f.clock, f.read).tick('t1');
    expect(f.read).not.toHaveBeenCalled();
    f.lifecycle.pause('t1');
    f.collector.tick('t1');
    f.collector.tick('unknown-task');
    expect(f.read).not.toHaveBeenCalled();
    f.lifecycle.resume('t1');
    f.store.execute("UPDATE sessions SET product_version='99.0.0'", []);
    f.collector.tick('t1');
    expect(f.read).not.toHaveBeenCalled();
    new Deletion(f.store).deleteTask('t1');
    f.collector.tick('t1');
    expect(f.read).not.toHaveBeenCalled();
  } finally {
    f.cleanup();
  }
});
test('restart_establishes_new_baseline', () => {
  const f = fixture();
  try {
    f.turn(0, 'model-a', 100);
    f.set(2);
    expect(f.collector.tick('t1')).toEqual([]);
    f.turn(3, 'model-a', 150);
    f.set(5);
    const restarted = new Collector(f.store, f.clock, f.read, () => parseFlexibleSnapshot);
    restarted.tick('t1');
    expect(f.store.eventCount()).toBe(0);
    f.turn(6, 'model-a', 180);
    f.set(8);
    restarted.tick('t1');
    expect(f.store.eventCount()).toBe(1);
    expect(f.store.get<{ payload: string }>('SELECT payload FROM events')?.payload).toContain('"value":30');
  } finally {
    f.cleanup();
  }
});
test('finalize_race_cannot_insert', () => {
  const f = fixture();
  try {
    f.set(2);
    expect(f.collector.tick('t1')).toEqual([]);
    f.turn(3, 'model-a', 100);
    f.set(5);
    f.read.mockImplementationOnce(() => {
      f.lifecycle.finalize('t1', 'failed', []);
      return { text: f.rows.map(x => JSON.stringify(x)).join('\n') + '\n', identity: 'file-1', size: JSON.stringify(f.rows).length, modified: f.rows.length };
    });
    f.collector.tick('t1');
    expect(f.store.eventCount()).toBe(0);
    expect(f.store.all('SELECT * FROM runtime_evidence')).toHaveLength(0);
  } finally {
    f.cleanup();
  }
});
test('parent_and_child_never_double_sum', () => {
  const f = fixture();
  try {
    f.set(0);
    f.collector.tick('t1');
    f.store.execute(
      "INSERT INTO sessions(id,task_id,project_id,parent_id,product,product_version,source_path) VALUES ('child','t1','p1','s1','codex','0.158.0','/synthetic-child')",
      []
    );
    f.turn(1, 'model-a', 100);
    f.set(3);
    f.collector.tick('t1');
    expect(f.read.mock.calls.every(([path]) => path !== '/synthetic-child')).toBe(true);
    expect(f.store.eventCount()).toBeLessThanOrEqual(1);
    expect(f.store.all<{ reason: string }>('SELECT reason FROM observation_gaps').some(g => g.reason === 'unknown_parent')).toBe(true);
  } finally {
    f.cleanup();
  }
});

test('claude_request_before_baseline_is_never_backfilled', () => {
  const f = fixture('claude_code');
  try {
    const common = { sessionId: 's1', cwd: f.root, version: '2.1.283' };
    f.rows.splice(0);
    f.rows.push({ ...common, type: 'user', promptId: 'request-1', timestamp: at(1), message: { content: [] } });
    f.set(3);
    expect(f.collector.tick('t1')).toEqual([]);
    f.rows.push(
      { type: 'progress', sessionId: 's1' },
      {
        ...common,
        type: 'assistant',
        timestamp: at(5),
        message: {
          id: 'message-1',
          model: 'model-a',
          content: [],
          usage: { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 20 }
        }
      }
    );
    f.set(6);
    expect(f.collector.tick('t1')).toEqual([]);
    expect(f.store.eventCount()).toBe(0);
    f.rows.push(
      { ...common, type: 'user', promptId: 'request-2', timestamp: at(7), message: { content: [] } },
      {
        ...common,
        type: 'assistant',
        timestamp: at(8),
        message: {
          id: 'message-2',
          model: 'model-b',
          content: [],
          usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 2 }
        }
      }
    );
    f.set(9);
    expect(f.collector.tick('t1')).toEqual([]);
    expect(f.store.eventCount()).toBe(1);
  } finally {
    f.cleanup();
  }
});
test('deletion_during_read_cannot_restore_usage_or_history', () => {
  const f = fixture();
  try {
    f.set(2);
    f.collector.tick('t1');
    f.turn(3, 'model-a', 100);
    f.set(5);
    f.read.mockImplementationOnce(() => {
      new Deletion(f.store).deleteTask('t1');
      return { text: f.rows.map(x => JSON.stringify(x)).join('\n') + '\n', identity: 'file-1', size: JSON.stringify(f.rows).length, modified: f.rows.length };
    });
    expect(f.collector.tick('t1')).toEqual([]);
    expect(f.store.eventCount()).toBe(0);
    expect(f.store.all('SELECT * FROM runtime_evidence')).toEqual([]);
  } finally {
    f.cleanup();
  }
});
test('failed_request_usage_and_sticky_gap_are_retained', () => {
  const f = fixture();
  try {
    f.set(0);
    f.collector.tick('t1');
    f.turn(1, 'model-a', 100);
    f.rows.push({ type: 'event_msg', timestamp: at(2), payload: { type: 'task_complete', turn_id: 'turn-1', error: { message: 'PRIVATE_FAILURE' } } });
    f.set(3);
    f.collector.tick('t1');
    expect(f.store.eventCount()).toBe(1);
    f.rows.push({ type: 'compacted' });
    f.set(4);
    f.collector.tick('t1');
    const gap = f.store.get<{ id: string }>("SELECT id FROM observation_gaps WHERE reason='unsupported'");
    expect(gap).toBeDefined();
    f.rows.pop();
    f.turn(5, 'model-a', 120);
    f.set(7);
    f.collector.tick('t1');
    expect(f.store.get('SELECT id FROM observation_gaps WHERE id=?', [gap!.id])).toBeDefined();
    expect(JSON.stringify(f.store.all('SELECT * FROM events'))).not.toContain('PRIVATE_FAILURE');
  } finally {
    f.cleanup();
  }
});

test('tombstoned_scope_is_denied_before_source_access', () => {
  const f = fixture();
  try {
    f.store.execute("INSERT INTO tombstones(kind,id,deleted_at) VALUES ('task','t1',?)", [at(1)]);
    f.set(2);
    f.collector.tick('t1');
    expect(f.read).not.toHaveBeenCalled();
  } finally {
    f.cleanup();
  }
});
