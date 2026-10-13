import { z } from 'zod';
import { IdSchema, MonetaryAmountSchema, ProductVersionSchema, ReadingSchema, TimestampSchema, TokenSchema } from './contracts.js';
import { CostFactsSchema, CostReasonSchema, PriceTableSchema } from './flexible-contracts.js';

export const InstrumentedHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const SequenceSchema = TokenSchema.min(1);
export const InstrumentedReasonSchema = z.enum([
  'unsupported_profile', 'unsupported_operation', 'unqualified_transport',
  'configuration_mismatch', 'topology_mismatch', 'identity_mismatch',
  'record_gap', 'record_conflict', 'unresolved_attempt', 'missing_usage',
  'counter_error', 'ambiguous_response', 'scope_revoked', 'receiver_lost',
  'producer_lost', 'durability_unavailable', 'missing_member_close',
  'missing_value', 'price_coverage', 'task_coverage',
]);
export type InstrumentedReason = z.infer<typeof InstrumentedReasonSchema>;

export const InstrumentedProducerProfileSchema = z.strictObject({
  schema_version: z.literal(1), profile_id: IdSchema,
  upstream_commit: z.string().regex(/^[a-f0-9]{40}$/),
  upstream_version: z.literal('0.162.1'), product_version: ProductVersionSchema,
  patched_source_digest: InstrumentedHashSchema,
  dependency_lock_digest: InstrumentedHashSchema,
  build_manifest_digest: InstrumentedHashSchema, binary_sha256: InstrumentedHashSchema,
  target: IdSchema, producer_protocol: z.literal('harness-codex-accounting-v1'),
  qualification_id: IdSchema, transport_contract_id: IdSchema,
  operation_inventory_digest: InstrumentedHashSchema,
  counter_contract_id: IdSchema, configuration_policy_id: IdSchema,
  model: z.literal('gpt-6.1-sol'), effort: z.literal('high'),
  max_roots: z.literal(1), max_direct_children: z.literal(2), max_depth: z.literal(1),
});
export type InstrumentedProducerProfile = z.infer<typeof InstrumentedProducerProfileSchema>;

export const InstrumentedRunControlSchema = z.strictObject({
  schema_version: z.literal(1), run_id: IdSchema, project_id: IdSchema, task_id: IdSchema,
  task_generation: TokenSchema, collector_instance_id: IdSchema, profile_id: IdSchema,
  producer_manifest_hash: InstrumentedHashSchema, root_session_id: IdSchema,
  configuration_receipt_id: IdSchema, authorization_receipt_id: IdSchema,
  price_table_id: IdSchema, price_table_hash: InstrumentedHashSchema,
  price_basis_hash: InstrumentedHashSchema.nullable(),
  state: z.enum(['prepared', 'open', 'closing', 'sealed', 'revoked']),
  opened_at: TimestampSchema.nullable(), closed_at: TimestampSchema.nullable(),
  control_sequence: TokenSchema,
});
export type InstrumentedRunControl = z.infer<typeof InstrumentedRunControlSchema>;

export const InstrumentedTokenReadingsSchema = z.strictObject({
  input_total: ReadingSchema, cached_input: ReadingSchema, cache_write_input: ReadingSchema,
  output_total: ReadingSchema, reasoning_output: ReadingSchema, total_tokens: ReadingSchema,
});
export type InstrumentedTokenReadings = z.infer<typeof InstrumentedTokenReadingsSchema>;

export const InstrumentedOperationClassSchema = z.enum([
  'generation', 'compaction', 'warmup', 'guardian', 'auxiliary', 'control', 'unknown',
]);
const TransportClassSchema = z.enum(['http_responses', 'http_other', 'websocket', 'unknown']);
export const InstrumentedTerminalDispositionSchema = z.enum([
  'response_completed', 'response_incomplete', 'http_error', 'transport_error', 'cancelled',
]);
export type InstrumentedTerminalDisposition = z.infer<typeof InstrumentedTerminalDispositionSchema>;

