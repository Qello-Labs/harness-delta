import { lstatSync, realpathSync } from 'node:fs';
import Database from 'better-sqlite3';
import { z } from 'zod';
import type { Store } from './store.js';

export interface WebMetadataScope {
  readonly taskId?: string;
  readonly projectId?: string;
}
const columns = z.array(z.object({ name: z.string() }));
const hasTable = (db: Database.Database, table: string) =>
  Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
function fileIdentity(path: string): string {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(path) !== path)
    throw new Error('ui_metadata_cleanup_pending');
  return JSON.stringify({ dev: String(stat.dev), ino: String(stat.ino), birth: String(stat.birthtimeNs) });
}

/** The Store writer lock orders metadata writes against cross-process deletion. */
export function withLiveWebMetadataScope<T>(store: Store, scope: WebMetadataScope, write: () => T): T {
  return store.immediateTransaction(() => {
    if (scope.projectId && (!store.get('SELECT id FROM projects WHERE id=?', [scope.projectId]) ||
      store.get("SELECT 1 FROM tombstones WHERE kind='project' AND id=?", [scope.projectId])))
      throw new Error('deleted_identifier');
    if (scope.taskId && (store.get("SELECT 1 FROM tombstones WHERE kind='task' AND id=?", [scope.taskId]) ||
      !store.get('SELECT id FROM tasks WHERE id=? UNION ALL SELECT task_id FROM shared_configuration_tasks WHERE task_id=?',
        [scope.taskId, scope.taskId]))) throw new Error('deleted_identifier');
    return write();
  });
}

export function registerWebMetadata(store: Store, db: Database.Database): void {
  store.immediateTransaction(() => {
    if (hasTable(db, 'web_tasks')) {
      if (!columns.parse(db.pragma('table_info(web_tasks)')).some(column => column.name === 'project_id'))
        db.exec('ALTER TABLE web_tasks ADD COLUMN project_id TEXT');
      const rows = z.array(z.object({ id: z.string() })).parse(db.prepare('SELECT id FROM web_tasks WHERE project_id IS NULL').all());
      for (const row of rows) {
        const owner = store.get<{ project_id: string }>(
          'SELECT project_id FROM tasks WHERE id=? UNION ALL SELECT project_id FROM shared_configuration_tasks WHERE task_id=?',
          [row.id, row.id]);
        if (owner) db.prepare('UPDATE web_tasks SET project_id=? WHERE id=?').run(owner.project_id, row.id);
      }
    }
    if (hasTable(db, 'web_actions')) {
      const existing = columns.parse(db.pragma('table_info(web_actions)'));
      for (const name of ['task_id', 'project_id']) if (!existing.some(column => column.name === name))
        db.exec(`ALTER TABLE web_actions ADD COLUMN ${name} TEXT`);
    }
    if (db.name === ':memory:') return;
    const path = realpathSync(db.name);
    const identity = fileIdentity(path);
    const prior = store.get<{ file_identity: string }>('SELECT file_identity FROM local_web_metadata_files WHERE path=?', [path]);
    if (prior && prior.file_identity !== identity) throw new Error('ui_metadata_cleanup_pending');
    store.execute('INSERT OR IGNORE INTO local_web_metadata_files(path,file_identity) VALUES (?,?)', [path, identity]);
    for (const row of store.all<{ kind: 'task' | 'project'; id: string }>(
      "SELECT kind,id FROM tombstones WHERE kind IN ('task','project')"))
      store.execute(`INSERT OR IGNORE INTO local_web_metadata_cleanup(metadata_path,scope_kind,scope_id)
        VALUES (?,?,?)`, [path, row.kind, row.id]);
  });
  flushWebMetadataCleanup(store);
  if (db.name !== ':memory:' && store.get('SELECT 1 FROM local_web_metadata_cleanup WHERE metadata_path=?', [realpathSync(db.name)]))
    throw new Error('ui_metadata_cleanup_pending');
}

