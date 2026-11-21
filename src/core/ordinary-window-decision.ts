import { z } from 'zod';
import { IdSchema, TimestampSchema } from '../contracts.js';
import {
  OrdinaryWindowEvidenceModeSchema,
  OrdinaryWindowPolicyIdSchema,
  ordinaryWindowDigest,
  ordinaryWindowPolicies,
  ordinaryWindowSelectionHash,
  OrdinaryWindowSelectionSchema,
  type OrdinaryWindowSelection
} from './ordinary-window-policy.js';
import type { Store } from '../store.js';

export function ordinaryWindowSelection(store: Store, taskId: string): OrdinaryWindowSelection | undefined {
  const row = store.get<{ selection: string; selection_hash: string }>('SELECT selection,selection_hash FROM ordinary_window_selections WHERE task_id=?', [
    IdSchema.parse(taskId)
  ]);
  if (!row) return undefined;
  const selection = OrdinaryWindowSelectionSchema.parse(JSON.parse(row.selection));
  if (selection.taskId !== taskId || ordinaryWindowSelectionHash(selection) !== row.selection_hash) {
    throw new Error('ordinary_configuration_changed');
  }
  return selection;
}
export function assertOrdinaryWindowPrepared(store: Store, taskId: string): OrdinaryWindowSelection {
  const selection = ordinaryWindowSelection(store, taskId);
  if (!selection) throw new Error('ordinary_preparation_required');
  const task = store.get<{ project_id: string; state: string; metadata: string }>('SELECT project_id,state,metadata FROM tasks WHERE id=?', [taskId]);
  const prepared = store.get<{
    settings: string;
    settings_hash: string;
    price_table_id: string;
    revoked_at: string | null;
  }>('SELECT settings,settings_hash,price_table_id,revoked_at FROM ordinary_tasks WHERE task_id=?', [taskId]);
  if (
    !task ||
    !prepared ||
    prepared.revoked_at !== null ||
    task.state === 'finalized' ||
    store.get("SELECT 1 FROM tombstones WHERE (kind='task' AND id=?) OR (kind='project' AND id=?)", [taskId, selection.projectId])
  ) {
    throw new Error('binding_scope_revoked');
  }
  if (store.get('SELECT 1 FROM comparison_assignments WHERE task_id=?', [taskId])) {
    throw new Error('binding_ordinary_assignment_conflict');
  }
  const metadata = z.object({ product: z.string() }).parse(JSON.parse(task.metadata));
  if (
    task.project_id !== selection.projectId ||
    metadata.product !== selection.policy.product ||
    prepared.settings !== JSON.stringify(selection) ||
    prepared.settings_hash !== ordinaryWindowSelectionHash(selection) ||
    prepared.price_table_id !== selection.priceTableId
  ) {
    throw new Error('ordinary_configuration_changed');
  }
  if (!store.get('SELECT 1 FROM projects WHERE id=? AND local_root IS NOT NULL', [selection.projectId])) {
    throw new Error('binding_scope_mismatch');
  }
  return selection;
}

export const ordinaryWindowRuntimeRevision = 'ordinary-window-runtime-v2';
export const ordinaryWindowTrialBudgetBasis = 'accepted_observed_root_input_plus_output-v1';
export interface OrdinaryWindowScope {
  readonly taskId: string;
  readonly rootSessionId?: string;
  readonly generation?: number;
  readonly segmentRevision?: number;
  readonly cursor?: string | null;
  readonly nativeRootId?: string;
  readonly decisionRef?: string;
  readonly clock?: () => string;
}
export const OrdinaryWindowRiskSchema = z.enum(['source_identity_limits', 'root_ownership_unverified']);
export const OrdinaryWindowAcceptedRisksSchema = z.tuple([OrdinaryWindowRiskSchema, OrdinaryWindowRiskSchema]).refine(values => values[0] !== values[1]);
export const ordinaryWindowDecisionKey = {
  project_id: IdSchema,
  product: z.enum(['codex', 'claude_code']),
  source: z.enum(['codex_binding', 'claude_binding']),
  policy_id: OrdinaryWindowPolicyIdSchema,
  policy_revision: IdSchema,
  policy_digest: z.string().regex(/^[a-f0-9]{64}$/),
  evidence_mode: OrdinaryWindowEvidenceModeSchema
};
const activationFields = {
  schema_version: z.literal(1),
  kind: z.literal('ordinary_window_activation'),
  ...ordinaryWindowDecisionKey,
  decision_ref: IdSchema,
  accepted_risks: OrdinaryWindowAcceptedRisksSchema,
  implementation_revision: z.literal(ordinaryWindowRuntimeRevision),
  evidence_ref: IdSchema,
  review_ref: IdSchema
};
export const OrdinaryWindowActivationPacketSchema = z.discriminatedUnion('decision_kind', [
  z.strictObject({
    ...activationFields,
    decision_kind: z.literal('product')
  }),
  z.strictObject({
    ...activationFields,
    decision_kind: z.literal('trial'),
    task_id: IdSchema,
    native_root_id: IdSchema,
    token_budget_basis: z.literal(ordinaryWindowTrialBudgetBasis),
    duration_ms: z.number().int().positive().max(2_147_483_647),
    token_limit: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
  })
]);
export type OrdinaryWindowActivationPacket = z.infer<typeof OrdinaryWindowActivationPacketSchema>;
export const OrdinaryWindowRevocationPacketSchema = z.strictObject({
  schema_version: z.literal(1),
  kind: z.literal('ordinary_window_revocation'),
  ...ordinaryWindowDecisionKey,
  decision_ref: IdSchema,
  reason: z.enum(['operator_revoked', 'trial_completed', 'trial_failed'])
});
export type OrdinaryWindowRevocationPacket = z.infer<typeof OrdinaryWindowRevocationPacketSchema>;
const recordFields = {
  ...ordinaryWindowDecisionKey,
  decision_ref: IdSchema,
  accepted_risks: OrdinaryWindowAcceptedRisksSchema,
  implementation_revision: z.literal(ordinaryWindowRuntimeRevision),
  evidence_ref: IdSchema,
  review_ref: IdSchema,
  decided_at: TimestampSchema,
  revoked_at: TimestampSchema.nullable(),
  revocation_reason: z.enum(['operator_revoked', 'trial_completed', 'trial_failed', 'trial_expired', 'trial_budget_exhausted']).nullable()
};
export const OrdinaryWindowDecisionSchema = z.discriminatedUnion('decision_kind', [
  z.strictObject({
    ...recordFields,
    decision_kind: z.literal('product'),
    trial_task_id: z.null(),
    trial_native_root_id: z.null(),
    trial_project_root: z.null(),
    trial_expires_at: z.null(),
    trial_token_limit: z.null(),
    trial_tokens_consumed: z.literal(0)
  }),
  z
    .strictObject({
      ...recordFields,
      decision_kind: z.literal('trial'),
      trial_task_id: IdSchema,
      trial_native_root_id: IdSchema,
      trial_project_root: z.string().min(1),
      trial_expires_at: TimestampSchema,
      trial_token_limit: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      trial_tokens_consumed: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
    })
    .refine(value => value.trial_tokens_consumed <= value.trial_token_limit)
]);
export type OrdinaryWindowDecision = z.infer<typeof OrdinaryWindowDecisionSchema>;

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
export function assertDecisionPolicy(packet: OrdinaryWindowDecisionKey): void {
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
