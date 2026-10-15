import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { hashBytes } from '../src/harness-config.js';
import { installCodexConnectInstallation as install, previewCodexConnectInstallation as preview,
  recoverCodexConnectInstallationLock as recover,
  removeCodexConnectInstallation as remove, statusCodexConnectInstallation as status } from '../src/codex-connect-installation.js';
import type { CodexConnectInstallationOptions } from '../src/codex-connect-installation.js';

const fault = vi.hoisted(() => ({ commit: false, concurrent: false, rollbackDrift: false }));
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, renameSync: (from: string, to: string) => {
    if (fault.concurrent && to.includes('/transaction-') && to.endsWith('/old-0')) {
      fault.concurrent = false;
      const root = to.split('/.harness-delta/')[0];
      if (root) actual.writeFileSync(join(root, '.codex/hooks.json'), '{"concurrent":true}');
    }
    if (fault.commit && to.endsWith('/installation.json')) {
      fault.commit = false;
      if (fault.rollbackDrift) {
        const root = to.split('/.harness-delta/')[0];
        if (root) actual.writeFileSync(join(root, '.agents/skills/harness-connect/SKILL.md'), 'concurrent package edit');
      }
      throw new Error('synthetic commit failure');
    }
    actual.renameSync(from, to);
  } };
});
const roots: string[] = [];
const target = '.agents/skills/harness-connect';
const metadata = '.harness-delta/codex-connect';
const recorder = `${metadata}/session-binding-codex-hook.mjs`;
const hooksPath = '.codex/hooks.json';
const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
function put(root: string, path: string, text: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true, mode: 0o700 });
  writeFileSync(join(root, path), text, { mode: 0o600 });
}
const unrelated = { matcher: 'startup', hooks: [{ type: 'command', command: 'unrelated command', timeout: 9 }] };
const initialHooks = { 'custom-key': { 'nested-key': [true, 1.25, null] },
  hooks: { SessionStart: [unrelated], Stop: [{ hooks: [{ type: 'command', command: 'stop command' }] }] } };
