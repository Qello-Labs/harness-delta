import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { compilePriceBasis, matchCatalogComponent, parsePriceCatalog } from '../../src/pricing/price-catalog.js';
import { projectCatalogCost } from '../../src/pricing/catalog-cost-report.js';
import { priceUsage } from '../../src/pricing/pricing.js';
import { EventV2Schema, RuntimeEvidenceSchema, type BillingComponent } from '../../src/flexible-contracts.js';
import { makeFlexibleFixture } from '../helpers/flexible-fixture.js';

const candidateUrl = new URL('../../config/prices/catalogs/reference-catalog-2026-11-25-v5.json', import.meta.url);
const cutoff = '2026-11-25T00:00:02Z';
const observed = (value: number) => ({ status: 'observed' as const, value, reason: null });

function candidateBasis() {
  return compilePriceBasis(parsePriceCatalog(JSON.parse(readFileSync(candidateUrl, 'utf8'))));
}

function usage(model = 'gpt-6.2-astra', write: BillingComponent['reading'] = observed(30)) {
  const original = makeFlexibleFixture().events[0];
  if (!original) throw new Error('missing_synthetic_event');
  return EventV2Schema.parse({
    ...original,
    occurred_at: '2026-11-25T00:00:01Z',
    payload: {
      ...original.payload,
      product: 'codex',
      product_version: '0.171.0',
      model,
      input_total: observed(write.status === 'observed' ? 120 + write.value : 150),
      cached_input: observed(20),
      output_total: observed(10),
      reasoning_output: observed(5),
      billing_components: [
        { kind: 'ordinary_input', reading: observed(100) },
        { kind: 'cache_read', reading: observed(20) },
        { kind: 'cache_write', reading: write },
        { kind: 'output', reading: observed(10) }
      ]
    }
  });
}

test('v5 compiles optional OpenAI write rates under the existing schema-three contract', () => {
  const basis = candidateBasis();
  expect(basis.catalog).toMatchObject({
    catalog_id: 'reference-catalog-2026-11-25',
    catalog_version: 5,
    schema_version: 3,
    policy_id: 'reference-standard-observed-cache-ttl-v3'
  });
  expect(basis.catalog.models).toHaveLength(17);
  expect(basis.table.entries).toHaveLength(76);
  expect(basis.table.entries.filter(entry => entry.product === 'codex' && entry.component === 'cache_write')).toEqual([]);
  expect(basis.matching_version).toBe('exact-catalog-observed-cache-ttl-v3');
  expect(basis.conditions.openai).toBe('standard_short');
});

test.each([
  ['gpt-6.2-astra', ['8', '0.4', '40'], '0.001208'],
  ['gpt-6.2-sol', ['2', '0.1', '10'], '0.000302'],
  ['gpt-6.1-terra', ['1', '0.05', '5'], '0.000151'],
  ['gpt-6-sol', ['2', '0.2', '10'], '0.000304'],
  ['gpt-5.6-terra', ['2', '0.2', '12'], '0.000324'],
  ['gpt-5.6-luna', ['0.2', '0.02', '1.2'], '0.0000324']
] as const)('v5 prices exact model %s while keeping its observed writes unpriced', (model, rates, amount) => {
  const event = usage(model);
  const basis = candidateBasis();
  const report = projectCatalogCost([event, event], basis, event.task_id, cutoff, 'output-only-v1');
  expect(report).toMatchObject({
    event_count: 1,
    partial_amount: null,
    legacy_unverified_partial_amount: amount,
    complete_amount: null,
    unknown_price_components: 1,
    unpriced_events: 1,
    price_reasons: ['missing_rate']
  });
  for (const [index, component] of (['ordinary_input', 'cache_read', 'output'] as const).entries()) {
    expect(report.matches.find(match => match.component === component)).toMatchObject({
      canonical_model: model,
      status: 'matched',
      price_per_unit: rates[index]
    });
  }
  expect(report.matches.find(match => match.component === 'cache_write')).toMatchObject({
    status: 'unavailable',
    reason: 'missing_rate',
    price_per_unit: null
  });
  expect(event.payload.billing_components.find(component => component.kind === 'cache_write')?.reading).toEqual(observed(30));
  expect(priceUsage(event, basis.table)).toMatchObject({ amount: null, partial_amount: amount, reasons: ['unpriced_component'] });
});

