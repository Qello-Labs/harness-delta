import type { Store } from '../../store.js';
export function bumpMergedRevision(store: Store, sharedProjectId: string): void {
  const value = (store.get<{ revision: number }>('SELECT revision FROM exchange_merge_state WHERE shared_project_id=?', [sharedProjectId])?.revision ?? 0) + 1;
  if (!Number.isSafeInteger(value)) throw new Error('revision_overflow');
  store.execute('INSERT INTO exchange_merge_state VALUES (?,?) ON CONFLICT(shared_project_id) DO UPDATE SET revision=excluded.revision', [
    sharedProjectId,
    value
  ]);
}
export function assertNotRetired(store: Store, sharedProjectId: string, protocolId: string): void {
  if (
    store.get('SELECT shared_project_id FROM exchange_project_denials WHERE shared_project_id=?', [sharedProjectId]) ||
    store.get('SELECT protocol_id FROM exchange_protocol_invalidations WHERE shared_project_id=? AND protocol_id=?', [sharedProjectId, protocolId])
  )
    throw new Error('deleted_identifier');
}
/** Purge all imported evidence for an irreversibly invalidated original cohort. Caller owns transaction. */
export function invalidateExchangeProtocol(
  store: Store,
  sharedProjectId: string,
  protocolId: string,
  reason: 'deletion' | 'identity_conflict',
  now: string
): boolean {
  const old = store.get<{ reason: string }>('SELECT reason FROM exchange_protocol_invalidations WHERE shared_project_id=? AND protocol_id=?', [
    sharedProjectId,
    protocolId
  ]);
  if (old && (old.reason === 'deletion' || old.reason === reason)) return false;
  store.execute(
    'INSERT OR IGNORE INTO exchange_tombstones SELECT shared_project_id,key_id FROM exchange_identity_keys WHERE shared_project_id=? AND protocol_id=?',
    [sharedProjectId, protocolId]
  );
  store.execute('INSERT OR IGNORE INTO exchange_tombstones SELECT shared_project_id,task_id FROM exchange_tasks WHERE shared_project_id=? AND protocol_id=?', [
    sharedProjectId,
    protocolId
  ]);
  store.execute(
    'INSERT OR IGNORE INTO exchange_team_report_tombstones SELECT snapshot_id,? FROM exchange_team_snapshots WHERE shared_project_id=? AND protocol_id=?',
    [reason, sharedProjectId, protocolId]
  );
  store.execute('DELETE FROM exchange_team_snapshots WHERE shared_project_id=? AND protocol_id=?', [sharedProjectId, protocolId]);
  store.execute('DELETE FROM exchange_team_sequences WHERE shared_project_id=? AND protocol_id=?', [sharedProjectId, protocolId]);
  store.execute('DELETE FROM exchange_tasks WHERE shared_project_id=? AND protocol_id=?', [sharedProjectId, protocolId]);
  store.execute('DELETE FROM exchange_import_revisions WHERE shared_project_id=? AND protocol_id=?', [sharedProjectId, protocolId]);
  store.execute("UPDATE exchange_import_receipts SET digest=NULL WHERE shared_project_id=? AND protocol_id=? AND kind='assignment_metadata'", [
    sharedProjectId,
    protocolId
  ]);
  store.execute(
    'INSERT INTO exchange_protocol_invalidations VALUES (?,?,?,?) ON CONFLICT(shared_project_id,protocol_id) DO UPDATE SET reason=excluded.reason',
    [sharedProjectId, protocolId, reason, now]
  );
  bumpMergedRevision(store, sharedProjectId);
  return true;
}
export function retireImportedProject(store: Store, sharedProjectId: string, now: string): boolean {
  let changed = !store.get('SELECT shared_project_id FROM exchange_project_denials WHERE shared_project_id=?', [sharedProjectId]);
  store.execute('INSERT OR IGNORE INTO exchange_project_denials VALUES (?)', [sharedProjectId]);
  for (const m of store.all<{ protocol_id: string }>('SELECT protocol_id FROM exchange_mappings WHERE shared_project_id=?', [sharedProjectId]))
    changed = invalidateExchangeProtocol(store, sharedProjectId, m.protocol_id, 'deletion', now) || changed;
  store.execute('DELETE FROM exchange_retention_policy WHERE shared_project_id=?', [sharedProjectId]);
  return changed;
}
export function deleteMappedProject(store: Store, localProjectId: string, now: string): void {
  for (const m of store.all<{ shared_project_id: string }>('SELECT DISTINCT shared_project_id FROM exchange_mappings WHERE local_project_id=?', [
    localProjectId
  ]))
    retireImportedProject(store, m.shared_project_id, now);
}
