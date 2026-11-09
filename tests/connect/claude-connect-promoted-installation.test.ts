import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, test, vi } from 'vitest';
import * as repositoryFiles from '../../src/core/repository-files.js';
import {
  installClaudeConnectInstallation as install,
  previewClaudeConnectInstallation as preview,
  removeClaudeConnectInstallation as remove,
  statusClaudeConnectInstallation as status,
  verifyClaudePromotedConnectContract
} from '../../src/connect/claude-connect-installation.js';
import type { ClaudePromotedConnectInstallationOptions } from '../../src/connect/claude-connect-installation.js';

const roots: string[] = [];
const target = '.claude/skills/harness-connect';
const legacyHook = 'node "$CLAUDE_PROJECT_DIR/.claude/skills/harness-connect/scripts/claude-session-hook.mjs" record';
const promotedHook = 'node "$CLAUDE_PROJECT_DIR/.claude/skills/harness-connect/scripts/claude-promoted-session-hook.mjs" record';
function put(root: string, path: string, text: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true, mode: 0o700 });
  writeFileSync(join(root, path), text, { mode: 0o600 });
}
function fixture(owned = true) {
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'claude-promoted-install-')));
  roots.push(sandbox);
  const project = join(sandbox, 'project');
  const packageRoot = join(sandbox, 'legacy');
  const promotedPackageRoot = join(sandbox, 'promoted');
  mkdirSync(project, { mode: 0o700 });
  put(
    packageRoot,
    'SKILL.md',
    `---\nname: harness-connect\nhooks:\n  PreToolUse:\n    - hooks:\n        - type: command\n          command: '${legacyHook}'\n---\n`
  );
  put(packageRoot, 'scripts/connect.mjs', 'export const legacy = true;\n');
  put(packageRoot, 'scripts/claude-session-hook.mjs', 'throw new Error("legacy must never launch");\n');
  put(packageRoot, 'references/support.txt', 'synthetic reference\n');
  put(
    promotedPackageRoot,
    'SKILL.md',
    `---\nname: harness-connect\nhooks:\n  PreToolUse:\n    - hooks:\n        - type: command\n          command: '${promotedHook}'\n---\n`
  );
  put(promotedPackageRoot, 'scripts/connect.mjs', 'export const contract = "promoted-payload-v1";\n');
  put(promotedPackageRoot, 'scripts/claude-session-hook.mjs', '#!/usr/bin/env node\nexport const contract = "promoted-payload-v1";\n');
  const settings = JSON.stringify({
    env: { SYNTHETIC: 'preserve' },
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'echo unrelated' }] }]
    }
  });
  put(project, '.claude/settings.json', settings);
  put(project, '.claude/skills/unrelated/SKILL.md', '---\nname: unrelated\ncustom: preserved\nhooks:\n  Stop: []\n---\n');
  const options = {
    packageRoot,
    promotedPackageRoot,
    bundleMode: 'promoted',
    productVersion: '2.1.319',
    promotedInUse: false,
    quiescentBoundaryConfirmed: true
  } satisfies ClaudePromotedConnectInstallationOptions;
  if (owned) {
    expect(install(project, { packageRoot }).state).toBe('installed');
  }
  return { project, packageRoot, promotedPackageRoot, options, settings };
}
function reviewed(project: string, options: NonNullable<Parameters<typeof preview>[1]>) {
  const result = preview(project, options);
  expect(result.blockers).toEqual([]);
  return {
    ...options,
    expectedPackageHash: result.packageHash,
    expectedInstalledHash: result.installedHash
  };
}
test('live promoted contract verification accepts an active installation without changing its files', () => {
  const f = fixture();
  install(f.project, reviewed(f.project, f.options));
  const before = readFileSync(join(f.project, target, 'scripts/claude-promoted-connect-config.mjs'));
  expect(
    verifyClaudePromotedConnectContract(f.project, {
      ...f.options,
      promotedInUse: true
    })
  ).toEqual({
    bundleContract: 'claude-promoted-bundle-v1',
    producerContract: 'promoted-payload-v1',
    receiptDirectory: join(f.project, '.harness-delta/claude-promoted-receipts')
  });
  expect(readFileSync(join(f.project, target, 'scripts/claude-promoted-connect-config.mjs'))).toEqual(before);
  expect(() =>
    verifyClaudePromotedConnectContract(f.project, {
      ...f.options,
      productVersion: '2.1.320'
    })
  ).toThrow('package_drift');
});

