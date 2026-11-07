import './helpers/claude-window-preservation.mjs';
import { bounded, observedProcess } from '../scripts/tool-update/fixtures.mjs';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';

const helper = resolve('skills/harness-connect-window-claude/scripts/connect.mjs');
const origin = 'http://127.0.0.1:43210';
const project = 'synthetic-project';
const task = 'synthetic-task';
const receipt = '11111111-1111-4111-8111-111111111111';
const csrf = 'a'.repeat(64);
const version = `"${'b'.repeat(64)}"`;
const view = {
  schema_version: 1,
  kind: 'claude_window_task',
  project_id: project,
  task_id: task,
  version,
  state: 'active',
  connection_enabled: true,
  reason: null,
  selected_root_id: null
};
const connection = {
  schema_version: 1,
  kind: 'claude_window_connection',
  status: 'connected',
  project_id: project,
  task_id: task,
  version,
  session_id: 'synthetic-root',
  automatic_children: false,
  collection_active: true,
  evidence_mode: 'publisher_verified_local_pin',
  trust: 'compatibility_unverified',
  root_ownership: 'unverified',
  possible_child_contribution: 'unknown',
  mapped_image_proof: 'unverified',
  cost_coverage: 'partial'
};
const effectsSchema = z.object({
  kind: z.literal('effects'),
  effects: z.object({
    ownedReads: z.number(),
    unauthorizedCalls: z.number(),
    nativeCalls: z.number(),
    processCalls: z.number(),
    metadataWrites: z.number(),
    operations: z.array(z.string())
  }),
  requests: z.array(z.object({ url: z.string(), method: z.string(), headers: z.record(z.string(), z.string()), body: z.string().nullable() })),
  attempts: z.number(),
  connections: z.number(),
  deadlines: z.number()
});
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

