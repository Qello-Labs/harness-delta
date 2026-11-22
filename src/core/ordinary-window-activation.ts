import type { Store } from '../store.js';
import { ordinaryWindowEmissionEligible } from './ordinary-window-emission-eligibility.js';
import {
  type OrdinaryWindowEmissionControl,
  isCurrentOrdinaryWindowArming,
  readOrdinaryWindowControl,
  writeOrdinaryWindowControl
} from './ordinary-window-control.js';
import { TimestampSchema } from '../contracts.js';
import { type OrdinaryWindowSelection, ordinaryWindowSelectionHash, OrdinaryWindowSelectionSchema } from './ordinary-window-policy.js';
import {
  type OrdinaryWindowActivationPacket,
  OrdinaryWindowActivationPacketSchema,
  type OrdinaryWindowDecision,
  type OrdinaryWindowRevocationPacket
} from './ordinary-window-decision.js';

import {
  assertDecisionPolicy,
  ordinaryWindowDecisionKeyValues,
  ordinaryWindowDecisionKeyForSelection,
  ordinaryWindowDecisionWhere,
  readOrdinaryWindowDecision,
  ordinaryWindowSelection
} from './ordinary-window-decision.js';
export {
  type OrdinaryWindowDecisionKey,
  ordinaryWindowDecisionKeyValues,
  ordinaryWindowDecisionKeyForSelection,
  ordinaryWindowDecisionWhere,
  readOrdinaryWindowDecision,
  ordinaryWindowDecisionStatus
} from './ordinary-window-decision.js';
import type { OrdinaryWindowDecisionKey } from './ordinary-window-decision.js';

