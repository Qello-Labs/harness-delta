import { expect, test } from 'vitest';
import { Store } from '../src/store.js';
import { Lifecycle } from '../src/lifecycle.js';
import { main, isEntrypoint } from '../src/cli.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const metadata = { type: 'feature', expected_size: 'small', assignee: 'u1', product: 'synthetic', model: 'synthetic-model', criterion_ids: ['c1'] };

test('lifecycle reserves the writer before state reads so collector writes cannot invalidate its snapshot', () => {
  const root = mkdtempSync(join(tmpdir(), 'lifecycle-writer-'));
  const path = join(root, 'local.db');
  const store = new Store(path);
  const other = new Store(path);
  other.execute('PRAGMA busy_timeout=0', []);
  let armed = false;
  let blocked = false;
  const life = new Lifecycle(store, () => {
    if (armed) {
      try {
        other.execute('BEGIN IMMEDIATE', []);
      } catch (error) {
        blocked = error instanceof Error && error.message.includes('locked');
      }
    }
    return '2026-01-01T00:00:00Z';
  });
  try {
    store.execute("INSERT INTO projects(id) VALUES ('p1')", []);
    life.createTask('p1', 't1', metadata);
    life.start('t1');
    life.declareFirst('t1');
    armed = true;
    expect(() => life.assessFirst('t1', false)).not.toThrow();
    expect(blocked).toBe(true);
    expect(life.task('t1').first_success).toBe(0);
  } finally {
    try {
      other.execute('ROLLBACK', []);
    } catch {
      /* No reservation acquired. */
    }
    other.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('task transitions preserve first assessment, rework and immutable final outcome', () => {
  const store = new Store(':memory:');
  const lifecycle = new Lifecycle(store);
  try {
    store.execute('INSERT INTO projects(id) VALUES (?)', ['p1']);
    lifecycle.createTask('p1', 't1', metadata);
    expect(lifecycle.state('t1')).toBe('registered');
    expect(() => lifecycle.resume('t1')).toThrow();
    lifecycle.start('t1');
    lifecycle.pause('t1');
    lifecycle.resume('t1');
    expect(lifecycle.state('t1')).toBe('active');
    lifecycle.declareFirst('t1');
    expect(() => lifecycle.declareFirst('t1')).toThrow();
    lifecycle.assessFirst('t1', false);
    lifecycle.rework('t1');
    lifecycle.finalize('t1', 'success', ['c1']);
    expect(lifecycle.state('t1')).toBe('finalized');
    expect(lifecycle.summary('t1')).toMatchObject({ first_success: false, outcome: 'success', rework_count: 1 });
    for (const action of [
      () => lifecycle.start('t1'),
      () => lifecycle.pause('t1'),
      () => lifecycle.resume('t1'),
      () => lifecycle.rework('t1'),
      () => lifecycle.assessFirst('t1', true),
      () => lifecycle.finalize('t1', 'failed', [])
    ])
      expect(action).toThrow();
  } finally {
    store.close();
  }
});

test('preregistration and success require complete fixed criteria', () => {
  const store = new Store(':memory:');
  const lifecycle = new Lifecycle(store);
  try {
    expect(() => lifecycle.createTask('missing', 't1', metadata)).toThrow();
    store.execute('INSERT INTO projects(id) VALUES (?)', ['p1']);
    expect(() => lifecycle.createTask('p1', 't1', { ...metadata, criterion_ids: [] })).toThrow();
    expect(() => lifecycle.createTask('p1', 't1', { ...metadata, expected_size: undefined })).toThrow();
    lifecycle.createTask('p1', 't1', metadata);
    lifecycle.start('t1');
    expect(() => lifecycle.finalize('t1', 'success', [])).toThrow();
    expect(() => lifecycle.finalize('t1', 'failed', ['unknown'])).toThrow();
    lifecycle.finalize('t1', 'aborted', []);
  } finally {
    store.close();
  }
});

test('CLI refuses unknown finalization and importing the module does not run it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lifecycle-test-'));
  const db = join(root, 'local.db');
  try {
    expect(await main(['--db', db, 'project', 'add', 'p1', '--root', root])).toBe(0);
    expect(await main(['--db', db, 'task', 'finalize', 'unknown', '--outcome', 'success'])).toBe(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('active time intervals do not imply collection and regression of the clock is rejected', () => {
  const store = new Store(':memory:');
  let now = '2026-01-01T00:00:00Z';
  const life = new Lifecycle(store, () => now);
  try {
    store.execute('INSERT INTO projects(id) VALUES (?)', ['p1']);
    life.createTask('p1', 't1', metadata);
    life.start('t1');
    now = '2026-01-01T00:00:10Z';
    life.pause('t1');
    now = '2026-01-01T00:00:05Z';
    expect(() => life.resume('t1')).toThrow('clock_regression');
    now = '2026-01-01T00:00:20Z';
    life.resume('t1');
    now = '2026-01-01T00:00:30Z';
    life.finalize('t1', 'success', ['c1']);
    const intervals = store.all<{ started_at: string; ended_at: string }>(
      'SELECT started_at,ended_at FROM active_intervals WHERE task_id = ? ORDER BY started_at',
      ['t1']
    );
    expect(intervals.map(row => Date.parse(row.ended_at) - Date.parse(row.started_at))).toEqual([10000, 10000]);
    expect(store.all('SELECT * FROM observations')).toHaveLength(0);
  } finally {
    store.close();
  }
});

test('session linking validates the task and product without reading source contents', () => {
  const store = new Store(':memory:');
  const life = new Lifecycle(store);
  try {
    store.execute('INSERT INTO projects(id) VALUES (?)', ['p1']);
    life.createTask('p1', 't1', { ...metadata, product: 'codex' });
    life.linkSession('t1', 's1', '/synthetic/nonexistent.jsonl', 'codex', '0.156.1');
    expect(store.all('SELECT id FROM sessions')).toHaveLength(1);
    expect(() => life.linkSession('t1', 's2', '/synthetic/nonexistent.jsonl', 'claude_code', '2.1.283')).toThrow('product_mismatch');
    life.start('t1');
    life.finalize('t1', 'aborted', []);
    expect(() => life.linkSession('t1', 's3', '/synthetic/nonexistent.jsonl', 'codex', '0.156.1')).toThrow('invalid_transition');
  } finally {
    store.close();
  }
});

test('session link rejects unregistered versions before reading a file', () => {
  const store = new Store(':memory:');
  const life = new Lifecycle(store);
  try {
    store.execute('INSERT INTO projects(id) VALUES (?)', ['p1']);
    life.createTask('p1', 't1', { ...metadata, product: 'codex' });
    const missing = '/synthetic/does-not-exist-unregistered.jsonl';
    for (const [sessionId, version] of [
      ['s9', '0.164.0'],
      ['s10', '0.156.1-rc.1'],
      ['s11', '0.156.1+build.1'],
      ['s12', '0.156.10'],
      ['s13', '2.1.283']
    ] as const) {
      expect(() => life.linkSession('t1', sessionId, missing, 'codex', version)).toThrow(/^unsupported$/);
    }
    expect(() => life.linkSession('t1', 's14', missing, 'codex', '>=0.156.1')).toThrow();
    expect(() => life.linkSession('t1', 's15', missing, 'claude_code', '0.156.1')).toThrow(/^unsupported$/);
    expect(() => life.linkSession('t1', 's16', missing, 'claude_code', '2.1.283')).toThrow(/^product_mismatch$/);
    expect(store.all('SELECT id FROM sessions')).toEqual([]);
  } finally {
    store.close();
  }
});

test('entry detection tolerates non-file process arguments', () => {
  expect(isEntrypoint('-')).toBe(false);
  expect(isEntrypoint(undefined)).toBe(false);
});
