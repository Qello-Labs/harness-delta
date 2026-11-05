import { expect, test } from 'vitest';
import { Store } from '../../src/store.js';
import { assignTask } from '../../src/comparison/allocation.js';
import { createComparisonSnapshot, readComparisonSnapshot } from '../../src/comparison/reports/comparison-snapshot.js';
import { Deletion } from '../../src/deletion.js';
import { seedFlexibleComparison } from '../helpers/flexible-store.js';
import { makeFlexibleFixture } from '../helpers/flexible-fixture.js';
const cutoff = '2026-01-01T02:00:00Z';
test('all_assignments_remain_in_denominator', () => {
  const store = new Store(':memory:');
  try {
    const f = seedFlexibleComparison(store);
    for (let n = 0; n < 5; n++)
      assignTask(store, { ...f.input, task_id: `task-${n}`, logical_task_id: `logical-${n}` }, { clock: () => f.protocol.recruitment_start, shuffle: x => x });
    const report = createComparisonSnapshot(store, { reportId: 'r1', protocolId: f.protocol.id, cutoff, revisionReason: 'initial' }, () => cutoff);
    expect(report.schema_version).toBe(2);
    if (report.schema_version !== 2) throw new Error('expected_flexible_report');
    expect(report.tasks).toHaveLength(5);
    expect(report.arms.reduce((sum, arm) => sum + arm.assigned_count, 0)).toBe(5);
  } finally {
    store.close();
  }
});
test('deletion_invalidates_cost_snapshot', () => {
  const store = new Store(':memory:');
  try {
    const f = seedFlexibleComparison(store);
    assignTask(store, f.input, { clock: () => f.protocol.recruitment_start, shuffle: x => x });
    createComparisonSnapshot(store, { reportId: 'r1', protocolId: f.protocol.id, cutoff, revisionReason: 'initial' }, () => cutoff);
    new Deletion(store).deleteTask('task-1');
    expect(readComparisonSnapshot(store, 'r1').validity_status).toBe('invalidated');
    expect(store.all('SELECT * FROM flexible_report_snapshots')).toEqual([]);
  } finally {
    store.close();
  }
});
test('partial_mean_is_not_primary_and_deadline_is_half_open', async () => {
  const { projectFlexibleComparison, FlexibleSnapshotInputSchema } = await import('../../src/comparison/reports/flexible-comparison.js');
  const f = makeFlexibleFixture();
  const assignment = {
    assignment_id: 'assignment-1',
    task_id: 'task-1',
    variant_id: 'variant-a',
    assigned_at: f.coverage.window_start,
    recorded_at: f.coverage.window_start,
    followup_ends_at: f.coverage.window_end,
    stratum_id: 'stratum-user-1',
    block_id: 'block-1',
    metadata: f.metadata,
    environment_id: 'environment-1',
    started_at: f.coverage.window_start,
    first_completed_at: null,
    first_assessed_at: null,
    first_success: null,
    finalized_at: null,
    outcome: null,
    rework_starts: [],
    active_intervals: [],
    observations: [],
    confirmations: [],
    deviations: [],
    usages: f.events.map(event => ({ event, recorded_at: event.occurred_at })),
    runtime: f.runtime,
    gaps: [],
    coverage: f.coverage
  };
  const input = FlexibleSnapshotInputSchema.parse({
    schema_version: 2,
    descriptive_version: 'flexible-cost-descriptive-1',
    report_id: 'r1',
    protocol: f.protocol,
    variants: f.variants,
    cutoff,
    evaluated_at: cutoff,
    data_revision: 1,
    snapshot_sequence: 1,
    revision_reason: 'initial',
    supersedes_report_id: null,
    assignments: [assignment],
    registrations: [],
    price_table: f.priceTable,
    formula_version: 'decimal160-disjoint-v1'
  });
  const complete = projectFlexibleComparison(input);
  expect(complete.tasks[0]!.cost.complete_amount).toBe('0.26');
  const partial = projectFlexibleComparison({
    ...input,
    assignments: [{ ...assignment, coverage: { ...f.coverage, facts: { ...f.coverage.facts, continuous_observation: 'unknown' } } }]
  });
  expect(partial.arms[0]!.complete_mean).toBeNull();
  expect(partial.arms[0]!.partial_mean).toBe('0.26');
  expect(partial.relative_change).toBeNull();
  const deadline = projectFlexibleComparison({
    ...input,
    assignments: [{ ...assignment, usages: [{ event: { ...f.events[0]!, occurred_at: f.coverage.window_end }, recorded_at: f.coverage.window_end }] }]
  });
  expect(deadline.tasks[0]!.cost.partial_amount).toBeNull();
});

