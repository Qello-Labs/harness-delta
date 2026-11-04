import { describe, expect, test } from 'vitest';
import { projectComparison } from '../src/reports/comparison.js';
import type { ComparisonSnapshotInput } from '../src/reports/comparison-contracts.js';
import { ProtocolSchema, VariantSchema } from '../src/comparison-contracts.js';
import { TaskMetadataSchema } from '../src/contracts.js';
import { metadata, protocol, variantA, variantB } from './helpers/comparison-fixture.js';

const assigned = '2026-01-01T00:00:00.000Z';
const deadline = '2026-01-01T01:00:00.000Z';
const earlier = '2026-01-01T00:59:59.999Z';
export function input(): ComparisonSnapshotInput {
  return {
    schema_version: 1,
    descriptive_version: 'assignment-descriptive-1',
    report_id: 'report-1',
    protocol: ProtocolSchema.parse(protocol),
    variants: [VariantSchema.parse(variantA), VariantSchema.parse(variantB)],
    cutoff: deadline,
    evaluated_at: '2026-01-03T00:00:00.000Z',
    data_revision: 0,
    snapshot_sequence: 1,
    revision_reason: 'initial',
    supersedes_report_id: null,
    registrations: [],
    assignments: [
      {
        assignment_id: 'assignment-1',
        task_id: 'task-1',
        variant_id: variantA.id,
        assigned_at: assigned,
        recorded_at: assigned,
        followup_ends_at: deadline,
        stratum_id: 'stratum-1',
        block_id: 'block-1',
        metadata: TaskMetadataSchema.parse(metadata),
        environment_id: 'environment-1',
        started_at: null,
        first_completed_at: null,
        first_assessed_at: null,
        first_success: null,
        finalized_at: null,
        outcome: null,
        rework_starts: [],
        active_intervals: [],
        observations: [],
        usages: [],
        confirmations: [],
        deviations: []
      }
    ]
  };
}
const observed = (value: number) => ({ status: 'observed' as const, value, reason: null });
const missing = { status: 'missing' as const, value: null, reason: 'not_available' as const };
function usage(id: string, at: string, value: number) {
  return {
    event_id: id,
    occurred_at: at,
    recorded_at: '2026-01-02T12:00:00.000Z',
    payload: {
      kind: 'usage' as const,
      input_total: observed(value),
      output_total: observed(0),
      cached_input: observed(value),
      reasoning_output: observed(0),
      product: 'synthetic' as const,
      product_version: '1.0.0',
      model: 'synthetic-model',
      epoch: 'epoch-1'
    }
  };
}
describe('assignment endpoint', () => {
  test('keeps never-started assignments and incomplete blocks without inventing zero', () => {
    const report = projectComparison(input());
    expect(report.total.assigned_tasks).toBe(1);
    expect(report.tasks[0]?.deadline_status).toBe('not_started');
    expect(report.total.deadline_success).toEqual({ numerator: 0, denominator: 1, value: 0, reason: null });
    expect(report.total.usage).toMatchObject({ complete_tasks: 0, partial_tasks: 0, missing_tasks: 1 });
    expect(report.tasks[0]?.usage.input_total.observed_sum).toBeNull();
    expect(report.blocks).toEqual([{ block_id: 'block-1', stratum_id: 'stratum-1', assigned_tasks: 1, a: 1, b: 0, planned_size: 4, status: 'incomplete' }]);
    expect(report.provisional).toBe(true); // Recruitment is still open.
  });
  test('uses half-open usage/assessment boundaries and all-assignment rates', () => {
    const data = input();
    const row = data.assignments[0]!;
    row.started_at = assigned;
    row.outcome = { status: 'success', assessed_at: deadline, criteria_met: ['criterion-1'] };
    row.usages = [usage('before', '2025-12-31T23:59:59.999Z', 100), usage('start', assigned, 0), usage('inside', earlier, 7), usage('end', deadline, 99)];
    const report = projectComparison(data);
    expect(report.tasks[0]?.deadline_status).toBe('outcome_missing');
    expect(report.tasks[0]?.usage.partial_tokens).toBe(7);
    expect(report.tasks[0]?.usage.input_total).toMatchObject({ observed_sum: 7, observed_events: 2 });
    expect(report.total.usage.partial_tokens).toEqual({ task_denominator: 1, distribution: [7], mean: 7, median: 7 });
    expect(report.tasks[0]?.usage.known_late_arrivals).toBe(2);
    row.outcome.assessed_at = earlier;
    expect(projectComparison(data).total.deadline_success.value).toBe(1);
  });
  test('early finalization does not shorten follow-up and future state does not leak', () => {
    const data = input();
    data.cutoff = earlier;
    const row = data.assignments[0]!;
    row.started_at = assigned;
    row.finalized_at = '2026-01-01T00:10:00.000Z';
    row.outcome = { status: 'success', assessed_at: row.finalized_at, criteria_met: ['criterion-1'] };
    row.usages = [usage('after-final', '2026-01-01T00:20:00.000Z', 3)];
    row.active_intervals = [{ started_at: assigned, ended_at: row.finalized_at }];
    row.observations = [{ started_at: assigned, ended_at: deadline, status: 'observed', reason: null }];
    expect(projectComparison(data).tasks[0]).toMatchObject({ deadline_status: 'pending_followup', current_outcome: 'success', endpoint_end: earlier });
    expect(projectComparison(data).total.deadline_success).toMatchObject({ denominator: 1, value: null, reason: 'pending_followup' });
    expect(projectComparison(data).tasks[0]?.observations[0]).toMatchObject({ ended_at: earlier, status: 'unmeasurable', reason: 'incomplete' });
    data.cutoff = deadline;
    row.started_at = deadline;
    row.outcome = null;
    expect(projectComparison(data).tasks[0]?.deadline_status).toBe('not_started');
  });
  test('excludes assignment at cutoff and partitions project registrations as of cutoff', () => {
    const data = input();
    data.cutoff = assigned;
    data.registrations = [{ task_id: 'unassigned', registered_at: assigned, assignment_at: null, assignment_protocol_id: null }];
    expect(projectComparison(data).total.assigned_tasks).toBe(0);
    expect(projectComparison(data).total.deadline_success.value).toBeNull();
    data.cutoff = earlier;
    data.registrations = [{ task_id: 'unassigned', registered_at: assigned, assignment_at: deadline, assignment_protocol_id: protocol.id }];
    expect(projectComparison(data).recruitment_context).toMatchObject({ registered_tasks: 1, unassigned: 1, assigned_this_protocol: 0 });
  });
  test('preserves component states, observed zero and safe token overflow', () => {
    const data = input();
    const row = data.assignments[0]!;
    row.usages = [usage('zero', assigned, 0)];
    expect(projectComparison(data).tasks[0]?.usage).toMatchObject({ status: 'partial', partial_tokens: 0, complete_tokens: null });
    row.usages[0]!.payload.output_total = missing;
    expect(projectComparison(data).tasks[0]?.usage.partial_tokens).toBeNull();
    row.usages.push(usage('more', earlier, Number.MAX_SAFE_INTEGER), usage('overflow', earlier, 1));
    expect(() => projectComparison(data)).toThrow('token_overflow');
  });
  test('keeps original arm and distinguishes known third variants from runtime uncertainty', () => {
    const data = input();
    const row = data.assignments[0]!;
    const base = {
      schema_version: 1 as const,
      id: 'confirmation-1',
      task_id: row.task_id,
      occurred_at: assigned,
      recorded_at: assigned,
      evidence_method: 'self_attested' as const,
      actual_variant_id: 'variant-c',
      product: null,
      product_version: null,
      model: null,
      reasoning_setting: null,
      environment_id: null,
      verification_status: 'unknown' as const,
      observed_config_hash: null,
      verification_scope: 'declared_settings' as const,
      deviation_codes: ['unknown' as const]
    };
    row.confirmations = [base];
    expect(projectComparison(data).tasks[0]?.actual_configuration).toMatchObject({ category: 'declared_other_only', has_unknown_runtime: true });
    row.confirmations.push({ ...base, id: 'confirmation-2', actual_variant_id: 'variant-a' });
    expect(projectComparison(data).tasks[0]?.actual_configuration.category).toBe('mixed');
    row.confirmations = [
      { ...base, actual_variant_id: 'variant-a', deviation_codes: ['version_drift'] },
      { ...base, id: 'confirmation-2', actual_variant_id: null }
    ];
    expect(projectComparison(data).tasks[0]?.actual_configuration).toMatchObject({
      category: 'declared_a_only',
      has_unknown_variant: true,
      has_runtime_drift: true
    });
    expect(projectComparison(data).arms[0]?.assigned_tasks).toBe(1);
    expect(projectComparison(data).adoption).toEqual({ status: 'inconclusive', reason: 'analysis_not_validated' });
  });
});

