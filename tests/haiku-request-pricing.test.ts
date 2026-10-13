import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { compilePriceBasis, digest, parsePriceCatalog } from '../src/price-catalog.js';
import { projectCatalogCost } from '../src/catalog-cost-report.js';
import { projectObservedCost } from '../src/observed-cost-report.js';
import { RuntimeEvidenceSchema, EventV2Schema, PriceTableSchema } from '../src/flexible-contracts.js';
import { Lifecycle } from '../src/lifecycle.js';
import { Store } from '../src/store.js';
import { putUsageWithEvidence, recordRuntimeEvidence } from '../src/runtime-history.js';
import { preparePriceBasis, refreshPriceCatalog } from '../src/price-catalog-store.js';
import { readReferenceTaskCostReport } from '../src/price-catalog-task-report.js';
import { captureTaskCostSnapshot, createPriceRevaluation, readPriceRevaluation } from '../src/price-revaluation.js';
import { FlexibleSnapshotInputSchema, projectFlexibleComparison } from '../src/reports/flexible-comparison.js';
import { canonicalJson } from '../src/reports/comparison-snapshot.js';
import { resolveSourceCompatibility } from '../src/source-compatibility.js';
import { makeFlexibleFixture } from './helpers/flexible-fixture.js';

const now = '2026-10-08T12:00:00Z';
const cutoff = '2026-01-01T00:00:10Z';
const bytes = () => readFileSync(new URL('../config/prices/catalogs/reference-catalog-2026-10-08.json', import.meta.url));
const basis = () => compilePriceBasis(parsePriceCatalog(JSON.parse(bytes().toString('utf8')) as unknown));
const observed = (value: number) => ({ status: 'observed' as const, value, reason: null });
function request(id: string, ordinary: number, cacheRead = 0, cacheWrite = 0) {
  const runtime = RuntimeEvidenceSchema.parse({ id: `runtime-${id}`, task_id: 'task', session_id: 'session', turn_id: null,
    request_id: id, model: 'claude-haiku-5-5', effort: null, product: 'claude_code', product_version: '2.1.291',
    source: 'product_log', boundary: 'request', occurred_at: '2026-01-01T00:00:02Z', recorded_at: '2026-01-01T00:00:03Z' });
  const event = EventV2Schema.parse({ id, source_key: id, task_id: 'task', project_id: 'project', session_id: 'session',
    occurred_at: runtime.occurred_at, payload: { schema_version: 2, kind: 'usage', product: runtime.product,
      product_version: runtime.product_version, model: runtime.model, epoch: 'epoch', attribution: 'verified', runtime_evidence_id: runtime.id,
      input_total: observed(ordinary + cacheRead + cacheWrite), cached_input: observed(cacheRead), output_total: observed(10), reasoning_output: observed(5),
      billing_components: [{ kind: 'ordinary_input', reading: observed(ordinary) }, { kind: 'cache_read', reading: observed(cacheRead) },
        { kind: 'cache_write', reading: observed(cacheWrite) }, { kind: 'output', reading: observed(10) }] } });
  return { event, runtime };
}

test.each([[99999, '0.0100049'], [100000, '0.010005'], [100001, '0.0500255']] as const)('Haiku whole-request rate at %i input tokens', (tokens, amount) => {
  const { event, runtime } = request('r', tokens);
  const report = projectCatalogCost([event], basis(), 'task', cutoff, 'output-only-v1', { referenceBinding: true, runtimeEvidence: [runtime] });
  expect(report).toMatchObject({ partial_amount: null, legacy_unverified_partial_amount: amount, complete_amount: null, unknown_price_components: 0 });
  expect(projectObservedCost([event], basis().table, 'task', cutoff, 'output-only-v1', [runtime]).legacy_unverified_partial_amount).toBe(amount);
});

test('cache reads and writes count toward threshold, and mixed requests choose separate whole-request tiers', () => {
  const short = request('short', 1, 99998, 1); // 100000 total
  const long = request('long', 1, 99999, 1); // 100001 total
  const report = projectCatalogCost([short.event, long.event, long.event], basis(), 'task', cutoff, 'output-only-v1', { referenceBinding: true, runtimeEvidence: [short.runtime, long.runtime] });
  expect(report).toMatchObject({ event_count: 2, partial_amount: null, legacy_unverified_partial_amount: '0.00603128', complete_amount: null });
  expect(report.matches.filter(row => row.component === 'output').map(row => row.price_per_unit).sort()).toEqual(['0.5', '2.5']);
});

