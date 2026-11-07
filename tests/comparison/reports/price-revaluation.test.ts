import { expect, test } from 'vitest';
import { Store } from '../../../src/store.js';
import { Lifecycle } from '../../../src/core/lifecycle.js';
import { Deletion } from '../../../src/deletion.js';
import { bundledPriceCatalog, digest } from '../../../src/pricing/price-catalog.js';
import { preparePriceBasis, refreshPriceCatalog } from '../../../src/pricing/price-catalog-store.js';
import { captureTaskCostSnapshot, createPriceRevaluation, readPriceRevaluation } from '../../../src/comparison/reports/price-revaluation.js';

const now = '2026-10-06T15:00:00Z';
function fixture(model = 'gpt-6.1-sol') {
  const store = new Store(':memory:');
  const life = new Lifecycle(store, () => '2026-01-01T00:00:00Z');
  life.registerProject('project', process.cwd());
  life.createTask('project', 'task', { type: 'feature', expected_size: 'small', assignee: 'user', product: 'codex', model, criterion_ids: ['criterion'] });
  life.start('task');
  store.execute("INSERT INTO sessions(id,project_id,task_id,product,source_path) VALUES ('session','project','task','codex','/synthetic/private')", []);
  const observed = (value: number) => ({ status: 'observed' as const, value, reason: null });
  store.putEvent({
    id: 'event',
    source_key: 'event',
    task_id: 'task',
    project_id: 'project',
    session_id: 'session',
    occurred_at: '2026-01-01T00:00:02Z',
    payload: {
      kind: 'usage',
      product: 'codex',
      product_version: '0.158.0',
      model,
      epoch: 'epoch',
      input_total: observed(100),
      cached_input: observed(50),
      output_total: observed(10),
      reasoning_output: observed(5)
    }
  });
  return { store, life };
}
test('revaluation changes rates on the retained snapshot, never the live usage or original result', async () => {
  const { store } = fixture();
  try {
    const basis = preparePriceBasis(store, now);
    const original = captureTaskCostSnapshot(
      store,
      { inputId: 'snapshot', taskId: 'task', cutoff: '2026-01-01T00:00:10Z', tableId: basis.table.id, inputBasis: 'output-only-v1' },
      now
    );
    const first = createPriceRevaluation(store, { id: 'original', inputId: 'snapshot', targetTableId: basis.table.id }, now);
    expect(first.tasks[0]?.cost).toMatchObject({ partial_amount: null, legacy_unverified_partial_amount: '0.0001' });
    const bytes = Buffer.from(
      JSON.stringify({
        ...bundledPriceCatalog(),
        catalog_id: 'new-rates',
        catalog_version: 2,
        models: bundledPriceCatalog().models.map(row => (row.model === 'gpt-6.1-sol' ? { ...row, rates: { ...row.rates, output: '20' } } : row))
      })
    );
    await refreshPriceCatalog(store, () => Promise.resolve(bytes), digest(bytes), now);
    const next = preparePriceBasis(store, now);
    store.execute("DELETE FROM events WHERE id='event'", []);
    const repriced = createPriceRevaluation(store, { id: 'recalculated', inputId: 'snapshot', targetTableId: next.table.id }, now);
    expect(repriced.tasks[0]?.cost).toMatchObject({ partial_amount: null, legacy_unverified_partial_amount: '0.0002' });
    expect(repriced).toMatchObject({ base_snapshot_hash: original.snapshot_hash, complete_amount: null, original_table_id: basis.table.id });
    expect(repriced.tasks[0]?.usage_snapshot_hash).toBe(first.tasks[0]?.usage_snapshot_hash);
    expect(readPriceRevaluation(store, 'original')).toEqual(first);
    expect(createPriceRevaluation(store, { id: 'recalculated', inputId: 'snapshot', targetTableId: next.table.id }, '2026-10-07T00:00:00Z')).toEqual(repriced);
    expect(() => createPriceRevaluation(store, { id: 'recalculated', inputId: 'snapshot', targetTableId: basis.table.id }, now)).toThrow(
      'revaluation_conflict'
    );
    expect(JSON.stringify(repriced)).not.toContain('/synthetic/private');
  } finally {
    store.close();
  }
});
for (const target of ['task', 'project'] as const)
  test(`${target} deletion purges retained usage and blocks result resurrection`, () => {
    const { store } = fixture();
    try {
      const basis = preparePriceBasis(store, now);
      captureTaskCostSnapshot(
        store,
        { inputId: 'snapshot', taskId: 'task', cutoff: '2026-01-01T00:00:10Z', tableId: basis.table.id, inputBasis: 'output-only-v1' },
        now
      );
      createPriceRevaluation(store, { id: 'result', inputId: 'snapshot', targetTableId: basis.table.id }, now);
      const deletion = new Deletion(store, () => now);
      if (target === 'task') deletion.deleteTask('task');
      else deletion.deleteProject('project');
      expect(readPriceRevaluation(store, 'result')).toMatchObject({ validity_status: 'invalidated' });
      expect(store.all('SELECT * FROM price_cost_inputs')).toEqual([]);
      expect(() => createPriceRevaluation(store, { id: 'result', inputId: 'snapshot', targetTableId: basis.table.id }, now)).toThrow('invalidated_revaluation');
      expect(store.all('SELECT * FROM price_catalogs')).toHaveLength(1);
    } finally {
      store.close();
    }
  });

