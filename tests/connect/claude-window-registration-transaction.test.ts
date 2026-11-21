import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  installClaudeConnectInstallation as install,
  previewClaudeConnectInstallation as preview,
  statusClaudeConnectInstallation as status
} from '../../src/connect/claude-connect-installation.js';
import type { ClaudeConnectInstallationOptions } from '../../src/connect/claude-connect-installation.js';

vi.mock('node:fs', { spy: true });
const roots: string[] = [];
beforeEach(async () => {
  const native = await vi.importActual<typeof import('node:fs')>('node:fs');
  vi.mocked(renameSync).mockImplementation(native.renameSync);
  vi.mocked(mkdirSync).mockImplementation(native.mkdirSync);
  vi.mocked(lstatSync).mockImplementation(native.lstatSync);
  vi.mocked(unlinkSync).mockImplementation(native.unlinkSync);
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(initial?: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'claude-registration-transaction-')));
  roots.push(root);
  const project = join(root, 'project');
  mkdirSync(project, { mode: 0o700 });
  const put = (path: string, text: string) => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, text, { mode: 0o600 });
  };
  const packageRoot = join(root, 'exact'),
    windowPackageRoot = join(root, 'window');
  for (const directory of [packageRoot, windowPackageRoot]) {
    put(join(directory, 'SKILL.md'), 'synthetic installer fixture\n');
    put(join(directory, 'scripts/connect.mjs'), 'export const synthetic = true;\n');
    put(join(directory, 'scripts/claude-session-hook.mjs'), 'throw new Error("must not execute");\n');
  }
  const settings = join(project, '.claude/settings.local.json');
  if (initial !== undefined) {
    put(settings, initial);
    chmodSync(settings, 0o640);
  }
  const options = { packageRoot, windowPackageRoot, bundleMode: 'ordinary_window' } as const;
  const reviewed = (selected: ClaudeConnectInstallationOptions = options) => {
    const p = preview(project, selected);
    expect(p.blockers).toEqual([]);
    return { ...selected, expectedPackageHash: p.packageHash, expectedInstalledHash: p.installedHash };
  };
  return { project, options, settings, reviewed };
}

test.each([undefined, ' \r\n{ "operator": [1,2,3] }\r\n'])('manifest failure restores original settings bytes and ownership: %s', async initial => {
  const f = fixture(initial);
  const native = await vi.importActual<typeof import('node:fs')>('node:fs');
  vi.mocked(renameSync).mockImplementation((from, to) => {
    if (String(to).endsWith('/installation.json')) throw new Error('synthetic_manifest_failure');
    native.renameSync(from, to);
  });

  expect(() => install(f.project, f.reviewed())).toThrow('installation_unavailable');

  expect(existsSync(join(f.project, '.claude/skills/harness-connect'))).toBe(false);
  expect(existsSync(join(f.project, '.harness-delta/claude-connect/installation.json'))).toBe(false);
  if (initial === undefined) expect(existsSync(f.settings)).toBe(false);
  else {
    expect(readFileSync(f.settings, 'utf8')).toBe(initial);
    expect(lstatSync(f.settings).mode & 0o777).toBe(0o640);
  }
});

test('failed exact migration restores the owned window registration and old manifest', async () => {
  const f = fixture();
  install(f.project, f.reviewed());
  const before = readFileSync(f.settings);
  const manifest = join(f.project, '.harness-delta/claude-connect/installation.json');
  const previousManifest = readFileSync(manifest);
  const exact = { ...f.options, bundleMode: 'exact' } as const;
  const reviewed = f.reviewed(exact);
  const native = await vi.importActual<typeof import('node:fs')>('node:fs');
  vi.mocked(renameSync).mockImplementation((from, to) => {
    if (String(to) === manifest) throw new Error('synthetic_manifest_failure');
    native.renameSync(from, to);
  });

  expect(() => install(f.project, reviewed)).toThrow('installation_unavailable');

  expect(readFileSync(f.settings)).toEqual(before);
  expect(readFileSync(manifest)).toEqual(previousManifest);
  expect(status(f.project, f.options)).toMatchObject({ state: 'installed', recorderRegistration: 'present' });
});