test.each([
  [observed(0), ['unpriced_component']],
  [{ status: 'missing', value: null, reason: 'not_available' }, ['unknown_components']],
  [{ status: 'error', value: null, reason: 'source_error' }, ['unknown_components']]
] as const)('v5 preserves %j write evidence instead of converting absent rates to zero usage', (write, reasons) => {
  const event = usage('gpt-6.2-astra', write);
  const basis = candidateBasis();
  expect(priceUsage(event, basis.table)).toMatchObject({ amount: null, partial_amount: '0.001208', reasons });
  expect(event.payload.billing_components.find(component => component.kind === 'cache_write')?.reading).toEqual(write);
  expect(matchCatalogComponent(event, 'cache_write', basis)).toMatchObject({ status: 'unavailable', reason: 'missing_rate', price_per_unit: null });
});

test.each([
  ['gpt-5.6', 'codex', 'gpt-5.6-sol', '20'],
  ['claude-haiku-4-5', 'claude_code', 'claude-haiku-4-5-20251001', '5']
] as const)('v5 keeps the explicit alias %s', (model, product, canonical, rate) => {
  const event = usage(model);
  event.payload.product = product;
  expect(matchCatalogComponent(event, 'output', candidateBasis())).toMatchObject({
    canonical_model: canonical,
    status: 'matched',
    price_per_unit: rate
  });
});

test.each(['gpt-6.2-astra-fast', 'gpt-6.2-sol-high', 'gpt-6.1-terra-20261125'])('v5 does not normalize unlisted model %s', model => {
  expect(matchCatalogComponent(usage(model), 'output', candidateBasis())).toMatchObject({
    status: 'unavailable',
    reason: 'unknown_model',
    price_per_unit: null
  });
});

test('v5 changes carried rates only by removing OpenAI writes and retains unknown promotion bounds', () => {
  const previous = parsePriceCatalog(
    JSON.parse(readFileSync(new URL('../../config/prices/catalogs/reference-catalog-2026-10-16-v4.json', import.meta.url), 'utf8'))
  );
  const next = candidateBasis().catalog;
  for (const row of previous.models) {
    const { cache_write: removed, ...withoutWrite } = row.rates;
    void removed;
    expect(next.models.find(model => model.model === row.model)).toEqual({
      ...row,
      verified_at: next.verified_at,
      rates: row.product === 'codex' ? withoutWrite : row.rates
    });
  }
  expect(next.models.find(row => row.model === 'gpt-5.6-sol')).toMatchObject({ effective_from: null, effective_until: null });
});

test.each([
  [272000, '2.176008'],
  [272001, '2.176016']
] as const)('v5 keeps the short-context reference label and rates for a %i-token OpenAI request', (tokens, amount) => {
  const event = usage();
  event.payload.input_total = observed(tokens);
  const ordinary = event.payload.billing_components.find(component => component.kind === 'ordinary_input');
  if (!ordinary) throw new Error('missing_synthetic_component');
  ordinary.reading = observed(tokens - 50);
  const runtime = RuntimeEvidenceSchema.parse({
    id: event.payload.runtime_evidence_id,
    task_id: event.task_id,
    session_id: event.session_id,
    turn_id: null,
    request_id: 'synthetic-request',
    model: event.payload.model,
    effort: null,
    product: event.payload.product,
    product_version: event.payload.product_version,
    source: 'product_log',
    boundary: 'request',
    occurred_at: event.occurred_at,
    recorded_at: event.occurred_at
  });
  const report = projectCatalogCost([event], candidateBasis(), event.task_id, cutoff, 'output-only-v1', {
    referenceBinding: true,
    runtimeEvidence: [runtime]
  });
  expect(report).toMatchObject({
    reference_conditions: { openai: 'standard_short' },
    legacy_unverified_partial_amount: amount,
    complete_amount: null,
    price_reasons: ['missing_rate']
  });
  expect(report.matches.find(match => match.component === 'ordinary_input')).toMatchObject({ status: 'matched', price_per_unit: '8' });
  expect(report.matches.find(match => match.component === 'output')).toMatchObject({ status: 'matched', price_per_unit: '40' });
});
