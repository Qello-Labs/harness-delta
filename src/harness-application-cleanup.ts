import { lstatSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from './store.js';
import { IdSchema } from './contracts.js';
function directoryIdentity(path: string) {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) throw new Error('application_cleanup_pending');
  return JSON.stringify({ dev: String(stat.dev), ino: String(stat.ino), birth: String(stat.birthtimeNs) });
}
/** Called inside deletion's transaction; native edits are never cleanup targets. */
export function queueApplicationCleanup(store: Store, taskId: string) {
  const record = store.get<{ local_root: string; project_id: string }>(
    "SELECT p.local_root,p.id AS project_id FROM projects p JOIN tasks t ON t.project_id=p.id WHERE t.id=? AND t.application_mode='agent_applied'",
    [taskId]
  );
  if (!record) return;
  let identity: string;
  try {
    identity = directoryIdentity(record.local_root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    identity = 'unverified';
  }
  store.execute('INSERT OR IGNORE INTO harness_application_cleanup(task_id,project_id,project_root,root_identity) VALUES(?,?,?,?)', [
    IdSchema.parse(taskId),
    record.project_id,
    record.local_root,
    identity
  ]);
}
/** Retry only pinned product-owned ignored artifacts after the DB deletion commits.
 * Unsafe/replaced roots stay pending; no following symlinks or workspace rollback.
 */
export function flushApplicationCleanup(store: Store) {
  for (const row of store.all<{ task_id: string; project_root: string; root_identity: string }>('SELECT * FROM harness_application_cleanup')) {
    try {
      if (!store.get("SELECT 1 FROM tombstones WHERE kind='task' AND id=?", [row.task_id])) continue;
      let missing = false;
      try {
        if (directoryIdentity(row.project_root) !== row.root_identity) continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') missing = true;
        else continue;
      }
      if (!missing) {
        let folder = row.project_root;
        for (const part of ['.harness-delta', 'applications', IdSchema.parse(row.task_id)]) {
          folder = join(folder, part);
          try {
            directoryIdentity(folder);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
              missing = true;
              break;
            }
            throw error;
          }
        }
        if (!missing) {
          if (directoryIdentity(row.project_root) !== row.root_identity) continue;
          rmSync(folder, { recursive: true });
        }
      }
      store.execute('DELETE FROM harness_application_cleanup WHERE task_id=?', [row.task_id]);
    } catch {
      /* Durable safe-code journal records pending cleanup, never private bytes. */
    }
  }
}
export function assertApplicationCleanupDone(store: Store, taskId: string) {
  if (store.get('SELECT 1 FROM harness_application_cleanup WHERE task_id=?', [taskId])) throw new Error('application_cleanup_pending');
}