test('live promoted contract verification rejects a reintroduced legacy registration', () => {
  const f = fixture();
  install(f.project, reviewed(f.project, f.options));
  put(f.project, '.claude/settings.local.json', JSON.stringify({ hooks: { Stop: [{ command: legacyHook }] } }));
  expect(() => verifyClaudePromotedConnectContract(f.project, f.options)).toThrow('promoted_registration_conflict');
});

test('reuses verified Claude installation bytes and hashes only while inputs are unchanged', () => {
  const f = fixture();
  install(f.project, reviewed(f.project, f.options));
  const read = vi.spyOn(repositoryFiles, 'readRepositoryFile');
  const hash = vi.spyOn(repositoryFiles, 'hashBytes');
  const contract = verifyClaudePromotedConnectContract(f.project, f.options);
  expect(read).toHaveBeenCalled();
  expect(hash).toHaveBeenCalled();
  read.mockClear();
  hash.mockClear();

  roots.push(realpathSync(mkdtempSync(join(tmpdir(), 'unrelated-installer-'))));
  for (let i = 0; i < 3; i++) {
    expect(
      verifyClaudePromotedConnectContract(f.project, {
        ...f.options,
        promotedInUse: true
      })
    ).toEqual(contract);
  }
  expect(read).not.toHaveBeenCalled();
  expect(hash).not.toHaveBeenCalled();
});

test.each(['replacement', 'mode', 'package option'] as const)('rechecks Claude bytes after a safe %s identity change', change => {
  const f = fixture();
  install(f.project, reviewed(f.project, f.options));
  verifyClaudePromotedConnectContract(f.project, f.options);
  const read = vi.spyOn(repositoryFiles, 'readRepositoryFile');
  const path = join(f.project, target, 'scripts/connect-promoted.mjs');
  if (change === 'replacement') {
    writeFileSync(`${path}.replacement`, readFileSync(path), {
      mode: 0o600
    });
    renameSync(`${path}.replacement`, path);
  }
  if (change === 'mode') chmodSync(path, 0o400);
  const options = change === 'package option' ? { ...f.options, packageRoot: join(f.project, 'unused-package') } : f.options;
  expect(verifyClaudePromotedConnectContract(f.project, options).producerContract).toBe('promoted-payload-v1');
  expect(read).toHaveBeenCalled();
});

test.each([
  'installed content',
  'installed replacement',
  'installed entry',
  'installed ancestor',
  'installed link count',
  'manifest',
  'settings',
  'local settings',
  'config',
  'receipt directory',
  'shipped content',
  'shipped entry',
  'shipped ancestor',
  'version',
  'package selection'
] as const)('refuses Claude verification after cached %s changes', change => {
  const f = fixture();
  install(f.project, reviewed(f.project, f.options));
  const path = join(f.project, target, 'scripts/connect-promoted.mjs');
  const contentPath = change === 'shipped content' ? join(f.promotedPackageRoot, 'scripts/connect.mjs') : path;
  if (change === 'installed content' || change === 'shipped content') {
    utimesSync(contentPath, 1, 1);
  }
  verifyClaudePromotedConnectContract(f.project, f.options);
  if (change === 'installed content' || change === 'shipped content') {
    writeFileSync(
      contentPath,
      readFileSync(contentPath).map(byte => (byte === 116 ? 102 : byte))
    );
    utimesSync(contentPath, 1, 1);
  }
  if (change === 'installed replacement') {
    writeFileSync(`${path}.replacement`, 'synthetic replacement', {
      mode: 0o600
    });
    renameSync(`${path}.replacement`, path);
  }
  if (change === 'installed entry') {
    put(f.project, `${target}/unexpected`, 'synthetic');
  }
  if (change === 'installed ancestor') {
    chmodSync(join(f.project, '.claude'), 0o777);
  }
  if (change === 'installed link count') {
    linkSync(path, join(f.packageRoot, 'linked-helper'));
  }
  if (change === 'manifest') {
    put(f.project, '.harness-delta/claude-connect/installation.json', '{}');
  }
  if (change === 'settings' || change === 'local settings') {
    put(
      f.project,
      change === 'settings' ? '.claude/settings.json' : '.claude/settings.local.json',
      JSON.stringify({ hooks: { Stop: [{ command: legacyHook }] } })
    );
  }
  if (change === 'config') {
    put(f.project, `${target}/scripts/claude-promoted-connect-config.mjs`, 'synthetic changed config');
  }
  if (change === 'receipt directory') {
    renameSync(join(f.project, '.harness-delta/claude-promoted-receipts'), join(f.packageRoot, 'previous-receipts'));
    put(f.project, '.harness-delta/claude-promoted-receipts', 'synthetic');
  }
  if (change === 'shipped entry') {
    put(f.promotedPackageRoot, 'unexpected', 'synthetic');
  }
  if (change === 'shipped ancestor') {
    chmodSync(join(f.promotedPackageRoot, 'scripts'), 0o777);
  }
  const options =
    change === 'version'
      ? { ...f.options, productVersion: '2.1.320' }
      : change === 'package selection'
        ? {
            ...f.options,
            promotedPackageRoot: join(f.project, 'missing-package')
          }
        : f.options;
  expect(() => verifyClaudePromotedConnectContract(f.project, options)).toThrow();
});