for (const kind of ['no-runtime', 'session-boundary', 'self-attested', 'missing-total', 'missing-cache', 'inconsistent-total', 'foreign-session', 'duplicate-runtime', 'request-alias', 'wrong-model', 'missing-request-id', 'missing-cache-summary'] as const) {
  test(`Haiku ${kind} evidence stays unavailable while a verified request stays partial`, () => {
    const good = request('good', 100000);
    const bad = request('bad', 100001);
    let runtimes = [good.runtime, bad.runtime];
    if (kind === 'no-runtime') runtimes = [good.runtime];
    if (kind === 'session-boundary') bad.runtime.boundary = 'session';
    if (kind === 'self-attested') bad.runtime.source = 'self_attested';
    if (kind === 'foreign-session') bad.runtime.session_id = 'other';
    if (kind === 'duplicate-runtime') runtimes.push({ ...bad.runtime });
    if (kind === 'request-alias') runtimes.push({ ...bad.runtime, id: 'runtime-alias' });
    if (kind === 'wrong-model') bad.runtime.model = 'claude-haiku-4-5';
    if (kind === 'missing-request-id') bad.runtime.request_id = null;
    if (kind === 'missing-cache-summary') bad.event.payload.cached_input = { status: 'missing', value: null, reason: 'not_available' };
    if (kind === 'missing-total') bad.event.payload.input_total = { status: 'missing', value: null, reason: 'not_available' };
    if (kind === 'missing-cache') bad.event.payload.billing_components[1]!.reading = { status: 'missing', value: null, reason: 'not_available' };
    if (kind === 'inconsistent-total') bad.event.payload.input_total = observed(100000);
    const report = projectCatalogCost([good.event, bad.event], basis(), 'task', cutoff, 'output-only-v1', { referenceBinding: true, runtimeEvidence: runtimes });
    expect(report).toMatchObject({ legacy_unverified_partial_amount: '0.010005', complete_amount: null, unavailable_events: 1 });
    expect(report.matches.filter(row => row.event_id === 'bad').every(row => row.price_per_unit === null)).toBe(true);
    expect(report.price_reasons).toContain('unverified_condition');
  });
}

test.each(['unique', 'aliased', 'one-hour'] as const)('stored %s request evidence is used for task reports and retained for immutable repricing', async identity => {
  const store = new Store(':memory:');
  try {
    const life = new Lifecycle(store, () => '2026-01-01T00:00:00Z');
    life.registerProject('project', process.cwd());
    life.createTask('project', 'task', { type: 'feature', expected_size: 'small', assignee: 'user', product: 'claude_code', model: 'claude-haiku-5-5', criterion_ids: ['criterion'] });
    life.start('task');
    store.execute("INSERT INTO sessions(id,project_id,task_id,product,source_path) VALUES ('session','project','task','claude_code','/synthetic/metadata')", []);
    const r = identity === 'one-hour' ? request('r', 99980, 0, 20) : request('r', 100000);
    if (identity === 'one-hour') r.event.payload.cache_write_1h_observed = true;
    putUsageWithEvidence(store, r.event, r.runtime);
    if (identity === 'aliased') recordRuntimeEvidence(store, { ...r.runtime, id: 'unlinked-alias' });
    const expected = identity === 'unique' ? '0.010005' : identity === 'one-hour' ? '0.010003' : null;
    const old = preparePriceBasis(store, now);
    captureTaskCostSnapshot(store, { inputId: 'old-input', taskId: 'task', tableId: old.table.id, cutoff, inputBasis: 'output-only-v1' }, now);
    const original = createPriceRevaluation(store, { id: 'old-result', inputId: 'old-input', targetTableId: old.table.id }, now);
    const saved = JSON.stringify(original);
    expect(original.tasks[0]?.cost.legacy_unverified_partial_amount).toBeNull();
    expect(await refreshPriceCatalog(store, () => Promise.resolve(bytes()), digest(bytes()), now)).toMatchObject({ status: 'updated' });
    const next = preparePriceBasis(store, now);
    expect(readReferenceTaskCostReport(store, 'task', cutoff, 'output-only-v1', now).legacy_unverified_partial_amount).toBe(expected);
    store.execute('DELETE FROM runtime_evidence', []); store.execute('DELETE FROM events', []);
    const repriced = createPriceRevaluation(store, { id: 'new-result', inputId: 'old-input', targetTableId: next.table.id }, now);
    expect(repriced.tasks[0]?.cost.legacy_unverified_partial_amount).toBe(expected);
    expect(JSON.stringify(readPriceRevaluation(store, 'old-result'))).toBe(saved);
    expect(repriced.complete_amount).toBeNull();
  } finally { store.close(); }
});

