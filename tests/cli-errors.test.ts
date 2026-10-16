import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommanderError } from 'commander';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { main } from '../src/cli.js';
import { describeCliError } from '../src/cli-errors.js';

test.each([
  Object.assign(new Error("The module '/private/PRIVATE_SENTINEL/better_sqlite3.node' was compiled against a different Node.js version using NODE_MODULE_VERSION 137. This version of Node.js requires NODE_MODULE_VERSION 141."), { code: 'ERR_DLOPEN_FAILED' }),
  new Error("Could not locate the bindings file. Tried:\n /private/PRIVATE_SENTINEL/better_sqlite3.node"),
  Object.assign(new Error("dlopen(/private/PRIVATE_SENTINEL/better_sqlite3.node): incompatible architecture"), { code: 'ERR_DLOPEN_FAILED' }),
])('native loading errors receive sanitized recovery', error => {
  const lines = describeCliError(error);
  expect(lines[0]).toBe('native_dependency');
  expect(lines).toHaveLength(2);
  expect(lines.join('\n')).not.toContain('PRIVATE_SENTINEL');
});

test('fixed codes are shown with a hint; other messages fall back without echoing content', () => {
  expect(describeCliError(new Error('binary_mismatch'))).toEqual(['binary_mismatch', expect.stringMatching(/^hint: binary SHA-256/)]);
  expect(describeCliError(new Error('report_conflict'))).toEqual(['report_conflict']);
  expect(describeCliError(new Error("ENOENT: no such file or directory, open '/private/PRIVATE_SENTINEL'"))).toEqual(['input_or_state_error']);
  expect(describeCliError(new Error('UNIQUE constraint failed: comparison_confirmations.id'))).toEqual(['input_or_state_error']);
  expect(describeCliError('PRIVATE_SENTINEL')).toEqual(['input_or_state_error']);
});

test('schema errors show key paths and issue codes, never values or user-supplied keys', () => {
  const schema = z.strictObject({ run_id: z.string().min(1), nested: z.record(z.string(), z.number()) });
  const result = schema.safeParse({ run_id: '', nested: { 'PRIVATE SENTINEL/path': 'PRIVATE_VALUE' }, extra: 'PRIVATE_EXTRA' });
  const lines = describeCliError(result.error);
  expect(lines[0]).toBe('invalid_input');
  expect(lines.join('\n')).toContain('at run_id: too_small');
  expect(lines.join('\n')).not.toMatch(/PRIVATE/);
});

test('usage errors name missing options but do not echo unknown argv tokens', () => {
  expect(describeCliError(new CommanderError(1, 'commander.missingMandatoryOptionValue', "error: required option '--runtime <file>' not specified")))
    .toEqual(["invalid_command: required option '--runtime <file>' not specified", 'hint: run the command with --help for usage']);
  expect(describeCliError(new CommanderError(1, 'commander.unknownOption', "error: unknown option '--PRIVATE_SENTINEL'"))[0]).toBe('invalid_command: unknownOption');
});

let root: string; let errors: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cli-errors-')); errors = '';
  vi.spyOn(process.stderr, 'write').mockImplementation(value => { errors += String(value); return true; });
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

test('workflow CLI reports one actionable line per failure', async () => {
  const db = join(root, 'local.sqlite');
  expect(await main(['--db', db, 'workflow', 'begin', '--config', join(root, 'workflow.json')])).toBe(2);
  expect(errors).toBe("invalid_command: required option '--runtime <file>' not specified\nhint: run the command with --help for usage\n");
  errors = ''; const missing = join(root, 'PRIVATE_SENTINEL.json');
  expect(await main(['--db', db, 'workflow', 'begin', '--config', missing, '--runtime', missing])).toBe(2);
  expect(errors).toBe('config_file_unreadable\nhint: cannot read the --config file\n');
  errors = ''; writeFileSync(join(root, 'bad.json'), '{"PRIVATE_SENTINEL": ');
  expect(await main(['--db', db, 'workflow', 'begin', '--config', join(root, 'bad.json'), '--runtime', join(root, 'bad.json')])).toBe(2);
  expect(errors).toBe('config_file_invalid_json\nhint: the --config file is not valid JSON\n');
  errors = '';
  expect(await main(['--db', db, 'workflow', 'finish', 'task-1', '--outcome', 'success'])).toBe(2);
  expect(errors).toMatch(/^task_not_assigned\nhint: /);
});

test('protocol registration names the newest admitted Claude workflow version rule', async () => {
  const db = join(root, 'local.sqlite'); const project = join(root, 'project'); mkdirSync(project);
  expect(await main(['--db', db, 'project', 'add', 'project-1', '--root', project])).toBe(0);
  const example = JSON.parse(readFileSync('examples/workflow/protocol.json', 'utf8')) as Record<string, unknown>;
  const claude = (product_version: string) => ({ product: 'claude_code', product_version, profile_id: 'claude-workflow-own-trace-v1' });
  const register = (id: string, profiles: unknown[]) => { const path = join(root, `${id}.json`); writeFileSync(path, JSON.stringify({ ...example, id, source_profiles: profiles }));
    return main(['--db', db, 'comparison', 'register', '--config', path]); };
  errors = '';
  expect(await register('protocol-new', [claude('2.1.288')])).toBe(2);
  expect(errors).toBe(describeCliError(new Error('claude_workflow_version_not_latest')).join('\n')+'\n');
  errors = '';
  expect(await register('protocol-two', [claude('2.1.288'), { ...claude('2.1.288'), product_version: '2.1.296' }])).toBe(2);
  expect(errors).toMatch(/^claude_workflow_version_not_latest\n/);
  expect(await register('protocol-latest', [claude('2.1.296')])).toBe(0);
});
