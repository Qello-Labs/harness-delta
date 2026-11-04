import { resolveSourceCompatibility } from '../src/source-compatibility.js';
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { PriceTableSchema } from '../src/flexible-contracts.js';
import type { Event } from '../src/contracts.js';
import { makeFlexibleFixture } from './helpers/flexible-fixture.js';
import { priceUsage } from '../src/pricing.js';

const observed = (value: number) => ({ status: 'observed' as const, value, reason: null });
const table = () =>
  PriceTableSchema.parse(JSON.parse(readFileSync(new URL('../config/prices/openai-standard-short-2026-10-04.json', import.meta.url), 'utf8')) as unknown);
type LegacyUsageEvent = Event & { payload: Extract<Event['payload'], { kind: 'usage' }> };
const usage = (id = 'parent', model = 'gpt-6-astra', input = 40000, cached = 30000, output = 80): LegacyUsageEvent => ({
  ...makeFlexibleFixture().events[0]!,
  id,
  source_key: id,
  session_id: `session-${id}`,
  payload: {
    kind: 'usage',
    product: 'codex',
    product_version: '0.158.0',
    source_compatibility: resolveSourceCompatibility('codex', '0.158.0', 'file')!,
    model,
    epoch: 'epoch-1',
    input_total: observed(input),
    cached_input: observed(cached),
    output_total: observed(output),
    reasoning_output: observed(40)
  }
});

test('explicit legacy input basis subtracts included cache and retains unknown components', () => {
  expect(priceUsage(usage(), table(), 'cache-read-remainder-ordinary-v1')).toMatchObject({
    amount: null,
    partial_amount: '0.134',
    reasons: ['unknown_components']
  });
  expect(priceUsage(usage(), table())).toMatchObject({ amount: null, partial_amount: '0.004', reasons: ['unknown_components'] });
});

test('parent and child are priced by their own models once with reproducible provenance', async () => {
  const { projectObservedCost } = await import('../src/observed-cost-report.js');
  const parent = usage();
  const child = usage('child', 'gpt-6.1-sol', 20000, 10000, 10);
  const report = projectObservedCost([parent, child, parent], table(), 'task-1', '2026-01-02T00:00:00Z', 'cache-read-remainder-ordinary-v1');
  expect(report).toMatchObject({
    complete_amount: null,
    partial_amount: '0.1551',
    event_count: 2,
    session_count: 2,
    assumed_input_events: 2,
    formula_version: 'decimal160-disjoint-v1',
    input_basis: 'cache-read-remainder-ordinary-v1',
    price_table: table()
  });
  expect(report.price_table_hash).toMatch(/^[a-f0-9]{64}$/);
  expect(() =>
    projectObservedCost(
      [parent, { ...parent, payload: { ...parent.payload, output_total: observed(81) } }],
      table(),
      'task-1',
      '2026-01-02T00:00:00Z',
      'output-only-v1'
    )
  ).toThrow('event_conflict');
});

test('missing cache never implies zero and contradictory included cache is rejected', () => {
  const event = usage();
  expect(
    priceUsage(
      { ...event, payload: { ...event.payload, cached_input: { status: 'missing', value: null, reason: 'not_available' } } },
      table(),
      'cache-read-remainder-ordinary-v1'
    ).partial_amount
  ).toBe('0.004');
  expect(() => priceUsage(usage('bad', 'gpt-6-astra', 10, 20), table(), 'cache-read-remainder-ordinary-v1')).toThrow('invalid_usage_components');
});

test('unpriced exact model and unknown v2 attribution stay unavailable', async () => {
  const { projectObservedCost } = await import('../src/observed-cost-report.js');
  const f = makeFlexibleFixture();
  expect(projectObservedCost([usage('u', 'unpriced-model')], table(), 'task-1', '2026-01-02T00:00:00Z', 'output-only-v1')).toMatchObject({
    partial_amount: null,
    complete_amount: null,
    unpriced_events: 1
  });
  expect(
    priceUsage({ ...f.events[0]!, payload: { ...f.events[0]!.payload, attribution: 'unknown' } }, f.priceTable, 'cache-read-remainder-ordinary-v1')
      .partial_amount
  ).toBeNull();
});

test('v2 recorded cache-write split is retained instead of applying legacy assumptions', () => {
  const f = makeFlexibleFixture();
  const event = f.events[0]!;
  const withWrite = {
    ...event,
    payload: {
      ...event.payload,
      billing_components: [
        { kind: 'ordinary_input' as const, reading: observed(90) },
        { kind: 'cache_write' as const, reading: observed(10) },
        { kind: 'cache_read' as const, reading: observed(20) },
        { kind: 'output' as const, reading: observed(10) }
      ]
    }
  };
  const rates = {
    ...f.priceTable,
    entries: [...f.priceTable.entries, { product: 'synthetic' as const, model: 'synthetic-model', component: 'cache_write' as const, price_per_unit: '5' }]
  };
  expect(priceUsage(withWrite, rates, 'cache-read-remainder-ordinary-v1')).toMatchObject({ amount: '0.29', partial_amount: '0.29', reasons: [] });
  expect(priceUsage(withWrite, rates, 'cache-read-remainder-ordinary-v1')).toEqual(priceUsage(withWrite, rates));
});

test('empty cutoff missing and observed zero remain distinct', async () => {
  const { projectObservedCost } = await import('../src/observed-cost-report.js');
  expect(projectObservedCost([], table(), 'task-1', '2026-01-02T00:00:00Z', 'output-only-v1')).toMatchObject({ partial_amount: null, event_count: 0 });
  expect(
    projectObservedCost([usage('zero', 'gpt-6-astra', 0, 0, 0)], table(), 'task-1', '2026-01-02T00:00:00Z', 'cache-read-remainder-ordinary-v1')
  ).toMatchObject({ partial_amount: '0', complete_amount: null });
  expect(projectObservedCost([usage()], table(), 'task-1', usage().occurred_at, 'output-only-v1').event_count).toBe(0);
  expect(() => projectObservedCost([{ ...usage(), task_id: 'other' }], table(), 'task-1', '2026-01-02T00:00:00Z', 'output-only-v1')).toThrow('scope_mismatch');
});
