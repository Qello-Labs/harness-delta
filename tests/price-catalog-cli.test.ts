import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { main } from '../src/cli.js';
import { Store } from '../src/store.js';
import { Lifecycle } from '../src/lifecycle.js';
import { bundledPriceCatalog, digest } from '../src/price-catalog.js';
import { ensureBundledCatalog, readPriceCatalogStatus } from '../src/price-catalog-store.js';
import { compiledWorker } from './helpers/compiled-worker.js';

test('default estimate, trusted local refresh and separate repricing work without manual price registration', async () => {
  const root = mkdtempSync(join(tmpdir(), 'catalog-cli-'));
  const db = join(root, 'local.db');
  const store = new Store(db);
  const life = new Lifecycle(store, () => '2026-01-01T00:00:00Z');
  let output = '';
  let errors = '';
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(value => {
    output += String(value);
    return true;
  });
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(value => {
    errors += String(value);
    return true;
  });
  // A network failure is synthetic; the command must retain the accepted bundle.
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('synthetic_offline')));
  const run = async (args: string[]) => {
    output = '';
    errors = '';
    const code = await main(['--db', db, 'price-table', ...args]);
    return { code, value: output ? (JSON.parse(output) as Record<string, unknown>) : null, errors };
  };
  try {
    life.registerProject('project', root);
    life.createTask('project', 'task', {
      type: 'feature',
      expected_size: 'small',
      assignee: 'user',
      product: 'codex',
      model: 'gpt-6.1-sol',
      criterion_ids: ['criterion']
    });
    life.start('task');
    store.execute("INSERT INTO sessions(id,project_id,task_id,product,source_path) VALUES ('session','project','task','codex','/synthetic/private')", []);
    const observed = (value: number) => ({ status: 'observed' as const, value, reason: null });
    store.putEvent({
      id: 'event',
      source_key: 'event',
      task_id: 'task',
      project_id: 'project',
      session_id: 'session',
      occurred_at: '2026-01-01T00:00:02Z',
      payload: {
        kind: 'usage',
        product: 'codex',
        product_version: '0.158.0',
        epoch: 'epoch',
        model: 'gpt-6.1-sol',
        input_total: observed(100),
        cached_input: observed(50),
        output_total: observed(10),
        reasoning_output: observed(5)
      }
    });
    expect(await run(['catalog-status'])).toMatchObject({ code: 0, value: { catalog_version: 1, update_channel: 'verified_https_manifest' } });
    expect(await run(['refresh-catalog', '--online'])).toMatchObject({ code: 2, value: { status: 'failed', reason: 'catalog_unavailable' } });
    expect(await run(['catalog-status'])).toMatchObject({
      code: 0,
      value: { online_source: { status: 'configured' }, can_attempt_online_refresh: true, catalog_version: 1 }
    });
    expect(await run(['refresh-catalog', '--online', '--artifact', 'synthetic.json', '--sha256', '0'.repeat(64)])).toMatchObject({
      code: 2,
      errors: 'catalog_refresh_mode_conflict\n'
    });
    const estimate = await run(['estimate-task', 'task', '--cutoff', '2026-01-01T00:00:10Z']);
    expect(estimate).toMatchObject({
      code: 0,
      value: {
        price_selection: 'current_catalog',
        partial_amount: null,
        legacy_unverified_partial_amount: '0.0001',
        complete_amount: null,
        window_policy: 'active-observed-loss-half-open-v2'
      }
    });
    expect(JSON.stringify(estimate.value)).not.toContain(root);
    expect(await run(['snapshot-task', 'task', '--id', 'input', '--cutoff', '2026-01-01T00:00:10Z'])).toMatchObject({ code: 0, value: { input_id: 'input' } });
    expect(await run(['reprice', 'input', '--id', 'before'])).toMatchObject({ code: 0, value: { revaluation_id: 'before' } });
    const bytes = Buffer.from(
      JSON.stringify({
        ...bundledPriceCatalog(),
        catalog_id: 'new',
        catalog_version: 2,
        models: bundledPriceCatalog().models.map(row => (row.model === 'gpt-6.1-sol' ? { ...row, rates: { ...row.rates, output: '20' } } : row))
      })
    );
    const artifact = join(root, 'artifact.json');
    writeFileSync(artifact, bytes);
    expect(await run(['refresh-catalog', '--artifact', artifact])).toMatchObject({ code: 2 });
    expect(await run(['refresh-catalog', '--artifact', artifact, '--sha256', '0'.repeat(64)])).toMatchObject({
      code: 2,
      value: { status: 'failed', reason: 'catalog_hash_mismatch' }
    });
    expect(await run(['refresh-catalog', '--artifact', artifact, '--sha256', digest(bytes)])).toMatchObject({ code: 0, value: { status: 'updated' } });
    const repriced = await run(['reprice', 'input', '--id', 'after']);
    expect(repriced).toMatchObject({
      code: 0,
      value: { complete_amount: null, tasks: [{ cost: { partial_amount: null, legacy_unverified_partial_amount: '0.0002' } }] }
    });
    expect(await run(['revaluation', 'before'])).toMatchObject({
      code: 0,
      value: { tasks: [{ cost: { partial_amount: null, legacy_unverified_partial_amount: '0.0001' } }] }
    });
    // The older bundled revision must not roll back a newer accepted local artifact.
    expect(await run(['refresh-catalog'])).toMatchObject({ code: 2, value: { reason: 'catalog_rollback' } });
    expect(await run(['catalog-status'])).toMatchObject({ code: 0, value: { catalog_version: 2, status: 'failed' } });
  } finally {
    vi.unstubAllGlobals();
    stdout.mockRestore();
    stderr.mockRestore();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a FIFO catalog artifact fails and exits without replacing the accepted catalog', () => {
  const root = mkdtempSync(join(tmpdir(), 'catalog-fifo-'));
  const file = join(root, 'catalog.fifo');
  const db = join(root, 'local.db');
  const store = new Store(db);
  try {
    ensureBundledCatalog(store);
    const before = readPriceCatalogStatus(store);
    const made = spawnSync('mkfifo', [file], { encoding: 'utf8' });
    expect(made.status).toBe(0);
    const compiled = compiledWorker(root);
    // The watchdog exceeds the existing five-second loader timeout. A pending
    // FIFO read must not keep the CLI alive after the failure receipt.
    const result = spawnSync(
      process.execPath,
      [join(compiled, 'cli.js'), '--db', db, 'price-table', 'refresh-catalog', '--artifact', file, '--sha256', '0'.repeat(64)],
      { encoding: 'utf8', timeout: 7000 }
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toEqual({ status: 'failed', reason: 'catalog_unavailable' });
    expect(result.stdout + result.stderr).not.toContain(root);
    expect(readPriceCatalogStatus(store)).toMatchObject({
      catalog_id: before.catalog_id,
      catalog_version: before.catalog_version,
      artifact_sha256: before.artifact_sha256,
      status: 'failed',
      reason: 'catalog_unavailable'
    });
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);
