import { recordRuntimeEvidence } from '../src/runtime-history.js';
import { expect, test } from 'vitest';
import { projectObservedCost } from '../src/observed-cost-report.js';
import { aggregateTaskCost } from '../src/metrics.js';
import { makeFlexibleFixture } from './helpers/flexible-fixture.js';

// Removing the report trust partition would expose these native values as verified totals.
test('legacy native usage without provenance is a separate reference, never silently verified', () => {
  const f = makeFlexibleFixture();
  const event = { ...f.events[0]!, payload: { ...f.events[0]!.payload, product: 'codex' as const, product_version: '0.160.0' } };
  const table = { ...f.priceTable, entries: f.priceTable.entries.map(e => ({ ...e, product: 'codex' as const })) };
  expect(projectObservedCost([event], table, event.task_id, f.coverage.window_end, 'output-only-v1')).toMatchObject({
    partial_amount: null,
    legacy_unverified_partial_amount: '0.26',
    compatibility: { verified_events: 0, legacy_unverified_events: 1 }
  });
  expect(aggregateTaskCost([event], table, f.coverage)).toMatchObject({
    partial_amount: null,
    legacy_unverified_partial_amount: '0.26',
    complete_amount: null
  });
});

import { projectCatalogCost } from '../src/catalog-cost-report.js';
import { bundledPriceCatalog, compilePriceBasis } from '../src/price-catalog.js';
const compatibility = (state: 'verified' | 'compatibility_unverified' | 'invalidated') => ({
  state,
  product: 'codex' as const,
  product_version: state === 'verified' ? '0.160.0' : '0.161.0',
  source: 'codex_workflow' as const,
  parser_version: '0.160.0',
  parser_revision: 'synthetic-parser',
  profile_id: 'synthetic-profile',
  rule_revision: 'synthetic-rule'
});
function nativeEvent(state: 'verified' | 'compatibility_unverified' | 'invalidated', id: string, zero = false) {
  const original = makeFlexibleFixture().events[0]!;
  const read = { status: 'observed' as const, value: 0, reason: null };
  return {
    ...original,
    id,
    source_key: id,
    payload: {
      ...original.payload,
      product: 'codex' as const,
      product_version: compatibility(state).product_version,
      model: 'gpt-6.1-sol',
      source_compatibility: compatibility(state),
      ...(zero
        ? {
            input_total: read,
            cached_input: read,
            output_total: read,
            reasoning_output: read,
            billing_components: original.payload.billing_components.map(c => ({ ...c, reading: read }))
          }
        : {})
    }
  };
}
// Catalog matching must not accidentally recombine separately trusted components.
test('catalog cost separates mixed trust and excludes invalidated estimates', () => {
  const events = [nativeEvent('verified', 'v'), nativeEvent('compatibility_unverified', 'u'), nativeEvent('invalidated', 'i')];
  const report = projectCatalogCost(events, compilePriceBasis(bundledPriceCatalog()), 'task-1', '2026-01-02T00:00:00Z', 'output-only-v1');
  expect(report).toMatchObject({
    partial_amount: '0.000302',
    compatibility_unverified_partial_amount: '0.000302',
    legacy_unverified_partial_amount: null,
    compatibility: { verified_events: 1, compatibility_unverified_events: 1, invalidated_events: 1 },
    complete_amount: null
  });
});
test('an observed unverified zero remains a reference zero, never a verified zero', () => {
  const report = projectCatalogCost(
    [nativeEvent('compatibility_unverified', 'zero', true)],
    compilePriceBasis(bundledPriceCatalog()),
    'task-1',
    '2026-01-02T00:00:00Z',
    'output-only-v1'
  );
  expect(report).toMatchObject({
    partial_amount: null,
    compatibility_unverified_partial_amount: '0',
    compatibility: { verified_events: 0, compatibility_unverified_events: 1 }
  });
});

