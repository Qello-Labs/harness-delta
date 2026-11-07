import { bounded, observedProcess } from '../../scripts/tool-update/fixtures.mjs';
import { closeSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';

const helper = resolve('skills/harness-connect-window-codex/scripts/connect.mjs');
const preload = resolve('tests/helpers/codex-window-connect-tripwire.mjs');
const project = 'synthetic-project';
const task = 'synthetic-task';
const receipt = '11111111-1111-4111-8111-111111111111';
const origin = 'http://127.0.0.1:43210';
const csrf = 'a'.repeat(64);
const view = {
  schema_version: 1,
  kind: 'codex_window_task',
  project_id: project,
  task_id: task,
  version: `"${'b'.repeat(64)}"`,
  state: 'active',
  connection_enabled: true,
  reason: null,
  selected_root_id: null
};
const connection = {
  schema_version: 1,
  kind: 'codex_window_connection',
  status: 'connected',
  project_id: project,
  task_id: task,
  session_id: 'synthetic-root',
  automatic_children: false,
  collection_active: true,
  evidence_mode: 'source_only',
  trust: 'compatibility_unverified',
  cost_coverage: 'partial'
};
const ledgerSchema = z.object({
  kind: z.literal('effects'),
  effects: z.object({
    filesystemCalls: z.number(),
    nativeCalls: z.number(),
    processCalls: z.number(),
    metadataWrites: z.number(),
    operations: z.array(z.string())
  }),
  requests: z.array(
    z.object({
      url: z.string(),
      method: z.string(),
      headers: z.record(z.string(), z.string()),
      body: z.string().nullable()
    })
  ),
  attempts: z.number(),
  connections: z.number()
});
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

async function invoke(
  options: {
    readonly scenario?: Readonly<Record<string, unknown>>;
    readonly args?: readonly string[];
    readonly script?: string;
    readonly control?: 'missing' | 'closed' | 'malformed' | 'stale';
  } = {}
) {
  const root = mkdtempSync(join(tmpdir(), 'codex-window-connect-synthetic-'));
  roots.push(root);
  const native = join(root, 'native');
  const metadata = join(root, 'metadata');
  mkdirSync(native);
  mkdirSync(metadata);
  writeFileSync(join(native, 'source.jsonl'), 'SYNTHETIC_NATIVE_SENTINEL');
  if (options.control !== 'missing') {
    writeFileSync(
      join(metadata, 'ordinary-window-control.json'),
      options.control === 'malformed'
        ? '{SYNTHETIC_PRIVATE'
        : JSON.stringify({
            state: options.control === 'closed' ? 'closed' : 'active'
          })
    );
  }
  const before = readdirSync(metadata).map(name => [name, readFileSync(join(metadata, name), 'utf8')]);
  const fd = openSync(join(native, 'source.jsonl'), 'r');
  let stdout = '',
    stderr = '',
    ready = false;
  let ledger: z.infer<typeof ledgerSchema> | undefined;
  const launched = observedProcess(
    process.execPath,
    [
      '--import',
      preload,
      options.script ?? helper,
      ...(options.args ?? ['connect', '--origin', origin, '--project', project, '--task', task, '--receipt', receipt])
    ],
    {
      env: {
        ...process.env,
        CODEX_WINDOW_CONNECT_NATIVE: native,
        CODEX_WINDOW_CONNECT_SCENARIO: JSON.stringify({ origin, project, task, receipt, csrf, view, connection, ...options.scenario }),
        CODEX_THREAD_ID: 'SYNTHETIC_UNTRUSTED_HINT',
        CODEX_HOME: native,
        HARNESS_ORDINARY_WINDOW_CONTROL: join(metadata, 'ordinary-window-control.json')
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
        const parsed = ledgerSchema.safeParse(message);
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
  if (!ready || !ledger) throw new Error('connect_missing_ready_or_effects', { cause: { code, ready, stderr } });
  expect(readdirSync(metadata).map(name => [name, readFileSync(join(metadata, name), 'utf8')])).toEqual(before);
  return { code, stdout, stderr, ...ledger };
}
function zeroEffects(result: Awaited<ReturnType<typeof invoke>>) {
  expect(result.effects).toEqual({
    filesystemCalls: 0,
    nativeCalls: 0,
    processCalls: 0,
    metadataWrites: 0,
    operations: []
  });
  expect(result.stderr).toBe('');
}
function blocked(result: Awaited<ReturnType<typeof invoke>>, reason: string) {
  zeroEffects(result);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout)).toEqual({
    status: 'blocked',
    reason_code: reason,
    verified: false
  });
}
const selectedView = (patch: Readonly<Record<string, unknown>> = {}) => ({
  csrf,
  task: { ...view, ...patch }
});

test.each(['missing', 'closed', 'malformed', 'stale'] as const)(
  'explicit receipt connects only the selected root without native or metadata effects under %s control',
  async control => {
    const result = await invoke({ control });
    zeroEffects(result);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(connection);
    expect(result.connections).toBe(1);
    expect(result.requests.map(request => [request.method, new URL(request.url).pathname])).toEqual([
      ['GET', `/api/tasks/${task}/codex-window-v1`],
      ['POST', `/api/tasks/${task}/codex-window-connect-v1`],
      ['GET', `/api/tasks/${task}/codex-window-v1`]
    ]);
  }
);
test('inspect projects only the explicit selected task and never attempts a connection', async () => {
  const result = await invoke({
    args: ['inspect', '--origin', origin, '--project', project, '--task', task]
  });
  zeroEffects(result);
  expect(JSON.parse(result.stdout)).toEqual({
    status: 'ready',
    project_id: project,
    task_id: task,
    automatic_children: false,
    reason_code: null
  });
  expect(result.requests).toHaveLength(1);
  expect(result.attempts).toBe(0);
});
test.each([
  ['missing receipt', ['connect', '--origin', origin, '--project', project, '--task', task], 'invalid_input'],
  [
    'unknown option',
    ['connect', '--origin', origin, '--project', project, '--task', task, '--receipt', receipt, '--source', '/SYNTHETIC_PRIVATE'],
    'invalid_input'
  ],
  [
    'unsupported product',
    ['connect', '--origin', origin, '--project', project, '--task', task, '--receipt', receipt, '--product', 'claude_code'],
    'invalid_input'
  ],
  ['nonloopback origin', ['connect', '--origin', 'http://example.invalid:42', '--project', project, '--task', task, '--receipt', receipt], 'invalid_origin'],
  ['origin credentials', ['connect', '--origin', 'http://user@127.0.0.1:42', '--project', project, '--task', task, '--receipt', receipt], 'invalid_origin'],
  ['malformed receipt', ['connect', '--origin', origin, '--project', project, '--task', task, '--receipt', '/SYNTHETIC_PRIVATE'], 'invalid_input']
])('rejects %s before transport effects', async (_name, args, reason) => {
  const result = await invoke({ args });
  blocked(result, reason);
  expect(result.requests).toEqual([]);
});
test.each([
  [{ state: 'paused' }, 'task_closed'],
  [
    {
      connection_enabled: false,
      reason: 'binding_window_activation_required'
    },
    'binding_window_activation_required'
  ],
  [{ reason: '/SYNTHETIC_PRIVATE', connection_enabled: false }, 'unsupported_ui_contract'],
  [{ reason: 'binding_window_activation_required' }, 'unsupported_ui_contract'],
  [{ project_id: 'another-project' }, 'unsupported_ui_contract'],
  [{ task_id: 'another-task' }, 'unsupported_ui_contract'],
  [{ version: 'unquoted' }, 'unsupported_ui_contract'],
  [{ connection_enabled: 'true' }, 'unsupported_ui_contract'],
  [{ selected_root_id: '/SYNTHETIC_PRIVATE' }, 'unsupported_ui_contract'],
  [{ state: 'unknown' }, 'unsupported_ui_contract']
])('rejects invalid or disabled task view %j before POST', async (patch, reason) => {
  const result = await invoke({
    scenario: { views: [selectedView(patch)] }
  });
  blocked(result, reason);
  expect(result.attempts).toBe(0);
});
test.each([
  null,
  {},
  { csrf: 'bad', task: view },
  { csrf, task: null },
  {
    csrf,
    task: { ...view, schema_version: 2 }
  }
])('rejects malformed selected view %j without connecting', async value => {
  const result = await invoke({ scenario: { views: [value] } });
  blocked(result, 'unsupported_ui_contract');
  expect(result.attempts).toBe(0);
});
test.each([
  { session_id: '/SYNTHETIC_PRIVATE' },
  { project_id: 'other' },
  { task_id: 'other' },
  { schema_version: 2 },
  { status: 'already_connected' },
  { automatic_children: true },
  { collection_active: false },
  { evidence_mode: 'attested' },
  { trust: 'verified' },
  { cost_coverage: 'complete' },
  { path: '/SYNTHETIC_PRIVATE' }
])('rejects a stale or stronger-than-source-only connection response %j', async patch => {
  const result = await invoke({
    scenario: { response: { ...connection, ...patch } }
  });
  blocked(result, 'connection_unverified');
  expect(result.attempts).toBe(1);
  expect(result.requests).toHaveLength(2);
});
test.each([
  [{ selected_root_id: 'different-root' }, 'connection_unverified'],
  [{ selected_root_id: null }, 'connection_unverified'],
  [{ state: 'paused', selected_root_id: connection.session_id }, 'task_closed'],
  [
    {
      connection_enabled: false,
      reason: 'binding_scope_revoked',
      selected_root_id: connection.session_id
    },
    'binding_scope_revoked'
  ],
  [{ project_id: 'other', selected_root_id: connection.session_id }, 'unsupported_ui_contract']
])('rechecks live linkage after POST rather than trusting response %j', async (patch, reason) => {
  const result = await invoke({
    scenario: { views: [selectedView(), selectedView(patch)] }
  });
  blocked(result, reason);
  expect(result.attempts).toBe(1);
  expect(result.requests).toHaveLength(3);
});
test.each<{ readonly scenario: Readonly<Record<string, unknown>>; readonly reason: string; readonly connections: number; readonly requests: number }>([
  { scenario: { serverVersion: `"${'c'.repeat(64)}"` }, reason: 'ui_state_changed', connections: 0, requests: 2 },
  { scenario: { serverError: '/SYNTHETIC_PRIVATE' }, reason: 'local_ui_request_failed', connections: 0, requests: 2 },
  { scenario: { serverError: { reason: '/SYNTHETIC_PRIVATE' } }, reason: 'local_ui_request_failed', connections: 0, requests: 2 },
  { scenario: { serverError: 'binding_scope_revoked' }, reason: 'binding_scope_revoked', connections: 0, requests: 2 },
  { scenario: { failAt: 1 }, reason: 'local_ui_unavailable', connections: 0, requests: 1 },
  { scenario: { failAt: 2 }, reason: 'ui_action_uncertain', connections: 0, requests: 2 },
  { scenario: { invalidJsonAt: 2 }, reason: 'ui_action_uncertain', connections: 0, requests: 2 },
  { scenario: { redirectAt: 1 }, reason: 'unsupported_ui_contract', connections: 0, requests: 1 }
])('sanitizes transport failure $scenario without a blind retry', async entry => {
  const result = await invoke({ scenario: entry.scenario });
  blocked(result, entry.reason);
  expect(result.connections).toBe(entry.connections);
  expect(result.requests).toHaveLength(entry.requests);
});
test.each([
  {
    name: 'inherited FD',
    importLine: "import { readSync } from 'node:fs';",
    statement: 'readSync(4, Buffer.alloc(1), 0, 1, null);',
    filesystemCalls: 1,
    nativeCalls: 1,
    processCalls: 0,
    operation: 'readSync'
  },
  {
    name: 'native path',
    importLine: "import { statSync } from 'node:fs';",
    statement: 'statSync(process.env.CODEX_WINDOW_CONNECT_NATIVE);',
    filesystemCalls: 1,
    nativeCalls: 1,
    processCalls: 0,
    operation: 'statSync'
  },
  {
    name: 'process ancestry',
    importLine: "import { execSync } from 'node:child_process';",
    statement: "execSync('ps');",
    filesystemCalls: 0,
    nativeCalls: 0,
    processCalls: 1,
    operation: 'child_process.execSync'
  },
  {
    name: 'low-level process spawn',
    importLine: "import { ChildProcess } from 'node:child_process';",
    statement: "new ChildProcess().spawn({file:'ps',args:['ps']});",
    filesystemCalls: 0,
    nativeCalls: 0,
    processCalls: 1,
    operation: 'child_process.ChildProcess.spawn'
  },
  { name: 'cwd lookup', importLine: '', statement: 'process.cwd();', filesystemCalls: 0, nativeCalls: 0, processCalls: 1, operation: 'process.cwd' }
])('calibrates $name detection against a disposable mutated helper', async calibration => {
  const original = readFileSync(helper);
  const root = mkdtempSync(join(tmpdir(), 'codex-window-connect-mutant-'));
  roots.push(root);
  const script = join(root, 'connect.mjs');
  const changed = original
    .toString()
    .replace('const origin = localOrigin(options.origin);', `${calibration.statement}\nconst origin = localOrigin(options.origin);`);
  expect(changed).not.toBe(original.toString());
  const mutation = Buffer.from(`${calibration.importLine}\n${changed}`);
  writeFileSync(script, mutation);
  const result = await invoke({ script });
  expect(result.code).toBe(1);
  expect(result.effects).toMatchObject({
    filesystemCalls: calibration.filesystemCalls,
    nativeCalls: calibration.nativeCalls,
    processCalls: calibration.processCalls,
    operations: [calibration.operation]
  });
  expect(result.requests).toEqual([]);
  expect(readFileSync(helper)).toEqual(original);
});
