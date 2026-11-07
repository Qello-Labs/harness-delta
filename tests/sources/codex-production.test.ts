import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { Store } from '../../src/store.js';
import { Lifecycle } from '../../src/core/lifecycle.js';
import { Collector } from '../../src/sources/collection.js';
import { aggregateTask } from '../../src/pricing/metrics.js';
import { parseSnapshot } from '../../src/sources/adapters.js';
import { Deletion } from '../../src/deletion.js';

const at = (second: number) => new Date(Date.parse('2026-01-01T00:00:00Z') + second * 1000).toISOString();
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'codex-production-'));
  const path = join(root, 'synthetic.jsonl');
  const store = new Store(':memory:');
  let second = 0;
  const clock = () => at(second);
  const life = new Lifecycle(store, clock);
  life.registerProject('p1', root);
  life.createTask('p1', 't1', { type: 'feature', expected_size: 'small', assignee: 'u1', product: 'codex', model: 'synthetic', criterion_ids: ['c1'] });
  life.linkSession('t1', 's1', path, 'codex', '0.158.0');
  const append = (...rows: unknown[]) => appendFileSync(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const scope = { product: 'codex' as const, version: '0.158.0', sessionId: 's1', projectRoot: root };
  const header = { type: 'session_meta', payload: { id: 's1', session_id: 's1', cwd: root, cli_version: scope.version, source: 'exec' } };
  writeFileSync(path, JSON.stringify(header) + '\n');
  const turn = (start: number, input: number, output: number, mode = 'v1') => [
    { timestamp: at(start), type: 'event_msg', payload: { type: 'task_started', turn_id: `t${start}` } },
    {
      type: 'turn_context',
      payload: {
        turn_id: `t${start}`,
        root_turn_id: `t${start}`,
        model: 'synthetic',
        cwd: root,
        collaboration_mode: { mode: 'default', settings: { developer_instructions: 'PRIVATE_INSTRUCTIONS' } },
        multi_agent_version: mode
      }
    },
    {
      timestamp: at(start + 1),
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: input, output_tokens: output, cached_input_tokens: 0, cache_write_input_tokens: 0, reasoning_output_tokens: 0 },
          last_token_usage: { input_tokens: 999999 }
        }
      }
    },
    { timestamp: at(start + 1), type: 'event_msg', payload: { type: 'task_complete', turn_id: `t${start}` } }
  ];
  const collector = new Collector(store, clock);
  return {
    root,
    store,
    life,
    collector,
    scope,
    header,
    append,
    turn,
    set: (value: number) => {
      second = value;
    },
    cleanup: () => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  };
}

test('registered profile links and collects a resumed sequential session into a partial task report without backfill', () => {
  const f = fixture();
  try {
    f.life.start('t1');
    f.append(...f.turn(0, 100, 10));
    f.set(2);
    f.collector.tick('t1'); // startup exclusion
    f.append({
      type: 'event_msg',
      payload: { type: 'thread_settings_applied', thread_id: 's1', thread_settings: { cwd: f.root, model: 'synthetic', instructions: 'PRIVATE_SETTINGS' } }
    });
    f.append(...f.turn(3, 150, 15));
    f.set(5);
    f.collector.tick('t1');
    f.collector.tick('t1');
    expect(f.store.eventCount()).toBe(1);
    const report = aggregateTask(f.store, 't1', at(5));
    expect(report.usage).toMatchObject({ status: 'partial', partial_tokens: 55, complete_tokens: null });
    expect(report.usage.reasons).toContain('incomplete');
    expect(report.usage.reasons).toContain('offline');
    expect(JSON.stringify(f.store.all('SELECT * FROM events'))).not.toContain('PRIVATE_');
    expect(JSON.stringify(f.store.all('SELECT * FROM cursors'))).not.toContain('PRIVATE_');
    f.life.pause('t1');
    f.append(...f.turn(6, 200, 20));
    f.set(8);
    f.life.resume('t1');
    f.collector.tick('t1');
    f.append(...f.turn(9, 250, 25));
    f.set(11);
    f.collector.tick('t1');
    expect(aggregateTask(f.store, 't1', at(11)).usage.partial_tokens).toBe(110);
    new Collector(f.store, () => at(12)).tick('t1');
    expect(f.store.eventCount()).toBe(2);
    new Deletion(f.store).deleteTask('t1');
    f.collector.tick('t1');
    expect(f.store.eventCount()).toBe(0);
  } finally {
    f.cleanup();
  }
});

test('actual child activity leaves previous usage partial and exposes a fixed reason', () => {
  const f = fixture();
  try {
    f.life.start('t1');
    f.collector.tick('t1');
    f.append(...f.turn(1, 100, 10));
    f.set(3);
    f.collector.tick('t1');
    f.append({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'SubAgentActivity', text: 'PRIVATE_CHILD' } } }, ...f.turn(4, 200, 20));
    f.set(6);
    f.collector.tick('t1');
    expect(aggregateTask(f.store, 't1', at(6)).usage).toMatchObject({ partial_tokens: 110, complete_tokens: null });
    expect(aggregateTask(f.store, 't1', at(6)).usage.reasons).toContain('child_activity');
  } finally {
    f.cleanup();
  }
});

test('production rejects missing cache-write and blocks model/root/compaction boundaries just like candidate', () => {
  const f = fixture();
  try {
    const parse = (...rows: unknown[]) => parseSnapshot([f.header, ...rows].map(row => JSON.stringify(row)).join('\n') + '\n', f.scope);
    for (const row of [
      { type: 'compacted', payload: {} },
      { type: 'inter_agent_communication_metadata', payload: {} },
      { type: 'event_msg', payload: { type: 'sub_agent_activity' } },
      {
        type: 'turn_context',
        payload: { model: 'other', turn_id: 'child', root_turn_id: 'parent', collaboration_mode: { mode: 'plan' }, multi_agent_version: 'v2' }
      }
    ]) {
      expect(parse(...f.turn(1, 100, 10), row).blocked).toBe(true);
    }
    expect(() =>
      parse({
        timestamp: at(1),
        type: 'event_msg',
        payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } } }
      })
    ).toThrow('unsupported');
  } finally {
    f.cleanup();
  }
});
