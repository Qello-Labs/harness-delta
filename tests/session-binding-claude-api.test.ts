import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test, vi } from 'vitest';
import { Deletion } from '../src/deletion.js';
import { externalContract } from '../src/external-session-contract.js';
import { createLocalWebDomain } from '../src/web/local-web-domain.js';
import { createLocalWebServer } from '../src/web/local-web-server.js';
import { selectTaskPriceTable } from '../src/price-catalog-selection.js';
import { ClaudeSessionBindingProvider, claudeProjectDirName } from '../src/session-binding-claude.js';
import { localWebFixture } from './helpers/local-web-fixture.js';

// These tests exercise HTTP -> domain -> Store -> candidate Claude parser using
// isolated metadata fixtures. No product executable or native history is opened.
const hook = resolve(import.meta.dirname, '../scripts/claude-session-hook.mjs');
const origin = 'http://127.0.0.1:4321';
const headers = { host: '127.0.0.1:4321' };
const at = () => new Date().toISOString();
const oldAt = () => new Date(Date.now() - 60000).toISOString();
const lines = (rows: unknown[]) => rows.map(row => JSON.stringify(row) + '\n').join('');

async function fixture(useFactory = false) {
  const f = localWebFixture();
  const receipts = join(f.root, 'claude-receipts');
  const projects = join(f.root, 'claude-projects');
  const projectDir = join(projects, claudeProjectDirName(f.project));
  mkdirSync(projectDir, { recursive: true });
  const factoryCalls: { taskId: string; projectRoot: string }[] = [];
  const resolutionErrors: string[] = [];
  const concreteProviders: ClaudeSessionBindingProvider[] = [];
  const provider = (projectRoot = f.project) => {
    const value = new ClaudeSessionBindingProvider({
      receiptDir: receipts,
      claudeProjectsDir: projects,
      projectRoot,
      allowCandidateProfiles: true,
      quiescenceMs: 0
    });
    const resolveCurrent = value.resolveCurrent.bind(value);
    value.resolveCurrent = async input => {
      try {
        return await resolveCurrent(input);
      } catch (error) {
        if (error instanceof Error) resolutionErrors.push(error.message);
        throw error;
      }
    };
    concreteProviders.push(value);
    return value;
  };
  const makeDomain = () =>
    createLocalWebDomain({
      store: f.store,
      metadataFile: f.metadataFile,
      profiles: [f.profile],
      ...(useFactory
        ? {
            bindingProviderFactory: (taskId: string, projectRoot: string) => {
              factoryCalls.push({ taskId, projectRoot });
              return [provider(projectRoot)];
            }
          }
        : { bindingProviders: [provider()] })
    });
  let domain = makeDomain();
  let app = createLocalWebServer({ origin, domain, metadataFile: f.metadataFile });
  const createTask = async (name = 'Synthetic Claude family') => {
    const created = (await domain.createTask({ name, project_id: 'project-1', setup_id: f.profile.id })) as { id: string };
    await domain.taskAction(created.id, 'apply', {});
    return created.id;
  };
  const id = await createTask();
  const post = async (action: string, body: unknown = {}, taskId = id) => {
    const bootstrap = (await app.inject({ url: '/api/bootstrap', headers })).json<{ csrf: string }>();
    return app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/${action}`,
      payload: JSON.stringify(body),
      headers: {
        ...headers,
        origin,
        'content-type': 'application/json',
        'x-harness-csrf': bootstrap.csrf,
        'idempotency-key': randomUUID(),
        'if-match': domain.task(taskId).version
      }
    });
  };
  const rootPath = (sid: string) => join(projectDir, `${sid}.jsonl`);
  const childPath = (sid: string, agent: string) => join(projectDir, sid, 'subagents', `agent-${agent}.jsonl`);
  const user = (sid: string, timestamp: string, agent?: string) => ({
    type: 'user',
    sessionId: sid,
    version: '2.1.291',
    cwd: f.project,
    timestamp,
    ...(agent ? { agentId: agent, isSidechain: true } : {})
  });
  const usage = (sid: string, request: string, timestamp = at(), agent?: string) => ({
    type: 'assistant',
    sessionId: sid,
    version: '2.1.291',
    timestamp,
    requestId: request,
    ...(agent ? { agentId: agent, isSidechain: true } : {}),
    message: {
      id: `msg_${request}`,
      model: 'model-a',
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 2,
        cache_read_input_tokens: 3,
        output_tokens: 4
      }
    }
  });
  const writeRoot = (sid = randomUUID(), rows: unknown[] = []) => {
    writeFileSync(rootPath(sid), lines([user(sid, oldAt()), ...rows]), { mode: 0o600 });
    return sid;
  };
  const writeChild = (sid: string, agent: string, rows: unknown[] = [], timestamp = at()) => {
    mkdirSync(join(projectDir, sid, 'subagents'), { recursive: true });
    writeFileSync(childPath(sid, agent), lines([user(sid, timestamp, agent), ...rows]), { mode: 0o600 });
  };
  const record = (sid: string, event: string, extra: Record<string, unknown> = {}) => {
    execFileSync(process.execPath, [hook, 'record', '--dir', receipts], {
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PID: String(process.pid) },
      input: JSON.stringify({ session_id: sid, cwd: f.project, transcript_path: rootPath(sid), hook_event_name: event, ...extra })
    });
  };
  const connectReceipt = (sid: string, agent?: string) => {
    const previous = new Set(existsSync(join(receipts, 'connect')) ? readdirSync(join(receipts, 'connect')) : []);
    const toolUseId = `toolu_${randomUUID()}`;
    record(sid, 'PreToolUse', {
      tool_name: 'Bash',
      tool_use_id: toolUseId,
      tool_input: { command: 'node /synthetic/connect.mjs connect --product claude_code' },
      ...(agent ? { agent_id: agent, agent_type: 'general-purpose' } : {})
    });
    const name = readdirSync(join(receipts, 'connect')).find(name => !previous.has(name));
    expect(name).toBeDefined();
    return name!.slice(0, -5);
  };
  const relation = (sid: string, agent: string) => record(sid, 'SubagentStart', { agent_id: agent, agent_type: 'general-purpose' });
  const connect = (receipt: string, taskId = id) => post('session-connect', { product: 'claude_code', receipt }, taskId);
  const counted = () =>
    f.store
      .all<{ request_id: string }>("SELECT json_extract(payload,'$.request_id') AS request_id FROM runtime_evidence ORDER BY rowid")
      .map(row => row.request_id);
  return {
    ...f,
    id,
    receipts,
    projects,
    projectDir,
    provider,
    createTask,
    post,
    rootPath,
    childPath,
    usage,
    writeRoot,
    writeChild,
    relation,
    record,
    connectReceipt,
    connect,
    counted,
    factoryCalls,
    resolutionErrors,
    concreteProviders,
    task: () => domain.task(id),
    bootstrap: () => app.inject({ url: '/api/bootstrap', headers }),
    restart: async () => {
      await app.close();
      domain = makeDomain();
      app = createLocalWebServer({ origin, domain, metadataFile: f.metadataFile });
    },
    cleanup: async () => {
      await app.close();
      f.cleanup();
    }
  };
}

test('Claude receipt baseline, sibling and flattened descendant ownership, replay, and child recalls retain one logical task', async () => {
  const f = await fixture();
  try {
    const sid = f.writeRoot();
    appendFileSync(f.rootPath(sid), lines([f.usage(sid, 'old-root', oldAt())]));
    const receipt = f.connectReceipt(sid);
    // A valid Start initially has an empty file. Connection now holds the family
    // until its own metadata row arrives, then baselines both members prospectively.
    mkdirSync(join(f.projectDir, sid, 'subagents'), { recursive: true });
    writeFileSync(f.childPath(sid, 'first'), '', { mode: 0o600 });
    f.relation(sid, 'first');
    const firstReceipt = f.connectReceipt(sid, 'first');
    const creation = delay(150).then(() => f.writeChild(sid, 'first'));
    const connected = await f.connect(receipt);
    await creation;
    expect(connected.statusCode, connected.body).toBe(200);
    expect(connected.json()).toMatchObject({
      connection: { status: 'connected', collection_active: true, cost_coverage: 'partial' },
      binding: { roots: 1, children: 1, requests: 0, complete_cost: null, inference: false }
    });
    expect(f.counted()).toEqual([]);

    // Native Claude hook ancestry is flattened: independently evidenced nested
    // member files remain root children even when their own rows carry parentAgentId.
    appendFileSync(f.childPath(sid, 'first'), lines([f.usage(sid, 'first-child', at(), 'first')]));
    expect(f.task()).toMatchObject({ binding: { children: 1 } });
    // The child recall revalidates independently and must not duplicate its usage.
    const recalled = await f.connect(firstReceipt);
    expect(recalled.statusCode, recalled.body).toBe(200);
    expect(recalled.json()).toMatchObject({
      connection: { status: 'already_connected', role: 'child', task_id: f.id },
      binding: { roots: 1, children: 1, requests: 1 }
    });
    f.writeChild(sid, 'second', [f.usage(sid, 'second-child', at(), 'second')]);
    f.relation(sid, 'second');
    f.writeChild(sid, 'nested', [{ ...f.usage(sid, 'nested-child', at(), 'nested'), parentAgentId: 'first' }]);
    f.relation(sid, 'nested');
    const rootUsage = f.usage(sid, 'new-root');
    appendFileSync(f.rootPath(sid), lines([rootUsage, f.usage(sid, 'first-child', at(), 'first'), f.usage(sid, 'nested-child', at(), 'nested')]));
    await expect.poll(() => f.counted().length, { timeout: 4000 }).toBe(4);
    expect(new Set(f.counted())).toEqual(new Set(['new-root', 'first-child', 'second-child', 'nested-child']));
    expect(f.task()).toMatchObject({ binding: { roots: 1, children: 3, requests: 4 } });
    expect(
      f.store.get("SELECT sum(json_extract(payload,'$.input_total.value')) AS input, sum(json_extract(payload,'$.output_total.value')) AS output FROM events")
    ).toEqual({ input: 60, output: 16 });
    const before = f.counted();
    appendFileSync(f.rootPath(sid), lines([rootUsage]));
    expect((await f.connect(firstReceipt)).json()).toMatchObject({ connection: { status: 'already_connected', role: 'child' } });
    expect((await f.connect(receipt)).json()).toMatchObject({ connection: { status: 'already_connected' } });
    expect(f.counted()).toEqual(before);
    expect(f.store.all('SELECT id FROM tasks')).toHaveLength(1);
    expect(f.store.all('SELECT parent_id FROM sessions WHERE parent_id=?', [sid])).toHaveLength(3);
  } finally {
    await f.cleanup();
  }
}, 15000);

test('Claude wrong-task conflicts and paused child recalls preserve the family; root reconnect and a new root exclude unseen usage', async () => {
  const f = await fixture(true);
  try {
    const sid = f.writeRoot();
    const receipt = f.connectReceipt(sid);
    expect((await f.connect(receipt)).statusCode).toBe(200);
    f.writeChild(sid, 'child', [f.usage(sid, 'observed-child', at(), 'child')]);
    f.relation(sid, 'child');
    const childReceipt = f.connectReceipt(sid, 'child');
    expect((await f.connect(childReceipt)).statusCode).toBe(200);
    const assignment = f.store.get('SELECT * FROM comparison_assignments WHERE task_id=?', [f.id]);
    const price = selectTaskPriceTable(f.store, f.id);
    const window = externalContract(f.store, f.id);
    expect((await f.post('pause')).statusCode).toBe(200);
    appendFileSync(f.rootPath(sid), lines([f.usage(sid, 'paused-root')]));
    appendFileSync(f.childPath(sid, 'child'), lines([f.usage(sid, 'paused-child', at(), 'child')]));
    const blocked = await f.connect(childReceipt);
    expect(blocked.json()).toMatchObject({ error: 'binding_reconnect_required' });
    expect(f.task()).toMatchObject({ state: 'paused', binding: { state: 'stopped', roots: 1 } });
    // A project owns one prepared surface at a time. Switch it explicitly to
    // another task before testing an otherwise-authorized cross-task receipt.
    expect((await f.post('release', { external_session_stopped: true })).statusCode).toBe(200);
    const managed = join(f.project, '.harness-delta-managed', 'active-instructions.md');
    rmSync(managed);
    const otherId = await f.createTask('Synthetic wrong task');
    expect((await f.connect(childReceipt, otherId)).json()).toMatchObject({ error: 'binding_session_conflict' });
    expect((await f.post('release', { external_session_stopped: true }, otherId)).statusCode).toBe(200);
    rmSync(managed);
    expect((await f.post('apply')).statusCode).toBe(200);
    expect(f.task().actions).toEqual(expect.arrayContaining([{ code: 'resume-binding', enabled: true, reason: null }]));
    expect((await f.post('resume-binding')).statusCode).toBe(200);
    appendFileSync(f.childPath(sid, 'child'), lines([f.usage(sid, 'resumed-child', at(), 'child')]));
    await expect.poll(() => f.counted().length, { timeout: 4000 }).toBe(2);
    const next = f.writeRoot();
    appendFileSync(f.rootPath(next), lines([f.usage(next, 'old-new-root', oldAt())]));
    expect((await f.connect(f.connectReceipt(next))).statusCode).toBe(200);
    appendFileSync(f.rootPath(next), lines([f.usage(next, 'new-parent-request')]));
    await expect.poll(() => f.counted().length, { timeout: 4000 }).toBe(3);
    expect(new Set(f.counted())).toEqual(new Set(['observed-child', 'resumed-child', 'new-parent-request']));
    expect(f.task()).toMatchObject({ binding: { roots: 2, children: 1, requests: 3, gaps: expect.arrayContaining(['unobserved_interval']) as string[] } });
    expect(f.store.get('SELECT * FROM comparison_assignments WHERE task_id=?', [f.id])).toEqual(assignment);
    expect(selectTaskPriceTable(f.store, f.id)).toEqual(price);
    expect(externalContract(f.store, f.id)).toEqual(window);
    expect(f.factoryCalls).toEqual([
      { taskId: f.id, projectRoot: f.project },
      { taskId: otherId, projectRoot: f.project }
    ]);
  } finally {
    await f.cleanup();
  }
}, 15000);

test('a late pre-existing Claude member exposes its excluded interval and later own requests remain measurable', async () => {
  const f = await fixture();
  try {
    const sid = f.writeRoot();
    expect((await f.connect(f.connectReceipt(sid))).statusCode).toBe(200);
    f.writeChild(sid, 'late', [f.usage(sid, 'unseen-old-child', oldAt(), 'late')], oldAt());
    f.relation(sid, 'late');
    await expect.poll(() => f.task(), { timeout: 4000 }).toMatchObject({ binding: { children: 1 } });
    expect(f.task()).toMatchObject({ binding: { gaps: expect.arrayContaining(['late_linked_member']) as string[] } });
    expect(f.counted()).toEqual([]);
    appendFileSync(f.childPath(sid, 'late'), lines([f.usage(sid, 'late-observed-child', at(), 'late')]));
    await expect.poll(() => f.counted(), { timeout: 4000 }).toEqual(['late-observed-child']);
    expect(f.store.all('SELECT * FROM observation_gaps WHERE task_id=?', [f.id])).not.toEqual([]);
  } finally {
    await f.cleanup();
  }
}, 10000);

test('the per-task Claude provider uses registered project scope and rejects a foreign path before reading its bytes', async () => {
  const f = await fixture(true);
  try {
    const foreignRoot = join(f.root, 'foreign-project');
    mkdirSync(foreignRoot);
    const foreignDir = join(f.projects, claudeProjectDirName(foreignRoot));
    mkdirSync(foreignDir);
    const sid = randomUUID();
    const foreignTranscript = join(foreignDir, `${sid}.jsonl`);
    // If scope validation were moved after transcript parsing, this malformed
    // file would produce metadata-invalid rather than the project-scope error.
    writeFileSync(foreignTranscript, 'invalid synthetic transcript bytes\n', { mode: 0o600 });
    f.record(sid, 'PreToolUse', {
      transcript_path: foreignTranscript,
      tool_name: 'Bash',
      tool_use_id: 'toolu_foreign',
      tool_input: { command: 'node /synthetic/connect.mjs connect --product claude_code' }
    });
    const receipt = readdirSync(join(f.receipts, 'connect'))[0]!.slice(0, -5);
    const rejected = await f.connect(receipt);
    expect(rejected.statusCode).toBe(400);
    expect(f.resolutionErrors).toEqual(['claude_project_mismatch']);
    expect(f.factoryCalls).toEqual([{ taskId: f.id, projectRoot: f.project }]);
    expect(f.task()).toMatchObject({ state: 'registered', binding: { state: 'unconnected', roots: 0, requests: 0 } });
    expect(f.store.all('SELECT * FROM sessions')).toEqual([]);
    expect(f.counted()).toEqual([]);
    expect(rejected.body).not.toContain(foreignRoot);
  } finally {
    await f.cleanup();
  }
}, 10000);

test('deleting a paused Claude family cleans metadata durably after restart and later hooks cannot recreate it', async () => {
  const f = await fixture(true);
  try {
    const sid = f.writeRoot();
    const receipt = f.connectReceipt(sid);
    expect((await f.connect(receipt)).statusCode).toBe(200);
    f.writeChild(sid, 'child');
    f.relation(sid, 'child');
    expect((await f.connect(f.connectReceipt(sid, 'child'))).statusCode).toBe(200);
    expect((await f.post('pause')).statusCode).toBe(200);
    const rootBefore = readFileSync(f.rootPath(sid));
    const childBefore = readFileSync(f.childPath(sid, 'child'));
    new Deletion(f.store).deleteTask(f.id);
    expect(f.store.all('SELECT * FROM session_bindings')).toEqual([]);
    expect(f.store.all('SELECT * FROM session_binding_forgets')).not.toEqual([]);
    // No observer is running: cleanup must survive a server restart, then flush
    // before even the bootstrap response is delivered.
    await f.restart();
    expect((await f.bootstrap()).statusCode).toBe(200);
    expect(f.store.all('SELECT * FROM session_binding_forgets')).toEqual([]);
    expect(f.factoryCalls).toEqual([
      { taskId: f.id, projectRoot: f.project },
      { taskId: f.id, projectRoot: f.project }
    ]);
    expect(existsSync(join(f.receipts, 'forgotten', sid))).toBe(true);
    expect(existsSync(join(f.receipts, 'sessions', sid))).toBe(false);
    expect(readdirSync(join(f.receipts, 'connect'))).toEqual([]);
    f.relation(sid, 'new-child');
    // Recorder exits successfully but stores no metadata for a forgotten native ID.
    execFileSync(process.execPath, [hook, 'record', '--dir', f.receipts], {
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PID: String(process.pid) },
      input: JSON.stringify({
        session_id: sid,
        cwd: f.project,
        transcript_path: f.rootPath(sid),
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_use_id: 'toolu_after_delete',
        tool_input: { command: 'node /synthetic/connect.mjs connect --product claude_code' }
      })
    });
    expect(existsSync(join(f.receipts, 'sessions', sid))).toBe(false);
    expect(readdirSync(join(f.receipts, 'connect'))).toEqual([]);
    expect(readFileSync(f.rootPath(sid))).toEqual(rootBefore);
    expect(readFileSync(f.childPath(sid, 'child'))).toEqual(childBefore);
    expect(f.store.all('SELECT * FROM events')).toEqual([]);
  } finally {
    await f.cleanup();
  }
}, 10000);

test('ordinary synthetic Claude connection holds usage baseline until its fresh Start source is attributable', async () => {
  const f = await fixture();
  const sid = f.writeRoot();
  const agent = 'initial-pending';
  f.relation(sid, agent);
  const discover = vi.spyOn(ClaudeSessionBindingProvider.prototype, 'discoverChildren');
  const read = vi.spyOn(ClaudeSessionBindingProvider.prototype, 'readUsage');
  const connecting = f.connect(f.connectReceipt(sid));
  try {
    await expect.poll(() => discover.mock.calls.length, { timeout: 1000 }).toBeGreaterThan(0);
    expect(read.mock.calls.length).toBe(0);
    f.writeChild(sid, agent, [f.usage(sid, 'held-initial-child', at(), agent)]);
    expect((await connecting).statusCode).toBe(200);
    expect(f.counted()).toEqual([]);
    expect(f.store.get<{ count: number }>('SELECT count(DISTINCT session_id) AS count FROM observation_gaps WHERE task_id=?', [f.id])!.count).toBe(2);
  } finally {
    f.writeChild(sid, agent);
    await connecting;
    await f.cleanup();
    discover.mockRestore();
    read.mockRestore();
  }
});

test.each(['stop', 'mixed'] as const)('ordinary Claude tick rejects %s terminal evidence before root usage even without a latched wait', async fault => {
  const f = await fixture();
  const sid = f.writeRoot();
  await f.connect(f.connectReceipt(sid));
  const selected = f.concreteProviders[0]!;
  const original = selected.discoverChildren.bind(selected);
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  let gated = false;
  const discover = vi.spyOn(selected, 'discoverChildren').mockImplementation(async identity => {
    gated = true;
    await gate;
    return original(identity);
  });
  const read = vi.spyOn(selected, 'readUsage');
  try {
    await expect.poll(() => gated).toBe(true); // Observe only after the next family preflight is held.
    if (fault === 'mixed') f.relation(sid, 'pending');
    f.record(sid, 'SubagentStop', { agent_id: 'unknown-stop', agent_type: null, agent_transcript_path: f.childPath(sid, 'unknown-stop') });
    appendFileSync(f.rootPath(sid), lines([f.usage(sid, 'must-not-collect')]));
    release();
    await expect.poll(() => f.task().state, { timeout: 1500 }).toBe('paused');
    expect(read.mock.calls.length).toBe(0);
    expect(f.counted()).toEqual([]);
  } finally {
    release();
    await f.cleanup();
    discover.mockRestore();
    read.mockRestore();
  }
});