test('both original arms reprice together from one comparison snapshot and base invalidation purges them', async () => {
  const { seedFlexibleComparison } = await import('../../helpers/flexible-store.js');
  const { assignTask } = await import('../../../src/comparison/allocation.js');
  const { createComparisonSnapshot, readComparisonSnapshot } = await import('../../../src/comparison/reports/comparison-snapshot.js');
  const { captureComparisonCostSnapshot } = await import('../../../src/comparison/reports/price-revaluation.js');
  const store = new Store(':memory:');
  try {
    const f = seedFlexibleComparison(store);
    for (let i = 0; i < 4; i++)
      assignTask(store, { ...f.input, task_id: `task-${i}`, logical_task_id: `logical-${i}` }, { clock: () => f.protocol.recruitment_start, shuffle: x => x });
    const cutoff = '2026-01-01T02:00:00Z';
    const original = createComparisonSnapshot(store, { reportId: 'base', protocolId: f.protocol.id, cutoff, revisionReason: 'initial' }, () => cutoff);
    const saved = JSON.stringify(original);
    const snapshot = captureComparisonCostSnapshot(store, 'cohort', 'base');
    const basis = preparePriceBasis(store, now);
    const result = createPriceRevaluation(store, { id: 'new-result', inputId: 'cohort', targetTableId: basis.table.id }, now);
    expect([...new Set(result.tasks.map(task => task.original_variant_id))].sort()).toEqual(['variant-a', 'variant-b']);
    expect(result.tasks).toHaveLength(4);
    expect(new Set(result.tasks.map(task => task.cost.price_table.id))).toEqual(new Set([basis.table.id]));
    expect(result.base_snapshot_hash).toBe(snapshot.snapshot_hash);
    expect(JSON.stringify(readComparisonSnapshot(store, 'base'))).toBe(saved);
    expect(result).not.toHaveProperty('relative_change');
    expect(result).not.toHaveProperty('adoption');
    new Deletion(store, () => now).deleteTask('task-0');
    expect(store.all('SELECT * FROM price_cost_inputs')).toEqual([]);
    expect(readPriceRevaluation(store, 'new-result').validity_status).toBe('invalidated');
  } finally {
    store.close();
  }
});

test('later synthetic catalog fills only a missing rate, preserving original unknown and usage gaps', async () => {
  const { store } = fixture('synthetic-new-model');
  try {
    const first = preparePriceBasis(store, now);
    captureTaskCostSnapshot(
      store,
      { inputId: 'unknown-input', taskId: 'task', tableId: first.table.id, cutoff: '2026-01-01T00:00:10Z', inputBasis: 'output-only-v1' },
      now
    );
    const original = createPriceRevaluation(store, { id: 'unknown-cost', inputId: 'unknown-input', targetTableId: first.table.id }, now);
    expect(original.tasks[0]?.cost).toMatchObject({ partial_amount: null, event_count: 1 });
    const catalog = bundledPriceCatalog();
    const model = { ...catalog.models.find(row => row.model === 'gpt-6.1-sol')!, model: 'synthetic-new-model', aliases: [] };
    const bytes = Buffer.from(JSON.stringify({ ...catalog, catalog_id: 'synthetic-new-catalog', catalog_version: 2, models: [...catalog.models, model] }));
    expect(await refreshPriceCatalog(store, () => Promise.resolve(bytes), digest(bytes), now)).toMatchObject({ status: 'updated' });
    const next = preparePriceBasis(store, now);
    const result = createPriceRevaluation(store, { id: 'known-reference', inputId: 'unknown-input', targetTableId: next.table.id }, now);
    expect(result.tasks[0]?.cost).toMatchObject({ partial_amount: null, legacy_unverified_partial_amount: '0.0001', complete_amount: null, event_count: 1 });
    expect(result.tasks[0]?.cost.reasons).toContain('unknown_components');
    expect(readPriceRevaluation(store, 'unknown-cost')).toEqual(original);
  } finally {
    store.close();
  }
});
