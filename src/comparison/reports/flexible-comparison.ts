import { overlayEventCompatibility } from '../../source-compatibility.js';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { Decimal } from 'decimal.js';
import { IdSchema, TimestampSchema, ReasonSchema, ModelSchema } from '../../contracts.js';
import {
  FlexibleProtocolSchema,
  FlexibleVariantSchema,
  FlexibleTaskMetadataSchema,
  EventV2Schema,
  RuntimeEvidenceSchema,
  CostCoverageEvidenceSchema,
  CostFactsSchema,
  PriceTableSchema,
  TaskCostSchema
} from '../../flexible-contracts.js';
import { comparisonTimestamp, parseComparison, ConfigurationRecordSchema } from '../../comparison-contracts.js';
import { comparisonProtocol, comparisonVariant, protocolRow } from '../../protocol-store.js';
import { aggregateTaskCost } from '../../metrics.js';
import { costFormulaVersion, readPriceTable } from '../../pricing.js';
import type { AssignmentRow } from '../allocation.js';
import type { TaskRow } from '../../lifecycle.js';
import type { Store } from '../../store.js';
import { canonicalJson } from '../../canonical-json.js';
import { assertLegacyComparisonTiming } from '../../external-session-contract.js';
import { ComparisonSnapshotInputSchema, SnapshotAssignmentSchema, RevisionReasonSchema } from './comparison-contracts.js';
/** Version 2 adds the late outcome disclosure; version 1 snapshots stay readable. */
export const FlexibleDescriptiveVersionSchema = z.enum(['flexible-cost-descriptive-1', 'flexible-cost-descriptive-2']);
export const FlexibleSnapshotAssignmentSchema = z.strictObject({
  ...SnapshotAssignmentSchema.omit({ metadata: true, usages: true }).shape,
  metadata: FlexibleTaskMetadataSchema,
  usages: z.array(z.strictObject({ event: EventV2Schema, recorded_at: TimestampSchema.nullable() })),
  runtime: z.array(RuntimeEvidenceSchema),
  gaps: z.array(z.strictObject({ started_at: TimestampSchema, ended_at: TimestampSchema.nullable(), recorded_at: TimestampSchema, reason: ReasonSchema })),
  coverage: CostCoverageEvidenceSchema,
  confirmations: SnapshotAssignmentSchema.shape.confirmations.max(10000),
  deviations: SnapshotAssignmentSchema.shape.deviations.max(10000)
});
export const FlexibleSnapshotInputSchema = z
  .strictObject({
    ...ComparisonSnapshotInputSchema.omit({ schema_version: true, descriptive_version: true, protocol: true, variants: true, assignments: true }).shape,
    schema_version: z.literal(2),
    descriptive_version: FlexibleDescriptiveVersionSchema,
    protocol: FlexibleProtocolSchema,
    variants: z.tuple([FlexibleVariantSchema, FlexibleVariantSchema]),
    assignments: z.array(FlexibleSnapshotAssignmentSchema),
    price_table: PriceTableSchema,
    formula_version: z.literal(costFormulaVersion)
  })
  .refine(value => value.price_table.id === value.protocol.price_table_id)
  .refine(value => value.variants.every((v, i) => v.id === value.protocol.variant_ids[i]))
  .refine(value => new Set(value.assignments.map(a => a.task_id)).size === value.assignments.length);
