import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { main } from '../src/cli.js';
import { Lifecycle } from '../src/lifecycle.js';
import { createOrdinaryTask, ordinaryTask, saveOrdinaryProjectSettings } from '../src/ordinary-observation.js';
import { Store } from '../src/store.js';
import { aggregateOrdinaryTaskReport } from '../src/reports/ordinary-task.js';
import { ordinaryBindingFixture } from './helpers/ordinary-session-binding-fixture.js';
import { bundledPriceCatalog, digest } from '../src/price-catalog.js';
import { refreshPriceCatalog } from '../src/price-catalog-store.js';
import { recordObservationGap } from '../src/runtime-history.js';

test('ordinary report uses actual bound usage and retains its basis after a catalog update', async () => {
  const f = ordinaryBindingFixture();
  try {
    const connected = await f.connect();
    const first = f.usage();
    first.payload.billing_components.push(
      { kind: 'ordinary_input', reading: { status: 'observed', value: 8, reason: null } },
      { kind: 'cache_read', reading: { status: 'observed', value: 2, reason: null } },
      { kind: 'cache_write', reading: { status: 'observed', value: 0, reason: null } },
    );
    f.advance();
    await f.binding.tick(f.taskId);
    const summary = f.binding.status(f.taskId).summary;
    const before = aggregateOrdinaryTaskReport(f.store, f.taskId, f.clock());
    expect(before.usage.input_total).toEqual(summary.input_total);
    expect(before.cost.partial_amount).toBe(summary.partial_amount);
    expect(before.cost.compatibility_unverified_partial_amount).toBe(summary.compatibility_unverified_partial_amount);
    expect(Number(before.cost.compatibility_unverified_partial_amount)).toBeGreaterThan(0);
    expect(before.cost.complete_amount).toBeNull();
    const bytes = Buffer.from(JSON.stringify({ ...bundledPriceCatalog(), catalog_id: 'ordinary-report-next', catalog_version: 2 }));
    expect(await refreshPriceCatalog(f.store, () => Promise.resolve(bytes), digest(bytes), f.clock()))
      .toMatchObject({ status: 'updated' });
    expect(aggregateOrdinaryTaskReport(f.store, f.taskId, f.clock())).toEqual(before);
    recordObservationGap(f.store, f.taskId, connected.session_id, first.occurredAt, f.clock(), 'source_error', f.clock());
    const excluded = aggregateOrdinaryTaskReport(f.store, f.taskId, f.clock());
    expect(excluded.cost).toMatchObject({ partial_amount: null, complete_amount: null, excluded_event_count: 1 });
    expect(excluded.cost.reasons).toContain('source_error');
    expect(excluded.usage.input_total).toMatchObject({ status: 'missing', value: null });
  } finally { await f.cleanup(); }
});

test('ordinary task reports preserve missing and zero readings, price pins and human outcomes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ordinary-report-'));
  const db = join(root, 'report.sqlite');
  const store = new Store(db);
  const clock = () => '2026-10-13T09:00:00.000Z';
  const life = new Lifecycle(store, clock);
  let output = '';
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(value => { output += String(value); return true; });
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    life.registerProject('p1', root);
    saveOrdinaryProjectSettings(store, 'p1', {
      schema_version: 1, product: 'claude_code', product_version: '2.1.296',
      receipt_directory: '/synthetic/private/receipts', claude_projects_directory: '/synthetic/private/projects',
    }, clock);
    const id = createOrdinaryTask(store, { project_id: 'p1', criterion_ids: ['accepted'] }, clock);
    const pin = ordinaryTask(store, id)?.price_table_id;
    const args = ['--db', db, 'report', 'task', id, '--cutoff', '2026-10-13T10:00:00Z'];
    expect(await main(args)).toBe(0);
    expect(JSON.parse(output) as unknown).toMatchObject({
      mode: 'ordinary', inference: false,
      usage: { coverage: 'partial', input_total: { status: 'missing', value: null }, output_total: { status: 'missing', value: null } },
      cost: { cost_coverage: 'partial', price_table: { id: pin }, complete_amount: null, partial_amount: null },
      quality: { outcome: null, criteria_met: null, first_success: null },
      time: { active_ms: null, elapsed_ms: null },
    });
    life.start(id);
    store.execute('INSERT INTO sessions(id,project_id,task_id,product) VALUES (?,?,?,?)', ['s1', 'p1', id, 'claude_code']);
    const observed = { status: 'observed' as const, value: 0, reason: null };
    store.putEvent({
      id: 'e1', source_key: 'e1', project_id: 'p1', task_id: id, session_id: 's1',
      occurred_at: '2026-10-13T09:01:00Z',
      payload: { kind: 'usage', product: 'claude_code', product_version: '2.1.296', epoch: 'epoch1',
        model: 'claude-opus-5-5', input_total: observed, cached_input: observed,
        output_total: observed, reasoning_output: { status: 'missing', value: null, reason: 'not_available' } },
    });
    new Lifecycle(store, () => '2026-10-13T09:02:00Z').finalize(id, 'success', ['accepted']);
    store.execute('DELETE FROM price_catalog_default', []);
    output = '';
    expect(await main(args)).toBe(0);
    const report: unknown = JSON.parse(output);
    expect(report).toMatchObject({
      mode: 'ordinary', inference: false,
      usage: { input_total: { status: 'observed', value: 0 }, reasoning_output: { status: 'missing', value: null } },
      cost: { price_table: { id: pin }, complete_amount: null, partial_amount: null, legacy_unverified_partial_amount: '0' },
      quality: { outcome: 'success', criteria_met: ['accepted'], first_success: null },
      time: { active_ms: 120000, elapsed_ms: 120000 },
    });
    expect(report).not.toHaveProperty('arms');
    expect(report).not.toHaveProperty('adoption');
    expect(output).not.toContain(root);
    output = '';
    expect(await main([...args, '--format', 'markdown'])).toBe(0);
    const json = output.split('```json\n')[1]?.split('\n```')[0];
    expect(json && JSON.parse(json) as unknown).toEqual(report);
    output = '';
    expect(await main([...args.slice(0, -1), '2026-10-13T09:01:00Z'])).toBe(0);
    expect(JSON.parse(output) as unknown).toMatchObject({ quality: { outcome: null }, cost: { event_count: 0 } });
  } finally {
    stdout.mockRestore(); stderr.mockRestore(); store.close(); rmSync(root, { recursive: true, force: true });
  }
});
