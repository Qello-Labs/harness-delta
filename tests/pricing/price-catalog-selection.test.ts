import { expect, test } from 'vitest';
import { Store } from '../../src/store.js';
import { selectTaskPriceTable } from '../../src/pricing/price-catalog-selection.js';
import { preparePriceBasis, refreshPriceCatalog } from '../../src/pricing/price-catalog-store.js';
import { bundledPriceCatalog, digest } from '../../src/pricing/price-catalog.js';
import { registerProtocolWithCatalogDefaults, registerVariant, freezeProtocol } from '../../src/comparison/comparison.js';
import { showProtocol } from '../../src/readiness-store.js';
import { makeFlexibleFixture } from '../helpers/flexible-fixture.js';
import { seedProject, beforeRecruitment, assignmentInput } from '../helpers/comparison-fixture.js';
import { assignTask } from '../../src/comparison/allocation.js';
import { readReferenceTaskCostReport } from '../../src/pricing/price-catalog-task-report.js';

const now = '2026-10-06T15:00:00Z';
test('omitted protocol price binds once and assigned tasks retain that pin after refresh', async () => {
  const store = new Store(':memory:');
  try {
    seedProject(store);
    const f = makeFlexibleFixture();
    f.variants.forEach(v => registerVariant(store, v));
    const { price_table_id: _omitted, ...draft } = f.protocol;
    void _omitted;
    registerProtocolWithCatalogDefaults(store, draft, now);
    const first = preparePriceBasis(store, now);
    freezeProtocol(store, f.protocol.id, beforeRecruitment);
    assignTask(
      store,
      { ...assignmentInput, schema_version: 2, task_id: 'task', logical_task_id: 'logical', metadata: f.metadata },
      { clock: () => f.protocol.recruitment_start, shuffle: x => x }
    );
    const bytes = Buffer.from(JSON.stringify({ ...bundledPriceCatalog(), catalog_id: 'next', catalog_version: 2 }));
    await refreshPriceCatalog(store, () => Promise.resolve(bytes), digest(bytes), now);
    expect(preparePriceBasis(store, now).table.id).not.toBe(first.table.id);
    expect(selectTaskPriceTable(store, 'task', now)).toEqual({ tableId: first.table.id, selection: 'frozen_comparison' });
    expect(readReferenceTaskCostReport(store, 'task', now, 'output-only-v1', now)).toMatchObject({
      price_selection: 'frozen_comparison',
      price_basis_hash: first.basis_hash,
      catalog_id: first.catalog.catalog_id,
      complete_amount: null,
      partial_amount: null,
      matches: [],
      window_start: null
    });
    registerProtocolWithCatalogDefaults(store, draft, now);
    expect(showProtocol(store, f.protocol.id)).toMatchObject({ configuration: { price_table_id: first.table.id } });
  } finally {
    store.close();
  }
});
test('explicit protocol reference keeps existing registration semantics', () => {
  const store = new Store(':memory:');
  try {
    seedProject(store);
    const f = makeFlexibleFixture();
    registerProtocolWithCatalogDefaults(store, f.protocol, now);
    expect(showProtocol(store, f.protocol.id)).toMatchObject({ configuration: { price_table_id: 'prices-1' } });
    expect(store.all('SELECT * FROM price_catalogs')).toEqual([]);
  } finally {
    store.close();
  }
});
