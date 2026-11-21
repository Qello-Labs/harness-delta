import type { Store } from './store.js';
import { TimestampSchema } from './contracts.js';
import { ordinaryWindowDecisionKeyForSelection, ordinaryWindowDecisionStatus } from './core/ordinary-window-activation.js';
import { assertOrdinaryWindowPrepared, ordinaryWindowSelection } from './core/ordinary-window-store.js';
import { clearOrdinaryWindowArming, readOrdinaryWindowControl } from './core/ordinary-window-trial.js';

export { publishOrdinaryWindowEmissionControl } from './core/ordinary-window-activation.js';

export function ordinaryWindowArmingStatus(store: Store, taskId: string, at: string) {
  const selection = ordinaryWindowSelection(store, taskId);
  if (!selection) {
    throw new Error('binding_scope_mismatch');
  }
  const project = store.get<{ local_root: string | null }>('SELECT local_root FROM projects WHERE id=?', [selection.projectId]);
  if (!project?.local_root) throw new Error('binding_scope_revoked');
  const control = readOrdinaryWindowControl(project.local_root, selection.policy.product);
  const timestamp = Date.parse(TimestampSchema.parse(at));
  let state: 'absent' | 'receipt_only' | 'inactive' | 'expired' | 'consumed' = control ? 'inactive' : 'absent';
  if (ordinaryWindowDecisionStatus(store, ordinaryWindowDecisionKeyForSelection(selection), at).state !== 'absent') {
    clearOrdinaryWindowArming(project.local_root, undefined, selection.policy.product);
    state = 'consumed';
  } else if (control?.state === 'receipt_only' && control.arming.taskId === taskId) {
    const task = store.get<{ state: string; generation: number }>('SELECT state,generation FROM tasks WHERE id=?', [taskId]);
    const expired = timestamp < Date.parse(control.arming.armedAt) || timestamp >= Date.parse(control.arming.expiresAt);
    let prepared = false;
    try {
      assertOrdinaryWindowPrepared(store, taskId);
      prepared = true;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      if (
        !['binding_scope_revoked', 'binding_scope_mismatch', 'binding_ordinary_assignment_conflict', 'ordinary_configuration_changed'].includes(error.message)
      ) {
        throw error;
      }
    }
    if (
      expired ||
      !prepared ||
      task?.state !== 'active' ||
      task.generation !== control.arming.generation ||
      control.arming.projectId !== selection.projectId ||
      control.arming.policyDigest !== selection.policyDigest ||
      control.policyId !== selection.policy.policyId ||
      control.policyRevision !== selection.policy.ruleRevision ||
      control.evidenceMode !== selection.policy.evidenceMode
    ) {
      clearOrdinaryWindowArming(project.local_root, taskId, selection.policy.product);
      state = expired ? 'expired' : 'inactive';
    } else state = 'receipt_only';
  }
  return {
    schema_version: 1,
    kind: 'ordinary_window_arming_status',
    project_id: selection.projectId,
    task_id: taskId,
    state,
    expires_at: state === 'receipt_only' && control?.state === 'receipt_only' ? control.arming.expiresAt : null,
    runtime_authority: false
  };
}

export function disarmOrdinaryWindowTrial(store: Store, taskId: string, at: string) {
  return store.immediateTransaction(() => {
    const selection = ordinaryWindowSelection(store, taskId);
    if (!selection) {
      throw new Error('binding_scope_mismatch');
    }
    const project = store.get<{ local_root: string | null }>('SELECT local_root FROM projects WHERE id=?', [selection.projectId]);
    if (!project?.local_root) throw new Error('binding_scope_revoked');
    clearOrdinaryWindowArming(project.local_root, taskId, selection.policy.product);
    return ordinaryWindowArmingStatus(store, taskId, at);
  });
}
