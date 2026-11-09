import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, test, vi } from 'vitest';
import { Store } from '../src/store.js';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});
function snapshot(db: Database.Database) {
  const tables = db.prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  return Object.fromEntries(tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'promotion-migration-'));
  roots.push(root);
  const file = join(root, 'store.sqlite');
  const db = new Database(file);
  db.pragma('foreign_keys = ON');
  const directory = new URL('../src/migrations/', import.meta.url);
  for (const name of readdirSync(directory)
    .filter(name => name.endsWith('.sql'))
    .sort()
    .slice(0, 37)) {
    db.exec(readFileSync(new URL(name, directory), 'utf8'));
  }
  db.pragma('user_version = 37');
  db.exec(`
    INSERT INTO projects(id,local_root) VALUES ('project','/synthetic/project');
    INSERT INTO tasks(id,project_id) VALUES ('task','project');
    INSERT INTO sessions(id,project_id,task_id,product,product_version) VALUES ('session','project','task','claude_code','2.1.306');
    INSERT INTO ordinary_project_settings(project_id,settings,settings_hash,updated_at)
      VALUES ('project','{"schema_version":1,"product_version":"2.1.306"}','frozen-settings','2026-11-09T00:00:00.000Z');
    INSERT INTO price_tables(id,payload) VALUES ('frozen-price','{"synthetic":"price-pin"}');
    INSERT INTO ordinary_tasks(task_id,settings,settings_hash,price_table_id,prepared_at)
      VALUES ('task','{"captured":"synthetic"}','frozen-task-settings','frozen-price','2026-11-09T00:00:00.000Z');
    INSERT INTO session_source_compatibility(session_id,payload) VALUES ('session','{"profile_id":"frozen-profile"}');
    INSERT INTO session_bindings(session_id,task_id,root_id,identity,observed_since,generation,state,cursor)
      VALUES ('session','task','session','{"nativeMapping":{"nativeSessionId":"synthetic"}}','2026-11-09T00:00:00.000Z',0,'stopped','frozen-cursor');
    INSERT INTO events(id,project_id,task_id,session_id,source_key,occurred_at,payload)
      VALUES ('event','project','task','session','synthetic:event','2026-11-09T00:00:00.000Z','{"kind":"synthetic"}');
    INSERT INTO tombstones(kind,id,deleted_at) VALUES ('task','forgotten-task','2026-11-09T00:00:00.000Z');
    INSERT INTO ordinary_window_selections(task_id,selection,selection_hash)
      VALUES ('task','{"scope":"synthetic-frozen-window"}','${'a'.repeat(64)}');
    INSERT INTO binding_root_segments(root_session_id,task_id,product,native_root_id,project_root,state,revision,observer_identity,opened_at,baseline_at)
      VALUES ('session','task','claude_code','native-root','/synthetic/project','paused',3,'frozen-observer',
        '2026-11-09T00:00:00.000Z','2026-11-09T00:01:00.000Z');
    UPDATE ordinary_tasks SET selected_root_id='session' WHERE task_id='task';
    INSERT INTO ordinary_window_segments(root_session_id,selection_hash,proof,coverage)
      VALUES ('session','${'a'.repeat(64)}','{"nativePinDigest":"${'b'.repeat(64)}"}','{"childrenStatus":"unobserved"}');
    INSERT INTO binding_baseline_exclusions(session_id,source_identity,request_key) VALUES ('session','frozen-source','excluded-request');
    INSERT INTO binding_native_tombstones(product,native_session_id) VALUES ('codex','forgotten-native-root');
    INSERT INTO ordinary_window_activations(project_id,product,source,policy_id,policy_revision,policy_digest,evidence_mode,
      accepted_risks,implementation_revision,evidence_ref,review_ref,decided_at)
      VALUES ('project','claude_code','claude_binding','claude-binding-root-window-v1','ordinary-window-v2','${'c'.repeat(64)}',
        'publisher_verified_local_pin','["source_identity_limits"]','frozen-implementation','synthetic-evidence','synthetic-review',
        '2026-11-09T00:00:00.000Z');
  `);
  const before = snapshot(db);
  const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  db.close();
  return { file, before, schema };
}

test('upgrade from populated v37 preserves every old table row and frozen pin with an empty denial ledger', () => {
  const f = fixture();
  const store = new Store(f.file);
  try {
    expect(store.get<{ user_version: number }>('PRAGMA user_version')?.user_version).toBe(38);
    for (const [name, rows] of Object.entries(f.before)) {
      expect(store.all(`SELECT * FROM "${name}" ORDER BY rowid`)).toEqual(rows);
    }
    expect(store.all('SELECT * FROM tool_version_promotion_denials')).toEqual([]);
    expect(store.all('SELECT * FROM tool_version_promotion_origins')).toEqual([]);
    expect(store.all('PRAGMA foreign_key_list(tool_version_promotion_origins)')).toEqual([]);
    expect(store.all('SELECT * FROM tool_version_promotion_generation')).toEqual([{ singleton: 1, generation: 0 }]);
    expect(store.all('PRAGMA foreign_key_check')).toEqual([]);
    expect(store.get<{ integrity_check: string }>('PRAGMA integrity_check')?.integrity_check).toBe('ok');
  } finally {
    store.close();
  }
});

test('failure after migration 038 executes rolls back every schema change, old row and user_version', () => {
  const f = fixture();
  const exec: unknown = Reflect.get(Database.prototype, 'exec');
  if (typeof exec !== 'function') throw new Error('fixture_exec_missing');
  const injected = vi.spyOn(Database.prototype, 'exec').mockImplementation(function (this: Database.Database, sql: string) {
    Reflect.apply(exec, this, [sql]);
    if (sql.includes('CREATE TABLE tool_version_promotion_origins')) {
      throw new Error('fixture_migration_failed');
    }
    return this;
  });
  expect(() => new Store(f.file)).toThrow('fixture_migration_failed');
  injected.mockRestore();
  const db = new Database(f.file);
  try {
    expect(db.pragma('user_version', { simple: true })).toBe(37);
    expect(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all()).toEqual(f.schema);
    expect(snapshot(db)).toEqual(f.before);
  } finally {
    db.close();
  }
});
