import { columns, hasTable, fileIdentity, flushWebMetadataCleanup } from './store-metadata-cleanup.js';
import { realpathSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { Store } from './store.js';

export interface WebMetadataScope {
  readonly taskId?: string;
  readonly projectId?: string;
}

/** The Store writer lock orders metadata writes against cross-process deletion. */
export function withLiveWebMetadataScope<T>(store: Store, scope: WebMetadataScope, write: () => T): T {
  return store.immediateTransaction(() => {
    if (
      scope.projectId &&
      (!store.get('SELECT id FROM projects WHERE id=?', [scope.projectId]) ||
        store.get("SELECT 1 FROM tombstones WHERE kind='project' AND id=?", [scope.projectId]))
    )
      throw new Error('deleted_identifier');
    if (
      scope.taskId &&
      (store.get("SELECT 1 FROM tombstones WHERE kind='task' AND id=?", [scope.taskId]) ||
        !store.get('SELECT id FROM tasks WHERE id=? UNION ALL SELECT task_id FROM shared_configuration_tasks WHERE task_id=?', [scope.taskId, scope.taskId]))
    )
      throw new Error('deleted_identifier');
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
          [row.id, row.id]
        );
        if (owner) db.prepare('UPDATE web_tasks SET project_id=? WHERE id=?').run(owner.project_id, row.id);
      }
    }
    if (hasTable(db, 'web_actions')) {
      const existing = columns.parse(db.pragma('table_info(web_actions)'));
      for (const name of ['task_id', 'project_id'])
        if (!existing.some(column => column.name === name)) db.exec(`ALTER TABLE web_actions ADD COLUMN ${name} TEXT`);
    }
    if (db.name === ':memory:') return;
    const path = realpathSync(db.name);
    const identity = fileIdentity(path);
    const prior = store.get<{ file_identity: string }>('SELECT file_identity FROM local_web_metadata_files WHERE path=?', [path]);
    if (prior && prior.file_identity !== identity) throw new Error('ui_metadata_cleanup_pending');
    store.execute('INSERT OR IGNORE INTO local_web_metadata_files(path,file_identity) VALUES (?,?)', [path, identity]);
    for (const row of store.all<{ kind: 'task' | 'project'; id: string }>("SELECT kind,id FROM tombstones WHERE kind IN ('task','project')"))
      store.execute(
        `INSERT OR IGNORE INTO local_web_metadata_cleanup(metadata_path,scope_kind,scope_id)
        VALUES (?,?,?)`,
        [path, row.kind, row.id]
      );
  });
  flushWebMetadataCleanup(store);
  if (db.name !== ':memory:' && store.get('SELECT 1 FROM local_web_metadata_cleanup WHERE metadata_path=?', [realpathSync(db.name)]))
    throw new Error('ui_metadata_cleanup_pending');
}
