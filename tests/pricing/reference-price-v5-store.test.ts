import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { main } from '../../src/cli.js';
import { Lifecycle } from '../../src/core/lifecycle.js';
import { putUsageWithEvidence } from '../../src/core/runtime-history.js';
import { EventV2Schema, RuntimeEvidenceSchema } from '../../src/flexible-contracts.js';
import { digest } from '../../src/pricing/price-catalog.js';
import { preparePriceBasis, readPriceBasis, refreshPriceCatalog } from '../../src/pricing/price-catalog-store.js';
import { captureTaskCostSnapshot, createPriceRevaluation, readPriceRevaluation } from '../../src/comparison/reports/price-revaluation.js';
import { Store } from '../../src/store.js';
import { makeFlexibleFixture } from '../helpers/flexible-fixture.js';

const now = '2026-11-25T12:00:00Z';
const cutoff = '2026-01-01T00:00:10Z';
const bytes = (name = 'reference-catalog-2026-11-25-v5.json') => readFileSync(new URL(`../../config/prices/catalogs/${name}`, import.meta.url));

function seedUsage(store: Store) {
  const fixture = makeFlexibleFixture();
  const original = fixture.events[0];
  const originalRuntime = fixture.runtime[0];
  if (!original || !originalRuntime) throw new Error('missing_synthetic_metadata');
  const event = EventV2Schema.parse({
    ...original,
    payload: {
      ...original.payload,
      product: 'codex',
      product_version: '0.171.0',
      model: 'gpt-6-astra',
      input_total: { status: 'observed', value: 140, reason: null },
      billing_components: [...original.payload.billing_components, { kind: 'cache_write', reading: { status: 'observed', value: 20, reason: null } }]
    }
  });
  const runtime = RuntimeEvidenceSchema.parse({
    ...originalRuntime,
    product: event.payload.product,
    product_version: event.payload.product_version,
    model: event.payload.model,
    occurred_at: event.occurred_at,
    recorded_at: event.occurred_at
  });
  const life = new Lifecycle(store, () => '2026-01-01T00:00:00Z');
  life.registerProject(event.project_id, process.cwd());
  life.createTask(event.project_id, event.task_id, {
    type: 'feature',
    expected_size: 'small',
    assignee: 'user',
    product: 'codex',
    model: event.payload.model,
    criterion_ids: ['criterion']
  });
  life.start(event.task_id);
  store.execute('INSERT INTO sessions(id,project_id,task_id,product,source_path) VALUES (?,?,?,?,?)', [
    event.session_id,
    event.project_id,
    event.task_id,
    'codex',
    '/synthetic/metadata'
  ]);
  putUsageWithEvidence(store, event, runtime);
  return event;
}