import { Store } from '../src/store.js';
import { Lifecycle } from '../src/lifecycle.js';
import { aggregateTask } from '../src/metrics.js';
import { freezePeriod, periodReport } from '../src/reports/period.js';
import { invalidateCompatibility, pinSessionCompatibility, resolveSourceCompatibility } from '../src/source-compatibility.js';
import { preparePriceBasis } from '../src/price-catalog-store.js';
import { captureTaskCostSnapshot, createPriceRevaluation, readPriceRevaluation } from '../src/price-revaluation.js';

test('task, period and retained repricing honor later invalidation without rewriting event or snapshot bytes', () => {
  const store = new Store(':memory:');
  const cutoff = '2026-01-02T00:00:00Z';
  const now = '2026-10-06T00:00:00Z';
  try {
    const life = new Lifecycle(store, () => '2026-01-01T00:00:00Z');
    life.registerProject('project-1', process.cwd());
    freezePeriod(
      store,
      {
        schema_version: 1,
        id: 'period',
        project_id: 'project-1',
        classification_version: 1,
        before: { start: '2026-01-01T00:00:00Z', end: cutoff },
        after: { start: cutoff, end: '2026-01-03T00:00:00Z' },
        followup_hours: 24,
        types: ['feature'],
        sizes: ['small'],
        assignees: ['user'],
        products: ['codex'],
        models: ['gpt-6.1-sol']
      },
      '2025-12-31T00:00:00Z'
    );
    life.createTask('project-1', 'task-1', {
      type: 'feature',
      expected_size: 'small',
      assignee: 'user',
      product: 'codex',
      model: 'gpt-6.1-sol',
      criterion_ids: ['c']
    });
    life.start('task-1');
    store.execute("INSERT INTO sessions(id,project_id,task_id,product,product_version) VALUES ('session-1','project-1','task-1','codex','0.161.0')", []);
    const trust = resolveSourceCompatibility('codex', '0.161.0', 'codex_workflow')!;
    pinSessionCompatibility(store, 'session-1', trust);
    recordRuntimeEvidence(store, { ...makeFlexibleFixture().runtime[0]!, product: 'codex', product_version: '0.161.0', model: 'gpt-6.1-sol' });
    store.putEvent({
      ...nativeEvent('compatibility_unverified', 'usage'),
      payload: { ...nativeEvent('compatibility_unverified', 'usage').payload, product_version: trust.product_version, source_compatibility: trust }
    });
    const originalEvent = store.get<{ payload: string }>('SELECT payload FROM events WHERE id=?', ['usage']);
    const task = aggregateTask(store, 'task-1', cutoff);
    expect(task.usage).toMatchObject({
      partial_tokens: null,
      compatibility_unverified: { partial_tokens: 130 },
      compatibility: { compatibility_unverified_events: 1 }
    });
    expect(periodReport(store, 'period', cutoff).before).toMatchObject({ mean_partial_tokens: null, compatibility_unverified: { mean_partial_tokens: 130 } });
    const basis = preparePriceBasis(store, now);
    captureTaskCostSnapshot(store, { inputId: 'frozen', taskId: 'task-1', tableId: basis.table.id, cutoff, inputBasis: 'output-only-v1' }, now);
    const frozenBytes = store.get('SELECT payload,hash FROM price_cost_inputs WHERE id=?', ['frozen']);
    const result = createPriceRevaluation(store, { id: 'priced', inputId: 'frozen', targetTableId: basis.table.id }, now);
    expect(result.tasks[0]!.cost).toMatchObject({ partial_amount: null, compatibility_unverified_partial_amount: '0.000302' });
    const pricedBytes = store.get('SELECT payload FROM price_revaluations WHERE id=?', ['priced']);
    invalidateCompatibility(store, trust, 'semantic_incompatibility');
    expect(aggregateTask(store, 'task-1', cutoff).usage).toMatchObject({
      partial_tokens: null,
      compatibility_unverified: { partial_tokens: null },
      compatibility: { invalidated_events: 1 }
    });
    expect(periodReport(store, 'period', cutoff).before).toMatchObject({
      mean_partial_tokens: null,
      invalidated_events: 1,
      compatibility_unverified: { mean_partial_tokens: null }
    });
    const read = readPriceRevaluation(store, 'priced');
    expect(read).toMatchObject({
      tasks: [{ cost: { partial_amount: null, compatibility_unverified_partial_amount: null, compatibility: { invalidated_events: 1 } } }]
    });
    expect(createPriceRevaluation(store, { id: 'after', inputId: 'frozen', targetTableId: basis.table.id }, now).tasks[0]!.cost).toMatchObject({
      partial_amount: null,
      compatibility_unverified_partial_amount: null,
      compatibility: { invalidated_events: 1 }
    });
    expect(store.get('SELECT payload FROM events WHERE id=?', ['usage'])).toEqual(originalEvent);
    expect(store.get('SELECT payload,hash FROM price_cost_inputs WHERE id=?', ['frozen'])).toEqual(frozenBytes);
    expect(store.get('SELECT payload FROM price_revaluations WHERE id=?', ['priced'])).toEqual(pricedBytes);
  } finally {
    store.close();
  }
});

