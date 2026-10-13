import { expect, test } from 'vitest';
import { InstrumentedProducerRecordSchema } from '../src/instrumented-codex-contracts.js';
import { projectInstrumentedTerminal } from '../src/instrumented-codex-usage.js';
import { priceUsage } from '../src/pricing.js';
import { PriceTableSchema } from '../src/flexible-contracts.js';
import { instrumentedFixtureProfile } from './helpers/instrumented-codex-fixture.js';

const at = '2026-10-06T15:00:00Z';
const table = PriceTableSchema.parse({
  id: 'synthetic-prices', version: 'synthetic-v1', currency: 'USD', source_id: 'synthetic-rates',
  as_of: at, unit_tokens: 1000, display_decimals: 6, rounding: 'half_even',
  entries: [
    { product: 'codex', model: 'gpt-6.1-sol', component: 'ordinary_input', price_per_unit: '2' },
    { product: 'codex', model: 'gpt-6.1-sol', component: 'cache_read', price_per_unit: '1' },
    { product: 'codex', model: 'gpt-6.1-sol', component: 'output', price_per_unit: '4' },
  ],
});
const observed = (value: number) => ({ status: 'observed' as const, value, reason: null });
const missing = { status: 'missing' as const, value: null, reason: 'not_available' as const };
const readings = {
  input_total: observed(100), cached_input: observed(20), cache_write_input: observed(0),
  output_total: observed(10), reasoning_output: observed(5), total_tokens: observed(110),
};
function project(overrides: Partial<typeof readings> = {}, effectiveModel: 'gpt-6.1-sol' | null = 'gpt-6.1-sol') {
  const record = InstrumentedProducerRecordSchema.parse({
    schema_version: 1, run_id: 'run-1', producer_instance_id: 'producer-1', member_id: 'member-1',
    task_generation: 1, sequence: 4, previous_record_hash: 'a'.repeat(64), occurred_at: at,
    body: { kind: 'attempt_terminal', attempt_id: 'attempt-1', disposition: 'response_completed',
      response_id: 'response-1', effective_model: effectiveModel, readings: { ...readings, ...overrides } },
  });
  return projectInstrumentedTerminal({
    record, profile: instrumentedFixtureProfile, taskId: 'task-1', projectId: 'project-1',
    sessionId: 'session-1', receivedAt: at,
  });
}

test('disjoint input and inclusive output are priced without adding reasoning twice', () => {
  const projected = project();
  const priced = priceUsage(projected.event, table, 'output-only-v1', [projected.runtime]);
  expect(projected.event.payload.billing_components).toEqual([
    { kind: 'ordinary_input', reading: observed(80) },
    { kind: 'cache_read', reading: observed(20) },
    { kind: 'output', reading: observed(10) },
  ]);
  expect(priced).toMatchObject({ amount: '0.22', partial_amount: '0.22', reasons: [] });
});

test('missing cache-write detail never becomes ordinary input or observed zero', () => {
  const record = InstrumentedProducerRecordSchema.parse({
    schema_version: 1, run_id: 'run-1', producer_instance_id: 'producer-1', member_id: 'member-1',
    task_generation: 1, sequence: 4, previous_record_hash: 'a'.repeat(64), occurred_at: at,
    body: { kind: 'attempt_terminal', attempt_id: 'attempt-1', disposition: 'response_completed',
      response_id: 'response-1', effective_model: 'gpt-6.1-sol', readings: { ...readings, cache_write_input: missing } },
  });
  const projected = projectInstrumentedTerminal({
    record, profile: instrumentedFixtureProfile, taskId: 'task-1', projectId: 'project-1',
    sessionId: 'session-1', receivedAt: at,
  });
  expect(projected.required_counters_present).toBe(false);
  expect(projected.raw_readings.cache_write_input).toEqual(missing);
  expect(projected.event.payload.billing_components).toContainEqual({ kind: 'ordinary_input', reading: missing });
});

test('inconsistent counters retain raw readings but cannot create a priced subtotal', () => {
  const projected = project({ cached_input: observed(101) });
  expect(projected.counter_error).toBe(true);
  expect(projected.raw_readings.cached_input).toEqual(observed(101));
  expect(priceUsage(projected.event, table, 'output-only-v1', [projected.runtime]).partial_amount).toBeNull();
});

test('absent effective model does not inherit the requested-model attribution', () => {
  const projected = project({}, null);
  expect(projected.runtime.model).toBeNull();
  expect(projected.event.payload).toMatchObject({ model: null, attribution: 'unknown' });
});
