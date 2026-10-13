import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { afterEach, expect, test } from 'vitest';
import { inspectClaudeProjectSkill } from '../src/claude-connect-readiness.js';
import type { ClaudeProjectSkillReadiness } from '../src/claude-connect-readiness.js';

const source = fileURLToPath(new URL('../skills/harness-connect', import.meta.url));
const files = ['SKILL.md', 'scripts/connect.mjs', 'scripts/claude-session-hook.mjs', 'references/support.md'] as const;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'claude-readiness-'));
  roots.push(root);
  const project = join(root, "project space ' $(touch INJECTED); &");
  mkdirSync(project);
  const destination = join(project, '.claude', 'skills', 'harness-connect');
  return { root, project, destination };
}

function install(destination: string) {
  mkdirSync(join(destination, 'scripts'), { recursive: true });
  mkdirSync(join(destination, 'references'), { recursive: true });
  for (const file of files) copyFileSync(join(source, file), join(destination, file));
}

function command(result: ClaudeProjectSkillReadiness): string {
  if (result.state !== 'missing') throw new Error('synthetic_missing_expected');
  return result.install_command;
}

test('missing package returns a command without creating project files', () => {
  const f = fixture();
  writeFileSync(join(f.project, 'unrelated'), 'synthetic');
  const result = inspectClaudeProjectSkill(f.project);
  expect(result.state).toBe('missing');
  expect(result.install_command).not.toBeNull();
  expect(existsSync(join(f.project, '.claude'))).toBe(false);
  expect(readFileSync(join(f.project, 'unrelated'), 'utf8')).toBe('synthetic');
});

test('matching required package is installed without reading unrelated entries', () => {
  const f = fixture();
  install(f.destination);
  symlinkSync(join(f.root, 'absent-native-log'), join(f.destination, 'unselected-session.jsonl'));
  expect(inspectClaudeProjectSkill(f.project)).toEqual({ state: 'installed', reason: null, install_command: null });
  for (const file of files) expect(readFileSync(join(f.destination, file))).toEqual(readFileSync(join(source, file)));
});

test.each(files)('missing expected %s conflicts without changing existing bytes', file => {
  const f = fixture();
  install(f.destination);
  unlinkSync(join(f.destination, file));
  const before = files.filter(name => name !== file).map(name => readFileSync(join(f.destination, name)));
  const result = inspectClaudeProjectSkill(f.project);
  expect(result.state).toBe('conflict');
  expect(result.install_command).toBeNull();
  expect(existsSync(join(f.destination, file))).toBe(false);
  for (const [index, name] of files.filter(name => name !== file).entries()) {
    expect(readFileSync(join(f.destination, name))).toEqual(before[index]);
  }
});

test.each(['different', 'oversized', 'directory'] as const)('invalid expected file conflicts when %s', kind => {
  const f = fixture();
  install(f.destination);
  const path = join(f.destination, 'SKILL.md');
  if (kind === 'directory') { unlinkSync(path); mkdirSync(path); }
  else writeFileSync(path, kind === 'oversized' ? Buffer.alloc(65537) : 'synthetic different bytes');
  const before = lstatSync(path);
  expect(inspectClaudeProjectSkill(f.project).state).toBe('conflict');
  expect(lstatSync(path).size).toBe(before.size);
  expect(lstatSync(path).mtimeMs).toBe(before.mtimeMs);
});

test('an existing empty install directory conflicts instead of offering overwrite', () => {
  const f = fixture();
  mkdirSync(f.destination, { recursive: true });
  const result = inspectClaudeProjectSkill(f.project);
  expect(result.state).toBe('conflict');
  expect(result.install_command).toBeNull();
});

test.each(['root', 'ancestor', '.claude', 'skills', 'install', 'scripts', 'references', 'file'] as const)('symlink %s cannot escape inspection', kind => {
  const f = fixture();
  const outside = join(f.root, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'sentinel'), 'synthetic untouched');
  let project = f.project;
  if (kind === 'root') {
    project = join(f.root, 'linked-root');
    symlinkSync(f.project, project);
  } else if (kind === 'ancestor') {
    const alias = join(f.root, 'linked-ancestor');
    symlinkSync(f.root, alias);
    project = join(alias, f.project.slice(f.root.length + 1));
  } else {
    const path = kind === '.claude' ? join(f.project, '.claude')
      : kind === 'skills' ? join(f.project, '.claude', 'skills')
      : kind === 'install' ? f.destination
      : kind === 'scripts' ? join(f.destination, 'scripts')
      : kind === 'references' ? join(f.destination, 'references')
      : join(f.destination, 'SKILL.md');
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(kind === 'file' ? join(outside, 'sentinel') : outside, path);
  }
  const result = inspectClaudeProjectSkill(project);
  expect(result.state).toBe('conflict');
  expect(result.install_command).toBeNull();
  expect(readFileSync(join(outside, 'sentinel'), 'utf8')).toBe('synthetic untouched');
  expect(existsSync(join(outside, 'scripts'))).toBe(false);
});

