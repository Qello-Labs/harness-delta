import type { Store } from '../store.js';
import { TimestampSchema } from '../contracts.js';
import {
  ordinaryWindowDigest,
  ordinaryWindowPolicies,
  type OrdinaryWindowSelection,
  ordinaryWindowSelectionHash,
  OrdinaryWindowSelectionSchema
} from './ordinary-window-policy.js';
import {
  type OrdinaryWindowActivationPacket,
  OrdinaryWindowActivationPacketSchema,
  type OrdinaryWindowDecision,
  OrdinaryWindowDecisionSchema,
  type OrdinaryWindowRevocationPacket,
  ordinaryWindowTrialBudgetBasis
} from './ordinary-window-decision.js';

export type OrdinaryWindowDecisionKey = Pick<
  OrdinaryWindowDecision,
  'project_id' | 'product' | 'source' | 'policy_id' | 'policy_revision' | 'policy_digest' | 'evidence_mode'
>;
export const ordinaryWindowDecisionKeyValues = (key: OrdinaryWindowDecisionKey) => [
  key.project_id,
  key.product,
  key.source,
  key.policy_id,
  key.policy_revision,
  key.policy_digest,
  key.evidence_mode
];
export function ordinaryWindowDecisionKeyForSelection(selection: OrdinaryWindowSelection): OrdinaryWindowDecisionKey {
  return {
    project_id: selection.projectId,
    product: selection.policy.product,
    source: selection.policy.source,
    policy_id: selection.policy.policyId,
    policy_revision: selection.policy.ruleRevision,
    policy_digest: selection.policyDigest,
    evidence_mode: selection.policy.evidenceMode
  };
}
export const ordinaryWindowDecisionWhere =
  'project_id=? AND product=? AND source=? AND policy_id=? AND policy_revision=? AND policy_digest=? AND evidence_mode=?';
export function readOrdinaryWindowDecision(store: Store, key: OrdinaryWindowDecisionKey): OrdinaryWindowDecision | null {
  const row = store.get<{ accepted_risks: string }>(
    `SELECT * FROM ordinary_window_activations WHERE ${ordinaryWindowDecisionWhere}`,
    ordinaryWindowDecisionKeyValues(key)
  );
  if (!row) return null;
  const acceptedRisks: unknown = JSON.parse(row.accepted_risks);
  const parsed = OrdinaryWindowDecisionSchema.safeParse({
    ...row,
    accepted_risks: acceptedRisks
  });
  return parsed.success ? parsed.data : null;
}
function assertDecisionPolicy(packet: OrdinaryWindowDecisionKey): void {
  const policy = ordinaryWindowPolicies.find(value => value.policyId === packet.policy_id);
  if (
    !policy ||
    policy.product !== packet.product ||
    policy.source !== packet.source ||
    policy.ruleRevision !== packet.policy_revision ||
    ordinaryWindowDigest(policy) !== packet.policy_digest ||
    policy.evidenceMode !== packet.evidence_mode
  ) {
    throw new Error('binding_window_policy_mismatch');
  }
}
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
}
export function ordinaryWindowDecisionStatus(store: Store, key: OrdinaryWindowDecisionKey, at: string) {
  assertDecisionPolicy(key);
  const decision = readOrdinaryWindowDecision(store, key);
  const unreviewed =
    !decision && !!store.get(`SELECT 1 FROM ordinary_window_activations WHERE ${ordinaryWindowDecisionWhere}`, ordinaryWindowDecisionKeyValues(key));
  const now = Date.parse(TimestampSchema.parse(at));
  const state = !decision
    ? unreviewed
      ? 'unreviewed'
      : 'absent'
    : decision.revoked_at
      ? 'revoked'
      : decision.decision_kind === 'trial' && (now < Date.parse(decision.decided_at) || now >= Date.parse(decision.trial_expires_at))
        ? 'expired'
        : decision.decision_kind === 'trial' && decision.trial_tokens_consumed >= decision.trial_token_limit
          ? 'budget_exhausted'
          : 'recorded';
  return {
    schema_version: 1,
    kind: 'ordinary_window_decision_status',
    key,
    state,
    decision,
    trial_budget_basis: decision?.decision_kind === 'trial' ? ordinaryWindowTrialBudgetBasis : null,
    runtime_authority: false
  };
}
export function matchingOrdinaryWindowRevocation(store: Store, packet: OrdinaryWindowRevocationPacket): OrdinaryWindowDecision {
  assertDecisionPolicy(packet);
  const decision = readOrdinaryWindowDecision(store, packet);
  if (!decision || decision.decision_ref !== packet.decision_ref) {
    throw new Error('binding_window_decision_mismatch');
  }
  return decision;
}
