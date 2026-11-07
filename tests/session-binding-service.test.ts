import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { registerHarness } from '../src/harness/harness-config.js';
import { hashBytes } from '../src/core/repository-files.js';
import { ApplicationCoordinator, requireApplication } from '../src/harness/harness-application.js';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, test, vi } from 'vitest';
import { localWebFixture } from './helpers/local-web-fixture.js';
import { createSessionBindingService } from '../src/session-binding-service.js';
import type { BindingUsageRecord, SessionBindingProvider, VerifiedSessionIdentity } from '../src/session-binding-contract.js';
import { Deletion } from '../src/deletion.js';
import { selectTaskPriceTable } from '../src/pricing/price-catalog-selection.js';
import { externalContract } from '../src/core/external-session-contract.js';
import { ExternalTaskSetupSchema, prepareExternalTask } from '../src/workflow/external-session-service.js';
import { codexWorkflowFixture } from './helpers/codex-workflow-fixture.js';
import { codexWorkflowProfileId } from '../src/workflow/codex-workflow-journal.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function fixture() {
  const f = localWebFixture();
  const domain = f.create();
  cleanups.push(async () => {
    await domain.close?.();
    f.cleanup();
  });
  const task = (await domain.createTask({ name: 'Synthetic family', project_id: 'project-1', setup_id: f.profile.id })) as { id: string };
  await domain.taskAction(task.id, 'apply', {});
  // The domain owns the generated setup; read only its isolated private fixture DB.
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(f.metadataFile);
  const row = db.prepare('SELECT setup FROM web_tasks WHERE id=?').get(task.id) as { setup: string };
  db.close();
  const setup = JSON.parse(row.setup) as typeof f.profile.setup;
  let now = new Date(Date.now() + 100).toISOString();
  const identities = new Map<string, VerifiedSessionIdentity>();
  const relations = new Map<string, VerifiedSessionIdentity[]>();
  const records = new Map<string, BindingUsageRecord[]>();
  let reads = 0;
  let resolves = 0;
  const identity = (parentSessionId: string | null = null) => {
    const value: VerifiedSessionIdentity = {
      product: 'codex',
      productVersion: '0.160.0',
      sessionId: randomUUID(),
      sourceRef: f.newRoot().path,
      sourceIdentity: randomUUID(),
      cwd: f.project,
      identityEvidenceId: randomUUID(),
      parentSessionId,
      createdAt: now
    };
    identities.set(value.sessionId, value);
    records.set(value.sessionId, []);
    return value;
  };
  let current = identity();
  const provider: SessionBindingProvider = {
    product: 'codex',
    capabilities: () => ({
      currentIdentity: 'native_hook',
      ancestry: 'verified_relations',
      usage: 'own_requests',
      productionSupported: false,
      maxDepth: 8,
      reasons: ['qualification_required']
    }),
    resolveCurrent: () => {
      resolves++;
      return Promise.resolve(current);
    },
    discoverChildren: parent =>
      Promise.resolve({
        children: (relations.get(parent.sessionId) ?? []).map(value => ({
          parentSessionId: parent.sessionId,
          identity: value,
          relationEvidenceId: value.identityEvidenceId
        })),
        gaps: []
      }),
    readUsage: (session, cursor) => {
      reads++;
      const all = records.get(session.sessionId)!;
      return Promise.resolve({ records: all.slice(cursor === null ? 0 : Number(cursor)), cursor: String(all.length), gaps: [] });
    }
  };
  const providers = [provider];
  const service = createSessionBindingService({ store: f.store, providers, setupFor: () => setup, clock: () => now });
  const usage = (session: VerifiedSessionIdentity, requestId = randomUUID()) => {
    now = new Date(Date.parse(now) + 100).toISOString();
    const observed = (value: number) => ({ status: 'observed' as const, value, reason: null });
    const record: BindingUsageRecord = {
      requestId,
      sessionId: session.sessionId,
      occurredAt: now,
      turnId: 'turn',
      effort: 'high',
      payload: {
        schema_version: 2,
        kind: 'usage',
        product: 'codex',
        product_version: '0.160.0',
        model: 'model-a',
        epoch: 'epoch',
        attribution: 'verified',
        input_total: observed(10),
        cached_input: observed(2),
        output_total: observed(3),
        reasoning_output: observed(1),
        billing_components: [
          { kind: 'ordinary_input', reading: observed(8) },
          { kind: 'cache_read', reading: observed(2) },
          { kind: 'output', reading: observed(3) }
        ]
      }
    };
    records.get(session.sessionId)!.push(record);
    return record;
  };
  const connect = () => service.connect(task.id, 'codex', { receipt: randomUUID() });
  return {
    ...f,
    domain,
    id: task.id,
    service,
    provider,
    providers,
    identity,
    relations,
    records,
    usage,
    connect,
    current: () => current,
    setCurrent: (value: VerifiedSessionIdentity) => {
      current = value;
    },
    advance: () => {
      now = new Date(Date.parse(now) + 1).toISOString();
    },
    setTime: (stamp: string) => {
      now = stamp;
    },
    reads: () => reads,
    resolves: () => resolves
  };
}

