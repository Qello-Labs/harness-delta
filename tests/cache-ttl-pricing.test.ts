import { readFileSync } from 'node:fs';
import { expect, test, vi } from 'vitest';
import { EventV2Schema, PriceTableSchema, RuntimeEvidenceSchema } from '../src/flexible-contracts.js';
import { bundledCatalogBytes, bundledPriceCatalog, compilePriceBasis, digest, parsePriceCatalog } from '../src/price-catalog.js';
import { projectCatalogCost } from '../src/catalog-cost-report.js';
import { priceUsage } from '../src/pricing.js';
import { makeFlexibleFixture } from './helpers/flexible-fixture.js';
import { Store } from '../src/store.js';
import { Lifecycle } from '../src/lifecycle.js';
import { putUsageWithEvidence } from '../src/runtime-history.js';
import { preparePriceBasis, readPriceBasis, refreshPriceCatalog } from '../src/price-catalog-store.js';
import { captureTaskCostSnapshot, createPriceRevaluation, readPriceRevaluation } from '../src/price-revaluation.js';
import { preparePriceCatalogRelease } from '../src/price-catalog-release.js';
import { refreshOnlinePriceCatalog } from '../src/price-catalog-online.js';
import { resolveSourceCompatibility } from '../src/source-compatibility.js';
import { main } from '../src/cli.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Synthetic metadata only. Aggregate writes remain a single observed component.
const cutoff = '2026-10-09T00:00:00Z';
function basis() {
  const raw = JSON.parse(readFileSync(new URL('../config/prices/catalogs/reference-catalog-2026-10-08.json', import.meta.url), 'utf8')) as Record<string, unknown>;
  return compilePriceBasis(parsePriceCatalog({ ...raw, schema_version: 3, catalog_version: 3, catalog_id: 'synthetic-ttl-v3',
    policy_id: 'reference-standard-observed-cache-ttl-v3', models: [{ product: 'claude_code', provider_id: 'anthropic', model: 'claude-opus-5-5', aliases: [],
      rates: { ordinary_input: '4', cache_read: '0.2', cache_write: '5', cache_write_1h: '8', output: '20' },
      source_url: 'https://platform.claude.com/docs/en/about-claude/pricing', verified_at: '2026-10-08T00:00:00Z', effective_from: null, effective_until: null }] }));
}
function request(five: number, hour: number, ttl: 'observed' | 'missing' | 'error' | 'legacy' = 'observed') {
  const fixture = makeFlexibleFixture();
  const event = EventV2Schema.parse({ ...fixture.events[0], occurred_at: '2026-10-08T00:00:00Z', payload: { ...fixture.events[0]!.payload,
    product: 'claude_code', product_version: '2.1.294', model: 'claude-opus-5-5', runtime_evidence_id: 'runtime',
    input_total: { status: 'observed', value: 10 + 30 + five + hour, reason: null }, cached_input: { status: 'observed', value: 30, reason: null },
    output_total: { status: 'observed', value: 5, reason: null }, ...(hour ? { cache_write_1h_observed: true } : {}),
    ...(ttl === 'legacy' ? {} : { cache_write_ttl: ttl === 'observed' ? { status: 'observed', source: 'product_usage_cache_creation', five_minute_tokens: five, one_hour_tokens: hour }
      : { status: ttl, source: 'product_usage_cache_creation', reason: ttl === 'missing' ? 'not_available' : 'source_error' } }),
    billing_components: [{ kind: 'ordinary_input', reading: { status: 'observed', value: 10, reason: null } },
      { kind: 'cache_read', reading: { status: 'observed', value: 30, reason: null } },
      { kind: 'cache_write', reading: { status: 'observed', value: five + hour, reason: null } },
      { kind: 'output', reading: { status: 'observed', value: 5, reason: null } }] } });
  const runtime = RuntimeEvidenceSchema.parse({ id: 'runtime', task_id: event.task_id, session_id: event.session_id, request_id: 'request', turn_id: null,
    model: event.payload.model, effort: null, product: 'claude_code', product_version: '2.1.294', source: 'product_log', boundary: 'request',
    occurred_at: event.occurred_at, recorded_at: event.occurred_at });
  return { event, runtime };
}