export const InstrumentedProducerRecordSchema = z.strictObject({
  schema_version: z.literal(1), run_id: IdSchema, producer_instance_id: IdSchema,
  member_id: IdSchema, task_generation: TokenSchema, sequence: SequenceSchema,
  previous_record_hash: InstrumentedHashSchema.nullable(), occurred_at: TimestampSchema,
  body: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('member_ready'), native_session_id: z.uuid(),
      parent_member_id: IdSchema.nullable(), child_reservation_id: IdSchema.nullable(),
      configuration_receipt_id: IdSchema,
    }),
    z.strictObject({ kind: z.literal('child_reserve'), parent_member_id: IdSchema }),
    z.strictObject({ kind: z.literal('child_cancel'), child_reservation_id: IdSchema }),
    z.strictObject({
      kind: z.literal('operation_open'), operation_id: IdSchema, turn_id: IdSchema.nullable(),
      operation_class: InstrumentedOperationClassSchema, transport_class: TransportClassSchema,
      requested_model: z.literal('gpt-6.1-sol'), requested_effort: z.literal('high'),
      configuration_revision: IdSchema,
    }),
    z.strictObject({
      kind: z.literal('attempt_reserve'), operation_id: IdSchema,
      retry_parent_attempt_id: IdSchema.nullable(),
    }),
    z.strictObject({ kind: z.literal('dispatch_commit'), attempt_id: IdSchema }),
    z.strictObject({ kind: z.literal('not_dispatched'), attempt_id: IdSchema }),
    z.strictObject({
      kind: z.literal('attempt_terminal'), attempt_id: IdSchema,
      disposition: InstrumentedTerminalDispositionSchema, response_id: IdSchema.nullable(),
      effective_model: z.literal('gpt-6.1-sol').nullable(),
      readings: InstrumentedTokenReadingsSchema,
    }),
    z.strictObject({
      kind: z.literal('operation_close'), operation_id: IdSchema,
      disposition: z.enum(['completed', 'failed', 'cancelled']),
    }),
    z.strictObject({
      kind: z.literal('unsupported_operation'), operation_id: IdSchema,
      operation_class: InstrumentedOperationClassSchema, transport_class: TransportClassSchema,
      reason: InstrumentedReasonSchema,
    }),
    z.strictObject({ kind: z.literal('close_request') }),
    z.strictObject({
      kind: z.literal('member_close'), close_fence_id: IdSchema,
      final_record_sequence: TokenSchema, final_record_hash: InstrumentedHashSchema.nullable(),
    }),
  ]),
});
export type InstrumentedProducerRecord = z.infer<typeof InstrumentedProducerRecordSchema>;

export const InstrumentedGateReceiptSchema = z.strictObject({
  schema_version: z.literal(1), receipt_id: IdSchema, run_id: IdSchema,
  control_sequence: SequenceSchema, recorded_at: TimestampSchema,
  body: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('member_admitted'), member_id: IdSchema, session_id: IdSchema }),
    z.strictObject({
      kind: z.literal('child_reserved'), child_reservation_id: IdSchema, parent_member_id: IdSchema,
    }),
    z.strictObject({ kind: z.literal('child_cancelled'), child_reservation_id: IdSchema }),
    z.strictObject({
      kind: z.literal('attempt_reserved'), attempt_id: IdSchema, operation_id: IdSchema,
      member_id: IdSchema, retry_parent_attempt_id: IdSchema.nullable(),
    }),
    z.strictObject({ kind: z.literal('dispatch_committed'), attempt_id: IdSchema }),
    z.strictObject({ kind: z.literal('not_dispatched'), attempt_id: IdSchema }),
    z.strictObject({
      kind: z.literal('record_committed'), producer_sequence: SequenceSchema,
      producer_record_hash: InstrumentedHashSchema,
    }),
    z.strictObject({ kind: z.literal('close_fence'), close_fence_id: IdSchema }),
    z.strictObject({ kind: z.literal('scope_revoked'), reason: InstrumentedReasonSchema }),
  ]),
});
export type InstrumentedGateReceipt = z.infer<typeof InstrumentedGateReceiptSchema>;