test('keeps all arms provisional when another arm follow-up is pending and does not discard failures or rework', () => {
  const data = input();
  const first = data.assignments[0]!;
  first.started_at = assigned;
  first.outcome = { status: 'success', assessed_at: earlier, criteria_met: ['criterion-1'] };
  first.first_assessed_at = earlier;
  first.first_success = false;
  first.rework_starts = [assigned, deadline];
  data.assignments.push({
    ...first,
    assignment_id: 'assignment-2',
    task_id: 'task-2',
    variant_id: 'variant-b',
    followup_ends_at: '2026-01-01T02:00:00.000Z',
    outcome: null,
    first_assessed_at: null,
    first_success: null
  });
  const report = projectComparison(data);
  expect(report.total.assigned_tasks).toBe(2);
  expect(report.total.deadline_counts).toMatchObject({ success: 1, pending_followup: 1 });
  expect(report.arms[0]?.deadline_success.value).toBeNull();
  expect(report.tasks[0]?.rework_count).toBe(1);
  expect(report.total.first_attempt.success).toMatchObject({ numerator: 0, denominator: 1, value: 0 });
  expect(report.total.criteria.fulfillment).toMatchObject({ numerator: 1, denominator: 1, value: 1 });
});

test('audits exact-endpoint receipts as late and preserves excluded/error/unmeasurable components', () => {
  const data = input();
  const row = data.assignments[0]!;
  row.usages = [{ ...usage('late', earlier, 0), recorded_at: deadline }];
  row.usages[0]!.payload.cached_input = { status: 'excluded', value: null, reason: 'paused' };
  row.usages[0]!.payload.reasoning_output = { status: 'unmeasurable', value: null, reason: 'unsupported' };
  row.usages.push({
    ...usage('error', assigned, 1),
    recorded_at: null,
    payload: { ...usage('error', assigned, 1).payload, input_total: { status: 'error', value: null, reason: 'source_error' } }
  });
  const report = projectComparison(data);
  expect(report.tasks[0]?.usage.known_late_arrivals).toBe(1);
  expect(report.tasks[0]?.usage.legacy_receipt_unknown).toBe(1);
  expect(report.tasks[0]?.usage.cached_input.status_counts.excluded).toBe(1);
  expect(report.tasks[0]?.usage.input_total.status_counts.error).toBe(1);
  expect(report.tasks[0]?.usage.reasoning_output.status_counts.unmeasurable).toBe(1);
  expect(report.tasks[0]?.usage.partial_tokens).toBe(0);
});

test('component-only observations have their own partial distributions and task denominators', () => {
  const data = input();
  const first = data.assignments[0]!;
  first.usages = [usage('input-only', assigned, 7)];
  first.usages[0]!.payload.output_total = missing;
  const second: typeof first = {
    ...first,
    assignment_id: 'assignment-2',
    task_id: 'task-2',
    variant_id: 'variant-b',
    usages: [usage('output-only', assigned, 0)]
  };
  second.usages[0]!.payload.input_total = missing;
  second.usages[0]!.payload.output_total = observed(3);
  data.assignments.push(second);
  const report = projectComparison(data);
  expect(report.total.usage.partial_tokens).toEqual({ task_denominator: 0, distribution: [], mean: null, median: null });
  expect(report.total.usage.partial_input_total).toEqual({ task_denominator: 1, distribution: [7], mean: 7, median: 7 });
  expect(report.total.usage.partial_output_total).toEqual({ task_denominator: 1, distribution: [3], mean: 3, median: 3 });
  expect(report.total.assigned_tasks).toBe(2);
});
