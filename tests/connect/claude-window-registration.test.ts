import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';
import {
  installClaudeConnectInstallation as install,
  previewClaudeConnectInstallation as preview,
  removeClaudeConnectInstallation as remove,
  statusClaudeConnectInstallation as status
} from '../../src/connect/claude-connect-installation.js';
import type { ClaudeConnectInstallationPreviewOptions } from '../../src/connect/claude-connect-installation.js';

const roots: string[] = [];
const settingsPath = '.claude/settings.local.json';
const target = '.claude/skills/harness-connect';
const hookSchema = z.object({ type: z.string(), command: z.string(), timeout: z.number().optional() }).passthrough();
const groupSchema = z.object({ hooks: z.array(hookSchema) }).passthrough();
const settingsSchema = z.object({ hooks: z.object({ SessionStart: z.array(groupSchema) }).passthrough() }).passthrough();
function put(root: string, path: string, text: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true, mode: 0o700 });
  writeFileSync(join(root, path), text, { mode: 0o600 });
}
function fixture(initial?: string) {
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'claude-registration-')));
  roots.push(sandbox);
  const project = join(sandbox, 'project space');
  mkdirSync(project, { mode: 0o700 });
  const packageRoot = join(sandbox, 'exact'),
    windowPackageRoot = join(sandbox, 'window'),
    promotedPackageRoot = join(sandbox, 'promoted');
  for (const directory of [packageRoot, windowPackageRoot, promotedPackageRoot]) {
    put(directory, 'SKILL.md', 'synthetic installation fixture\n');
    put(directory, 'scripts/connect.mjs', 'export const synthetic = true;\n');
    put(directory, 'scripts/claude-session-hook.mjs', 'throw new Error("fixture must not execute");\n');
  }
  put(project, '.claude/settings.json', '{ "shared" : true }\n');
  if (initial !== undefined) put(project, settingsPath, initial);
  const options = { packageRoot, windowPackageRoot, bundleMode: 'ordinary_window' } as const;
  return { project, packageRoot, promotedPackageRoot, options };
}
function reviewed(project: string, options: ClaudeConnectInstallationPreviewOptions) {
  const p = preview(project, options);
  expect(p.blockers).toEqual([]);
  return { ...options, expectedPackageHash: p.packageHash, expectedInstalledHash: p.installedHash };
}
function groups(project: string) {
  return settingsSchema.parse(JSON.parse(readFileSync(join(project, settingsPath), 'utf8'))).hooks.SessionStart;
}
function snapshot(root: string): string {
  const entries = readdirSync(root)
    .sort()
    .map(name => {
      const path = join(root, name),
        stat = lstatSync(path);
      const content = stat.isSymbolicLink() ? readlinkSync(path) : stat.isDirectory() ? snapshot(path) : readFileSync(path).toString('hex');
      return [name, stat.mode, stat.ino, stat.mtimeMs, content];
    });
  return JSON.stringify(entries);
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('window preview lists settings as its own reviewed change without writing', () => {
  const f = fixture(),
    before = snapshot(f.project);
  const p = preview(f.project, f.options);
  const changes = p.changes.filter(change => change.path === settingsPath);
  expect(changes).toMatchObject([{ path: settingsPath, action: 'create', beforeHash: null }]);
  expect(changes).toHaveLength(1);
  expect(changes[0]?.afterHash).toMatch(/^[a-f0-9]{64}$/);
  expect(status(f.project, f.options)).toMatchObject({ recorderRegistration: 'absent', hookRegistration: 'unverified' });
  expect(snapshot(f.project)).toBe(before);
  expect(() => install(f.project, f.options)).toThrow('installation_preview_required');
  expect(snapshot(f.project)).toBe(before);
});

test('window install registers one quoted absolute recorder command and remains idempotent', () => {
  const f = fixture();
  expect(install(f.project, reviewed(f.project, f.options)).state).toBe('installed');
  expect(existsSync(join(f.project, settingsPath))).toBe(true);
  const starts = groups(f.project),
    command = starts[0]?.hooks[0]?.command;
  const recorder = join(f.project, target, 'scripts/claude-window-session-hook.mjs');
  expect(starts).toEqual([{ hooks: [{ type: 'command', command, timeout: 10 }] }]);
  expect([
    `'${process.execPath}' '${recorder}' record`,
    `"${process.execPath}" "${recorder}" record`,
    `'${process.execPath}' "${recorder}" record`,
    `"${process.execPath}" '${recorder}' record`
  ]).toContain(command);
  expect(lstatSync(join(f.project, settingsPath)).mode & 0o777).toBe(0o600);
  const before = snapshot(f.project);
  expect(install(f.project, f.options).state).toBe('installed');
  expect(snapshot(f.project)).toBe(before);
  expect(status(f.project, f.options)).toMatchObject({ recorderRegistration: 'present', hookRegistration: 'unverified' });
});

test('install preserves operator JSON fragments and removal restores original bytes and mode', () => {
  const operator = '{ "matcher" : "resume", "hooks" : [ { "type":"command", "command":"echo operator" } ] }';
  const prefix = ' \n{\t"env" : {"ODD":"\\u0061"}, "hooks" : { "SessionStart" : [ ';
  const suffix = ' \t], "Stop" : [ {"hooks":[]} ] }, "number" : 1e2 }\r\n';
  const original = prefix + operator + suffix,
    f = fixture(original);
  chmodSync(join(f.project, settingsPath), 0o640);
  expect(install(f.project, reviewed(f.project, f.options)).state).toBe('installed');
  const installed = readFileSync(join(f.project, settingsPath), 'utf8');
  for (const fragment of [prefix, operator, suffix]) expect(installed).toContain(fragment);
  expect(groups(f.project)).toHaveLength(2);
  expect(lstatSync(join(f.project, settingsPath)).mode & 0o777).toBe(0o640);
  expect(remove(f.project, reviewed(f.project, { ...f.options, operation: 'remove' })).state).toBe('absent');
  expect(readFileSync(join(f.project, settingsPath), 'utf8')).toBe(original);
  expect(lstatSync(join(f.project, settingsPath)).mode & 0o777).toBe(0o640);
  expect(readFileSync(join(f.project, '.claude/settings.json'), 'utf8')).toBe('{ "shared" : true }\n');
});

test.each([undefined, ' { "operator" : true }\n'])('exact install leaves existing or absent local settings untouched: %s', initial => {
  const f = fixture(initial),
    path = join(f.project, settingsPath);
  const before = initial === undefined ? undefined : lstatSync(path);
  expect(install(f.project, { packageRoot: f.packageRoot }).state).toBe('installed');
  if (initial === undefined) expect(existsSync(path)).toBe(false);
  else {
    expect(readFileSync(path, 'utf8')).toBe(initial);
    expect(lstatSync(path)).toMatchObject({ ino: before?.ino, mode: before?.mode, mtimeMs: before?.mtimeMs });
  }
});

test.each(['edited', 'duplicate'] as const)('%s recorder registration blocks removal without writes', kind => {
  const f = fixture('{"hooks":{"SessionStart":[]}}');
  install(f.project, reviewed(f.project, f.options));
  const starts = groups(f.project);
  expect(starts).toHaveLength(1);
  const changed = kind === 'duplicate' ? [...starts, ...starts] : [{ hooks: [{ type: 'command', command: 'echo edited', timeout: 10 }] }];
  put(f.project, settingsPath, JSON.stringify({ hooks: { SessionStart: changed } }));
  const before = snapshot(f.project);
  expect(remove(f.project, f.options)).toMatchObject({ state: 'blocked' });
  expect(snapshot(f.project)).toBe(before);
});

const invalidSettings = ['{', '[]', 'null', '{"hooks":[]}', '{"hooks":null}', '{"hooks":{"SessionStart":{}}}', '{"hooks":{"SessionStart":[null]}}'] as const;
test.each(invalidSettings)('window install refuses invalid or unextendable settings %s without writes', initial => {
  const f = fixture(initial),
    before = snapshot(f.project);
  expect(preview(f.project, f.options).state).toBe('blocked');
  expect(install(f.project, f.options).state).toBe('blocked');
  expect(snapshot(f.project)).toBe(before);
});

test.each(['symlink', 'hardlink', 'directory'] as const)('window install refuses a settings %s without writes', kind => {
  const f = fixture(),
    path = join(f.project, settingsPath),
    foreign = join(dirname(f.project), 'foreign.json');
  writeFileSync(foreign, '{}\n', { mode: 0o600 });
  switch (kind) {
    case 'symlink':
      symlinkSync(foreign, path);
      break;
    case 'hardlink':
      linkSync(foreign, path);
      break;
    case 'directory':
      mkdirSync(path, { mode: 0o700 });
      break;
  }
  const before = snapshot(dirname(f.project));
  expect(preview(f.project, f.options).blockers).toContain('unsafe_path');
  expect(install(f.project, f.options).blockers).toContain('unsafe_path');
  expect(snapshot(dirname(f.project))).toBe(before);
});

test('exact to window to exact migration adds then removes only owned registration', () => {
  const original = ' { "operator" : true }\n',
    f = fixture(original);
  const exact = { ...f.options, bundleMode: 'exact' } as const;
  expect(install(f.project, exact).state).toBe('installed');
  expect(preview(f.project, f.options).changes.map(change => change.path)).toContain(settingsPath);
  expect(install(f.project, reviewed(f.project, f.options)).state).toBe('installed');
  expect(groups(f.project)).toHaveLength(1);
  expect(preview(f.project, exact).changes.map(change => change.path)).toContain(settingsPath);
  expect(install(f.project, reviewed(f.project, exact)).state).toBe('installed');
  expect(readFileSync(join(f.project, settingsPath), 'utf8')).toBe(original);
});

test.each(['missing', 'mismatched'] as const)('status reports %s recorder registration without asserting native trust', kind => {
  const f = fixture();
  install(f.project, reviewed(f.project, f.options));
  const command = `"${process.execPath}" "${join(f.project, target, 'scripts/claude-window-session-hook.mjs')}" record`;
  const changed = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command, timeout: 9 }] }] } };
  put(f.project, settingsPath, kind === 'missing' ? '{}' : JSON.stringify(changed));
  const before = snapshot(f.project);
  expect(status(f.project, f.options)).toMatchObject({ recorderRegistration: kind, hookRegistration: 'unverified' });
  expect(snapshot(f.project)).toBe(before);
});

