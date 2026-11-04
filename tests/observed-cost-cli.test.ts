import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test, vi } from 'vitest';
import { main } from '../src/cli.js';
import { Store } from '../src/store.js';
import { Lifecycle } from '../src/lifecycle.js';
import { readObservedCostReport } from '../src/observed-cost-report.js';
import { registerPriceTable } from '../src/pricing.js';
import { recordObservationGap } from '../src/runtime-history.js';
import { collectionFixture, millis } from './helpers/collection-fixture.js';

test('collector usage remains priceable despite unknown coverage while explicit loss gaps exclude it', () => {
  const f = collectionFixture('codex');
  try {
    registerPriceTable(f.store, {
      id: 'reference',
      version: 'v1',
      currency: 'USD',
      source_id: 'synthetic-reference',
      as_of: millis(0),
      unit_tokens: 1000000,
      display_decimals: 6,
      rounding: 'half_even',
      entries: [{ product: 'codex', model: 'synthetic', component: 'output', price_per_unit: '10' }]
    });
    f.life.start('t1');
    f.collector.tick('t1');
    f.rows(...f.turn(10, 20));
    f.set(30);
    expect(f.collector.tick('t1')).toEqual([]);
    expect(f.store.eventCount()).toBe(1);
    const report = () => readObservedCostReport(f.store, 't1', 'reference', millis(40), 'output-only-v1');
    expect(report()).toMatchObject({ event_count: 1, complete_amount: null, partial_amount: '0.0003', excluded_event_count: 0 });
    recordObservationGap(f.store, 't1', 's1', millis(10), millis(25), 'not_available', millis(30));
    const unknown = report();
    expect(unknown.event_count).toBe(1);
    recordObservationGap(f.store, 't1', 's1', millis(10), millis(25), 'source_error', millis(30));
    const lost = report();
    expect(lost).toMatchObject({ event_count: 0, partial_amount: null, complete_amount: null, excluded_event_count: 1 });
    expect(lost.observation_snapshot_hash).not.toBe(unknown.observation_snapshot_hash);
    expect(lost.reasons).toContain('source_error');
  } finally {
    f.cleanup();
  }
});

test('explicit table and basis report across linked sessions without paths, mutation or completeness', async () => {
  const root = mkdtempSync(join(tmpdir(), 'observed-cost-'));
  const db = join(root, 'local.db');
  const store = new Store(db);
  const life = new Lifecycle(store, () => '2026-01-01T00:00:00Z');
  try {
    life.registerProject('project-1', root);
    life.createTask('project-1', 'task-1', {
      type: 'feature',
      expected_size: 'small',
      assignee: 'user-1',
      product: 'codex',
      model: 'gpt-6-astra',
      criterion_ids: ['c1']
    });
    life.start('task-1');
    const observed = (value: number) => ({ status: 'observed' as const, value, reason: null });
    for (const [session, model] of [
      ['parent', 'gpt-6-astra'],
      ['child', 'gpt-6.1-sol']
    ]) {
      store.execute('INSERT INTO sessions(id,project_id,task_id,product,source_path) VALUES (?,?,?,?,?)', [
        session,
        'project-1',
        'task-1',
        'codex',
        '/synthetic/private'
      ]);
      store.putEvent({
        id: `event-${session}`,
        source_key: `event-${session}`,
        session_id: session!,
        task_id: 'task-1',
        project_id: 'project-1',
        occurred_at: '2026-01-01T00:00:03Z',
        payload: {
          kind: 'usage',
          product: 'codex',
          product_version: '0.158.0',
          epoch: 'epoch-1',
          model: model!,
          input_total: observed(100),
          cached_input: observed(60),
          output_total: observed(10),
          reasoning_output: observed(5)
        }
      });
    }
    const original = store.get<{ payload: string }>('SELECT payload FROM events WHERE id=?', ['event-parent'])!;
    for (const [id, occurredAt] of [
      ['before', '2025-12-31T23:59:59Z'],
      ['after', '2026-01-02T00:00:00Z'],
      ['paused', '2026-01-01T00:00:01.500Z'],
      ['uncertain', '2026-01-01T00:00:04.500Z']
    ]) {
      store.execute('INSERT INTO events(id,source_key,session_id,task_id,project_id,occurred_at,payload) VALUES (?,?,?,?,?,?,?)', [
        id,
        id,
        'parent',
        'task-1',
        'project-1',
        occurredAt,
        original.payload
      ]);
    }
    new Lifecycle(store, () => '2026-01-01T00:00:01Z').pause('task-1');
    new Lifecycle(store, () => '2026-01-01T00:00:02Z').resume('task-1');
    store.execute('INSERT INTO observations(id,task_id,started_at,ended_at,status,reason) VALUES (?,?,?,?,?,?)', [
      'uncertain-window',
      'task-1',
      '2026-01-01T00:00:04Z',
      '2026-01-01T00:00:05Z',
      'unmeasurable',
      'offline'
    ]);
    const run = (args: string[]) => main(['--db', db, ...args]);
    let output = '';
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(value => {
      output += String(value);
      return true;
    });
    const errors = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(await run(['price-table', 'register', '--config', resolve('config/prices/openai-standard-short-2026-10-04.json')])).toBe(0);
      const args = ['price-table', 'estimate-task', 'task-1', '--price-table', 'openai-standard-short-2026-10-04', '--cutoff', '2026-01-02T00:00:00Z'];
      expect(await run([...args, '--input-basis', 'cache-read-remainder-ordinary-v1'])).toBe(0);
      expect(JSON.parse(output) as unknown).toMatchObject({
        complete_amount: null,
        partial_amount: null,
        legacy_unverified_partial_amount: '0.001146',
        session_count: 2,
        assumed_input_events: 2,
        excluded_event_count: 2,
        input_basis: 'cache-read-remainder-ordinary-v1'
      });
      expect(output).not.toContain(root);
      expect(output).not.toContain('/synthetic/private');
      output = '';
      expect(await run(args)).toBe(0);
      expect(JSON.parse(output) as unknown).toMatchObject({
        partial_amount: null,
        legacy_unverified_partial_amount: '0.0006',
        assumed_input_events: 0,
        input_basis: 'output-only-v1'
      });
      output = '';
      new Lifecycle(store, () => '2026-01-01T00:00:03Z').finalize('task-1', 'success', ['c1']);
      expect(await run(args)).toBe(0);
      expect(JSON.parse(output) as unknown).toMatchObject({ partial_amount: null, event_count: 0, window_end: '2026-01-01T00:00:03.000Z' });
      expect(await run([...args, '--input-basis', 'unknown'])).toBe(2);
      expect(await run(['price-table', 'estimate-task', 'task-1', '--price-table', 'unknown', '--cutoff', '2026-01-02T00:00:00Z'])).toBe(2);
      expect(await run(['delete', 'task', 'task-1'])).toBe(0);
      expect(await run(args)).toBe(2);
      expect(store.eventCount()).toBe(0);
    } finally {
      write.mockRestore();
      errors.mockRestore();
    }
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