export const InstrumentedWindowSealSchema = z.strictObject({
  schema_version: z.literal(1), seal_id: IdSchema, run_id: IdSchema,
  task_generation: TokenSchema, profile_id: IdSchema,
  producer_manifest_hash: InstrumentedHashSchema,
  open_control_sequence: SequenceSchema, close_control_sequence: SequenceSchema,
  opened_at: TimestampSchema, closed_at: TimestampSchema, sealed_at: TimestampSchema,
  members: z.array(z.strictObject({
    member_id: IdSchema, session_id: IdSchema, identity_receipt_hash: InstrumentedHashSchema,
    final_record_sequence: SequenceSchema, final_record_hash: InstrumentedHashSchema,
    close_receipt_id: IdSchema,
  })).min(1).max(3).refine(values => new Set(values.map(value => value.member_id)).size === values.length),
  attempt_ledger_hash: InstrumentedHashSchema, terminal_records_hash: InstrumentedHashSchema,
  lifecycle_evidence_hash: InstrumentedHashSchema,
  configuration_evidence_hash: InstrumentedHashSchema,
  counts: z.strictObject({
    reserved: TokenSchema, dispatch_committed: TokenSchema,
    not_dispatched: TokenSchema, terminal: TokenSchema, unresolved: TokenSchema,
  }),
  unresolved_attempt_ids: z.array(IdSchema)
    .refine(values => new Set(values).size === values.length),
  reason_codes: z.array(InstrumentedReasonSchema)
    .refine(values => new Set(values).size === values.length),
}).refine(value =>
  Number.isSafeInteger(value.counts.dispatch_committed + value.counts.not_dispatched) &&
  value.counts.dispatch_committed + value.counts.not_dispatched <= value.counts.reserved &&
  value.counts.terminal <= value.counts.dispatch_committed &&
  value.counts.unresolved === value.unresolved_attempt_ids.length);
export type InstrumentedWindowSeal = z.infer<typeof InstrumentedWindowSealSchema>;

export const InstrumentedLaunchReceiptSchema = z.strictObject({
  schema_version: z.literal(1), receipt_id: IdSchema, run_id: IdSchema,
  binary_sha256: InstrumentedHashSchema, manifest_hash: InstrumentedHashSchema,
  process_id: TokenSchema.min(1), started_at: TimestampSchema,
  start_kind: z.enum(['task_start', 'work_window']),
  configuration_receipt_hash: InstrumentedHashSchema,
  authorization_receipt_hash: InstrumentedHashSchema,
});
export type InstrumentedLaunchReceipt = z.infer<typeof InstrumentedLaunchReceiptSchema>;

export const InstrumentedBuildIdentitySchema = z.strictObject({
  schema_version: z.literal(1), id: IdSchema, profile: InstrumentedProducerProfileSchema,
  qualification_kind: z.literal('instrumented_localhost'),
  qualification_hash: InstrumentedHashSchema, qualified_at: TimestampSchema,
});
export type InstrumentedBuildIdentity = z.infer<typeof InstrumentedBuildIdentitySchema>;

export const InstrumentedRetirementReceiptSchema = z.strictObject({
  schema_version: z.literal(1), run_id: IdSchema, launch_receipt_id: IdSchema,
  process_id: TokenSchema.min(1), exit_code: z.literal(0), retired_at: TimestampSchema,
  final_producer_sequence: SequenceSchema,
});

