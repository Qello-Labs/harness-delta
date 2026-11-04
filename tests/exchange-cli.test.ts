import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { main } from '../src/cli.js';
import { freshSource, assignAndSnapshot, packageId } from './helpers/exchange-fixture.js';
import { readExchangeFile } from '../src/exchange/files.js';

test('explicit CLI export writes safe metadata and returns fixed private-input diagnostics', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'exchange-cli-'));
  const db = join(dir, 'source.db');
  const store = freshSource(db);
  assignAndSnapshot(store);
  store.close();
  let output = '';
  let error = '';
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(v => {
    output += String(v);
    return true;
  });
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(v => {
    error += String(v);
    return true;
  });
  try {
    const file = join(dir, 'out.json');
    expect(await main(['--db', db, 'exchange', 'export', '--protocol', 'comparison-1', '--snapshot', 'report-1', '--id', packageId, '--out', file])).toBe(0);
    expect(readExchangeFile(file)).toMatchObject({ kind: 'assignment_metadata', package_id: packageId });
    expect(output).not.toContain(dir);
    const config = join(dir, 'bad.json');
    writeFileSync(config, '{"PRIVATE_SENTINEL":');
    expect(await main(['--db', db, 'exchange', 'source', 'register', '--config', config])).toBe(2);
    expect(error).toBe('invalid_exchange_package\n');
  } finally {
    out.mockRestore();
    err.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI mapping/import/replay/local deletion and stale import have explicit safe results', async () => {
  const { paired } = await import('./helpers/exchange-import-fixture.js');
  const dir = mkdtempSync(join(tmpdir(), 'exchange-import-cli-'));
  const path = join(dir, 'dest.db');
  const { source, dest, pkg, mapping } = paired(path);
  dest.close();
  let output = '';
  let errors = '';
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(v => {
    output += String(v);
    return true;
  });
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(v => {
    errors += String(v);
    return true;
  });
  try {
    const file = join(dir, 'package.json');
    const map = join(dir, 'mapping.json');
    writeFileSync(file, JSON.stringify(pkg));
    writeFileSync(map, JSON.stringify(mapping));
    const run = (args: string[]) => main(['--db', path, 'exchange', ...args]);
    expect(await run(['mapping', 'register', '--config', map])).toBe(0);
    output = '';
    expect(await run(['import', '--file', file, '--project', 'destination'])).toBe(0);
    expect(JSON.parse(output) as unknown).toEqual({ status: 'imported' });
    output = '';
    expect(await run(['import', '--file', file, '--project', 'destination'])).toBe(0);
    expect(JSON.parse(output) as unknown).toEqual({ status: 'replayed' });
    expect(await run(['retention', 'apply', '--project', 'destination', '--shared-project', mapping.shared_project_id])).toBe(2);
    expect(await run(['retention', 'set', '--project', 'destination', '--shared-project', mapping.shared_project_id, '--days', '30'])).toBe(0);
    expect(await run(['delete-task', '--project', 'destination', '--shared-project', mapping.shared_project_id, '--task', 'task-1'])).toBe(0);
    expect(await run(['import', '--file', file, '--project', 'destination'])).toBe(2);
    expect(errors).toBe('retention_not_configured\ndeleted_identifier\n');
    expect(output).not.toContain(dir);
  } finally {
    source.close();
    out.mockRestore();
    err.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI explicitly reports committed deletion with rejected conflicting data', async () => {
  const { paired } = await import('./helpers/exchange-import-fixture.js');
  const { importExchangePackage } = await import('../src/exchange/import.js');
  const dir = mkdtempSync(join(tmpdir(), 'exchange-partial-cli-'));
  const path = join(dir, 'dest.db');
  const f = paired(path);
  importExchangePackage(f.dest, f.pkg, 'destination', () => '2026-01-05T00:00:00.000Z');
  f.dest.close();
  const mixed = structuredClone(f.pkg);
  mixed.tombstones = [{ kind: 'protocol_invalidated', target_id: mixed.protocol_id, reason: 'deletion', invalidated_at: mixed.produced_at }];
  mixed.assignments[0]!.original_variant_id = 'unknown';
  const file = join(dir, 'mixed.json');
  writeFileSync(file, JSON.stringify(mixed));
  let output = '';
  let error = '';
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(v => {
    output += String(v);
    return true;
  });
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(v => {
    error += String(v);
    return true;
  });
  try {
    expect(await main(['--db', path, 'exchange', 'import', '--file', file, '--project', 'destination'])).toBe(2);
    expect(JSON.parse(output) as unknown).toEqual({ status: 'deletions_applied_data_rejected', reason: 'deleted_identifier' });
    expect(error).toBe('deleted_identifier\n');
    const { Store } = await import('../src/store.js');
    const restart = new Store(path);
    try {
      expect(restart.all('SELECT * FROM exchange_tasks')).toEqual([]);
      expect(() => importExchangePackage(restart, f.pkg, 'destination')).toThrow('deleted_identifier');
    } finally {
      restart.close();
    }
  } finally {
    f.source.close();
    out.mockRestore();
    err.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});
