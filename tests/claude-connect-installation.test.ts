import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, test, vi } from 'vitest';
import { hashBytes } from '../src/harness-config.js';
import { installClaudeConnectInstallation as install, previewClaudeConnectInstallation as preview,
  removeClaudeConnectInstallation as remove, statusClaudeConnectInstallation as status } from '../src/claude-connect-installation.js';
import { recoverClaudeConnectInstallationLock as recover } from '../src/claude-connect-installation.js';

const fault = vi.hoisted(() => ({ manifest: false, drift: false, rollbackDrift: false }));
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, renameSync: (from: string, to: string) => {
    if (fault.manifest && to.endsWith('/installation.json')) {
      if (fault.rollbackDrift) {
        const project = to.split('/.harness-delta/')[0];
        if (project) actual.writeFileSync(join(project, '.claude/skills/harness-connect/SKILL.md'), 'changed after replacement');
      }
      throw new Error('synthetic failure');
    }
    actual.renameSync(from, to);
  }, mkdirSync: (path: string, options?: import('node:fs').MakeDirectoryOptions) => {
    const result = actual.mkdirSync(path, options);
    if (fault.drift && path.includes('/transaction-')) {
      fault.drift = false;
      const project = path.split('/.harness-delta/')[0];
      if (project) actual.writeFileSync(join(project, '.claude/skills/harness-connect/SKILL.md'), 'concurrent change');
    }
    return result;
  } };
});
const roots: string[] = [];
const target = '.claude/skills/harness-connect';
const metadata = '.harness-delta/claude-connect';
function put(root: string, path: string, text: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true, mode: 0o700 });
  writeFileSync(join(root, path), text, { mode: 0o600 });
}
function fixture() {
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'claude-install-')));
  roots.push(sandbox);
  const project = join(sandbox, 'project'), packageRoot = join(sandbox, 'package');
  mkdirSync(project); mkdirSync(packageRoot);
  put(packageRoot, 'SKILL.md', 'synthetic skill');
  put(packageRoot, 'scripts/connect.mjs', "export const connect = true;\n");
  put(packageRoot, 'scripts/claude-session-hook.mjs', '#!/usr/bin/env node\nexport const hook = true;\n');
  put(packageRoot, 'references/data.json', '{"synthetic":true}\n');
  put(project, '.claude/settings.json', '{"synthetic":"settings"}\n');
  put(project, '.claude/skills/unrelated/SKILL.md', 'unrelated skill');
  return { project, packageRoot, options: { packageRoot } };
}
function snapshot(root: string): string {
  const entries: unknown[] = [];
  function visit(path: string) {
    for (const name of readdirSync(join(root, path)).sort()) {
      const relative = path ? `${path}/${name}` : name;
      const stat = lstatSync(join(root, relative));
      entries.push(stat.isDirectory() ? [relative, stat.mode, stat.ino] : [relative, stat.mode, stat.ino, stat.size, stat.mtimeMs]);
      if (stat.isDirectory()) visit(relative);
      else if (stat.isFile()) entries.push(hashBytes(readFileSync(join(root, relative))));
    }
  }
  visit('');
  return JSON.stringify(entries);
}
afterEach(() => {
  fault.manifest = false; fault.drift = false; fault.rollbackDrift = false;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
test('preview and status are read-only and expose only relative paths and hashes', () => {
  const f = fixture(), before = snapshot(f.project);
  const result = preview(f.project, f.options);
  expect(result.state).toBe('absent');
  expect(result.source).toBe('available');
  expect(result.changes).toHaveLength(5);
  expect(result.changes.every(change => change.action === 'create' && change.beforeHash === null && change.afterHash?.length === 64)).toBe(true);
  expect(JSON.stringify(result)).not.toContain(f.project);
  expect(JSON.stringify(result)).not.toContain(f.packageRoot);
  expect(status(f.project, f.options).hookRegistration).toBe('unverified');
  expect(snapshot(f.project)).toBe(before);
});
test('install persists private ownership and configures the same local receipt directory for both scripts', async () => {
  const f = fixture();
  const result = install(f.project, f.options);
  expect(result.state).toBe('installed');
  expect(result.installedHash).toBe(result.packageHash);
  expect(lstatSync(join(f.project, metadata)).mode & 0o077).toBe(0);
  expect(lstatSync(join(f.project, metadata, 'installation.json')).mode & 0o077).toBe(0);
  const manifest: unknown = JSON.parse(readFileSync(join(f.project, metadata, 'installation.json'), 'utf8'));
  expect(manifest).toMatchObject({ schema_version: 1, package: 'harness-connect' });
  expect(manifest && typeof manifest === 'object' && 'files' in manifest ? manifest.files : null).toEqual(expect.arrayContaining([
    { path: 'SKILL.md', shipped_sha256: hashBytes('synthetic skill'), installed_sha256: hashBytes('synthetic skill') },
    { path: 'scripts/claude-connect-config.mjs', shipped_sha256: null, installed_sha256: hashBytes(readFileSync(join(f.project, target, 'scripts/claude-connect-config.mjs'))) },
  ]));
  const previous = process.env.HARNESS_DELTA_CLAUDE_RECEIPT_DIR;
  try {
    const hook: unknown = await import(pathToFileURL(join(f.project, target, 'scripts/claude-session-hook.mjs')).href);
    const connect: unknown = await import(pathToFileURL(join(f.project, target, 'scripts/connect.mjs')).href);
    expect(hook).toMatchObject({ hook: true });
    expect(connect).toMatchObject({ connect: true });
    expect(process.env.HARNESS_DELTA_CLAUDE_RECEIPT_DIR).toBe(join(f.project, metadata, 'receipts') + '/');
  } finally {
    if (previous === undefined) delete process.env.HARNESS_DELTA_CLAUDE_RECEIPT_DIR;
    else process.env.HARNESS_DELTA_CLAUDE_RECEIPT_DIR = previous;
  }
  expect(existsSync(join(f.project, metadata, 'receipts'))).toBe(false);
  expect(readFileSync(join(f.project, '.claude/settings.json'), 'utf8')).toBe('{"synthetic":"settings"}\n');
  expect(readFileSync(join(f.project, '.claude/skills/unrelated/SKILL.md'), 'utf8')).toBe('unrelated skill');
});
test('repeat install leaves all installed files and manifest unchanged', () => {
  const f = fixture(); install(f.project, f.options);
  const before = snapshot(f.project);
  expect(install(f.project, f.options).state).toBe('installed');
  expect(preview(f.project, f.options).changes).toEqual([]);
  expect(snapshot(f.project)).toBe(before);
});
test('upgrade adds updates and retires only unchanged owned package files', () => {
  const f = fixture(); install(f.project, f.options);
  put(f.packageRoot, 'SKILL.md', 'synthetic upgrade');
  rmSync(join(f.packageRoot, 'references/data.json'));
  rmSync(join(f.packageRoot, 'references'), { recursive: true });
  put(f.packageRoot, 'new.json', '{"v":2}');
  expect(status(f.project, f.options).state).toBe('update_available');
  expect(preview(f.project, f.options).changes.map(change => change.action).sort()).toEqual(['create', 'delete', 'update']);
  expect(install(f.project, f.options).state).toBe('installed');
  expect(readFileSync(join(f.project, target, 'SKILL.md'), 'utf8')).toBe('synthetic upgrade');
  expect(existsSync(join(f.project, target, 'references/data.json'))).toBe(false);
});
test('remove deletes unchanged owned package and manifest but preserves receipts settings and other skills', () => {
  const f = fixture(); install(f.project, f.options);
  put(f.project, `${metadata}/receipts/connect/synthetic.json`, '{"receipt":true}');
  const before = snapshot(f.project);
  expect(preview(f.project, { ...f.options, operation: 'remove' }).changes.every(change => change.action === 'delete')).toBe(true);
  expect(snapshot(f.project)).toBe(before);
  expect(remove(f.project, f.options).state).toBe('absent');
  expect(existsSync(join(f.project, target))).toBe(false);
  expect(existsSync(join(f.project, metadata, 'installation.json'))).toBe(false);
  expect(readFileSync(join(f.project, metadata, 'receipts/connect/synthetic.json'), 'utf8')).toBe('{"receipt":true}');
  expect(existsSync(join(f.project, '.claude/settings.json'))).toBe(true);
  expect(existsSync(join(f.project, '.claude/skills/unrelated/SKILL.md'))).toBe(true);
  const removed = snapshot(f.project);
  expect(remove(f.project, f.options).state).toBe('absent');
  expect(snapshot(f.project)).toBe(removed);
});
test.each(['modified', 'missing', 'extra', 'empty directory', 'manifest invalid', 'manifest missing'])(
  'install and remove refuse %s ownership drift without writes', kind => {
    const f = fixture(); install(f.project, f.options);
    switch (kind) {
      case 'modified': put(f.project, `${target}/SKILL.md`, 'user changed'); break;
      case 'missing': rmSync(join(f.project, target, 'SKILL.md')); break;
      case 'extra': put(f.project, `${target}/unowned.txt`, 'user file'); break;
      case 'empty directory': mkdirSync(join(f.project, target, 'unowned')); break;
      case 'manifest invalid': put(f.project, `${metadata}/installation.json`, '{}'); break;
      case 'manifest missing': rmSync(join(f.project, metadata, 'installation.json')); break;
    }
    const before = snapshot(f.project);
    expect(preview(f.project, f.options).blockers.length).toBeGreaterThan(0);
    expect(install(f.project, f.options).state).toBe('blocked');
    expect(remove(f.project, f.options).state).toBe('blocked');
    expect(snapshot(f.project)).toBe(before);
  },
);
test('pre-existing unowned package is refused even when its files match source', () => {
  const f = fixture(); put(f.project, `${target}/SKILL.md`, 'synthetic skill');
  const before = snapshot(f.project);
  expect(install(f.project, f.options).blockers).toContain('package_unowned');
  expect(remove(f.project, f.options).state).toBe('blocked');
  expect(snapshot(f.project)).toBe(before);
});
test.each(['.claude', '.claude/skills', target, '.harness-delta', metadata, `${target}/SKILL.md`, `${metadata}/installation.json`])(
  'symlink at %s is rejected without changing either target', path => {
    const f = fixture(); install(f.project, f.options);
    const original = join(f.project, path), moved = join(dirname(f.project), 'foreign');
    renameSync(original, moved); symlinkSync(moved, original);
    const before = snapshot(f.project), foreign = lstatSync(moved).isDirectory() ? snapshot(moved) : hashBytes(readFileSync(moved));
    expect(install(f.project, f.options).state).toBe('blocked');
    expect(remove(f.project, f.options).state).toBe('blocked');
    expect(snapshot(f.project)).toBe(before);
    expect(lstatSync(moved).isDirectory() ? snapshot(moved) : hashBytes(readFileSync(moved))).toBe(foreign);
  },
);
test('project root aliases and unsafe non-directory parents are rejected', () => {
  const f = fixture(), alias = join(dirname(f.project), 'alias');
  symlinkSync(f.project, alias);
  expect(preview(alias, f.options).blockers).toContain('unsafe_project_root');
  put(f.project, '.harness-delta', 'not a directory');
  const before = snapshot(f.project);
  expect(install(f.project, f.options).state).toBe('blocked');
  expect(snapshot(f.project)).toBe(before);
});
test('loose private metadata and modified root identity are refused', () => {
  const f = fixture(); install(f.project, f.options);
  chmodSync(join(f.project, metadata), 0o755);
  expect(remove(f.project, f.options).blockers).toContain('metadata_unsafe');
  chmodSync(join(f.project, metadata), 0o700);
  const original = f.project + '-old'; renameSync(f.project, original); mkdirSync(f.project);
  renameSync(join(original, '.claude'), join(f.project, '.claude'));
  renameSync(join(original, '.harness-delta'), join(f.project, '.harness-delta'));
  expect(remove(f.project, f.options).blockers).toContain('changed_project_root');
});
test('unavailable or unsafe source blocks install but not explicit owned removal', () => {
  const f = fixture(); install(f.project, f.options);
  rmSync(f.packageRoot, { recursive: true });
  expect(status(f.project, f.options).source).toBe('unavailable');
  expect(install(f.project, f.options).state).toBe('blocked');
  expect(remove(f.project, f.options).state).toBe('absent');
});
test('source symlinks and unsafe names never appear in sanitized preview', () => {
  const f = fixture();
  symlinkSync(join(f.packageRoot, 'SKILL.md'), join(f.packageRoot, 'link'));
  const before = snapshot(f.project);
  const result = preview(f.project, f.options);
  expect(result.blockers).toContain('package_source_unavailable');
  expect(result.changes).toEqual([]);
  expect(snapshot(f.project)).toBe(before);
});
test('concurrent package change after staging is retained and blocks replacement', () => {
  const f = fixture(); install(f.project, f.options);
  put(f.packageRoot, 'SKILL.md', 'upgrade'); fault.drift = true;
  expect(() => install(f.project, f.options)).toThrow('package_drift');
  expect(readFileSync(join(f.project, target, 'SKILL.md'), 'utf8')).toBe('concurrent change');
  expect(status(f.project, f.options).state).toBe('blocked');
  expect(readdirSync(join(f.project, metadata))).toEqual(['installation.json']);
});
test('manifest commit failure restores only the previous owned package', () => {
  const f = fixture(); install(f.project, f.options);
  const before = snapshot(join(f.project, target)), manifest = readFileSync(join(f.project, metadata, 'installation.json'));
  put(f.packageRoot, 'SKILL.md', 'upgrade'); fault.manifest = true;
  expect(() => install(f.project, f.options)).toThrow('installation_unavailable');
  expect(snapshot(join(f.project, target))).toBe(before);
  expect(readFileSync(join(f.project, metadata, 'installation.json'))).toEqual(manifest);
  expect(readdirSync(join(f.project, metadata))).toEqual(['installation.json']);
});
test('failed fresh install rolls back its package and leaves unrelated files intact', () => {
  const f = fixture(); const before = snapshot(f.project); fault.manifest = true;
  expect(() => install(f.project, f.options)).toThrow('installation_unavailable');
  expect(snapshot(f.project)).toBe(before);
});
test('default source resolves the repository shipped package without an absolute-path seam', () => {
  const f = fixture();
  expect(preview(f.project).source).toBe('available');
  expect(preview(f.project).changes.some(change => change.path === `${target}/scripts/connect.mjs`)).toBe(true);
});
test('rollback refuses to delete a newly changed package and retains recovery blockers', () => {
  const f = fixture(); install(f.project, f.options);
  put(f.packageRoot, 'SKILL.md', 'upgrade'); fault.manifest = true; fault.rollbackDrift = true;
  expect(() => install(f.project, f.options)).toThrow('installation_rollback_failed');
  expect(readFileSync(join(f.project, target, 'SKILL.md'), 'utf8')).toBe('changed after replacement');
  expect(status(f.project, f.options).state).toBe('blocked');
  expect(existsSync(join(f.project, metadata, 'installation-lock'))).toBe(true);
  expect(readdirSync(join(f.project, metadata)).some(name => name.startsWith('transaction-'))).toBe(true);
});
test('world writable parents and hardlinked owned files are rejected', () => {
  const f = fixture(); chmodSync(join(f.project, '.claude'), 0o777);
  expect(install(f.project, f.options).blockers).toContain('unsafe_path');
  chmodSync(join(f.project, '.claude'), 0o700); install(f.project, f.options);
  linkSync(join(f.project, target, 'SKILL.md'), join(f.project, 'linked'));
  const before = snapshot(f.project);
  expect(remove(f.project, f.options).blockers).toContain('unsafe_path');
  expect(snapshot(f.project)).toBe(before);
});
test('an installation lock blocks read-only plans and explicit mutation', () => {
  const f = fixture(); install(f.project, f.options);
  mkdirSync(join(f.project, metadata, 'installation-lock'), { mode: 0o700 });
  writeFileSync(join(f.project, metadata, 'installation-lock', 'owner.json'), JSON.stringify({ pid: process.pid }), { mode: 0o600 });
  const before = snapshot(f.project);
  expect(preview(f.project, f.options).blockers).toContain('installation_busy');
  expect(install(f.project, f.options).state).toBe('blocked');
  expect(remove(f.project, f.options).state).toBe('blocked');
  expect(snapshot(f.project)).toBe(before);
});

test('a reviewed source hash cannot install a changed package', () => {
  const f = fixture();
  const reviewed = preview(f.project, f.options);
  put(f.packageRoot, 'SKILL.md', 'changed synthetic source');
  const before = snapshot(f.project);
  expect(() => install(f.project, { ...f.options, expectedPackageHash: reviewed.packageHash,
    expectedInstalledHash: reviewed.installedHash })).toThrow('installation_preview_changed');
  expect(snapshot(f.project)).toBe(before);
});

test('trusted source hardlinks are readable while owned destination hardlinks remain blocked', () => {
  const f = fixture();
  linkSync(join(f.packageRoot, 'SKILL.md'), join(f.project, 'source-copy'));
  expect(install(f.project, f.options).state).toBe('installed');
  linkSync(join(f.project, target, 'SKILL.md'), join(f.project, 'owned-copy'));
  expect(remove(f.project, f.options).blockers).toContain('unsafe_path');
});

test('an unverified installer lock requires recovery without changing any files', () => {
  const f = fixture(); install(f.project, f.options);
  mkdirSync(join(f.project, metadata, 'installation-lock'), { mode: 0o700 });
  const before = snapshot(f.project);
  expect(status(f.project, f.options).blockers).toContain('installation_recovery_required');
  expect(() => recover(f.project, f.options)).toThrow('installation_recovery_required');
  expect(snapshot(f.project)).toBe(before);
});

test('a proved-dead clean installer releases only its owned metadata lock', () => {
  const f = fixture(); install(f.project, f.options);
  put(f.project, `${metadata}/installation-lock/owner.json`, JSON.stringify({ pid: 2147483647 }));
  expect(status(f.project, f.options).blockers).toContain('installation_recovery_required');
  expect(recover(f.project, f.options).state).toBe('installed');
  expect(existsSync(join(f.project, metadata, 'installation-lock'))).toBe(false);
  expect(readFileSync(join(f.project, '.claude/settings.json'), 'utf8')).toBe('{"synthetic":"settings"}\n');
});
