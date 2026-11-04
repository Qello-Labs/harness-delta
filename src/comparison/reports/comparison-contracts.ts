import { z } from 'zod';
import { IdSchema, TaskMetadataSchema, TimestampSchema, UsageSchema, ReasonSchema } from '../../contracts.js';
import { ConfigurationRecordSchema, ProtocolSchema, VariantSchema } from '../../comparison-contracts.js';

const time = TimestampSchema.transform(value => new Date(value).toISOString());
const interval = z.strictObject({ started_at: time, ended_at: time.nullable() });
export const RevisionReasonSchema = z.enum(['initial', 'late_arrival', 'cutoff_advanced', 'evidence_updated']);
export const SnapshotRequestSchema = z.strictObject({
  reportId: IdSchema,
  protocolId: IdSchema,
  cutoff: time,
  supersedesReportId: IdSchema.optional(),
  revisionReason: RevisionReasonSchema
});
export type ComparisonSnapshotRequest = z.input<typeof SnapshotRequestSchema>;
export const SnapshotAssignmentSchema = z.strictObject({
  assignment_id: IdSchema,
  task_id: IdSchema,
  variant_id: IdSchema,
  assigned_at: time,
  recorded_at: time,
  followup_ends_at: time,
  stratum_id: IdSchema,
  block_id: IdSchema,
  metadata: TaskMetadataSchema,
  environment_id: IdSchema,
  started_at: time.nullable(),
  first_completed_at: time.nullable(),
  first_assessed_at: time.nullable(),
  first_success: z.boolean().nullable(),
  finalized_at: time.nullable(),
  outcome: z.strictObject({ status: z.enum(['success', 'failed', 'aborted']), assessed_at: time, criteria_met: z.array(IdSchema) }).nullable(),
  rework_starts: z.array(time),
  active_intervals: z.array(interval),
  observations: z.array(interval.extend({ status: z.enum(['observed', 'missing', 'error', 'excluded', 'unmeasurable']), reason: ReasonSchema.nullable() })),
  usages: z.array(z.strictObject({ event_id: IdSchema, occurred_at: time, recorded_at: time.nullable(), payload: UsageSchema })),
  confirmations: z.array(ConfigurationRecordSchema.extend({ recorded_at: time })),
  deviations: z.array(
    z.strictObject({
      id: IdSchema,
      occurred_at: time,
      recorded_at: time,
      reason_code: z.enum(['mismatch', 'unknown', 'crossover', 'version_drift', 'reassignment_attempt', 'cancellation'])
    })
  )
});
export const ComparisonSnapshotInputSchema = z.strictObject({
  schema_version: z.literal(1),
  descriptive_version: z.literal('assignment-descriptive-1'),
  report_id: IdSchema,
  protocol: ProtocolSchema,
  variants: z.tuple([VariantSchema, VariantSchema]),
  cutoff: time,
  evaluated_at: time,
  data_revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  snapshot_sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  revision_reason: RevisionReasonSchema,
  supersedes_report_id: IdSchema.nullable(),
  assignments: z.array(SnapshotAssignmentSchema),
  registrations: z.array(
    z.strictObject({ task_id: IdSchema, registered_at: time, assignment_at: time.nullable(), assignment_protocol_id: IdSchema.nullable() })
  )
});
export type ComparisonSnapshotInput = z.input<typeof ComparisonSnapshotInputSchema>;
export type SnapshotAssignment = z.infer<typeof SnapshotAssignmentSchema>;
export interface InvalidatedReport {
  schema_version: 1;
  report_id: string;
  validity_status: 'invalidated';
  reason: 'deletion' | 'identity_conflict';
  original_cohort: 'unavailable_due_to_deletion' | 'unavailable_due_to_identity_conflict';
  adoption: { status: 'inconclusive'; reason: 'deletion' | 'identity_conflict' };
}
