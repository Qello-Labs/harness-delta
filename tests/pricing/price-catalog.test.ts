import { expect, test } from 'vitest';
import { PriceTableSchema } from '../../src/flexible-contracts.js';
import { bundledPriceCatalog, compilePriceBasis, parsePriceCatalog } from '../../src/pricing/price-catalog.js';

test('bundle supplies verified literal models and reference conditions', () => {
  const catalog = bundledPriceCatalog();
  const basis = compilePriceBasis(catalog);
  expect(PriceTableSchema.safeParse(basis.table).success).toBe(true);
  expect(catalog.models).toHaveLength(7);
  expect(basis.table.entries.find(row => row.model === 'gpt-6.1-sol' && row.component === 'cache_read')?.price_per_unit).toBe('0.1');
  expect(basis.table.entries.find(row => row.model === 'claude-haiku-4-5' && row.component === 'cache_write')?.price_per_unit).toBe('1.25');
  expect(basis.policy_id).toBe('reference-standard-v1');
  expect(basis.table.entries.some(row => row.model === 'opus' || row.model === 'gpt-6.1-sol-high')).toBe(false);
});

test('compiler is deterministic and aliases conflicts fail instead of collapsing', () => {
  const catalog = bundledPriceCatalog();
  const reversed = { ...catalog, models: [...catalog.models].reverse() };
  expect(compilePriceBasis(reversed)).toEqual(compilePriceBasis(catalog));
  expect(() => parsePriceCatalog({ ...catalog, models: [...catalog.models, catalog.models[0]] })).toThrow('invalid_price_catalog');
  const colliding = catalog.models.map((model, i) => (i < 2 ? { ...model, aliases: ['same-model'] } : model));
  expect(() => parsePriceCatalog({ ...catalog, models: colliding })).toThrow('invalid_price_catalog');
});

test('missing rate differs from verified zero and effective expiry blocks new preparation only', () => {
  const catalog = bundledPriceCatalog();
  const models = catalog.models.map((model, i) => (i === 0 ? { ...model, rates: { output: '0' }, effective_until: '2026-10-07T00:00:00Z' } : model));
  const basis = compilePriceBasis(parsePriceCatalog({ ...catalog, models }), '2026-10-06T00:00:00Z');
  expect(basis.table.entries.filter(row => row.model === models[0]!.model).map(row => row.price_per_unit)).toEqual(['0']);
  const later = compilePriceBasis(parsePriceCatalog({ ...catalog, models }), '2026-10-07T00:00:00Z');
  expect(later.table.entries.some(row => row.model === models[0]!.model)).toBe(false);
  expect(basis.table.entries.some(row => row.model === models[0]!.model)).toBe(true);
  expect(() => parsePriceCatalog({ ...catalog, currency: 'EUR' })).toThrow('invalid_price_catalog');
  expect(() => parsePriceCatalog({ ...catalog, policy_id: 'bill-everything' })).toThrow('invalid_price_catalog');
  expect(() => parsePriceCatalog({ ...catalog, unexpected: 'private' })).toThrow('invalid_price_catalog');
});
