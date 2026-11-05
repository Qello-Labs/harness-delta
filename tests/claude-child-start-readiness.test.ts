import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, test, vi } from 'vitest';
import { takeFamilyDiagnostic } from '../src/binding-family-diagnostics.js';
import { createSessionBindingService } from '../src/session-binding-service.js';
import { issueClaudeHumanPilotScope, assertClaudeHumanPilotSource } from '../src/session-binding-claude-human-pilot.js';
import { createLocalWebDomain } from '../src/web/local-web-domain.js';
import { ClaudeSessionBindingProvider, claudeProjectDirName } from '../src/session-binding-claude.js';
import { localWebFixture } from './helpers/local-web-fixture.js';

// Synthetic files and this Node test process only; no native CLI, settings or user records.
async function fixture(initialHold = false, observation?: (event: unknown) => void) {
  const f = localWebFixture('claude-ordinary-human-pilot', { product: 'claude_code', productVersion: '2.1.294' });
  const receipts = join(f.root, 'receipts');
  const sources = join(f.root, 'claude-projects', claudeProjectDirName(f.project));
  mkdirSync(sources, { recursive: true });
  mkdirSync(join(receipts, 'connect'), { recursive: true, mode: 0o700 });
  f.profile.session_binding = { product: 'claude_code', receipt_directory: receipts, claude_projects_directory: join(f.root, 'claude-projects') };
  let domain = f.create();
  const { id } = (await domain.createTask({ name: 'Synthetic Start readiness', project_id: 'project-1', setup_id: f.profile.id })) as { id: string };
  await domain.close?.();
  domain = createLocalWebDomain({
    store: f.store,
    metadataFile: f.metadataFile,
    profiles: [f.profile],
    nativePilot: { taskId: id, observe: true, untilExplicitStop: true },
    ...(observation ? { onChildReadiness: observation } : {})
  });
  await domain.taskAction(id, 'apply', {});
  const sid = randomUUID();
  const source = join(sources, sid + '.jsonl');
  const receipt = randomUUID();
  const ownRow = (agent: string | null = null) => ({
    type: 'user',
    sessionId: sid,
    version: '2.1.294',
    timestamp: new Date().toISOString(),
    ...(agent ? { agentId: agent, isSidechain: true } : {})
  });
  writeFileSync(source, JSON.stringify(ownRow()) + '\n', { mode: 0o600 });
  const proof = {
    schema_version: 1,
    kind: 'connect',
    receipt_id: receipt,
    session_id: sid,
    agent_id: null,
    agent_type: null,
    transcript_path: source,
    agent_transcript_path: null,
    cwd: f.project,
    claude_pid: process.pid,
    uid: process.getuid?.() ?? null,
    recorded_at: new Date().toISOString()
  };
  writeFileSync(join(receipts, 'connect', receipt + '.json'), JSON.stringify(proof), { mode: 0o600 });
  const agent = 'synthetic-member';
  const agents = join(receipts, 'sessions', sid, 'agents');
  mkdirSync(agents, { recursive: true, mode: 0o700 });
  const childDir = join(sources, sid, 'subagents');
  mkdirSync(childDir, { recursive: true });
  const childPath = join(childDir, 'agent-' + agent + '.jsonl');
  const start = (recordedAt = new Date().toISOString()) =>
    writeFileSync(
      join(agents, agent + '.subagent_start.json'),
      JSON.stringify({ ...proof, kind: 'subagent_start', receipt_id: randomUUID(), agent_id: agent, agent_type: 'Explore', recorded_at: recordedAt }),
      { mode: 0o600 }
    );
  const stop = () =>
    writeFileSync(
      join(agents, agent + '.subagent_stop.json'),
      JSON.stringify({
        ...proof,
        kind: 'subagent_stop',
        receipt_id: randomUUID(),
        agent_id: agent,
        agent_transcript_path: childPath,
        recorded_at: new Date().toISOString()
      }),
      { mode: 0o600 }
    );
  const child = () => writeFileSync(childPath, JSON.stringify(ownRow(agent)) + '\n', { mode: 0o600 });
  const usage = (path: string, request: string, member: string | null = null) =>
    appendFileSync(
      path,
      JSON.stringify({
        ...ownRow(member),
        type: 'assistant',
        requestId: request,
        message: { model: 'claude-sonnet-4-5', usage: { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }
      }) +
        '\n' +
        JSON.stringify(ownRow(member)) +
        '\n'
    );
  if (initialHold) start();
  const creation = initialHold
    ? delay(150).then(() => {
        usage(source, 'initial-held-root');
        child();
        usage(childPath, 'initial-held-child', agent);
      })
    : Promise.resolve();
  await domain.taskAction(id, 'session-connect', { product: 'claude_code', receipt });
  await creation;
  return { ...f, domain, id, sid, source, childPath, agent, start, stop, child, ownRow, usage, receipts, sources, receipt };
}

test('holds all usage through missing and partial Start source, then excludes the held snapshot prospectively', async () => {
  const f = await fixture();
  const discover = vi.spyOn(ClaudeSessionBindingProvider.prototype, 'discoverChildren');
  const read = vi.spyOn(ClaudeSessionBindingProvider.prototype, 'readUsage');
  try {
    f.usage(f.source, 'retained-root');
    await expect.poll(() => f.store.eventCount(), { timeout: 3000 }).toBe(1);
    const reads = read.mock.calls.length;
    const cursor = f.store.get<{ cursor: string }>('SELECT cursor FROM session_bindings WHERE session_id=?', [f.sid])!.cursor;
    discover.mockClear();
    f.start();
    await expect.poll(() => discover.mock.calls.length, { timeout: 1000 }).toBeGreaterThan(0);
    await delay(60);
    expect(f.domain.task(f.id).state, String(f.domain.task(f.id).reason)).toBe('active');
    expect(read.mock.calls.length).toBe(reads);
    expect(f.store.get<{ cursor: string }>('SELECT cursor FROM session_bindings WHERE session_id=?', [f.sid])!.cursor).toBe(cursor);
    f.usage(f.source, 'held-root');
    writeFileSync(f.childPath, '{"type":"user","sessionId"', { mode: 0o600 });
    await delay(60);
    expect(read.mock.calls.length).toBe(reads);
    f.child();
    f.usage(f.childPath, 'held-child', f.agent);
    await expect
      .poll(() => f.store.get<{ count: number }>('SELECT count(*) AS count FROM session_bindings WHERE task_id=?', [f.id])!.count, { timeout: 2000 })
      .toBe(2);
    await expect
      .poll(() => f.store.get<{ count: number }>('SELECT count(*) AS count FROM observation_gaps WHERE task_id=?', [f.id])!.count, { timeout: 2000 })
      .toBeGreaterThan(0);
    expect(f.domain.task(f.id).state, String(f.domain.task(f.id).reason)).toBe('active');
    expect(f.store.eventCount()).toBe(1); // Prior measured row survives; held root/child requests are never backfilled.
    f.usage(f.source, 'after-root');
    f.usage(f.childPath, 'after-child', f.agent);
    await expect.poll(() => f.store.eventCount(), { timeout: 3000 }).toBe(3);
    const requests = f.store
      .all<{ id: string }>("SELECT json_extract(payload,'$.request_id') AS id FROM runtime_evidence ORDER BY occurred_at,id")
      .map(row => row.id);
    expect(requests.sort()).toEqual(['after-child', 'after-root', 'retained-root']);
    expect((f.domain.task(f.id).binding as { gaps: string[] }).gaps).toContain('unobserved_interval');
  } finally {
    await f.domain.close?.();
    discover.mockRestore();
    read.mockRestore();
    f.cleanup();
  }
}, 10000);

test.each(['stop', 'unsafe', 'stale', 'future', 'foreign', 'foreign-cwd', 'wrong-pid', 'pre-root', 'mixed'] as const)(
  'keeps %s evidence terminal instead of treating it as source readiness',
  async fault => {
    const f = await fixture();
    const read = vi.spyOn(ClaudeSessionBindingProvider.prototype, 'readUsage');
    try {
      f.start(fault === 'stale' ? new Date(Date.now() - 5000).toISOString() : fault === 'future' ? new Date(Date.now() + 5000).toISOString() : undefined);
      if (fault === 'foreign-cwd' || fault === 'wrong-pid' || fault === 'pre-root') {
        const path = join(f.receipts, 'sessions', f.sid, 'agents', f.agent + '.subagent_start.json');
        const proof = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
        writeFileSync(
          path,
          JSON.stringify({
            ...proof,
            ...(fault === 'foreign-cwd'
              ? { cwd: f.root }
              : fault === 'wrong-pid'
                ? { claude_pid: process.pid + 100000 }
                : { recorded_at: new Date(Date.now() - 1000).toISOString() })
          }),
          { mode: 0o600 }
        );
      }
      if (fault === 'stop') f.stop();
      if (fault === 'unsafe') writeFileSync(f.childPath, '', { mode: 0o000 });
      if (fault === 'foreign') writeFileSync(f.childPath, JSON.stringify({ ...f.ownRow(f.agent), sessionId: randomUUID() }) + '\n', { mode: 0o600 });
      if (fault === 'mixed') {
        f.child();
        f.stop(); // A valid first child cannot excuse another unknown Stop.
        const proof = JSON.parse(readFileSync(join(f.receipts, 'sessions', f.sid, 'agents', f.agent + '.subagent_stop.json'), 'utf8')) as Record<
          string,
          unknown
        >;
        writeFileSync(
          join(f.receipts, 'sessions', f.sid, 'agents', 'other.subagent_stop.json'),
          JSON.stringify({ ...proof, agent_id: 'other', agent_transcript_path: join(f.sources, f.sid, 'subagents', 'agent-other.jsonl') }),
          { mode: 0o600 }
        );
      }
      await expect.poll(() => f.domain.task(f.id).state, { timeout: 1500 }).toBe('paused');
      expect(f.store.eventCount()).toBe(0);
      expect(read.mock.calls.length).toBe(0);
    } finally {
      await f.domain.close?.();
      read.mockRestore();
      f.cleanup();
    }
  }
);

test('Stop arriving during a missing Start source ends the hold without any usage read', async () => {
  const f = await fixture();
  const discover = vi.spyOn(ClaudeSessionBindingProvider.prototype, 'discoverChildren');
  const read = vi.spyOn(ClaudeSessionBindingProvider.prototype, 'readUsage');
  try {
    f.start();
    await expect.poll(() => discover.mock.calls.length, { timeout: 1000 }).toBeGreaterThan(0);
    f.stop();
    await expect.poll(() => f.domain.task(f.id).state, { timeout: 1000 }).toBe('paused');
    expect(read.mock.calls.length).toBe(0);
    expect(f.store.eventCount()).toBe(0);
  } finally {
    await f.domain.close?.();
    discover.mockRestore();
    read.mockRestore();
    f.cleanup();
  }
});

test('replayed Start cannot renew the fixed deadline and later file creation cannot restart collection', async () => {
  const f = await fixture();
  const read = vi.spyOn(ClaudeSessionBindingProvider.prototype, 'readUsage');
  try {
    const began = performance.now();
    f.start();
    await delay(900);
    f.start();
    await expect.poll(() => f.domain.task(f.id).state, { timeout: 1600 }).toBe('paused');
    expect(performance.now() - began).toBeLessThan(2600);
    f.child();
    await delay(300);
    expect(f.domain.task(f.id).state).toBe('paused');
    expect(read.mock.calls.length).toBe(0);
    expect(f.store.eventCount()).toBe(0);
  } finally {
    await f.domain.close?.();
    read.mockRestore();
    f.cleanup();
  }
}, 6000);

test('pause revokes an in-flight readiness hold before further discovery or cursor commits', async () => {
  const f = await fixture();
  const discover = vi.spyOn(ClaudeSessionBindingProvider.prototype, 'discoverChildren');
  const read = vi.spyOn(ClaudeSessionBindingProvider.prototype, 'readUsage');
  try {
    f.start();
    await expect.poll(() => discover.mock.calls.length, { timeout: 1000 }).toBeGreaterThan(0);
    const began = performance.now();
    await f.domain.taskAction(f.id, 'pause', {});
    expect(performance.now() - began).toBeLessThan(500);
    const calls = discover.mock.calls.length;
    f.child();
    await delay(100);
    expect(discover.mock.calls.length).toBe(calls);
    expect(read.mock.calls.length).toBe(0);
    expect(f.domain.task(f.id).state).toBe('paused');
    expect(f.store.eventCount()).toBe(0);
    expect(f.store.get<{ cursor: string | null }>('SELECT cursor FROM session_bindings WHERE session_id=?', [f.sid])!.cursor).toBeNull();
  } finally {
    await f.domain.close?.();
    discover.mockRestore();
    read.mockRestore();
    f.cleanup();
  }
});

async function directFixture(resume = true, observation?: (event: unknown) => void) {
  const f = await fixture();
  await f.domain.close?.();
  const observationClock = { now: null as number | null };
  const provider = new ClaudeSessionBindingProvider({
    now: () => observationClock.now ?? Date.now(),
    receiptDir: f.receipts,
    claudeProjectsDir: join(f.root, 'claude-projects'),
    projectRoot: f.project,
    allowCandidateProfiles: true,
    maxFamilyMembers: 3,
    authorizeSource: metadata => assertClaudeHumanPilotSource(scope, f.store, f.id, metadata)
  });
  const scope = issueClaudeHumanPilotScope(f.store, f.id, provider, { untilExplicitStop: true });
  const service = createSessionBindingService({
    store: f.store,
    providers: [provider],
    clock: () => new Date(observationClock.now ?? Date.now()).toISOString(),
    setupFor: () => f.profile.setup,
    humanPilot: scope,
    onFamilyRejection: () => {},
    ...(observation ? { onChildReadiness: observation } : {})
  });
  if (resume) await service.resume(f.id);
  return { ...f, provider, service, observationClock };
}

test('pause revokes queued resume and connect operations instead of letting them restart a held family', async () => {
  const f = await directFixture();
  const discover = vi.spyOn(f.provider, 'discoverChildren');
  const read = vi.spyOn(f.provider, 'readUsage');
  try {
    f.start();
    const first = f.service.tick(f.id).catch(error => error as unknown);
    await expect.poll(() => discover.mock.calls.length).toBeGreaterThan(0);
    const queuedResume = f.service.resume(f.id).then(
      () => 'resumed',
      (error: unknown) => (error instanceof Error ? error.message : 'unknown')
    );
    const queuedConnect = f.service.connect(f.id, 'claude_code', { receipt: f.receipt }).then(
      () => 'connected',
      (error: unknown) => (error instanceof Error ? error.message : 'unknown')
    );
    f.service.pause(f.id);
    f.child();
    await first;
    expect(await queuedResume).toBe('binding_scope_revoked');
    expect(await queuedConnect).toBe('binding_scope_revoked');
    expect(f.service.status(f.id).state).toBe('stopped');
    expect(read.mock.calls.length).toBe(0);
  } finally {
    f.service.pause(f.id);
    discover.mockRestore();
    read.mockRestore();
    f.cleanup();
  }
});

test.each(['steady', 'rollback'] as const)(
  'identity discovery returning after the original deadline cannot release readiness with %s clock',
  async clockMode => {
    const f = await directFixture();
    const original = f.provider.discoverChildren.bind(f.provider);
    let pending = false;
    const discover = vi.spyOn(f.provider, 'discoverChildren').mockImplementation(async identity => {
      const result = await original(identity);
      if (result.gaps.length) {
        pending = true;
        f.child();
      } else if (pending && result.children.length) {
        pending = false;
        if (clockMode === 'rollback') f.observationClock.now = Date.now() - 10000;
        await delay(2050);
      }
      return result;
    });
    const read = vi.spyOn(f.provider, 'readUsage');
    try {
      f.start();
      const failure = await f.service.tick(f.id).then(
        () => null,
        (error: unknown) => error
      );
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe('binding_pilot_family_scope');
      expect(takeFamilyDiagnostic(failure, f.id, f.store)).toEqual({ schema_version: 1, phase: 'tick_discovery', reason_codes: ['child_readiness_timeout'] });
      expect(read.mock.calls.length).toBe(0);
      expect(f.store.eventCount()).toBe(0);
    } finally {
      f.observationClock.now = null;
      f.service.pause(f.id);
      discover.mockRestore();
      read.mockRestore();
      f.cleanup();
    }
  },
  6000
);

test('initial connection waits before usage baselines and excludes pending root and child history', async () => {
  const f = await fixture(true);
  try {
    expect(f.domain.task(f.id).state).toBe('active');
    expect(f.store.eventCount()).toBe(0);
    expect(f.store.get<{ count: number }>('SELECT count(*) AS count FROM session_bindings WHERE task_id=?', [f.id])!.count).toBe(2);
    expect(f.store.get<{ count: number }>('SELECT count(*) AS count FROM observation_gaps WHERE task_id=?', [f.id])!.count).toBe(2);
    f.usage(f.source, 'initial-after-root');
    f.usage(f.childPath, 'initial-after-child', f.agent);
    await expect.poll(() => f.store.eventCount(), { timeout: 3000 }).toBe(2);
  } finally {
    await f.domain.close?.();
    f.cleanup();
  }
});

test('resume shares the family barrier before any usage baseline or collection', async () => {
  const f = await directFixture(false);
  const discover = vi.spyOn(f.provider, 'discoverChildren');
  const read = vi.spyOn(f.provider, 'readUsage');
  try {
    f.start();
    const resume = f.service.resume(f.id);
    await expect.poll(() => discover.mock.calls.length).toBeGreaterThan(0);
    expect(read.mock.calls.length).toBe(0);
    f.usage(f.source, 'resume-held-root');
    f.child();
    f.usage(f.childPath, 'resume-held-child', f.agent);
    await resume;
    expect(f.store.eventCount()).toBe(0);
    f.usage(f.source, 'resume-after-root');
    f.usage(f.childPath, 'resume-after-child', f.agent);
    await delay(300);
    await f.service.tick(f.id);
    expect(f.store.eventCount()).toBe(2);
  } finally {
    f.service.pause(f.id);
    discover.mockRestore();
    read.mockRestore();
    f.cleanup();
  }
});

test('gap and prospective boundary extend through the final family baseline', async () => {
  const f = await directFixture();
  const original = f.provider.readUsage.bind(f.provider);
  let unblock!: () => void;
  const gate = new Promise<void>(resolve => {
    unblock = resolve;
  });
  let rootBaselined = false;
  const read = vi.spyOn(f.provider, 'readUsage').mockImplementation(async (identity, cursor, scope, boundary) => {
    const result = await original(identity, cursor, scope, boundary);
    if (boundary?.baseline && identity.parentSessionId === null && !rootBaselined) {
      rootBaselined = true;
      await gate;
    }
    return result;
  });
  const discover = vi.spyOn(f.provider, 'discoverChildren');
  try {
    f.start();
    const ticking = f.service.tick(f.id);
    await expect.poll(() => discover.mock.calls.length).toBeGreaterThan(0);
    f.child();
    await expect.poll(() => rootBaselined).toBe(true);
    f.usage(f.source, 'between-family-baselines');
    const injectedAt = Date.now();
    await delay(40);
    unblock();
    await ticking;
    const rows = f.store.all<{ observed_since: string }>('SELECT observed_since FROM session_bindings WHERE task_id=?', [f.id]);
    expect(new Set(rows.map(row => row.observed_since)).size).toBe(1);
    expect(Date.parse(rows[0]!.observed_since)).toBeGreaterThan(injectedAt);
    f.usage(f.source, 'after-family-baselines');
    f.usage(f.childPath, 'after-family-child', f.agent);
    await delay(300);
    await f.service.tick(f.id);
    expect(f.store.eventCount()).toBe(2);
    expect(
      f.store
        .all<{ id: string }>("SELECT json_extract(payload,'$.request_id') AS id FROM runtime_evidence")
        .map(row => row.id)
        .sort()
    ).toEqual(['after-family-baselines', 'after-family-child']);
  } finally {
    unblock();
    f.service.pause(f.id);
    discover.mockRestore();
    read.mockRestore();
    f.cleanup();
  }
});

test('readiness observations bind one attempt to the Start and acknowledge only committed family recovery', async () => {
  const observations: Array<Record<string, unknown>> = [];
  const f = await directFixture(true, event => {
    observations.push(event as Record<string, unknown>);
  });
  let ticking: Promise<unknown> | undefined;
  try {
    const cursor = f.store.get<{ cursor: string }>('SELECT cursor FROM session_bindings WHERE session_id=?', [f.sid])!.cursor;
    f.start();
    const start = JSON.parse(readFileSync(join(f.receipts, 'sessions', f.sid, 'agents', f.agent + '.subagent_start.json'), 'utf8')) as {
      receipt_id: string;
      recorded_at: string;
    };
    ticking = f.service.tick(f.id).catch((error: unknown) => error);
    await expect.poll(() => observations.length, { timeout: 700 }).toBe(1);
    const held = observations[0]!;
    expect(held).toMatchObject({
      phase: 'hold_entered',
      taskId: f.id,
      rootSessionId: f.sid,
      generation: f.store.get<{ generation: number }>('SELECT generation FROM tasks WHERE id=?', [f.id])!.generation,
      starts: [{ receiptId: start.receipt_id, agentId: f.agent, recordedAt: start.recorded_at }],
      boundary: null
    });
    expect(held.attemptId).toEqual(expect.any(String));
    expect(f.store.get<{ cursor: string }>('SELECT cursor FROM session_bindings WHERE session_id=?', [f.sid])!.cursor).toBe(cursor);
    expect(f.store.eventCount()).toBe(0);
    f.usage(f.source, 'observation-held-root');
    f.child();
    f.usage(f.childPath, 'observation-held-child', f.agent);
    await ticking;
    expect(observations.map(x => x.phase)).toEqual(['hold_entered', 'rebaseline_complete']);
    const complete = observations[1]!;
    expect(complete.attemptId).toBe(held.attemptId);
    expect(complete.starts).toEqual(held.starts);
    expect(complete.elapsedMs).toEqual(expect.any(Number));
    expect(Date.parse(String(complete.boundary))).toBeLessThan(Date.parse(String(complete.deadline)));
    const family = f.store.all<{ observed_since: string; gaps: string }>('SELECT observed_since,gaps FROM session_bindings WHERE task_id=?', [f.id]);
    expect(family).toHaveLength(2);
    for (const row of family) {
      expect(row.observed_since).toBe(complete.boundary);
      expect(JSON.parse(row.gaps) as unknown).toContain('unobserved_interval');
    }
    expect(
      new Set(
        f.store
          .all<{ session_id: string }>('SELECT session_id FROM observation_gaps WHERE task_id=? AND ended_at=?', [f.id, complete.boundary])
          .map(row => row.session_id)
      ).size
    ).toBe(2);
    expect(f.store.eventCount()).toBe(0);
    f.usage(f.source, 'observation-prospective-root');
    await delay(30);
    await f.service.tick(f.id);
    expect(f.store.eventCount()).toBe(1);
  } finally {
    f.service.pause(f.id);
    await ticking;
    f.cleanup();
  }
});

test('readiness observation failure does not change recovery or the original Stop fence', async () => {
  let observed = 0;
  const f = await directFixture(true, () => {
    observed++;
    throw new Error('synthetic sink failure');
  });
  let ticking: Promise<unknown> | undefined;
  try {
    f.start();
    ticking = f.service.tick(f.id).catch((error: unknown) => error);
    await expect.poll(() => observed, { timeout: 700 }).toBe(1);
    f.stop();
    const error = await ticking;
    expect(error).toBeInstanceOf(Error);
    expect(takeFamilyDiagnostic(error, f.id, f.store)).toMatchObject({ reason_codes: ['child_source_missing'] });
    expect(observed).toBe(1);
    expect(f.store.eventCount()).toBe(0);
  } finally {
    f.service.pause(f.id);
    await ticking;
    f.cleanup();
  }
});

test('selected Claude pilot domain forwards only opt-in actual readiness observations', async () => {
  const observed: Array<Record<string, unknown>> = [];
  const f = await fixture(true, event => {
    observed.push(event as Record<string, unknown>);
  });
  try {
    expect(observed.map(x => x.phase)).toEqual(['hold_entered', 'rebaseline_complete']);
    expect(f.domain.task(f.id).state).toBe('active');
    expect(f.store.eventCount()).toBe(0);
    expect(JSON.stringify(f.domain.task(f.id))).not.toContain(String(observed[0]!.attemptId));
  } finally {
    await f.domain.close?.();
    f.cleanup();
  }
});

test.each(['hold', 'completion'] as const)('diagnostic-only %s lookup failure cannot replace collector recovery or Stop rejection', async phase => {
  const observations: Array<Record<string, unknown>> = [];
  const f = await directFixture(true, event => {
    observations.push(event as Record<string, unknown>);
  });
  const get = f.store.get.bind(f.store);
  let failed = 0;
  const query = vi.spyOn(f.store, 'get').mockImplementation((sql, params) => {
    if (sql === 'SELECT * FROM session_bindings WHERE session_id=? AND task_id=?' && (phase === 'hold' || observations.length === 1)) {
      failed++;
      throw new Error('synthetic diagnostic query failure');
    }
    return get(sql, params);
  });
  let ticking: Promise<unknown> | undefined;
  try {
    f.start();
    ticking = f.service.tick(f.id).then(
      () => null,
      (error: unknown) => error
    );
    await expect.poll(() => (phase === 'hold' ? failed : observations.length), { timeout: 700 }).toBe(1);
    if (phase === 'hold') {
      f.stop();
      const error = await ticking;
      expect(takeFamilyDiagnostic(error, f.id, f.store)).toMatchObject({ reason_codes: ['child_source_missing'] });
      expect(observations).toEqual([]);
    } else {
      f.child();
      expect(await ticking).toBeNull();
      expect(failed).toBe(1);
      expect(observations.map(event => event.phase)).toEqual(['hold_entered']);
      expect(
        new Set(f.store.all<{ session_id: string }>('SELECT session_id FROM observation_gaps WHERE task_id=?', [f.id]).map(row => row.session_id)).size
      ).toBe(2);
      f.usage(f.source, 'post-diagnostic-failure');
      await delay(30);
      await f.service.tick(f.id);
      expect(f.store.eventCount()).toBe(1);
    }
  } finally {
    query.mockRestore();
    f.service.pause(f.id);
    await ticking;
    f.cleanup();
  }
});

test('callback-driven pause still revokes the normal hold even when the callback throws', async () => {
  let pause = () => {};
  const f = await directFixture(true, () => {
    pause();
    throw new Error('synthetic callback failure');
  });
  pause = () => f.service.pause(f.id);
  try {
    f.start();
    await expect(f.service.tick(f.id)).rejects.toThrow('binding_scope_revoked');
    expect(f.store.eventCount()).toBe(0);
  } finally {
    f.service.pause(f.id);
    f.cleanup();
  }
});
