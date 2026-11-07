import { afterEach, expect, test } from 'vitest';
import { aggregateOrdinaryWindowReport } from '../../src/comparison/reports/ordinary-window.js';
import { readOrdinaryWindowStatus } from '../../src/comparison/reports/ordinary-window-state.js';
import { aggregateOrdinaryTaskReport } from '../../src/comparison/reports/ordinary-task.js';
import { readObservedCostReport } from '../../src/pricing/observed-cost-report.js';
import { emptyOrdinaryWindowCoverage } from '../../src/core/ordinary-window-policy.js';
import { Deletion } from '../../src/deletion.js';
import { Lifecycle } from '../../src/core/lifecycle.js';
import { recordObservationGap } from '../../src/core/runtime-history.js';
import { readOrdinaryWindowBatch } from '../../src/ordinary-window-binding.js';
import { windowReportCutoff, windowReportFixture } from '../helpers/ordinary-window-report-fixture.js';

const fixtures: ReturnType<typeof windowReportFixture>[] = [];
function fixture(product: 'codex' | 'claude_code' = 'codex') {
  const f = windowReportFixture(product);
  fixtures.push(f);
  return f;
}
afterEach(() => {
  for (const f of fixtures.splice(0)) f.store.close();
});

test.each(['codex', 'claude_code'] as const)('reports eventless %s selection without granting collection authority', product => {
  const f = fixture(product);
  f.life.start(f.taskId);
  const before = f.snapshot();
  const report = aggregateOrdinaryWindowReport(f.store, f.taskId, windowReportCutoff);
  expect(report).toMatchObject({
    schema_version: 3,
    report_version: 'ordinary-window-task-v1',
    inference: false,
    automatic_children: false,
    selection: { declared_version: f.selection.declaredVersion, policy: { evidenceMode: f.selection.policy.evidenceMode, maxDepth: 0, maxMembers: 1 } },
    collection: { state: 'disabled', reason: 'binding_window_activation_required' },
    coverage_as_of: 'current_store',
    coverage: { status: 'missing', rootOwnership: 'unverified', possibleChildContribution: 'unknown', detectionCompleteness: 'unknown', segments: [] },
    usage: { event_count: 0, verified: { partial_tokens: null }, compatibility_unverified: { partial_tokens: null }, invalidated: { partial_tokens: null } },
    cost: { verified: { partial_amount: null }, compatibility_unverified: { partial_amount: null }, complete_amount: null },
    denominators: { tokens_per_success: null, cost_per_success: null }
  });
  expect(f.calls).toEqual([]);
  expect(f.snapshot()).toEqual(before);
  expect(f.store.all('SELECT * FROM ordinary_window_activations')).toEqual([]);
  expect(JSON.stringify(report)).not.toContain('/synthetic/');
});

test('keeps token and priced amounts in four trust partitions without summing cached or reasoning subsets twice', () => {
  const f = fixture();
  f.life.start(f.taskId);
  for (const state of ['verified', 'compatibility_unverified', 'legacy_unverified', 'invalidated'] as const) f.put(state, state);
  const report = aggregateOrdinaryWindowReport(f.store, f.taskId, windowReportCutoff);
  for (const state of ['verified', 'compatibility_unverified', 'legacy_unverified'] as const) {
    expect(report.usage[state]).toMatchObject({
      event_count: 1,
      partial_tokens: 15,
      input_total: { observed_sum: 10 },
      cached_input: { observed_sum: 2 },
      output_total: { observed_sum: 5 },
      reasoning_output: { observed_sum: 1 },
      complete_tokens: null
    });
    expect(report.cost[state]).toMatchObject({ event_count: 1, partial_amount: '0.00005', complete_amount: null });
  }
  expect(report.usage.invalidated).toMatchObject({ event_count: 1, partial_tokens: null, input_total: { status: 'invalidated', observed_sum: null } });
  expect(report.cost.invalidated).toMatchObject({ event_count: 1, partial_amount: null });
  expect(report.usage.compatibility).toMatchObject({
    verified_events: 1,
    compatibility_unverified_events: 1,
    legacy_unverified_events: 1,
    invalidated_events: 1
  });
  expect(report.usage).not.toHaveProperty('partial_tokens');
  expect(report.cost).not.toHaveProperty('partial_amount');
});

test.each([
  { name: 'observed zero', options: { zero: true }, tokens: 0, amount: '0' },
  { name: 'missing output', options: { missingOutput: true }, tokens: null, amount: null },
  { name: 'unknown price', options: { model: 'synthetic-unpriced-model' }, tokens: 15, amount: null }
])('preserves $name without manufacturing a verified value', ({ options, tokens, amount }) => {
  const f = fixture();
  f.life.start(f.taskId);
  f.put('reference', 'compatibility_unverified', options);
  const report = aggregateOrdinaryWindowReport(f.store, f.taskId, windowReportCutoff);
  expect(report.usage.compatibility_unverified.partial_tokens).toBe(tokens);
  expect(report.cost.compatibility_unverified.partial_amount).toBe(amount);
  expect(report.usage.verified.partial_tokens).toBeNull();
  expect(report.cost.verified.partial_amount).toBeNull();
  expect(report.cost.complete_amount).toBeNull();
});

