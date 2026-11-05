import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, test } from 'vitest';

test.each([
  ['harness/harness-managed-file', 'workflow/external-session-managed-file'],
  ['qualification/codex-failure-diagnostics', 'workflow/bounded-candidate-diagnostics']
])('rebuilding removes retired %s outputs without deleting current modules', (retired, current) => {
  const root = mkdtempSync(join(tmpdir(), 'copy-assets-synthetic-'));
  const put = (path: string, bytes: string) => {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  };
  try {
    put('scripts/copy-assets.mjs', readFileSync(new URL('../scripts/copy-assets.mjs', import.meta.url), 'utf8'));
    put('src/migrations/synthetic.sql', 'SELECT 1;');
    put('config/prices/catalogs/synthetic.json', '{}');
    put('skills/synthetic/SKILL.md', 'Synthetic asset');
    for (const extension of ['js', 'js.map', 'd.ts', 'd.ts.map']) {
      put(`dist/${retired}.${extension}`, 'Retired output');
      put(`dist/${current}.${extension}`, 'Current output');
    }
    execFileSync(process.execPath, [join(root, 'scripts/copy-assets.mjs')], { stdio: 'pipe' });
    for (const extension of ['js', 'js.map', 'd.ts', 'd.ts.map']) {
      expect(existsSync(join(root, `dist/${retired}.${extension}`))).toBe(false);
      expect(readFileSync(join(root, `dist/${current}.${extension}`), 'utf8')).toBe('Current output');
    }
    expect(readFileSync(join(root, 'dist/migrations/synthetic.sql'), 'utf8')).toBe('SELECT 1;');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
