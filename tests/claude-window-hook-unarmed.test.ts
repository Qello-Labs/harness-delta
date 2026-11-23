import './helpers/claude-window-preservation.mjs';
import { bounded, observedProcess } from '../scripts/tool-update/fixtures.mjs';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';

const hook = resolve('skills/harness-connect-window-claude/scripts/claude-session-hook.mjs');
const roots: string[] = [];
const messageSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ready') }),
  z.object({ kind: z.literal('control_read') }),
  z.object({
    kind: z.literal('effects'),
    effects: z.object({
      unauthorizedCalls: z.number(),
      nativeCalls: z.number(),
      processCalls: z.number(),
      metadataWrites: z.number(),
      operations: z.array(z.string())
    })
  })
]);
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const projectRoot = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'claude-window-unarmed-synthetic-')));
  roots.push(projectRoot);
  const directory = join(projectRoot, '.harness-delta', 'claude-window-receipts');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const controlPath = join(directory, 'ordinary-window-control.json');
  fs.writeFileSync(
    controlPath,
    JSON.stringify({
      schemaVersion: 1,
      projectRoot,
      product: 'claude_code',
      policyId: 'claude-binding-root-window-v1',
      policyRevision: 'claude-ordinary-root-window-v1',
      evidenceMode: 'publisher_verified_local_pin',
      state: 'active'
    }),
    { mode: 0o600 }
  );
  return { projectRoot, directory, controlPath };
}
async function invoke(
  f: ReturnType<typeof fixture>,
  options: {
    readonly directory?: string | null;
    readonly args?: readonly string[];
    readonly stdin?: string;
    readonly revoke?: () => void;
    readonly removeAncestorAfterValidation?: 'leaf' | 'ancestor';
  } = {}
) {
  const preloads: string[] = [];
  if (options.removeAncestorAfterValidation) {
    const path = join(f.projectRoot, 'ancestor-race.mjs');
    fs.writeFileSync(
      path,
      [
        "import fs from 'node:fs';",
        "import { syncBuiltinESMExports } from 'node:module';",
        'const original = fs.lstatSync;',
        'const rename = fs.renameSync;',
        `const boundary = ${JSON.stringify(options.removeAncestorAfterValidation === 'ancestor' ? dirname(f.directory) : f.directory)};`,
        `const ancestor = ${JSON.stringify(dirname(f.directory))};`,
        'fs.lstatSync = (path, ...args) => {',
        '  const stat = original(path, ...args);',
        "  if (path === boundary) rename(ancestor, ancestor + '-removed');",
        '  return stat;',
        '};',
        'syncBuiltinESMExports();'
      ].join('\n'),
      { mode: 0o600 }
    );
    preloads.push('--import', path);
  }
  let stdout = '',
    stderr = '';
  let effects: z.infer<typeof messageSchema> | undefined;
  const launched = observedProcess(
    process.execPath,
    [...preloads, '--import', resolve('tests/helpers/claude-window-launcher.mjs'), hook, ...(options.args ?? ['record'])],
    {
      env: {
        ...process.env,
        HARNESS_DELTA_CLAUDE_WINDOW_RECEIPT_DIR: options.directory === null ? undefined : (options.directory ?? f.directory),
        CLAUDE_WINDOW_FIXTURE: JSON.stringify({ script: hook, directory: f.directory, nativePrefixes: [] })
      },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc']
    },
    child => {
      const sendInput = () =>
        child.stdin?.end(
          options.stdin ?? JSON.stringify({ hook_event_name: 'SessionStart', session_id: '11111111-1111-4111-8111-111111111111', cwd: f.projectRoot })
        );
      child.once('spawn', () => {
        child.stdout?.on('data', (chunk: Buffer) => {
          stdout += chunk.toString();
        });
        child.stderr?.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        child.stdin?.on('error', error => {
          if (!('code' in error) || error.code !== 'EPIPE') throw error;
        });
      });
      child.on('message', (message: unknown) => {
        const parsed = messageSchema.parse(message);
        switch (parsed.kind) {
          case 'ready':
            if (!options.revoke) sendInput();
            break;
          case 'control_read':
            if (options.revoke) {
              options.revoke();
              sendInput();
            }
            break;
          case 'effects':
            effects = parsed;
            break;
          default: {
            const exhaustive: never = parsed;
            throw new Error('fixture_unhandled_hook_message', { cause: exhaustive });
          }
        }
      });
    }
  );
  let code: number | null;
  try {
    [code] = await bounded(launched.closed, 10000);
  } catch (error) {
    launched.child.kill('SIGKILL');
    throw error;
  }
  expect(effects).toEqual({
    kind: 'effects',
    effects: { unauthorizedCalls: 0, nativeCalls: 0, processCalls: 0, metadataWrites: 0, operations: [] }
  });
  const stat = fs.existsSync(f.directory) ? fs.lstatSync(f.directory) : null;
  const receipts = stat?.isDirectory() ? fs.readdirSync(f.directory).filter(name => /^[a-f0-9-]{36}\.json$/.test(name)) : [];
  expect(receipts).toEqual([]);
  return { code, stdout, stderr };
}
function remove(f: ReturnType<typeof fixture>, kind: string) {
  if (kind === 'control') fs.unlinkSync(f.controlPath);
  else fs.rmSync(kind === 'ancestor' ? dirname(f.directory) : f.directory, { recursive: true });
}
test.each(['directory', 'control'])('quietly ignores missing %s before reading invalid stdin', async kind => {
  const f = fixture();
  remove(f, kind);
  expect(await invoke(f, { stdin: '{invalid' })).toEqual({ code: 0, stdout: '', stderr: '' });
  expect(fs.existsSync(kind === 'directory' ? f.directory : f.controlPath)).toBe(false);
});
test.each(['directory', 'control'])('quietly suppresses receipts when %s disappears while stdin is pending', async kind => {
  const f = fixture();
  expect(await invoke(f, { revoke: () => remove(f, kind) })).toEqual({ code: 0, stdout: '', stderr: '' });
  expect(fs.existsSync(kind === 'directory' ? f.directory : f.controlPath)).toBe(false);
});
test.each([
  'ancestor',
  'ancestor-mode',
  'directory-mode',
  'non-directory',
  'directory-symlink',
  'ancestor-symlink',
  'control-symlink',
  'control-mode',
  'malformed-control',
  'invalid-env',
  'missing-env',
  'invalid-config',
  'invalid-payload'
])('keeps %s visible instead of treating it as unarmed', async kind => {
  const f = fixture();
  let directory: string | null = f.directory;
  if (kind === 'ancestor') remove(f, 'ancestor');
  if (kind === 'ancestor-mode') {
    remove(f, 'directory');
    fs.chmodSync(dirname(f.directory), 0o755);
  }
  if (kind === 'directory-mode') fs.chmodSync(f.directory, 0o755);
  if (kind === 'non-directory') {
    remove(f, 'directory');
    fs.writeFileSync(f.directory, '', { mode: 0o600 });
  }
  if (kind === 'directory-symlink' || kind === 'ancestor-symlink') {
    const path = kind === 'directory-symlink' ? f.directory : dirname(f.directory);
    fs.renameSync(path, path + '-saved');
    fs.symlinkSync(path + '-saved', path);
  }
  if (kind === 'control-symlink') {
    fs.renameSync(f.controlPath, f.controlPath + '-saved');
    fs.symlinkSync(f.controlPath + '-saved', f.controlPath);
  }
  if (kind === 'control-mode') fs.chmodSync(f.controlPath, 0o644);
  if (kind === 'malformed-control') fs.writeFileSync(f.controlPath, '{invalid');
  if (kind === 'invalid-env') directory = 'relative';
  if (kind === 'missing-env') directory = null;
  expect(
    await invoke(f, {
      directory,
      ...(kind === 'invalid-config' ? { args: ['invalid'] } : {}),
      ...(kind === 'invalid-payload' ? { stdin: '{invalid' } : {})
    })
  ).toEqual({ code: 1, stdout: '', stderr: 'binding_window_hook_metadata_unavailable\n' });
});
test.each(['ancestor', 'directory-mode', 'malformed-control'])('keeps revoked %s failures visible after stdin', async kind => {
  const f = fixture();
  const revoke = () => {
    if (kind === 'ancestor') remove(f, kind);
    if (kind === 'directory-mode') fs.chmodSync(f.directory, 0o755);
    if (kind === 'malformed-control') fs.writeFileSync(f.controlPath, '{invalid');
  };
  expect(await invoke(f, { revoke })).toEqual({ code: 1, stdout: '', stderr: 'binding_window_hook_metadata_unavailable\n' });
});

test.each(['leaf', 'ancestor'] as const)('keeps a missing ancestor visible after its %s lookup succeeds', async boundary => {
  const f = fixture();
  const result = await invoke(f, { removeAncestorAfterValidation: boundary });
  expect(fs.existsSync(dirname(f.directory) + '-removed')).toBe(true);
  expect(result).toEqual({
    code: 1,
    stdout: '',
    stderr: 'binding_window_hook_metadata_unavailable\n'
  });
});
