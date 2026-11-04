import { lstatSync, realpathSync } from 'node:fs';
import Database from 'better-sqlite3';
import { z } from 'zod';
import type { Store } from '../store.js';

export const columns = z.array(z.object({ name: z.string() }));

export const hasTable = (db: Database.Database, table: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));

export function fileIdentity(path: string): string {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(path) !== path) throw new Error('ui_metadata_cleanup_pending');
  return JSON.stringify({ dev: String(stat.dev), ino: String(stat.ino), birth: String(stat.birthtimeNs) });
}

export function queueWebMetadataCleanup(store: Store, kind: 'task' | 'project', id: string, projectId: string): void {
  store.execute(
    `INSERT OR IGNORE INTO local_web_metadata_cleanup(metadata_path,scope_kind,scope_id,project_id)
    SELECT path,?,?,? FROM local_web_metadata_files`,
    [kind, id, projectId]
  );
}

export function flushWebMetadataCleanup(store: Store): void {
  for (const work of store.all<{ metadata_path: string; scope_kind: 'task' | 'project'; scope_id: string; project_id: string | null }>(
    'SELECT * FROM local_web_metadata_cleanup'
  )) {
    try {
      store.immediateTransaction(() => {
        const registered = store.get<{ file_identity: string }>('SELECT file_identity FROM local_web_metadata_files WHERE path=?', [work.metadata_path]);
        if (!registered || fileIdentity(work.metadata_path) !== registered.file_identity) throw new Error('ui_metadata_cleanup_pending');
        const db = new Database(work.metadata_path, { fileMustExist: true });
        try {
          db.pragma('busy_timeout = 5000');
          db.transaction(() => {
            if (hasTable(db, 'web_actions')) {
              const existing = columns.parse(db.pragma('table_info(web_actions)'));
              if (!existing.some(column => column.name === 'task_id') || !existing.some(column => column.name === 'project_id'))
                db.prepare("UPDATE web_actions SET state='deleted',request_hash='',status=400,response=NULL").run();
              else
                db.prepare(
                  `UPDATE web_actions SET state='deleted',request_hash='',status=400,response=NULL
                WHERE (task_id IS NULL AND project_id IS NULL) OR task_id=?
                  OR (project_id=? AND (?='project' OR (state='pending' AND task_id IS NULL)))`
                ).run(work.scope_id, work.project_id ?? work.scope_id, work.scope_kind);
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
                db.prepare("DELETE FROM web_profiles WHERE json_extract(payload,'$.setup.workflow.assignment.project_id')=?").run(work.scope_id);
            }
          }).immediate();
          store.execute('DELETE FROM local_web_metadata_cleanup WHERE metadata_path=? AND scope_kind=? AND scope_id=?', [
            work.metadata_path,
            work.scope_kind,
            work.scope_id
          ]);
        } finally {
          db.close();
        }
      });
    } catch {
      // Only pinned paths and opaque scope IDs remain in the durable pending journal.
    }
  }
}

export function assertWebMetadataCleanupDone(store: Store, kind: 'task' | 'project', id: string): void {
  const pending =
    kind === 'task'
      ? store.get('SELECT 1 FROM local_web_metadata_cleanup WHERE scope_kind=? AND scope_id=?', [kind, id])
      : store.get('SELECT 1 FROM local_web_metadata_cleanup WHERE (scope_kind=? AND scope_id=?) OR project_id=?', [kind, id, id]);
  if (pending) throw new Error('ui_metadata_cleanup_pending');
}
