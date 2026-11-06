import type { OrdinaryWindowSelection } from '../../src/core/ordinary-window-policy.js';
import { ordinaryWindowRuntimeRevision, ordinaryWindowTrialBudgetBasis } from '../../src/core/ordinary-window-decision.js';

export function windowDecisionPacket(selection: OrdinaryWindowSelection) {
  return {
    schema_version: 1,
    kind: 'ordinary_window_activation',
    decision_kind: 'product',
    decision_ref: 'synthetic-decision',
    project_id: selection.projectId,
    product: selection.policy.product,
    source: selection.policy.source,
    policy_id: selection.policy.policyId,
    policy_revision: selection.policy.ruleRevision,
    policy_digest: selection.policyDigest,
    evidence_mode: selection.policy.evidenceMode,
    accepted_risks: ['source_identity_limits', 'root_ownership_unverified'],
    implementation_revision: ordinaryWindowRuntimeRevision,
    evidence_ref: 'synthetic-evidence',
    review_ref: 'synthetic-review'
  };
}
export function windowTrialPacket(
  selection: OrdinaryWindowSelection,
  options: {
    readonly nativeRootId?: string;
    readonly durationMs?: number;
    readonly tokenLimit?: number;
  } = {}
) {
  return {
    ...windowDecisionPacket(selection),
    decision_kind: 'trial',
    task_id: selection.taskId,
    native_root_id: options.nativeRootId ?? 'native-root',
    duration_ms: options.durationMs ?? 60_000,
    token_limit: options.tokenLimit ?? 32_000,
    token_budget_basis: ordinaryWindowTrialBudgetBasis
  };
}
export function windowRevocationPacket(selection: OrdinaryWindowSelection) {
  const { project_id, product, source, policy_id, policy_revision, policy_digest, evidence_mode } = windowDecisionPacket(selection);
  return {
    schema_version: 1,
    kind: 'ordinary_window_revocation',
    project_id,
    product,
    source,
    policy_id,
    policy_revision,
    policy_digest,
    evidence_mode,
    decision_ref: 'synthetic-decision',
    reason: 'operator_revoked'
  };
}
