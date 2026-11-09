import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';
import {
  installCodexConnectInstallation as install,
  previewCodexConnectInstallation as preview,
  statusCodexConnectInstallation as status
} from '../../src/connect/codex-connect-installation.js';

const roots: string[] = [];
const destination = '.agents/skills/harness-connect';
const metadata = '.harness-delta/codex-connect';
const legacyRecorder = `${metadata}/session-binding-codex-hook.mjs`;
const promotedRecorder = `${metadata}/session-binding-codex-promoted-hook.mjs`;
const hooksPath = '.codex/hooks.json';
const unrelated = {
  hooks: [{ type: 'command', command: 'synthetic-unrelated' }]
};
function put(root: string, path: string, bytes: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true, mode: 0o700 });
  writeFileSync(join(root, path), bytes, { mode: 0o600 });
}
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'codex-promoted-install-')));
  roots.push(root);
  const project = join(root, 'project');
  const packageRoot = join(root, 'legacy');
  const promotedPackageRoot = join(root, 'promoted');
  mkdirSync(project, { mode: 0o700 });
  put(packageRoot, 'SKILL.md', 'synthetic legacy skill\n');
  put(packageRoot, 'scripts/connect.mjs', 'export const legacy = true;\n');
  put(root, 'legacy-hook.mjs', 'export const legacyRecorder = true;\n');
  put(promotedPackageRoot, 'SKILL.md', 'synthetic promoted skill\n');
  put(promotedPackageRoot, 'scripts/connect.mjs', 'export const promoted = true;\n');
  put(root, 'promoted-hook.mjs', 'export const producerContract = "promoted-payload-v1";\n');
  put(
    project,
    hooksPath,
    JSON.stringify({
      custom: { retained: true },
      hooks: { SessionStart: [unrelated], Stop: [unrelated] }
    })
  );
  const legacy = {
    packageRoot,
    hookSource: join(root, 'legacy-hook.mjs'),
    sourceRoots: [project],
    productVersion: '0.163.0'
  };
  const promoted = {
    ...legacy,
    bundleMode: 'promoted' as const,
    productVersion: '0.167.0',
    sourceRoots: [join(root, 'native-hint-never-created')],
    promotedPackageRoot,
    promotedHookSource: join(root, 'promoted-hook.mjs'),
    promotedInUse: false,
    quiescentBoundaryConfirmed: true
  };
  return { root, project, legacy, promoted };
}
function reviewed(root: string, options: Parameters<typeof preview>[1]) {
  const result = preview(root, options);
  expect(result.blockers).toEqual([]);
  return {
    ...options,
    expectedPackageHash: result.packageHash,
    expectedInstalledHash: result.installedHash
  };
}
function hookDocument(root: string) {
  return z
    .object({
      custom: z.object({ retained: z.boolean() }),
      hooks: z.record(z.string(), z.array(z.unknown()))
    })
    .parse(JSON.parse(readFileSync(join(root, hooksPath), 'utf8')));
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test('reports an unverified producer contract before any promoted cutover', () => {
  const f = fixture();
  expect(status(f.project, f.promoted)).toMatchObject({
    state: 'absent',
    bundleMode: 'promoted',
    bundleRevision: 'codex-promoted-bundle-v1',
    producerContract: 'promoted_producer_contract_unverified',
    requiresFreshRoots: true
  });
});

test('installs only promoted registrations and preserves unrelated hooks without reading native hints', () => {
  const f = fixture();
  expect(install(f.project, reviewed(f.project, f.promoted))).toMatchObject({
    state: 'installed',
    hookRegistration: 'unverified'
  });
  const document = hookDocument(f.project);
  expect(document.custom).toEqual({ retained: true });
  expect(document.hooks.Stop).toEqual([unrelated]);
  expect(document.hooks.SessionStart?.[0]).toEqual(unrelated);
  const registrations = JSON.stringify(document.hooks);
  expect(registrations).toContain(promotedRecorder);
  expect(registrations).not.toContain(legacyRecorder);
  expect(readFileSync(join(f.project, destination, 'scripts/connect-promoted.mjs'), 'utf8')).toBe('export const promoted = true;\n');
});

test('cuts over owned legacy registrations while keeping historical helper bytes and files', () => {
  const f = fixture();
  install(f.project, reviewed(f.project, f.legacy));
  const recorder = readFileSync(join(f.project, legacyRecorder));
  const connector = readFileSync(join(f.project, destination, 'scripts/connect.mjs'));
  install(f.project, reviewed(f.project, f.promoted));
  expect(readFileSync(join(f.project, legacyRecorder))).toEqual(recorder);
  expect(readFileSync(join(f.project, destination, 'scripts/connect.mjs'))).toEqual(connector);
  const hooks = hookDocument(f.project).hooks;
  expect(hooks.SessionStart).toHaveLength(2);
  expect(hooks.SubagentStart).toHaveLength(1);
  expect(JSON.stringify(hooks)).not.toContain(legacyRecorder);
});

test.each([
  ['active task', { promotedInUse: true }, 'codex_connect_promoted_installation_in_use'],
  ['missing task proof', { promotedInUse: undefined }, 'codex_connect_promoted_task_state_unverified'],
  ['unconfirmed quiescence', { quiescentBoundaryConfirmed: false }, 'codex_connect_promoted_quiescence_unconfirmed']
])('refuses promoted preview and apply with %s', (_name, change, blocker) => {
  const f = fixture();
  const options = { ...f.promoted, ...change };
  expect(preview(f.project, options)).toMatchObject({
    state: 'blocked',
    blockers: [blocker],
    changes: []
  });
  expect(install(f.project, options)).toMatchObject({
    state: 'blocked',
    blockers: [blocker]
  });
  expect(readFileSync(join(f.project, hooksPath), 'utf8')).not.toContain(promotedRecorder);
});

test('refuses an edited owned historical recorder rather than launching it', () => {
  const f = fixture();
  install(f.project, reviewed(f.project, f.legacy));
  put(f.project, legacyRecorder, 'synthetic edited recorder');
  expect(preview(f.project, f.promoted)).toMatchObject({
    state: 'blocked',
    blockers: ['codex_connect_package_drift'],
    changes: []
  });
});

test.each(['SessionStart', 'Stop'])('refuses unowned legacy registration in %s before cutover', event => {
  const f = fixture();
  put(
    f.project,
    hooksPath,
    JSON.stringify({
      hooks: {
        [event]: [
          {
            hooks: [
              {
                type: 'command',
                command: `node ${legacyRecorder}`
              }
            ]
          }
        ]
      }
    })
  );
  expect(preview(f.project, f.promoted)).toMatchObject({
    state: 'blocked',
    blockers: ['codex_connect_hooks_unowned'],
    changes: []
  });
});

test('refuses an unowned skill rather than overwriting its registration', () => {
  const f = fixture();
  put(f.project, `${destination}/SKILL.md`, 'synthetic unowned skill');
  expect(preview(f.project, f.promoted)).toMatchObject({
    state: 'blocked',
    blockers: ['codex_connect_package_unowned'],
    changes: []
  });
});

test('refuses a stale preview after unrelated hooks change', () => {
  const f = fixture();
  const options = reviewed(f.project, f.promoted);
  put(f.project, hooksPath, JSON.stringify({ hooks: { Stop: [unrelated] } }));
  expect(() => install(f.project, options)).toThrow('codex_connect_installation_preview_changed');
});

test('requires a reviewed preview before promoted apply', () => {
  const f = fixture();
  expect(() => install(f.project, f.promoted)).toThrow('codex_connect_installation_preview_required');
});

test('rechecks active-task state after staging and rolls back without changing registrations', () => {
  const f = fixture();
  const before = readFileSync(join(f.project, hooksPath));
  const approved = reviewed(f.project, f.promoted);
  let calls = 0;
  expect(() => install(f.project, { ...approved, promotedInUse: () => ++calls > 1 })).toThrow('codex_connect_promoted_installation_in_use');
  expect(readFileSync(join(f.project, hooksPath))).toEqual(before);
});

test('does not restore read-capable legacy registrations by switching an installed promoted copy to exact mode', () => {
  const f = fixture();
  install(f.project, reviewed(f.project, f.promoted));
  expect(preview(f.project, f.legacy)).toMatchObject({
    state: 'blocked',
    blockers: ['codex_connect_promoted_cutover_required'],
    changes: []
  });
  expect(JSON.stringify(hookDocument(f.project).hooks)).not.toContain(legacyRecorder);
});