async function invoke(options: { readonly scenario?: Readonly<Record<string, unknown>>; readonly args?: readonly string[]; readonly script?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'claude-window-connect-synthetic-'));
  roots.push(root);
  const native = join(root, 'native.jsonl');
  writeFileSync(native, 'SYNTHETIC_NATIVE');
  const fd = openSync(native, 'r');
  let stdout = '',
    stderr = '',
    ready = false;
  let ledger: z.infer<typeof effectsSchema> | undefined;
  const launched = observedProcess(
    process.execPath,
    [
      '--import',
      resolve('tests/helpers/claude-window-launcher.mjs'),
      options.script ?? helper,
      ...(options.args ?? ['connect', '--origin', origin, '--project', project, '--task', task, '--receipt', receipt])
    ],
    {
      env: {
        ...process.env,
        CLAUDE_WINDOW_FIXTURE: JSON.stringify({
          script: options.script ?? helper,
          nativePrefixes: [native, '/proc', '/dev/fd'],
          scenario: { origin, project, task, receipt, csrf, view, connection, ...options.scenario }
        })
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc', fd]
    },
    child => {
      child.once('spawn', () => {
        child.stdout?.on('data', (chunk: Buffer) => {
          stdout += chunk.toString();
        });
        child.stderr?.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
        });
      });
      child.on('message', (message: unknown) => {
        if (z.object({ kind: z.literal('ready') }).safeParse(message).success) ready = true;
        if (z.object({ kind: z.literal('request_pending') }).safeParse(message).success) child.send({ kind: 'abort_request' });
        const parsed = effectsSchema.safeParse(message);
        if (parsed.success) ledger = parsed.data;
      });
    }
  );
  closeSync(fd);
  let code: number | null;
  try {
    [code] = await bounded(launched.closed, 10000);
  } catch (error) {
    launched.child.kill('SIGKILL');
    throw error;
  }
  if (!ready || !ledger) {
    throw new Error('claude_window_missing_effects', { cause: { code, stderr } });
  }
  return { code, stdout, stderr, ...ledger };
}
function zeroEffects(result: Awaited<ReturnType<typeof invoke>>) {
  expect(result.effects).toEqual({ ownedReads: 0, unauthorizedCalls: 0, nativeCalls: 0, processCalls: 0, metadataWrites: 0, operations: [] });
  expect(result.stderr).toBe('');
}
function blocked(result: Awaited<ReturnType<typeof invoke>>, reason: string) {
  zeroEffects(result);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout)).toEqual({ status: 'blocked', reason_code: reason, verified: false });
}
test('connects only explicit active Claude root with CSRF, UUID, version and bounded readback, without native effects', async () => {
  const result = await invoke();
  zeroEffects(result);
  expect([result.code, JSON.parse(result.stdout)]).toEqual([0, connection]);
  expect([result.attempts, result.connections, result.deadlines]).toEqual([1, 1, 3]);
});
test('inspect never starts or connects the selected task', async () => {
  const result = await invoke({ args: ['inspect', '--origin', origin, '--project', project, '--task', task] });
  zeroEffects(result);
  expect(JSON.parse(result.stdout)).toEqual({ status: 'ready', project_id: project, task_id: task, automatic_children: false, reason_code: null });
  expect([result.requests.length, result.attempts, result.connections]).toEqual([1, 0, 0]);
});
test.each([
  ['origin', 'http://example.invalid:42', 'invalid_origin'],
  ['origin', 'http://user@127.0.0.1:42', 'invalid_origin'],
  ['origin', 'http://127.1:42', 'invalid_origin'],
  ['project', 'bad.project', 'invalid_input'],
  ['task', 'x'.repeat(129), 'invalid_input'],
  ['receipt', '11111111-1111-1111-1111-111111111111', 'invalid_input'],
  ['source', '/SYNTHETIC_PRIVATE', 'invalid_input']
])('rejects explicit invalid %s before transport', async (key, value, reason) => {
  const args = ['connect', '--origin', origin, '--project', project, '--task', task, '--receipt', receipt];
  const index = args.indexOf('--' + key);
  if (index >= 0) args[index + 1] = value;
  else args.push('--' + key, value);
  const result = await invoke({ args });
  blocked(result, reason);
  expect(result.requests).toEqual([]);
});
test.each([
  { csrf: 'bad', task: view },
  { csrf, task: { ...view, project_id: 'other' } },
  { csrf, task: { ...view, task_id: 'other' } },
  { csrf, task: { ...view, kind: 'codex_window_task' } },
  { csrf, task: { ...view, reason: '/SYNTHETIC_PRIVATE', connection_enabled: false } },
  { csrf, task: { ...view, version: 'unquoted' } }
])('refuses malformed task fences before POST', async value => {
  const result = await invoke({ scenario: { views: [value] } });
  blocked(result, 'unsupported_ui_contract');
  expect(result.attempts).toBe(0);
});
test.each([
  [{ state: 'paused' }, 'task_closed'],
  [{ connection_enabled: false, reason: 'binding_window_activation_required' }, 'binding_window_activation_required']
])('preserves closed task blockers', async (patch, reason) => {
  const result = await invoke({ scenario: { views: [{ csrf, task: { ...view, ...patch } }] } });
  blocked(result, reason);
  expect(result.attempts).toBe(0);
});
test.each([
  { kind: 'codex_window_connection' },
  { project_id: 'other' },
  { task_id: 'other' },
  { automatic_children: true },
  { evidence_mode: 'source_only' },
  { root_ownership: 'verified' },
  { possible_child_contribution: 'none' },
  { mapped_image_proof: 'verified' },
  { version: 'bad' },
  { raw: '/SYNTHETIC_PRIVATE' }
])('rejects stronger or foreign connection metadata', async patch => {
  const result = await invoke({ scenario: { response: { ...connection, ...patch } } });
  blocked(result, 'connection_unverified');
  expect(result.requests).toHaveLength(2);
});
test.each([
  [{ selected_root_id: 'other' }, 'connection_unverified'],
  [{ selected_root_id: connection.session_id, version: `"${'c'.repeat(64)}"` }, 'connection_unverified'],
  [{ selected_root_id: connection.session_id, connection_enabled: false, reason: 'binding_scope_revoked' }, 'binding_scope_revoked']
])('rechecks linkage and revocation after awaited POST', async (patch, reason) => {
  const result = await invoke({
    scenario: {
      views: [
        { csrf, task: view },
        { csrf, task: { ...view, ...patch } }
      ]
    }
  });
  blocked(result, reason);
  expect([result.attempts, result.requests.length]).toEqual([1, 3]);
});
test.each([
  [{ serverVersion: `"${'c'.repeat(64)}"` }, 'ui_state_changed', 2],
  [{ replayed: true }, 'binding_request_conflict', 2],
  [{ serverError: '/SYNTHETIC_PRIVATE' }, 'local_ui_request_failed', 2],
  [{ serverError: 'binding_scope_revoked' }, 'binding_scope_revoked', 2],
  [{ failAt: 1 }, 'local_ui_unavailable', 1],
  [{ failAt: 2 }, 'ui_action_uncertain', 2],
  [{ invalidJsonAt: 2 }, 'ui_action_uncertain', 2],
  [{ redirectAt: 1 }, 'unsupported_ui_contract', 1],
  [{ redirectAt: 2 }, 'unsupported_ui_contract', 2],
  [{ abortAt: 2 }, 'ui_action_uncertain', 2]
])('sanitizes failures and never blindly retries a mutation', async (scenario, reason, requests) => {
  const result = await invoke({ scenario });
  blocked(result, reason);
  expect([result.connections, result.requests.length]).toEqual([0, requests]);
});
test.each([
  ['native FD', "const { readSync } = await import('node:fs'); readSync(4, Buffer.alloc(1), 0, 1, null);", 1, 0, 1],
  ['process ancestry', 'process.cwd();', 0, 1, 0],
  ['source asset read', "const { readFileSync } = await import('node:fs'); readFileSync(new URL(import.meta.url));", 0, 0, 1]
] as const)('detects %s after an awaited GET in the actual helper', async (_name, statement, nativeCalls, processCalls, unauthorizedCalls) => {
  const root = mkdtempSync(join(tmpdir(), 'claude-window-helper-mutant-'));
  roots.push(root);
  const original = readFileSync(helper);
  const script = join(root, 'connect.mjs');
  const anchor = "const before = taskView(await request('/claude-window-v1'), options);";
  const changed = original.toString().replace(anchor, anchor + '\n' + statement);
  expect(changed).not.toBe(original.toString());
  writeFileSync(script, changed);
  const result = await invoke({ script });
  expect(result.effects).toMatchObject({ nativeCalls, processCalls, unauthorizedCalls, metadataWrites: 0 });
  expect([result.code, result.attempts, result.requests.length]).toEqual([1, 0, 1]);
  expect(readFileSync(helper)).toEqual(original);
});
test('ships identical selected raw helper, recorder and skill bytes', () => {
  for (const path of ['SKILL.md', 'scripts/connect.mjs', 'scripts/claude-session-hook.mjs']) {
    expect(readFileSync(resolve('dist/skills/harness-connect-window-claude', path))).toEqual(
      readFileSync(resolve('skills/harness-connect-window-claude', path))
    );
  }
});
