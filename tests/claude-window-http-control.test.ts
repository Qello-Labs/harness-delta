import { randomUUID } from 'node:crypto';
import * as filesystem from 'node:fs';
import * as filesystemAsync from 'node:fs/promises';
import * as processes from 'node:child_process';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, test, vi } from 'vitest';
import { Deletion } from '../src/deletion.js';
import { ordinaryWindowSelectionHash, revokeOrdinaryWindowActivation } from '../src/core/ordinary-window-store.js';
import { resolveOrdinaryWindow } from '../src/core/ordinary-window-policy.js';
import * as binding from '../src/ordinary-session-binding.js';
import { createLocalWebDomain } from '../src/web/local-web-domain.js';
import { createLocalWebServer } from '../src/web/local-web-server.js';
import type { ClaudeWindowTaskDto } from '../src/web/local-web-claude-window-control.js';
import { createClaudeWindowFixture } from './helpers/claude-window-fixture.js';

vi.mock('node:fs', { spy: true });
vi.mock('node:fs/promises', { spy: true });
vi.mock('../src/ordinary-session-binding.js', { spy: true });
vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>();
  const forbidden = () => {
    throw new Error('fixture_process_forbidden');
  };
  return {
    ...original,
    spawn: vi.fn(forbidden),
    spawnSync: vi.fn(forbidden),
    exec: vi.fn(forbidden),
    execSync: vi.fn(forbidden),
    execFile: vi.fn(forbidden),
    execFileSync: vi.fn(forbidden)
  };
});

const fixtures: {
  app: ReturnType<typeof createLocalWebServer>;
  metadata: Database.Database;
  cleanup(): void;
}[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) {
    await f.app.close();
    f.metadata.close();
    f.cleanup();
  }
  vi.useRealTimers();
});

async function fixture() {
  const f = createClaudeWindowFixture();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(f.clock()));
  const metadataFile = join(f.directory, 'metadata.sqlite');
  const domain = createLocalWebDomain({
    store: f.store,
    metadataFile,
    claudeWindowBinaryAdapters: f.binary.adapters
  });
  const metadata = new Database(metadataFile);
  const setup = {
    schema_version: 1,
    kind: 'claude_window_setup',
    selection_hash: ordinaryWindowSelectionHash(f.selection),
    configuration: {
      product_version: f.selection.declaredVersion,
      project_root: f.projectRoot,
      receipt_directory: f.receiptDirectory,
      claude_projects_directory: f.claudeProjectsDirectory
    }
  };
  metadata
    .prepare('INSERT INTO web_tasks(id,name,profile_id,setup,project_id) VALUES (?,?,?,?,?)')
    .run(f.taskId, 'Synthetic Claude window', 'ordinary-claude-window-v1', JSON.stringify(setup), 'project');
  const origin = 'http://127.0.0.1:4327';
  const app = createLocalWebServer({
    domain,
    origin,
    metadataFile: join(f.directory, 'transport.sqlite')
  });
  const path = `/api/tasks/${f.taskId}/claude-window`;
  const get = (url = `${path}-v1`) => app.inject({ url, headers: { host: '127.0.0.1:4327' } });
  await app.ready();
  const csrf = (await get()).json<{ csrf: string }>().csrf;
  const view = async () => (await get()).json<{ csrf: string; task: ClaudeWindowTaskDto }>();
  const post = (operation: 'connect' | 'action', body: unknown, version: string, key: string = randomUUID(), token = csrf) =>
    app.inject({
      method: 'POST',
      url: `${path}-${operation}-v1`,
      payload: JSON.stringify(body),
      headers: {
        host: '127.0.0.1:4327',
        origin,
        'content-type': 'application/json',
        'x-harness-csrf': token,
        'idempotency-key': key,
        'if-match': version
      }
    });
  const body = {
    project_id: 'project',
    product: 'claude_code',
    receipt: f.receipt.receipt
  };
  const connect = async (key = randomUUID(), version?: string) => post('connect', body, version ?? (await view()).task.version, key);
  const action = async (operation: 'start' | 'resume' | 'pause' | 'revoke-collection' | 'collect') =>
    post('action', { project_id: 'project', operation }, (await view()).task.version);
  const result = {
    ...f,
    app,
    domain,
    metadata,
    setup,
    get,
    view,
    post,
    body,
    connect,
    action
  };
  fixtures.push(result);
  return result;
}

