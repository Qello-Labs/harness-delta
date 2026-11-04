import { expect, test } from 'vitest';
import { Store } from '../src/store.js';
import { Lifecycle } from '../src/lifecycle.js';
import { Deletion } from '../src/deletion.js';
const metadata = { type: 'fix', expected_size: 'small', assignee: 'u1', product: 'synthetic', model: 'synthetic', criterion_ids: ['c1'] };

test('deletion removes children and events and prevents re-registration', () => {
  const store = new Store(':memory:');
  const life = new Lifecycle(store);
  const deletion = new Deletion(store);
  try {
    store.execute('INSERT INTO projects(id) VALUES (?)', ['p1']);
    life.createTask('p1', 't1', metadata);
    store.execute('INSERT INTO sessions(id,project_id,task_id) VALUES (?,?,?)', ['s1', 'p1', 't1']);
    store.execute('INSERT INTO sessions(id,project_id,task_id,parent_id) VALUES (?,?,?,?)', ['s2', 'p1', 't1', 's1']);
    store.putEvent({
      id: 'e1',
      project_id: 'p1',
      task_id: 't1',
      session_id: 's2',
      source_key: 'source:1',
      occurred_at: '2026-01-01T00:00:00Z',
      payload: { kind: 'session_linked' }
    });
    deletion.deleteTask('t1');
    expect(store.eventCount()).toBe(0);
    expect(() => life.state('t1')).toThrow();
    expect(() => life.createTask('p1', 't1', metadata)).toThrow();
    expect(deletion.isDeleted('task', 't1')).toBe(true);
    expect(deletion.isDeleted('session', 's2')).toBe(true);
    deletion.deleteProject('p1');
    expect(deletion.isDeleted('project', 'p1')).toBe(true);
  } finally {
    store.close();
  }
});

test('retention is explicit and uses finalization age and the same tombstone path', () => {
  const store = new Store(':memory:');
  const life = new Lifecycle(store, () => '2026-01-01T00:00:00Z');
  const deletion = new Deletion(store);
  try {
    store.execute('INSERT INTO projects(id) VALUES (?)', ['p1']);
    expect(() => deletion.applyRetention('p1', '2026-02-01T00:00:00Z')).toThrow('retention_not_configured');
    life.createTask('p1', 'old', metadata);
    life.start('old');
    life.finalize('old', 'aborted', []);
    life.createTask('p1', 'active', metadata);
    life.start('active');
    store.execute('UPDATE projects SET retention_days = ? WHERE id = ?', [7, 'p1']);
    expect(deletion.applyRetention('p1', '2026-02-01T00:00:00Z')).toBe(1);
    expect(deletion.isDeleted('task', 'old')).toBe(true);
    expect(life.state('active')).toBe('active');
  } finally {
    store.close();
  }
});

test('a failed delete rolls back both records and tombstones', () => {
  const store = new Store(':memory:');
  const life = new Lifecycle(store);
  const deletion = new Deletion(store);
  try {
    store.execute('INSERT INTO projects(id) VALUES (?)', ['p1']);
    life.createTask('p1', 't1', metadata);
    store.execute("CREATE TRIGGER fail_delete BEFORE DELETE ON tasks BEGIN SELECT RAISE(ABORT, 'synthetic_failure'); END", []);
    expect(() => deletion.deleteTask('t1')).toThrow();
    expect(life.state('t1')).toBe('registered');
    expect(deletion.isDeleted('task', 't1')).toBe(false);
  } finally {
    store.close();
  }
});