test('mismatched source provenance cannot label a different actual version verified', () => {
  const event = nativeEvent('verified', 'mismatch');
  expect(() =>
    projectCatalogCost(
      [{ ...event, payload: { ...event.payload, product_version: '0.161.0' } }],
      compilePriceBasis(bundledPriceCatalog()),
      'task-1',
      '2026-01-02T00:00:00Z',
      'output-only-v1'
    )
  ).toThrow('invalid_event');
});

import { registerVariant, registerProtocol, freezeProtocol } from '../src/comparison.js';
import { registerPriceTable } from '../src/pricing.js';
import { assignTask } from '../src/allocation.js';
import { assignmentInput } from './helpers/comparison-fixture.js';
import { createComparisonSnapshot, readComparisonSnapshot, canonicalJson } from '../src/reports/comparison-snapshot.js';
import { FlexibleSnapshotInputSchema, projectFlexibleComparison } from '../src/reports/flexible-comparison.js';

function nativeComparisonFixture(version = '0.161.0') {
  const store = new Store(':memory:', () => '2026-01-01T00:00:04Z');
  const f = makeFlexibleFixture();
  new Lifecycle(store).registerProject('project-1', process.cwd());
  const trust = resolveSourceCompatibility('codex', version, 'codex_workflow')!;
  f.protocol.purpose = 'functional_pilot';
  delete f.protocol.minimum_effect;
  delete f.protocol.quality_margin;
  delete f.protocol.confidence_level;
  f.protocol.source_profiles = [{ product: 'codex', product_version: version, profile_id: trust.profile_id }];
  f.metadata.product = 'codex';
  f.priceTable.entries = f.priceTable.entries.map(e => ({ ...e, product: 'codex', model: 'gpt-6.1-sol' }));
  registerPriceTable(store, f.priceTable);
  f.variants.forEach(v => registerVariant(store, v));
  registerProtocol(store, f.protocol);
  freezeProtocol(store, f.protocol.id, '2025-12-31T00:00:00Z');
  assignTask(store, { ...assignmentInput, schema_version: 2, metadata: f.metadata }, { clock: () => f.protocol.recruitment_start, shuffle: x => x });
  store.execute("UPDATE tasks SET state='active',started_at=? WHERE id='task-1'", [f.protocol.recruitment_start]);
  store.execute("INSERT INTO sessions(id,project_id,task_id,product,product_version) VALUES ('session-1','project-1','task-1','codex',?)", [version]);
  pinSessionCompatibility(store, 'session-1', trust);
  recordRuntimeEvidence(store, { ...f.runtime[0]!, product: 'codex', product_version: version, model: 'gpt-6.1-sol' });
  store.putEvent({
    ...nativeEvent('compatibility_unverified', 'usage'),
    payload: { ...nativeEvent('compatibility_unverified', 'usage').payload, product_version: trust.product_version, source_compatibility: trust }
  });
  const cutoff = '2026-01-01T02:00:00Z';
  const report = createComparisonSnapshot(store, { reportId: 'frozen-comparison', protocolId: f.protocol.id, cutoff, revisionReason: 'initial' }, () => cutoff);
  return { store, trust, report };
}
test('frozen flexible task and arm means keep references separate and disclose subsequent invalidation', () => {
  const { store, trust, report } = nativeComparisonFixture();
  try {
    expect(report).toMatchObject({
      tasks: [{ cost: { partial_amount: null, compatibility_unverified_partial_amount: '0.26' } }],
      arms: [{ partial_mean: null, compatibility_unverified_partial_mean: '0.26' }, {}]
    });
    const bytes = store.get('SELECT input_json,report_json,snapshot_hash FROM flexible_report_snapshots');
    invalidateCompatibility(store, trust, 'semantic_incompatibility');
    const current = readComparisonSnapshot(store, 'frozen-comparison');
    expect(current).toMatchObject({
      snapshot_hash: report.snapshot_hash,
      tasks: [{ cost: { partial_amount: null, compatibility_unverified_partial_amount: null, compatibility: { invalidated_events: 1 } } }],
      arms: [{ partial_mean: null, compatibility_unverified_partial_mean: null, invalidated_events: 1 }, {}]
    });
    expect(store.get('SELECT input_json,report_json,snapshot_hash FROM flexible_report_snapshots')).toEqual(bytes);
  } finally {
    store.close();
  }
});
test('historical frozen native bytes validate without silently qualifying missing provenance', () => {
  const { store } = nativeComparisonFixture('0.160.0');
  try {
    const row = store.get<{ input_json: string }>('SELECT input_json FROM flexible_report_snapshots')!;
    const input = FlexibleSnapshotInputSchema.parse(JSON.parse(row.input_json) as unknown);
    for (const a of input.assignments) for (const u of a.usages) delete u.event.payload.source_compatibility;
    input.report_id = 'historical';
    input.snapshot_sequence = 2;
    const historical = projectFlexibleComparison(input, true);
    expect(historical.tasks[0]!.cost.partial_amount).toBe('0.26');
    store.execute(
      'INSERT INTO flexible_report_snapshots(report_id,protocol_id,cutoff,evaluated_at,data_revision,snapshot_sequence,schema_version,descriptive_version,revision_reason,supersedes_report_id,input_json,report_json,snapshot_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [
        input.report_id,
        input.protocol.id,
        input.cutoff,
        input.evaluated_at,
        input.data_revision,
        input.snapshot_sequence,
        2,
        input.descriptive_version,
        input.revision_reason,
        input.supersedes_report_id,
        canonicalJson(input),
        canonicalJson(historical),
        historical.snapshot_hash
      ]
    );
    const frozen = store.get("SELECT input_json,report_json,snapshot_hash FROM flexible_report_snapshots WHERE report_id='historical'");
    const current = readComparisonSnapshot(store, 'historical');
    expect(current).toMatchObject({
      snapshot_hash: historical.snapshot_hash,
      tasks: [{ cost: { partial_amount: null, legacy_unverified_partial_amount: '0.26' } }],
      arms: [{ partial_mean: null, legacy_unverified_partial_mean: '0.26' }, {}]
    });
    invalidateCompatibility(store, resolveSourceCompatibility('codex', '0.160.0', 'file')!, 'semantic_incompatibility');
    const blocked = readComparisonSnapshot(store, 'historical');
    expect(blocked).toMatchObject({
      snapshot_hash: historical.snapshot_hash,
      tasks: [{ cost: { partial_amount: null, legacy_unverified_partial_amount: null, compatibility: { invalidated_events: 1 } } }],
      arms: [{ partial_mean: null, legacy_unverified_partial_mean: null, invalidated_events: 1 }, {}],
      limitations: expect.arrayContaining(['source_compatibility_invalidated_since_capture']) as unknown
    });
    expect(store.get("SELECT input_json,report_json,snapshot_hash FROM flexible_report_snapshots WHERE report_id='historical'")).toEqual(frozen);
  } finally {
    store.close();
  }
});