test('connect baselines old usage, replay is idempotent, multiple children and a descendant aggregate', async () => {
  const f = await fixture();
  f.usage(f.current());
  expect(await f.connect()).toMatchObject({ status: 'connected', automatic_children: true, cost_coverage: 'partial' });
  expect(f.store.eventCount()).toBe(0);
  const reads = f.reads();
  expect(await f.connect()).toMatchObject({ status: 'already_connected' });
  expect(f.reads()).toBe(reads);
  const a = f.identity(f.current().sessionId);
  const b = f.identity(f.current().sessionId);
  const descendant = f.identity(a.sessionId);
  f.relations.set(f.current().sessionId, [a, b]);
  f.relations.set(a.sessionId, [descendant]);
  f.usage(f.current());
  f.usage(a);
  f.usage(b);
  f.usage(descendant);
  await f.service.tick(f.id);
  await f.service.tick(f.id);
  expect(f.store.eventCount()).toBe(4);
  expect(f.service.status(f.id)).toMatchObject({ roots: 1, children: 3, requests: 4, cost_coverage: 'partial' });
});

test('pause and same/new root restart baseline excluded interval and preserve assignment/window/price', async () => {
  const f = await fixture();
  await f.connect();
  f.usage(f.current());
  await f.service.tick(f.id);
  const assignment = f.store.get('SELECT * FROM comparison_assignments WHERE task_id=?', [f.id]);
  const price = selectTaskPriceTable(f.store, f.id);
  const window = externalContract(f.store, f.id);
  f.service.pause(f.id);
  const reads = f.reads();
  await f.service.tick(f.id);
  expect(f.reads()).toBe(reads);
  expect(f.service.status(f.id).gaps).toContain('unobserved_interval');
  f.usage(f.current());
  await f.connect();
  await f.service.tick(f.id);
  expect(f.store.eventCount()).toBe(1);
  f.setCurrent(f.identity());
  f.usage(f.current());
  await f.connect();
  f.usage(f.current());
  await f.service.tick(f.id);
  expect(f.store.eventCount()).toBe(2);
  expect(f.service.status(f.id)).toMatchObject({ roots: 2 });
  expect(f.store.get('SELECT * FROM comparison_assignments WHERE task_id=?', [f.id])).toEqual(assignment);
  expect(selectTaskPriceTable(f.store, f.id)).toEqual(price);
  expect(externalContract(f.store, f.id)).toEqual(window);
});

test('global native request conflict rolls back child batch and cursor', async () => {
  const f = await fixture();
  await f.connect();
  const request = randomUUID();
  f.usage(f.current(), request);
  await f.service.tick(f.id);
  const child = f.identity(f.current().sessionId);
  f.relations.set(f.current().sessionId, [child]);
  f.usage(child, request);
  await expect(f.service.tick(f.id)).rejects.toThrow('binding_request_conflict');
  expect(f.store.eventCount()).toBe(1);
});