test.each(['absent', 'partial', 'symlink', 'scripts-symlink', 'file-symlink', 'oversized'] as const)('unavailable bundled source has no invented command when %s', kind => {
  const f = fixture();
  const packageSource = join(f.root, 'package');
  if (kind === 'symlink') symlinkSync(source, packageSource);
  if (kind === 'partial') mkdirSync(join(packageSource, 'scripts'), { recursive: true });
  if (kind === 'scripts-symlink') {
    mkdirSync(packageSource);
    symlinkSync(join(source, 'scripts'), join(packageSource, 'scripts'));
  }
  if (kind === 'file-symlink') {
    install(packageSource);
    unlinkSync(join(packageSource, 'SKILL.md'));
    symlinkSync(join(source, 'SKILL.md'), join(packageSource, 'SKILL.md'));
  }
  if (kind === 'oversized') {
    install(packageSource);
    writeFileSync(join(packageSource, 'SKILL.md'), Buffer.alloc(65537));
  }
  const result = inspectClaudeProjectSkill(f.project, packageSource);
  expect(result.state).toBe('unavailable');
  expect(result.install_command).toBeNull();
  expect(existsSync(join(f.project, '.claude'))).toBe(false);
});

test('an absent registered project root is unavailable rather than installable', () => {
  const f = fixture();
  const result = inspectClaudeProjectSkill(join(f.root, 'absent-project'));
  expect(result.state).toBe('unavailable');
  expect(result.install_command).toBeNull();
});

test('compiled dist module resolves its own bundled skills without repository fallback', () => {
  const f = fixture();
  const dist = join(f.root, 'dist');
  const packaged = join(dist, 'skills', 'harness-connect');
  install(packaged);
  const compiled = transpileModule(readFileSync(new URL('../src/claude-connect-readiness.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2023 },
  }).outputText;
  const module = join(dist, 'claude-connect-readiness.mjs');
  writeFileSync(module, compiled);
  const invoke = () => spawnSync(process.execPath, ['--input-type=module', '-e',
    'const {inspectClaudeProjectSkill}=await import(process.argv[1]); process.stdout.write(JSON.stringify(inspectClaudeProjectSkill(process.argv[2])));',
    pathToFileURL(module).href, f.project], { encoding: 'utf8', timeout: 10000 });
  const result = invoke();
  expect(result.status).toBe(0);
  const value: unknown = JSON.parse(result.stdout);
  expect(value).toMatchObject({ state: 'missing' });
  if (!value || typeof value !== 'object' || !('install_command' in value) || typeof value.install_command !== 'string') {
    throw new Error('synthetic_missing_command');
  }
  const script = value.install_command;
  expect(spawnSync('/bin/sh', ['-c', script], { cwd: f.root, timeout: 10000 }).status).toBe(0);
  expect(inspectClaudeProjectSkill(f.project).state).toBe('installed');
  rmSync(packaged, { recursive: true });
  const absent = invoke();
  expect(absent.status).toBe(0);
  const unavailable: unknown = JSON.parse(absent.stdout);
  expect(unavailable).toMatchObject({ state: 'unavailable', install_command: null });
});

test('unreadable expected file is unavailable without changing permissions', () => {
  const f = fixture();
  install(f.destination);
  const path = join(f.destination, 'SKILL.md');
  chmodSync(path, 0);
  try {
    expect(inspectClaudeProjectSkill(f.project).state).toBe('unavailable');
    expect(lstatSync(path).mode & 0o777).toBe(0);
  } finally { chmodSync(path, 0o600); }
});

test('quoted local copy command installs only expected bytes without invoking a native CLI', () => {
  const f = fixture();
  const packageSource = join(f.root, "package ' space ; $(touch INJECTED) &");
  install(packageSource);
  writeFileSync(join(packageSource, 'unselected'), 'synthetic');
  const script = command(inspectClaudeProjectSkill(f.project, packageSource));
  const result = spawnSync('/bin/sh', ['-c', script], { cwd: f.root, timeout: 10000 });
  expect(result.status).toBe(0);
  expect(result.error).toBeUndefined();
  expect(inspectClaudeProjectSkill(f.project).state).toBe('installed');
  for (const file of files) expect(readFileSync(join(f.destination, file))).toEqual(readFileSync(join(source, file)));
  expect(existsSync(join(f.destination, 'unselected'))).toBe(false);
  expect(existsSync(join(f.root, 'INJECTED'))).toBe(false);
});

test.each(['directory', 'file', 'symlink', 'dangling', 'parent-symlink'] as const)('copy command refuses a newly existing %s destination', kind => {
  const f = fixture();
  const script = command(inspectClaudeProjectSkill(f.project));
  const outside = join(f.root, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'sentinel'), 'synthetic');
  mkdirSync(dirname(f.destination), { recursive: true });
  if (kind === 'directory') install(f.destination);
  if (kind === 'file') writeFileSync(f.destination, 'synthetic');
  if (kind === 'symlink') symlinkSync(outside, f.destination);
  if (kind === 'dangling') symlinkSync(join(f.root, 'absent'), f.destination);
  if (kind === 'parent-symlink') {
    rmSync(join(f.project, '.claude', 'skills'), { recursive: true });
    symlinkSync(outside, join(f.project, '.claude', 'skills'));
  }
  const before = kind === 'directory' ? readFileSync(join(f.destination, 'SKILL.md')) : null;
  const result = spawnSync('/bin/sh', ['-c', script], { cwd: f.root, timeout: 10000 });
  expect(result.status).not.toBe(0);
  expect(readFileSync(join(outside, 'sentinel'), 'utf8')).toBe('synthetic');
  expect(existsSync(join(outside, 'harness-connect'))).toBe(false);
  if (before) expect(readFileSync(join(f.destination, 'SKILL.md'))).toEqual(before);
  if (kind === 'file') expect(readFileSync(f.destination, 'utf8')).toBe('synthetic');
});
