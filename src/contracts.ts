import { z } from 'zod';

export const IdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/);
export const TimestampSchema = z.iso.datetime({ offset: false });
export const MonetaryAmountSchema = z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/);
export const TokenSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const ReasonSchema = z.enum(['not_available', 'unsupported', 'source_error', 'paused',
  'offline', 'counter_reset', 'scope_mismatch', 'unknown_parent', 'incomplete', 'overflow']);
export const ReadingSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('observed'), value: TokenSchema, reason: z.null() }),
  ...(['missing', 'error', 'excluded', 'unmeasurable'] as const).map(status =>
    z.strictObject({ status: z.literal(status), value: z.null(), reason: ReasonSchema })),
]);
export type Reading = z.infer<typeof ReadingSchema>;
export const ComparisonModeSchema = z.enum(['randomized_task', 'observational_period']);
export const ModelSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
export const ProductVersionSchema = z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/);
export const SourceCompatibilitySchema = z.strictObject({
  state: z.enum(['verified', 'compatibility_unverified', 'invalidated']),
  product: z.enum(['codex', 'claude_code']), product_version: ProductVersionSchema,
  source: z.enum(['file', 'codex_workflow', 'claude_workflow', 'codex_binding']),
  parser_version: ProductVersionSchema, parser_revision: IdSchema,
  profile_id: IdSchema, rule_revision: IdSchema,
});
export type SourceCompatibility = z.infer<typeof SourceCompatibilitySchema>;
export const UsageSchema = z.strictObject({
  kind: z.literal('usage'),
  input_total: ReadingSchema, cached_input: ReadingSchema,
  output_total: ReadingSchema, reasoning_output: ReadingSchema,
  product: z.enum(['codex', 'claude_code', 'synthetic']),
  product_version: ProductVersionSchema, model: ModelSchema, epoch: IdSchema,
  source_compatibility: SourceCompatibilitySchema.optional(),
  // Read-time exclusion of legacy observations whose source provenance is absent.
  source_invalidated: z.literal(true).optional(),
});
export const ToolSchema = z.strictObject({
  kind: z.literal('tool'), call_id: IdSchema,
  boundary: z.enum(['codex_command', 'claude_bash']),
  execution: z.enum(['confirmed', 'unknown']),
  outcome: z.enum(['completed', 'failed', 'denied', 'cancelled', 'validation_failed', 'unknown']),
  category: z.literal('unclassified'),
});
export const BillingComponentSchema = z.strictObject({
  kind: z.enum(['ordinary_input', 'cache_read', 'cache_write', 'output']), reading: ReadingSchema,
});
export const CacheWriteTtlSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('observed'), source: z.literal('product_usage_cache_creation'),
    five_minute_tokens: TokenSchema, one_hour_tokens: TokenSchema }),
  z.strictObject({ status: z.literal('missing'), source: z.literal('product_usage_cache_creation'), reason: z.literal('not_available') }),
  z.strictObject({ status: z.literal('error'), source: z.literal('product_usage_cache_creation'), reason: z.literal('source_error') }),
]);
export const UsageV2Schema = UsageSchema.extend({
  schema_version: z.literal(2), model: ModelSchema.nullable(), runtime_evidence_id: IdSchema.nullable(),
  attribution: z.enum(['verified', 'ambiguous', 'unknown']),
  cache_write_1h_observed: z.literal(true).optional(),
  cache_write_ttl: CacheWriteTtlSchema.optional(),
  billing_components: z.array(BillingComponentSchema).max(4)
    .refine(values => new Set(values.map(value => value.kind)).size === values.length),
}).refine(value => value.attribution !== 'verified' || (value.model !== null && value.runtime_evidence_id !== null))
  .refine(value => value.attribution !== 'ambiguous' || value.model === null)
  .refine(value => value.cache_write_ttl === undefined || value.product === 'claude_code' || value.product === 'synthetic')
  .refine(value => {
    const ttl = value.cache_write_ttl;
    if (ttl?.status !== 'observed') return true;
    const write = value.billing_components.find(component => component.kind === 'cache_write')?.reading;
    const total = ttl.five_minute_tokens + ttl.one_hour_tokens;
    return Number.isSafeInteger(total) && write?.status === 'observed' && write.value === total &&
      Boolean(value.cache_write_1h_observed) === (ttl.one_hour_tokens > 0);
  });
export const eventFields = {
  id: IdSchema, project_id: IdSchema, task_id: IdSchema, session_id: IdSchema,
  source_key: IdSchema, occurred_at: TimestampSchema,
};
export const LegacyEventSchema = z.strictObject({ ...eventFields,
  payload: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('session_linked') }), UsageSchema, ToolSchema,
  ]),
});
export const EventSchema = z.strictObject({ ...eventFields,
  payload: z.union([z.strictObject({ kind: z.literal('session_linked') }), UsageSchema, UsageV2Schema, ToolSchema]),
}).refine(event => event.payload.kind !== 'usage' || !event.payload.source_compatibility ||
  event.payload.product === event.payload.source_compatibility.product && event.payload.product_version === event.payload.source_compatibility.product_version);
export type Event = z.infer<typeof LegacyEventSchema>;

export function addTokens(values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    if (!TokenSchema.safeParse(value).success || !Number.isSafeInteger(total + value)) {
      throw new Error('token_overflow');
    }
    total += value;
  }
  return total;
}

export const TaskMetadataSchema = z.strictObject({
  type: IdSchema, expected_size: IdSchema, assignee: IdSchema,
  product: z.enum(['codex', 'claude_code', 'synthetic']), model: ModelSchema,
  criterion_ids: z.array(IdSchema).min(1).refine(ids => new Set(ids).size === ids.length),
  expected_complexity: IdSchema.optional(),
});
export const SharedTaskSchema = TaskMetadataSchema.extend({ id: IdSchema, project_id: IdSchema });
export const SharedOutcomeSchema = z.strictObject({
  task_id: IdSchema, status: z.enum(['success', 'failed', 'aborted']),
  criteria_met: z.array(IdSchema).refine(ids => new Set(ids).size === ids.length),
  first_success: z.boolean().nullable(), assessed_at: TimestampSchema,
});