test('late_arrival_new_revision_and_v2_task_report_dispatch', async () => {
  const { aggregateFlexibleTaskReport } = await import('../../src/comparison/reports/flexible-comparison.js');
  const { putUsageWithEvidence } = await import('../../src/runtime-history.js');
  const { aggregateTask } = await import('../../src/metrics.js');
  let receipt = '2026-01-01T03:00:00Z';
  const store = new Store(':memory:', () => receipt);
  try {
    const f = seedFlexibleComparison(store);
    assignTask(store, f.input, { clock: () => f.protocol.recruitment_start, shuffle: x => x });
    store.execute("UPDATE tasks SET state='active',started_at=? WHERE id='task-1'", [f.protocol.recruitment_start]);
    store.execute("INSERT INTO sessions(id,task_id,project_id,product,product_version) VALUES ('session-1','task-1','project-1','synthetic','1.0.0')", []);
    const first = createComparisonSnapshot(store, { reportId: 'r1', protocolId: f.protocol.id, cutoff, revisionReason: 'initial' }, () => cutoff);
    putUsageWithEvidence(store, f.events[0]!, f.runtime[0]!);
    expect(readComparisonSnapshot(store, 'r1')).toEqual(first);
    receipt = '2026-01-01T04:00:00Z';
    const next = createComparisonSnapshot(
      store,
      { reportId: 'r2', protocolId: f.protocol.id, cutoff, revisionReason: 'late_arrival', supersedesReportId: 'r1' },
      () => receipt
    );
    if (next.schema_version !== 2) throw new Error('expected_flexible_report');
    expect(next.tasks[0]!.cost.partial_amount).toBe('0.26');
    expect(next.tasks[0]!.cost.complete_amount).toBeNull();
    expect(next.snapshot_hash).not.toBe(first.snapshot_hash);
    expect(aggregateFlexibleTaskReport(store, 'task-1', cutoff).cost.partial_amount).toBe('0.26');
    expect(() => aggregateTask(store, 'task-1', cutoff)).toThrow('unsupported_report_mode');
  } finally {
    store.close();
  }
});
test('success_failure_abort_and_missing_keep_original_arms', () => {
  const store = new Store(':memory:');
  try {
    const f = seedFlexibleComparison(store);
    for (let n = 0; n < 5; n++) {
      const taskId = `task-${n}`;
      assignTask(store, { ...f.input, task_id: taskId, logical_task_id: `logical-${n}` }, { clock: () => f.protocol.recruitment_start, shuffle: x => x });
      if (n !== 3) store.execute('UPDATE tasks SET started_at=? WHERE id=?', [f.protocol.recruitment_start, taskId]);
      if (n < 3)
        store.execute('INSERT INTO outcomes(task_id,status,criteria_met,first_success,assessed_at) VALUES (?,?,?,?,?)', [
          taskId,
          ['success', 'failed', 'aborted'][n],
          n === 0 ? '["criterion-1"]' : '[]',
          null,
          '2026-01-01T00:20:00Z'
        ]);
    }
    const report = createComparisonSnapshot(store, { reportId: 'r1', protocolId: f.protocol.id, cutoff, revisionReason: 'initial' }, () => cutoff);
    if (report.schema_version !== 2) throw new Error('expected_flexible_report');
    expect(report.tasks.map(t => t.deadline_status)).toEqual(['success', 'failed', 'aborted', 'not_started', 'outcome_missing']);
    expect(report.arms.reduce((sum, a) => sum + a.assigned_count, 0)).toBe(5);
    expect(report.adoption.status).toBe('inconclusive');
  } finally {
    store.close();
  }
});

test('period_v2_is_explicitly_unsupported', async () => {
  const { freezePeriod, periodReport } = await import('../../src/comparison/reports/period.js');
  const store = new Store(':memory:');
  try {
    const f = seedFlexibleComparison(store);
    assignTask(store, f.input, { clock: () => f.protocol.recruitment_start, shuffle: x => x });
    store.execute('UPDATE tasks SET started_at=? WHERE id=?', [f.protocol.recruitment_start, 'task-1']);
    freezePeriod(
      store,
      {
        schema_version: 1,
        id: 'period-1',
        project_id: 'project-1',
        classification_version: 1,
        before: { start: '2026-01-01T00:00:00Z', end: '2026-01-02T00:00:00Z' },
        after: { start: '2026-01-02T00:00:00Z', end: '2026-01-03T00:00:00Z' },
        followup_hours: 1,
        types: ['feature'],
        sizes: ['small'],
        assignees: ['user-1'],
        products: ['synthetic'],
        models: ['synthetic-model']
      },
      '2025-12-31T00:00:00Z'
    );
    expect(() => periodReport(store, 'period-1', cutoff)).toThrow('unsupported_report_mode');
  } finally {
    store.close();
  }
});

