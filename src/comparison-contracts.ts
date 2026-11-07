import { z } from 'zod';
import { IdSchema, ModelSchema, ProductVersionSchema, TaskMetadataSchema, TimestampSchema } from './contracts.js';

const ids = z
  .array(IdSchema)
  .min(1)
  .max(256)
  .refine(values => new Set(values).size === values.length);
const fraction = z.number().finite().min(0).max(1);
export const ManifestHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const VariantSchema = z.strictObject({
  schema_version: z.literal(1),
  id: IdSchema,
  harness_version: IdSchema,
  instruction_manifest_hash: ManifestHashSchema,
  product: z.enum(['codex', 'claude_code', 'synthetic']),
  product_version: ProductVersionSchema,
  model: ModelSchema,
  reasoning_setting: IdSchema,
  policy_version: IdSchema,
  policy_status: z.enum(['eligible', 'ineligible'])
});
export type Variant = z.infer<typeof VariantSchema>;

const stratumSchema = z.strictObject({
  id: IdSchema,
  assignees: ids,
  types: ids,
  sizes: ids,
  allocator_id: IdSchema
});
export const protocolFields = {
  schema_version: z.literal(1),
  id: IdSchema,
  project_id: IdSchema,
  team_id: IdSchema,
  mode: z.literal('randomized_task'),
  purpose: z.enum(['synthetic_validation', 'real_experiment']),
  protocol_version: IdSchema,
  eligibility_version: IdSchema,
  classification_version: IdSchema,
  participants: ids,
  environment_ids: ids,
  variant_ids: z.tuple([IdSchema, IdSchema]).refine(values => values[0] !== values[1]),
  recruitment_start: TimestampSchema,
  recruitment_end: TimestampSchema,
  allocation_method: z.literal('balanced_blocks'),
  allocation_version: z.literal('balanced-blocks-v1'),
  allocation_ratio: z.tuple([z.literal(1), z.literal(1)]),
  block_size: z
    .number()
    .int()
    .min(2)
    .max(256)
    .refine(value => value % 2 === 0),
  strata: z
    .array(stratumSchema)
    .min(1)
    .max(256)
    .refine(values => new Set(values.map(value => value.id)).size === values.length),
  primary_metric: z.enum(['input_total', 'total_tokens']),
  quality_metric: z.enum(['criterion_fulfillment', 'deadline_success']),
  quality_margin: fraction,
  minimum_effect: z.number().finite().nonnegative(),
  sample_plan: z.strictObject({ target_tasks: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), planning_basis_id: IdSchema }),
  followup_seconds: z.number().int().positive().max(315360000),
  stopping_rule: z.strictObject({ kind: z.literal('fixed_recruitment'), version: IdSchema }),
  missingness_policy: z.strictObject({ version: IdSchema, max_usage_missing_rate: fraction, max_outcome_missing_rate: fraction }),
  deviation_policy: z.strictObject({
    mismatch: z.enum(['stop', 'continue']),
    unknown: z.enum(['stop', 'continue']),
    version_drift: z.enum(['stop', 'new_phase'])
  }),
  confidence_level: z.number().finite().gt(0).lt(1),
  analysis_plan_version: IdSchema,
  sensitivity_plan_ids: ids
};
export const ProtocolDraftSchema = z.strictObject(protocolFields).partial().required({
  schema_version: true,
  id: true,
  project_id: true,
  mode: true,
  purpose: true
});
export const ProtocolSchema = z.strictObject(protocolFields).refine(value => Date.parse(value.recruitment_start) < Date.parse(value.recruitment_end));
export type Protocol = z.infer<typeof ProtocolSchema>;

export const AssignmentInputSchema = z.strictObject({
  schema_version: z.literal(1),
  protocol_id: IdSchema,
  project_id: IdSchema,
  logical_task_id: IdSchema,
  task_id: IdSchema,
  alias_ids: ids.optional(),
  metadata: TaskMetadataSchema,
  environment_id: IdSchema,
  code_base_commit: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/),
  allocator_id: IdSchema
});
export type AssignmentInput = z.infer<typeof AssignmentInputSchema>;

/** All comparison boundary errors use fixed codes, never Zod input diagnostics. */
export function parseComparison<T>(schema: z.ZodType<T>, input: unknown, code = 'invalid_comparison_input'): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new Error(code);
  return result.data;
}

export function comparisonTimestamp(input: string): string {
  return new Date(parseComparison(TimestampSchema, input)).toISOString();
}

export const ConfirmationInputSchema = z.strictObject({
  schema_version: z.literal(1),
  id: IdSchema,
  task_id: IdSchema,
  session_id: IdSchema.optional(),
  occurred_at: TimestampSchema.optional(),
  evidence_method: z.enum(['self_attested', 'selected_artifact_hash']),
  actual_variant_id: IdSchema.nullable(),
  product: z.enum(['codex', 'claude_code', 'synthetic']).nullable(),
  product_version: ProductVersionSchema.nullable(),
  model: ModelSchema.nullable(),
  reasoning_setting: IdSchema.nullable(),
  environment_id: IdSchema.nullable()
});
export const ConfigurationRecordSchema = ConfirmationInputSchema.extend({
  occurred_at: TimestampSchema,
  verification_status: z.enum(['confirmed', 'mismatch', 'unknown']),
  observed_config_hash: ManifestHashSchema.nullable(),
  verification_scope: z.enum(['declared_settings', 'selected_artifacts_and_declared_settings']),
  deviation_codes: z.array(z.enum(['unknown', 'mismatch', 'crossover', 'version_drift']))
});
