import { ReportCompatibilitySchema } from './report-source-trust-contracts.js';
import { z } from 'zod';
import {
  BillingComponentSchema,
  eventFields,
  IdSchema,
  ModelSchema,
  MonetaryAmountSchema,
  ProductVersionSchema,
  TaskMetadataSchema,
  TimestampSchema,
  UsageSchema,
  UsageV2Schema,
  type Event
} from './contracts.js';
import { ManifestHashSchema, parseComparison, protocolFields, ProtocolSchema } from './comparison-contracts.js';
export { BillingComponentSchema, UsageV2Schema } from './contracts.js';
const productSchema = UsageSchema.shape.product;
const ids = z
  .array(IdSchema)
  .min(1)
  .max(256)
  .refine(values => new Set(values).size === values.length);
export const FlexibleVariantSchema = z.strictObject({
  schema_version: z.literal(2),
  id: IdSchema,
  harness_version: IdSchema,
  instruction_manifest_hash: ManifestHashSchema,
  policy_version: IdSchema,
  policy_status: z.enum(['eligible', 'ineligible']),
  runtime_policy: z.literal('flexible')
});
export const FlexibleTaskMetadataSchema = TaskMetadataSchema.omit({ model: true }).extend({
  schema_version: z.literal(2),
  initial_model: ModelSchema.nullable()
});
export const FlexibleProtocolSchema = z
  .strictObject({
    ...protocolFields,
    schema_version: z.literal(2),
    purpose: z.enum(['synthetic_validation', 'real_experiment', 'functional_pilot']),
    minimum_effect: protocolFields.minimum_effect.optional(),
    quality_margin: protocolFields.quality_margin.optional(),
    confidence_level: protocolFields.confidence_level.optional(),
    primary_metric: z.literal('standardized_cost'),
    price_table_id: IdSchema,
    estimand: z.literal('registered_task_mean'),
    runtime_policy: z.literal('flexible'),
    source_profiles: z
      .array(z.strictObject({ product: productSchema, product_version: ProductVersionSchema, profile_id: IdSchema }))
      .min(1)
      .max(256)
      .refine(rows => new Set(rows.map(r => `${r.product}:${r.product_version}`)).size === rows.length),
    planning_basis_id: IdSchema,
    collaboration_policy_id: IdSchema,
    strata: z
      .array(protocolFields.strata.element.extend({ assignees: z.tuple([IdSchema]) }))
      .min(1)
      .max(256)
      .refine(rows => new Set(rows.map(r => r.id)).size === rows.length)
  })
  .refine(value => Date.parse(value.recruitment_start) < Date.parse(value.recruitment_end))
  .refine(value => value.planning_basis_id === value.sample_plan.planning_basis_id)
  .refine(value => value.strata.every(s => value.participants.includes(s.assignees[0])))
  .superRefine((value, context) => {
    for (const key of ['minimum_effect', 'quality_margin', 'confidence_level'] as const) {
      if (value.purpose === 'functional_pilot' ? value[key] !== undefined : value[key] === undefined)
        context.addIssue({ code: 'custom', path: [key], message: value.purpose === 'functional_pilot' ? 'effect_input_not_allowed' : 'effect_input_required' });
    }
  });
export const FlexibleProtocolDraftSchema = z
  .strictObject(FlexibleProtocolSchema.shape)
  .partial()
  .required({
    schema_version: true,
    id: true,
    project_id: true,
    mode: true,
    purpose: true
  })
  .superRefine((value, context) => {
    if (value.purpose === 'functional_pilot')
      for (const key of ['minimum_effect', 'quality_margin', 'confidence_level'] as const) {
        if (value[key] !== undefined) context.addIssue({ code: 'custom', path: [key], message: 'effect_input_not_allowed' });
      }
  });
export const RuntimeEvidenceSchema = z
  .strictObject({
    id: IdSchema,
    task_id: IdSchema,
    session_id: IdSchema,
    turn_id: IdSchema.nullable(),
    request_id: IdSchema.nullable(),
    model: ModelSchema.nullable(),
    effort: IdSchema.nullable(),
    product: productSchema,
    product_version: ProductVersionSchema,
    source: z.enum(['self_attested', 'product_log', 'validated_integration']),
    occurred_at: TimestampSchema,
    recorded_at: TimestampSchema,
    boundary: z.enum(['request', 'turn', 'session', 'unknown'])
  })
  .refine(value => Date.parse(value.recorded_at) >= Date.parse(value.occurred_at));
