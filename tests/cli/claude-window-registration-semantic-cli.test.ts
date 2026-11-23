import '../helpers/claude-window-preservation.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';
import {
  installClaudeConnectInstallation as install,
  previewClaudeConnectInstallation as preview,
  removeClaudeConnectInstallation as remove,
  statusClaudeConnectInstallation as status
} from '../../src/connect/claude-connect-installation.js';
import { ordinaryWindowArmingStatus } from '../../src/ordinary-window-emission.js';
import { createClaudeWindowArmingFixture } from '../helpers/claude-window-arming-fixture.js';

const hookSchema = z.object({ type: z.string(), command: z.string(), timeout: z.number() }).passthrough();
const groupSchema = z.object({ hooks: z.array(hookSchema) }).passthrough();
const settingsSchema = z.object({ hooks: z.object({ SessionStart: z.array(groupSchema) }).passthrough() }).passthrough();
const fixtures: ReturnType<typeof createClaudeWindowArmingFixture>[] = [];
function fixture() {
  const f = createClaudeWindowArmingFixture();
  fixtures.push(f);
  return f;
}
const settingsPath = (f: ReturnType<typeof fixture>) => join(f.projectRoot, '.claude/settings.local.json');
const readSettings = (f: ReturnType<typeof fixture>) => settingsSchema.parse(JSON.parse(readFileSync(settingsPath(f), 'utf8')));
const writeSettings = (f: ReturnType<typeof fixture>, value: z.infer<typeof settingsSchema>) =>
  writeFileSync(settingsPath(f), JSON.stringify(value, null, 2) + '\n');
const installationOptions = { bundleMode: 'ordinary_window' } as const;
afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup();
});

test.each(['native-rewrite', 'reordered-and-unrelated'] as const)('%s preserves installed registration identity and permits real CLI arming', async kind => {
  const f = fixture();
  const before = status(f.projectRoot, installationOptions);
  const value = readSettings(f);
  value['disabledMcpjsonServers'] = ['synthetic-disabled'];
  if (kind === 'reordered-and-unrelated') {
    const hook = value.hooks.SessionStart[0]?.hooks[0];
    if (!hook) throw new Error('fixture_owned_hook_missing');
    value.hooks.SessionStart = [
      { hooks: [{ timeout: hook.timeout, command: hook.command, type: hook.type }] },
      { matcher: 'resume', hooks: [{ type: 'command', command: 'echo operator', timeout: 1 }] }
    ];
    value['permissions'] = { allow: ['Read(synthetic)'] };
  }
  writeSettings(f, value);
  const armed = await f.run(['compatibility', 'ordinary-window', 'arm', f.taskId, '--duration-ms', '60000']);
  expect([armed.code, armed.stderr]).toEqual([0, '']);
  expect(armed.effects).toEqual({ nativeCalls: 0, processCalls: 0, operations: [] });
  expect(status(f.projectRoot, installationOptions)).toMatchObject({
    state: 'installed',
    recorderRegistration: 'present',
    installedHash: before.installedHash,
    packageHash: before.packageHash,
    blockers: []
  });
  const response: unknown = JSON.parse(armed.stdout);
  expect(response).toMatchObject({ state: 'receipt_only', runtime_authority: false });
  expect(ordinaryWindowArmingStatus(f.store, f.taskId, f.options.clock()).state).toBe('receipt_only');
});

