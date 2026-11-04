import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { appendFamilyDiagnostic } from '../src/binding-family-diagnostics.js';
let root: string;
let sink: string;
const row = { schema_version: 1, phase: 'tick_discovery', reason_codes: ['child_source_missing'] };
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'hd-family-diagnostic-')));
  sink = join(root, 'diagnostics.jsonl');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});
// A concurrent observer may skip a diagnostic, but must never bypass the sink budget.
test('an occupied writer lock neither creates output nor deletes the other writer lock', () => {
  writeFileSync(sink + '.lock', '', { mode: 0o600 });
  appendFamilyDiagnostic(sink, row);
  expect(existsSync(sink)).toBe(false);
  expect(existsSync(sink + '.lock')).toBe(true);
});
test('writes only fixed fields to owner-private storage and caps repeated rejection rows', () => {
  for (let i = 0; i < 80; i++) appendFamilyDiagnostic(sink, row);
  expect(lstatSync(sink).mode & 0o077).toBe(0);
  const text = readFileSync(sink, 'utf8');
  expect(text.trim().split('\n')).toHaveLength(64);
  expect(
    text
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as unknown)
  ).toEqual(Array.from({ length: 64 }, () => row));
  expect(lstatSync(sink).size).toBeLessThanOrEqual(65536);
});
test('byte capacity refuses the whole next row rather than writing a partial JSON record', () => {
  const large = { schema_version: 1, phase: 'tick_discovery', reason_codes: Array.from({ length: 32 }, () => 'claude_bound_identity_changed') };
  for (let i = 0; i < 80; i++) appendFamilyDiagnostic(sink, large);
  const text = readFileSync(sink, 'utf8');
  expect(text.endsWith('\n')).toBe(true);
  const rows = text.trim().split('\n');
  expect(rows.length).toBeLessThan(64);
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.map(line => JSON.parse(line) as unknown)).toEqual(Array.from({ length: rows.length }, () => large));
  expect(lstatSync(sink).size).toBeLessThanOrEqual(65536);
});
test.each(['unknown_reason', 'unknown_phase', 'extra_field'] as const)('rejects %s without creating a diagnostic file', fault => {
  const invalid =
    fault === 'unknown_reason'
      ? { ...row, reason_codes: ['SYNTHETIC-SECRET'] }
      : fault === 'unknown_phase'
        ? { ...row, phase: 'SYNTHETIC-SECRET' }
        : { ...row, path: 'SYNTHETIC-SECRET' };
  expect(() => appendFamilyDiagnostic(sink, invalid)).not.toThrow();
  expect(existsSync(sink)).toBe(false);
});
test.each(['symlink', 'hardlink', 'public_file', 'public_parent', 'corrupt', 'directory'] as const)(
  'unsafe %s sink is left untouched without throwing',
  fault => {
    const target = join(root, 'target');
    writeFileSync(target, 'SYNTHETIC-PRIVATE', { mode: 0o600 });
    if (fault === 'symlink') symlinkSync(target, sink);
    else if (fault === 'hardlink') linkSync(target, sink);
    else if (fault === 'directory') {
      writeFileSync(sink, '');
      rmSync(sink);
      mkdirSync(sink);
    } else {
      writeFileSync(sink, fault === 'corrupt' ? 'SYNTHETIC-PRIVATE' : '', { mode: 0o600 });
      if (fault === 'public_file') chmodSync(sink, 0o644);
      if (fault === 'public_parent') chmodSync(root, 0o755);
    }
    const before = fault === 'directory' ? null : readFileSync(sink, 'utf8');
    expect(() => appendFamilyDiagnostic(sink, row)).not.toThrow();
    if (before !== null) expect(readFileSync(sink, 'utf8')).toBe(before);
    expect(readFileSync(target, 'utf8')).toBe('SYNTHETIC-PRIVATE');
  }
);