test.each([[20, 0, '0.000246'], [0, 20, '0.000306'], [10, 10, '0.000276'], [0, 0, '0.000146']] as const)('v3 prices disjoint 5m=%i / 1h=%i writes once and leaves source trust unverified', (five, hour, amount) => {
    const { event, runtime } = request(five, hour); const b = basis();
    expect(priceUsage(event, b.table)).toMatchObject({ amount, partial_amount: amount, reasons: [] });
    const report = projectCatalogCost([event, event], b, event.task_id, cutoff, 'output-only-v1', { referenceBinding: true, runtimeEvidence: [runtime] });
    expect(report).toMatchObject({ partial_amount: null, legacy_unverified_partial_amount: amount, complete_amount: null, unpriced_events: 0,
      matching_version: 'exact-catalog-observed-cache-ttl-v3', report_version: 'catalog-observed-cost-cache-ttl-v3' });
    expect(report.matches.filter(match => match.component === 'cache_write')).toEqual(expect.arrayContaining([
      expect.objectContaining({ cache_ttl: '5m', status: 'matched', price_per_unit: '5' }),
      expect.objectContaining({ cache_ttl: '1h', status: 'matched', price_per_unit: '8' }),
    ]));
  });

test.each(['legacy', 'missing', 'error'] as const)('v3 excludes %s write TTL without assuming five minutes', ttl => {
  const { event } = request(10, 10, ttl); const b = basis();
  expect(priceUsage(event, b.table)).toMatchObject({ amount: null, partial_amount: '0.000146', reasons: ['unpriced_component'] });
  const report = projectCatalogCost([event], b, event.task_id, cutoff, 'output-only-v1');
  expect(report).toMatchObject({ legacy_unverified_partial_amount: '0.000146', complete_amount: null, unpriced_events: 1,
    unknown_price_components: 1, price_reasons: ['unverified_condition'] });
});

test('v3 does not treat absence of the historical one-hour flag as observed five-minute TTL', () => {
  const { event } = request(20, 0, 'legacy');
  expect(priceUsage(event, basis().table).partial_amount).toBe('0.000146');
});

test('old basis and one-hour boolean retain exclusions with new metadata', () => {
  const old = compilePriceBasis(bundledPriceCatalog());
  expect(old.table.id).toBe('catalog-prices-16acc0a0fb77e373f311591ffd69262641f0aafcd57470abc4509cfee5a7c4e4');
  expect(priceUsage(request(10, 10).event, old.table)).toMatchObject({ partial_amount: '0.000146', reasons: ['unpriced_component'] });
  expect(priceUsage(request(20, 0).event, old.table).amount).toBe('0.000246');
});

test('TTL contract refuses inconsistent counts, foreign source and ambiguous rates', () => {
  const { event } = request(10, 10);
  for (const patch of [{ five_minute_tokens: 11 }, { one_hour_tokens: -1 }, { one_hour_tokens: 0.5 }, { five_minute_tokens: Number.MAX_SAFE_INTEGER }, { source: 'guessed' }]) {
    expect(EventV2Schema.safeParse({ ...event, payload: { ...event.payload, cache_write_ttl: { ...event.payload.cache_write_ttl, ...patch } } }).success).toBe(false);
  }
  const b = basis(); const rate = b.table.entries.find(row => row.cache_ttl === '5m')!;
  const { cache_ttl: ignored, ...flat } = rate; void ignored;
  expect(PriceTableSchema.safeParse({ ...b.table, entries: [...b.table.entries, flat] }).success).toBe(false);
  expect(PriceTableSchema.safeParse({ ...b.table, entries: [...b.table.entries, rate] }).success).toBe(false);
});

test('synthetic product projection retains Claude-format TTL metadata without admitting other native products', () => {
  const { event } = request(10, 10);
  expect(EventV2Schema.safeParse({ ...event, payload: { ...event.payload, product: 'synthetic' } }).success).toBe(true);
  expect(EventV2Schema.safeParse({ ...event, payload: { ...event.payload, product: 'codex' } }).success).toBe(false);
});

const candidateBytes = () => readFileSync(new URL('../config/prices/catalogs/reference-catalog-2026-10-08-v3.json', import.meta.url));
const candidateBasis = () => compilePriceBasis(parsePriceCatalog(JSON.parse(candidateBytes().toString('utf8')) as unknown));

test.each([[100000, '0.01000105'], [100001, '0.05000575']] as const)('v3 Haiku mixed TTL uses the full prompt tier (%i)', (total, amount) => {
  const r = request(10, 10);
  r.event.payload.model = r.runtime.model = 'claude-haiku-5-5';
  r.event.payload.input_total.value = total;
  r.event.payload.billing_components[0]!.reading = { status: 'observed', value: total - 50, reason: null };
  expect(priceUsage(r.event, candidateBasis().table, 'output-only-v1', [r.runtime]).partial_amount).toBe(amount);
  const missing = projectCatalogCost([r.event], candidateBasis(), r.event.task_id, cutoff, 'output-only-v1');
  expect(missing).toMatchObject({ legacy_unverified_partial_amount: null, price_reasons: ['unverified_condition'] });
});

