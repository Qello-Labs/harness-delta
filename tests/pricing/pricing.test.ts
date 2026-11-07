import { expect, test } from 'vitest';
import { Decimal } from 'decimal.js';
import { Store } from '../../src/store.js';
import { PriceTableSchema } from '../../src/flexible-contracts.js';
import { makeFlexibleFixture } from '../helpers/flexible-fixture.js';
test('prices_disjoint_components_once', async () => {
  const { priceUsage } = await import('../../src/pricing/pricing.js');
  const f = makeFlexibleFixture();
  expect(priceUsage(f.events[0]!, f.priceTable)).toMatchObject({ amount: '0.26', partial_amount: '0.26', reasons: [] });
  expect(Decimal.precision).toBe(20);
});
test('unknown_cache_split_is_null', async () => {
  const { priceUsage } = await import('../../src/pricing/pricing.js');
  const f = makeFlexibleFixture();
  const event = {
    ...f.events[0]!,
    payload: { ...f.events[0]!.payload, billing_components: [{ kind: 'output' as const, reading: { status: 'observed' as const, value: 10, reason: null } }] }
  };
  expect(priceUsage(event, f.priceTable)).toMatchObject({ amount: null, partial_amount: '0.04', reasons: ['unknown_components'] });
});
test('unpriced_is_not_zero', async () => {
  const { priceUsage } = await import('../../src/pricing/pricing.js');
  const f = makeFlexibleFixture();
  expect(priceUsage({ ...f.events[0]!, payload: { ...f.events[0]!.payload, model: 'not-priced' } }, f.priceTable).amount).toBeNull();
  const table = { ...f.priceTable, entries: f.priceTable.entries.filter(e => e.component !== 'output') };
  expect(priceUsage(f.events[0]!, table)).toMatchObject({ amount: null, partial_amount: '0.22', reasons: ['unpriced_component'] });
});
test('round_only_for_display', async () => {
  const { priceUsage, sumAmounts, displayAmount } = await import('../../src/pricing/pricing.js');
  const f = makeFlexibleFixture();
  const table = { ...f.priceTable, entries: f.priceTable.entries.map(e => ({ ...e, price_per_unit: '0.001' })) };
  const amount = priceUsage(f.events[0]!, table).amount!;
  expect(amount).toBe('0.00013');
  expect(displayAmount(sumAmounts(Array.from({ length: 100 }, () => amount)), table)).toBe('0.01');
  expect(displayAmount('0.025', table)).toBe('0.02');
});
test('duplicate_price_key_and_currency_mix_reject', () => {
  const f = makeFlexibleFixture();
  expect(PriceTableSchema.safeParse({ ...f.priceTable, entries: [...f.priceTable.entries, f.priceTable.entries[0]] }).success).toBe(false);
  expect(PriceTableSchema.safeParse({ ...f.priceTable, entries: [{ ...f.priceTable.entries[0], currency: 'EUR' }] }).success).toBe(false);
  expect(PriceTableSchema.safeParse({ ...f.priceTable, entries: [{ ...f.priceTable.entries[0], price_per_unit: '-1' }] }).success).toBe(false);
});
test('same_table_bytes_are_idempotent_changed_contents_conflict', async () => {
  const { registerPriceTable, readPriceTable } = await import('../../src/pricing/pricing.js');
  const f = makeFlexibleFixture();
  const store = new Store(':memory:');
  try {
    registerPriceTable(store, f.priceTable);
    registerPriceTable(store, f.priceTable);
    expect(readPriceTable(store, f.priceTable.id)).toEqual(f.priceTable);
    expect(() => registerPriceTable(store, { ...f.priceTable, currency: 'EUR' })).toThrow('price_table_conflict');
    expect(() => store.execute("UPDATE price_tables SET payload='{}'", [])).toThrow('immutable_price_table');
  } finally {
    store.close();
  }
});
test('legal_smallest_price_with_repeating_unit_division_aggregates_without_false_overflow', async () => {
  const { priceUsage, sumAmounts } = await import('../../src/pricing/pricing.js');
  const { aggregateTaskCost } = await import('../../src/pricing/metrics.js');
  const f = makeFlexibleFixture();
  const table = PriceTableSchema.parse({
    ...f.priceTable,
    unit_tokens: 3,
    entries: f.priceTable.entries.map(e => ({ ...e, price_per_unit: '0.' + '0'.repeat(58) + '1' }))
  });
  const amount = priceUsage(f.events[0]!, table).amount!;
  expect(amount.length).toBeGreaterThan(200);
  expect(sumAmounts([amount])).toBe(amount);
  expect(aggregateTaskCost(f.events, table, f.coverage).complete_amount).toBe(amount);
});
