import { expect, test } from 'vitest';
import { aggregateTask } from '../src/metrics.js';
import { collectionFixture, jsonLines } from './helpers/collection-fixture.js';

// Reallocating ordinary/cache-create input preserves total input (100) and
// cached-read input (40). Comparing only normalized usage loses this revision.
const reallocate = (text: string) =>
  text.replace('"input_tokens":20', '"input_tokens":21').replace('"cache_creation_input_tokens":40', '"cache_creation_input_tokens":39');
const modes = ['growing-auxiliary', 'growing-message', 'same-size-unchanged-mtime', 'same-size-changed-mtime'] as const;
for (const settled of [false, true]) {
  test.each(modes)(`Claude rejects ${settled ? 'settled' : 'deferred'} cross-poll component revisions in %s`, mode => {
    const f = collectionFixture('claude_code');
    try {
      f.life.start('t1');
      f.collector.tick('t1');
      const first = f.turn(1, 2, 1, 'first');
      f.rows(...first);
      f.set(2);
      f.collector.tick('t1');
      const target = jsonLines(f.turn(3, 8, 1, 'target'));
      const prefix = jsonLines([f.header(), ...first]);
      const original = prefix + target;
      f.replace(original);
      f.set(settled ? 8 : 4);
      expect(f.collector.tick('t1')).toEqual([]);
      const events = f.state().events;
      expect(events).toHaveLength(settled ? 2 : 1);
      const suffix =
        mode === 'growing-auxiliary' ? jsonLines([{ type: 'progress' }]) : mode === 'growing-message' ? jsonLines(f.turn(7, 8, 1, 'additional')) : '';
      const revised = prefix + reallocate(target) + suffix;
      if (mode.startsWith('same-size')) expect(Buffer.byteLength(revised)).toBe(Buffer.byteLength(original));
      else expect(Buffer.byteLength(revised)).toBeGreaterThan(Buffer.byteLength(original));
      // Growing sources also retain mtime: neither size nor mtime grants identity.
      f.replace(revised, { modified: Buffer.byteLength(original) + (mode === 'same-size-changed-mtime' ? 1 : 0) });
      f.set(9);
      expect(f.collector.tick('t1')).toEqual([
        { session_id: 's1', at: f.clock(), category: mode === 'same-size-changed-mtime' ? 'same_size_modified' : 'record_changed' }
      ]);
      expect(f.state().events).toEqual(events);
      expect(f.store.all('SELECT checkpoint FROM cursors')).toEqual([]);
      const usage = aggregateTask(f.store, 't1', f.clock()).usage;
      expect(usage).toMatchObject({ status: 'partial', partial_tokens: settled ? 260 : 130, complete_tokens: null });
      expect(usage.reasons).toContain('source_error');
      // Recovery consumes every revised/uncertain record, including future ones.
      const recovery = revised + jsonLines(f.turn(10, 15, 1, 'uncertain'));
      f.replace(recovery);
      f.set(11);
      expect(f.collector.tick('t1')).toEqual([]);
      f.set(16);
      expect(f.collector.tick('t1')).toEqual([]);
      expect(f.state().events).toEqual(events);
      f.replace(recovery + jsonLines(f.turn(17, 18, 1, 'new')));
      f.set(18);
      expect(f.collector.tick('t1')).toEqual([]);
      expect(f.collector.tick('t1')).toEqual([]);
      expect(f.events()).toHaveLength(settled ? 3 : 2);
      expect(aggregateTask(f.store, 't1', f.clock()).usage).toMatchObject({ partial_tokens: settled ? 390 : 260, complete_tokens: null });
    } finally {
      f.cleanup();
    }
  });
}

test.each([false, true])('Claude exact component replay and new append remain eligible with settled=%s', settled => {
  const f = collectionFixture('claude_code');
  try {
    f.life.start('t1');
    f.collector.tick('t1');
    const first = f.turn(1, 8, 1, 'first');
    f.rows(...first);
    f.set(settled ? 8 : 2);
    expect(f.collector.tick('t1')).toEqual([]);
    const original = jsonLines([f.header(), ...first]);
    f.replace(original + jsonLines([f.origin(9, 'next'), ...f.usage(8, 1, 'first'), ...f.usage(10, 1, 'next')]), { modified: Buffer.byteLength(original) });
    f.set(10);
    expect(f.collector.tick('t1')).toEqual([]);
    expect(f.collector.tick('t1')).toEqual([]);
    expect(aggregateTask(f.store, 't1', f.clock()).usage).toMatchObject({ partial_tokens: 260, complete_tokens: null, input_total: { observed_events: 2 } });
    expect(f.store.all("SELECT reason FROM observations WHERE status='error'")).toEqual([]);
  } finally {
    f.cleanup();
  }
});

test('Claude component conflict invalidation rolls back atomically and is rejected again on retry', () => {
  const f = collectionFixture('claude_code');
  try {
    f.life.start('t1');
    f.collector.tick('t1');
    const original = jsonLines([f.header(), ...f.turn(1, 8)]);
    f.replace(original);
    f.set(2);
    f.collector.tick('t1');
    const before = f.state();
    f.replace(reallocate(original) + jsonLines([{ type: 'progress' }]));
    f.set(9);
    f.store.execute("CREATE TRIGGER fail_invalidation BEFORE DELETE ON cursors BEGIN SELECT RAISE(ABORT,'synthetic'); END", []);
    expect(() => f.collector.tick('t1')).toThrow(/^collection_error$/);
    expect(f.state()).toEqual(before);
    f.store.execute('DROP TRIGGER fail_invalidation', []);
    expect(f.collector.tick('t1')).toMatchObject([{ category: 'record_changed' }]);
    expect(f.events()).toHaveLength(0);
    expect(f.store.all('SELECT checkpoint FROM cursors')).toEqual([]);
    expect(f.store.all("SELECT reason FROM observations WHERE status='error'")).toEqual([{ reason: 'source_error' }]);
  } finally {
    f.cleanup();
  }
});