test.each([
  [
    'reference-catalog-2026-10-08-v3.json',
    '3ecd87627df79d86a1c562635e119f0d51c30dd62c692fb3d7615710d55691ae',
    'catalog-prices-011d292e970f5edb1b183cd77a3a6a364ab42bafbdcfc63706462e50fd58f722'
  ],
  [
    'reference-catalog-2026-10-16-v4.json',
    'b3f05b7efe58930f300345c420de2877c94f35631fc91a11167a581695429dc6',
    'catalog-prices-ba18fb0c978390b16ec3d914006e7288371b6746d0c7d5af37702eadf1725b84'
  ]
] as const)('v5 refresh preserves the frozen bytes and write prices of %s', async (name, hash, tableId) => {
  const store = new Store(':memory:');
  try {
    const event = seedUsage(store);
    const oldBytes = bytes(name);
    expect(digest(oldBytes)).toBe(hash);
    expect(await refreshPriceCatalog(store, () => Promise.resolve(oldBytes), hash, now)).toMatchObject({ status: 'updated' });
    const old = preparePriceBasis(store, now);
    expect(old.table.id).toBe(tableId);
    const input = captureTaskCostSnapshot(store, { inputId: 'frozen', taskId: event.task_id, tableId, cutoff, inputBasis: 'output-only-v1' }, now);
    expect(input.tasks[0]?.events[0]?.payload).toHaveProperty(
      'billing_components',
      expect.arrayContaining([{ kind: 'cache_write', reading: { status: 'observed', value: 20, reason: null } }])
    );
    const original = createPriceRevaluation(store, { id: 'original', inputId: input.input_id, targetTableId: tableId }, now);
    expect(original.tasks[0]?.cost.legacy_unverified_partial_amount).toBe('0.00177');
    const frozenInput = store.get('SELECT payload,hash FROM price_cost_inputs WHERE id=?', [input.input_id]);
    const frozenResult = store.get('SELECT payload FROM price_revaluations WHERE id=?', ['original']);
    const candidateBytes = bytes();
    expect(await refreshPriceCatalog(store, () => Promise.resolve(candidateBytes), digest(candidateBytes), now)).toMatchObject({ status: 'updated' });
    const next = preparePriceBasis(store, now);
    expect(next.table.version).toBe('catalog-v5');
    store.execute('DELETE FROM runtime_evidence', []);
    store.execute('DELETE FROM events', []);
    const revalued = createPriceRevaluation(store, { id: 'revalued', inputId: input.input_id, targetTableId: next.table.id }, now);
    expect(revalued.tasks[0]?.cost).toMatchObject({
      legacy_unverified_partial_amount: '0.00152',
      complete_amount: null,
      price_reasons: ['missing_rate']
    });
    expect(revalued.tasks[0]?.usage_snapshot_hash).toBe(input.tasks[0]?.usage_snapshot_hash);
    expect(readPriceBasis(store, tableId)).toEqual(old);
    expect(readPriceRevaluation(store, 'original')).toEqual(original);
    expect(store.get('SELECT payload,hash FROM price_cost_inputs WHERE id=?', [input.input_id])).toEqual(frozenInput);
    expect(store.get('SELECT payload FROM price_revaluations WHERE id=?', ['original'])).toEqual(frozenResult);
    expect(digest(bytes(name))).toBe(hash);
  } finally {
    store.close();
  }
});

test('v5 CLI reports observed writes as unpriced without changing the stored usage', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(now));
  const directory = mkdtempSync(join(tmpdir(), 'synthetic-price-v5-'));
  const db = join(directory, 'metadata.sqlite');
  const store = new Store(db);
  let output = '';
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(value => {
    output += String(value);
    return true;
  });
  try {
    const event = seedUsage(store);
    const stored = store.get('SELECT payload FROM events WHERE id=?', [event.id]);
    const candidateBytes = bytes();
    expect(await refreshPriceCatalog(store, () => Promise.resolve(candidateBytes), digest(candidateBytes), now)).toMatchObject({ status: 'updated' });
    expect(await main(['--db', db, 'price-table', 'estimate-task', event.task_id, '--cutoff', cutoff])).toBe(0);
    const report: unknown = JSON.parse(output);
    expect(report).toMatchObject({
      catalog_id: 'reference-catalog-2026-11-25',
      legacy_unverified_partial_amount: '0.00152',
      complete_amount: null,
      price_reasons: ['missing_rate']
    });
    expect(report).toHaveProperty(
      'matches',
      expect.arrayContaining([
        expect.objectContaining({ component: 'cache_write', status: 'unavailable', price_per_unit: null, reason: 'missing_rate' }),
        expect.objectContaining({ component: 'ordinary_input', status: 'matched', price_per_unit: '10' })
      ])
    );
    expect(store.get('SELECT payload FROM events WHERE id=?', [event.id])).toEqual(stored);
    expect(output).not.toContain(directory);
  } finally {
    stdout.mockRestore();
    store.close();
    rmSync(directory, { recursive: true, force: true });
    vi.useRealTimers();
  }
});