import { readObservedCostReport } from '../src/observed-cost-report.js';

test('legacy native reports and retained repricing exclude blocked versions without fabricating provenance', () => {
  const store = new Store(':memory:');
  const now = '2026-10-06T00:00:00Z';
  const cutoff = '2026-01-02T00:00:00Z';
  try {
    const life = new Lifecycle(store, () => '2026-01-01T00:00:00Z');
    life.registerProject('project-1', process.cwd());
    life.createTask('project-1', 'task-1', {
      type: 'feature',
      expected_size: 'small',
      assignee: 'user',
      product: 'codex',
      model: 'gpt-6.1-sol',
      criterion_ids: ['c']
    });
    life.start('task-1');
    store.execute("INSERT INTO sessions(id,project_id,task_id,product,product_version) VALUES ('session-1','project-1','task-1','codex','0.160.0')", []);
    const original = nativeEvent('verified', 'legacy');
    const { source_compatibility: omitted, ...payload } = original.payload;
    void omitted;
    recordRuntimeEvidence(store, { ...makeFlexibleFixture().runtime[0]!, product: 'codex', product_version: '0.160.0', model: 'gpt-6.1-sol' });
    store.putEvent({ ...original, payload });
    const rawEvent = store.get<{ payload: string }>('SELECT payload FROM events WHERE id=?', ['legacy'])!;
    expect(rawEvent.payload).not.toContain('source_compatibility');
    const basis = preparePriceBasis(store, now);
    expect(readObservedCostReport(store, 'task-1', basis.table.id, cutoff, 'output-only-v1')).toMatchObject({
      partial_amount: null,
      legacy_unverified_partial_amount: '0.000302'
    });
    captureTaskCostSnapshot(store, { inputId: 'legacy-frozen', taskId: 'task-1', tableId: basis.table.id, cutoff, inputBasis: 'output-only-v1' }, now);
    const rawSnapshot = store.get('SELECT payload,hash FROM price_cost_inputs WHERE id=?', ['legacy-frozen']);
    createPriceRevaluation(store, { id: 'legacy-price', inputId: 'legacy-frozen', targetTableId: basis.table.id }, now);
    // Historical source is unknown: a block on either known source invalidates this version conservatively.
    invalidateCompatibility(store, resolveSourceCompatibility('codex', '0.160.0', 'file')!, 'semantic_incompatibility');
    expect(aggregateTask(store, 'task-1', cutoff).usage).toMatchObject({
      partial_tokens: null,
      legacy_unverified: { partial_tokens: null },
      compatibility: {
        invalidated_events: 1,
        legacy_unverified_events: 0,
        sources: [{ state: 'invalidated', product: 'codex', product_version: '0.160.0', event_count: 1 }]
      }
    });
    const observed = readObservedCostReport(store, 'task-1', basis.table.id, cutoff, 'output-only-v1');
    expect(observed).toMatchObject({ partial_amount: null, legacy_unverified_partial_amount: null, compatibility: { invalidated_events: 1 } });
    expect(JSON.stringify(observed)).not.toContain('parser_revision');
    const repriced = readPriceRevaluation(store, 'legacy-price');
    expect(repriced).toMatchObject({
      tasks: [{ cost: { partial_amount: null, legacy_unverified_partial_amount: null, compatibility: { invalidated_events: 1 } } }],
      limitations: expect.arrayContaining(['source_compatibility_invalidated_since_capture']) as unknown
    });
    expect(createPriceRevaluation(store, { id: 'legacy-after', inputId: 'legacy-frozen', targetTableId: basis.table.id }, now)).toMatchObject({
      tasks: [{ cost: { partial_amount: null, legacy_unverified_partial_amount: null, compatibility: { invalidated_events: 1 } } }]
    });
    expect(store.get('SELECT payload FROM events WHERE id=?', ['legacy'])).toEqual(rawEvent);
    expect(store.get('SELECT payload,hash FROM price_cost_inputs WHERE id=?', ['legacy-frozen'])).toEqual(rawSnapshot);
  } finally {
    store.close();
  }
});
