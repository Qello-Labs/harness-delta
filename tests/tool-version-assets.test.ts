import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';

const repository = fileURLToPath(new URL('../', import.meta.url));
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'tool-version-assets-'));
  roots.push(root);
  for (const path of [
    'scripts/generate-tool-version-assets.mjs',
    'scripts/session-binding-codex-hook.template.mjs',
    'src/core/tool-version-profiles.json',
    'src/core/tool-version-recipes.json',
    'src/core/tool-version-identities.json',
    'docs/runbooks/harness-connect.md',
    'docs/runbooks/harness-connect.ko.md',
    'docs/runbooks/workflow-quickstart.md',
    'docs/runbooks/workflow-quickstart.ko.md'
  ]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(join(repository, path), join(root, path));
  }
  expect(run(root).status).toBe(0);
  return root;
}

function run(root: string, args: readonly string[] = []) {
  const result = spawnSync(process.execPath, [join(root, 'scripts/generate-tool-version-assets.mjs'), ...args], {
    encoding: 'utf8',
    timeout: 10000
  });
  if (result.error) throw result.error;
  return result;
}

function snapshot(root: string) {
  const rows: unknown[] = [];
  const visit = (path: string) => {
    for (const entry of readdirSync(join(root, path), {
      withFileTypes: true
    })) {
      const name = join(path, entry.name);
      if (entry.isDirectory()) visit(name);
      else {
        const stat = statSync(join(root, name), { bigint: true });
        rows.push({
          path: name,
          mode: stat.mode,
          mtime: stat.mtimeNs,
          ctime: stat.ctimeNs,
          inode: stat.ino,
          digest: createHash('sha256')
            .update(readFileSync(join(root, name)))
            .digest('hex')
        });
      }
    }
  };
  visit('');
  return rows;
}

test('checking current generated assets preserves every file byte and metadata', () => {
  const root = fixture();
  const before = snapshot(root);
  const result = run(root, ['--check']);
  expect(result.status).toBe(0);
  const output: unknown = JSON.parse(result.stdout);
  expect(output).toMatchObject({ status: 'tool_version_assets_current' });
  expect(snapshot(root)).toEqual(before);
});

test.each(['stale', 'missing', 'read_only'] as const)('checking a %s generated asset fails without repairs', condition => {
  const root = fixture();
  const target = join(root, 'scripts/generated/tool-version-data.mjs');
  if (condition === 'stale') {
    writeFileSync(target, 'Synthetic stale artifact');
  } else if (condition === 'missing') unlinkSync(target);
  else chmodSync(target, 0o444);
  const before = snapshot(root);
  const result = run(root, ['--check']);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(`tool_version_assets_${condition}:scripts/generated/tool-version-data.mjs`);
  expect(snapshot(root)).toEqual(before);
});
