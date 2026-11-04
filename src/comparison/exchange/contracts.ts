import { createHash } from 'node:crypto';
import { z } from 'zod';
import { IdSchema, TaskMetadataSchema, TimestampSchema, TokenSchema, ReasonSchema, addTokens } from '../../contracts.js';
import { ProtocolSchema, VariantSchema, parseComparison } from '../../comparison-contracts.js';
import { FlexibleProtocolSchema, FlexibleVariantSchema, FlexibleTaskMetadataSchema, PriceTableSchema } from '../../flexible-contracts.js';
import { FlexibleTaskReportSchema } from '../reports/flexible-comparison.js';
import { costFormulaVersion } from '../../pricing.js';
import { codePointOrder } from '../reports/comparison-task.js';
import { canonicalJson } from '../../core/canonical-json.js';

export const MAX_BYTES = 16 * 1024 * 1024;
export const time = TimestampSchema.transform(v => new Date(v).toISOString());
export const uuid = z.uuid();
export const count = TokenSchema;
const positive = count.refine(v => v > 0);
const ids = z
  .array(IdSchema)
  .max(10000)
  .refine(a => new Set(a).size === a.length);
export const SourceConfigSchema = z.strictObject({
  schema_version: z.literal(1),
  namespace_id: uuid,
  local_project_id: IdSchema,
  shared_project_id: uuid,
  protocol_id: IdSchema,
  owned_strata: ids.min(1).max(256)
});
export type SourceConfig = z.infer<typeof SourceConfigSchema>;
const { project_id: localProjectField, ...protocolFields } = ProtocolSchema.shape;
void localProjectField;
export const SharedProtocolSchema = z
  .strictObject({ ...protocolFields, shared_project_id: uuid })
  .refine(p => Date.parse(p.recruitment_start) < Date.parse(p.recruitment_end));
const reasonCounts = z
  .strictObject(Object.fromEntries(ReasonSchema.options.map(k => [k, count])) as Record<z.infer<typeof ReasonSchema>, typeof count>)
  .partial();
const reading = z
  .strictObject({
    observed_sum: count.nullable(),
    observed_events: count,
    status_counts: z.strictObject({ observed: count, missing: count, error: count, excluded: count, unmeasurable: count }),
    reason_counts: reasonCounts
  })
  .refine(
    r =>
      r.observed_events === r.status_counts.observed &&
      r.observed_events > 0 === (r.observed_sum !== null) &&
      addTokens(Object.values(r.reason_counts).filter((v): v is number => v !== undefined)) ===
        addTokens([r.status_counts.missing, r.status_counts.error, r.status_counts.excluded, r.status_counts.unmeasurable])
  );
const usage = z
  .strictObject({
    status: z.enum(['partial', 'missing']),
    complete_tokens: z.null(),
    partial_tokens: count.nullable(),
    input_total: reading,
    output_total: reading,
    cached_input: reading,
    reasoning_output: reading,
    known_late_arrivals: count,
    legacy_receipt_unknown: count
  })
  .refine(u => {
    const totals = [u.input_total, u.output_total, u.cached_input, u.reasoning_output].map(r => addTokens(Object.values(r.status_counts)));
    return (
      totals.every(n => n === totals[0]) &&
      (u.status === 'missing') === (totals[0] === 0) &&
      u.known_late_arrivals + u.legacy_receipt_unknown <= totals[0]! &&
      u.partial_tokens ===
        (u.input_total.observed_sum === null || u.output_total.observed_sum === null
          ? null
          : addTokens([u.input_total.observed_sum, u.output_total.observed_sum]))
    );
  });