test('known one-hour writes still count toward the prompt tier while their price stays unavailable', () => {
  const r = request('long-one-hour', 1, 99999, 1); r.event.payload.cache_write_1h_observed = true;
  const report = projectCatalogCost([r.event], basis(), 'task', cutoff, 'output-only-v1', { referenceBinding: true, runtimeEvidence: [r.runtime] });
  expect(report).toMatchObject({ legacy_unverified_partial_amount: '0.00502545', complete_amount: null, unknown_price_components: 1, price_reasons: ['unverified_condition'] });
  expect(report.matches.find(row => row.component === 'cache_write')).toMatchObject({ prompt_tokens: 100001, prompt_tier: 'over_100000', price_per_unit: null });
  expect(projectObservedCost([r.event], basis().table, 'task', cutoff, 'output-only-v1', [r.runtime]).legacy_unverified_partial_amount).toBe('0.00502545');
});

test('known prompt with missing output retains observed input as partial without filling output', () => {
  const r = request('partial', 100000);
  r.event.payload.output_total = { status: 'missing', value: null, reason: 'not_available' };
  r.event.payload.billing_components[3]!.reading = { status: 'missing', value: null, reason: 'not_available' };
  expect(projectCatalogCost([r.event], basis(), 'task', cutoff, 'output-only-v1', { referenceBinding: true, runtimeEvidence: [r.runtime] }))
    .toMatchObject({ legacy_unverified_partial_amount: '0.01', complete_amount: null });
});

test('tier schema refuses a flat Haiku shortcut, old-policy tiers and ambiguous compiled entries', () => {
  const catalog = parsePriceCatalog(JSON.parse(bytes().toString('utf8')) as unknown);
  expect(() => parsePriceCatalog({ ...catalog, schema_version: 1, policy_id: 'reference-standard-v1' })).toThrow('invalid_price_catalog');
  const compiled = basis().table;
  const output = compiled.entries.find(row => row.model === 'claude-haiku-5-5' && row.component === 'output')!;
  const { prompt_tier: omitted, ...flat } = output; void omitted;
  expect(PriceTableSchema.safeParse({ ...compiled, entries: [...compiled.entries, flat] }).success).toBe(false);
  expect(() => parsePriceCatalog({ ...catalog, models: catalog.models.map(row => row.model === 'claude-haiku-5-5' ? { ...row, rates: { output: '0.5' } } : row) })).toThrow('invalid_price_catalog');
});

test('legacy message totals cannot establish a request tier', () => {
  const r = request('legacy', 100000);
  const u = r.event.payload;
  const legacy = { ...r.event, payload: { kind: 'usage' as const, input_total: u.input_total, cached_input: u.cached_input,
    output_total: u.output_total, reasoning_output: u.reasoning_output, product: u.product, product_version: u.product_version,
    model: 'claude-haiku-5-5', epoch: u.epoch } };
  expect(projectCatalogCost([legacy], basis(), 'task', cutoff, 'output-only-v1', { referenceBinding: true, runtimeEvidence: [r.runtime] }))
    .toMatchObject({ legacy_unverified_partial_amount: null, complete_amount: null, price_reasons: ['unverified_condition'] });
});

