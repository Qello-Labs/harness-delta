import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { readExchangeFile, publishExchangeFile } from '../../src/comparison/exchange/files.js';
import { freshSource, assignAndSnapshot, dataPackage } from '../helpers/exchange-fixture.js';

test('file boundary rejects escaped duplicate keys, oversized input and private parse diagnostics', () => {
  const dir = mkdtempSync(join(tmpdir(), 'exchange-'));
  const path = join(dir, 'input.json');
  try {
    for (const text of ['{"a":1,"\\u0061":2}', '{"nested":{"a":1,"a":2}}', '{"PRIVATE_SENTINEL":', ' '.repeat(16 * 1024 * 1024 + 1)]) {
      writeFileSync(path, text);
      expect(() => readExchangeFile(path)).toThrow(/^(invalid_exchange_package|exchange_limit_exceeded)$/);
    }
    writeFileSync(path, JSON.stringify({ a: [{ b: 1 }, { b: 2 }], s: 'escaped " brace }' }));
    expect(readExchangeFile(path)).toEqual({ a: [{ b: 1 }, { b: 2 }], s: 'escaped " brace }' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('published files are private, replay-safe and never overwrite conflicting content', () => {
  const dir = mkdtempSync(join(tmpdir(), 'exchange-'));
  const path = join(dir, 'out.json');
  const store = freshSource();
  try {
    assignAndSnapshot(store);
    const pkg = dataPackage(store);
    publishExchangeFile(path, pkg);
    const first = readFileSync(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    publishExchangeFile(path, pkg);
    expect(readFileSync(path)).toEqual(first);
    writeFileSync(path, 'PRIVATE_SENTINEL');
    expect(() => publishExchangeFile(path, pkg)).toThrow('exchange_io_error');
    expect(readFileSync(path, 'utf8')).toBe('PRIVATE_SENTINEL');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('publication rejects semantically identical but byte-different or publicly readable existing files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'exchange-format-'));
  const path = join(dir, 'out.json');
  const store = freshSource();
  try {
    assignAndSnapshot(store);
    const pkg = dataPackage(store);
    writeFileSync(path, JSON.stringify(pkg, null, 2), { mode: 0o644 });
    expect(() => publishExchangeFile(path, pkg)).toThrow('exchange_io_error');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a package at the exact byte limit is readable after publication', async () => {
  const { canonicalJson } = await import('../../src/core/canonical-json.js');
  const { MAX_BYTES } = await import('../../src/comparison/exchange/contracts.js');
  const dir = mkdtempSync(join(tmpdir(), 'exchange-limit-'));
  const path = join(dir, 'out.json');
  const store = freshSource();
  try {
    assignAndSnapshot(store);
    const pkg = dataPackage(store);
    if (pkg.kind !== 'assignment_metadata') throw new Error('wrong_kind');
    pkg.assignments = Array.from({ length: 6000 }, (_, i) => ({
      ...structuredClone(pkg.assignments[0]!),
      task_id: `t-${i}`,
      assignment_id: `a-${i}`,
      logical_task_id: `l-${i}`,
      allocation_index: i
    }));
    let remaining = MAX_BYTES - Buffer.byteLength(canonicalJson(pkg));
    let row = 0;
    let counter = 0;
    expect(remaining).toBeGreaterThan(0);
    while (remaining >= 131) {
      if (pkg.assignments[row]!.metadata.criterion_ids.length === 10000) row++;
      pkg.assignments[row]!.metadata.criterion_ids.push(`c${counter++}`.padEnd(128, 'x'));
      remaining -= 131;
    }
    if (remaining > 0 && remaining < 4) {
      const ids = pkg.assignments[row]!.metadata.criterion_ids;
      ids[ids.length - 1] = ids.at(-1)!.slice(0, -4);
      remaining += 4;
    }
    if (remaining) pkg.assignments[row]!.metadata.criterion_ids.push('z'.repeat(remaining - 3));
    expect(Buffer.byteLength(canonicalJson(pkg))).toBe(MAX_BYTES);
    publishExchangeFile(path, pkg);
    expect(statSync(path).size).toBe(MAX_BYTES);
    expect(readExchangeFile(path)).toMatchObject({ package_id: pkg.package_id });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);