test('a failed pause gap fences collection without inventing a valid interval', async () => {
  const f = await fixture();
  await f.connect();
  const start = f.store.get<{ observed_since: string }>('SELECT observed_since FROM session_bindings')!.observed_since;
  f.setTime(new Date(Date.parse(start) - 1).toISOString());
  expect(() => f.service.pause(f.id)).toThrow('invalid_gap');
  expect(f.store.all<{ state: string; cursor: string | null }>('SELECT state,cursor FROM session_bindings')).toEqual([{ state: 'stopped', cursor: null }]);
  expect(f.store.all('SELECT * FROM observation_gaps')).toEqual([]);
  const reads = f.reads();
  f.setTime(new Date(Date.parse(start) + 1000).toISOString());
  await f.service.tick(f.id);
  expect(f.reads()).toBe(reads);
  expect(f.service.status(f.id)).toMatchObject({ state: 'stopped', gaps: ['unobserved_interval'] });
});

test('a failed pause fences an in-flight child discovery before binding or source reads', async () => {
  const f = await fixture();
  await f.connect();
  const child = f.identity(f.current().sessionId);
  const start = f.store.get<{ observed_since: string }>('SELECT observed_since FROM session_bindings')!.observed_since;
  f.provider.discoverChildren = parent => {
    if (parent.sessionId !== f.current().sessionId) return Promise.resolve({ children: [], gaps: [] });
    f.setTime(new Date(Date.parse(start) - 1).toISOString());
    expect(() => f.service.pause(f.id)).toThrow('invalid_gap');
    f.setTime(new Date(Date.parse(start) + 1000).toISOString());
    return Promise.resolve({ children: [{ parentSessionId: f.current().sessionId, identity: child, relationEvidenceId: child.identityEvidenceId }], gaps: [] });
  };
  const reads = f.reads();
  await expect(f.service.tick(f.id)).rejects.toThrow('binding_scope_revoked');
  expect(f.reads()).toBe(reads);
  expect(f.store.all('SELECT session_id FROM session_bindings')).toHaveLength(1);
  expect(f.store.eventCount()).toBe(0);
});

test('a failed pause fences pending and subsequent root connects until pause recovery', async () => {
  const f = await fixture();
  await f.connect();
  const next = f.identity();
  f.setCurrent(next);
  let resolve!: (value: VerifiedSessionIdentity) => void;
  let entered!: () => void;
  const resolving = new Promise<void>(done => {
    entered = done;
  });
  f.provider.resolveCurrent = () => {
    entered();
    return new Promise(done => {
      resolve = done;
    });
  };
  const pending = f.connect();
  await resolving;
  const start = f.store.get<{ observed_since: string }>('SELECT observed_since FROM session_bindings')!.observed_since;
  f.setTime(new Date(Date.parse(start) - 1).toISOString());
  expect(() => f.service.pause(f.id)).toThrow('invalid_gap');
  f.setTime(new Date(Date.parse(start) + 1000).toISOString());
  const reads = f.reads();
  resolve(next);
  await expect(pending).rejects.toThrow('binding_scope_revoked');
  f.provider.resolveCurrent = () => Promise.resolve(next);
  await expect(f.connect()).rejects.toThrow('binding_scope_revoked');
  expect(f.reads()).toBe(reads);
  expect(f.store.all('SELECT session_id FROM session_bindings')).toHaveLength(1);
  expect(f.store.get('SELECT id FROM sessions WHERE id=?', [next.sessionId])).toBeUndefined();
  f.service.pause(f.id);
  expect(await f.connect()).toMatchObject({ status: 'connected', roots: 2 });
});

test('a pause after the read commit keeps the tick completion from clearing its fence', async () => {
  const f = await fixture();
  await f.connect();
  const start = f.store.get<{ observed_since: string }>('SELECT observed_since FROM session_bindings')!.observed_since;
  const execute = f.store.execute.bind(f.store);
  let queued = false;
  const spy = vi.spyOn(f.store, 'execute').mockImplementation((sql, params) => {
    execute(sql, params);
    if (!queued && sql.startsWith('UPDATE session_bindings SET cursor=')) {
      queued = true;
      queueMicrotask(() => {
        f.setTime(new Date(Date.parse(start) - 1).toISOString());
        expect(() => f.service.pause(f.id)).toThrow('invalid_gap');
        f.setTime(new Date(Date.parse(start) + 1000).toISOString());
      });
    }
  });
  try {
    await f.service.tick(f.id);
    expect(queued).toBe(true);
    expect(f.store.get<{ state: string }>('SELECT state FROM external_preparations')?.state).toBe('stopped');
    expect(f.service.status(f.id).state).toBe('stopped');
    const reads = f.reads();
    f.setCurrent(f.identity());
    await expect(f.connect()).rejects.toThrow('binding_scope_revoked');
    expect(f.reads()).toBe(reads);
  } finally {
    spy.mockRestore();
  }
});