export const EvidenceSchema = z.strictObject({
  started: z.boolean(),
  first_completed_at: time.nullable(),
  first_assessed_at: time.nullable(),
  first_success: z.boolean().nullable(),
  finalized_at: time.nullable(),
  current_outcome: z.enum(['success', 'failed', 'aborted']).nullable(),
  outcome_assessed_at: time.nullable(),
  criteria_met: ids,
  rework_count: count,
  usage,
  actual_configuration: z.strictObject({
    category: z.enum(['declared_a_only', 'declared_b_only', 'declared_other_only', 'mixed', 'unknown']),
    known_variant_ids: ids,
    has_unknown_variant: z.boolean(),
    has_unknown_runtime: z.boolean(),
    has_runtime_drift: z.boolean(),
    self_attested: count,
    selected_artifact_hash: count
  }),
  deviations: z
    .array(
      z.strictObject({
        occurred_at: time,
        recorded_at: time,
        reason_code: z.enum(['mismatch', 'unknown', 'crossover', 'version_drift', 'reassignment_attempt', 'cancellation'])
      })
    )
    .max(10000),
  observations: z
    .array(
      z.strictObject({
        started_at: time,
        ended_at: time,
        status: z.enum(['observed', 'missing', 'error', 'excluded', 'unmeasurable']),
        reason: ReasonSchema.nullable()
      })
    )
    .max(10000),
  time: z.strictObject({ active_ms: count.nullable(), elapsed_ms: count.nullable(), elapsed_is_labor: z.literal(false) })
});
export const SharedAssignmentSchema = z.strictObject({
  task_id: IdSchema,
  logical_task_id: IdSchema,
  alias_ids: ids,
  assignment_id: IdSchema,
  protocol_id: IdSchema,
  original_variant_id: IdSchema,
  stratum_id: IdSchema,
  block_id: IdSchema,
  allocation_index: count,
  allocator_id: IdSchema,
  assigned_at: time,
  assignment_recorded_at: time,
  followup_ends_at: time,
  registered_at: time,
  metadata: TaskMetadataSchema.safeExtend({ criterion_ids: ids.min(1) }),
  environment_id: IdSchema,
  evidence: EvidenceSchema
});
export type SharedAssignment = z.infer<typeof SharedAssignmentSchema>;
export const NoticeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('project'), target_id: uuid, reason: z.literal('deletion'), invalidated_at: time }),
  z.strictObject({ kind: z.literal('protocol_invalidated'), target_id: IdSchema, reason: z.enum(['deletion', 'identity_conflict']), invalidated_at: time })
]);
export type Notice = z.infer<typeof NoticeSchema>;
const envelope = {
  schema_version: z.literal(1),
  package_id: uuid,
  namespace_id: uuid,
  shared_project_id: uuid,
  export_revision: positive,
  produced_at: time,
  tombstones: z.array(NoticeSchema).max(2)
};
export const DataPackageSchema = z.strictObject({
  ...envelope,
  kind: z.literal('assignment_metadata'),
  protocol_id: IdSchema,
  cutoff: time,
  source_evaluated_at: time,
  source_snapshot_sequence: positive,
  identity_captured_at: time,
  protocol: z.strictObject({ settings: SharedProtocolSchema, frozen_at: time }),
  variants: z.tuple([VariantSchema, VariantSchema]),
  authority: z
    .array(z.strictObject({ stratum_id: IdSchema, allocator_id: IdSchema }))
    .min(1)
    .max(256),
  assignments: z.array(SharedAssignmentSchema).max(10000)
});
export const DeletionPackageSchema = z.strictObject({ ...envelope, kind: z.literal('deletion_metadata'), tombstones: z.array(NoticeSchema).min(1).max(2) });
export const ExchangePackageSchema = z.discriminatedUnion('kind', [DataPackageSchema, DeletionPackageSchema]);
export type DataPackage = z.infer<typeof DataPackageSchema>;
const { project_id: flexibleLocal, ...flexibleProtocolFields } = FlexibleProtocolSchema.shape;
void flexibleLocal;
export const FlexibleSharedProtocolSchema = z
  .strictObject({
    ...flexibleProtocolFields,
    purpose: protocolFields.purpose,
    minimum_effect: protocolFields.minimum_effect,
    quality_margin: protocolFields.quality_margin,
    confidence_level: protocolFields.confidence_level,
    shared_project_id: uuid
  })
  .refine(
    p =>
      Date.parse(p.recruitment_start) < Date.parse(p.recruitment_end) &&
      p.planning_basis_id === p.sample_plan.planning_basis_id &&
      p.strata.every(s => s.assignees.length === 1)
  );
export const FlexibleEvidenceSchema = z.strictObject({
  ...EvidenceSchema.omit({ usage: true, actual_configuration: true }).shape,
  // Native trust/reference metadata remains local; synthetic exchange retains its strict cost contract.
  cost: FlexibleTaskReportSchema.shape.cost.omit({
    compatibility: true,
    compatibility_unverified_partial_amount: true,
    legacy_unverified_partial_amount: true
  }),
  runtime_summary: FlexibleTaskReportSchema.shape.runtime_summary,
  cost_provenance: z.strictObject({
    price_table_id: IdSchema,
    price_table_hash: z.string().regex(/^[a-f0-9]{64}$/),
    formula_version: z.literal(costFormulaVersion),
    source_snapshot_hash: z.string().regex(/^[a-f0-9]{64}$/)
  })
});
export const FlexibleSharedAssignmentSchema = z.strictObject({
  ...SharedAssignmentSchema.omit({ metadata: true, evidence: true }).shape,
  metadata: FlexibleTaskMetadataSchema,
  evidence: FlexibleEvidenceSchema
});
export const FlexibleDataPackageSchema = z
  .strictObject({
    ...DataPackageSchema.omit({ schema_version: true, protocol: true, variants: true, assignments: true }).shape,
    schema_version: z.literal(2),
    protocol: z.strictObject({ settings: FlexibleSharedProtocolSchema, frozen_at: time }),
    variants: z.tuple([FlexibleVariantSchema, FlexibleVariantSchema]),
    assignments: z.array(FlexibleSharedAssignmentSchema).max(10000),
    price_table: PriceTableSchema,
    price_table_hash: z.string().regex(/^[a-f0-9]{64}$/),
    formula_version: z.literal(costFormulaVersion)
  })
  .refine(
    p =>
      p.price_table.id === p.protocol.settings.price_table_id &&
      digest(p.price_table) === p.price_table_hash &&
      p.assignments.every(
        a =>
          a.evidence.cost.currency === p.price_table.currency &&
          a.evidence.cost.price_table_id === p.price_table.id &&
          a.evidence.cost_provenance.price_table_id === p.price_table.id &&
          a.evidence.cost_provenance.price_table_hash === p.price_table_hash
      )
  );
