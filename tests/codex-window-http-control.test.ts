import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import * as filesystem from 'node:fs';
import * as processes from 'node:child_process';
import { open as openAsync } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { Deletion } from '../src/deletion.js';
import { codexBindingAdmissions, isQualifiedCodexBindingAdmission } from '../src/codex-binding-admission.js';
import { CodexWindowSessionBindingProvider } from '../src/session-binding-codex.js';
import { ordinaryWindowRuntimeRevision, ordinaryWindowSelection, revokeOrdinaryWindowActivation } from '../src/core/ordinary-window-store.js';
import { localWebCodexWindowFixture } from './helpers/local-web-codex-window-fixture.js';

vi.mock('node:fs', { spy: true });
vi.mock('node:fs/promises', { spy: true });
vi.mock('node:child_process', { spy: true });
vi.mock('../src/session-binding-codex.js', { spy: true });
const fixtures: Awaited<ReturnType<typeof localWebCodexWindowFixture>>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) await f.close();
  vi.useRealTimers();
});
async function fixture() {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-07T03:00:00.000Z'));
  const f = await localWebCodexWindowFixture();
  fixtures.push(f);
  return f;
}
function insertWrongDecision(f: Awaited<ReturnType<typeof fixture>>, mismatch: string) {
  const selection = ordinaryWindowSelection(f.store, f.taskId);
  if (!selection) throw new Error('fixture_selection_missing');
  if (mismatch === 'wrong_project') f.store.execute('INSERT INTO projects(id,local_root) VALUES (?,?)', ['other-project', join(f.directory, 'other-project')]);
  f.store.execute(
    `INSERT INTO ordinary_window_activations(project_id,product,source,policy_id,policy_revision,policy_digest,evidence_mode,
      accepted_risks,implementation_revision,evidence_ref,review_ref,decided_at,decision_ref,decision_kind)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      mismatch === 'wrong_project' ? 'other-project' : 'project',
      mismatch === 'wrong_product' ? 'claude_code' : 'codex',
      selection.policy.source,
      mismatch === 'wrong_policy' ? 'other-policy' : selection.policy.policyId,
      mismatch === 'wrong_revision' ? 'other-revision' : selection.policy.ruleRevision,
      mismatch === 'wrong_digest' ? 'a'.repeat(64) : selection.policyDigest,
      mismatch === 'wrong_mode' ? 'publisher_verified_local_pin' : selection.policy.evidenceMode,
      JSON.stringify(['source_identity_limits', 'root_ownership_unverified']),
      mismatch === 'stale_implementation' ? 'other-runtime' : ordinaryWindowRuntimeRevision,
      'synthetic-evidence',
      'synthetic-review',
      new Date().toISOString(),
      'synthetic-decision',
      'product'
    ]
  );
}

test.each([
  'absent',
  'revoked',
  'wrong_project',
  'wrong_product',
  'wrong_policy',
  'wrong_revision',
  'wrong_digest',
  'wrong_mode',
  'stale_implementation',
  'inactive_task'
])('refuses versioned connect with %s authority before any receipt, filesystem, process or provider operation', async authority => {
  const f = await fixture();
  if (authority === 'revoked' || authority === 'inactive_task') {
    f.activate();
  } else if (authority !== 'absent') insertWrongDecision(f, authority);
  if (authority !== 'inactive_task') f.life.start(f.taskId);
  if (authority === 'revoked') {
    revokeOrdinaryWindowActivation(f.store, f.taskId, new Date().toISOString());
  }
  vi.clearAllMocks();
  const response = await f.connect();
  expect(response.statusCode, response.body).toBe(400);
  expect(response.json()).toEqual({
    error: authority === 'inactive_task' ? 'binding_scope_revoked' : 'binding_window_activation_required'
  });
  for (const operation of [
    filesystem.realpathSync,
    filesystem.lstatSync,
    filesystem.statSync,
    filesystem.openSync,
    filesystem.readFileSync,
    filesystem.readdirSync,
    filesystem.readlinkSync,
    filesystem.readSync,
    openAsync,
    processes.spawn,
    processes.spawnSync,
    processes.exec,
    processes.execSync,
    processes.execFile,
    processes.execFileSync
  ]) {
    expect(operation).not.toHaveBeenCalled();
  }
  expect(CodexWindowSessionBindingProvider).not.toHaveBeenCalled();
  expect(f.store.all('SELECT * FROM sessions')).toEqual([]);
  expect(f.store.all('SELECT * FROM session_source_compatibility')).toEqual([]);
  expect(f.store.eventCount()).toBe(0);
});

test('prepares a disabled declaration over HTTP while the legacy task path stays closed', async () => {
  const f = await fixture();
  const response = await f.post('/api/projects/project/codex-window-prepare-v1', { name: 'Second window', criterion_ids: ['accepted'] });
  expect(response.statusCode, response.body).toBe(200);
  const prepared = response.json<{ task_id: string; version: string }>();
  expect(response.json()).toMatchObject({
    schema_version: 1,
    kind: 'codex_window_task',
    state: 'registered',
    connection_enabled: false,
    reason: 'binding_scope_revoked',
    selected_root_id: null
  });
  expect(prepared.version).toMatch(/^"[a-f0-9]{64}"$/);
  expect((await f.get(`/api/tasks/${prepared.task_id}`)).statusCode).toBe(400);
  expect(() => f.domain.task(prepared.task_id)).toThrow('binding_scope_revoked');
  expect(filesystem.existsSync(f.receiptDirectory)).toBe(false);
  expect(f.store.all('SELECT * FROM ordinary_window_activations')).toEqual([]);
});

test('connects only an explicitly active task through the live coordinator and reads back the selected root', async () => {
  const f = await fixture();
  f.activate();
  expect((await f.action('start')).statusCode).toBe(200);
  f.seedReceipt();
  const key = randomUUID();
  const before = await f.view();
  z.strictObject({
    schema_version: z.literal(1),
    kind: z.literal('codex_window_task'),
    project_id: z.literal('project'),
    task_id: z.literal(f.taskId),
    version: z.string().regex(/^"[a-f0-9]{64}"$/),
    state: z.literal('active'),
    connection_enabled: z.literal(true),
    reason: z.null(),
    selected_root_id: z.null()
  }).parse(before.task);
  const response = await f.connect(key, before.task.version);
  expect(response.statusCode, response.body).toBe(200);
  const connection = response.json<{ session_id: string }>();
  expect(response.json()).toEqual({
    schema_version: 1,
    kind: 'codex_window_connection',
    status: 'connected',
    project_id: 'project',
    task_id: f.taskId,
    session_id: connection.session_id,
    automatic_children: false,
    collection_active: true,
    evidence_mode: 'source_only',
    trust: 'compatibility_unverified',
    cost_coverage: 'partial'
  });
  expect((await f.view()).task).toMatchObject({
    state: 'active',
    connection_enabled: true,
    reason: null,
    selected_root_id: connection.session_id
  });
  expect(f.store.all('SELECT * FROM ordinary_window_segments')).toHaveLength(1);
  const opens = vi.mocked(openAsync).mock.calls.length;
  expect((await f.connect(key, before.task.version)).json()).toEqual(response.json());
  expect(vi.mocked(openAsync).mock.calls).toHaveLength(opens);
  revokeOrdinaryWindowActivation(f.store, f.taskId, new Date().toISOString());
  expect((await f.connect(key, before.task.version)).statusCode).toBe(400);
  expect(vi.mocked(openAsync).mock.calls).toHaveLength(opens);
  expect((await f.get(`/api/tasks/${f.taskId}`)).statusCode).toBe(400);
});

test('uses frozen preparation roots rather than later project preferences on successful connection', async () => {
  const f = await fixture();
  if (!f.domain.codexProjectAction) throw new Error('fixture_setup_missing');
  await f.domain.codexProjectAction('project', {
    operation: 'configure',
    product_version: '0.168.0',
    source_roots: [join(f.directory, 'unavailable-replacement')]
  });
  f.activate();
  f.life.start(f.taskId);
  f.seedReceipt();
  const response = await f.connect();
  expect(response.statusCode, response.body).toBe(200);
  expect(ordinaryWindowSelection(f.store, f.taskId)?.declaredVersion).toBe('0.167.0');
  expect(f.store.all('SELECT product_version FROM sessions')).toEqual([
    {
      product_version: '0.167.0'
    }
  ]);
});

test.each(['lifecycle', 'window_action'] as const)('does not replay or project an old root after %s pause and resume', async route => {
  const f = await fixture();
  f.activate();
  f.life.start(f.taskId);
  f.seedReceipt();
  const key = randomUUID();
  const version = (await f.view()).task.version;
  const connected = await f.connect(key, version);
  expect(connected.statusCode, connected.body).toBe(200);
  if (route === 'lifecycle') {
    f.life.pause(f.taskId);
    f.life.resume(f.taskId);
  } else {
    expect((await f.action('pause')).statusCode).toBe(200);
    expect((await f.action('resume')).statusCode).toBe(200);
  }
  vi.clearAllMocks();
  expect((await f.view()).task).toMatchObject({
    state: 'active',
    connection_enabled: true,
    reason: null,
    selected_root_id: null
  });
  expect((await f.connect(key, version)).json()).toEqual({ error: 'binding_scope_revoked' });
  expect(CodexWindowSessionBindingProvider).not.toHaveBeenCalled();
  expect(openAsync).not.toHaveBeenCalled();
  expect(f.store.eventCount()).toBe(0);
});

test.each(['csrf', 'stale_revision', 'wrong_project', 'flags', 'source_hint'])('rejects %s without constructing a provider', async kind => {
  const f = await fixture();
  f.activate();
  f.life.start(f.taskId);
  const view = await f.view();
  const url = `/api/tasks/${f.taskId}/codex-window-connect-v1`;
  const body = {
    project_id: kind === 'wrong_project' ? 'other-project' : 'project',
    product: 'codex',
    receipt: f.receipt,
    ...(kind === 'flags' ? { activated: true, qualified: true } : {}),
    ...(kind === 'source_hint' ? { source_roots: [f.sourceRoot] } : {})
  };
  vi.clearAllMocks();
  const response =
    kind === 'csrf'
      ? await f.app.inject({
          method: 'POST',
          url,
          payload: body,
          headers: { host: '127.0.0.1:4327', origin: f.origin }
        })
      : await f.post(url, body, kind === 'stale_revision' ? `"${'0'.repeat(64)}"` : view.task.version);
  expect(response.statusCode).toBe(kind === 'csrf' ? 403 : kind === 'stale_revision' ? 409 : 400);
  expect(CodexWindowSessionBindingProvider).not.toHaveBeenCalled();
  expect(openAsync).not.toHaveBeenCalled();
  expect(f.store.all('SELECT * FROM sessions')).toEqual([]);
});

test.each(['delete_task', 'delete_project', 'revoke', 'pause'] as const)(
  'discards a source open after %s during await without reading or returning a connection',
  async kind => {
    const f = await fixture();
    f.activate();
    f.life.start(f.taskId);
    f.seedReceipt();
    const native = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const gates = new EventEmitter();
    const entered = once(gates, 'entered', {
      signal: AbortSignal.timeout(5000)
    });
    const release = once(gates, 'release', {
      signal: AbortSignal.timeout(5000)
    });
    const reads = vi.fn();
    vi.mocked(openAsync).mockImplementationOnce(async (...args) => {
      const fd = await native.open(...args);
      vi.spyOn(fd, 'read').mockImplementation(() => {
        reads();
        throw new Error('unauthorized_native_read');
      });
      gates.emit('entered');
      await release;
      return fd;
    });
    const connecting = f.connect();
    try {
      await Promise.race([
        entered,
        connecting.then(() => {
          throw new Error('fixture_source_open_not_reached');
        })
      ]);
      if (kind === 'delete_task') {
        new Deletion(f.store).deleteTask(f.taskId);
      } else if (kind === 'delete_project') {
        new Deletion(f.store).deleteProject('project');
      } else if (kind === 'revoke') {
        revokeOrdinaryWindowActivation(f.store, f.taskId, new Date().toISOString());
      } else f.life.pause(f.taskId);
    } finally {
      gates.emit('release');
    }
    expect((await connecting).statusCode).toBe(400);
    expect(reads).not.toHaveBeenCalled();
    expect(f.store.all('SELECT * FROM ordinary_window_segments')).toHaveLength(kind === 'delete_task' || kind === 'delete_project' ? 0 : 1);
    expect(f.store.all('SELECT * FROM session_source_compatibility')).toEqual([]);
    expect(f.store.eventCount()).toBe(0);
  }
);

test('does not replay a deleted prepared declaration', async () => {
  const f = await fixture();
  const key = randomUUID();
  const url = '/api/projects/project/codex-window-prepare-v1';
  const body = { name: 'Disposable', criterion_ids: ['accepted'] };
  const created = await f.post(url, body, undefined, key);
  expect(created.statusCode, created.body).toBe(200);
  new Deletion(f.store).deleteTask(created.json<{ task_id: string }>().task_id);
  expect((await f.post(url, body, undefined, key)).json()).toEqual({
    error: 'deleted_identifier'
  });
});

test('saves an omitted-mode configure body as the existing window mode without touching native roots', async () => {
  const f = await fixture();
  const missingRoot = join(f.directory, 'missing-native');
  vi.clearAllMocks();
  const response = await f.post('/api/projects/project/codex-setup', { operation: 'configure', source_roots: [missingRoot] });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json()).toMatchObject({
    schema_version: 2,
    mode: 'ordinary_window',
    product: 'codex',
    product_version: '0.167.0',
    source_roots: [missingRoot],
    available_versions: codexBindingAdmissions.map(admission => admission.productVersion),
    unqualified_versions: codexBindingAdmissions
      .filter(admission => !isQualifiedCodexBindingAdmission(admission.productVersion))
      .map(admission => admission.productVersion),
    window: {
      policy_id: 'codex-binding-root-window-v1',
      policy_revision: 'codex-ordinary-root-window-v1',
      evidence_mode: 'source_only',
      collection_enabled: false,
      reason: 'binding_window_activation_required'
    }
  });
  for (const operation of [
    filesystem.realpathSync,
    filesystem.lstatSync,
    filesystem.statSync,
    filesystem.openSync,
    filesystem.readFileSync,
    filesystem.readdirSync,
    filesystem.readlinkSync,
    openAsync
  ]) {
    const nativeCalls = vi
      .mocked(operation)
      .mock.calls.filter(args => typeof args[0] === 'string' && (args[0].startsWith(missingRoot) || args[0].startsWith(f.sourceRoot)));
    expect(nativeCalls).toEqual([]);
  }
  for (const operation of [filesystem.openSync, filesystem.readFileSync, filesystem.readdirSync, openAsync]) {
    expect(vi.mocked(operation).mock.calls.filter(args => typeof args[0] === 'string' && args[0].startsWith(f.receiptDirectory))).toEqual([]);
  }
  expect(CodexWindowSessionBindingProvider).not.toHaveBeenCalled();
  expect(f.store.all('SELECT * FROM ordinary_window_activations')).toEqual([]);
});

test('collects a subsequent synthetic root response only through the versioned collection action', async () => {
  const f = await fixture();
  f.activate();
  f.life.start(f.taskId);
  f.seedReceipt();
  const connected = await f.connect();
  expect(connected.statusCode, connected.body).toBe(200);
  vi.setSystemTime(new Date('2026-11-07T03:00:01.000Z'));
  const timestamp = new Date().toISOString();
  filesystem.appendFileSync(
    f.sourcePath,
    [
      { type: 'turn_context', timestamp, payload: { cwd: f.projectRoot, turn_id: 'turn', root_turn_id: 'turn', model: 'gpt-6.1-sol', effort: 'high' } },
      {
        type: 'token_usage_record',
        timestamp,
        payload: {
          thread_id: 'synthetic-root',
          session_id: 'synthetic-root',
          turn_id: 'turn',
          root_turn_id: 'turn',
          response_id: 'response',
          usage: {
            input_tokens: 100,
            cached_input_tokens: 10,
            output_tokens: 20,
            reasoning_output_tokens: 5,
            total_tokens: 120
          }
        }
      }
    ]
      .map(row => JSON.stringify(row))
      .join('\n') + '\n'
  );
  const collected = await f.action('collect');
  expect(collected.statusCode, collected.body).toBe(200);
  expect(f.store.eventCount()).toBe(1);
  expect(f.store.all('SELECT * FROM session_bindings')).toHaveLength(1);
  expect((await f.action('pause')).statusCode).toBe(200);
  const inactive = await f.action('collect');
  expect(inactive.statusCode).toBe(400);
  expect(f.store.eventCount()).toBe(1);
});

test('never replays a successful connection after its task is deleted', async () => {
  const f = await fixture();
  f.activate();
  f.life.start(f.taskId);
  f.seedReceipt();
  const key = randomUUID();
  const version = (await f.view()).task.version;
  const connected = await f.connect(key, version);
  expect(connected.statusCode, connected.body).toBe(200);
  new Deletion(f.store).deleteTask(f.taskId);
  vi.clearAllMocks();
  const replay = await f.connect(key, version);
  expect(replay.json()).toEqual({ error: 'deleted_identifier' });
  expect(CodexWindowSessionBindingProvider).not.toHaveBeenCalled();
  expect(openAsync).not.toHaveBeenCalled();
});

test('blocks setup changes while a window root reservation is awaiting its source proof', async () => {
  const f = await fixture();
  f.activate();
  f.life.start(f.taskId);
  f.seedReceipt();
  const configure = f.domain.codexProjectAction;
  if (!configure) throw new Error('fixture_setup_missing');
  const gates = new EventEmitter();
  const entered = once(gates, 'entered', { signal: AbortSignal.timeout(5000) });
  const release = once(gates, 'release', { signal: AbortSignal.timeout(5000) });
  vi.spyOn(CodexWindowSessionBindingProvider.prototype, 'inspectWindowCurrent').mockImplementationOnce(async () => {
    gates.emit('entered');
    await release;
    throw new Error('synthetic_interrupted');
  });
  const connecting = f.connect();
  try {
    await Promise.race([
      entered,
      connecting.then(() => {
        throw new Error('fixture_source_proof_not_reached');
      })
    ]);
    expect(() => configure('project', { operation: 'configure', source_roots: [join(f.directory, 'replacement')] })).toThrow('codex_connect_in_use');
  } finally {
    gates.emit('release');
  }
  expect((await connecting).statusCode).toBe(400);
});