test('deletion and revoked generation during asynchronous read prevent queued writes', async () => {
  const f = await fixture();
  await f.connect();
  f.usage(f.current());
  const original = f.provider.readUsage.bind(f.provider);
  f.provider.readUsage = async (...args) => {
    const result = await original(...args);
    f.service.pause(f.id);
    return result;
  };
  await expect(f.service.tick(f.id)).rejects.toThrow('binding_scope_revoked');
  expect(f.store.eventCount()).toBe(0);
  new Deletion(f.store).deleteTask(f.id);
  const resolves = f.resolves();
  await expect(f.connect()).rejects.toThrow('unknown_task');
  expect(f.resolves()).toBe(resolves);
  expect(f.store.all('SELECT * FROM session_bindings')).toEqual([]);
});

test('rejects ambiguous ancestry, mismatched cwd and unqualified production before source reads', async () => {
  const f = await fixture();
  f.current().cwd = '/synthetic/unrelated';
  await expect(f.connect()).rejects.toThrow('binding_identity_mismatch');
  expect(f.reads()).toBe(0);
  f.current().cwd = f.project;
  await f.connect();
  const child = f.identity('other-parent');
  f.relations.set(f.current().sessionId, [child]);
  await expect(f.service.tick(f.id)).rejects.toThrow('binding_relation_invalid');
  const native = codexWorkflowFixture(codexWorkflowProfileId, 'functional_pilot');
  cleanups.push(() => {
    native.cleanup();
    return Promise.resolve();
  });
  const setup = ExternalTaskSetupSchema.parse({ ...f.profile.setup, workflow: native.input });
  prepareExternalTask(native.store, setup, true);
  const service = createSessionBindingService({ store: native.store, providers: [f.provider], setupFor: () => setup });
  f.provider.capabilities = () => ({
    currentIdentity: 'native_hook',
    ancestry: 'verified_relations',
    usage: 'own_requests',
    productionSupported: true,
    maxDepth: 8,
    reasons: []
  });
  const resolves = f.resolves();
  await expect(service.connect(native.input.assignment.task_id, 'codex', { receipt: randomUUID() })).rejects.toThrow('binding_source_unqualified');
  expect(f.resolves()).toBe(resolves);
});

test('a second platform root preserves the same logical task arm, price and window', async () => {
  const f = await fixture();
  await f.connect();
  const request = randomUUID();
  f.usage(f.current(), request);
  await f.service.tick(f.id);
  const assignment = f.store.get('SELECT * FROM comparison_assignments WHERE task_id=?', [f.id]);
  const price = selectTaskPriceTable(f.store, f.id);
  const window = externalContract(f.store, f.id);
  const member = { ...f.identity(), product: 'claude_code' as const, productVersion: '2.1.291' };
  const candidate: SessionBindingProvider = { ...f.provider, product: 'claude_code', resolveCurrent: () => Promise.resolve(member) };
  f.providers.push(candidate);
  await f.service.connect(f.id, 'claude_code', { receipt: randomUUID() });
  const record = f.usage(member, request);
  record.payload.product = 'claude_code';
  record.payload.product_version = '2.1.291';
  await f.service.tick(f.id);
  await f.service.tick(f.id);
  expect(f.service.status(f.id)).toMatchObject({ roots: 2, requests: 2, cost_coverage: 'partial' });
  expect(f.store.get('SELECT * FROM comparison_assignments WHERE task_id=?', [f.id])).toEqual(assignment);
  expect(selectTaskPriceTable(f.store, f.id)).toEqual(price);
  expect(externalContract(f.store, f.id)).toEqual(window);
  expect(f.store.all<{ product: string }>('SELECT identity FROM session_bindings')).toHaveLength(2);
});

