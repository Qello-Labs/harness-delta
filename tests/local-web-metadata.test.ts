import Database from 'better-sqlite3';
import { mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { Store } from '../src/store.js';
import { Deletion } from '../src/deletion.js';
import { registerWebMetadata } from '../src/local-web-metadata.js';
import { createCodexProjectSetupManager } from '../src/local-web-codex.js';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'web-metadata-')));
  const path = join(root, 'store.sqlite');
  const metadataPath = join(root, 'custom.sqlite');
  const store = new Store(path);
  const metadata = new Database(metadataPath);
  cleanups.push(() => { metadata.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  store.execute("INSERT INTO projects(id) VALUES ('p1'),('p2')", []);
  store.execute("INSERT INTO tasks(id,project_id) VALUES ('t1','p1'),('t2','p2')", []);
  metadata.exec(`CREATE TABLE web_tasks(id TEXT PRIMARY KEY,name TEXT,setup TEXT);
    CREATE TABLE web_sources(handle TEXT PRIMARY KEY,task_id TEXT,payload TEXT);
    CREATE TABLE web_actions(id TEXT PRIMARY KEY,request_hash TEXT,state TEXT,status INTEGER,response TEXT);
    INSERT INTO web_tasks VALUES ('t1','private-one','{}'),('t2','private-two','{}');
    INSERT INTO web_sources VALUES ('s1','t1','private-source');
    INSERT INTO web_actions VALUES ('legacy-key','opaque-hash','done',200,'{"private":"cached"}')`);
  registerWebMetadata(store, metadata);
  return { root, path, metadataPath, store, metadata };
}

test('failed private cleanup remains pending and Store reopen retries a custom database without UI startup', () => {
  const f = fixture();
  f.metadata.exec("CREATE TRIGGER refuse_cleanup BEFORE DELETE ON web_tasks BEGIN SELECT RAISE(ABORT,'synthetic_failure'); END");
  expect(() => new Deletion(f.store).deleteTask('t1')).toThrow('ui_metadata_cleanup_pending');
  expect(f.store.get("SELECT id FROM tasks WHERE id='t1'")).toBeUndefined();
  expect(f.store.all('SELECT * FROM local_web_metadata_cleanup')).toHaveLength(1);
  f.metadata.exec('DROP TRIGGER refuse_cleanup');
  const restarted = new Store(f.path);
  try {
    expect(restarted.all('SELECT * FROM local_web_metadata_cleanup')).toEqual([]);
    expect(f.metadata.prepare('SELECT id FROM web_tasks ORDER BY id').all()).toEqual([{ id: 't2' }]);
    expect(f.metadata.prepare("SELECT state,request_hash,response FROM web_actions WHERE id='legacy-key'").get())
      .toEqual({ state: 'deleted', request_hash: '', response: null });
    expect(() => new Deletion(restarted).deleteTask('t1')).not.toThrow();
  } finally { restarted.close(); }
});

test('retention retries prior cleanup even when no new task is eligible', () => {
  const f = fixture();
  f.store.execute("UPDATE tasks SET state='finalized',finalized_at='2026-01-01T00:00:00Z' WHERE id='t1'", []);
  f.store.execute("UPDATE projects SET retention_days=1 WHERE id='p1'", []);
  f.metadata.exec("CREATE TRIGGER refuse_cleanup BEFORE DELETE ON web_tasks BEGIN SELECT RAISE(ABORT,'synthetic_failure'); END");
  expect(() => new Deletion(f.store).applyRetention('p1', '2026-02-01T00:00:00Z')).toThrow('ui_metadata_cleanup_pending');
  f.metadata.exec('DROP TRIGGER refuse_cleanup');
  expect(new Deletion(f.store).applyRetention('p1', '2026-02-01T00:00:00Z')).toBe(0);
  expect(f.metadata.prepare("SELECT id FROM web_tasks WHERE id='t1'").get()).toBeUndefined();
});

test.each(['replacement', 'symlink'] as const)('cleanup leaves a %s metadata file untouched and reports pending', kind => {
  const f = fixture();
  renameSync(f.metadataPath, join(f.root, 'original.sqlite'));
  const otherPath = join(f.root, 'other.sqlite');
  const other = new Database(otherPath);
  try {
    other.exec("CREATE TABLE web_tasks(id TEXT,name TEXT); INSERT INTO web_tasks VALUES ('t1','unrelated')");
    if (kind === 'symlink') symlinkSync(otherPath, f.metadataPath);
    else renameSync(otherPath, f.metadataPath);
    expect(() => new Deletion(f.store).deleteTask('t1')).toThrow('ui_metadata_cleanup_pending');
    expect(other.prepare('SELECT name FROM web_tasks').get()).toEqual({ name: 'unrelated' });
    expect(f.store.all('SELECT * FROM local_web_metadata_cleanup')).toHaveLength(1);
  } finally { other.close(); }
});

test('a replay after private commit but failed journal acknowledgement is idempotent', () => {
  const f = fixture();
  f.store.execute(`CREATE TRIGGER refuse_ack BEFORE DELETE ON local_web_metadata_cleanup
    BEGIN SELECT RAISE(ABORT,'synthetic_failure'); END`, []);
  expect(() => new Deletion(f.store).deleteTask('t1')).toThrow('ui_metadata_cleanup_pending');
  expect(f.metadata.prepare("SELECT id FROM web_tasks WHERE id='t1'").get()).toBeUndefined();
  expect(f.store.all('SELECT * FROM local_web_metadata_cleanup')).toHaveLength(1);
  f.store.execute('DROP TRIGGER refuse_ack', []);
  expect(() => new Deletion(f.store).deleteTask('t1')).not.toThrow();
  expect(f.store.all('SELECT * FROM local_web_metadata_cleanup')).toEqual([]);
  expect(f.metadata.prepare("SELECT name FROM web_tasks WHERE id='t2'").get()).toEqual({ name: 'private-two' });
});

test('reserved shared tasks survive registration and are removed with their project', () => {
  const f = fixture();
  f.store.execute('INSERT INTO shared_configuration_tasks VALUES (?,?,?,?)', ['reserved', 'p1', 'a'.repeat(64), 'b'.repeat(64)]);
  f.metadata.prepare('INSERT INTO web_tasks(id,name,setup,project_id) VALUES (?,?,?,?)')
    .run('reserved', 'private-reservation', '{}', 'p1');
  registerWebMetadata(f.store, f.metadata);
  expect(f.metadata.prepare("SELECT name FROM web_tasks WHERE id='reserved'").get()).toEqual({ name: 'private-reservation' });
  new Deletion(f.store).deleteProject('p1');
  expect(f.metadata.prepare('SELECT id FROM web_tasks ORDER BY id').all()).toEqual([{ id: 't2' }]);
  expect(f.store.all('SELECT * FROM shared_configuration_tasks')).toEqual([]);
});

test('Codex configuration cannot restore private paths after a concurrent project deletion', () => {
  const f = fixture();
  f.store.execute('UPDATE projects SET local_root=? WHERE id=?', [f.root, 'p1']);
  const manager = createCodexProjectSetupManager(f.store, f.metadata);
  const deleting = new Store(f.path);
  const prepare = f.metadata.prepare.bind(f.metadata);
  let deleted = false;
  const intercept = vi.spyOn(f.metadata, 'prepare').mockImplementation(sql => {
    const statement = prepare(sql);
    if (!deleted && sql === 'SELECT settings FROM web_codex_connections WHERE project_id=?') {
      const get = statement.get.bind(statement);
      vi.spyOn(statement, 'get').mockImplementation((...args) => {
        const saved = get(...args);
        deleted = true;
        new Deletion(deleting).deleteProject('p1');
        return saved;
      });
    }
    return statement;
  });
  try {
    expect(() => manager.action('p1', { operation: 'configure', source_roots: ['/synthetic/private-source'] }))
      .toThrow(/deleted_identifier|unknown_project/);
    expect(deleted).toBe(true);
    expect(prepare('SELECT * FROM web_codex_connections').all()).toEqual([]);
    const restarted = new Store(f.path);
    try {
      expect(restarted.all('SELECT * FROM local_web_metadata_cleanup')).toEqual([]);
      expect(prepare('SELECT * FROM web_codex_connections').all()).toEqual([]);
    } finally { restarted.close(); }
  } finally { intercept.mockRestore(); deleting.close(); }
});

test('Codex private configuration holds the Store writer lock before its INSERT', () => {
  const f = fixture();
  f.store.execute('UPDATE projects SET local_root=? WHERE id=?', [f.root, 'p1']);
  const manager = createCodexProjectSetupManager(f.store, f.metadata);
  const competing = new Database(f.path);
  competing.pragma('busy_timeout = 0');
  const prepare = f.metadata.prepare.bind(f.metadata);
  let checked = false;
  const intercept = vi.spyOn(f.metadata, 'prepare').mockImplementation(sql => {
    if (sql.startsWith('INSERT INTO web_codex_connections')) {
      checked = true;
      expect(() => competing.exec('BEGIN IMMEDIATE')).toThrow('database is locked');
    }
    return prepare(sql);
  });
  try {
    manager.action('p1', { operation: 'configure', source_roots: ['/synthetic/private-source'] });
    expect(checked).toBe(true);
    new Deletion(f.store).deleteProject('p1');
    expect(prepare('SELECT * FROM web_codex_connections').all()).toEqual([]);
  } finally {
    intercept.mockRestore();
    if (competing.inTransaction) competing.exec('ROLLBACK');
    competing.close();
  }
});