test('v3 missing one-hour rate keeps five-minute and other components with explicit missing_rate', () => {
  const full = basis(); const { event } = request(10, 10);
  const reduced = compilePriceBasis(parsePriceCatalog({ ...full.catalog, models: full.catalog.models.map(row => {
    const { cache_write_1h: removed, ...rates } = row.rates; void removed;
    return { ...row, rates };
  }) }));
  expect(projectCatalogCost([event], reduced, event.task_id, cutoff, 'output-only-v1')).toMatchObject({ legacy_unverified_partial_amount: '0.000196',
    complete_amount: null, unpriced_events: 1, price_reasons: ['missing_rate'] });
});

test('v3 rates do not promote compatibility trust or revive invalidated source usage', () => {
  const r = request(10, 10);
  r.event.payload.product_version = r.runtime.product_version = '2.1.297';
  r.event.payload.source_compatibility = resolveSourceCompatibility('claude_code', '2.1.297', 'claude_workflow')!;
  expect(projectCatalogCost([r.event], basis(), r.event.task_id, cutoff, 'output-only-v1')).toMatchObject({ partial_amount: null,
    compatibility_unverified_partial_amount: '0.000276', legacy_unverified_partial_amount: null, complete_amount: null });
  r.event.payload.source_compatibility.state = 'invalidated';
  expect(projectCatalogCost([r.event], basis(), r.event.task_id, cutoff, 'output-only-v1')).toMatchObject({ partial_amount: null,
    compatibility_unverified_partial_amount: null, complete_amount: null, matches: [] });
});

test.each(['observed', 'legacy'] as const)('frozen %s TTL survives refresh/repricing without historical rewrite or live backfill', async ttl => {
  const store = new Store(':memory:'); const now = '2026-10-09T01:00:00Z';
  try {
    const r = request(10, 10, ttl); const life = new Lifecycle(store, () => '2026-10-08T00:00:00Z');
    life.registerProject(r.event.project_id, process.cwd());
    life.createTask(r.event.project_id, r.event.task_id, { type: 'feature', expected_size: 'small', assignee: 'user', product: 'claude_code', model: 'claude-opus-5-5', criterion_ids: ['criterion'] });
    life.start(r.event.task_id);
    store.execute('INSERT INTO sessions(id,project_id,task_id,product,source_path) VALUES (?,?,?,?,?)', [r.event.session_id, r.event.project_id, r.event.task_id, 'claude_code', '/synthetic/metadata']);
    putUsageWithEvidence(store, r.event, r.runtime);
    const old = preparePriceBasis(store, now);
    const input = captureTaskCostSnapshot(store, { inputId: 'frozen', taskId: r.event.task_id, tableId: old.table.id, cutoff, inputBasis: 'output-only-v1' }, now);
    const result = createPriceRevaluation(store, { id: 'old', inputId: input.input_id, targetTableId: old.table.id }, now);
    const frozen = store.get('SELECT payload,hash FROM price_cost_inputs WHERE id=?', [input.input_id]);
    const saved = store.get('SELECT payload FROM price_revaluations WHERE id=?', ['old']);
    await refreshPriceCatalog(store, () => Promise.resolve(candidateBytes()), digest(candidateBytes()), now);
    const target = preparePriceBasis(store, now);
    store.execute('DELETE FROM runtime_evidence', []); store.execute('DELETE FROM events', []);
    const repriced = createPriceRevaluation(store, { id: 'new', inputId: input.input_id, targetTableId: target.table.id }, now);
    expect(repriced.tasks[0]?.cost.legacy_unverified_partial_amount).toBe(ttl === 'observed' ? '0.000276' : '0.000146');
    expect(repriced.tasks[0]?.usage_snapshot_hash).toBe(input.tasks[0]?.usage_snapshot_hash);
    expect(repriced.complete_amount).toBeNull();
    expect(readPriceRevaluation(store, 'old')).toEqual(result);
    expect(readPriceBasis(store, old.table.id)).toEqual(old);
    expect(store.get('SELECT payload,hash FROM price_cost_inputs WHERE id=?', [input.input_id])).toEqual(frozen);
    expect(store.get('SELECT payload FROM price_revaluations WHERE id=?', ['old'])).toEqual(saved);
  } finally { store.close(); }
});

