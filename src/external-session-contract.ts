import { comparisonProtocol, protocolRow } from './protocol-store.js';
import { IdSchema, TimestampSchema } from './contracts.js';
import { utcNow, type Clock } from './lifecycle.js';
import type { Store } from './store.js';

export interface ExternalTaskContract {
  task_id: string;
  timing_contract: 'external-first-connection-v1';
  report_contract: 'external-observation-v1';
  followup_seconds: number;
  registered_at: string;
  started_at: string | null;
  ends_at: string | null;
}
export function externalContract(store: Store, taskId: string): ExternalTaskContract | undefined {
  // Old-schema fixture replay and historical report reading remain possible.
  if (!store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='external_task_contracts'")) return undefined;
  return store.get<ExternalTaskContract>('SELECT * FROM external_task_contracts WHERE task_id=?', [IdSchema.parse(taskId)]);
}
export function registerExternalContract(store: Store, taskId: string, clock: Clock = utcNow): ExternalTaskContract {
  const now = new Date(TimestampSchema.parse(clock())).toISOString();
  return store.immediateTransaction(() => {
    const old = externalContract(store, taskId);
    if (old) return old;
    const assignment = store.get<{ protocol_id: string }>('SELECT protocol_id FROM comparison_assignments WHERE task_id=?', [taskId]);
    if (!assignment) throw new Error('task_not_assigned');
    const protocol = comparisonProtocol(store, protocolRow(store, assignment.protocol_id));
    if (protocol.schema_version !== 2) throw new Error('external_contract_unsupported');
    if (
      store.get(
        `SELECT 1 FROM sessions WHERE task_id=? UNION ALL SELECT 1 FROM events WHERE task_id=?
      UNION ALL SELECT 1 FROM active_intervals WHERE task_id=? UNION ALL SELECT 1 FROM external_preparations WHERE task_id=? AND first_connected_at IS NOT NULL`,
        [taskId, taskId, taskId, taskId]
      )
    )
      throw new Error('external_contract_requires_new_task');
    store.execute(
      `INSERT INTO external_task_contracts(task_id,timing_contract,report_contract,followup_seconds,registered_at)
      VALUES (?,'external-first-connection-v1','external-observation-v1',?,?)`,
      [taskId, protocol.followup_seconds, now]
    );
    return externalContract(store, taskId)!;
  });
}
export function assertLegacyComparisonTiming(store: Store, protocolId: string): void {
  if (!store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='external_task_contracts'")) return;
  if (store.get('SELECT 1 FROM external_task_contracts c JOIN comparison_assignments a ON a.task_id=c.task_id WHERE a.protocol_id=?', [protocolId]))
    throw new Error('timing_contract_mismatch');
}

export interface BindingCollectionControl {
  task_id: string;
  end_condition: 'explicit_stop';
  authorized_at: string;
  revoked_at: string | null;
}
export function bindingCollectionControl(store: Store, taskId: string): BindingCollectionControl | undefined {
  if (!store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='binding_collection_controls'")) return undefined;
  return store.get<BindingCollectionControl>('SELECT * FROM binding_collection_controls WHERE task_id=?', [IdSchema.parse(taskId)]);
}
/** Metadata-only authority; source admission and native qualification remain separate. */
export function registerBindingCollectionControl(store: Store, taskId: string, clock: Clock = utcNow): void {
  store.immediateTransaction(() => {
    const task = store.get<{ project_id: string; state: string }>('SELECT project_id,state FROM tasks WHERE id=?', [IdSchema.parse(taskId)]);
    if (
      !task ||
      task.state === 'finalized' ||
      store.get("SELECT 1 FROM tombstones WHERE (kind='task' AND id=?) OR (kind='project' AND id=?)", [taskId, task.project_id])
    )
      throw new Error('binding_scope_revoked');
    const old = bindingCollectionControl(store, taskId);
    if (old?.revoked_at) throw new Error('binding_scope_revoked');
    if (old) return;
    if (task.state === 'active' || !externalContract(store, taskId)) throw new Error('binding_collection_requires_inactive_task');
    store.execute("INSERT INTO binding_collection_controls(task_id,end_condition,authorized_at) VALUES (?,'explicit_stop',?)", [
      taskId,
      new Date(TimestampSchema.parse(clock())).toISOString()
    ]);
  });
}
export function revokeBindingCollectionControl(store: Store, taskId: string, clock: Clock = utcNow): void {
  const old = bindingCollectionControl(store, taskId);
  if (!old) throw new Error('binding_collection_control_required');
  if (!old.revoked_at)
    store.execute('UPDATE binding_collection_controls SET revoked_at=? WHERE task_id=?', [new Date(TimestampSchema.parse(clock())).toISOString(), taskId]);
}
