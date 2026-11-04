import { expect, test } from 'vitest';
import { FlexibleProtocolSchema, FlexibleProtocolDraftSchema } from '../src/flexible-contracts.js';
import { ProtocolSchema } from '../src/comparison-contracts.js';
import { FlexibleSharedProtocolSchema } from '../src/comparison/exchange/contracts.js';
import { evaluateReadiness } from '../src/readiness.js';
import { registerProtocol, showProtocol } from '../src/comparison.js';
import { createCodexWorkflowAdapter, pinnedCodexWorkflowBinarySha } from '../src/codex-workflow-adapter.js';
import { stopCodexWorkflow } from '../src/codex-workflow-journal.js';
import { beginAssignedWorkflow, runAssignedWorkflow, finishAssignedWorkflow } from '../src/task-workflow.js';
import { createComparisonSnapshot, readComparisonSnapshot } from '../src/comparison/reports/comparison-snapshot.js';
import { FlexibleComparisonReportSchema, FlexibleSnapshotInputSchema, projectFlexibleComparison } from '../src/comparison/reports/flexible-comparison.js';
import { renderComparisonReport } from '../src/comparison/reports/comparison-render.js';
import { makeFlexibleFixture } from './helpers/flexible-fixture.js';
import { codexWorkflowFixture } from './helpers/codex-workflow-fixture.js';
import { protocol as legacy } from './helpers/comparison-fixture.js';