test('candidate release binds bytes/policy and new client retains accepted prices on hash/future-schema failures', async () => {
  const bytes = candidateBytes(); const release = preparePriceCatalogRelease(bytes);
  expect(release.manifest).toMatchObject({ catalog_version: 3, policy_id: 'reference-standard-observed-cache-ttl-v3', artifact_sha256: digest(bytes), artifact_bytes: bytes.length });
  expect(release.artifact).toEqual(bytes);
  // Original immutable bootstrap bytes and semantic basis stay exact.
  expect(digest(bundledCatalogBytes())).toBe('ae7f1aefab3b78f87bf9259b68b29882edc498b305831e3c2b3146f0968adf24');
  const store = new Store(':memory:'); const now = '2026-10-09T01:00:00Z';
  const source = { publisherId: 'harness-delta', manifestUrl: 'https://catalog.example.invalid/manifest.json' };
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(url => Promise.resolve(new Response((typeof url === 'string' ? url : url instanceof URL ? url.href : url.url) === source.manifestUrl ? JSON.stringify(release.manifest) : bytes)));
  try {
    const old = preparePriceBasis(store, now);
    expect(await refreshOnlinePriceCatalog(store, source, { fetch }, now)).toMatchObject({ status: 'updated' });
    const current = preparePriceBasis(store, now);
    expect(current).toEqual(candidateBasis());
    expect(readPriceBasis(store, old.table.id)).toEqual(old);
    const future = Buffer.from(JSON.stringify({ ...current.catalog, schema_version: 4, catalog_version: 4 }));
    expect(await refreshPriceCatalog(store, () => Promise.resolve(future), digest(future), now)).toMatchObject({ status: 'failed', reason: 'invalid_price_catalog' });
    expect(await refreshPriceCatalog(store, () => Promise.resolve(bytes), '0'.repeat(64), now)).toMatchObject({ status: 'failed', reason: 'catalog_hash_mismatch' });
    expect(preparePriceBasis(store, now)).toEqual(current);
    expect(() => parsePriceCatalog({ ...current.catalog, schema_version: 2, policy_id: 'reference-standard-request-tiers-v2' })).toThrow('invalid_price_catalog');
  } finally { store.close(); }
});

test('CLI explains TTL matches and keeps unpriced old writes distinct from observed usage', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'synthetic-ttl-cli-')); const db = join(directory, 'metadata.sqlite');
  const store = new Store(db); let output = '';
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(value => { output += String(value); return true; });
  try {
    const r = request(10, 10); const life = new Lifecycle(store, () => '2026-10-08T00:00:00Z');
    life.registerProject(r.event.project_id, directory);
    life.createTask(r.event.project_id, r.event.task_id, { type: 'feature', expected_size: 'small', assignee: 'user', product: 'claude_code', model: 'claude-opus-5-5', criterion_ids: ['criterion'] });
    life.start(r.event.task_id);
    store.execute('INSERT INTO sessions(id,project_id,task_id,product,source_path) VALUES (?,?,?,?,?)', [r.event.session_id, r.event.project_id, r.event.task_id, 'claude_code', '/synthetic/metadata']);
    putUsageWithEvidence(store, r.event, r.runtime);
    const legacy = request(10, 10, 'legacy'); legacy.event.id = legacy.event.source_key = 'legacy'; legacy.runtime.id = legacy.event.payload.runtime_evidence_id = 'legacy-runtime'; legacy.runtime.request_id = 'legacy-request';
    putUsageWithEvidence(store, legacy.event, legacy.runtime);
    await refreshPriceCatalog(store, () => Promise.resolve(candidateBytes()), digest(candidateBytes()), '2026-10-09T01:00:00Z');
    expect(await main(['--db', db, 'price-table', 'estimate-task', r.event.task_id, '--cutoff', cutoff])).toBe(0);
    const report = JSON.parse(output) as Record<string, unknown>;
    expect(report).toMatchObject({ matching_version: 'exact-catalog-observed-cache-ttl-v3', legacy_unverified_partial_amount: '0.000422', complete_amount: null,
      event_count: 2, unpriced_events: 1, price_reasons: ['unverified_condition'] });
    expect(report.matches).toEqual(expect.arrayContaining([expect.objectContaining({ component: 'cache_write', cache_ttl: '1h', status: 'matched', price_per_unit: '8' }),
      expect.objectContaining({ event_id: 'legacy', component: 'cache_write', status: 'unavailable', reason: 'unverified_condition' })]));
    expect(output).not.toContain(directory);
  } finally { stdout.mockRestore(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});