function fixture() {
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "codex-install-'")));
  roots.push(sandbox);
  const project = join(sandbox, 'project'), packageRoot = join(sandbox, 'package');
  const sourceRoot = join(sandbox, "reviewed sources' root"), hookSource = join(sandbox, 'source/recorder.mjs');
  mkdirSync(project); mkdirSync(packageRoot); mkdirSync(sourceRoot);
  put(packageRoot, 'SKILL.md', 'synthetic skill');
  put(packageRoot, 'scripts/connect.mjs', 'export const connect = true;\n');
  put(packageRoot, 'references/data.json', '{"synthetic":true}\n');
  put(sandbox, 'source/recorder.mjs', '#!/usr/bin/env node\nexport const metadataOnly = true;\n');
  put(project, hooksPath, JSON.stringify(initialHooks));
  put(project, '.codex/config.toml', 'trust is not installation');
  put(project, '.agents/skills/unrelated/SKILL.md', 'unrelated skill');
  const options: CodexConnectInstallationOptions = { packageRoot, hookSource, sourceRoots: [sourceRoot], productVersion: '0.162.1' };
  return { project, packageRoot, sourceRoot, hookSource, options };
}
function reviewed(root: string, options: CodexConnectInstallationOptions, operation: 'install' | 'remove' = 'install') {
  const evidence = preview(root, { ...options, operation });
  expect(evidence.blockers).toEqual([]);
  return { ...options, expectedPackageHash: evidence.packageHash, expectedInstalledHash: evidence.installedHash };
}
function snapshot(root: string): string {
  const entries: unknown[] = [];
  const visit = (prefix: string) => {
    for (const name of readdirSync(join(root, prefix)).sort()) {
      const path = prefix ? `${prefix}/${name}` : name, stat = lstatSync(join(root, path));
      entries.push([path, stat.mode, stat.ino, stat.nlink]);
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) entries.push(hashBytes(readFileSync(join(root, path))));
    }
  };
  visit('');
  return JSON.stringify(entries);
}
function hooks(root: string) {
  return JSON.parse(readFileSync(join(root, hooksPath), 'utf8')) as {
    hooks: { SessionStart: unknown[]; SubagentStart: unknown[]; Stop: unknown[] };
    [key: string]: unknown;
  };
}
afterEach(() => {
  fault.commit = false; fault.concurrent = false; fault.rollbackDrift = false;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('status and previews only read files and expose sanitized hash evidence', () => {
  const f = fixture(), before = snapshot(f.project);
  const result = preview(f.project, f.options);
  expect(result).toMatchObject({ state: 'absent', source: 'available', installedHash: null,
    destination: target, receiptDirectory: `${metadata}/receipts`, hookRegistration: 'unverified',
    beforeHooksHash: hashBytes(readFileSync(join(f.project, hooksPath))) });
  expect(result.changes).toHaveLength(6);
  expect(result.changes.find(change => change.path === hooksPath)).toMatchObject({ action: 'update',
    beforeHash: result.beforeHooksHash });
  expect(JSON.stringify(result)).not.toContain(f.project);
  expect(JSON.stringify(result)).not.toContain(f.sourceRoot);
  expect(status(f.project, f.options).state).toBe('absent');
  preview(f.project, { ...f.options, operation: 'remove' });
  expect(snapshot(f.project)).toBe(before);
});
test('install requires reviewed matching hashes before any mutation', () => {
  const f = fixture(), before = snapshot(f.project);
  expect(() => install(f.project, f.options)).toThrow('codex_connect_installation_preview_required');
  expect(snapshot(f.project)).toBe(before);
});
test('install merges native entries and creates a real private empty receipt directory', () => {
  const f = fixture();
  const result = install(f.project, reviewed(f.project, f.options));
  expect(result.state).toBe('installed');
  expect(result.installedHash).toBe(result.packageHash);
  expect(result.hookRegistration).toBe('unverified');
  const document = hooks(f.project);
  expect(document['custom-key']).toEqual(initialHooks['custom-key']);
  expect(document.hooks.Stop).toEqual(initialHooks.hooks.Stop);
  expect(document.hooks.SessionStart[0]).toEqual(unrelated);
  const command = [realpathSync(process.execPath), join(f.project, recorder), '--receipt-directory',
    join(f.project, metadata, 'receipts'), '--product-version', '0.162.1', '--source-root', f.sourceRoot].map(quote).join(' ');
  expect(document.hooks.SessionStart[1]).toEqual({ matcher: 'startup|resume|clear|compact',
    hooks: [{ type: 'command', command }] });
  expect(document.hooks.SubagentStart).toEqual([{ hooks: [{ type: 'command', command }] }]);
  expect(readFileSync(join(f.project, recorder))).toEqual(readFileSync(f.hookSource));
  for (const path of [metadata, `${metadata}/receipts`]) {
    expect(lstatSync(join(f.project, path)).isDirectory()).toBe(true);
    expect(lstatSync(join(f.project, path)).mode & 0o777).toBe(0o700);
  }
  expect(lstatSync(join(f.project, metadata, 'installation.json')).mode & 0o777).toBe(0o600);
  expect(readdirSync(join(f.project, metadata, 'receipts'))).toEqual([]);
  expect(readFileSync(join(f.project, '.codex/config.toml'), 'utf8')).toBe('trust is not installation');
});
test('repeat install does not rewrite hook formatting or owned files', () => {
  const f = fixture(); install(f.project, reviewed(f.project, f.options));
  put(f.project, hooksPath, JSON.stringify(hooks(f.project)));
  const before = snapshot(f.project);
  expect(preview(f.project, f.options).changes).toEqual([]);
  expect(install(f.project, reviewed(f.project, f.options)).state).toBe('installed');
  expect(snapshot(f.project)).toBe(before);
});
test('reviewed reinstall repairs a missing receipt directory without replacing hooks or skill files', () => {
  const f = fixture();
  install(f.project, reviewed(f.project, f.options));
  const hooksBefore = readFileSync(join(f.project, hooksPath));
  const skillBefore = readFileSync(join(f.project, target, 'SKILL.md'));
  const oldReview = reviewed(f.project, f.options);
  rmSync(join(f.project, metadata, 'receipts'), { recursive: true });
  expect(() => install(f.project, oldReview)).toThrow('codex_connect_installation_preview_changed');
  const next = preview(f.project, f.options);
  expect(next.state).toBe('update_available');
  expect(next.blockers).toEqual([]);
  expect(next.changes.map(change => change.path)).toEqual([`${metadata}/receipts`]);
  expect(install(f.project, reviewed(f.project, f.options)).state).toBe('installed');
  expect(lstatSync(join(f.project, metadata, 'receipts')).mode & 0o777).toBe(0o700);
  expect(readdirSync(join(f.project, metadata, 'receipts'))).toEqual([]);
  expect(readFileSync(join(f.project, hooksPath))).toEqual(hooksBefore);
  expect(readFileSync(join(f.project, target, 'SKILL.md'))).toEqual(skillBefore);
});
test('explicit lock recovery refuses a live owner and releases only a dead clean owner', () => {
  const f = fixture();
  install(f.project, reviewed(f.project, f.options));
  const stat = lstatSync(f.project);
  const lock = `${metadata}/installation-lock`;
  put(f.project, `${lock}/owner.json`, JSON.stringify({
    pid: process.pid, root_identity: `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`,
  }));
  expect(() => recover(f.project, f.options)).toThrow('codex_connect_installation_busy');
  vi.spyOn(process, 'kill').mockImplementationOnce(() => { throw Object.assign(new Error('synthetic dead owner'), { code: 'ESRCH' }); });
  expect(recover(f.project, f.options).state).toBe('installed');
  expect(existsSync(join(f.project, lock))).toBe(false);
});
test('lock recovery retains interrupted transaction evidence', () => {
  const f = fixture();
  install(f.project, reviewed(f.project, f.options));
  const stat = lstatSync(f.project);
  const lock = `${metadata}/installation-lock`;
  put(f.project, `${lock}/owner.json`, JSON.stringify({
    pid: process.pid, root_identity: `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`,
  }));
  put(f.project, `${metadata}/transaction-interrupted/old-0`, 'synthetic preimage');
  vi.spyOn(process, 'kill').mockImplementationOnce(() => { throw Object.assign(new Error('synthetic dead owner'), { code: 'ESRCH' }); });
  expect(() => recover(f.project, f.options)).toThrow('codex_connect_installation_recovery_required');
  expect(readFileSync(join(f.project, metadata, 'transaction-interrupted/old-0'), 'utf8')).toBe('synthetic preimage');
  expect(existsSync(join(f.project, lock))).toBe(true);
});
test('upgrades preserve later unrelated hooks and retire only owned package files', () => {
  const f = fixture(); install(f.project, reviewed(f.project, f.options));
  const document = hooks(f.project);
  document.hooks.SessionStart.unshift({ extra: 'unrelated entry', hooks: [] });
  document.hooks.SubagentStart.push({ hooks: [{ type: 'command', command: 'new unrelated hook' }] });
  document['new-key'] = { keep: true };
  put(f.project, hooksPath, JSON.stringify(document));
  put(f.packageRoot, 'SKILL.md', 'synthetic upgrade');
  rmSync(join(f.packageRoot, 'references'), { recursive: true });
  put(f.packageRoot, 'new.json', '{"v":2}');
  put(dirname(f.hookSource), 'recorder.mjs', 'export const updated = true;\n');
  expect(status(f.project, f.options).state).toBe('update_available');
  const hooksBefore = readFileSync(join(f.project, hooksPath));
  expect(install(f.project, reviewed(f.project, f.options)).state).toBe('installed');
  expect(readFileSync(join(f.project, hooksPath))).toEqual(hooksBefore);
  expect(existsSync(join(f.project, target, 'references'))).toBe(false);
  expect(readFileSync(join(f.project, target, 'new.json'), 'utf8')).toBe('{"v":2}');
});
test('reviewed source root changes update only owned hook entries', () => {
  const f = fixture(); install(f.project, reviewed(f.project, f.options));
  const nextRoot = join(dirname(f.sourceRoot), 'next-root'); mkdirSync(nextRoot);
  const options = { ...f.options, sourceRoots: [nextRoot] };
  expect(install(f.project, reviewed(f.project, options)).state).toBe('installed');
  expect(hooks(f.project).hooks.SessionStart[0]).toEqual(unrelated);
  expect(hooks(f.project).hooks.SessionStart).toHaveLength(2);
  const entry = z.object({ hooks: z.array(z.object({ command: z.string() })) }).parse(hooks(f.project).hooks.SessionStart[1]);
  expect(entry.hooks[0]?.command).toContain(quote(nextRoot));
  expect(entry.hooks[0]?.command).not.toContain(quote(f.sourceRoot));
});
test('removal preserves unrelated hooks keys receipts transcripts and settings', () => {
  const f = fixture(); install(f.project, reviewed(f.project, f.options));
  put(f.project, `${metadata}/receipts/synthetic.json`, '{"receipt":true}');
  put(f.sourceRoot, 'synthetic.jsonl', '{"synthetic":true}');
  const document = hooks(f.project);
  document.hooks.SessionStart.push({ hooks: [{ type: 'command', command: 'added later' }] });
  document['later-key'] = [1, 2];
  put(f.project, hooksPath, JSON.stringify(document));
  const evidence = reviewed(f.project, f.options, 'remove'), before = snapshot(f.project);
  preview(f.project, { ...f.options, operation: 'remove' });
  expect(snapshot(f.project)).toBe(before);
  expect(remove(f.project, evidence).state).toBe('absent');
  expect(existsSync(join(f.project, target))).toBe(false);
  expect(existsSync(join(f.project, recorder))).toBe(false);
  expect(existsSync(join(f.project, metadata, 'installation.json'))).toBe(false);
  expect(hooks(f.project).hooks.SessionStart).toEqual([unrelated, { hooks: [{ type: 'command', command: 'added later' }] }]);
  expect(hooks(f.project).hooks.SubagentStart).toEqual([]);
  expect(hooks(f.project)['later-key']).toEqual([1, 2]);
  expect(readFileSync(join(f.project, metadata, 'receipts/synthetic.json'), 'utf8')).toBe('{"receipt":true}');
  expect(readFileSync(join(f.sourceRoot, 'synthetic.jsonl'), 'utf8')).toBe('{"synthetic":true}');
  expect(readFileSync(join(f.project, '.agents/skills/unrelated/SKILL.md'), 'utf8')).toBe('unrelated skill');
  const removed = snapshot(f.project);
  expect(remove(f.project, f.options).state).toBe('absent');
  expect(snapshot(f.project)).toBe(removed);
});
test.each(['source', 'hooks', 'roots', 'root replacement'])('stale %s preview refuses mutation', kind => {
  const f = fixture(), options = reviewed(f.project, f.options);
  let requested = options;
  switch (kind) {
    case 'source': put(f.packageRoot, 'SKILL.md', 'changed source'); break;
    case 'hooks': put(f.project, hooksPath, '{"later":true}'); break;
    case 'roots': requested = { ...options, sourceRoots: [f.project] }; break;
    case 'root replacement': renameSync(f.project, `${f.project}-old`); mkdirSync(f.project); break;
  }
  const before = snapshot(f.project);
  expect(() => install(f.project, requested)).toThrow('codex_connect_installation_preview_changed');
  expect(snapshot(f.project)).toBe(before);
});
test('stale removal detects unrelated hooks added after its preview', () => {
  const f = fixture(); install(f.project, reviewed(f.project, f.options));
  const options = reviewed(f.project, f.options, 'remove');
  const document = hooks(f.project); document['late-key'] = true; put(f.project, hooksPath, JSON.stringify(document));
  const before = snapshot(f.project);
  expect(() => remove(f.project, options)).toThrow('codex_connect_installation_preview_changed');
  expect(snapshot(f.project)).toBe(before);
});
test.each(['skill', 'recorder', 'extra file', 'empty directory', 'owned hook', 'missing hook', 'manifest'])(
  'changed %s blocks installation and removal without mutation', kind => {
    const f = fixture(); install(f.project, reviewed(f.project, f.options));
    switch (kind) {
      case 'skill': put(f.project, `${target}/SKILL.md`, 'user edit'); break;
      case 'recorder': put(f.project, recorder, 'user edit'); break;
      case 'extra file': put(f.project, `${target}/user.txt`, 'user file'); break;
      case 'empty directory': mkdirSync(join(f.project, target, 'empty')); break;
      case 'owned hook': {
        const document = hooks(f.project);
        document.hooks.SessionStart[1] = { hooks: [{ type: 'command', command: 'user edit' }] };
        put(f.project, hooksPath, JSON.stringify(document)); break;
      }
      case 'missing hook': {
        const document = hooks(f.project); document.hooks.SubagentStart = [];
        put(f.project, hooksPath, JSON.stringify(document)); break;
      }
      case 'manifest': put(f.project, `${metadata}/installation.json`, '{}'); break;
    }
    const before = snapshot(f.project);
    expect(status(f.project, f.options).state).toBe('blocked');
    expect(install(f.project, f.options).state).toBe('blocked');
    expect(remove(f.project, f.options).state).toBe('blocked');
    expect(snapshot(f.project)).toBe(before);
  },
);
test.each(['skill', 'recorder'])('unowned %s cannot be adopted even with matching bytes', kind => {
  const f = fixture();
  if (kind === 'skill') put(f.project, `${target}/SKILL.md`, 'synthetic skill');
  else put(f.project, recorder, readFileSync(f.hookSource, 'utf8'));
  const before = snapshot(f.project);
  expect(install(f.project, f.options).blockers).toContain('codex_connect_package_unowned');
  expect(snapshot(f.project)).toBe(before);
});
test.each(['symlink parent', 'symlink hooks', 'hardlink hooks', 'hardlink owned', 'writable parent', 'public receipts'])(
  'unsafe %s is refused without mutation', kind => {
    const f = fixture();
    switch (kind) {
      case 'symlink parent':
        renameSync(join(f.project, '.agents'), join(f.project, 'agents-original'));
        symlinkSync(join(f.project, 'agents-original'), join(f.project, '.agents')); break;
      case 'symlink hooks':
        renameSync(join(f.project, hooksPath), join(f.project, 'original-hooks'));
        symlinkSync(join(f.project, 'original-hooks'), join(f.project, hooksPath)); break;
      case 'hardlink hooks': linkSync(join(f.project, hooksPath), join(f.project, 'linked')); break;
      case 'hardlink owned':
        install(f.project, reviewed(f.project, f.options));
        linkSync(join(f.project, target, 'SKILL.md'), join(f.project, 'linked')); break;
      case 'writable parent': chmodSync(join(f.project, '.codex'), 0o777); break;
      case 'public receipts':
        mkdirSync(join(f.project, metadata, 'receipts'), { recursive: true, mode: 0o700 });
        chmodSync(join(f.project, metadata, 'receipts'), 0o755); break;
    }
    const before = snapshot(f.project);
    expect(install(f.project, f.options).state).toBe('blocked');
    expect(remove(f.project, f.options).state).toBe('blocked');
    expect(snapshot(f.project)).toBe(before);
  },
);
test.each(['0.162.0', '0.162.2', ''])('version %s cannot expand exact admission', productVersion => {
  const f = fixture(), before = snapshot(f.project);
  expect(install(f.project, { ...f.options, productVersion }).blockers).toContain('codex_connect_product_version_unsupported');
  expect(snapshot(f.project)).toBe(before);
});
test('unavailable source still permits reviewed unchanged owned removal', () => {
  const f = fixture(); install(f.project, reviewed(f.project, f.options));
  rmSync(f.packageRoot, { recursive: true }); rmSync(f.hookSource);
  expect(status(f.project, f.options).source).toBe('unavailable');
  expect(remove(f.project, reviewed(f.project, f.options, 'remove')).state).toBe('absent');
});
test.each(['duplicate keys', 'non-object hooks', 'non-array event', 'lossy number'])('malformed %s hooks are never rewritten', kind => {
  const f = fixture();
  put(f.project, hooksPath, kind === 'duplicate keys' ? '{"hooks":{},"hooks":{}}' :
    kind === 'non-object hooks' ? '{"hooks":[]}' : kind === 'lossy number' ? '{"keep":9007199254740993}' :
      '{"hooks":{"SessionStart":{}}}');
  const before = snapshot(f.project);
  expect(install(f.project, f.options).state).toBe('blocked');
  expect(snapshot(f.project)).toBe(before);
});
test('an existing lock blocks all mutations without inventing recovery', () => {
  const f = fixture(); install(f.project, reviewed(f.project, f.options));
  mkdirSync(join(f.project, metadata, 'installation-lock'), { mode: 0o700 });
  const before = snapshot(f.project);
  expect(status(f.project, f.options).blockers).toContain('codex_connect_installation_busy');
  expect(remove(f.project, f.options).state).toBe('blocked');
  expect(snapshot(f.project)).toBe(before);
});
test('commit failure rolls back fresh files and keeps the original hooks', () => {
  const f = fixture(), options = reviewed(f.project, f.options), before = snapshot(f.project);
  fault.commit = true;
  expect(() => install(f.project, options)).toThrow('codex_connect_installation_unavailable');
  expect(snapshot(f.project)).toBe(before);
});
test('concurrent hooks edits survive a refused update and package rollback', () => {
  const f = fixture(); install(f.project, reviewed(f.project, f.options));
  put(f.packageRoot, 'SKILL.md', 'upgrade');
  const options = reviewed(f.project, f.options);
  fault.concurrent = true;
  expect(() => install(f.project, options)).toThrow('codex_connect_installation_preview_changed');
  expect(readFileSync(join(f.project, hooksPath), 'utf8')).toBe('{"concurrent":true}');
  expect(readFileSync(join(f.project, target, 'SKILL.md'), 'utf8')).toBe('synthetic skill');
});
test('rollback never deletes a newly modified file and leaves a recovery lock', () => {
  const f = fixture(); install(f.project, reviewed(f.project, f.options));
  put(f.packageRoot, 'SKILL.md', 'upgrade');
  const options = reviewed(f.project, f.options);
  fault.commit = true; fault.rollbackDrift = true;
  expect(() => install(f.project, options)).toThrow('codex_connect_installation_rollback_failed');
  expect(readFileSync(join(f.project, target, 'SKILL.md'), 'utf8')).toBe('concurrent package edit');
  expect(existsSync(join(f.project, metadata, 'installation-lock'))).toBe(true);
  expect(status(f.project, f.options).state).toBe('blocked');
});
test('default shipped sources are available without reading session contents', () => {
  const f = fixture();
  const result = preview(f.project, { sourceRoots: [f.sourceRoot], productVersion: '0.162.1' });
  expect(result.source).toBe('available');
  expect(result.changes.some(change => change.path === recorder)).toBe(true);
});
test('a project without hooks gets only the two owned lifecycle entries', () => {
  const f = fixture(); rmSync(join(f.project, hooksPath));
  expect(install(f.project, reviewed(f.project, f.options)).state).toBe('installed');
  expect(Object.keys(hooks(f.project).hooks).sort()).toEqual(['SessionStart', 'SubagentStart']);
});
test('unowned recorder commands are refused instead of duplicated or adopted', () => {
  const f = fixture();
  put(f.project, hooksPath, JSON.stringify({ hooks: { SessionStart: [{
    hooks: [{ type: 'command', command: `node ${join(f.project, recorder)}` }],
  }] } }));
  const before = snapshot(f.project);
  expect(install(f.project, f.options).blockers).toContain('codex_connect_hooks_unowned');
  expect(snapshot(f.project)).toBe(before);
});
test.each(['skill symlink', 'recorder hardlink', 'noncanonical root'])('unsafe source %s is refused read-only', kind => {
  const f = fixture();
  switch (kind) {
    case 'skill symlink': symlinkSync(join(f.packageRoot, 'SKILL.md'), join(f.packageRoot, 'link')); break;
    case 'recorder hardlink': linkSync(f.hookSource, join(dirname(f.hookSource), 'linked')); break;
    case 'noncanonical root': {
      const link = join(dirname(f.sourceRoot), 'linked-root'); symlinkSync(f.sourceRoot, link);
      const before = snapshot(f.project);
      expect(install(f.project, { ...f.options, sourceRoots: [link] }).state).toBe('blocked');
      expect(snapshot(f.project)).toBe(before); return;
    }
  }
  const before = snapshot(f.project);
  expect(install(f.project, f.options).state).toBe('blocked');
  expect(snapshot(f.project)).toBe(before);
});
test('package tree traversal has a finite entry budget', () => {
  const f = fixture();
  for (let index = 0; index < 257; index++) put(f.packageRoot, `file-${index}.json`, '{}');
  const before = snapshot(f.project);
  expect(install(f.project, f.options).blockers).toContain('codex_connect_package_limit');
  expect(snapshot(f.project)).toBe(before);
});
test('moving an installed project does not transfer its ownership to a replacement root', () => {
  const f = fixture(); install(f.project, reviewed(f.project, f.options));
  renameSync(f.project, `${f.project}-old`); mkdirSync(f.project);
  for (const path of readdirSync(`${f.project}-old`)) renameSync(join(`${f.project}-old`, path), join(f.project, path));
  const before = snapshot(f.project);
  expect(remove(f.project, f.options).blockers).toContain('codex_connect_changed_project_root');
  expect(snapshot(f.project)).toBe(before);
});