export function queueWebMetadataCleanup(store: Store, kind: 'task' | 'project', id: string, projectId: string): void {
  store.execute(`INSERT OR IGNORE INTO local_web_metadata_cleanup(metadata_path,scope_kind,scope_id,project_id)
    SELECT path,?,?,? FROM local_web_metadata_files`, [kind, id, projectId]);
}

export function flushWebMetadataCleanup(store: Store): void {
  for (const work of store.all<{ metadata_path: string; scope_kind: 'task' | 'project'; scope_id: string; project_id: string | null }>(
    'SELECT * FROM local_web_metadata_cleanup')) {
    try {
      store.immediateTransaction(() => {
        const registered = store.get<{ file_identity: string }>(
          'SELECT file_identity FROM local_web_metadata_files WHERE path=?', [work.metadata_path]);
        if (!registered || fileIdentity(work.metadata_path) !== registered.file_identity)
          throw new Error('ui_metadata_cleanup_pending');
        const db = new Database(work.metadata_path, { fileMustExist: true });
        try {
          db.pragma('busy_timeout = 5000');
          db.transaction(() => {
            if (hasTable(db, 'web_actions')) {
              const existing = columns.parse(db.pragma('table_info(web_actions)'));
              if (!existing.some(column => column.name === 'task_id') || !existing.some(column => column.name === 'project_id'))
                db.prepare("UPDATE web_actions SET state='deleted',request_hash='',status=400,response=NULL").run();
              else db.prepare(`UPDATE web_actions SET state='deleted',request_hash='',status=400,response=NULL
                WHERE (task_id IS NULL AND project_id IS NULL) OR task_id=?
                  OR (project_id=? AND (?='project' OR (state='pending' AND task_id IS NULL)))`)
                .run(work.scope_id, work.project_id ?? work.scope_id, work.scope_kind);
            }
            if (hasTable(db, 'web_sources')) {
              db.prepare('DELETE FROM web_sources WHERE task_id=?').run(work.scope_id);
              if (work.scope_kind === 'project' && hasTable(db, 'web_tasks'))
                db.prepare('DELETE FROM web_sources WHERE task_id IN (SELECT id FROM web_tasks WHERE project_id=?)').run(work.scope_id);
            }
            if (hasTable(db, 'web_tasks')) {
              db.prepare('DELETE FROM web_tasks WHERE id=?').run(work.scope_id);
              if (work.scope_kind === 'project') db.prepare('DELETE FROM web_tasks WHERE project_id=?').run(work.scope_id);
            }
            if (work.scope_kind === 'project') {
              for (const table of ['web_codex_connections', 'web_shared_versions'])
                if (hasTable(db, table)) db.prepare(`DELETE FROM ${table} WHERE project_id=?`).run(work.scope_id);
              if (hasTable(db, 'web_profiles'))
                db.prepare("DELETE FROM web_profiles WHERE json_extract(payload,'$.setup.workflow.assignment.project_id')=?")
                  .run(work.scope_id);
            }
          }).immediate();
          store.execute('DELETE FROM local_web_metadata_cleanup WHERE metadata_path=? AND scope_kind=? AND scope_id=?',
            [work.metadata_path, work.scope_kind, work.scope_id]);
        } finally { db.close(); }
      });
    } catch {
      // Only pinned paths and opaque scope IDs remain in the durable pending journal.
    }
  }
}

export function assertWebMetadataCleanupDone(store: Store, kind: 'task' | 'project', id: string): void {
  const pending = kind === 'task'
    ? store.get('SELECT 1 FROM local_web_metadata_cleanup WHERE scope_kind=? AND scope_id=?', [kind, id])
    : store.get('SELECT 1 FROM local_web_metadata_cleanup WHERE (scope_kind=? AND scope_id=?) OR project_id=?', [kind, id, id]);
  if (pending) throw new Error('ui_metadata_cleanup_pending');
}