export type FlexibleSnapshotInput = z.infer<typeof FlexibleSnapshotInputSchema>;
const amount = TaskCostSchema.shape.complete_amount;
const LateOutcomeSchema = z.strictObject({ status: z.enum(['success', 'failed', 'aborted']), assessed_at: TimestampSchema });
export const FlexibleTaskReportSchema = z.strictObject({
  task_id: IdSchema,
  assignment_id: IdSchema,
  original_variant_id: IdSchema,
  metadata: FlexibleTaskMetadataSchema,
  followup_ends_at: TimestampSchema,
  deadline_status: z.enum(['followup_pending', 'success', 'failed', 'aborted', 'not_started', 'outcome_missing']),
  cost: TaskCostSchema,
  deviations: z.array(SnapshotAssignmentSchema.shape.deviations.element.omit({ id: true })).max(10000),
  quality: z.strictObject({
    outcome: z.enum(['success', 'failed', 'aborted']).nullable(),
    criteria_met: z.array(IdSchema),
    criteria_total: z.number().int().nonnegative(),
    first_success: z.boolean().nullable()
  }),
  time: z.strictObject({
    elapsed_ms: z.number().nonnegative().nullable(),
    active_ms: z.number().nonnegative().nullable(),
    rework_count: z.number().int().nonnegative()
  }),
  runtime_summary: z.strictObject({
    models: z.array(ModelSchema.nullable()).max(10000),
    efforts: z.array(IdSchema.nullable()).max(10000),
    changes: z.number().int().nonnegative(),
    unknown_count: z.number().int().nonnegative()
  }),
  /** Descriptive version 2: an outcome assessed at/after the follow-up deadline and
   * before the cutoff. Disclosed only; it never changes deadline_status or rates. */
  late_outcome: LateOutcomeSchema.nullable().optional()
});
export const FlexibleComparisonReportSchema = z
  .strictObject({
    schema_version: z.literal(2),
    descriptive_version: FlexibleDescriptiveVersionSchema,
    purpose: z.literal('functional_pilot').optional(),
    evaluation_status: z.literal('functional_only').optional(),
    report_id: IdSchema,
    protocol_id: IdSchema,
    cutoff: TimestampSchema,
    evaluated_at: TimestampSchema,
    validity_status: z.literal('valid'),
    data_revision: z.number().int().nonnegative(),
    snapshot_sequence: z.number().int().positive(),
    revision_reason: RevisionReasonSchema,
    supersedes_report_id: IdSchema.nullable(),
    snapshot_hash: z.string(),
    price_table_hash: z.string(),
    price_table: PriceTableSchema,
    formula_version: z.literal(costFormulaVersion),
    tasks: z.array(FlexibleTaskReportSchema),
    arms: z.array(
      z.strictObject({
        variant_id: IdSchema,
        assigned_count: z.number().int().nonnegative(),
        complete_count: z.number().int().nonnegative(),
        partial_count: z.number().int().nonnegative(),
        missing_count: z.number().int().nonnegative(),
        complete_mean: amount,
        partial_mean: amount,
        compatibility_unverified_partial_mean: amount.optional(),
        legacy_unverified_partial_mean: amount.optional(),
        invalidated_events: z.number().int().nonnegative().optional(),
        deadline_success_rate: z.number().min(0).max(1).nullable(),
        late_outcome_count: z.number().int().nonnegative().optional()
      })
    ),
    relative_change: z.string().nullable(),
    adoption: z.strictObject({
      status: z.enum(['inconclusive', 'not_applicable']),
      reasons: z.array(z.enum(['analysis_unverified', 'incomplete', 'followup_pending', 'quality_missing', 'functional_pilot_only']))
    }),
    limitations: z.array(z.string())
  })
  .refine(value => {
    const v2 = value.descriptive_version === 'flexible-cost-descriptive-2';
    return value.tasks.every(t => (t.late_outcome !== undefined) === v2) && value.arms.every(a => (a.late_outcome_count !== undefined) === v2);
  })
  .refine(value =>
    value.purpose === 'functional_pilot'
      ? value.evaluation_status === 'functional_only' &&
        value.adoption.status === 'not_applicable' &&
        value.adoption.reasons.includes('functional_pilot_only') &&
        value.relative_change === null &&
        value.arms.every(arm => arm.complete_mean === null)
      : value.evaluation_status === undefined && value.adoption.status === 'inconclusive' && !value.adoption.reasons.includes('functional_pilot_only')
  );
