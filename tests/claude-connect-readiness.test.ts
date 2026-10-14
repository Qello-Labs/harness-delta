import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import { inspectClaudeProjectSkill, inspectOrdinaryClaudeProjectSkill } from '../src/claude-connect-readiness.js';
import { installClaudeConnectInstallation, statusClaudeConnectInstallation } from '../src/claude-connect-installation.js';

const source = fileURLToPath(new URL('../skills/harness-connect', import.meta.url));
const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'claude-readiness-'));
  roots.push(root);
  const project = join(root, 'project');
  mkdirSync(project);
  return { root, project, destination: join(project, '.claude/skills/harness-connect') };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('ordinary missing installation offers no legacy copy command or writes', () => {
  const f = fixture();
  expect(inspectOrdinaryClaudeProjectSkill(f.project)).toEqual({
    state: 'missing', reason: 'project_skill_missing', install_command: null,
  });
  expect(existsSync(join(f.project, '.claude'))).toBe(false);
  expect(existsSync(join(f.project, '.harness-delta'))).toBe(false);
});

test('current manifest installation is installed despite configured script bytes', () => {
  const f = fixture();
  expect(installClaudeConnectInstallation(f.project).state).toBe('installed');
  for (const file of ['scripts/connect.mjs', 'scripts/claude-session-hook.mjs']) {
    expect(readFileSync(join(f.destination, file))).not.toEqual(readFileSync(join(source, file)));
  }
  const manifest = join(f.project, '.harness-delta/claude-connect/installation.json');
  const before = readFileSync(manifest);
  expect(inspectOrdinaryClaudeProjectSkill(f.project)).toEqual({
    state: 'installed', reason: null, install_command: null,
  });
  expect(inspectClaudeProjectSkill(f.project)).toEqual({
    state: 'conflict', reason: 'package_differs', install_command: null,
  });
  expect(readFileSync(manifest)).toEqual(before);
  expect(existsSync(join(f.project, '.harness-delta/claude-connect/receipts'))).toBe(false);
});

test.each(['changed', 'missing'] as const)('ordinary %s owned file remains a conflict', kind => {
  const f = fixture();
  expect(installClaudeConnectInstallation(f.project).state).toBe('installed');
  const path = join(f.destination, 'scripts/connect.mjs');
  if (kind === 'changed') writeFileSync(path, 'synthetic drift');
  else unlinkSync(path);
  expect(inspectOrdinaryClaudeProjectSkill(f.project)).toEqual({
    state: 'conflict', reason: 'package_drift', install_command: null,
  });
});

test('ordinary pristine copy without ownership remains a conflict', () => {
  const f = fixture();
  mkdirSync(join(f.project, '.claude/skills'), { recursive: true });
  cpSync(source, f.destination, { recursive: true });
  expect(inspectOrdinaryClaudeProjectSkill(f.project)).toEqual({
    state: 'conflict', reason: 'package_unowned', install_command: null,
  });
  expect(inspectClaudeProjectSkill(f.project)).toEqual({
    state: 'installed', reason: null, install_command: null,
  });
});

test('ordinary manifest from a different project root remains a conflict', () => {
  const f = fixture();
  expect(installClaudeConnectInstallation(f.project).state).toBe('installed');
  const other = join(f.root, 'other');
  mkdirSync(other);
  renameSync(join(f.project, '.claude'), join(other, '.claude'));
  renameSync(join(f.project, '.harness-delta'), join(other, '.harness-delta'));
  expect(inspectOrdinaryClaudeProjectSkill(other)).toEqual({
    state: 'conflict', reason: 'changed_project_root', install_command: null,
  });
});

test('ordinary symlink project root remains a conflict', () => {
  const f = fixture();
  const alias = join(f.root, 'alias');
  symlinkSync(f.project, alias);
  expect(inspectOrdinaryClaudeProjectSkill(alias)).toEqual({
    state: 'conflict', reason: 'unsafe_project_root', install_command: null,
  });
});

test.each([false, true])('unavailable package source cannot become installed with ownership %s', installed => {
  const f = fixture();
  if (installed) expect(installClaudeConnectInstallation(f.project).state).toBe('installed');
  expect(inspectOrdinaryClaudeProjectSkill(f.project, { packageRoot: join(f.root, 'missing-package') })).toEqual({
    state: 'unavailable', reason: 'package_source_unavailable', install_command: null,
  });
});

test('ordinary update requires reviewed update instead of claiming current installation', () => {
  const f = fixture();
  const packageRoot = join(f.root, 'package');
  cpSync(source, packageRoot, { recursive: true });
  expect(installClaudeConnectInstallation(f.project, { packageRoot }).state).toBe('installed');
  writeFileSync(join(packageRoot, 'SKILL.md'), 'synthetic new package');
  expect(statusClaudeConnectInstallation(f.project, { packageRoot }).state).toBe('update_available');
  expect(inspectOrdinaryClaudeProjectSkill(f.project, { packageRoot })).toEqual({
    state: 'conflict', reason: 'project_skill_update_required', install_command: null,
  });
  expect(installClaudeConnectInstallation(f.project, { packageRoot }).state).toBe('installed');
  expect(inspectOrdinaryClaudeProjectSkill(f.project, { packageRoot }).state).toBe('installed');
});

test('legacy missing installation keeps the guarded shell-copy command', () => {
  const f = fixture();
  const result = inspectClaudeProjectSkill(f.project);
  expect(result.state).toBe('missing');
  expect(result.reason).toBe('project_skill_missing');
  expect(typeof result.install_command).toBe('string');
  expect(existsSync(join(f.project, '.claude'))).toBe(false);
});

test('legacy drift and missing bundled source keep existing classifications', () => {
  const f = fixture();
  mkdirSync(join(f.project, '.claude/skills'), { recursive: true });
  cpSync(source, f.destination, { recursive: true });
  writeFileSync(join(f.destination, 'SKILL.md'), 'synthetic drift');
  expect(inspectClaudeProjectSkill(f.project)).toEqual({
    state: 'conflict', reason: 'package_differs', install_command: null,
  });
  expect(inspectClaudeProjectSkill(f.project, join(f.root, 'missing-package'))).toEqual({
    state: 'unavailable', reason: 'directory_unavailable', install_command: null,
  });
});