test('flexible comparison uses frozen eligible request evidence and rejects late evidence', () => {
  const f = makeFlexibleFixture(); const r = request('flex', 100001);
  r.event.task_id = 'task-1'; r.runtime.task_id = 'task-1';
  const assignment = { assignment_id: 'assignment-1', task_id: 'task-1', variant_id: 'variant-a', assigned_at: f.coverage.window_start,
    recorded_at: f.coverage.window_start, followup_ends_at: f.coverage.window_end, stratum_id: 'stratum-user-1', block_id: 'block-1',
    metadata: f.metadata, environment_id: 'environment-1', started_at: f.coverage.window_start, first_completed_at: null,
    first_assessed_at: null, first_success: null, finalized_at: null, outcome: null, rework_starts: [], active_intervals: [],
    observations: [], confirmations: [], deviations: [], usages: [{ event: r.event, recorded_at: r.runtime.recorded_at }],
    runtime: [r.runtime], gaps: [], coverage: f.coverage };
  const input = FlexibleSnapshotInputSchema.parse({ schema_version: 2, descriptive_version: 'flexible-cost-descriptive-1', report_id: 'flex',
    protocol: { ...f.protocol, price_table_id: basis().table.id }, variants: f.variants, cutoff, evaluated_at: cutoff, data_revision: 1, snapshot_sequence: 1,
    revision_reason: 'initial', supersedes_report_id: null, assignments: [assignment], registrations: [], price_table: basis().table,
    formula_version: 'decimal160-disjoint-v1' });
  expect(projectFlexibleComparison(input).tasks[0]?.cost).toMatchObject({ legacy_unverified_partial_amount: '0.0500255', complete_amount: null });
  const late = { ...input, assignments: [{ ...input.assignments[0]!, runtime: [{ ...r.runtime, recorded_at: '2026-01-01T00:00:11Z' }] }] };
  expect(projectFlexibleComparison(late).tasks[0]?.cost.legacy_unverified_partial_amount).toBeNull();
  expect(projectFlexibleComparison(input).tasks[0]?.cost.legacy_unverified_partial_amount).toBe('0.0500255');
});

test('retained schema-one input does not fetch newly available request evidence', async () => {
  const store = new Store(':memory:');
  try {
    const life = new Lifecycle(store, () => '2026-01-01T00:00:00Z');
    life.registerProject('project', process.cwd());
    life.createTask('project', 'task', { type: 'feature', expected_size: 'small', assignee: 'user', product: 'claude_code', model: 'claude-haiku-5-5', criterion_ids: ['criterion'] });
    life.start('task');
    store.execute("INSERT INTO sessions(id,project_id,task_id,product,source_path) VALUES ('session','project','task','claude_code','/synthetic/metadata')", []);
    const r = request('late', 100000); putUsageWithEvidence(store, r.event, r.runtime);
    store.execute('DELETE FROM runtime_evidence', []);
    const old = preparePriceBasis(store, now);
    const snapshot = captureTaskCostSnapshot(store, { inputId: 'without-runtime', taskId: 'task', tableId: old.table.id, cutoff, inputBasis: 'output-only-v1' }, now);
    expect(snapshot.schema_version).toBe(1);
    expect(snapshot.tasks[0]).not.toHaveProperty('runtime_evidence');
    putUsageWithEvidence(store, r.event, r.runtime);
    await refreshPriceCatalog(store, () => Promise.resolve(bytes()), digest(bytes()), now);
    const next = preparePriceBasis(store, now);
    expect(readReferenceTaskCostReport(store, 'task', cutoff, 'output-only-v1', now).legacy_unverified_partial_amount).toBe('0.010005');
    const result = createPriceRevaluation(store, { id: 'still-unavailable', inputId: snapshot.input_id, targetTableId: next.table.id }, now);
    expect(result.tasks[0]?.cost).toMatchObject({ legacy_unverified_partial_amount: null, complete_amount: null, price_reasons: ['unverified_condition'] });
  } finally { store.close(); }
});