test('retains eventless child metadata and disk/source evidence separately from enrolled sessions and prices', () => {
  const f = fixture();
  f.activate();
  f.connect();
  f.store.execute('UPDATE ordinary_window_segments SET coverage=? WHERE root_session_id=?', [
    JSON.stringify({
      ...emptyOrdinaryWindowCoverage(),
      status: 'partial',
      detectedChildren: [
        { identity: 'native-child', firstSeenAt: f.clock(), basis: 'root_linked_receipt', parentRelation: 'unverified', usage: null, cost: null }
      ]
    }),
    f.rootId
  ]);
  const report = aggregateOrdinaryWindowReport(f.store, f.taskId, windowReportCutoff);
  expect(report.coverage.segments).toMatchObject([
    {
      root_session_id: f.rootId,
      actual_source_version: '0.167.0',
      source_version_basis: 'root_creation_header',
      publisher_proof: 'unavailable',
      writer_version: 'unverified',
      coverage: { childrenStatus: 'unobserved', detectionCompleteness: 'unknown', detectedChildren: [{ identity: 'native-child', usage: null, cost: null }] }
    }
  ]);
  expect(report.usage.event_count).toBe(0);
  expect(f.store.all('SELECT id FROM sessions')).toEqual([{ id: f.rootId }]);
});

test('projects a real staged window batch and later invalidation without rewriting its stored event', async () => {
  const f = fixture();
  f.activate();
  f.connect();
  await readOrdinaryWindowBatch({ store: f.store, taskId: f.taskId, rootSessionId: f.rootId, baseline: false, clock: f.clock, provider: () => f.provider });
  const stored = f.store.all('SELECT * FROM events');
  expect(aggregateOrdinaryWindowReport(f.store, f.taskId, windowReportCutoff).usage.compatibility_unverified.partial_tokens).toBe(15);
  f.store.execute('INSERT INTO source_compatibility_blocks(product,product_version,source,reason) VALUES (?,?,?,?)', [
    'codex',
    f.selection.declaredVersion,
    'codex_binding',
    'contract_failed'
  ]);
  const report = aggregateOrdinaryWindowReport(f.store, f.taskId, windowReportCutoff);
  expect(report).toMatchObject({
    collection: { reason: 'compatibility_invalidated' },
    coverage: { status: 'invalidated', segments: [{ coverage: { status: 'invalidated', reason: 'compatibility_invalidated' } }] },
    usage: { verified: { partial_tokens: null }, compatibility_unverified: { partial_tokens: null }, invalidated: { event_count: 1, partial_tokens: null } },
    cost: { verified: { partial_amount: null }, compatibility_unverified: { partial_amount: null }, invalidated: { partial_amount: null } }
  });
  expect(f.store.all('SELECT * FROM events')).toEqual(stored);
});

test('uses the existing half-open active/loss intervals and cutoff for both tokens and cost', () => {
  const f = fixture();
  f.life.start(f.taskId);
  f.put('eligible', 'compatibility_unverified');
  f.put('loss', 'compatibility_unverified', { at: '2026-11-06T01:02:00.000Z' });
  f.put('cutoff', 'compatibility_unverified', { at: windowReportCutoff });
  recordObservationGap(f.store, f.taskId, 'loss', '2026-11-06T01:02:00.000Z', '2026-11-06T01:03:00.000Z', 'source_error', f.clock());
  const report = aggregateOrdinaryWindowReport(f.store, f.taskId, windowReportCutoff);
  expect(report.usage.compatibility_unverified).toMatchObject({ event_count: 1, partial_tokens: 15 });
  expect(report.cost).toMatchObject({ excluded_event_count: 1, compatibility_unverified: { event_count: 1, partial_amount: '0.00005' } });
});

test('retains reports after finalization without widening legacy window report routes', () => {
  const f = fixture();
  f.life.start(f.taskId);
  f.put('reference', 'compatibility_unverified');
  new Lifecycle(f.store, () => '2026-11-06T01:05:00.000Z').finalize(f.taskId, 'success', ['accepted']);
  expect(aggregateOrdinaryWindowReport(f.store, f.taskId, windowReportCutoff)).toMatchObject({
    task_state: 'finalized',
    collection: { state: 'disabled', reason: 'binding_scope_revoked' },
    usage: { compatibility_unverified: { partial_tokens: 15 } }
  });
  expect(() => aggregateOrdinaryTaskReport(f.store, f.taskId, windowReportCutoff)).toThrow('binding_scope_revoked');
  expect(() => readObservedCostReport(f.store, f.taskId, f.selection.priceTableId, windowReportCutoff, 'output-only-v1')).toThrow('binding_scope_revoked');
});

test.each(['task', 'project'] as const)('refuses deleted %s evidence without recreating selection or coverage', kind => {
  const f = fixture();
  const deletion = new Deletion(f.store, f.clock);
  if (kind === 'task') deletion.deleteTask(f.taskId);
  else deletion.deleteProject('project');
  const before = f.snapshot();
  expect(() => readOrdinaryWindowStatus(f.store, f.taskId)).toThrow('unknown_task');
  expect(() => aggregateOrdinaryWindowReport(f.store, f.taskId, windowReportCutoff)).toThrow('unknown_task');
  expect(f.snapshot()).toEqual(before);
});
