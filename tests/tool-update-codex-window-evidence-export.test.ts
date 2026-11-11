import { createHash } from 'node:crypto';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { exportWindowEvidence } from '../scripts/tool-update/codex-window-evidence-export.mjs';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const base = mkdtempSync(join(realpathSync(tmpdir()), 'evidence-export-'));
  roots.push(base);
  chmodSync(base, 0o700);
  const evidenceRoot = join(base, 'evidence');
  const exportRoot = join(base, 'export');
  mkdirSync(evidenceRoot, { mode: 0o700 });
  mkdirSync(exportRoot, { mode: 0o700 });
  return { base, evidenceRoot, exportRoot };
}

const sha = (bytes: string) => createHash('sha256').update(bytes).digest('hex');

test('copies bounded JSON evidence out of the image and records each hash', () => {
  const f = fixture();
  writeFileSync(join(f.evidenceRoot, 'synthetic-case.json'), '{"count":1}\n', { mode: 0o600 });
  writeFileSync(join(f.evidenceRoot, 'second.json'), '{"count":2}\n', { mode: 0o600 });
  const summary = exportWindowEvidence({ evidenceRoot: f.evidenceRoot, exportRoot: f.exportRoot });
  expect(summary).toMatchObject({
    total_bytes: 24,
    files: [
      { name: 'second.json', bytes: 12, sha256: sha('{"count":2}\n') },
      { name: 'synthetic-case.json', bytes: 12, sha256: sha('{"count":1}\n') }
    ]
  });
  expect(readFileSync(join(f.exportRoot, 'synthetic-case.json'), 'utf8')).toBe('{"count":1}\n');
  const manifest: unknown = JSON.parse(readFileSync(join(f.exportRoot, 'manifest.json'), 'utf8'));
  expect(manifest).toMatchObject({ total_bytes: 24, files: [{ name: 'second.json' }, { name: 'synthetic-case.json' }] });
});

test('an empty evidence volume exports an empty manifest', () => {
  const f = fixture();
  expect(exportWindowEvidence({ evidenceRoot: f.evidenceRoot, exportRoot: f.exportRoot })).toMatchObject({ total_bytes: 0, files: [] });
});

test.each(['text', 'array', 'scalar'] as const)('refuses evidence that is not a JSON object: %s', variant => {
  const f = fixture();
  writeFileSync(join(f.evidenceRoot, 'raw.json'), { text: 'prompt: please do things', array: '[1]', scalar: '7' }[variant], { mode: 0o600 });
  expect(() => exportWindowEvidence({ evidenceRoot: f.evidenceRoot, exportRoot: f.exportRoot })).toThrow('evidence_export_unsafe');
  expect(readdirSync(f.exportRoot)).toEqual([]);
});

test('refuses a file larger than the per-file bound', () => {
  const f = fixture();
  writeFileSync(join(f.evidenceRoot, 'big.json'), JSON.stringify({ pad: 'x'.repeat(65536) }), { mode: 0o600 });
  expect(() => exportWindowEvidence({ evidenceRoot: f.evidenceRoot, exportRoot: f.exportRoot })).toThrow('evidence_export_unsafe');
});

test('refuses when the total would exceed the retention bound', () => {
  const f = fixture();
  writeFileSync(join(f.evidenceRoot, 'a.json'), '{"a":1}', { mode: 0o600 });
  writeFileSync(join(f.evidenceRoot, 'b.json'), '{"b":2}', { mode: 0o600 });
  expect(() => exportWindowEvidence({ evidenceRoot: f.evidenceRoot, exportRoot: f.exportRoot, maxTotalBytes: 10 })).toThrow('evidence_export_unsafe');
  expect(readdirSync(f.exportRoot)).toEqual([]);
});

test.each(['symlink', 'hardlink', 'directory', 'name'] as const)('refuses an unsafe evidence entry: %s', variant => {
  const f = fixture();
  if (variant === 'symlink') symlinkSync(join(f.base, 'elsewhere.json'), join(f.evidenceRoot, 'link.json'));
  else if (variant === 'hardlink') {
    writeFileSync(join(f.base, 'outside.json'), '{}', { mode: 0o600 });
    linkSync(join(f.base, 'outside.json'), join(f.evidenceRoot, 'linked.json'));
  } else if (variant === 'directory') mkdirSync(join(f.evidenceRoot, 'nested.json'), { mode: 0o700 });
  else writeFileSync(join(f.evidenceRoot, '.hidden'), '{}', { mode: 0o600 });
  expect(() => exportWindowEvidence({ evidenceRoot: f.evidenceRoot, exportRoot: f.exportRoot })).toThrow('evidence_export_unsafe');
  expect(readdirSync(f.exportRoot)).toEqual([]);
});

test('the export root must be private, empty and outside the evidence volume', () => {
  const f = fixture();
  writeFileSync(join(f.exportRoot, 'stale'), '');
  expect(() => exportWindowEvidence({ evidenceRoot: f.evidenceRoot, exportRoot: f.exportRoot })).toThrow('evidence_export_unsafe');
  rmSync(join(f.exportRoot, 'stale'));
  chmodSync(f.exportRoot, 0o755);
  expect(() => exportWindowEvidence({ evidenceRoot: f.evidenceRoot, exportRoot: f.exportRoot })).toThrow('owned_mode_invalid');
  const nested = join(f.evidenceRoot, 'inside');
  mkdirSync(nested, { mode: 0o700 });
  expect(() => exportWindowEvidence({ evidenceRoot: f.evidenceRoot, exportRoot: nested })).toThrow('evidence_export_unsafe');
  expect(existsSync(join(nested, 'manifest.json'))).toBe(false);
});
