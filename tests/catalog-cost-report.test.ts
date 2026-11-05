import { resolveSourceCompatibility } from '../src/source-compatibility.js';
import { expect, test } from 'vitest';
import { bundledPriceCatalog, compilePriceBasis, matchCatalogComponent } from '../src/pricing/price-catalog.js';
import { projectCatalogCost } from '../src/catalog-cost-report.js';
import { makeFlexibleFixture } from './helpers/flexible-fixture.js';

function event(model = 'gpt-6.1-sol') {
  const original = makeFlexibleFixture().events[0]!;
  return {
    ...original,
    payload: {
      ...original.payload,
      product: 'codex' as const,
      product_version: '0.160.0',
      source_compatibility: resolveSourceCompatibility('codex', '0.160.0', 'codex_workflow')!,
      model
    }
  };
}
test('standardized matched cost uses observed disjoint components and inclusive output once', () => {
  const basis = compilePriceBasis(bundledPriceCatalog());
  const e = event();
  const report = projectCatalogCost([e, e], basis, e.task_id, '2026-01-02T00:00:00Z', 'output-only-v1');
  expect(report).toMatchObject({ partial_amount: '0.000302', complete_amount: null, event_count: 1, unknown_price_components: 0 });
  expect(report.matches.every(match => match.provider_basis === 'reference_policy')).toBe(true);
  expect(report.usage_snapshot_hash).toMatch(/^[a-f0-9]{64}$/);
});
test('provider, model, attribution, unsupported conditions and absent rates remain unavailable', () => {
  const basis = compilePriceBasis(bundledPriceCatalog());
  const e = event();
  expect(matchCatalogComponent(e, 'output', basis, {})).toMatchObject({ reason: 'unknown_provider', price_per_unit: null });
  expect(matchCatalogComponent(e, 'output', basis, { providerId: 'azure' })).toMatchObject({ reason: 'unsupported_provider' });
  expect(matchCatalogComponent(event('gpt-6.1-sol-high'), 'output', basis)).toMatchObject({ reason: 'unknown_model' });
  const unknown = projectCatalogCost([event('unknown')], basis, e.task_id, '2026-01-02T00:00:00Z', 'output-only-v1');
  expect(unknown).toMatchObject({ partial_amount: null, complete_amount: null, event_count: 1, unknown_price_components: 3 });
  const ambiguous = { ...e, payload: { ...e.payload, attribution: 'ambiguous' as const, model: null } };
  expect(projectCatalogCost([ambiguous], basis, e.task_id, '2026-01-02T00:00:00Z', 'output-only-v1').partial_amount).toBeNull();
  const noOutput = compilePriceBasis({
    ...basis.catalog,
    models: basis.catalog.models.map(row => (row.model === e.payload.model ? { ...row, rates: { ordinary_input: '2', cache_read: '0.1' } } : row))
  });
  expect(projectCatalogCost([e], noOutput, e.task_id, '2026-01-02T00:00:00Z', 'output-only-v1')).toMatchObject({
    partial_amount: '0.000202',
    unknown_price_components: 1
  });
});
test('missing usage is never filled with zero and fully priced rows do not establish complete usage', () => {
  const basis = compilePriceBasis(bundledPriceCatalog());
  const e = event();
  const missing = {
    ...e,
    payload: {
      ...e.payload,
      output_total: { status: 'missing' as const, value: null, reason: 'not_available' as const },
      billing_components: e.payload.billing_components.map(c =>
        c.kind === 'output' ? { ...c, reading: { status: 'missing' as const, value: null, reason: 'not_available' as const } } : c
      )
    }
  };
  expect(projectCatalogCost([missing], basis, e.task_id, '2026-01-02T00:00:00Z', 'output-only-v1')).toMatchObject({
    partial_amount: '0.000202',
    complete_amount: null
  });
  const zero = {
    ...e,
    payload: {
      ...e.payload,
      input_total: { status: 'observed' as const, value: 0, reason: null },
      cached_input: { status: 'observed' as const, value: 0, reason: null },
      output_total: { status: 'observed' as const, value: 0, reason: null },
      billing_components: e.payload.billing_components.map(c => ({ ...c, reading: { status: 'observed' as const, value: 0, reason: null } }))
    }
  };
  expect(projectCatalogCost([zero], basis, e.task_id, '2026-01-02T00:00:00Z', 'output-only-v1')).toMatchObject({ partial_amount: '0', complete_amount: null });
  expect(projectCatalogCost([], basis, e.task_id, '2026-01-02T00:00:00Z', 'output-only-v1').partial_amount).toBeNull();
});

test('a completely rejected single-model table yields unavailable rather than invalid-table failure', () => {
  const c = bundledPriceCatalog();
  const basis = compilePriceBasis({ ...c, models: [c.models.find(row => row.model === 'gpt-6.1-sol')!] });
  const e = event();
  expect(projectCatalogCost([e], basis, e.task_id, '2026-01-02T00:00:00Z', 'output-only-v1', { providerId: 'azure' })).toMatchObject({
    partial_amount: null,
    unknown_price_components: 3
  });
});