test('promoted installation creates private pending receipt storage', () => {
  const f = fixture(false);
  const planned = preview(f.project, f.options);
  expect(planned.changes.find(change => change.path === planned.receiptDirectory)).toMatchObject({ action: 'create' });
  const installed = install(f.project, reviewed(f.project, f.options));
  const storage = lstatSync(join(f.project, installed.receiptDirectory));
  expect(storage.isDirectory()).toBe(true);
  expect(storage.mode & 0o777).toBe(0o700);
});
test('promoted receipt storage changes invalidate a reviewed installation', () => {
  const f = fixture();
  const accepted = reviewed(f.project, f.options);
  mkdirSync(join(f.project, '.harness-delta/claude-promoted-receipts'), {
    mode: 0o700
  });
  expect(() => install(f.project, accepted)).toThrow('installation_preview_changed');
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test.each([true, false])('promoted preview/apply preserves legacy bytes and disables its registration (owned=%s)', async owned => {
  const f = fixture(owned);
  const legacyPaths = ['scripts/connect.mjs', 'scripts/claude-session-hook.mjs', 'scripts/claude-connect-config.mjs', 'references/support.txt'];
  const historical = owned ? legacyPaths.map(path => [path, readFileSync(join(f.project, target, path))] as const) : [];
  const p = preview(f.project, f.options);
  expect(p).toMatchObject({
    bundleMode: 'promoted',
    bundleRevision: 'claude-promoted-bundle-v1',
    producerContract: 'promoted_producer_contract_unverified',
    requiresFreshRoots: true,
    blockers: []
  });
  expect(p.changes.some(change => change.action === 'delete')).toBe(false);
  expect(install(f.project, reviewed(f.project, f.options))).toMatchObject({
    state: 'installed',
    producerContract: 'promoted_producer_contract_unverified'
  });
  for (const [path, bytes] of historical) {
    expect(readFileSync(join(f.project, target, path))).toEqual(bytes);
  }
  expect(readFileSync(join(f.project, target, 'SKILL.md'))).toEqual(readFileSync(join(f.promotedPackageRoot, 'SKILL.md')));
  expect(readFileSync(join(f.project, '.claude/settings.json'), 'utf8')).toBe(f.settings);
  expect(readFileSync(join(f.project, '.claude/skills/unrelated/SKILL.md'), 'utf8')).toContain('custom: preserved');
  const manifest: unknown = JSON.parse(readFileSync(join(f.project, '.harness-delta/claude-connect/installation.json'), 'utf8'));
  expect(manifest).toMatchObject({
    schema_version: 3,
    bundle_mode: 'promoted',
    bundle_revision: 'claude-promoted-bundle-v1'
  });
  const names = ['HARNESS_DELTA_PROMOTED_RECEIPT_DIR', 'HARNESS_DELTA_PROMOTED_PROJECT_ROOT', 'HARNESS_DELTA_PROMOTED_PRODUCT_VERSION'];
  const before = names.map(name => process.env[name]);
  try {
    expect(await import(pathToFileURL(join(f.project, target, 'scripts/connect-promoted.mjs')).href)).toMatchObject({ contract: 'promoted-payload-v1' });
    expect(await import(pathToFileURL(join(f.project, target, 'scripts/claude-promoted-session-hook.mjs')).href)).toMatchObject({
      contract: 'promoted-payload-v1'
    });
    expect(process.env.HARNESS_DELTA_PROMOTED_RECEIPT_DIR).toBe(join(f.project, '.harness-delta/claude-promoted-receipts'));
    expect(process.env.HARNESS_DELTA_PROMOTED_PROJECT_ROOT).toBe(f.project);
    expect(process.env.HARNESS_DELTA_PROMOTED_PRODUCT_VERSION).toBe('2.1.319');
  } finally {
    for (const [index, name] of names.entries()) {
      const value = before[index];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  expect(status(f.project, f.options)).toMatchObject({
    state: 'installed',
    requiresFreshRoots: true,
    producerContract: 'promoted_producer_contract_unverified'
  });
});

test.each([
  [{ promotedInUse: undefined }, 'promoted_in_use_unverified'],
  [{ promotedInUse: true }, 'promoted_installation_in_use'],
  [{ promotedInUse: () => true }, 'promoted_installation_in_use'],
  [{ quiescentBoundaryConfirmed: false }, 'promoted_quiescent_boundary_unconfirmed'],
  [{ productVersion: undefined }, 'promoted_product_version_invalid'],
  [{ productVersion: '2.1.319-beta' }, 'promoted_product_version_invalid'],
  [{ productVersion: '02.1.319' }, 'promoted_product_version_invalid']
])('refuses unsafe promoted cutover options %j', (override, code) => {
  const f = fixture();
  const options = { ...f.options, ...override };
  const before = readFileSync(join(f.project, target, 'SKILL.md'));
  const result = preview(f.project, options);
  expect(result).toMatchObject({
    state: 'blocked',
    changes: []
  });
  expect(result.blockers).toContain(code);
  expect(install(f.project, options).state).toBe('blocked');
  expect(readFileSync(join(f.project, target, 'SKILL.md'))).toEqual(before);
});

test.each(['edited', 'unowned', 'settings'] as const)('refuses %s legacy registration without launching it', kind => {
  const f = fixture();
  if (kind === 'edited') {
    put(f.project, `${target}/SKILL.md`, 'edited registration');
  }
  if (kind === 'unowned') {
    rmSync(join(f.project, '.harness-delta/claude-connect/installation.json'));
  }
  if (kind === 'settings') {
    put(
      f.project,
      '.claude/settings.json',
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              hooks: [
                {
                  type: 'command',
                  command: legacyHook
                }
              ]
            }
          ]
        }
      })
    );
  }
  expect(preview(f.project, f.options)).toMatchObject({
    state: 'blocked',
    changes: []
  });
  expect(install(f.project, f.options).state).toBe('blocked');
  expect(existsSync(join(f.project, target, 'scripts/connect-promoted.mjs'))).toBe(false);
});