function expectNoNativeOperations(f: Awaited<ReturnType<typeof fixture>>) {
  expect(f.binary.operations).toEqual([]);
  for (const operation of [
    filesystem.realpathSync,
    filesystem.lstatSync,
    filesystem.statSync,
    filesystem.openSync,
    filesystem.readFileSync,
    filesystem.readdirSync,
    filesystem.readlinkSync,
    filesystem.readSync,
    filesystemAsync.open,
    filesystemAsync.readFile,
    filesystemAsync.readdir,
    processes.spawn,
    processes.spawnSync,
    processes.exec,
    processes.execSync,
    processes.execFile,
    processes.execFileSync
  ]) {
    expect(operation).not.toHaveBeenCalled();
  }
}

function assign(f: Awaited<ReturnType<typeof fixture>>) {
  f.store.execute('INSERT INTO comparison_variants(id,configuration) VALUES (?,?)', ['variant', '{}']);
  f.store.execute('INSERT INTO comparison_protocols(id,project_id,settings) VALUES (?,?,?)', ['protocol', 'project', '{}']);
  f.store.execute(
    `INSERT INTO comparison_assignments(id,task_id,project_id,protocol_id,variant_id,assigned_at,recorded_at,
      followup_ends_at,stratum_id,block_id,allocation_index,allocator_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ['assignment', f.taskId, 'project', 'protocol', 'variant', f.clock(), f.clock(), f.clock(), 'stratum', 'block', 0, 'allocator']
  );
}

test.each([
  ['absent', 'binding_window_activation_required'],
  ['revoked', 'binding_window_activation_required'],
  ['inactive', 'binding_scope_revoked'],
  ['paused', 'binding_scope_revoked'],
  ['assigned', 'binding_ordinary_assignment_conflict'],
  ['missing_setup', 'ordinary_preparation_required'],
  ['missing_selection', 'binding_scope_mismatch'],
  ['wrong_profile', 'ordinary_preparation_required'],
  ['wrong_hash', 'ordinary_configuration_changed'],
  ['wrong_version', 'ordinary_configuration_changed'],
  ['wrong_root', 'ordinary_configuration_changed'],
  ['malformed_setup', 'local_operation_failed']
])('denies %s before receipt, native or usage operations', async (kind, error) => {
  const f = await fixture();
  if (kind !== 'absent') f.activate();
  if (kind !== 'inactive') f.life.start(f.taskId);
  if (kind === 'revoked') {
    revokeOrdinaryWindowActivation(f.store, f.taskId, f.clock());
  }
  if (kind === 'paused') f.life.pause(f.taskId);
  if (kind === 'assigned') assign(f);
  const version = (await f.view()).task.version;
  if (kind === 'missing_setup') {
    f.metadata.prepare('DELETE FROM web_tasks WHERE id=?').run(f.taskId);
  }
  if (kind === 'missing_selection') {
    f.store.execute('DELETE FROM ordinary_window_selections WHERE task_id=?', [f.taskId]);
  }
  if (kind === 'wrong_profile') {
    f.metadata.prepare('UPDATE web_tasks SET profile_id=? WHERE id=?').run('legacy-claude', f.taskId);
  }
  if (kind === 'wrong_hash') f.setup.selection_hash = '0'.repeat(64);
  if (kind === 'wrong_version') {
    f.setup.configuration.product_version = '2.1.306';
  }
  if (kind === 'wrong_root') {
    f.setup.configuration.project_root = join(f.directory, 'other-project');
  }
  if (['wrong_hash', 'wrong_version', 'wrong_root'].includes(kind)) {
    f.metadata.prepare('UPDATE web_tasks SET setup=? WHERE id=?').run(JSON.stringify(f.setup), f.taskId);
  }
  if (kind === 'malformed_setup') {
    f.metadata.prepare('UPDATE web_tasks SET setup=? WHERE id=?').run('{}', f.taskId);
  }
  const before = f.usageState();
  vi.clearAllMocks();
  const response = await f.post('connect', f.body, version);
  expect(response.statusCode, response.body).toBe(400);
  expect(response.json()).toEqual({ error });
  expectNoNativeOperations(f);
  expect(f.usageState()).toEqual(before);
  expect(f.store.all('SELECT * FROM sessions')).toEqual([]);
  expect(f.life.state(f.taskId)).toBe(kind === 'inactive' ? 'registered' : kind === 'paused' ? 'paused' : 'active');
});

test.each(['wrong_product', 'wrong_project', 'stale_implementation'] as const)(
  'rejects %s activation rather than treating any decision as authority',
  async kind => {
    const f = await fixture();
    f.life.start(f.taskId);
    f.activate();
    const row = f.store.get<Record<string, string | number | null>>('SELECT * FROM ordinary_window_activations');
    if (!row) throw new Error('fixture_activation_missing');
    if (kind === 'wrong_product') row.product = 'codex';
    if (kind === 'wrong_project') {
      f.store.execute('INSERT INTO projects(id,local_root) VALUES (?,?)', ['other-project', join(f.directory, 'other-project')]);
      row.project_id = 'other-project';
    }
    if (kind === 'stale_implementation') {
      row.implementation_revision = 'synthetic-stale-runtime';
    }
    f.store.execute('DELETE FROM ordinary_window_activations', []);
    const columns = Object.keys(row);
    f.store.execute(`INSERT INTO ordinary_window_activations(${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`, Object.values(row));
    const before = f.usageState();
    vi.clearAllMocks();
    const response = await f.connect();
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json()).toEqual({
      error: 'binding_window_activation_required'
    });
    expectNoNativeOperations(f);
    expect(f.usageState()).toEqual(before);
  }
);

test.each(['csrf', 'stale_version', 'wrong_project', 'flags', 'source_hint', 'request_uuid'] as const)(
  'rejects forged or stale %s transport input without native operations',
  async kind => {
    const f = await fixture();
    f.activate();
    f.life.start(f.taskId);
    const version = (await f.view()).task.version;
    const body = {
      ...f.body,
      ...(kind === 'wrong_project' ? { project_id: 'other-project' } : {}),
      ...(kind === 'flags' ? { activated: true, qualified: true, binaryAdapters: {} } : {}),
      ...(kind === 'source_hint' ? { claude_projects_directory: f.claudeProjectsDirectory } : {})
    };
    const before = f.usageState();
    vi.clearAllMocks();
    const response = await f.post(
      'connect',
      body,
      kind === 'stale_version' ? '"stale"' : version,
      kind === 'request_uuid' ? 'invalid' : randomUUID(),
      kind === 'csrf' ? 'forged' : (await f.view()).csrf
    );
    expect(response.statusCode, response.body).toBe(kind === 'csrf' ? 403 : kind === 'stale_version' ? 409 : 400);
    expectNoNativeOperations(f);
    expect(f.usageState()).toEqual(before);
  }
);

test('does not accept a Codex prepared selection through Claude routes', async () => {
  const f = await fixture();
  f.activate();
  f.life.start(f.taskId);
  const resolved = resolveOrdinaryWindow('codex', '0.167.0');
  if (!resolved) throw new Error('fixture_policy_missing');
  const selection = {
    ...f.selection,
    declaredVersion: '0.167.0',
    policy: resolved.policy,
    policyDigest: resolved.policyDigest
  };
  f.store.execute('DELETE FROM ordinary_window_selections WHERE task_id=?', [f.taskId]);
  f.store.execute('INSERT INTO ordinary_window_selections(task_id,selection,selection_hash) VALUES (?,?,?)', [
    f.taskId,
    JSON.stringify(selection),
    ordinaryWindowSelectionHash(selection)
  ]);
  const before = f.usageState();
  vi.clearAllMocks();
  const response = await f.post('connect', f.body, '"unused"');
  expect(response.statusCode, response.body).toBe(400);
  expect(response.json()).toEqual({ error: 'binding_scope_mismatch' });
  expectNoNativeOperations(f);
  expect(f.usageState()).toEqual(before);
});

test('reads status as metadata only without starting or activating collection', async () => {
  const f = await fixture();
  const before = f.usageState();
  vi.clearAllMocks();
  const response = await f.get();
  expect(response.statusCode, response.body).toBe(200);
  expect(response.headers.etag).toBe(response.json<{ task: ClaudeWindowTaskDto }>().task.version);
  expect(response.json()).toMatchObject({
    task: {
      state: 'registered',
      connection_enabled: false,
      reason: 'binding_scope_revoked',
      selected_root_id: null
    }
  });
  expectNoNativeOperations(f);
  expect(f.usageState()).toEqual(before);
  expect(f.store.all('SELECT * FROM ordinary_window_activations')).toEqual([]);
});

test('starts explicitly and connects the prepared root through the real coordinator with fake binary adapters', async () => {
  const f = await fixture();
  f.activate();
  expect((await f.action('start')).statusCode).toBe(200);
  const response = await f.connect();
  expect(response.statusCode, response.body).toBe(200);
  const result = response.json<{ session_id: string }>();
  expect(response.json()).toMatchObject({
    kind: 'claude_window_connection',
    automatic_children: false,
    evidence_mode: 'publisher_verified_local_pin',
    trust: 'compatibility_unverified',
    mapped_image_proof: 'unverified',
    root_ownership: 'unverified',
    possible_child_contribution: 'unknown',
    cost_coverage: 'partial'
  });
  expect((await f.view()).task.selected_root_id).toBe(result.session_id);
  expect(f.store.all('SELECT product,product_version FROM sessions')).toEqual([{ product: 'claude_code', product_version: '2.1.318' }]);
  expect(f.store.all('SELECT * FROM ordinary_window_segments')).toHaveLength(1);
  expect(f.binary.operations).toContain('signature');
  expect(processes.execFileSync).not.toHaveBeenCalled();
});

test.each(['pause_resume', 'revoke', 'delete', 'replace_activation'] as const)(
  'revalidates cached connections after %s without reentering the provider',
  async kind => {
    const f = await fixture();
    f.activate();
    f.life.start(f.taskId);
    const key = randomUUID();
    const version = (await f.view()).task.version;
    const first = await f.connect(key, version);
    expect(first.statusCode, first.body).toBe(200);
    f.binary.operations.length = 0;
    vi.clearAllMocks();
    expect((await f.connect(key, version)).json()).toEqual(first.json());
    expectNoNativeOperations(f);
    if (kind === 'pause_resume') {
      f.life.pause(f.taskId);
      f.life.resume(f.taskId);
    }
    if (kind === 'revoke') {
      revokeOrdinaryWindowActivation(f.store, f.taskId, f.clock());
    }
    if (kind === 'delete') new Deletion(f.store).deleteTask(f.taskId);
    if (kind === 'replace_activation') {
      const row = f.store.get<Record<string, string | number | null>>('SELECT * FROM ordinary_window_activations');
      if (!row) throw new Error('fixture_activation_missing');
      row.decision_ref = 'synthetic-replacement-decision';
      f.store.execute('DELETE FROM ordinary_window_activations', []);
      const columns = Object.keys(row);
      f.store.execute(`INSERT INTO ordinary_window_activations(${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`, Object.values(row));
    }
    const before = f.usageState();
    vi.clearAllMocks();
    const replay = await f.connect(key, version);
    expect(replay.statusCode, replay.body).toBe(kind === 'replace_activation' ? 409 : 400);
    expectNoNativeOperations(f);
    expect(f.usageState()).toEqual(before);
  }
);

test('collects appended terminal usage through the registered task action route', async () => {
  const f = await fixture();
  f.activate();
  f.life.start(f.taskId);
  expect((await f.connect()).statusCode).toBe(200);
  f.advance();
  vi.setSystemTime(new Date(f.clock()));
  f.append([f.assistant('http-request')]);
  const response = await f.action('collect');
  expect(response.statusCode, response.body).toBe(200);
  expect(f.payloads()).toHaveLength(1);
  expect(f.payloads()[0]).toMatchObject({
    kind: 'usage',
    product: 'claude_code',
    output_total: { status: 'observed', value: 5 }
  });
  expect(processes.execFileSync).not.toHaveBeenCalled();
});

test.each(['revoke', 'pause_resume'] as const)('denies collect after %s without receipt, native or cursor changes', async kind => {
  const f = await fixture();
  f.activate();
  f.life.start(f.taskId);
  expect((await f.connect()).statusCode).toBe(200);
  if (kind === 'revoke') {
    revokeOrdinaryWindowActivation(f.store, f.taskId, f.clock());
  } else {
    f.life.pause(f.taskId);
    f.life.resume(f.taskId);
  }
  const before = f.usageState();
  f.binary.operations.length = 0;
  vi.clearAllMocks();
  const response = await f.action('collect');
  expect(response.statusCode, response.body).toBe(400);
  expectNoNativeOperations(f);
  expect(f.usageState()).toEqual(before);
});

test.each(['pause_resume', 'replace_activation', 'change_setup'] as const)(
  'discards successful coordinator connect readback after %s across await',
  async kind => {
    const f = await fixture();
    f.activate();
    f.life.start(f.taskId);
    const actual = await vi.importActual<typeof import('../src/ordinary-session-binding.js')>('../src/ordinary-session-binding.js');
    vi.mocked(binding.connectOrdinaryClaudeWindow).mockImplementationOnce(async (...args) => {
      const result = await actual.connectOrdinaryClaudeWindow(...args);
      if (kind === 'pause_resume') {
        f.life.pause(f.taskId);
        f.life.resume(f.taskId);
      }
      if (kind === 'replace_activation') {
        const row = f.store.get<Record<string, string | number | null>>('SELECT * FROM ordinary_window_activations');
        if (!row) throw new Error('fixture_activation_missing');
        row.decision_ref = 'synthetic-replacement-decision';
        f.store.execute('DELETE FROM ordinary_window_activations', []);
        const columns = Object.keys(row);
        f.store.execute(`INSERT INTO ordinary_window_activations(${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`, Object.values(row));
      }
      if (kind === 'change_setup') {
        f.setup.configuration.claude_projects_directory = join(f.directory, 'replacement-sources');
        f.metadata.prepare('UPDATE web_tasks SET setup=? WHERE id=?').run(JSON.stringify(f.setup), f.taskId);
      }
      return result;
    });
    const response = await f.connect();
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json()).toEqual({ error: 'binding_scope_revoked' });
    expect(f.payloads()).toEqual([]);
  }
);

test('discards successful collect readback when authority is revoked during await', async () => {
  const f = await fixture();
  f.activate();
  f.life.start(f.taskId);
  expect((await f.connect()).statusCode).toBe(200);
  const actual = await vi.importActual<typeof import('../src/ordinary-session-binding.js')>('../src/ordinary-session-binding.js');
  vi.mocked(binding.collectOrdinaryClaudeWindow).mockImplementationOnce(async (...args) => {
    await actual.collectOrdinaryClaudeWindow(...args);
    revokeOrdinaryWindowActivation(f.store, f.taskId, f.clock());
  });
  const response = await f.action('collect');
  expect(response.statusCode, response.body).toBe(400);
  expect(response.json()).toEqual({
    error: 'binding_scope_revoked'
  });
});