test('session rows and sum preserve missing, observed zero, partial readings and unpriced usage without adding cache/reasoning counters', async () => {
  const f = await fixture();
  await f.connect();
  expect(f.service.status(f.id).sessions[0]).toMatchObject({ requests: null, input_total: { status: 'missing', value: null }, partial_amount: null });
  const child = f.identity(f.current().sessionId);
  f.relations.set(f.current().sessionId, [child]);
  const zero = f.usage(f.current());
  zero.payload.model = 'synthetic-model';
  zero.payload.input_total = { status: 'observed', value: 0, reason: null };
  zero.payload.cached_input = { status: 'observed', value: 0, reason: null };
  zero.payload.output_total = { status: 'observed', value: 0, reason: null };
  zero.payload.reasoning_output = { status: 'observed', value: 0, reason: null };
  if ('schema_version' in zero.payload)
    zero.payload.billing_components = zero.payload.billing_components.map(c => ({ ...c, reading: { status: 'observed', value: 0, reason: null } }));
  const absent = f.usage(child);
  absent.payload.input_total = { status: 'missing', value: null, reason: 'not_available' };
  absent.payload.model = 'no-matched-price';
  if ('schema_version' in absent.payload) absent.payload.billing_components = [{ kind: 'output', reading: absent.payload.output_total }];
  await f.service.tick(f.id);
  f.advance();
  const binding = f.service.status(f.id);
  expect(binding.sessions[0]).toMatchObject({
    requests: 1,
    input_total: { status: 'observed', value: 0 },
    output_total: { status: 'observed', value: 0 },
    partial_amount: '0'
  });
  expect(binding.sessions[1]).toMatchObject({
    requests: 1,
    input_total: { status: 'missing', value: null, statuses: ['missing'] },
    output_total: { status: 'observed', value: 3 },
    partial_amount: null,
    unpriced_events: 1
  });
  expect(binding.summary).toMatchObject({
    requests: 2,
    input_total: { status: 'partial', value: 0, statuses: ['missing', 'observed'] },
    output_total: { status: 'observed', value: 3 },
    partial_amount: '0',
    unpriced_events: 1,
    complete_cost: null
  });
});

test('ordinary synthetic resume needs no owner and excludes paused usage for the family', async () => {
  const f = await fixture();
  await f.connect();
  const child = f.identity(f.current().sessionId);
  f.relations.set(f.current().sessionId, [child]);
  f.usage(f.current());
  f.usage(child);
  await f.service.tick(f.id);
  const assignment = f.store.get('SELECT * FROM comparison_assignments WHERE task_id=?', [f.id]);
  const window = externalContract(f.store, f.id);
  f.service.pause(f.id);
  const reads = f.reads();
  f.usage(f.current());
  f.usage(child);
  await f.service.tick(f.id);
  expect(f.reads()).toBe(reads);
  expect(await f.service.resume(f.id)).toMatchObject({ status: 'reconnected', roots: 1, children: 1 });
  await f.service.tick(f.id);
  expect(f.store.eventCount()).toBe(2);
  for (let i = 0; i < 5; i++) f.usage(f.current());
  f.usage(child);
  await f.service.tick(f.id);
  expect(f.store.eventCount()).toBe(8);
  expect(f.store.get('SELECT * FROM comparison_assignments WHERE task_id=?', [f.id])).toEqual(assignment);
  expect(externalContract(f.store, f.id)).toEqual(window);
  expect(f.service.status(f.id).gaps).toContain('unobserved_interval');
});

test('ordinary resume refuses to select among multiple linked roots', async () => {
  const f = await fixture();
  await f.connect();
  f.setCurrent(f.identity());
  await f.connect();
  f.service.pause(f.id);
  const resolves = f.resolves();
  await expect(f.service.resume(f.id)).rejects.toThrow('binding_reconnect_required');
  expect(f.resolves()).toBe(resolves);
  expect(f.service.status(f.id).state).toBe('stopped');
});

test('ordinary resume rejects configuration drift and a closed window before resolving sources', async () => {
  const f = await fixture();
  await f.connect();
  f.service.pause(f.id);
  const resolves = f.resolves();
  f.setTime(externalContract(f.store, f.id)!.ends_at!);
  await expect(f.service.resume(f.id)).rejects.toThrow('external_window_closed');
  expect(f.resolves()).toBe(resolves);
  const g = await fixture();
  await g.connect();
  g.service.pause(g.id);
  g.store.execute("UPDATE external_preparations SET configuration_digest='changed' WHERE task_id=?", [g.id]);
  const other = g.resolves();
  await expect(g.service.resume(g.id)).rejects.toThrow('external_configuration_drift');
  expect(g.resolves()).toBe(other);
  expect(g.service.status(g.id).state).toBe('stopped');
});