export const InstrumentedAttemptSchema = z.strictObject({
  id: IdSchema, run_id: IdSchema, operation_id: IdSchema, member_id: IdSchema,
  retry_parent_id: IdSchema.nullable(), reservation_receipt_id: IdSchema,
  dispatch_receipt_id: IdSchema.nullable(),
  state: z.enum(['reserved', 'dispatched', 'not_dispatched', 'terminal']),
  terminal_sequence: SequenceSchema.nullable(),
});
export const InstrumentedCostSnapshotSchema = z.strictObject({
  schema_version: z.literal(1), kind: z.literal('instrumented_cost_snapshot'),
  input_id: IdSchema, run_id: IdSchema, task_id: IdSchema, project_id: IdSchema,
  cutoff: TimestampSchema, captured_at: TimestampSchema,
  profile: InstrumentedProducerProfileSchema, control: InstrumentedRunControlSchema,
  seal: InstrumentedWindowSealSchema, launch: InstrumentedLaunchReceiptSchema.nullable(),
  retirement: InstrumentedRetirementReceiptSchema.nullable(),
  build_identity: InstrumentedBuildIdentitySchema.nullable(),
  price_table: PriceTableSchema, price_table_hash: InstrumentedHashSchema,
  price_basis_hash: InstrumentedHashSchema.nullable(),
  attempts: z.array(InstrumentedAttemptSchema),
  records: z.array(z.strictObject({
    sequence: SequenceSchema, record_hash: InstrumentedHashSchema, received_at: TimestampSchema,
    payload: InstrumentedProducerRecordSchema, receipt: InstrumentedGateReceiptSchema,
  })),
  receipts: z.array(InstrumentedGateReceiptSchema),
  task_lifecycle: z.strictObject({
    state: z.enum(['active', 'paused', 'finalized']), generation: TokenSchema,
    started_at: TimestampSchema, finalized_at: TimestampSchema.nullable(),
    active_interval_count: TokenSchema, other_source_session_count: TokenSchema,
    other_instrumented_run_count: TokenSchema, observation_gap_count: TokenSchema,
    other_source_event_count: TokenSchema,
  }),
  snapshot_hash: InstrumentedHashSchema,
});
export type InstrumentedCostSnapshot = z.infer<typeof InstrumentedCostSnapshotSchema>;

export const InstrumentedCostResultSchema = z.strictObject({
  schema_version: z.literal(3), kind: z.literal('instrumented_standardized_cost'),
  valuation_id: IdSchema, input_id: IdSchema, run_id: IdSchema, task_id: IdSchema, seal_id: IdSchema,
  source_snapshot_hash: InstrumentedHashSchema, cutoff: TimestampSchema, evaluated_at: TimestampSchema,
  coverage_scope: z.enum(['work_window', 'whole_task']),
  opened_at: TimestampSchema, closed_at: TimestampSchema,
  currency: PriceTableSchema.shape.currency, price_table_id: IdSchema,
  price_table_hash: InstrumentedHashSchema, price_basis_hash: InstrumentedHashSchema.nullable(),
  original_price_table_id: IdSchema, formula_version: IdSchema,
  usage_complete: z.boolean(), price_complete: z.boolean(), facts: CostFactsSchema,
  complete_window_amount: MonetaryAmountSchema.nullable(), complete_amount: MonetaryAmountSchema.nullable(),
  partial_amount: MonetaryAmountSchema.nullable(),
  source_unverified_partial_amount: MonetaryAmountSchema.nullable(), observed_attempt_count: TokenSchema,
  unresolved_attempt_count: TokenSchema,
  reasons: z.array(z.union([InstrumentedReasonSchema, CostReasonSchema, CostFactsSchema.keyof()])),
  limitations: z.array(IdSchema),
}).refine(value => value.complete_amount === null ||
  value.coverage_scope === 'whole_task' && value.usage_complete && value.price_complete &&
  value.complete_amount === value.complete_window_amount)
  .refine(value => value.complete_window_amount === null || value.usage_complete && value.price_complete);
export type InstrumentedCostResult = z.infer<typeof InstrumentedCostResultSchema>;
