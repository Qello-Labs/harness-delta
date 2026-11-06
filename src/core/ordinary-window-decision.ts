import { z } from 'zod';
import { IdSchema, TimestampSchema } from '../contracts.js';
import { OrdinaryWindowEvidenceModeSchema, OrdinaryWindowPolicyIdSchema } from './ordinary-window-policy.js';

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