test.each([
  'command',
  'plain-command',
  'timeout',
  'type',
  'group-key',
  'hook-key',
  'extra-hook',
  'repeated-hook',
  'repeated-group',
  'foreign-group',
  'foreign-event',
  'duplicate-foreign'
] as const)('%s content drift remains blocked and refuses real CLI arming', async kind => {
  const f = fixture();
  const value = readSettings(f);
  const group = value.hooks.SessionStart[0];
  const hook = group?.hooks[0];
  if (!group || !hook) throw new Error('fixture_owned_hook_missing');
  const foreign = { hooks: [{ type: 'command', command: 'node /foreign/harness-connect/claude-session-hook.mjs', timeout: 10 }] };
  switch (kind) {
    case 'command':
      hook.command += ' --edited';
      break;
    case 'plain-command':
      hook.command = 'echo edited';
      break;
    case 'timeout':
      hook.timeout = 11;
      break;
    case 'type':
      hook.type = 'prompt';
      break;
    case 'group-key':
      group['matcher'] = 'startup';
      break;
    case 'hook-key':
      hook['matcher'] = 'startup';
      break;
    case 'extra-hook':
      group.hooks.push({ type: 'command', command: 'echo extra', timeout: 10 });
      break;
    case 'repeated-hook':
      group.hooks.push({ ...hook });
      break;
    case 'repeated-group':
      value.hooks.SessionStart.push(group);
      break;
    case 'foreign-group':
      value.hooks.SessionStart.push(foreign);
      break;
    case 'foreign-event':
      value.hooks['Stop'] = [foreign];
      break;
    case 'duplicate-foreign':
      value.hooks['Stop'] = [foreign, foreign];
      break;
    default: {
      const exhaustive: never = kind;
      throw new Error('fixture_unhandled_variant', { cause: exhaustive });
    }
  }
  writeSettings(f, value);
  expect(status(f.projectRoot, installationOptions)).toMatchObject({
    state: 'blocked',
    recorderRegistration: 'mismatched'
  });
  const armed = await f.run(['compatibility', 'ordinary-window', 'arm', f.taskId, '--duration-ms', '60000']);
  expect([armed.code, armed.stderr]).toEqual([2, 'binding_window_package_required\n']);
  expect(armed.effects).toEqual({ nativeCalls: 0, processCalls: 0, operations: [] });
  expect(ordinaryWindowArmingStatus(f.store, f.taskId, f.options.clock()).state).toBe('inactive');
});

test('an unrelated byte edit after preview still invalidates remove without changing the rewritten settings', () => {
  const f = fixture();
  const options = { ...installationOptions, operation: 'remove' } as const;
  const reviewed = preview(f.projectRoot, options);
  const value = readSettings(f);
  value['permissions'] = { allow: ['Read(synthetic)'] };
  writeSettings(f, value);
  const rewritten = readFileSync(settingsPath(f));
  expect(() =>
    remove(f.projectRoot, { ...installationOptions, expectedPackageHash: reviewed.packageHash, expectedInstalledHash: reviewed.installedHash })
  ).toThrow('installation_preview_changed');
  expect(readFileSync(settingsPath(f))).toEqual(rewritten);
});

test.each(['remove', 'exact', 'promoted'] as const)('rewritten settings permit %s while retaining unrelated hooks and stable status identity', kind => {
  const f = fixture();
  const value = readSettings(f);
  const operator = [{ hooks: [{ type: 'command', command: 'echo operator', timeout: 1 }] }];
  value.hooks['Stop'] = operator;
  value['permissions'] = { allow: ['Read(synthetic)'] };
  writeSettings(f, value);
  const options =
    kind === 'promoted'
      ? ({ bundleMode: 'promoted', productVersion: '2.1.319', promotedInUse: false, quiescentBoundaryConfirmed: true } as const)
      : kind === 'exact'
        ? ({ bundleMode: 'exact' } as const)
        : ({ ...installationOptions, operation: 'remove' } as const);
  const reviewed = preview(f.projectRoot, options);
  expect(reviewed.blockers).toEqual([]);
  const apply = kind === 'remove' ? remove : install;
  expect(apply(f.projectRoot, { ...options, expectedPackageHash: reviewed.packageHash, expectedInstalledHash: reviewed.installedHash }).state).toBe(
    kind === 'remove' ? 'absent' : 'installed'
  );
  const remaining = z.record(z.string(), z.unknown()).parse(JSON.parse(readFileSync(settingsPath(f), 'utf8')));
  expect(remaining).toEqual({ hooks: { Stop: operator }, permissions: { allow: ['Read(synthetic)'] } });
  const before = status(f.projectRoot, options);
  remaining['disabledMcpjsonServers'] = ['synthetic-disabled'];
  writeFileSync(settingsPath(f), JSON.stringify(remaining, null, 4) + '\n');
  expect(status(f.projectRoot, options)).toMatchObject({
    state: before.state,
    packageHash: before.packageHash,
    installedHash: before.installedHash,
    blockers: []
  });
});
