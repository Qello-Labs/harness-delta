import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { main } from '../src/cli.js';
import { Store } from '../src/store.js';
import { seedFlexibleComparison } from './helpers/flexible-store.js';
import { makeFlexibleFixture } from './helpers/flexible-fixture.js';
import { assignTask } from '../src/comparison/allocation.js';
import { putUsageWithEvidence } from '../src/runtime-history.js';
test('CLI registers explicit immutable prices and shows them without defaults', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flexible-cli-'));
  const db = join(root, 'db');
  const path = join(root, 'price.json');
  let output = '';
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(v => {
    output += String(v);
    return true;
  });
  const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  try {
    const f = makeFlexibleFixture();
    writeFileSync(path, JSON.stringify(f.priceTable));
    expect(await main(['--db', db, 'price-table', 'register', '--config', path])).toBe(0);
    expect(await main(['--db', db, 'price-table', 'show', f.priceTable.id])).toBe(0);
    expect(JSON.parse(output)).toEqual(f.priceTable);
    writeFileSync(path, JSON.stringify({ ...f.priceTable, currency: 'EUR' }));
    expect(await main(['--db', db, 'price-table', 'register', '--config', path])).toBe(2);
  } finally {
    out.mockRestore();
    err.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});
test('CLI dispatches flexible task report runtime history and readiness', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flexible-cli-'));
  const db = join(root, 'db');
  let output = '';
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(v => {
    output += String(v);
    return true;
  });
  const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  try {
    const store = new Store(db, () => '2026-01-01T00:00:04Z');
    const f = seedFlexibleComparison(store);
    assignTask(store, f.input, { clock: () => f.protocol.recruitment_start, shuffle: x => x });
    store.execute("UPDATE tasks SET state='active',started_at=? WHERE id='task-1'", [f.protocol.recruitment_start]);
    store.execute("INSERT INTO sessions(id,task_id,project_id,product,product_version) VALUES ('session-1','task-1','project-1','synthetic','1.0.0')", []);
    putUsageWithEvidence(store, f.events[0]!, f.runtime[0]!);
    store.close();
    expect(await main(['--db', db, 'report', 'task', 'task-1', '--cutoff', '2026-01-01T02:00:00Z'])).toBe(0);
    expect(JSON.parse(output)).toMatchObject({ cost: { complete_amount: null, partial_amount: '0.26' }, original_variant_id: expect.any(String) as unknown });
    output = '';
    expect(await main(['--db', db, 'task', 'config-history', 'task-1'])).toBe(0);
    expect(JSON.parse(output)).toMatchObject({ runtime: [{ id: 'runtime-1', model: 'synthetic-model' }] });
    output = '';
    expect(await main(['--db', db, 'comparison', 'readiness', f.protocol.id])).toBe(0);
    expect(JSON.parse(output)).toMatchObject({ real_allocation: false, complete_cost: false, inference: false });
  } finally {
    out.mockRestore();
    err.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});
