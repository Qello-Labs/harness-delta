import { afterEach, expect, test } from 'vitest';
import { aggregateTask, aggregateTaskReportV2 } from '../../src/pricing/metrics.js';
import { aggregateOrdinaryTaskReportV2 } from '../../src/comparison/reports/ordinary-task.js';
import { aggregateOrdinaryWindowMetrics as aggregateOrdinaryWindowReport } from '../../src/pricing/metrics-ordinary-window.js';
import { captureOrdinaryWindowCostInput } from '../../src/pricing/observed-cost-report.js';
import { freezePeriod, periodReport } from '../../src/comparison/reports/period.js';
import { emptyOrdinaryWindowCoverage } from '../../src/core/ordinary-window-policy.js';
import { readOrdinaryWindowBindingReport } from '../../src/ordinary-session-binding.js';
import { windowReportCutoff, windowReportFixture } from '../helpers/ordinary-window-report-fixture.js';

const fixtures: ReturnType<typeof windowReportFixture>[] = [];
const fixture = () => {
  const f = windowReportFixture();
  fixtures.push(f);
  return f;
};
afterEach(() => {
  for (const f of fixtures.splice(0)) f.store.close();
});

test.each(['eventless', 'unverified_zero', 'invalidated'] as const)('versioned task and binding reads preserve %s partitions without writes', state => {
  const f = fixture();
  f.life.start(f.taskId);
  if (state !== 'eventless') f.put('reference', state === 'invalidated' ? 'invalidated' : 'compatibility_unverified', { zero: true });
  const before = f.reportSnapshot();
  const report = aggregateOrdinaryWindowReport(f.store, f.taskId, windowReportCutoff);
  expect(aggregateTaskReportV2(f.store, f.taskId, windowReportCutoff)).toEqual(report);
  expect(aggregateOrdinaryTaskReportV2(f.store, f.taskId, windowReportCutoff)).toEqual(report);
  expect(readOrdinaryWindowBindingReport(f.store, f.taskId, windowReportCutoff)).toEqual(report);
  expect(report).toMatchObject({
    inference: false,
    inference_refusal: 'ordinary_window_descriptive_only',
    exchange: { supported: false, reason: 'native_window_exchange_unsupported' },
    usage: { verified: { partial_tokens: null }, invalidated: { partial_tokens: null } },
    cost: { verified: { partial_amount: null } }
  });
  expect(() => aggregateTask(f.store, f.taskId, windowReportCutoff)).toThrow('unsupported_report_mode');
  expect(f.calls).toEqual([]);
  expect(f.reportSnapshot()).toEqual(before);
});

test.each(['paused', 'revoked', 'finalized'] as const)('saved evidence remains readable after %s', state => {
  const f = fixture();
  f.life.start(f.taskId);
  f.put('reference', 'compatibility_unverified');
  if (state === 'paused') f.life.pause(f.taskId);
  if (state === 'revoked') f.store.execute('UPDATE ordinary_tasks SET revoked_at=? WHERE task_id=?', [f.clock(), f.taskId]);
  if (state === 'finalized') f.life.finalize(f.taskId, 'success', ['accepted']);
  const before = f.reportSnapshot();
  expect(aggregateTaskReportV2(f.store, f.taskId, windowReportCutoff)).toMatchObject({
    task_state: state === 'revoked' ? 'active' : state,
    usage: { verified: { partial_tokens: null } },
    collection: { state: 'disabled' }
  });
  expect(f.reportSnapshot()).toEqual(before);
});

test.each(['orphan', 'mismatch'] as const)('cost capture and versioned task reads reject %s preparation without reconstruction', state => {
  const f = fixture();
  if (state === 'orphan') f.store.execute('DELETE FROM ordinary_window_selections WHERE task_id=?', [f.taskId]);
  else f.store.execute("UPDATE ordinary_tasks SET settings_hash='mismatched' WHERE task_id=?", [f.taskId]);
  const before = f.reportSnapshot();
  const reason = state === 'orphan' ? 'ordinary_preparation_required' : 'ordinary_configuration_changed';
  expect(() => captureOrdinaryWindowCostInput(f.store, f.taskId, windowReportCutoff)).toThrow(reason);
  expect(() => aggregateTaskReportV2(f.store, f.taskId, windowReportCutoff)).toThrow(reason);
  expect(f.reportSnapshot()).toEqual(before);
});

