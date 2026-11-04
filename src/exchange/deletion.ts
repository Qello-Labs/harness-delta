import type { Store } from '../store.js';
import type { SourceConfig } from './contracts.js';
import { SourceConfigSchema, parseExchange } from './contracts.js';
export function exchangeSource(store: Store): SourceConfig | undefined {
  const row = store.get<{ config_json: string }>('SELECT config_json FROM exchange_sources WHERE singleton=1');
  return row ? parseExchange(SourceConfigSchema, JSON.parse(row.config_json) as unknown) : undefined;
}
/** Caller owns the source mutation's immediate transaction. */
export function retireSource(store: Store, protocolId: string, reason: 'deletion' | 'identity_conflict', now: string): void {
  const source = exchangeSource(store);
  if (!source || source.protocol_id !== protocolId) return;
  store.execute(
    "INSERT INTO exchange_scope_notices(kind,target_id,reason,invalidated_at) VALUES ('protocol_invalidated',?,?,?) ON CONFLICT(kind) DO UPDATE SET reason=CASE WHEN excluded.reason='deletion' THEN 'deletion' ELSE reason END",
    [protocolId, reason, now]
  );
  store.execute('DELETE FROM exchange_export_identities', []);
  store.execute('UPDATE exchange_export_receipts SET request_json=NULL,metadata_json=NULL,digest=NULL,invalidated=1 WHERE request_json IS NOT NULL', []);
}
export function recordSourceTaskDeletion(store: Store, taskId: string, now: string): void {
  const source = exchangeSource(store);
  if (!source) return;
  const task = store.get<{ project_id: string }>('SELECT project_id FROM tasks WHERE id=?', [taskId]);
  if (task?.project_id !== source.local_project_id) return;
  for (const key of [taskId, ...store.all<{ key_id: string }>('SELECT key_id FROM comparison_identity_keys WHERE task_id=?', [taskId]).map(r => r.key_id)])
    store.execute('INSERT OR IGNORE INTO exchange_source_tombstones VALUES (?,?)', [key, now]);
  // Even recruitment-context dependencies retire the shared comparison conservatively.
  retireSource(store, source.protocol_id, 'deletion', now);
}
export function recordSourceProjectDeletion(store: Store, projectId: string, now: string): void {
  const source = exchangeSource(store);
  if (!source || source.local_project_id !== projectId) return;
  retireSource(store, source.protocol_id, 'deletion', now);
  store.execute("INSERT OR IGNORE INTO exchange_scope_notices VALUES ('project',?,'deletion',?)", [source.shared_project_id, now]);
}
export function assertUnsealedIdentity(store: Store, taskId: string, keys: readonly string[]): void {
  if (!store.get('SELECT task_id FROM exchange_export_identities WHERE task_id=?', [taskId])) return;
  const known = new Set(store.all<{ key_id: string }>('SELECT key_id FROM comparison_identity_keys WHERE task_id=?', [taskId]).map(r => r.key_id));
  if (keys.some(k => !known.has(k))) throw new Error('identity_sealed');
}