export type FlexibleComparisonReport = z.infer<typeof FlexibleComparisonReportSchema>;
export type FlexibleTaskReport = z.infer<typeof FlexibleTaskReportSchema>;
const Money = Decimal.clone({ precision: 160, rounding: Decimal.ROUND_HALF_EVEN, toExpNeg: -1000, toExpPos: 1000 });
export function projectFlexibleComparison(input: FlexibleSnapshotInput, historicalReplay = false): FlexibleComparisonReport {
  const config = parseComparison(FlexibleSnapshotInputSchema, input, 'invalid_snapshot_input');
  const functional = config.protocol.purpose === 'functional_pilot';
  // Stored version 1 snapshots must re-project byte-identically, so the late
  // outcome disclosure exists only in version 2 inputs.
  const disclosesLate = config.descriptive_version === 'flexible-cost-descriptive-2';
  const evaluation = Date.parse(config.evaluated_at);
  if (Date.parse(config.cutoff) > evaluation) throw new Error('invalid_cutoff');
  const tasks = config.assignments
    .filter(a => Date.parse(a.assigned_at) < Date.parse(config.cutoff) && Date.parse(a.recorded_at) <= evaluation)
    .map(a => {
      if (!config.protocol.variant_ids.includes(a.variant_id) || a.coverage.task_id !== a.task_id) throw new Error('scope_mismatch');
      const end = Math.min(Date.parse(config.cutoff), Date.parse(a.followup_ends_at));
      const startedAt = a.started_at !== null && Date.parse(a.started_at) >= Date.parse(a.assigned_at) && Date.parse(a.started_at) < end ? a.started_at : null;
      const start = Date.parse(a.assigned_at);
      const timeStart = startedAt === null ? start : Date.parse(startedAt);
      const window = (at: string) => Date.parse(at) >= start && Date.parse(at) < end;
      const pending = Date.parse(config.cutoff) < Date.parse(a.followup_ends_at);
      const runtime = a.runtime.filter(r => r.task_id === a.task_id && window(r.occurred_at) && Date.parse(r.recorded_at) <= evaluation);
      const observed = a.usages.filter(
        u => u.event.task_id === a.task_id && window(u.event.occurred_at) && u.recorded_at !== null && Date.parse(u.recorded_at) <= evaluation
      );
      const facts = { ...a.coverage.facts };
      if (pending) facts.terminal_accounting = 'unknown';
      if (
        a.gaps.some(
          g => Date.parse(g.started_at) < end && Date.parse(g.ended_at ?? new Date(end).toISOString()) >= start && Date.parse(g.recorded_at) <= evaluation
        )
      )
        facts.continuous_observation = 'violated';
      if (Date.parse(a.coverage.window_start) !== start || Date.parse(a.coverage.window_end) !== Date.parse(a.followup_ends_at))
        throw new Error('coverage_window_mismatch');
      if (
        observed.some(
          u =>
            !runtime.some(
              r =>
                r.id === u.event.payload.runtime_evidence_id &&
                r.session_id === u.event.session_id &&
                r.model === u.event.payload.model &&
                r.source !== 'self_attested'
            )
        )
      )
        facts.configuration_accounting = 'unknown';
      const cost =
        start < end
          ? aggregateTaskCost(
              observed.map(u => u.event),
              config.price_table,
              { ...a.coverage, window_start: new Date(start).toISOString(), window_end: new Date(end).toISOString(), facts },
              runtime,
              historicalReplay
            )
          : {
              currency: config.price_table.currency,
              price_table_id: config.price_table.id,
              complete_amount: null,
              partial_amount: null,
              usage_complete: false,
              price_complete: false,
              reasons: ['missing_value' as const]
            };
      const outcome = a.outcome && window(a.outcome.assessed_at) ? a.outcome : null;
      if (outcome?.criteria_met.some(id => !a.metadata.criterion_ids.includes(id))) throw new Error('invalid_criteria');
      const deadlineStatus = pending
        ? ('followup_pending' as const)
        : (outcome?.status ?? (startedAt === null ? ('not_started' as const) : ('outcome_missing' as const)));
      const late =
        !pending &&
        a.outcome !== null &&
        outcome === null &&
        Date.parse(a.outcome.assessed_at) >= Date.parse(a.followup_ends_at) &&
        Date.parse(a.outcome.assessed_at) < Date.parse(config.cutoff)
          ? { status: a.outcome.status, assessed_at: a.outcome.assessed_at }
          : null;
      const intervals = a.active_intervals
        .map(i => [Math.max(timeStart, Date.parse(i.started_at)), Math.min(end, Date.parse(i.ended_at ?? new Date(end).toISOString()))] as const)
        .filter(([x, y]) => x < y)
        .sort(([x], [y]) => x - y);
      let active = 0;
      let until = timeStart;
      for (const [x, y] of intervals) {
        if (y > until) {
          active += y - Math.max(x, until);
          until = y;
        }
      }
      let changes = 0;
      for (let i = 1; i < runtime.length; i++) if (runtime[i]!.model !== runtime[i - 1]!.model || runtime[i]!.effort !== runtime[i - 1]!.effort) changes++;
      return parseComparison(
        FlexibleTaskReportSchema,
        {
          task_id: a.task_id,
          assignment_id: a.assignment_id,
          original_variant_id: a.variant_id,
          metadata: a.metadata,
          followup_ends_at: a.followup_ends_at,
          deadline_status: deadlineStatus,
          cost,
          deviations: a.deviations
            .filter(d => window(d.occurred_at) && Date.parse(d.recorded_at) <= evaluation)
            .map(d => ({ occurred_at: d.occurred_at, recorded_at: d.recorded_at, reason_code: d.reason_code })),
          quality: {
            outcome: outcome?.status ?? null,
            criteria_met: outcome?.criteria_met ?? [],
            criteria_total: a.metadata.criterion_ids.length,
            first_success: a.first_assessed_at !== null && window(a.first_assessed_at) ? a.first_success : null
          },
          time: {
            elapsed_ms: startedAt === null ? null : Math.max(0, Math.min(end, a.finalized_at === null ? end : Date.parse(a.finalized_at)) - timeStart),
            active_ms: startedAt === null ? null : active,
            rework_count: a.rework_starts.filter(window).length
          },
          runtime_summary: {
            models: [...new Set(runtime.map(r => r.model))],
            efforts: [...new Set(runtime.map(r => r.effort))],
            changes,
            unknown_count: runtime.filter(r => r.model === null || r.boundary === 'unknown').length
          },
          ...(disclosesLate ? { late_outcome: late } : {})
        },
        'invalid_snapshot_input'
      );
    });
  const allComplete = tasks.length > 0 && tasks.every(t => t.cost.complete_amount !== null);
  const mean = (values: string[]) =>
    values.length
      ? values
          .reduce((sum, value) => sum.plus(value), new Money(0))
          .div(values.length)
          .toFixed()
      : null;
  const arms = config.protocol.variant_ids.map(variant_id => {
    const rows = tasks.filter(t => t.original_variant_id === variant_id);
    const complete = rows.filter(t => t.cost.complete_amount !== null);
    const partial = rows.filter(t => t.cost.complete_amount === null && t.cost.partial_amount !== null);
    return {
      variant_id,
      assigned_count: rows.length,
      complete_count: complete.length,
      partial_count: partial.length,
      missing_count: rows.length - complete.length - partial.length,
      complete_mean: allComplete && !functional ? mean(rows.map(t => t.cost.complete_amount!)) : null,
      partial_mean: mean(rows.flatMap(t => (t.cost.partial_amount === null ? [] : [t.cost.partial_amount]))),
      ...(rows.some(t => t.cost.compatibility)
        ? {
            compatibility_unverified_partial_mean: mean(
              rows.flatMap(t => (t.cost.compatibility_unverified_partial_amount == null ? [] : [t.cost.compatibility_unverified_partial_amount]))
            ),
            legacy_unverified_partial_mean: mean(
              rows.flatMap(t => (t.cost.legacy_unverified_partial_amount == null ? [] : [t.cost.legacy_unverified_partial_amount]))
            ),
            invalidated_events: rows.reduce((sum, t) => sum + (t.cost.compatibility?.invalidated_events ?? 0), 0)
          }
        : {}),
      deadline_success_rate:
        rows.length && rows.every(t => !['followup_pending', 'outcome_missing'].includes(t.deadline_status))
          ? rows.filter(t => t.deadline_status === 'success').length / rows.length
          : null,
      ...(disclosesLate ? { late_outcome_count: rows.filter(t => t.late_outcome).length } : {})
    };
  });
  const a = arms[0]!.complete_mean;
  const b = arms[1]!.complete_mean;
  const relative = a !== null && b !== null && !new Money(a).isZero() ? new Money(b).minus(a).div(a).toFixed() : null;
  const reasons: FlexibleComparisonReport['adoption']['reasons'] = functional ? ['functional_pilot_only'] : ['analysis_unverified'];
  if (!allComplete) reasons.push('incomplete');
  if (tasks.some(t => t.deadline_status === 'followup_pending')) reasons.push('followup_pending');
  if (tasks.some(t => t.quality.outcome === null)) reasons.push('quality_missing');
  return parseComparison(
    FlexibleComparisonReportSchema,
    {
      schema_version: 2,
      descriptive_version: config.descriptive_version,
      report_id: config.report_id,
      protocol_id: config.protocol.id,
      cutoff: config.cutoff,
      evaluated_at: config.evaluated_at,
      validity_status: 'valid',
      data_revision: config.data_revision,
      snapshot_sequence: config.snapshot_sequence,
      revision_reason: config.revision_reason,
      supersedes_report_id: config.supersedes_report_id,
      snapshot_hash: createHash('sha256').update(canonicalJson(config)).digest('hex'),
      price_table_hash: createHash('sha256').update(canonicalJson(config.price_table)).digest('hex'),
      price_table: config.price_table,
      formula_version: config.formula_version,
      ...(functional ? { purpose: 'functional_pilot', evaluation_status: 'functional_only' } : {}),
      tasks,
      arms,
      relative_change: relative,
      adoption: { status: functional ? 'not_applicable' : 'inconclusive', reasons },
      limitations: [
        'standardized_estimated_cost_is_not_actual_billing',
        'whole_task_cost_unconfirmed_without_coverage',
        'elapsed_is_not_human_labor',
        'realized_model_is_descriptive_only'
      ]
    },
    'invalid_snapshot'
  );
}
export function captureFlexibleInput(
  store: Store,
  protocolId: string,
  reportId: string,
  cutoff: string,
  evaluatedAt: string,
  sequence: number,
  reason: FlexibleSnapshotInput['revision_reason'],
  supersedes: string | null
): FlexibleSnapshotInput {
  assertLegacyComparisonTiming(store, protocolId);
  const row = protocolRow(store, protocolId);
  const protocol = comparisonProtocol(store, row);
  if (protocol.schema_version !== 2) throw new Error('unsupported_report_mode');
  const variants = protocol.variant_ids.map(id => comparisonVariant(store, id));
  const assignments = store
    .all<AssignmentRow>('SELECT * FROM comparison_assignments WHERE protocol_id=? ORDER BY task_id', [protocolId])
    .filter(a => Date.parse(a.assigned_at) < Math.min(Date.parse(cutoff), Date.parse(protocol.recruitment_end)))
    .map(a => {
      const task = store.get<TaskRow>('SELECT * FROM tasks WHERE id=?', [a.task_id]);
      if (!task) throw new Error('unknown_task');
      const prereg = store.get<{ metadata: string; environment_id: string }>(
        'SELECT metadata,environment_id FROM comparison_preregistrations WHERE task_id=?',
        [a.task_id]
      );
      if (!prereg) throw new Error('task_not_assigned');
      const usages = store
        .all<{
          id: string;
          project_id: string;
          task_id: string;
          session_id: string;
          source_key: string;
          occurred_at: string;
          payload: string;
          recorded_at: string | null;
        }>('SELECT e.*,r.recorded_at FROM events e LEFT JOIN event_receipts r ON r.event_id=e.id WHERE e.task_id=? ORDER BY e.occurred_at,e.id', [a.task_id])
        .flatMap(e => {
          const payload: unknown = JSON.parse(e.payload);
          const event = EventV2Schema.safeParse({
            id: e.id,
            project_id: e.project_id,
            task_id: e.task_id,
            session_id: e.session_id,
            source_key: e.source_key,
            occurred_at: e.occurred_at,
            payload
          });
          return event.success ? [{ event: EventV2Schema.parse(overlayEventCompatibility(store, event.data)), recorded_at: e.recorded_at }] : [];
        });
      const runtime = store
        .all<{ payload: string }>('SELECT payload FROM runtime_evidence WHERE task_id=? ORDER BY occurred_at,id', [a.task_id])
        .map(r => parseComparison(RuntimeEvidenceSchema, JSON.parse(r.payload) as unknown));
      const endpointEnd = Math.min(Date.parse(cutoff), Date.parse(a.followup_ends_at));
      const startedAt =
        task.started_at !== null && Date.parse(task.started_at) >= Date.parse(a.assigned_at) && Date.parse(task.started_at) < endpointEnd
          ? task.started_at
          : null;
      const outcome = store.get<{ status: string; assessed_at: string; criteria_met: string }>('SELECT * FROM outcomes WHERE task_id=?', [a.task_id]);
      return {
        assignment_id: a.id,
        task_id: a.task_id,
        variant_id: a.variant_id,
        assigned_at: a.assigned_at,
        recorded_at: a.recorded_at,
        followup_ends_at: a.followup_ends_at,
        stratum_id: a.stratum_id,
        block_id: a.block_id,
        metadata: parseComparison(FlexibleTaskMetadataSchema, JSON.parse(prereg.metadata) as unknown),
        environment_id: prereg.environment_id,
        started_at: startedAt,
        first_completed_at: task.first_completed_at,
        first_assessed_at: task.first_assessed_at,
        first_success: task.first_success === null ? null : task.first_success === 1,
        finalized_at: task.finalized_at,
        outcome: outcome ? { status: outcome.status, assessed_at: outcome.assessed_at, criteria_met: JSON.parse(outcome.criteria_met) as unknown } : null,
        rework_starts: store
          .all<{ started_at: string }>("SELECT started_at FROM attempts WHERE task_id=? AND kind='rework' ORDER BY started_at,id", [a.task_id])
          .map(r => r.started_at),
        active_intervals: store.all('SELECT started_at,ended_at FROM active_intervals WHERE task_id=? ORDER BY started_at,id', [a.task_id]),
        observations: [],
        confirmations: store
          .all<{ payload: string; recorded_at: string }>('SELECT payload,recorded_at FROM comparison_confirmations WHERE task_id=? ORDER BY occurred_at,id', [
            a.task_id
          ])
          .map(r => ({ ...parseComparison(ConfigurationRecordSchema, JSON.parse(r.payload) as unknown), recorded_at: r.recorded_at }))
          .filter(
            r =>
              Date.parse(r.occurred_at) >= Date.parse(a.assigned_at) &&
              Date.parse(r.occurred_at) < endpointEnd &&
              Date.parse(r.recorded_at) <= Date.parse(evaluatedAt)
          ),
        deviations: store
          .all<{ id: string; occurred_at: string; recorded_at: string; reason_code: string }>(
            'SELECT id,occurred_at,recorded_at,reason_code FROM comparison_deviations WHERE task_id=? ORDER BY occurred_at,id',
            [a.task_id]
          )
          .filter(
            r =>
              Date.parse(r.occurred_at) >= Date.parse(a.assigned_at) &&
              Date.parse(r.occurred_at) < endpointEnd &&
              Date.parse(r.recorded_at) <= Date.parse(evaluatedAt)
          ),
        usages,
        runtime,
        gaps: store.all('SELECT started_at,ended_at,recorded_at,reason FROM observation_gaps WHERE task_id=? ORDER BY started_at,id', [a.task_id]),
        coverage: {
          profile_id: 'unsupported-production-cost',
          task_id: a.task_id,
          window_start: a.assigned_at,
          window_end: a.followup_ends_at,
          facts: Object.fromEntries(Object.keys(CostFactsSchema.shape).map(k => [k, 'unknown'])),
          has_observed_value: usages.length > 0
        }
      };
    });
  return parseComparison(
    FlexibleSnapshotInputSchema,
    {
      schema_version: 2,
      descriptive_version: 'flexible-cost-descriptive-2',
      report_id: reportId,
      protocol,
      variants,
      cutoff: comparisonTimestamp(cutoff),
      evaluated_at: comparisonTimestamp(evaluatedAt),
      data_revision: row.data_revision,
      snapshot_sequence: sequence,
      revision_reason: reason,
      supersedes_report_id: supersedes,
      assignments,
      registrations: [],
      price_table: readPriceTable(store, protocol.price_table_id),
      formula_version: costFormulaVersion
    },
    'invalid_snapshot_input'
  );
}
export function aggregateFlexibleTaskReport(store: Store, taskId: string, cutoff: string): FlexibleTaskReport {
  return store.transaction(() => {
    const a = store.get<AssignmentRow>('SELECT * FROM comparison_assignments WHERE task_id=?', [parseComparison(IdSchema, taskId)]);
    if (!a) throw new Error('task_not_assigned');
    const input = captureFlexibleInput(store, a.protocol_id, 'current-task-report', cutoff, new Date().toISOString(), 1, 'initial', null);
    const task = projectFlexibleComparison(input).tasks.find(t => t.task_id === taskId);
    if (!task) throw new Error('task_not_in_window');
    return task;
  });
}