// Losing runtime evidence during signature integration would make the tier unavailable.
// Recombining source trust would wrongly promote these inherited parser observations.
test('conditional source trust retains request tiers and excludes invalidated references', () => {
  const conditional = request('conditional', 100001);
  const legacy = request('legacy-reference', 100000);
  const invalidated = request('invalidated', 100001);
  for (const row of [conditional, invalidated]) {
    row.event.payload.product_version = row.runtime.product_version = '2.1.297';
    row.event.payload.source_compatibility = resolveSourceCompatibility('claude_code', '2.1.297', 'claude_workflow')!;
  }
  invalidated.event.payload.source_compatibility = { ...invalidated.event.payload.source_compatibility!, state: 'invalidated' };
  const report = projectCatalogCost([conditional.event, legacy.event, invalidated.event], basis(), 'task', cutoff, 'output-only-v1',
    { referenceBinding: true, runtimeEvidence: [conditional.runtime, legacy.runtime, invalidated.runtime] });
  expect(report).toMatchObject({ partial_amount: null, compatibility_unverified_partial_amount: '0.0500255', legacy_unverified_partial_amount: '0.010005',
    compatibility: { verified_events: 0, compatibility_unverified_events: 1, legacy_unverified_events: 1, invalidated_events: 1 }, complete_amount: null });
  expect(report.matches.some(match => match.event_id === 'invalidated')).toBe(false);
  const missing = projectCatalogCost([conditional.event], basis(), 'task', cutoff, 'output-only-v1', { referenceBinding: true });
  expect(missing).toMatchObject({ partial_amount: null, compatibility_unverified_partial_amount: null, unavailable_events: 1, price_reasons: ['unverified_condition'] });
});

// Frozen schema-2 results must validate old serialized arithmetic using retained request
// evidence, then expose today's trust partitions without modifying historical bytes.
test('historical schema-two revaluation retains request evidence without live backfill or rewrite', async () => {
  const store = new Store(':memory:');
  try {
    const life = new Lifecycle(store, () => '2026-01-01T00:00:00Z');
    life.registerProject('project', process.cwd());
    life.createTask('project', 'task', { type: 'feature', expected_size: 'small', assignee: 'user', product: 'claude_code', model: 'claude-haiku-5-5', criterion_ids: ['criterion'] });
    life.start('task');
    store.execute("INSERT INTO sessions(id,project_id,task_id,product,source_path) VALUES ('session','project','task','claude_code','/synthetic/metadata')", []);
    const r = request('retained', 100001); putUsageWithEvidence(store, r.event, r.runtime);
    const old = preparePriceBasis(store, now);
    const snapshot = captureTaskCostSnapshot(store, { inputId: 'historical-input', taskId: 'task', tableId: old.table.id, cutoff, inputBasis: 'output-only-v1' }, now);
    expect(snapshot.schema_version).toBe(2);
    expect(snapshot.tasks[0]?.runtime_evidence).toEqual([r.runtime]);
    await refreshPriceCatalog(store, () => Promise.resolve(bytes()), digest(bytes()), now);
    const next = preparePriceBasis(store, now);
    const result = createPriceRevaluation(store, { id: 'current-result', inputId: snapshot.input_id, targetTableId: next.table.id }, now);
    const historical = { ...result, revaluation_id: 'historical-result', tasks: snapshot.tasks.map(task => ({ task_id: task.task_id, original_variant_id: task.original_variant_id,
      usage_snapshot_hash: task.usage_snapshot_hash, observation_snapshot_hash: task.observation_snapshot_hash, original_partial_amount: task.original_partial_amount,
      cost: projectCatalogCost(task.events as typeof r.event[], next, task.task_id, task.cutoff, task.input_basis,
        { referenceBinding: true, runtimeEvidence: task.runtime_evidence ?? [] }, true), source_reasons: task.reasons })) };
    expect(historical.tasks[0]?.cost).toMatchObject({ partial_amount: '0.0500255' });
    expect(historical.tasks[0]?.cost).not.toHaveProperty('legacy_unverified_partial_amount');
    const frozen = canonicalJson(historical);
    store.execute('INSERT INTO price_revaluations(id,input_id,target_table_id,payload) VALUES (?,?,?,?)', ['historical-result', snapshot.input_id, next.table.id, frozen]);
    const frozenInput = store.get('SELECT payload,hash FROM price_cost_inputs WHERE id=?', [snapshot.input_id]);
    store.execute('DELETE FROM runtime_evidence', []); store.execute('DELETE FROM events', []);
    const current = readPriceRevaluation(store, 'historical-result');
    expect(current).toMatchObject({ tasks: [{ cost: { partial_amount: null, legacy_unverified_partial_amount: '0.0500255', complete_amount: null } }] });
    expect(store.get<{payload:string}>('SELECT payload FROM price_revaluations WHERE id=?', ['historical-result'])?.payload).toBe(frozen);
    expect(store.get('SELECT payload,hash FROM price_cost_inputs WHERE id=?', [snapshot.input_id])).toEqual(frozenInput);
  } finally { store.close(); }
});
