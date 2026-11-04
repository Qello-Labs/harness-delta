import { expect, test } from 'vitest';
import { makeFlexibleFixture } from './helpers/flexible-fixture.js';
test('partial_and_complete_not_added', async () => {
  const { aggregateTaskCost } = await import('../src/metrics.js');
  const f = makeFlexibleFixture();
  expect(aggregateTaskCost(f.events, f.priceTable, f.coverage)).toMatchObject({
    complete_amount: '0.26',
    partial_amount: '0.26',
    usage_complete: true,
    price_complete: true
  });
  expect(aggregateTaskCost([...f.events, ...f.events], f.priceTable, f.coverage).complete_amount).toBe('0.26');
});
test('effort_unknown_can_be_price_irrelevant', async () => {
  const { aggregateTaskCost } = await import('../src/metrics.js');
  const f = makeFlexibleFixture();
  expect(f.runtime[0]!.effort).toBeNull();
  expect(aggregateTaskCost(f.events, f.priceTable, f.coverage).complete_amount).toBe('0.26');
});
test('observed_zero_requires_presence', async () => {
  const { aggregateTaskCost } = await import('../src/metrics.js');
  const f = makeFlexibleFixture();
  expect(aggregateTaskCost([], f.priceTable, f.coverage).complete_amount).toBeNull();
  const zero = { status: 'observed' as const, value: 0, reason: null };
  const event = {
    ...f.events[0]!,
    payload: {
      ...f.events[0]!.payload,
      input_total: zero,
      cached_input: zero,
      output_total: zero,
      billing_components: f.events[0]!.payload.billing_components.map(c => ({ ...c, reading: zero }))
    }
  };
  expect(aggregateTaskCost([event], f.priceTable, f.coverage).complete_amount).toBe('0');
});
test('window_and_price_completeness_are_separate', async () => {
  const { aggregateTaskCost } = await import('../src/metrics.js');
  const f = makeFlexibleFixture();
  const table = { ...f.priceTable, entries: f.priceTable.entries.filter(e => e.component !== 'output') };
  expect(aggregateTaskCost(f.events, table, f.coverage)).toMatchObject({
    complete_amount: null,
    partial_amount: '0.22',
    usage_complete: true,
    price_complete: false
  });
  expect(aggregateTaskCost([{ ...f.events[0]!, occurred_at: f.coverage.window_end }], f.priceTable, f.coverage).partial_amount).toBeNull();
  expect(() => aggregateTaskCost([{ ...f.events[0]!, task_id: 'other-task' }], f.priceTable, f.coverage)).toThrow('scope_mismatch');
  for (const fact of Object.keys(f.coverage.facts)) {
    const coverage = { ...f.coverage, facts: { ...f.coverage.facts, [fact]: 'unknown' as const } };
    expect(aggregateTaskCost(f.events, f.priceTable, coverage).complete_amount).toBeNull();
  }
});
