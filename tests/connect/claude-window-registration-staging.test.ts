import { closeSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  installClaudeConnectInstallation as install,
  previewClaudeConnectInstallation as preview,
  removeClaudeConnectInstallation as remove,
  statusClaudeConnectInstallation as status
} from '../../src/connect/claude-connect-installation.js';
import type { ClaudeConnectInstallationOptions } from '../../src/connect/claude-connect-installation.js';

vi.mock('node:fs', { spy: true });
const roots: string[] = [];
beforeEach(async () => {
  const native = await vi.importActual<typeof import('node:fs')>('node:fs');
  vi.mocked(openSync).mockImplementation(native.openSync);
  vi.mocked(writeFileSync).mockImplementation(native.writeFileSync);
  vi.mocked(fsyncSync).mockImplementation(native.fsyncSync);
  vi.mocked(closeSync).mockImplementation(native.closeSync);
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(operation: 'window' | 'exact' | 'remove') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'claude-registration-staging-')));
  roots.push(root);
  const project = join(root, 'project');
  const files = ['SKILL.md', 'scripts/connect.mjs', 'scripts/claude-session-hook.mjs'];
  const put = (path: string, bytes: string) => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, bytes, { mode: 0o600 });
  };
  const packageRoot = join(root, 'exact');
  const windowPackageRoot = join(root, 'window');
  for (const directory of [packageRoot, windowPackageRoot]) {
    for (const file of files) put(join(directory, file), `synthetic ${directory === packageRoot ? 'exact' : 'window'} ${file}\n`);
  }
  const settings = join(project, '.claude/settings.local.json');
  put(settings, ' \r\n{ "operator": ["preserve", 1.25] }\r\n');
  const options = { packageRoot, windowPackageRoot };
  const selected = { ...options, bundleMode: operation === 'window' ? 'exact' : 'ordinary_window' } as const;
  const reviewed = (value: ClaudeConnectInstallationOptions, action: 'install' | 'remove' = 'install') => {
    const planned = preview(project, { ...value, operation: action });
    expect(planned.blockers).toEqual([]);
    return { ...value, expectedPackageHash: planned.packageHash, expectedInstalledHash: planned.installedHash };
  };
  expect(install(project, reviewed(selected)).state).toBe('installed');
  const target = { ...options, bundleMode: operation === 'window' ? 'ordinary_window' : 'exact' } as const;
  const reviewedTarget = reviewed(operation === 'remove' ? selected : target, operation === 'remove' ? 'remove' : 'install');
  const manifest = join(project, '.harness-delta/claude-connect/installation.json');
  const bundle = join(project, '.claude/skills/harness-connect');
  const bundleEntries = readdirSync(bundle, { recursive: true, encoding: 'utf8' }).sort();
  const bundleFiles = bundleEntries.filter(path => lstatSync(join(bundle, path)).isFile());
  const before = {
    settings: readFileSync(settings),
    mode: lstatSync(settings).mode & 0o777,
    manifest: readFileSync(manifest),
    bundle: bundleFiles.map(file => readFileSync(join(bundle, file))),
    entries: readdirSync(join(project, '.claude')).sort()
  };
  return {
    project,
    settings,
    selected,
    invoke: () => (operation === 'remove' ? remove(project, reviewedTarget) : install(project, reviewedTarget)),
    assertRestored(foreign?: string) {
      expect(readFileSync(settings)).toEqual(before.settings);
      expect(lstatSync(settings).mode & 0o777).toBe(before.mode);
      expect(readFileSync(manifest)).toEqual(before.manifest);
      expect(bundleFiles.map(file => readFileSync(join(bundle, file)))).toEqual(before.bundle);
      expect(readdirSync(bundle, { recursive: true }).sort()).toEqual(bundleEntries);
      expect(readdirSync(join(project, '.claude')).sort()).toEqual([...before.entries, ...(foreign ? [foreign] : [])].sort());
      expect(readdirSync(join(project, '.harness-delta/claude-connect'))).toEqual(['installation.json']);
      expect(status(project, selected)).toMatchObject({ state: 'installed' });
    }
  };
}

const operations = ['window', 'exact', 'remove'] as const;
for (const operation of operations) {
  test.each(['write', 'fsync', 'close'] as const)('%s failure leaves no settings staging residue during ' + operation, async failure => {
    const f = fixture(operation);
    const native = await vi.importActual<typeof import('node:fs')>('node:fs');
    let descriptor: number | undefined;
    let injected = false;
    vi.mocked(openSync).mockImplementation((path, flags, mode) => {
      const fd = native.openSync(path, flags, mode);
      if (String(path).includes('/.window-hook-settings-')) descriptor = fd;
      return fd;
    });
    vi.mocked(writeFileSync).mockImplementation((file, bytes, options) => {
      if (!injected && file === descriptor && failure === 'write') {
        injected = true;
        native.writeFileSync(file, 'partial synthetic operator settings');
        throw new Error('synthetic_staging_write_failure');
      }
      native.writeFileSync(file, bytes, options);
    });
    vi.mocked(fsyncSync).mockImplementation(fd => {
      if (!injected && fd === descriptor && failure === 'fsync') {
        injected = true;
        throw new Error('synthetic_staging_fsync_failure');
      }
      native.fsyncSync(fd);
    });
    vi.mocked(closeSync).mockImplementation(fd => {
      native.closeSync(fd);
      if (!injected && fd === descriptor && failure === 'close') {
        injected = true;
        throw new Error('synthetic_staging_close_failure');
      }
    });

    expect(f.invoke).toThrow('installation_unavailable');

    expect(injected).toBe(true);
    f.assertRestored();
  });

  test('exclusive-open collision preserves the foreign settings staging file during ' + operation, async () => {
    const f = fixture(operation);
    const native = await vi.importActual<typeof import('node:fs')>('node:fs');
    const foreign = Buffer.from('synthetic foreign file, not owned by the installer\n');
    let collisionPath = '';
    vi.mocked(openSync).mockImplementation((path, flags, mode) => {
      if (!collisionPath && String(path).includes('/.window-hook-settings-')) {
        collisionPath = String(path);
        native.writeFileSync(path, foreign, { flag: 'wx', mode: 0o600 });
      }
      return native.openSync(path, flags, mode);
    });

    expect(f.invoke).toThrow('installation_unavailable');

    expect(collisionPath).not.toBe('');
    expect(readFileSync(collisionPath)).toEqual(foreign);
    expect(lstatSync(collisionPath).mode & 0o777).toBe(0o600);
    f.assertRestored(collisionPath.slice(collisionPath.lastIndexOf('/') + 1));
  });
}