export const EventV2Schema = z.strictObject({ ...eventFields, payload: UsageV2Schema });
export const PriceTableSchema = z
  .strictObject({
    id: IdSchema,
    version: IdSchema,
    currency: z.string().regex(/^[A-Z]{3}$/),
    source_id: IdSchema,
    as_of: TimestampSchema,
    unit_tokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    display_decimals: z.number().int().min(0).max(12),
    rounding: z.literal('half_even'),
    cache_write_policy: z.literal('observed_ttl-v1').optional(),
    entries: z
      .array(
        z.strictObject({
          product: productSchema,
          model: ModelSchema,
          component: BillingComponentSchema.shape.kind,
          cache_ttl: z.enum(['5m', '1h']).optional(),
          prompt_tier: z.enum(['up_to_100000', 'over_100000']).optional(),
          price_per_unit: MonetaryAmountSchema.refine(value => value.replace('.', '').length <= 60)
        })
      )
      .min(1)
      .max(4096)
  })
  .refine(
    value =>
      new Set(value.entries.map(e => `${e.product}:${e.model}:${e.component}:${e.prompt_tier ?? 'flat'}:${e.cache_ttl ?? 'aggregate'}`)).size ===
      value.entries.length
  )
  .refine(value =>
    value.entries.every(
      entry =>
        entry.cache_ttl === undefined ||
        (value.cache_write_policy === 'observed_ttl-v1' && entry.component === 'cache_write' && entry.product === 'claude_code')
    )
  )
  .refine(value =>
    value.entries.every(
      entry =>
        value.cache_write_policy !== 'observed_ttl-v1' || entry.component !== 'cache_write' || entry.product !== 'claude_code' || entry.cache_ttl !== undefined
    )
  )
  .refine(value => value.entries.every(entry => entry.prompt_tier === undefined || (entry.product === 'claude_code' && entry.model === 'claude-haiku-5-5')))
  .refine(value =>
    value.entries.every(
      entry =>
        entry.prompt_tier === undefined ||
        !value.entries.some(
          other => other.product === entry.product && other.model === entry.model && other.component === entry.component && other.prompt_tier === undefined
        )
    )
  );
export const CostReasonSchema = z.enum([
  'unknown_model',
  'unknown_attribution',
  'unknown_components',
  'unpriced_component',
  'missing_value',
  'unsupported_profile',
  'scope_mismatch',
  'incomplete',
  'invalidated',
  'followup_pending',
  'source_unverified',
  'analysis_unverified',
  'price_conflict',
  'quality_missing'
]);
export const PricedUsageSchema = z.strictObject({
  event_id: IdSchema,
  amount: MonetaryAmountSchema.nullable(),
  partial_amount: MonetaryAmountSchema.nullable(),
  reasons: z.array(CostReasonSchema)
});
const state = z.enum(['verified', 'unknown', 'violated']);
export const CostFactsSchema = z.strictObject({
  scope_before_access: state,
  fresh_session: state,
  ready_before_first_request: state,
  continuous_observation: state,
  configuration_accounting: state,
  bounded_topology: state,
  request_universe: state,
  terminal_accounting: state,
  immutable_identity: state,
  durable_flush: state,
  counter_semantics: state,
  price_coverage: state
});
export const CostCoverageEvidenceSchema = z
  .strictObject({
    profile_id: IdSchema,
    task_id: IdSchema,
    window_start: TimestampSchema,
    window_end: TimestampSchema,
    facts: CostFactsSchema,
    has_observed_value: z.boolean()
  })
  .refine(value => Date.parse(value.window_start) < Date.parse(value.window_end));
export const CostCoverageDecisionSchema = z.strictObject({ eligible: z.boolean(), reasons: z.array(z.union([CostReasonSchema, CostFactsSchema.keyof()])) });
export const TaskCostSchema = z.strictObject({
  currency: PriceTableSchema.shape.currency,
  price_table_id: IdSchema,
  complete_amount: MonetaryAmountSchema.nullable(),
  partial_amount: MonetaryAmountSchema.nullable(),
  compatibility: ReportCompatibilitySchema.optional(),
  compatibility_unverified_partial_amount: MonetaryAmountSchema.nullable().optional(),
  legacy_unverified_partial_amount: MonetaryAmountSchema.nullable().optional(),
  usage_complete: z.boolean(),
  price_complete: z.boolean(),
  reasons: CostCoverageDecisionSchema.shape.reasons
});
export const FlexibleAssignmentInputSchema = z.strictObject({
  schema_version: z.literal(2),
  protocol_id: IdSchema,
  project_id: IdSchema,
  logical_task_id: IdSchema,
  task_id: IdSchema,
  alias_ids: ids.optional(),
  metadata: FlexibleTaskMetadataSchema,
  environment_id: IdSchema,
  code_base_commit: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/),
  allocator_id: IdSchema
});
export type FlexibleAssignmentInput = z.infer<typeof FlexibleAssignmentInputSchema>;
export type FlexibleVariant = z.infer<typeof FlexibleVariantSchema>;
export type FlexibleProtocol = z.infer<typeof FlexibleProtocolSchema>;
export type FlexibleTaskMetadata = z.infer<typeof FlexibleTaskMetadataSchema>;
export type RuntimeEvidence = z.infer<typeof RuntimeEvidenceSchema>;
export type EventV2 = z.infer<typeof EventV2Schema>;
export type UsageV2 = z.infer<typeof UsageV2Schema>;
export type UsageEvent = (Event & { payload: z.infer<typeof UsageSchema> }) | EventV2;
export type BillingComponent = z.infer<typeof BillingComponentSchema>;
export type PriceTable = z.infer<typeof PriceTableSchema>;
export type PricedUsage = z.infer<typeof PricedUsageSchema>;
export type CostCoverageEvidence = z.infer<typeof CostCoverageEvidenceSchema>;
export type CostCoverageDecision = z.infer<typeof CostCoverageDecisionSchema>;
export type TaskCost = z.infer<typeof TaskCostSchema>;
export function parseTaskMetadata(input: unknown) {
  return parseComparison(z.union([TaskMetadataSchema, FlexibleTaskMetadataSchema]), input, 'invalid_metadata');
}
export function parseProtocol(input: unknown) {
  return parseComparison(z.union([ProtocolSchema, FlexibleProtocolSchema]), input, 'invalid_protocol');
}