export type FlexibleDataPackage = z.infer<typeof FlexibleDataPackageSchema>;
export type AnyDataPackage = DataPackage | FlexibleDataPackage;
export type AnySharedAssignment = SharedAssignment | z.infer<typeof FlexibleSharedAssignmentSchema>;
export type ExchangePackage = z.infer<typeof ExchangePackageSchema> | FlexibleDataPackage;
export function parseExchange<T>(schema: z.ZodType<T>, input: unknown): T {
  try {
    return parseComparison(schema, input, 'invalid_exchange_package');
  } catch {
    throw new Error('invalid_exchange_package');
  }
}
export function parseExchangePackage(input: unknown): ExchangePackage {
  if (input && typeof input === 'object' && 'schema_version' in input && input.schema_version !== 1 && input.schema_version !== 2)
    throw new Error('unsupported_exchange_version');
  const pkg =
    input && typeof input === 'object' && 'schema_version' in input && input.schema_version === 2
      ? parseExchange(FlexibleDataPackageSchema, input)
      : parseExchange(ExchangePackageSchema, input);
  if (pkg.kind === 'assignment_metadata') {
    if (pkg.variants[0].id === pkg.variants[1].id) throw new Error('invalid_exchange_package');
    const keys = new Set<string>();
    for (const a of pkg.assignments)
      for (const key of [a.logical_task_id, ...a.alias_ids]) {
        if (keys.has(key)) throw new Error('invalid_exchange_package');
        keys.add(key);
      }
    if (
      new Set(pkg.assignments.map(a => a.task_id)).size !== pkg.assignments.length ||
      new Set(pkg.assignments.map(a => a.assignment_id)).size !== pkg.assignments.length ||
      new Set(pkg.authority.map(a => a.stratum_id)).size !== pkg.authority.length
    )
      throw new Error('invalid_exchange_package');
  }
  if (new Set(pkg.tombstones.map(n => n.kind)).size !== pkg.tombstones.length) throw new Error('invalid_exchange_package');
  pkg.tombstones.sort((a, b) => codePointOrder(a.kind, b.kind));
  if (pkg.kind === 'assignment_metadata') {
    const p = pkg.protocol.settings;
    p.recruitment_start = new Date(p.recruitment_start).toISOString();
    p.recruitment_end = new Date(p.recruitment_end).toISOString();
    for (const a of [p.participants, p.environment_ids, p.sensitivity_plan_ids]) a.sort(codePointOrder);
    p.strata.sort((a, b) => codePointOrder(a.id, b.id));
    for (const s of p.strata) for (const a of [s.assignees, s.types, s.sizes]) a.sort(codePointOrder);
    pkg.authority.sort((a, b) => codePointOrder(a.stratum_id, b.stratum_id));
    pkg.assignments.sort((a, b) => codePointOrder(a.task_id, b.task_id));
    for (const a of pkg.assignments) {
      for (const ids of [a.alias_ids, a.metadata.criterion_ids, a.evidence.criteria_met]) ids.sort(codePointOrder);
      if ('actual_configuration' in a.evidence) a.evidence.actual_configuration.known_variant_ids.sort(codePointOrder);
      a.evidence.deviations.sort((a, b) => codePointOrder(canonicalJson(a), canonicalJson(b)));
      a.evidence.observations.sort((a, b) => codePointOrder(canonicalJson(a), canonicalJson(b)));
    }
  }
  if (Buffer.byteLength(canonicalJson(pkg)) > MAX_BYTES) throw new Error('exchange_limit_exceeded');
  return pkg;
}
export function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
export function protocolDigest(pkg: AnyDataPackage): string {
  return digest({ protocol: pkg.protocol, variants: pkg.variants });
}