test('older bindings without a connect receipt require explicit reconnect without reading sources', async () => {
  const f = await fixture();
  await f.connect();
  f.store.execute('UPDATE session_bindings SET connect_receipt=NULL', []);
  f.service.pause(f.id);
  const resolves = f.resolves();
  const reads = f.reads();
  expect(f.service.resumeAvailable(f.id)).toBe(false);
  await expect(f.service.resume(f.id)).rejects.toThrow('binding_reconnect_required');
  expect(f.resolves()).toBe(resolves);
  expect(f.reads()).toBe(reads);
  await f.connect();
  expect(f.service.resumeAvailable(f.id)).toBe(true);
});

test('resume pins the retained root identity before lifecycle, binding or baseline mutation', async () => {
  const f = await fixture();
  await f.connect();
  const root = f.current();
  f.service.pause(f.id);
  const before = f.store.all('SELECT * FROM session_bindings');
  const task = f.store.get('SELECT * FROM tasks WHERE id=?', [f.id]);
  const reads = f.reads();
  f.setCurrent(f.identity());
  await expect(f.service.resume(f.id)).rejects.toThrow('binding_identity_mismatch');
  expect(f.store.all('SELECT * FROM session_bindings')).toEqual(before);
  expect(f.store.get('SELECT * FROM tasks WHERE id=?', [f.id])).toEqual(task);
  expect(f.reads()).toBe(reads);
  expect(f.service.status(f.id)).toMatchObject({ state: 'stopped', roots: 1 });
  // Same session with changed source proof is also rejected. A fresh explicit
  // connect remains the only authority for selecting another parent.
  f.setCurrent({ ...root, sourceIdentity: randomUUID() });
  await expect(f.service.resume(f.id)).rejects.toThrow('binding_identity_mismatch');
  expect(f.reads()).toBe(reads);
  f.setCurrent(f.identity());
  expect(await f.connect()).toMatchObject({ status: 'connected', roots: 2 });
});

test('legacy bindings accept new optional names without changing UUID aggregation or silently backfilling stored labels', async () => {
  const f = await fixture();
  await f.connect();
  const root = f.current();
  root.agentMetadata = { source: 'codex_session_meta', nickname: 'Cedar', role: 'reviewer' };
  expect(await f.connect()).toMatchObject({ status: 'already_connected' });
  const a = f.identity(root.sessionId);
  const b = f.identity(root.sessionId);
  a.agentMetadata = { source: 'codex_session_meta', nickname: 'Same', role: 'worker' };
  b.agentMetadata = { source: 'codex_session_meta', nickname: 'Same', role: 'worker' };
  f.relations.set(root.sessionId, [a, b]);
  f.usage(a);
  f.usage(b);
  f.advance();
  await f.service.tick(f.id);
  await f.service.tick(f.id);
  const status = f.service.status(f.id);
  expect(status).toMatchObject({ requests: 2, summary: { input_total: { value: 20 }, output_total: { value: 6 } } });
  expect(status.sessions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ session_id: root.sessionId, agent_metadata: null, models: [] }),
      expect.objectContaining({
        session_id: a.sessionId,
        requests: 1,
        models: ['model-a'],
        agent_metadata: { source: 'codex_session_meta', nickname: 'Same', role: 'worker' }
      }),
      expect.objectContaining({ session_id: b.sessionId, requests: 1 })
    ])
  );
  f.service.pause(f.id);
  expect(await f.connect()).toMatchObject({ status: 'reconnected' });
  await f.service.tick(f.id);
  expect(f.store.eventCount()).toBe(2);
  expect(f.store.get<{ identity: string }>('SELECT identity FROM session_bindings WHERE session_id=?', [root.sessionId])?.identity).not.toContain('Cedar');
});

