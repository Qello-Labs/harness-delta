import { existsSync, readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { bundledCatalogBytes, compilePriceBasis, digest, matchCatalogComponent, parsePriceCatalog } from '../src/price-catalog.js';
import { preparePriceCatalogRelease } from '../src/price-catalog-release.js';
import { preparePriceBasis, readPriceBasis, readPriceCatalogStatus, refreshPriceCatalog } from '../src/price-catalog-store.js';
import { registerProtocolWithCatalogDefaults, selectTaskPriceTable } from '../src/price-catalog-selection.js';
import { freezeProtocol, registerVariant, showProtocol } from '../src/comparison.js';
import { assignTask } from '../src/allocation.js';
import { projectCatalogCost } from '../src/catalog-cost-report.js';
import { Store } from '../src/store.js';
import { makeFlexibleFixture } from './helpers/flexible-fixture.js';
import { assignmentInput, beforeRecruitment, seedProject } from './helpers/comparison-fixture.js';

const candidateUrl = new URL('../config/prices/catalogs/reference-catalog-2026-10-08.json', import.meta.url);
const now = '2026-10-08T12:00:00Z';
function candidateBytes() {
  expect(existsSync(candidateUrl), 'release candidate must exist').toBe(true);
  return readFileSync(candidateUrl);
}
function candidate() { return parsePriceCatalog(JSON.parse(candidateBytes().toString('utf8')) as unknown); }

const refreshedUrl = new URL('../config/prices/catalogs/reference-catalog-2026-10-16-v4.json', import.meta.url);
const refreshedAt = '2026-10-16T12:00:00Z';
function refreshedBytes() { return readFileSync(refreshedUrl); }
function refreshedCandidate() { return parsePriceCatalog(JSON.parse(refreshedBytes().toString('utf8'))); }

test('October 16 candidate advances catalog version without changing schema or existing rates', () => {
  const previousBytes = readFileSync(new URL('../config/prices/catalogs/reference-catalog-2026-10-08-v3.json', import.meta.url));
  const previous = parsePriceCatalog(JSON.parse(previousBytes.toString('utf8')));
  const next = refreshedCandidate();
  expect(next).toMatchObject({ schema_version: 3, catalog_version: 4, catalog_id: 'reference-catalog-2026-10-16',
    policy_id: 'reference-standard-observed-cache-ttl-v3', verified_at: '2026-10-16T00:00:00Z', published_at: '2026-10-16T00:00:00Z' });
  expect(next.models).toHaveLength(11);
  for (const row of previous.models) {
    expect(next.models.find(model => model.model === row.model)).toEqual({ ...row, verified_at: next.verified_at });
  }
  expect(next.models.every(row => row.effective_from === null && row.effective_until === null)).toBe(true);
  expect(digest(previousBytes)).toBe('3ecd87627df79d86a1c562635e119f0d51c30dd62c692fb3d7615710d55691ae');
  expect(digest(candidateBytes())).toBe('145226cc91e537aa95cb74d2dfa2441a1e9b2d8dbdd5353c3999e972e8b8627e');
  expect(digest(bundledCatalogBytes())).toBe('ae7f1aefab3b78f87bf9259b68b29882edc498b305831e3c2b3146f0968adf24');
});

test.each([
  ['gpt-5.6-sol', 'gpt-5.6-sol', ['4', '0.4', '5', '20'], '0.000708'],
  ['gpt-5.6', 'gpt-5.6-sol', ['4', '0.4', '5', '20'], '0.000708'],
  ['gpt-5.6-cyber', 'gpt-5.6-cyber', ['12.5', '1.25', '15.625', '75'], '0.0023375'],
] as const)('October 16 candidate prices the literal %s under the existing reference policy', (model, canonical, rates, amount) => {
  const original = makeFlexibleFixture().events[0];
  if (!original) throw new Error('missing_synthetic_event');
  const event = { ...original, payload: { ...original.payload, product: 'codex' as const, model,
    input_total: { status: 'observed' as const, value: 140, reason: null },
    billing_components: [...original.payload.billing_components,
      { kind: 'cache_write' as const, reading: { status: 'observed' as const, value: 20, reason: null } }] } };
  const basis = compilePriceBasis(refreshedCandidate());
  for (const [index, component] of (['ordinary_input', 'cache_read', 'cache_write', 'output'] as const).entries()) {
    expect(matchCatalogComponent(event, component, basis)).toMatchObject({
      canonical_model: canonical, provider_basis: 'reference_policy', status: 'matched', price_per_unit: rates[index],
    });
  }
  expect(projectCatalogCost([event, event], basis, event.task_id, refreshedAt, 'output-only-v1')).toMatchObject({
    legacy_unverified_partial_amount: amount, partial_amount: null, complete_amount: null,
  });
  expect(matchCatalogComponent(event, 'output', basis, { providerId: 'reseller' })).toMatchObject({ reason: 'unsupported_provider' });
});

test.each(['gpt-5.6-sol-fast', 'gpt-6.1-sol-high', 'gpt-rosalind-research', 'claude-mythos-5-1-20260901', 'claude-haiku-5-5-20261007'])(
  'October 16 candidate does not infer unsupported model %s', model => {
    const original = makeFlexibleFixture().events[0];
    if (!original) throw new Error('missing_synthetic_event');
    const event = { ...original, payload: { ...original.payload, product: model.startsWith('claude-') ? 'claude_code' as const : 'codex' as const, model } };
    expect(matchCatalogComponent(event, 'output', compilePriceBasis(refreshedCandidate()))).toMatchObject({
      status: 'unavailable', reason: 'unknown_model', price_per_unit: null,
    });
  });

test('October 16 refresh keeps the v3 comparison pin and rejects unknown schema instead of confusing it with catalog version', async () => {
  const previousBytes = readFileSync(new URL('../config/prices/catalogs/reference-catalog-2026-10-08-v3.json', import.meta.url));
  const store = new Store(':memory:');
  try {
    seedProject(store);
    expect(await refreshPriceCatalog(store, () => Promise.resolve(previousBytes), digest(previousBytes), refreshedAt)).toMatchObject({ status: 'updated' });
    const first = preparePriceBasis(store, refreshedAt);
    expect(first.table.id).toBe('catalog-prices-011d292e970f5edb1b183cd77a3a6a364ab42bafbdcfc63706462e50fd58f722');
    const fixture = makeFlexibleFixture();
    fixture.variants.forEach(variant => registerVariant(store, variant));
    const { price_table_id: omitted, ...draft } = fixture.protocol; void omitted;
    registerProtocolWithCatalogDefaults(store, draft, refreshedAt);
    freezeProtocol(store, fixture.protocol.id, beforeRecruitment);
    assignTask(store, { ...assignmentInput, schema_version: 2, task_id: 'task', logical_task_id: 'logical', metadata: fixture.metadata },
      { clock: () => fixture.protocol.recruitment_start, shuffle: rows => rows });
    const bytes = refreshedBytes();
    expect(await refreshPriceCatalog(store, () => Promise.resolve(bytes), digest(bytes), refreshedAt)).toMatchObject({ status: 'updated' });
    const current = preparePriceBasis(store, refreshedAt);
    expect(current.table.id).not.toBe(first.table.id);
    expect(current.table.version).toBe('catalog-v4');
    expect(current.matching_version).toBe('exact-catalog-observed-cache-ttl-v3');
    expect(readPriceBasis(store, first.table.id)).toEqual(first);
    expect(selectTaskPriceTable(store, 'task', refreshedAt)).toEqual({ tableId: first.table.id, selection: 'frozen_comparison' });
    const future = Buffer.from(JSON.stringify({ ...current.catalog, schema_version: 4 }));
    expect(await refreshPriceCatalog(store, () => Promise.resolve(future), digest(future), refreshedAt)).toMatchObject({ reason: 'invalid_price_catalog' });
    expect(preparePriceBasis(store, refreshedAt)).toEqual(current);
    expect(await refreshPriceCatalog(store, () => Promise.resolve(previousBytes), digest(previousBytes), refreshedAt)).toMatchObject({ reason: 'catalog_rollback' });
    expect(readPriceCatalogStatus(store).catalog_version).toBe(4);
  } finally { store.close(); }
});

test('October 16 manifest binds version four bytes under schema three capability', () => {
  const bytes = refreshedBytes();
  const release = preparePriceCatalogRelease(bytes);
  expect(release.manifest).toMatchObject({ schema_version: 1, publisher_id: 'harness-delta',
    catalog_id: 'reference-catalog-2026-10-16', catalog_version: 4, policy_id: 'reference-standard-observed-cache-ttl-v3',
    artifact_sha256: digest(bytes), artifact_bytes: bytes.length, artifact_file: `catalog-${digest(bytes)}.json` });
  expect(release.artifact).toEqual(bytes);
  expect(parsePriceCatalog(JSON.parse(bundledCatalogBytes().toString('utf8'))).catalog_version).toBe(1);
});

test('candidate changes only the source-verified Sonnet row and adds verified request tiers for the literal Haiku ID', () => {
  const previous = parsePriceCatalog(JSON.parse(bundledCatalogBytes().toString('utf8')) as unknown);
  const next = candidate();
  expect(next).toMatchObject({ schema_version: 2, catalog_id: 'reference-catalog-2026-10-08', catalog_version: 2,
    policy_id: 'reference-standard-request-tiers-v2', currency: 'USD', unit_tokens: 1000000,
    verified_at: '2026-10-08T00:00:00Z', published_at: '2026-10-08T00:00:00Z' });
  expect(next.models).toHaveLength(8);
  for (const row of previous.models) {
    const updated = next.models.find(model => model.model === row.model);
    expect(updated).toEqual(row.model === 'claude-sonnet-5-5'
      ? { ...row, rates: { ...row.rates, cache_read: '0.1' }, verified_at: next.verified_at } : row);
  }
  expect(next.models.find(row => row.model === 'claude-haiku-5-5')).toEqual({
    product: 'claude_code', provider_id: 'anthropic', model: 'claude-haiku-5-5', aliases: [], rates: {},
    source_url: 'https://platform.claude.com/docs/en/about-claude/pricing', verified_at: next.verified_at,
    effective_from: null, effective_until: null,
    prompt_tiers: { up_to_100000: { ordinary_input: '0.1', cache_read: '0.01', cache_write: '0.125', output: '0.5' },
      over_100000: { ordinary_input: '0.5', cache_read: '0.05', cache_write: '0.625', output: '2.5' } },
  });
});

test('candidate prices Sonnet cache reads while Haiku tier ambiguity stays missing, never zero', () => {
  const basis = compilePriceBasis(candidate());
  const original = makeFlexibleFixture().events[0]!;
  const sonnet = { ...original, payload: { ...original.payload, product: 'claude_code' as const, model: 'claude-sonnet-5-5' } };
  expect(matchCatalogComponent(sonnet, 'cache_read', basis)).toMatchObject({ status: 'matched', price_per_unit: '0.1' });
  // Synthetic disjoint usage: 100 ordinary input, 20 cache read, 10 inclusive output.
  expect(projectCatalogCost([sonnet], basis, sonnet.task_id, now, 'output-only-v1')).toMatchObject({ partial_amount: null, legacy_unverified_partial_amount: '0.000302', complete_amount: null });
  const haiku = { ...sonnet, payload: { ...sonnet.payload, model: 'claude-haiku-5-5' } };
  for (const component of ['ordinary_input', 'cache_read', 'cache_write', 'output'] as const) {
    expect(matchCatalogComponent(haiku, component, basis)).toMatchObject({ canonical_model: 'claude-haiku-5-5', status: 'unavailable', reason: 'unverified_condition', price_per_unit: null });
  }
  expect(basis.table.entries.some(row => row.model === 'claude-haiku-5-5')).toBe(true);
  expect(projectCatalogCost([haiku], basis, haiku.task_id, now, 'output-only-v1')).toMatchObject({ partial_amount: null, complete_amount: null, unknown_price_components: 3 });
  const fabricated = { ...haiku, payload: { ...haiku.payload, model: 'claude-haiku-5-5-20261007' } };
  expect(matchCatalogComponent(fabricated, 'output', basis)).toMatchObject({ reason: 'unknown_model' });
});

test('candidate refresh preserves v1 bytes, stored tables and the frozen comparison pin', async () => {
  const oldBytes = bundledCatalogBytes();
  expect(digest(oldBytes)).toBe('ae7f1aefab3b78f87bf9259b68b29882edc498b305831e3c2b3146f0968adf24');
  expect(oldBytes).toHaveLength(3476);
  const store = new Store(':memory:');
  try {
    seedProject(store);
    const fixture = makeFlexibleFixture();
    fixture.variants.forEach(variant => registerVariant(store, variant));
    const { price_table_id: omitted, ...draft } = fixture.protocol; void omitted;
    registerProtocolWithCatalogDefaults(store, draft, now);
    const first = preparePriceBasis(store, now);
    expect(first.table.id).toBe('catalog-prices-16acc0a0fb77e373f311591ffd69262641f0aafcd57470abc4509cfee5a7c4e4');
    const firstBytes = store.get<{ payload: string }>('SELECT payload FROM price_catalog_bases WHERE price_table_id=?', [first.table.id])!.payload;
    freezeProtocol(store, fixture.protocol.id, beforeRecruitment);
    assignTask(store, { ...assignmentInput, schema_version: 2, task_id: 'task', logical_task_id: 'logical', metadata: fixture.metadata },
      { clock: () => fixture.protocol.recruitment_start, shuffle: rows => rows });
    const bytes = candidateBytes();
    expect(await refreshPriceCatalog(store, () => Promise.resolve(bytes), digest(bytes), now)).toMatchObject({ status: 'updated' });
    expect(readPriceCatalogStatus(store)).toMatchObject({ catalog_id: 'reference-catalog-2026-10-08', catalog_version: 2 });
    expect(preparePriceBasis(store, now).table.id).not.toBe(first.table.id);
    expect(readPriceBasis(store, first.table.id)).toEqual(first);
    expect(store.get<{ payload: string }>('SELECT payload FROM price_catalog_bases WHERE price_table_id=?', [first.table.id])!.payload).toBe(firstBytes);
    expect(selectTaskPriceTable(store, 'task', now)).toEqual({ tableId: first.table.id, selection: 'frozen_comparison' });
    expect(showProtocol(store, fixture.protocol.id)).toMatchObject({ configuration: { price_table_id: first.table.id } });
    expect(await refreshPriceCatalog(store, () => Promise.resolve(oldBytes), digest(oldBytes), now)).toMatchObject({ reason: 'catalog_rollback' });
    expect(readPriceCatalogStatus(store).catalog_version).toBe(2);
  } finally { store.close(); }
  expect(bundledCatalogBytes()).toEqual(oldBytes);
});

test('candidate release manifest binds exact candidate bytes and leaves the bootstrap at v1', () => {
  const bytes = candidateBytes();
  const release = preparePriceCatalogRelease(bytes);
  expect(release.manifest).toMatchObject({ catalog_id: 'reference-catalog-2026-10-08', catalog_version: 2,
    verified_at: '2026-10-08T00:00:00Z', artifact_sha256: digest(bytes), artifact_bytes: bytes.length });
  expect(release.artifact).toEqual(bytes);
  expect(release.manifest.artifact_file).toBe(`catalog-${digest(bytes)}.json`);
  expect(parsePriceCatalog(JSON.parse(bundledCatalogBytes().toString('utf8')) as unknown).catalog_version).toBe(1);
});