test('settings changed after preview invalidate apply hashes without writes', () => {
  const f = fixture('{}\n'),
    options = reviewed(f.project, f.options);
  put(f.project, settingsPath, '{ "operator" : "changed after preview" }\n');
  const before = snapshot(f.project);
  expect(() => install(f.project, options)).toThrow('installation_preview_changed');
  expect(snapshot(f.project)).toBe(before);
});

test.each(['absent', 'existing-empty', 'operator-added'] as const)('remove respects settings file ownership: %s', kind => {
  const f = fixture(kind === 'existing-empty' ? '{}\n' : undefined);
  install(f.project, reviewed(f.project, f.options));
  expect(existsSync(join(f.project, settingsPath))).toBe(true);
  if (kind === 'operator-added') {
    const text = readFileSync(join(f.project, settingsPath), 'utf8');
    const end = text.lastIndexOf('}');
    put(f.project, settingsPath, text.slice(0, end) + ', "operator" : true ' + text.slice(end));
  }
  expect(remove(f.project, reviewed(f.project, { ...f.options, operation: 'remove' })).state).toBe('absent');
  const path = join(f.project, settingsPath);
  if (kind === 'absent') expect(existsSync(path)).toBe(false);
  else if (kind === 'existing-empty') expect(readFileSync(path, 'utf8')).toBe('{}\n');
  else expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ operator: true });
});

test.each(['owned', 'foreign'] as const)('promoted conflict guard distinguishes %s window registration', kind => {
  const f = fixture('{"hooks":{"SessionStart":[]}}');
  install(f.project, reviewed(f.project, f.options));
  expect(groups(f.project)).toHaveLength(1);
  if (kind === 'foreign') {
    put(
      f.project,
      '.claude/settings.json',
      '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"node /foreign/harness-connect/claude-window-session-hook.mjs record"}]}]}}'
    );
  }
  const options = {
    ...f.options,
    bundleMode: 'promoted',
    promotedPackageRoot: f.promotedPackageRoot,
    productVersion: '2.1.319',
    promotedInUse: false,
    quiescentBoundaryConfirmed: true
  } as const;
  const before = snapshot(f.project),
    p = preview(f.project, options);
  expect(p.blockers).toEqual(kind === 'foreign' ? ['promoted_registration_conflict'] : []);
  expect(snapshot(f.project)).toBe(before);
  if (kind === 'owned') expect(install(f.project, reviewed(f.project, options)).state).toBe('installed');
});