function applySyntheticHarness(f: Awaited<ReturnType<typeof fixture>>) {
  writeFileSync(join(f.project, 'procedure.md'), 'Synthetic procedure');
  writeFileSync(join(f.project, 'README.md'), 'Synthetic prerequisites');
  const bundle = registerHarness(f.project, {
    schema_version: 1,
    harness_id: 'synthetic',
    version: 'application-v1',
    policy_version: 'synthetic',
    readme_path: 'README.md',
    artifacts: [{ artifact_id: 'instruction', role: 'instruction', source_path: 'procedure.md', target_path: 'harness.md' }]
  }).manifest;
  requireApplication(f.store, f.id, { origin: f.project, bundlePath: 'harness-config/application-v1/manifest.json', bundleHash: bundle.bundle_hash });
  const coordinator = new ApplicationCoordinator(f.store);
  const context = coordinator.prepareHandoff(f.id, { workspace: f.project, workspaceDigest: coordinator.workspace(f.id, f.project).digest, product: 'codex' });
  const identity = { ...f.current(), parentSessionId: null };
  coordinator.registerIdentity(f.id, context.attempt_id, identity);
  const [checkpoint] = coordinator.checkpoint(f.id, { attempt_id: context.attempt_id, paths: ['AGENTS.md'] });
  writeFileSync(join(f.project, 'AGENTS.md'), 'Synthetic applied rules');
  coordinator.report(f.id, {
    attempt_id: context.attempt_id,
    bundle_hash: bundle.bundle_hash,
    outputs: [{ path: 'AGENTS.md', checkpoint_id: checkpoint!.checkpoint_id, sha256: hashBytes('Synthetic applied rules') }],
    checks: [{ check_id: 'synthetic_script', outcome: 'passed' }]
  });
  f.setTime(new Date(Date.now() + 1000).toISOString());
  f.setCurrent(f.identity());
  return coordinator;
}

test('application output drift denies connect before identity or usage access', async () => {
  const f = await fixture();
  applySyntheticHarness(f);
  writeFileSync(join(f.project, 'AGENTS.md'), 'Synthetic drift');
  const resolves = f.resolves(),
    reads = f.reads();
  await expect(f.connect()).rejects.toThrow('application_output_changed');
  expect(f.resolves()).toBe(resolves);
  expect(f.reads()).toBe(reads);
  expect(f.store.eventCount()).toBe(0);
}, 15000);

test('application drift after a source read discards the batch and binds the durable epoch', async () => {
  const f = await fixture();
  applySyntheticHarness(f);
  await f.connect();
  expect(f.store.get('SELECT epoch FROM harness_application_session_epochs WHERE session_id=?', [f.current().sessionId])).toEqual({ epoch: 1 });
  f.usage(f.current());
  const original = f.provider.readUsage.bind(f.provider);
  f.provider.readUsage = async (...args) => {
    const result = await original(...args);
    writeFileSync(join(f.project, 'AGENTS.md'), 'Synthetic drift after read');
    return result;
  };
  await expect(f.service.tick(f.id)).rejects.toThrow('application_output_changed');
  expect(f.store.eventCount()).toBe(0);
  expect(f.store.get<{ cursor: string }>('SELECT cursor FROM session_bindings WHERE session_id=?', [f.current().sessionId])?.cursor).toBe('0');
  expect(f.store.get<{ state: string }>('SELECT state FROM tasks WHERE id=?', [f.id])?.state).toBe('paused');
  expect(f.store.all('SELECT * FROM observation_gaps WHERE task_id=?', [f.id])).not.toHaveLength(0);
}, 15000);

test('application deletion with absent private files still forgets bound identities and prevents queued collection', async () => {
  const f = await fixture();
  applySyntheticHarness(f);
  f.provider.product = 'claude_code';
  f.current().product = 'claude_code';
  await f.service.connect(f.id, 'claude_code', { receipt: randomUUID() });
  const forgotten: string[] = [];
  f.provider.forgetSession = async id => {
    forgotten.push(id);
    await Promise.resolve();
  };
  rmSync(join(f.project, `.harness-delta/applications/${f.id}`), { recursive: true });
  new Deletion(f.store).deleteTask(f.id);
  await f.service.flushForgotten();
  expect(forgotten).toEqual([f.current().sessionId]);
  const reads = f.reads();
  await expect(f.connect()).rejects.toThrow('unknown_task');
  expect(f.reads()).toBe(reads);
  expect(f.store.all('SELECT * FROM harness_application_tasks')).toHaveLength(0);
  expect(f.store.all('SELECT * FROM harness_application_jobs')).toHaveLength(0);
}, 15000);