test('late_start_does_not_rewrite_historical_not_started_state', () => {
  const store = new Store(':memory:');
  try {
    const f = seedFlexibleComparison(store);
    assignTask(store, f.input, { clock: () => f.protocol.recruitment_start, shuffle: x => x });
    store.execute('UPDATE tasks SET started_at=? WHERE id=?', ['2026-01-01T04:00:00Z', 'task-1']);
    const report = createComparisonSnapshot(store, { reportId: 'r1', protocolId: f.protocol.id, cutoff, revisionReason: 'initial' }, () => cutoff);
    if (report.schema_version !== 2) throw new Error('expected_flexible_report');
    expect(report.tasks[0]!.deadline_status).toBe('not_started');
    expect(report.tasks[0]!.time.elapsed_ms).toBeNull();
  } finally {
    store.close();
  }
});
test('report_id_namespace_is_unique_across_both_version_tables', async () => {
  const { registerVariant, registerProtocol, freezeProtocol } = await import('../../src/comparison.js');
  const legacy = await import('../helpers/comparison-fixture.js');
  const store = new Store(':memory:');
  try {
    const f = seedFlexibleComparison(store);
    assignTask(store, f.input, { clock: () => f.protocol.recruitment_start });
    const variants = [
      { ...legacy.variantA, id: 'legacy-a' },
      { ...legacy.variantB, id: 'legacy-b' }
    ];
    variants.forEach(v => registerVariant(store, v));
    registerProtocol(store, { ...legacy.protocol, id: 'legacy', variant_ids: variants.map(v => v.id) });
    freezeProtocol(store, 'legacy', legacy.beforeRecruitment);
    const original = createComparisonSnapshot(store, { reportId: 'shared', protocolId: f.protocol.id, cutoff, revisionReason: 'initial' }, () => cutoff);
    expect(() => createComparisonSnapshot(store, { reportId: 'shared', protocolId: 'legacy', cutoff, revisionReason: 'initial' }, () => cutoff)).toThrow(
      'report_conflict'
    );
    expect(readComparisonSnapshot(store, 'shared')).toEqual(original);
    const old = createComparisonSnapshot(store, { reportId: 'legacy-first', protocolId: 'legacy', cutoff, revisionReason: 'initial' }, () => cutoff);
    expect(() =>
      createComparisonSnapshot(store, { reportId: 'legacy-first', protocolId: f.protocol.id, cutoff, revisionReason: 'initial' }, () => cutoff)
    ).toThrow('report_conflict');
    expect(readComparisonSnapshot(store, 'legacy-first')).toEqual(old);
  } finally {
    store.close();
  }
});
test('delayed_start_does_not_erase_assignment_window_gaps_or_reject_full_coverage', async () => {
  const { projectFlexibleComparison, FlexibleSnapshotInputSchema } = await import('../../src/comparison/reports/flexible-comparison.js');
  const f = makeFlexibleFixture();
  const assignment = {
    assignment_id: 'a1',
    task_id: 'task-1',
    variant_id: 'variant-a',
    assigned_at: f.coverage.window_start,
    recorded_at: f.coverage.window_start,
    followup_ends_at: f.coverage.window_end,
    stratum_id: 'stratum-user-1',
    block_id: 'b1',
    metadata: f.metadata,
    environment_id: 'environment-1',
    started_at: '2026-01-01T00:30:00Z',
    first_completed_at: null,
    first_assessed_at: null,
    first_success: null,
    finalized_at: null,
    outcome: null,
    rework_starts: [],
    active_intervals: [],
    observations: [],
    confirmations: [],
    deviations: [],
    usages: [{ event: { ...f.events[0]!, occurred_at: '2026-01-01T00:31:03Z' }, recorded_at: '2026-01-01T00:31:04Z' }],
    runtime: [{ ...f.runtime[0]!, occurred_at: '2026-01-01T00:31:01Z', recorded_at: '2026-01-01T00:31:02Z' }],
    gaps: [{ started_at: '2026-01-01T00:10:00Z', ended_at: '2026-01-01T00:20:00Z', recorded_at: '2026-01-01T00:20:01Z', reason: 'offline' }],
    coverage: f.coverage
  };
  const input = FlexibleSnapshotInputSchema.parse({
    schema_version: 2,
    descriptive_version: 'flexible-cost-descriptive-1',
    report_id: 'r1',
    protocol: f.protocol,
    variants: f.variants,
    cutoff,
    evaluated_at: cutoff,
    data_revision: 1,
    snapshot_sequence: 1,
    revision_reason: 'initial',
    supersedes_report_id: null,
    assignments: [assignment],
    registrations: [],
    price_table: f.priceTable,
    formula_version: 'decimal160-disjoint-v1'
  });
  const report = projectFlexibleComparison(input);
  expect(report.tasks[0]!.cost).toMatchObject({ complete_amount: null, partial_amount: '0.26', usage_complete: false });
  expect(report.tasks[0]!.cost.reasons).toContain('continuous_observation');
  expect(report.tasks[0]!.time.elapsed_ms).toBe(30 * 60000);
  expect(() =>
    projectFlexibleComparison({ ...input, assignments: [{ ...input.assignments[0]!, coverage: { ...f.coverage, window_start: '2026-01-01T00:30:00Z' } }] })
  ).toThrow('coverage_window_mismatch');
});