test('requires reviewed hashes and rejects changed source or settings after preview', () => {
  const f = fixture();
  expect(() => install(f.project, f.options)).toThrow('installation_preview_required');
  const options = reviewed(f.project, f.options);
  put(f.promotedPackageRoot, 'scripts/connect.mjs', 'export const contract = "changed";\n');
  expect(() => install(f.project, options)).toThrow('installation_preview_changed');
  const changed = reviewed(f.project, f.options);
  put(f.project, '.claude/settings.json', JSON.stringify({ hooks: { Stop: [] } }));
  expect(() => install(f.project, changed)).toThrow('installation_preview_changed');
});

test('rechecks trusted activity before replacing the registration', () => {
  const f = fixture();
  const options = reviewed(f.project, f.options);
  let calls = 0;
  expect(() => install(f.project, { ...options, promotedInUse: () => ++calls > 1 })).toThrow('promoted_installation_in_use');
  expect(readFileSync(join(f.project, target, 'SKILL.md'))).toEqual(readFileSync(join(f.packageRoot, 'SKILL.md')));
});

test('refuses historical hooks in project-local settings without modifying them', () => {
  const f = fixture();
  const local = JSON.stringify({
    hooks: {
      SessionStart: [
        {
          hooks: [{ type: 'command', command: legacyHook }]
        }
      ]
    }
  });
  put(f.project, '.claude/settings.local.json', local);
  const helper = readFileSync(join(f.project, target, 'scripts/claude-session-hook.mjs'));

  expect(preview(f.project, f.options).blockers).toContain('promoted_registration_conflict');
  expect(install(f.project, f.options).state).toBe('blocked');
  expect(readFileSync(join(f.project, '.claude/settings.local.json'), 'utf8')).toBe(local);
  expect(readFileSync(join(f.project, target, 'scripts/claude-session-hook.mjs'))).toEqual(helper);
});