const profile = { product: 'codex' as const, product_version: '0.160.0', profile_id: 'codex-workflow-own-response-v1' };
const stats = ['minimum_effect', 'quality_margin', 'confidence_level'] as const;
function pilot() {
  const { minimum_effect, quality_margin, confidence_level, ...rest } = makeFlexibleFixture().protocol;
  void minimum_effect;
  void quality_margin;
  void confidence_level;
  return { ...rest, purpose: 'functional_pilot' as const, source_profiles: [profile] };
}
test('functional purpose omits effect inputs, forbids supplied values, and still requires operational settings', () => {
  expect(FlexibleProtocolSchema.parse(pilot())).toEqual(pilot());
  for (const key of stats) {
    const supplied = { ...pilot(), [key]: makeFlexibleFixture().protocol[key] };
    expect(FlexibleProtocolSchema.safeParse(supplied).success).toBe(false);
    expect(FlexibleProtocolDraftSchema.safeParse(supplied).success).toBe(false);
  }
  for (const key of ['followup_seconds', 'recruitment_start', 'missingness_policy'] as const) {
    const incomplete = { ...pilot() };
    delete (incomplete as Record<string, unknown>)[key];
    expect(FlexibleProtocolSchema.safeParse(incomplete).success).toBe(false);
    expect(FlexibleProtocolDraftSchema.safeParse(incomplete).success).toBe(true);
  }
});
test('existing purposes and v1 keep effect validation and serialized protocol identity; exchange excludes pilot', () => {
  const f = makeFlexibleFixture();
  expect(JSON.stringify(FlexibleProtocolSchema.parse(f.protocol))).toBe(JSON.stringify(f.protocol));
  expect(JSON.stringify(ProtocolSchema.parse(legacy))).toBe(JSON.stringify(legacy));
  for (const purpose of ['synthetic_validation', 'real_experiment'] as const)
    for (const key of stats) {
      const input: Record<string, unknown> = { ...f.protocol, purpose };
      delete input[key];
      expect(FlexibleProtocolSchema.safeParse(input).success).toBe(false);
    }
  expect(ProtocolSchema.safeParse({ ...legacy, purpose: 'functional_pilot' }).success).toBe(false);
  const { project_id, ...shared } = pilot();
  void project_id;
  expect(FlexibleSharedProtocolSchema.safeParse({ ...shared, shared_project_id: '00000000-0000-4000-8000-000000000001' }).success).toBe(false);
});
test('functional allocation uses exact production source gates and never qualifies inference', () => {
  const input = {
    protocol: FlexibleProtocolSchema.parse(pilot()),
    source_evidence_ids: ['codex-workflow-01600-root-native-v1'],
    coverage: [],
    analysis_evidence_id: null,
    invalidated: false,
    followup_complete: true
  };
  expect(evaluateReadiness(input)).toMatchObject({ real_allocation: true, complete_cost: false, inference: false });
  expect(evaluateReadiness(input).reasons).toContain('functional_pilot_only');
  for (const source of [
    { ...profile, product_version: '0.160.1' },
    { ...profile, product: 'claude_code' as const, product_version: '2.1.288' }
  ]) {
    expect(evaluateReadiness({ ...input, protocol: { ...input.protocol, source_profiles: [source] } })).toMatchObject({
      real_allocation: false,
      complete_cost: false,
      inference: false
    });
  }
  expect(evaluateReadiness({ ...input, invalidated: true }).real_allocation).toBe(false);
});
test('functional freeze, sticky assignment, linked collection, stop/replay and human report reuse ordinary workflow offline', async () => {
  const f = codexWorkflowFixture(profile.profile_id, 'functional_pilot');
  try {
    expect(showProtocol(f.store, 'comparison-1')).toMatchObject({ status: 'frozen', real_allocation_enabled: true });
    const first = beginAssignedWorkflow(f.store, f.input, { model: 'developer-model', effort: 'high' });
    const again = beginAssignedWorkflow(f.store, { ...f.input, confirmation_id: 'again' }, { model: 'other-model', effort: 'low' });
    expect(again.receipt.assigned_variant_id).toBe(first.receipt.assigned_variant_id);
    expect(again.receipt.reused).toBe(true);
    const source = f.newRoot();
    // Link/collect read only synthetic local rows; the pinned declaration never launches this Node binary.
    const execution = (id: string, operation: 'link' | 'collect') => {
      const value = f.execution(id, operation, source.id, operation === 'link' ? source.path : undefined);
      value.binary.sha256 = pinnedCodexWorkflowBinarySha;
      return value;
    };
    const linked = await runAssignedWorkflow(f.store, { ...f.input, confirmation_id: 'link' }, createCodexWorkflowAdapter(f.store, execution('link', 'link')), {
      model: null,
      effort: null
    });
    expect(linked.adapter_result).toMatchObject({ state: 'completed', observed_requests: 0 });
    const collect = async (id: string, append: boolean) => {
      const running = runAssignedWorkflow(f.store, { ...f.input, confirmation_id: id }, createCodexWorkflowAdapter(f.store, execution(id, 'collect')), {
        model: null,
        effort: null
      });
      const deadline = Date.now() + 2000;
      while (!f.store.get('SELECT 1 FROM codex_workflow_runs WHERE id=? AND identity_verified=1', [id]) && Date.now() < deadline)
        await new Promise(ok => setTimeout(ok, 10));
      expect(f.store.get('SELECT 1 FROM codex_workflow_runs WHERE id=? AND identity_verified=1', [id])).toBeDefined();
      if (append) {
        f.appendUsage(source);
        while (f.store.eventCount() === 0 && Date.now() < deadline) await new Promise(ok => setTimeout(ok, 10));
      }
      stopCodexWorkflow(f.store, id);
      return running;
    };
    expect((await collect('collect', true)).adapter_result).toMatchObject({ state: 'stopped', observed_requests: 1 });
    expect((await collect('replay', false)).adapter_result).toMatchObject({ state: 'stopped', observed_requests: 0 });
    expect(f.store.eventCount()).toBe(1);
    expect(f.store.all('SELECT id FROM runtime_evidence')).toHaveLength(1);
    finishAssignedWorkflow(f.store, 'task-1', 'success', ['criterion-1']);
    const cutoff = new Date(Date.now() + 10).toISOString();
    const report = createComparisonSnapshot(
      f.store,
      { reportId: 'functional-report', protocolId: 'comparison-1', cutoff, revisionReason: 'initial' },
      () => cutoff
    );
    expect(report).toMatchObject({
      purpose: 'functional_pilot',
      evaluation_status: 'functional_only',
      relative_change: null,
      adoption: { status: 'not_applicable' }
    });
    expect(readComparisonSnapshot(f.store, 'functional-report')).toEqual(report);
    expect(() => registerProtocol(f.store, { ...makeFlexibleFixture().protocol, purpose: 'real_experiment' })).toThrow('protocol_conflict');
  } finally {
    f.cleanup();
  }
});
test('unqualified functional sources are rejected before artifacts, assignment or adapter execution', () => {
  const f = codexWorkflowFixture('unsupported-profile', 'functional_pilot');
  try {
    expect(() => beginAssignedWorkflow(f.store, f.input, { model: null, effort: null })).toThrow('real_experiment_disabled');
    expect(f.store.all('SELECT id FROM comparison_assignments')).toHaveLength(0);
    expect(f.store.all('SELECT id FROM sessions')).toHaveLength(0);
  } finally {
    f.cleanup();
  }
});
test('even complete functional facts cannot produce primary means, relative improvement or adoption; old reports remain unchanged', () => {
  const f = makeFlexibleFixture();
  const cutoff = '2026-01-01T02:00:00Z';
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
    assignments: [
      assignment,
      {
        ...assignment,
        assignment_id: 'assignment-2',
        task_id: 'task-2',
        variant_id: 'variant-b',
        coverage: { ...f.coverage, task_id: 'task-2' },
        usages: f.events.map(event => ({ event: { ...event, task_id: 'task-2' }, recorded_at: event.occurred_at })),
        runtime: f.runtime.map(r => ({ ...r, task_id: 'task-2' }))
      }
    ],
    registrations: [],
    price_table: f.priceTable,
    formula_version: 'decimal160-disjoint-v1'
  });
  const old = projectFlexibleComparison(input);
  expect(old.relative_change).toBe('0');
  expect(old.arms[0]!.complete_mean).toBe('0.26');
  expect(old).not.toHaveProperty('purpose');
  expect(old).not.toHaveProperty('evaluation_status');
  expect(JSON.stringify(FlexibleComparisonReportSchema.parse(old))).toBe(JSON.stringify(old));
  const report = projectFlexibleComparison({ ...input, protocol: FlexibleProtocolSchema.parse(pilot()) });
  expect(report.tasks.map(t => t.cost.complete_amount)).toEqual(['0.26', '0.26']);
  expect(report.arms.map(a => a.partial_mean)).toEqual(['0.26', '0.26']);
  expect(report.arms.map(a => a.complete_mean)).toEqual([null, null]);
  expect(report).toMatchObject({
    purpose: 'functional_pilot',
    evaluation_status: 'functional_only',
    relative_change: null,
    adoption: { status: 'not_applicable' }
  });
  expect(report.adoption.reasons).toContain('functional_pilot_only');
  expect(renderComparisonReport(report, 'markdown-readable')).toContain('Functional checks only');
  expect(FlexibleComparisonReportSchema.safeParse({ ...report, relative_change: '-0.5' }).success).toBe(false);
  expect(FlexibleComparisonReportSchema.safeParse({ ...old, adoption: { status: 'not_applicable', reasons: ['functional_pilot_only'] } }).success).toBe(false);
});
