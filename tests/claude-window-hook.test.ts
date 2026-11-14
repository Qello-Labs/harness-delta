import './helpers/claude-window-preservation.mjs';
import { bounded, observedProcess } from '../scripts/tool-update/fixtures.mjs';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';
import { ClaudeWindowPendingReceiptSchema } from '../src/session-binding-claude.js';
import { installClaudeConnectInstallation, previewClaudeConnectInstallation } from '../src/connect/claude-connect-installation.js';

const hook = resolve('skills/harness-connect-window-claude/scripts/claude-session-hook.mjs');
const rootId = '11111111-1111-4111-8111-111111111111';
const effectsSchema = z.object({
  kind: z.literal('effects'),
  effects: z.object({
    ownedReads: z.number(),
    unauthorizedCalls: z.number(),
    nativeCalls: z.number(),
    processCalls: z.number(),
    metadataWrites: z.number(),
    operations: z.array(z.string())
  })
});
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
function fixture() {
  const projectRoot = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'claude-window-hook-synthetic-')));
  roots.push(projectRoot);
  const directory = join(projectRoot, '.harness-delta', 'claude-window-receipts');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const native = join(projectRoot, 'native');
  fs.mkdirSync(native, { mode: 0o700 });
  fs.writeFileSync(join(native, 'source.jsonl'), 'SYNTHETIC_NATIVE');
  const controlPath = join(directory, 'ordinary-window-control.json');
  const control = {
    schemaVersion: 1,
    projectRoot,
    product: 'claude_code',
    policyId: 'claude-binding-root-window-v1',
    policyRevision: 'claude-ordinary-root-window-v1',
    evidenceMode: 'publisher_verified_local_pin',
    state: 'active'
  };
  const setControl = (value: unknown) => fs.writeFileSync(controlPath, JSON.stringify(value), { mode: 0o600 });
  setControl(control);
  const input = {
    hook_event_name: 'SessionStart',
    session_id: rootId,
    cwd: `${native}/raw/../cwd`,
    transcript_path: join(native, 'source.jsonl'),
    prompt: 'SYNTHETIC_PRIVATE',
    response: 'SYNTHETIC_PRIVATE',
    productVersion: '99.99.99',
    sourceIdentity: 'FORGED',
    processId: 999,
    proof: 'FORGED'
  };
  return {
    projectRoot,
    directory,
    native,
    controlPath,
    control,
    setControl,
    input
  };
}
async function invoke(
  f: ReturnType<typeof fixture>,
  options: {
    readonly input?: unknown;
    readonly stdin?: string;
    readonly directory?: string;
    readonly script?: string;
    readonly bootstrap?: string;
    readonly revoke?: boolean;
    readonly aliases?: readonly {
      readonly path: string;
      readonly target: string;
    }[];
  } = {}
) {
  const fd = fs.openSync(join(f.native, 'source.jsonl'), 'r');
  let stdout = '',
    stderr = '',
    ready = false;
  let ledger: z.infer<typeof effectsSchema> | undefined;
  const launched = observedProcess(
    process.execPath,
    ['--import', resolve('tests/helpers/claude-window-launcher.mjs'), options.script ?? hook, 'record'],
    {
      env: {
        ...process.env,
        HARNESS_DELTA_CLAUDE_WINDOW_RECEIPT_DIR: options.bootstrap ? undefined : (options.directory ?? f.directory),
        CLAUDE_PID: '999999999',
        CLAUDE_CONFIG_DIR: f.native,
        CLAUDE_CODE_SESSION_ID: 'FORGED',
        CLAUDE_WINDOW_FIXTURE: JSON.stringify({
          script: options.script ?? hook,
          codeFiles: options.bootstrap ? [options.bootstrap] : [],
          directory: options.directory ?? f.directory,
          nativePrefixes: [f.native, '/proc', '/dev/fd'],
          aliases: options.aliases ?? []
        })
      },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc', fd]
    },
    child => {
      const sendInput = () => child.stdin?.end(options.stdin ?? JSON.stringify(options.input ?? f.input));
      child.once('spawn', () => {
        child.stdout?.on('data', (chunk: Buffer) => {
          stdout += chunk.toString();
        });
        child.stderr?.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        child.stdin?.on('error', error => {
          if (!('code' in error) || error.code !== 'EPIPE') {
            throw error;
          }
        });
      });
      child.on('message', (message: unknown) => {
        if (z.object({ kind: z.literal('ready') }).safeParse(message).success) {
          ready = true;
          if (!options.revoke) sendInput();
        }
        if (options.revoke && z.object({ kind: z.literal('control_read') }).safeParse(message).success) {
          f.setControl({ ...f.control, state: 'inactive' });
          sendInput();
        }
        const parsed = effectsSchema.safeParse(message);
        if (parsed.success) ledger = parsed.data;
      });
    }
  );
  fs.closeSync(fd);
  let code: number | null;
  try {
    [code] = await bounded(launched.closed, 10000);
  } catch (error) {
    launched.child.kill('SIGKILL');
    throw error;
  }
  if (!ready || !ledger) {
    throw new Error('claude_window_missing_effects', {
      cause: { code, stderr }
    });
  }
  const names = fs.readdirSync(f.directory).filter(name => /^[a-f0-9-]{36}\.json$/.test(name));
  const receipts = names.map(name => ClaudeWindowPendingReceiptSchema.parse(JSON.parse(fs.readFileSync(join(f.directory, name), 'utf8'))));
  return { code, stdout, stderr, effects: ledger.effects, receipts, names };
}
function zeroUnauthorized(result: Awaited<ReturnType<typeof invoke>>) {
  expect(result.effects).toMatchObject({
    unauthorizedCalls: 0,
    nativeCalls: 0,
    processCalls: 0,
    operations: []
  });
}
test.each([true, false])('installed recorder uses its actual bootstrap under active=%s control', async active => {
  const f = fixture();
  if (!active) f.setControl({ ...f.control, state: 'inactive' });
  const options = { bundleMode: 'ordinary_window' } as const;
  const preview = previewClaudeConnectInstallation(f.projectRoot, options);
  expect(preview.blockers).toEqual([]);
  expect(
    installClaudeConnectInstallation(f.projectRoot, {
      ...options,
      expectedPackageHash: preview.packageHash,
      expectedInstalledHash: preview.installedHash
    }).state
  ).toBe('installed');
  const scripts = join(f.projectRoot, '.claude/skills/harness-connect/scripts');
  const result = await invoke(f, {
    script: join(scripts, 'claude-window-session-hook.mjs'),
    bootstrap: join(scripts, 'claude-connect-config.mjs')
  });
  zeroUnauthorized(result);
  expect([result.code, result.effects.metadataWrites, result.receipts.length]).toEqual([0, Number(active), Number(active)]);
  expect(JSON.stringify(result.receipts)).not.toMatch(/SYNTHETIC_PRIVATE|FORGED|99\.99\.99/);
});
test.each(['SessionStart', 'SubagentStart', 'SubagentStop'])('projects %s to exact L1 pending metadata under stale active control', async event => {
  const f = fixture();
  const child = event !== 'SessionStart';
  const result = await invoke(f, {
    input: {
      ...f.input,
      hook_event_name: event,
      ...(child ? { agent_id: 'synthetic-child' } : {}),
      agent_transcript_path: join(f.native, 'child.jsonl')
    }
  });
  zeroUnauthorized(result);
  expect([result.code, result.stderr, result.effects.metadataWrites, result.effects.ownedReads > 0]).toEqual([0, '', 1, true]);
  expect(result.receipts).toHaveLength(1);
  expect(result.receipts[0]).toMatchObject({
    event: event === 'SessionStart' ? 'connect' : event === 'SubagentStart' ? 'subagent_start' : 'subagent_stop',
    nativeSessionId: rootId,
    nativeRootSessionId: rootId,
    agentId: child ? 'synthetic-child' : null,
    sourceRef: f.input.transcript_path,
    cwd: f.input.cwd,
    processIdHint: process.pid
  });
  expect(result.names.map(name => fs.statSync(join(f.directory, name)).mode & 0o777)).toEqual([0o600]);
  expect(result.names).toEqual([result.receipts[0]?.receipt + '.json']);
  expect(JSON.stringify(result.receipts)).not.toMatch(/SYNTHETIC_PRIVATE|FORGED|99\.99\.99|child\.jsonl/);
  expect(result.stdout).not.toContain(f.native);
});
test.each([
  'missing',
  'inactive',
  'receipt_only',
  'malformed',
  'projectRoot',
  'product',
  'policyId',
  'policyRevision',
  'evidenceMode',
  'schemaVersion',
  'extra'
])('emits no metadata for %s control', async kind => {
  const f = fixture();
  if (kind === 'missing') fs.rmSync(f.controlPath);
  else if (kind === 'inactive' || kind === 'receipt_only') {
    f.setControl({ ...f.control, state: kind });
  } else if (kind === 'malformed') {
    fs.writeFileSync(f.controlPath, '{SYNTHETIC_PRIVATE');
  } else f.setControl({ ...f.control, [kind]: 'mismatch' });
  const result = await invoke(f);
  zeroUnauthorized(result);
  expect([result.receipts, result.effects.metadataWrites, result.stdout]).toEqual([[], 0, '']);
});
test('rechecks inactive control after awaited input without further metadata emission', async () => {
  const f = fixture();
  const result = await invoke(f, { revoke: true });
  zeroUnauthorized(result);
  expect([result.receipts, result.effects.metadataWrites, result.stdout]).toEqual([[], 0, '']);
});
test.each([
  { session_id: 'not-a-uuid' },
  { hook_event_name: 'PreToolUse' },
  { hook_event_name: 'SubagentStop', agent_id: 'bad.agent' },
  { cwd: 'x'.repeat(4097) }
])('rejects malformed or unselected payload without native access', async patch => {
  const f = fixture();
  const result = await invoke(f, { input: { ...f.input, ...patch } });
  zeroUnauthorized(result);
  expect([result.code, result.receipts, result.effects.metadataWrites]).toEqual([1, [], 0]);
});
test.each(['payload', 'control', 'storage', 'directory-mode', 'parent-mode', 'project-mode', 'control-mode', 'control-symlink', 'directory-symlink'])(
  'bounds private owned storage and input: %s',
  async kind => {
    const f = fixture();
    if (kind === 'control') {
      fs.writeFileSync(f.controlPath, JSON.stringify(f.control) + ' '.repeat(4097));
    }
    if (kind === 'storage') {
      for (let n = 0; n < 1023; n++) {
        fs.writeFileSync(join(f.directory, `filler-${n}`), '');
      }
    }
    if (kind === 'directory-mode') fs.chmodSync(f.directory, 0o755);
    if (kind === 'parent-mode') {
      fs.chmodSync(join(f.projectRoot, '.harness-delta'), 0o755);
    }
    if (kind === 'project-mode') fs.chmodSync(f.projectRoot, 0o777);
    if (kind === 'control-mode') fs.chmodSync(f.controlPath, 0o644);
    if (kind === 'control-symlink') {
      fs.rmSync(f.controlPath);
      fs.symlinkSync(join(f.native, 'source.jsonl'), f.controlPath);
    }
    if (kind === 'directory-symlink') {
      fs.renameSync(f.directory, f.directory + '-saved');
      fs.symlinkSync(f.directory + '-saved', f.directory);
    }
    const result = await invoke(
      f,
      kind === 'payload'
        ? {
            stdin: JSON.stringify({
              ...f.input,
              prompt: 'x'.repeat(65536)
            })
          }
        : {}
    );
    zeroUnauthorized(result);
    expect([result.code, result.receipts, result.effects.metadataWrites]).toEqual([1, [], 0]);
  }
);
test('rejects a native-pointing project ancestor symlink before descending through it', async () => {
  const f = fixture();
  const alias = join(f.projectRoot, 'alias');
  fs.symlinkSync(f.native, alias);
  const result = await invoke(f, {
    directory: join(alias, 'project', '.harness-delta', 'claude-window-receipts'),
    aliases: [{ path: alias, target: f.native }]
  });
  zeroUnauthorized(result);
  expect([result.code, result.receipts, result.effects.metadataWrites]).toEqual([1, [], 0]);
});
test.each([
  ['inherited native FD', 'readSync(4, Buffer.alloc(1), 0, 1, null);', 1, 0],
  ['native path lookup', 'lstatSync(process.env.CLAUDE_CONFIG_DIR);', 1, 0],
  ['process lookup', 'process.kill(1, 0);', 0, 1]
] as const)('detects %s in a disposable after-await mutation even after revocation', async (_name, statement, nativeCalls, processCalls) => {
  const f = fixture();
  const original = fs.readFileSync(hook);
  const script = join(f.projectRoot, 'mutant.mjs');
  const changed = original.toString().replace('const record = await payload();', 'const record = await payload();\n' + statement);
  expect(changed).not.toBe(original.toString());
  fs.writeFileSync(script, changed);
  const result = await invoke(f, { script, revoke: true });
  expect(result.effects).toMatchObject({
    nativeCalls,
    processCalls,
    metadataWrites: 0
  });
  expect([result.code, result.receipts]).toEqual([1, []]);
  expect(fs.readFileSync(hook)).toEqual(original);
});