test.each(['created', 'changed'] as const)('refuses project-local settings %s after preview', mutation => {
  const f = fixture();
  if (mutation === 'changed') {
    put(f.project, '.claude/settings.local.json', '{"env":{"SYNTHETIC":"before"}}');
  }
  const accepted = reviewed(f.project, f.options);
  const local = '{"env":{"SYNTHETIC":"after"}}';
  put(f.project, '.claude/settings.local.json', local);

  expect(() => install(f.project, accepted)).toThrow('installation_preview_changed');
  expect(readFileSync(join(f.project, '.claude/settings.local.json'), 'utf8')).toBe(local);
  expect(readFileSync(join(f.project, target, 'SKILL.md'))).toEqual(readFileSync(join(f.packageRoot, 'SKILL.md')));
});

test.each(['created', 'changed'] as const)('rechecks project-local settings %s immediately before cutover', mutation => {
  const f = fixture();
  if (mutation === 'changed') {
    put(f.project, '.claude/settings.local.json', '{"env":{"SYNTHETIC":"before"}}');
  }
  const accepted = reviewed(f.project, f.options);
  const local = '{"env":{"SYNTHETIC":"after"}}';
  let calls = 0;
  const promotedInUse = () => {
    if (++calls === 2) {
      put(f.project, '.claude/settings.local.json', local);
    }
    return false;
  };

  expect(() => install(f.project, { ...accepted, promotedInUse })).toThrow('installation_preview_changed');
  expect(calls).toBe(2);
  expect(readFileSync(join(f.project, '.claude/settings.local.json'), 'utf8')).toBe(local);
  expect(readFileSync(join(f.project, target, 'SKILL.md'))).toEqual(readFileSync(join(f.packageRoot, 'SKILL.md')));
});

test('preserves unrelated project-local settings byte-for-byte during promoted cutover', () => {
  const f = fixture();
  const local = '{\n  "env": {"SYNTHETIC": "local"},\n  "hooks": {"Stop": [{"hooks": [{"type": "command", "command": "echo local"}]}]}\n}\n';
  put(f.project, '.claude/settings.local.json', local);

  expect(install(f.project, reviewed(f.project, f.options)).state).toBe('installed');
  expect(readFileSync(join(f.project, '.claude/settings.local.json'), 'utf8')).toBe(local);
  expect(readFileSync(join(f.project, '.claude/settings.json'), 'utf8')).toBe(f.settings);
});

test('promoted removal and switching modes refuse rather than restoring legacy hooks', () => {
  const f = fixture();
  install(f.project, reviewed(f.project, f.options));
  for (const options of [
    { packageRoot: f.packageRoot },
    {
      ...f.options,
      bundleMode: 'exact' as const
    }
  ]) {
    const result = install(f.project, options);
    expect(result.state).toBe('blocked');
    expect(result.blockers).toContain('promoted_cutover_required');
  }
  const removed = remove(f.project, f.options);
  expect(removed.state).toBe('blocked');
  expect(removed.blockers).toContain('promoted_cutover_required');
  expect(readFileSync(join(f.project, target, 'SKILL.md'))).toEqual(readFileSync(join(f.promotedPackageRoot, 'SKILL.md')));
});
