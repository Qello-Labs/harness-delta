import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { ordinaryWindowDigest, ordinaryWindowPolicies } from './core/ordinary-window-policy.js';
import type { Store } from './store.js';
import { TimestampSchema } from './contracts.js';
import {
  ordinaryWindowDecisionKeyForSelection,
  ordinaryWindowDecisionStatus,
  publishOrdinaryWindowEmissionControl
} from './core/ordinary-window-activation.js';
import { ordinaryWindowSelection } from './core/ordinary-window-decision.js';
import { clearOrdinaryWindowArming, readOrdinaryWindowControl } from './core/ordinary-window-trial.js';
import { isCurrentOrdinaryWindowArming } from './core/ordinary-window-control.js';
import { ordinaryWindowEmissionEligible } from './core/ordinary-window-emission-eligibility.js';

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
    const expired = timestamp < Date.parse(control.arming.armedAt) || timestamp >= Date.parse(control.arming.expiresAt);
    if (!isCurrentOrdinaryWindowArming(store, control, timestamp)) {
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

type ReconciliationTarget = ({ readonly taskId: string } | { readonly projectId: string; readonly product?: 'codex' | 'claude_code' }) & {
  readonly clock?: () => string;
  readonly projectRoot?: string;
};
const operations = new AsyncLocalStorage<Store>();

function controlScopes(store: Store, target: ReconciliationTarget) {
  const selection = 'taskId' in target ? ordinaryWindowSelection(store, target.taskId) : undefined;
  if ('taskId' in target && !selection) return [];
  let projectId = 'projectId' in target ? target.projectId : selection?.projectId;
  if (!projectId) return [];
  let projectRoot = store.get<{ local_root: string | null }>('SELECT local_root FROM projects WHERE id=?', [projectId])?.local_root;
  if (target.projectRoot !== undefined) {
    try {
      projectRoot = realpathSync(target.projectRoot);
      projectId = store.get<{ id: string }>('SELECT id FROM projects WHERE local_root=?', [projectRoot])?.id ?? randomUUID();
    } catch (error) {
      // An unresolvable registration root can still fall back to its live ID's root.
      if (!(error instanceof Error)) throw error;
    }
  }
  if (!projectRoot) return [];
  const keys = selection
    ? [ordinaryWindowDecisionKeyForSelection(selection)]
    : ordinaryWindowPolicies
        .filter(policy => !('product' in target) || target.product === undefined || policy.product === target.product)
        .map(policy => ({
          project_id: projectId,
          product: policy.product,
          source: policy.source,
          policy_id: policy.policyId,
          policy_revision: policy.ruleRevision,
          policy_digest: ordinaryWindowDigest(policy),
          evidence_mode: policy.evidenceMode
        }));
  return keys.map(key => ({ ...key, projectRoot }));
}

function staleControl(store: Store, key: ReturnType<typeof controlScopes>[number], at: string): boolean {
  const control = readOrdinaryWindowControl(key.projectRoot, key.product);
  if (control?.state !== 'active') return false;
  if (control.policyId !== key.policy_id || control.policyRevision !== key.policy_revision || control.evidenceMode !== key.evidence_mode) return true;
  const projects = store.all<{ id: string }>(
    `SELECT p.id FROM projects p WHERE p.local_root=?
    AND NOT EXISTS (SELECT 1 FROM tombstones t WHERE t.kind='project' AND t.id=p.id)`,
    [key.projectRoot]
  );
  return !projects.some(project => ordinaryWindowEmissionEligible(store, { ...key, project_id: project.id }, key.projectRoot, at));
}

export function ordinaryWindowEmissionControlStale(store: Store, target: ReconciliationTarget): boolean | null {
  try {
    const at = target.clock?.() ?? new Date().toISOString();
    const scopes = controlScopes(store, target);
    if (!scopes.length) return null;
    return scopes.some(key => staleControl(store, key, at));
  } catch {
    return null;
  }
}

function reconcile(store: Store, target: ReconciliationTarget): void {
  if (store.inTransaction) return;
  try {
    const at = target.clock?.() ?? new Date().toISOString();
    for (const key of controlScopes(store, target)) {
      try {
        if (!staleControl(store, key, at)) continue;
        // A concurrent activation or arming must win over the earlier stale observation.
        if (staleControl(store, key, at)) {
          publishOrdinaryWindowEmissionControl(store, key, at);
        }
      } catch {
        // Registration touches both products even when one product's repair fails.
        continue;
      }
    }
  } catch {
    // A repair failure must not replace the operation's result, including an earlier closed-scope error.
    return;
  }
}

export function withOrdinaryWindowReconciliation<T>(store: Store, target: ReconciliationTarget, operation: () => Promise<T>): Promise<T>;
export function withOrdinaryWindowReconciliation<T>(store: Store, target: ReconciliationTarget, operation: () => T): T;
export function withOrdinaryWindowReconciliation<T>(store: Store, target: ReconciliationTarget, operation: () => T | Promise<T>): T | Promise<T> {
  if (operations.getStore() === store) return operation();
  let result: T | Promise<T>;
  try {
    result = operations.run(store, operation);
  } catch (error) {
    reconcile(store, target);
    throw error;
  }
  if (result instanceof Promise) return result.finally(() => reconcile(store, target));
  reconcile(store, target);
  return result;
}
