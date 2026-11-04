import type { Store } from '../store.js';

/** Discover before task cascade; recruitment context can depend on unassigned/other-protocol tasks. */
export function affectedComparisonProtocols(store: Store, taskId: string): string[] {
  return store
    .all<{ protocol_id: string }>(
      'SELECT protocol_id FROM comparison_assignments WHERE task_id=? UNION SELECT s.protocol_id FROM comparison_report_dependencies d JOIN comparison_report_snapshots s ON s.report_id=d.report_id WHERE d.task_id=? UNION SELECT s.protocol_id FROM flexible_report_dependencies d JOIN flexible_report_snapshots s ON s.report_id=d.report_id WHERE d.task_id=?',
      [taskId, taskId, taskId]
    )
    .map(row => row.protocol_id);
}
/** Caller owns the invalidation transaction. Only opaque report IDs are returned for disclosure. */
export function invalidateComparisonSnapshots(store: Store, protocolId: string, reason: 'deletion' | 'identity_conflict', now: string): string[] {
  const ids = store
    .all<{ report_id: string }>(
      'SELECT report_id FROM comparison_report_snapshots WHERE protocol_id=? UNION SELECT report_id FROM flexible_report_snapshots WHERE protocol_id=? ORDER BY report_id',
      [protocolId, protocolId]
    )
    .map(row => row.report_id);
  for (const id of ids) store.execute('INSERT OR IGNORE INTO comparison_report_tombstones(report_id,deleted_at,reason_code) VALUES (?,?,?)', [id, now, reason]);
  store.execute('DELETE FROM flexible_report_snapshots WHERE protocol_id=?', [protocolId]);
  store.execute('DELETE FROM comparison_report_snapshots WHERE protocol_id=?', [protocolId]);
  store.execute('DELETE FROM comparison_report_sequences WHERE protocol_id=?', [protocolId]);
  return ids;
}