function assertTrialTask(store: Store, packet: Extract<OrdinaryWindowActivationPacket, { decision_kind: 'trial' }>): void {
  const row = store.get<{
    selection: string;
    selection_hash: string;
    settings: string;
    settings_hash: string;
    price_table_id: string;
    project_id: string;
    state: string;
    revoked_at: string | null;
  }>(
    `SELECT w.selection,w.selection_hash,o.settings,o.settings_hash,o.price_table_id,t.project_id,t.state,o.revoked_at FROM ordinary_window_selections w
    JOIN tasks t ON t.id=w.task_id JOIN ordinary_tasks o ON o.task_id=t.id WHERE t.id=?`,
    [packet.task_id]
  );
  if (
    !row ||
    row.project_id !== packet.project_id ||
    row.state === 'finalized' ||
    row.revoked_at !== null ||
    store.get('SELECT 1 FROM comparison_assignments WHERE task_id=?', [packet.task_id]) ||
    store.get("SELECT 1 FROM tombstones WHERE kind='task' AND id=?", [packet.task_id])
  ) {
    throw new Error('binding_scope_revoked');
  }
  const selection = OrdinaryWindowSelectionSchema.parse(JSON.parse(row.selection));
  if (
    selection.taskId !== packet.task_id ||
    row.selection_hash !== ordinaryWindowSelectionHash(selection) ||
    row.settings_hash !== row.selection_hash ||
    row.settings !== JSON.stringify(selection) ||
    row.price_table_id !== selection.priceTableId
  ) {
    throw new Error('ordinary_configuration_changed');
  }
  if (
    JSON.stringify(ordinaryWindowDecisionKeyValues(ordinaryWindowDecisionKeyForSelection(selection))) !==
    JSON.stringify(ordinaryWindowDecisionKeyValues(packet))
  ) {
    throw new Error('binding_scope_mismatch');
  }
}
export function activateOrdinaryWindowDecision(store: Store, input: unknown, at: string): OrdinaryWindowDecision {
  const packet = OrdinaryWindowActivationPacketSchema.parse(input);
  const timestamp = new Date(TimestampSchema.parse(at)).toISOString();
  assertDecisionPolicy(packet);
  return store.immediateTransaction(() => {
    const project = store.get<{ local_root: string | null }>('SELECT local_root FROM projects WHERE id=?', [packet.project_id]);
    if (!project?.local_root || store.get("SELECT 1 FROM tombstones WHERE kind='project' AND id=?", [packet.project_id])) {
      throw new Error('binding_scope_revoked');
    }
    if (packet.decision_kind === 'trial') assertTrialTask(store, packet);
    if (store.get(`SELECT 1 FROM ordinary_window_activations WHERE ${ordinaryWindowDecisionWhere}`, ordinaryWindowDecisionKeyValues(packet))) {
      throw new Error('binding_window_decision_exists');
    }
    const trial = packet.decision_kind === 'trial' ? packet : null;
    store.execute(
      `INSERT INTO ordinary_window_activations(project_id,product,source,policy_id,policy_revision,policy_digest,evidence_mode,
      accepted_risks,implementation_revision,evidence_ref,review_ref,decided_at,decision_ref,decision_kind,
      trial_task_id,trial_native_root_id,trial_project_root,trial_expires_at,trial_token_limit)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        ...ordinaryWindowDecisionKeyValues(packet),
        JSON.stringify([...packet.accepted_risks].sort()),
        packet.implementation_revision,
        packet.evidence_ref,
        packet.review_ref,
        timestamp,
        packet.decision_ref,
        packet.decision_kind,
        trial?.task_id ?? null,
        trial?.native_root_id ?? null,
        trial ? project.local_root : null,
        trial ? new Date(Date.parse(timestamp) + trial.duration_ms).toISOString() : null,
        trial?.token_limit ?? null
      ]
    );
    const decision = readOrdinaryWindowDecision(store, packet);
    if (!decision) throw new Error('binding_window_activation_required');
    return decision;
  });
}
export function assertOrdinaryWindowDecision(
  store: Store,
  selection: OrdinaryWindowSelection,
  scope: {
    readonly nativeRootId?: string;
    readonly decisionRef?: string;
    readonly clock?: () => string;
  }
): OrdinaryWindowDecision {
  const decision = readOrdinaryWindowDecision(store, ordinaryWindowDecisionKeyForSelection(selection));
  if (!decision || decision.revoked_at !== null || (scope.decisionRef !== undefined && scope.decisionRef !== decision.decision_ref)) {
    throw new Error('binding_window_activation_required');
  }
  assertDecisionPolicy(decision);
  if (decision.decision_kind === 'trial') {
    const project = store.get<{ local_root: string | null }>('SELECT local_root FROM projects WHERE id=?', [selection.projectId]);
    if (
      decision.trial_task_id !== selection.taskId ||
      decision.trial_project_root !== project?.local_root ||
      (scope.nativeRootId !== undefined && scope.nativeRootId !== decision.trial_native_root_id)
    ) {
      throw new Error('binding_scope_mismatch');
    }
    const now = TimestampSchema.parse(scope.clock ? scope.clock() : new Date().toISOString());
    if (Date.parse(now) < Date.parse(decision.decided_at) || Date.parse(now) >= Date.parse(decision.trial_expires_at)) {
      throw new Error('binding_window_trial_expired');
    }
    if (decision.trial_tokens_consumed >= decision.trial_token_limit) {
      throw new Error('binding_window_trial_budget_exhausted');
    }
  }
  return decision;
}
export function revokeOrdinaryWindowDecisionRow(
  store: Store,
  decision: OrdinaryWindowDecision,
  termination: {
    readonly at: string;
    readonly reason: NonNullable<OrdinaryWindowDecision['revocation_reason']>;
  }
): void {
  store.execute(
    `UPDATE ordinary_window_activations SET revoked_at=?,revocation_reason=?
    WHERE ${ordinaryWindowDecisionWhere} AND decision_ref=? AND revoked_at IS NULL`,
    [TimestampSchema.parse(termination.at), termination.reason, ...ordinaryWindowDecisionKeyValues(decision), decision.decision_ref]
  );
  queueOrdinaryWindowEmissionControl(store, decision);
}
export function matchingOrdinaryWindowRevocation(store: Store, packet: OrdinaryWindowRevocationPacket): OrdinaryWindowDecision {
  assertDecisionPolicy(packet);
  const decision = readOrdinaryWindowDecision(store, packet);
  if (!decision || decision.decision_ref !== packet.decision_ref) {
    throw new Error('binding_window_decision_mismatch');
  }
  return decision;
}

export function publishOrdinaryWindowEmissionControl(store: Store, key: OrdinaryWindowDecisionKey & { readonly projectRoot?: string }, at: string) {
  const project = store.get<{ local_root: string | null }>('SELECT local_root FROM projects WHERE id=?', [key.project_id]);
  const projectRoot = project?.local_root ?? key.projectRoot;
  if (!projectRoot) {
    throw new Error('binding_window_control_unavailable');
  }
  const state = ordinaryWindowEmissionEligible(store, key, projectRoot, at) ? 'active' : 'inactive';
  const control: OrdinaryWindowEmissionControl = {
    schemaVersion: 1,
    projectRoot: projectRoot,
    product: key.product,
    policyId: key.policy_id,
    policyRevision: key.policy_revision,
    evidenceMode: key.evidence_mode,
    state
  };
  try {
    writeOrdinaryWindowControl(control);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    throw new Error('binding_window_control_unavailable', { cause: error });
  }
  return {
    schema_version: 1,
    kind: 'ordinary_window_emission_status',
    product: key.product,
    policy_id: key.policy_id,
    state,
    runtime_authority: false
  };
}

export function queueTaskOrdinaryWindowEmissionControl(store: Store, taskId: string): void {
  const selection = ordinaryWindowSelection(store, taskId);
  if (selection) queueOrdinaryWindowEmissionControl(store, ordinaryWindowDecisionKeyForSelection(selection));
}

export function queueOrdinaryWindowEmissionControl(store: Store, key: OrdinaryWindowDecisionKey, capturedRoot?: string): void {
  const projectRoot = capturedRoot ?? store.get<{ local_root: string | null }>('SELECT local_root FROM projects WHERE id=?', [key.project_id])?.local_root;
  if (!projectRoot) return;
  store.afterCommit(() => {
    const at = new Date().toISOString();
    try {
      // An absent control already refuses emission, including DB-only preparations.
      const control = readOrdinaryWindowControl(projectRoot, key.product);
      if (!control) return;
      if (
        control.state === 'receipt_only' &&
        !readOrdinaryWindowDecision(store, key) &&
        control.arming.projectId === key.project_id &&
        control.arming.policyDigest === key.policy_digest &&
        control.policyId === key.policy_id &&
        control.policyRevision === key.policy_revision &&
        control.evidenceMode === key.evidence_mode &&
        isCurrentOrdinaryWindowArming(store, control, Date.parse(at))
      ) {
        return;
      }
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      throw new Error('binding_window_control_unavailable', { cause: error });
    }
    publishOrdinaryWindowEmissionControl(store, { ...key, projectRoot }, at);
  });
}
