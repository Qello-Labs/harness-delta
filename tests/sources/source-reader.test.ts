import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { readSource } from '../../src/sources/collection.js';
import { SourceFailure, sourceCategory } from '../../src/core/source-errors.js';

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, fstatSync: vi.fn(actual.fstatSync), readSync: vi.fn(actual.readSync) };
});
afterEach(() => vi.restoreAllMocks());

test.each(['short', 'unstable'] as const)('bounded reader rejects a %s read with only a fixed category', fault => {
  const root = mkdtempSync(join(tmpdir(), 'reader-fault-'));
  const path = join(root, 'synthetic.jsonl');
  try {
    writeFileSync(path, 'synthetic_private_content');
    if (fault === 'short') vi.mocked(fs.readSync).mockReturnValueOnce(0);
    else {
      const actual = vi.mocked(fs.fstatSync).getMockImplementation()!;
      vi.mocked(fs.fstatSync).mockImplementationOnce(fd => {
        const stat = actual(fd);
        writeFileSync(path, 'synthetic_changed_content_is_longer');
        return stat;
      });
    }
    let failure: unknown;
    try {
      readSource(path);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(SourceFailure);
    expect(sourceCategory(failure, 'read_failed')).toBe(fault === 'short' ? 'short_read' : 'unstable_read');
    expect((failure as Error).message).toBe('source_error');
    expect(JSON.stringify(failure)).not.toContain('synthetic');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('untrusted category and arbitrary error text cannot enter diagnostic output', () => {
  const forged = new SourceFailure('read_failed');
  Object.assign(forged, { category: 'PRIVATE/path' });
  expect(sourceCategory(forged, 'read_failed')).toBe('read_failed');
  expect(sourceCategory(new Error('PRIVATE/prompt'), 'parse_failed')).toBe('parse_failed');
});
