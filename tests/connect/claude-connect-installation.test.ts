import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, expect, test, vi } from 'vitest';
import { hashBytes } from '../../src/core/repository-files.js';
import {
  installClaudeConnectInstallation as install,
  previewClaudeConnectInstallation as preview,
  removeClaudeConnectInstallation as remove,
  statusClaudeConnectInstallation as status
} from '../../src/connect/claude-connect-installation.js';
import { recoverClaudeConnectInstallationLock as recover } from '../../src/connect/claude-connect-installation.js';
import type { ClaudeConnectInstallationOptions } from '../../src/connect/claude-connect-installation.js';

const fault = vi.hoisted(() => ({
  manifest: false,
  drift: false,
  rollbackDrift: false,
  activateWindow: false,
  windowActive: false
}));
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      if (fault.manifest && to.endsWith('/installation.json')) {
        if (fault.rollbackDrift) {
          const project = to.split('/.harness-delta/')[0];
          if (project) {
            actual.writeFileSync(join(project, '.claude/skills/harness-connect/SKILL.md'), 'changed after replacement');
          }
        }
        throw new Error('synthetic failure');
      }
      actual.renameSync(from, to);
    },
    mkdirSync: (path: string, options?: import('node:fs').MakeDirectoryOptions) => {
      const result = actual.mkdirSync(path, options);
      if (fault.activateWindow && path.includes('/transaction-')) {
        fault.activateWindow = false;
        fault.windowActive = true;
      }
      if (fault.drift && path.includes('/transaction-')) {
        fault.drift = false;
        const project = path.split('/.harness-delta/')[0];
        if (project) {
          actual.writeFileSync(join(project, '.claude/skills/harness-connect/SKILL.md'), 'concurrent change');
        }
      }
      return result;
    }
  };
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
  const project = join(sandbox, 'project'),
    packageRoot = join(sandbox, 'package');
  mkdirSync(project);
  mkdirSync(packageRoot);
  put(packageRoot, 'SKILL.md', 'synthetic skill');
  put(packageRoot, 'scripts/connect.mjs', 'export const connect = true;\n');
  put(packageRoot, 'scripts/claude-session-hook.mjs', '#!/usr/bin/env node\nexport const hook = true;\n');
  put(packageRoot, 'references/data.json', '{"synthetic":true}\n');
  put(project, '.claude/settings.json', '{"synthetic":"settings"}\n');
  put(project, '.claude/skills/unrelated/SKILL.md', 'unrelated skill');
  return { project, packageRoot, options: { packageRoot } };
}
function windowFixture() {
  const f = fixture();
  const windowPackageRoot = join(dirname(f.project), 'window-package');
  put(windowPackageRoot, 'SKILL.md', 'synthetic window skill');
  put(windowPackageRoot, 'scripts/connect.mjs', 'export const windowConnect = true;\n');
  put(windowPackageRoot, 'scripts/claude-session-hook.mjs', '#!/usr/bin/env node\nexport const windowHook = true;\n');
  const options: ClaudeConnectInstallationOptions = {
    ...f.options,
    bundleMode: 'ordinary_window',
    windowPackageRoot
  };
  return { ...f, windowPackageRoot, windowOptions: options };
}
function reviewed(root: string, options: ClaudeConnectInstallationOptions, operation: 'install' | 'remove' = 'install') {
  const result = preview(root, { ...options, operation });
  expect(result.blockers).toEqual([]);
  return {
    ...options,
    expectedPackageHash: result.packageHash,
    expectedInstalledHash: result.installedHash
  };
}
function snapshot(root: string): string {
  const entries: unknown[] = [];
  function visit(path: string) {
    for (const name of readdirSync(join(root, path)).sort()) {
      const relative = path ? `${path}/${name}` : name;
      const stat = lstatSync(join(root, relative));
      entries.push(stat.isDirectory() ? [relative, stat.mode, stat.ino] : [relative, stat.mode, stat.ino, stat.size, stat.mtimeMs]);
      if (stat.isDirectory()) visit(relative);
      else if (stat.isFile()) {
        entries.push(hashBytes(readFileSync(join(root, relative))));
      }
    }
  }
  visit('');
  return JSON.stringify(entries);
}
afterEach(() => {
  fault.manifest = false;
  fault.drift = false;
  fault.rollbackDrift = false;
  fault.activateWindow = false;
  fault.windowActive = false;
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});
test('preview and status are read-only and expose only relative paths and hashes', () => {
  const f = fixture(),
    before = snapshot(f.project);
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
  expect(manifest).toMatchObject({
    schema_version: 1,
    package: 'harness-connect'
  });
  expect(manifest && typeof manifest === 'object' && 'files' in manifest ? manifest.files : null).toEqual(
    expect.arrayContaining([
      {
        path: 'SKILL.md',
        shipped_sha256: hashBytes('synthetic skill'),
        installed_sha256: hashBytes('synthetic skill')
      },
      {
        path: 'scripts/claude-connect-config.mjs',
        shipped_sha256: null,
        installed_sha256: hashBytes(readFileSync(join(f.project, target, 'scripts/claude-connect-config.mjs')))
      }
    ])
  );
  const previous = process.env.HARNESS_DELTA_CLAUDE_RECEIPT_DIR;
  try {
    const hook: unknown = await import(pathToFileURL(join(f.project, target, 'scripts/claude-session-hook.mjs')).href);
    const connect: unknown = await import(pathToFileURL(join(f.project, target, 'scripts/connect.mjs')).href);
    expect(hook).toMatchObject({ hook: true });
    expect(connect).toMatchObject({ connect: true });
    expect(process.env.HARNESS_DELTA_CLAUDE_RECEIPT_DIR).toBe(join(f.project, metadata, 'receipts') + '/');
  } finally {
    if (previous === undefined) {
      delete process.env.HARNESS_DELTA_CLAUDE_RECEIPT_DIR;
    } else process.env.HARNESS_DELTA_CLAUDE_RECEIPT_DIR = previous;
  }
  expect(existsSync(join(f.project, metadata, 'receipts'))).toBe(false);
  expect(readFileSync(join(f.project, '.claude/settings.json'), 'utf8')).toBe('{"synthetic":"settings"}\n');
  expect(readFileSync(join(f.project, '.claude/skills/unrelated/SKILL.md'), 'utf8')).toBe('unrelated skill');
});
test('repeat install leaves all installed files and manifest unchanged', () => {
  const f = fixture();
  install(f.project, f.options);
  const before = snapshot(f.project);
  expect(install(f.project, f.options).state).toBe('installed');
  expect(preview(f.project, f.options).changes).toEqual([]);
  expect(snapshot(f.project)).toBe(before);
});
test('upgrade adds updates and retires only unchanged owned package files', () => {
  const f = fixture();
  install(f.project, f.options);
  put(f.packageRoot, 'SKILL.md', 'synthetic upgrade');
  rmSync(join(f.packageRoot, 'references/data.json'));
  rmSync(join(f.packageRoot, 'references'), { recursive: true });
  put(f.packageRoot, 'new.json', '{"v":2}');
  expect(status(f.project, f.options).state).toBe('update_available');
  expect(
    preview(f.project, f.options)
      .changes.map(change => change.action)
      .sort()
  ).toEqual(['create', 'delete', 'update']);
  expect(install(f.project, f.options).state).toBe('installed');
  expect(readFileSync(join(f.project, target, 'SKILL.md'), 'utf8')).toBe('synthetic upgrade');
  expect(existsSync(join(f.project, target, 'references/data.json'))).toBe(false);
});
test('remove deletes unchanged owned package and manifest but preserves receipts settings and other skills', () => {
  const f = fixture();
  install(f.project, f.options);
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
  'install and remove refuse %s ownership drift without writes',
  kind => {
    const f = fixture();
    install(f.project, f.options);
    switch (kind) {
      case 'modified':
        put(f.project, `${target}/SKILL.md`, 'user changed');
        break;
      case 'missing':
        rmSync(join(f.project, target, 'SKILL.md'));
        break;
      case 'extra':
        put(f.project, `${target}/unowned.txt`, 'user file');
        break;
      case 'empty directory':
        mkdirSync(join(f.project, target, 'unowned'));
        break;
      case 'manifest invalid':
        put(f.project, `${metadata}/installation.json`, '{}');
        break;
      case 'manifest missing':
        rmSync(join(f.project, metadata, 'installation.json'));
        break;
    }
    const before = snapshot(f.project);
    expect(preview(f.project, f.options).blockers.length).toBeGreaterThan(0);
    expect(install(f.project, f.options).state).toBe('blocked');
    expect(remove(f.project, f.options).state).toBe('blocked');
    expect(snapshot(f.project)).toBe(before);
  }
);
test('pre-existing unowned package is refused even when its files match source', () => {
  const f = fixture();
  put(f.project, `${target}/SKILL.md`, 'synthetic skill');
  const before = snapshot(f.project);
  expect(install(f.project, f.options).blockers).toContain('package_unowned');
  expect(remove(f.project, f.options).state).toBe('blocked');
  expect(snapshot(f.project)).toBe(before);
});
test.each(['.claude', '.claude/skills', target, '.harness-delta', metadata, `${target}/SKILL.md`, `${metadata}/installation.json`])(
  'symlink at %s is rejected without changing either target',
  path => {
    const f = fixture();
    install(f.project, f.options);
    const original = join(f.project, path),
      moved = join(dirname(f.project), 'foreign');
    renameSync(original, moved);
    symlinkSync(moved, original);
    const before = snapshot(f.project),
      foreign = lstatSync(moved).isDirectory() ? snapshot(moved) : hashBytes(readFileSync(moved));
    expect(install(f.project, f.options).state).toBe('blocked');
    expect(remove(f.project, f.options).state).toBe('blocked');
    expect(snapshot(f.project)).toBe(before);
    expect(lstatSync(moved).isDirectory() ? snapshot(moved) : hashBytes(readFileSync(moved))).toBe(foreign);
  }
);
test('project root aliases and unsafe non-directory parents are rejected', () => {
  const f = fixture(),
    alias = join(dirname(f.project), 'alias');
  symlinkSync(f.project, alias);
  expect(preview(alias, f.options).blockers).toContain('unsafe_project_root');
  put(f.project, '.harness-delta', 'not a directory');
  const before = snapshot(f.project);
  expect(install(f.project, f.options).state).toBe('blocked');
  expect(snapshot(f.project)).toBe(before);
});
test('loose private metadata and modified root identity are refused', () => {
  const f = fixture();
  install(f.project, f.options);
  chmodSync(join(f.project, metadata), 0o755);
  expect(remove(f.project, f.options).blockers).toContain('metadata_unsafe');
  chmodSync(join(f.project, metadata), 0o700);
  const original = f.project + '-old';
  renameSync(f.project, original);
  mkdirSync(f.project);
  renameSync(join(original, '.claude'), join(f.project, '.claude'));
  renameSync(join(original, '.harness-delta'), join(f.project, '.harness-delta'));
  expect(remove(f.project, f.options).blockers).toContain('changed_project_root');
});
test('unavailable or unsafe source blocks install but not explicit owned removal', () => {
  const f = fixture();
  install(f.project, f.options);
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
  const f = fixture();
  install(f.project, f.options);
  put(f.packageRoot, 'SKILL.md', 'upgrade');
  fault.drift = true;
  expect(() => install(f.project, f.options)).toThrow('package_drift');
  expect(readFileSync(join(f.project, target, 'SKILL.md'), 'utf8')).toBe('concurrent change');
  expect(status(f.project, f.options).state).toBe('blocked');
  expect(readdirSync(join(f.project, metadata))).toEqual(['installation.json']);
});
test('manifest commit failure restores only the previous owned package', () => {
  const f = fixture();
  install(f.project, f.options);
  const before = snapshot(join(f.project, target)),
    manifest = readFileSync(join(f.project, metadata, 'installation.json'));
  put(f.packageRoot, 'SKILL.md', 'upgrade');
  fault.manifest = true;
  expect(() => install(f.project, f.options)).toThrow('installation_unavailable');
  expect(snapshot(join(f.project, target))).toBe(before);
  expect(readFileSync(join(f.project, metadata, 'installation.json'))).toEqual(manifest);
  expect(readdirSync(join(f.project, metadata))).toEqual(['installation.json']);
});
test('failed fresh install rolls back its package and leaves unrelated files intact', () => {
  const f = fixture();
  const before = snapshot(f.project);
  fault.manifest = true;
  expect(() => install(f.project, f.options)).toThrow('installation_unavailable');
  expect(snapshot(f.project)).toBe(before);
});
test('default source resolves the repository shipped package without an absolute-path seam', () => {
  const f = fixture();
  expect(preview(f.project).source).toBe('available');
  expect(preview(f.project).changes.some(change => change.path === `${target}/scripts/connect.mjs`)).toBe(true);
});
test('rollback refuses to delete a newly changed package and retains recovery blockers', () => {
  const f = fixture();
  install(f.project, f.options);
  put(f.packageRoot, 'SKILL.md', 'upgrade');
  fault.manifest = true;
  fault.rollbackDrift = true;
  expect(() => install(f.project, f.options)).toThrow('installation_rollback_failed');
  expect(readFileSync(join(f.project, target, 'SKILL.md'), 'utf8')).toBe('changed after replacement');
  expect(status(f.project, f.options).state).toBe('blocked');
  expect(existsSync(join(f.project, metadata, 'installation-lock'))).toBe(true);
  expect(readdirSync(join(f.project, metadata)).some(name => name.startsWith('transaction-'))).toBe(true);
});
test('world writable parents and hardlinked owned files are rejected', () => {
  const f = fixture();
  chmodSync(join(f.project, '.claude'), 0o777);
  expect(install(f.project, f.options).blockers).toContain('unsafe_path');
  chmodSync(join(f.project, '.claude'), 0o700);
  install(f.project, f.options);
  linkSync(join(f.project, target, 'SKILL.md'), join(f.project, 'linked'));
  const before = snapshot(f.project);
  expect(remove(f.project, f.options).blockers).toContain('unsafe_path');
  expect(snapshot(f.project)).toBe(before);
});
test('an installation lock blocks read-only plans and explicit mutation', () => {
  const f = fixture();
  install(f.project, f.options);
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
  expect(() =>
    install(f.project, {
      ...f.options,
      expectedPackageHash: reviewed.packageHash,
      expectedInstalledHash: reviewed.installedHash
    })
  ).toThrow('installation_preview_changed');
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
  const f = fixture();
  install(f.project, f.options);
  mkdirSync(join(f.project, metadata, 'installation-lock'), { mode: 0o700 });
  const before = snapshot(f.project);
  expect(status(f.project, f.options).blockers).toContain('installation_recovery_required');
  expect(() => recover(f.project, f.options)).toThrow('installation_recovery_required');
  expect(snapshot(f.project)).toBe(before);
});

test('a proved-dead clean installer releases only its owned metadata lock', () => {
  const f = fixture();
  install(f.project, f.options);
  put(f.project, `${metadata}/installation-lock/owner.json`, JSON.stringify({ pid: 2147483647 }));
  expect(status(f.project, f.options).blockers).toContain('installation_recovery_required');
  expect(recover(f.project, f.options).state).toBe('installed');
  expect(existsSync(join(f.project, metadata, 'installation-lock'))).toBe(false);
  expect(readFileSync(join(f.project, '.claude/settings.json'), 'utf8')).toBe('{"synthetic":"settings"}\n');
});

test('window first install requires reviewed hashes and keeps independent receipt environments', async () => {
  const f = windowFixture();
  const before = snapshot(f.project);
  const proposed = preview(f.project, f.windowOptions);
  expect(proposed).toMatchObject({
    state: 'absent',
    bundleMode: 'ordinary_window',
    bundleRevision: 'claude-window-bundle-v1',
    destination: target,
    receiptDirectory: '.harness-delta/claude-window-receipts',
    hookRegistration: 'unverified'
  });
  expect(() => install(f.project, f.windowOptions)).toThrow('installation_preview_required');
  expect(snapshot(f.project)).toBe(before);
  const result = install(f.project, reviewed(f.project, f.windowOptions));
  expect(result.state).toBe('installed');
  expect(result.installedHash).toBe(result.packageHash);
  const manifest: unknown = JSON.parse(readFileSync(join(f.project, metadata, 'installation.json'), 'utf8'));
  expect(manifest).toMatchObject({
    schema_version: 2,
    bundle_mode: 'ordinary_window',
    bundle_revision: 'claude-window-bundle-v1'
  });
  expect(lstatSync(join(f.project, metadata, 'installation.json')).mode & 0o077).toBe(0);
  const previous = process.env.HARNESS_DELTA_CLAUDE_WINDOW_RECEIPT_DIR;
  const exact = process.env.HARNESS_DELTA_CLAUDE_RECEIPT_DIR;
  try {
    const hook: unknown = await import(pathToFileURL(join(f.project, target, 'scripts/claude-window-session-hook.mjs')).href);
    const helper: unknown = await import(pathToFileURL(join(f.project, target, 'scripts/connect-window.mjs')).href);
    expect(hook).toMatchObject({ windowHook: true });
    expect(helper).toMatchObject({ windowConnect: true });
    expect(process.env.HARNESS_DELTA_CLAUDE_WINDOW_RECEIPT_DIR).toBe(join(f.project, '.harness-delta/claude-window-receipts'));
    expect(process.env.HARNESS_DELTA_CLAUDE_RECEIPT_DIR).toBe(join(f.project, '.harness-delta/claude-connect/receipts') + '/');
  } finally {
    if (previous === undefined) {
      delete process.env.HARNESS_DELTA_CLAUDE_WINDOW_RECEIPT_DIR;
    } else process.env.HARNESS_DELTA_CLAUDE_WINDOW_RECEIPT_DIR = previous;
    if (exact === undefined) {
      delete process.env.HARNESS_DELTA_CLAUDE_RECEIPT_DIR;
    } else process.env.HARNESS_DELTA_CLAUDE_RECEIPT_DIR = exact;
  }
  expect(existsSync(join(f.windowPackageRoot, 'scripts/claude-connect-config.mjs'))).toBe(false);
});

test('exact to window migration is a read-only preview followed by explicit owned-copy apply', () => {
  const f = windowFixture();
  install(f.project, f.options);
  const exact = snapshot(f.project);
  const proposed = preview(f.project, f.windowOptions);
  expect(proposed.state).toBe('update_available');
  expect(proposed.installedHash).toBe(status(f.project, f.options).installedHash);
  expect(proposed.changes.map(change => change.path)).toEqual([
    `${target}/SKILL.md`,
    `${target}/scripts/claude-connect-config.mjs`,
    `${target}/scripts/claude-window-session-hook.mjs`,
    `${target}/scripts/connect-window.mjs`
  ]);
  expect(snapshot(f.project)).toBe(exact);
  expect(install(f.project, f.options).state).toBe('installed');
  expect(() => install(f.project, f.windowOptions)).toThrow('installation_preview_required');
  expect(snapshot(f.project)).toBe(exact);
  expect(install(f.project, reviewed(f.project, f.windowOptions))).toMatchObject({
    state: 'installed',
    bundleMode: 'ordinary_window',
    bundleRevision: 'claude-window-bundle-v1'
  });
  expect(readFileSync(join(f.project, target, 'SKILL.md'), 'utf8')).toBe('synthetic window skill');
});

test('omitting mode preserves the installed window bundle even when an exact package seam is supplied', () => {
  const f = windowFixture();
  install(f.project, reviewed(f.project, f.windowOptions));
  const options = { ...f.options, windowPackageRoot: f.windowPackageRoot };
  const before = snapshot(f.project);
  expect(status(f.project, options)).toMatchObject({
    state: 'installed',
    bundleMode: 'ordinary_window',
    bundleRevision: 'claude-window-bundle-v1'
  });
  expect(preview(f.project, options).changes).toEqual([]);
  expect(install(f.project, options).state).toBe('installed');
  expect(snapshot(f.project)).toBe(before);
  expect(preview(f.project, { ...options, bundleMode: 'exact' }).state).toBe('update_available');
  expect(() => install(f.project, { ...options, bundleMode: 'exact' })).toThrow('installation_preview_required');
  expect(snapshot(f.project)).toBe(before);
});

test.each(['package', 'installed'] as const)('window migration refuses a stale %s hash without writes', kind => {
  const f = windowFixture();
  install(f.project, f.options);
  const options = reviewed(f.project, f.windowOptions);
  if (kind === 'package') {
    put(f.windowPackageRoot, 'SKILL.md', 'new window source');
  } else {
    put(f.packageRoot, 'SKILL.md', 'new exact source');
    install(f.project, f.options);
  }
  const before = snapshot(f.project);
  expect(() => install(f.project, options)).toThrow('installation_preview_changed');
  expect(snapshot(f.project)).toBe(before);
});

test.each(['edited', 'missing', 'symlink', 'extra'] as const)('window install and removal refuse %s owned-file drift', kind => {
  const f = windowFixture();
  install(f.project, reviewed(f.project, f.windowOptions));
  const path = join(f.project, target, 'SKILL.md');
  switch (kind) {
    case 'edited':
      put(f.project, `${target}/SKILL.md`, 'user edit');
      break;
    case 'missing':
      rmSync(path);
      break;
    case 'symlink':
      rmSync(path);
      symlinkSync(join(f.windowPackageRoot, 'SKILL.md'), path);
      break;
    case 'extra':
      put(f.project, `${target}/user.json`, '{"keep":true}');
      break;
  }
  const before = snapshot(f.project);
  const reason = kind === 'symlink' ? 'unsafe_path' : 'package_drift';
  expect(install(f.project, f.windowOptions).blockers).toContain(reason);
  expect(remove(f.project, f.windowOptions).blockers).toContain(reason);
  expect(snapshot(f.project)).toBe(before);
  expect(readFileSync(join(f.windowPackageRoot, 'SKILL.md'), 'utf8')).toBe('synthetic window skill');
});

test.each(['migration', 'upgrade', 'remove'] as const)('trusted in-use proof blocks window %s without native discovery', operation => {
  const f = windowFixture();
  if (operation === 'migration') install(f.project, f.options);
  else install(f.project, reviewed(f.project, f.windowOptions));
  if (operation === 'upgrade') {
    put(f.windowPackageRoot, 'SKILL.md', 'window upgrade');
  }
  const before = snapshot(f.project);
  const options = { ...f.windowOptions, windowInUse: true };
  expect(
    preview(f.project, {
      ...options,
      operation: operation === 'remove' ? 'remove' : 'install'
    }).blockers
  ).toContain('ordinary_installation_in_use');
  expect((operation === 'remove' ? remove : install)(f.project, options).blockers).toContain('ordinary_installation_in_use');
  expect(snapshot(f.project)).toBe(before);
});

test('trusted in-use callback is rechecked after staging before replacing the installed bundle', () => {
  const f = windowFixture();
  install(f.project, f.options);
  const options = reviewed(f.project, {
    ...f.windowOptions,
    windowInUse: () => fault.windowActive
  });
  const before = snapshot(f.project);
  fault.activateWindow = true;
  expect(() => install(f.project, options)).toThrow('ordinary_installation_in_use');
  expect(snapshot(f.project)).toBe(before);
});

test('window removal preserves receipts transcripts and all unrelated settings and hook bytes', () => {
  const f = windowFixture();
  install(f.project, f.options);
  const preserved = [
    ['.claude/settings.json', '{"synthetic":"settings"}\n'],
    ['.claude/settings.local.json', ' { "hooks": { "SessionStart": [] }, "other": true }\n'],
    ['.claude/hooks.json', '{"unrelated":"hooks"}\n'],
    [`${metadata}/receipts/connect/synthetic.json`, '{"exact_receipt":true}'],
    ['.harness-delta/claude-window-receipts/root.json', '{"window_receipt":true}'],
    ['.harness-delta/claude-window-receipts/transcript.jsonl', '{"synthetic_transcript":true}\n']
  ] as const;
  for (const [path, bytes] of preserved) put(f.project, path, bytes);
  install(f.project, reviewed(f.project, f.windowOptions));
  for (const [path, bytes] of preserved) {
    expect(readFileSync(join(f.project, path), 'utf8')).toBe(bytes);
  }
  expect(preview(f.project, { ...f.windowOptions, operation: 'remove' }).changes.every(change => change.path.startsWith(`${target}/`))).toBe(true);
  expect(remove(f.project, reviewed(f.project, f.windowOptions, 'remove')).state).toBe('absent');
  expect(existsSync(join(f.project, target))).toBe(false);
  expect(existsSync(join(f.project, metadata, 'installation.json'))).toBe(false);
  for (const [path, bytes] of preserved) {
    expect(readFileSync(join(f.project, path), 'utf8')).toBe(bytes);
  }
  expect(readFileSync(join(f.project, '.claude/skills/unrelated/SKILL.md'), 'utf8')).toBe('unrelated skill');
});

test.each(['skills', 'dist/skills'] as const)('window installer consumes the selected %s package bytes and adds only local bootstrap', directory => {
  const f = fixture();
  const windowPackageRoot = fileURLToPath(new URL(`../../${directory}/harness-connect-window-claude/`, import.meta.url));
  const options: ClaudeConnectInstallationOptions = {
    ...f.options,
    bundleMode: 'ordinary_window',
    ...(directory === 'dist/skills' ? { windowPackageRoot } : {})
  };
  const result = install(f.project, reviewed(f.project, options));
  expect(result.state).toBe('installed');
  for (const [path, installedPath] of [
    ['SKILL.md', 'SKILL.md'],
    ['scripts/connect.mjs', 'scripts/connect-window.mjs'],
    ['scripts/claude-session-hook.mjs', 'scripts/claude-window-session-hook.mjs']
  ] as const) {
    const source = readFileSync(fileURLToPath(new URL(`../../skills/harness-connect-window-claude/${path}`, import.meta.url)));
    const built = readFileSync(fileURLToPath(new URL(`../../dist/skills/harness-connect-window-claude/${path}`, import.meta.url)));
    expect(source).toEqual(built);
    if (path !== 'scripts/claude-session-hook.mjs') {
      expect(readFileSync(join(f.project, target, installedPath))).toEqual(source);
    } else {
      const text = source.toString('utf8');
      const split = text.startsWith('#!') ? text.indexOf('\n') + 1 : 0;
      expect(readFileSync(join(f.project, target, installedPath), 'utf8')).toBe(
        text.slice(0, split) + "import './claude-connect-config.mjs';\n" + text.slice(split)
      );
    }
  }
  expect(existsSync(join(windowPackageRoot, 'scripts/claude-connect-config.mjs'))).toBe(false);
});

test('in-use proof leaves unchanged window status and legacy exact operations compatible', () => {
  const f = windowFixture();
  expect(install(f.project, { ...f.options, windowInUse: true }).state).toBe('installed');
  const legacy = status(f.project, { ...f.options, windowInUse: true });
  expect(legacy).not.toHaveProperty('bundleMode');
  expect(legacy).not.toHaveProperty('bundleRevision');
  const manifest: unknown = JSON.parse(readFileSync(join(f.project, metadata, 'installation.json'), 'utf8'));
  expect(manifest).toMatchObject({ schema_version: 1 });
  expect(manifest).not.toHaveProperty('bundle_mode');
  install(f.project, reviewed(f.project, f.windowOptions));
  const before = snapshot(f.project);
  const options = { ...f.windowOptions, windowInUse: true };
  expect(status(f.project, options)).toMatchObject({
    state: 'installed',
    bundleMode: 'ordinary_window',
    blockers: []
  });
  expect(preview(f.project, options).changes).toEqual([]);
  expect(install(f.project, options).state).toBe('installed');
  expect(snapshot(f.project)).toBe(before);
});

test('window upgrade failure restores the exact owned package and schema-one manifest', () => {
  const f = windowFixture();
  install(f.project, f.options);
  const options = reviewed(f.project, f.windowOptions);
  const before = snapshot(join(f.project, target));
  const manifest = readFileSync(join(f.project, metadata, 'installation.json'));
  fault.manifest = true;
  expect(() => install(f.project, options)).toThrow('installation_unavailable');
  expect(snapshot(join(f.project, target))).toBe(before);
  expect(readFileSync(join(f.project, metadata, 'installation.json'))).toEqual(manifest);
  expect(readdirSync(join(f.project, metadata))).toEqual(['installation.json']);
});

test('window lock blocks install and remove even with reviewed matching hashes', () => {
  const f = windowFixture();
  install(f.project, reviewed(f.project, f.windowOptions));
  put(f.windowPackageRoot, 'SKILL.md', 'explicit upgrade');
  const options = reviewed(f.project, f.windowOptions);
  put(f.project, `${metadata}/installation-lock/owner.json`, JSON.stringify({ pid: process.pid }));
  const before = snapshot(f.project);
  expect(install(f.project, options).blockers).toContain('installation_busy');
  expect(remove(f.project, options).blockers).toContain('installation_busy');
  expect(snapshot(f.project)).toBe(before);
});

test('window removal remains possible with an unavailable source and retains its receipts', () => {
  const f = windowFixture();
  install(f.project, reviewed(f.project, f.windowOptions));
  put(f.project, '.harness-delta/claude-window-receipts/root.json', '{"synthetic":true}');
  rmSync(f.windowPackageRoot, { recursive: true });
  const options = { ...f.options, windowPackageRoot: f.windowPackageRoot };
  const proposed = preview(f.project, { ...options, operation: 'remove' });
  expect(proposed).toMatchObject({
    source: 'unavailable',
    bundleMode: 'ordinary_window',
    blockers: []
  });
  expect(remove(f.project, reviewed(f.project, options, 'remove')).state).toBe('absent');
  expect(readFileSync(join(f.project, '.harness-delta/claude-window-receipts/root.json'), 'utf8')).toBe('{"synthetic":true}');
});

test('window receipt symlinks are refused without following or deleting their targets', () => {
  const f = windowFixture();
  install(f.project, reviewed(f.project, f.windowOptions));
  symlinkSync(f.windowPackageRoot, join(f.project, '.harness-delta/claude-window-receipts'));
  const before = snapshot(f.project);
  const foreign = snapshot(f.windowPackageRoot);
  expect(remove(f.project, f.windowOptions).blockers).toContain('unsafe_path');
  expect(snapshot(f.project)).toBe(before);
  expect(snapshot(f.windowPackageRoot)).toBe(foreign);
});

test('a window preview cannot authorize the same package in a different project root', () => {
  const f = windowFixture();
  const other = fixture();
  const options = reviewed(f.project, f.windowOptions);
  const before = snapshot(other.project);
  expect(() => install(other.project, options)).toThrow('installation_preview_changed');
  expect(snapshot(other.project)).toBe(before);
});