test('a settings edit during staging is preserved and refuses the reviewed installation', async () => {
  const original = '{ "operator": "before" }\n';
  const changed = '{ "operator": "during staging" }\n';
  const f = fixture(original);
  const reviewed = f.reviewed();
  const native = await vi.importActual<typeof import('node:fs')>('node:fs');
  let changedOnce = false;
  vi.mocked(mkdirSync).mockImplementation((path, options) => {
    const result = native.mkdirSync(path, options);
    if (!changedOnce && String(path).includes('/transaction-')) {
      changedOnce = true;
      native.writeFileSync(f.settings, changed);
    }
    return result;
  });

  expect(() => install(f.project, reviewed)).toThrow('installation_preview_changed');

  expect(changedOnce).toBe(true);
  expect(readFileSync(f.settings, 'utf8')).toBe(changed);
  expect(existsSync(join(f.project, '.claude/skills/harness-connect'))).toBe(false);
  expect(existsSync(join(f.project, '.harness-delta/claude-connect/installation.json'))).toBe(false);
});

test('a late operator deletion is not undone by rollback after the package replacement', async () => {
  const f = fixture();
  install(f.project, f.reviewed());
  const manifest = join(f.project, '.harness-delta/claude-connect/installation.json');
  const previousManifest = readFileSync(manifest);
  const exact = { ...f.options, bundleMode: 'exact' } as const;
  const reviewed = f.reviewed(exact);
  const native = await vi.importActual<typeof import('node:fs')>('node:fs');
  let deleted = false;
  vi.mocked(renameSync).mockImplementation((from, to) => {
    native.renameSync(from, to);
    if (!deleted && String(from).endsWith('/package') && String(to).endsWith('/.claude/skills/harness-connect')) {
      deleted = true;
      native.unlinkSync(f.settings);
    }
  });

  expect(() => install(f.project, reviewed)).toThrow('installation_preview_changed');

  expect(deleted).toBe(true);
  expect(existsSync(f.settings)).toBe(false);
  expect(readFileSync(manifest)).toEqual(previousManifest);
  expect(existsSync(join(f.project, '.claude/skills/harness-connect/scripts/claude-window-session-hook.mjs'))).toBe(true);
});

test('a settings readback failure still rolls back an already completed atomic replacement', async () => {
  const f = fixture();
  const native = await vi.importActual<typeof import('node:fs')>('node:fs');
  let replaced = false;
  vi.mocked(renameSync).mockImplementation((from, to) => {
    native.renameSync(from, to);
    if (!replaced && String(to) === f.settings) {
      replaced = true;
      vi.mocked(lstatSync).mockImplementationOnce(() => {
        throw new Error('synthetic_readback_failure');
      });
    }
  });

  expect(() => install(f.project, f.reviewed())).toThrow('installation_unavailable');

  expect(replaced).toBe(true);
  expect(existsSync(f.settings)).toBe(false);
  expect(existsSync(join(f.project, '.claude/skills/harness-connect'))).toBe(false);
  expect(existsSync(join(f.project, '.harness-delta/claude-connect/installation.json'))).toBe(false);
});

test('a settings readback failure still rolls back an already completed unlink', async () => {
  const f = fixture();
  install(f.project, f.reviewed());
  const before = readFileSync(f.settings);
  const manifest = join(f.project, '.harness-delta/claude-connect/installation.json');
  const previousManifest = readFileSync(manifest);
  const exact = { ...f.options, bundleMode: 'exact' } as const;
  const reviewed = f.reviewed(exact);
  const native = await vi.importActual<typeof import('node:fs')>('node:fs');
  let removed = false;
  vi.mocked(unlinkSync).mockImplementation(path => {
    native.unlinkSync(path);
    if (!removed && String(path) === f.settings) {
      removed = true;
      vi.mocked(lstatSync).mockImplementationOnce(() => {
        throw new Error('synthetic_readback_failure');
      });
    }
  });

  expect(() => install(f.project, reviewed)).toThrow('installation_unavailable');

  expect(removed).toBe(true);
  expect(readFileSync(f.settings)).toEqual(before);
  expect(readFileSync(manifest)).toEqual(previousManifest);
  expect(status(f.project, f.options)).toMatchObject({ state: 'installed', recorderRegistration: 'present' });
});