test.each([false, true])('period coverage remains independent of task-start model and later usage (%s)', usage => {
  const f = fixture();
  freezePeriod(
    f.store,
    {
      schema_version: 1,
      id: 'period',
      project_id: 'project',
      classification_version: 1,
      before: { start: '2026-11-06T00:00:00Z', end: '2026-11-07T00:00:00Z' },
      after: { start: '2026-11-08T00:00:00Z', end: '2026-11-09T00:00:00Z' },
      followup_hours: 24,
      types: ['feature'],
      sizes: ['medium'],
      assignees: ['local-user'],
      products: ['codex'],
      models: ['gpt-6.1-sol']
    },
    '2026-11-05T00:00:00Z'
  );
  f.life.start(f.taskId);
  if (usage) f.put('reference', 'compatibility_unverified');
  const before = f.reportSnapshot();
  const report = periodReport(f.store, 'period', windowReportCutoff);
  expect(report).toMatchObject({
    schema_version: 2,
    analysis_version: 'ordinary-window-period-v1',
    inference: false,
    before: { eligible_count: 0, mean_partial_tokens: null },
    after: { eligible_count: 0 },
    ordinary_window_references: [
      {
        task_id: f.taskId,
        cohort: 'before',
        initial_model: null,
        cohort_eligible: false,
        model_classification: 'unknown_task_start_model',
        exclusion_reason: 'unknown_task_start_model',
        report: { selection: { declared_version: '0.167.0' }, coverage_as_of: 'current_store', usage: { event_count: usage ? 1 : 0 } }
      }
    ]
  });
  expect(f.reportSnapshot()).toEqual(before);
});

test.each(['codex', 'claude_code'] as const)('all saved %s segments retain eventless child coverage independently of pricing', product => {
  const f = windowReportFixture(product);
  fixtures.push(f);
  f.activate();
  f.connect();
  f.store.execute('INSERT INTO sessions(id,project_id,task_id,product,product_version) VALUES (?,?,?,?,?)', [
    'second-root',
    'project',
    f.taskId,
    product,
    f.selection.declaredVersion
  ]);
  f.store.execute(
    `INSERT INTO binding_root_segments(root_session_id,task_id,product,native_root_id,project_root,state,opened_at,closed_at)
    VALUES (?,?,?,?,?,'closed',?,?)`,
    ['second-root', f.taskId, product, 'second-native', f.identity.cwd, f.clock(), f.clock()]
  );
  const coverage = {
    ...emptyOrdinaryWindowCoverage(),
    status: 'partial',
    detectedChildren: [{ identity: 'child', firstSeenAt: f.clock(), basis: 'scoped_directory_metadata', parentRelation: 'unverified', usage: null, cost: null }]
  };
  f.store.execute(
    `INSERT INTO ordinary_window_segments(root_session_id,selection_hash,proof,coverage)
    SELECT ?,selection_hash,?,? FROM ordinary_window_selections WHERE task_id=?`,
    ['second-root', JSON.stringify({ ...f.proof, nativeSessionId: 'second-native' }), JSON.stringify(coverage), f.taskId]
  );
  const before = f.reportSnapshot();
  const report = aggregateTaskReportV2(f.store, f.taskId, windowReportCutoff);
  expect(report).toMatchObject({
    coverage_as_of: 'current_store',
    coverage: {
      segments: [
        { root_session_id: f.rootId },
        {
          root_session_id: 'second-root',
          state: 'closed',
          coverage: { detectionCompleteness: 'unknown', detectedChildren: [{ identity: 'child', usage: null, cost: null }] }
        }
      ]
    },
    usage: { event_count: 0 },
    cost: { verified: { partial_amount: null } }
  });
  expect(report).toHaveProperty(
    'limitations',
    expect.arrayContaining(
      product === 'codex'
        ? ['version_is_root_creation_header_not_writer', 'executable_publisher_and_process_proof_unavailable']
        : ['disk_identity_does_not_prove_mapped_image']
    )
  );
  expect(f.reportSnapshot()).toEqual(before);
});
