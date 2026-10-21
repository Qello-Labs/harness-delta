import { createHash, randomUUID } from 'node:crypto';
import { afterEach, expect, test, vi } from 'vitest';
import { ordinaryBindingFixture } from './helpers/ordinary-session-binding-fixture.js';
import { ordinaryTask, ordinaryTaskSettings, revokeOrdinaryObservation, saveOrdinaryProjectSettings } from '../src/ordinary-observation.js';
import { bundledPriceCatalog, digest } from '../src/price-catalog.js';
import { refreshPriceCatalog } from '../src/price-catalog-store.js';
import { BindingUsageRecordSchema, type BindingReadBoundary } from '../src/session-binding-contract.js';
import { createOrdinarySessionBindingService } from '../src/ordinary-session-binding.js';
import { ClaudeSessionBindingProvider } from '../src/session-binding-claude.js';
import { Deletion } from '../src/deletion.js';
import { sessionCompatibility } from '../src/source-compatibility.js';

const fixtures: ReturnType<typeof ordinaryBindingFixture>[] = [];
const fixture = (productVersion = '2.1.296') => { const value = ordinaryBindingFixture(productVersion); fixtures.push(value); return value; };
afterEach(async () => { for (const f of fixtures.splice(0)) await f.cleanup(); });
const deferred = <T>() => {
  let resolve: ((value: T | PromiseLike<T>) => void) | undefined;
  const promise = new Promise<T>(done => { resolve = done; });
  if (!resolve) throw new Error('fixture_resolver_missing');
  return { promise, resolve };
};

test('connect grants proof-scoped active measurement authority before reading an already-running root', async () => {
  const f = fixture();
  f.advance(); const result = await f.connect();
  const native = f.current();
  expect(result).toMatchObject({ status: 'connected', state: 'observing', roots: 1, children: 0,
    selected_root_id: result.session_id, segment_state: 'observing', complete_cost: null, inference: false });
  expect(result.session_id).not.toBe(native.sessionId);
  expect(JSON.parse(f.store.get<{ identity: string }>('SELECT identity FROM session_bindings')?.identity ?? 'null')).toEqual(native);
  expect(f.scopes[0]?.sessions[0]).toMatchObject({ sessionId: result.session_id, rootSessionId: result.session_id,
    sourceId: native.sessionId, nativeSessionId: native.sessionId, processId: native.nativeMapping?.processId });
  expect(f.life.state(f.taskId)).toBe('active');
  expect(f.store.all('SELECT * FROM comparison_assignments')).toEqual([]);
  expect(f.store.all('SELECT * FROM comparison_confirmations')).toEqual([]);
  expect(JSON.stringify(result)).not.toContain('/synthetic/');
  expect(f.bodyReads).toHaveLength(2);
});

test.each([
  ['2.1.296', '2.1.301'],
  ['2.1.301', '2.1.296'],
  ['2.1.296', '2.1.306'],
  ['2.1.301', '2.1.306'],
  ['2.1.306', '2.1.296'],
])('keeps the frozen %s admission when project defaults change to %s', async (version, projectVersion) => {
  const f = fixture(version);
  saveOrdinaryProjectSettings(f.store, 'project', {
    ...ordinaryTaskSettings(f.store, f.taskId), product_version: projectVersion,
  }, f.clock);
  f.usage(); f.advance();
  expect(f.binding.sourceSupported(f.taskId, 'claude_code')).toBe(true);
  const connected = await f.connect();
  expect(sessionCompatibility(f.store, connected.session_id)).toMatchObject({
    product_version: version, parser_version: version, source: 'claude_binding', state: 'compatibility_unverified',
  });
  f.usage(); f.advance();
  await f.binding.tick(f.taskId);
  expect(f.binding.status(f.taskId)).toMatchObject({ requests: 1, complete_cost: null, inference: false });
  expect(f.store.get<{ product_version: string }>('SELECT product_version FROM sessions')?.product_version).toBe(version);
  expect(f.store.all('SELECT * FROM comparison_assignments')).toEqual([]);
  expect(f.store.all('SELECT * FROM comparison_confirmations')).toEqual([]);
});

test('refuses an unadmitted frozen task version before receipt inspection or body reads', async () => {
  const f = fixture('2.1.302');
  expect(() => f.binding.sourceSupported(f.taskId, 'claude_code')).toThrow('binding_source_unqualified');
  await expect(f.connect()).rejects.toThrow('binding_source_unqualified');
  expect(f.inspections).toEqual([]);
  expect(f.bodyReads).toEqual([]);
  expect(f.store.all('SELECT * FROM sessions')).toEqual([]);
});

test('durable baseline excludes more than 1024 requests even when a cursor replays history', async () => {
  const f = fixture();
  for (let index = 0; index < 1030; index++) f.usage();
  await f.connect();
  expect(f.store.all('SELECT * FROM binding_baseline_exclusions')).toHaveLength(1030);
  f.store.execute("UPDATE session_bindings SET cursor='0'", []);
  f.usage(); f.advance();
  await f.binding.tick(f.taskId);
  expect(f.store.eventCount()).toBe(1);
  expect(f.binding.status(f.taskId).requests).toBe(1);
});

test('native fingerprints deduplicate replay while events and runtime use measurement IDs', async () => {
  const f = fixture(); const connected = await f.connect();
  const record = f.usage(); f.advance();
  await f.binding.tick(f.taskId);
  f.store.execute("UPDATE session_bindings SET cursor='0'", []);
  await f.binding.tick(f.taskId);
  const key = createHash('sha256').update(JSON.stringify(['binding-request-v1', 'claude_code', record.requestId])).digest('hex');
  const fingerprint = createHash('sha256').update(JSON.stringify(BindingUsageRecordSchema.parse(record))).digest('hex');
  expect(f.store.get('SELECT * FROM binding_requests')).toEqual({ request_key: key, event_id: key, fingerprint });
  expect(f.store.get<{ session_id: string }>('SELECT session_id FROM events')?.session_id).toBe(connected.session_id);
  expect(f.store.get<{ session_id: string }>('SELECT session_id FROM runtime_evidence')?.session_id).toBe(connected.session_id);
  expect(f.store.eventCount()).toBe(1);
});

test('paused and active native reservations refuse another task before root body reads', async () => {
  const f = fixture(); await f.connect();
  const second = f.task(); f.use(f.binding, second);
  const before = f.bodyReads.length;
  await expect(f.binding.connect(second, 'claude_code', f.receipt())).rejects.toThrow('binding_session_conflict');
  f.use(f.binding); f.binding.pause(f.taskId); f.use(f.binding, second);
  await expect(f.binding.connect(second, 'claude_code', f.receipt())).rejects.toThrow('binding_session_conflict');
  expect(f.bodyReads).toHaveLength(before);
  expect(f.life.state(second)).toBe('registered');
  expect(f.store.all('SELECT * FROM sessions WHERE task_id=?', [second])).toEqual([]);
});

test('stop relinquishes root without human finalization and task two requires a post-stop receipt and new price pin', async () => {
  const f = fixture(); const first = await f.connect(); f.usage(); f.advance(); await f.binding.tick(f.taskId);
  const firstPin = ordinaryTask(f.store, f.taskId)?.price_table_id;
  const oldReceipt = f.receipt();
  f.advance(); await f.binding.stopObservation(f.taskId);
  const bytes = Buffer.from(JSON.stringify({ ...bundledPriceCatalog(), catalog_id: 'ordinary-next', catalog_version: 2 }));
  await refreshPriceCatalog(f.store, () => Promise.resolve(bytes), digest(bytes), f.clock());
  const second = f.task(); f.use(f.binding, second); const reads = f.bodyReads.length;
  await expect(f.binding.connect(second, 'claude_code', oldReceipt)).rejects.toThrow('binding_receipt_stale');
  expect(f.bodyReads).toHaveLength(reads);
  f.advance(); const connected = await f.binding.connect(second, 'claude_code', f.receipt());
  expect(connected.session_id).not.toBe(first.session_id);
  expect(ordinaryTask(f.store, second)?.price_table_id).not.toBe(ordinaryTask(f.store, f.taskId)?.price_table_id);
  expect(ordinaryTask(f.store, f.taskId)?.price_table_id).toBe(firstPin);
  expect(f.life.summary(f.taskId).outcome).toBeNull();
  expect(f.store.all('SELECT * FROM session_bindings')).toHaveLength(2);
  expect(f.store.eventCount()).toBe(1);
  f.usage(); f.advance(); await f.binding.tick(second);
  expect(f.store.eventCount()).toBe(2);
});

test('stop synchronously fences delayed read callbacks and drains before releasing its native reservation', async () => {
  const f = fixture(); await f.connect(); f.usage();
  const entered = deferred<BindingReadBoundary | undefined>(); const release = deferred<void>();
  f.onRead(boundary => { entered.resolve(boundary); return release.promise; });
  const reading = f.binding.tick(f.taskId); const boundary = await entered.promise;
  const stop = f.binding.stopObservation(f.taskId);
  expect(f.store.get<{ state: string }>('SELECT state FROM binding_root_segments')?.state).toBe('stopping');
  expect(() => boundary?.baselineLedger?.add('stale')).toThrow('binding_scope_revoked');
  expect(() => boundary?.baselineLedger?.has('stale')).toThrow('binding_scope_revoked');
  const second = f.task(); f.use(f.binding, second);
  await expect(f.binding.connect(second, 'claude_code', f.receipt())).rejects.toThrow('binding_session_conflict');
  f.use(f.binding); release.resolve();
  await expect(reading).rejects.toThrow('binding_scope_revoked'); await stop;
  expect(f.store.eventCount()).toBe(0);
  expect(f.store.all('SELECT * FROM binding_baseline_exclusions')).toEqual([]);
  expect(f.store.get<{ state: string }>('SELECT state FROM binding_root_segments')?.state).toBe('closed');
});

test('generic finalization releases the ordinary root for another task without old usage', async () => {
  const f = fixture(); await f.connect(); f.usage(); f.advance();
  await f.binding.tick(f.taskId);
  f.advance(); f.life.finalize(f.taskId, 'success', ['accepted']);
  const second = f.task(); f.use(f.binding, second); f.advance();
  await expect(f.binding.connect(second, 'claude_code', f.receipt())).resolves.toMatchObject({ state: 'observing' });
  expect(f.binding.status(f.taskId)).toMatchObject({ selected_root_id: null, requests: 1 });
  expect(f.binding.status(second).requests).toBe(0);
  expect(f.life.summary(f.taskId).outcome).toBe('success');
});

test('generic finalization fences a delayed ordinary read before another task can use its result', async () => {
  const f = fixture(); await f.connect(); f.usage();
  const entered = deferred<BindingReadBoundary | undefined>(); const release = deferred<void>();
  f.onRead(boundary => { entered.resolve(boundary); return release.promise; });
  const reading = f.binding.tick(f.taskId); const boundary = await entered.promise;
  f.advance(); f.life.finalize(f.taskId, 'aborted', []);
  expect(() => boundary?.baselineLedger?.add('after-finalize')).toThrow('binding_scope_revoked');
  release.resolve();
  await expect(reading).rejects.toThrow('binding_scope_revoked');
  expect(f.store.eventCount()).toBe(0);
  expect(f.binding.status(f.taskId).selected_root_id).toBeNull();
});

test('stop also fences acquisition waiting on metadata inspection before any reservation exists', async () => {
  const f = fixture(); const entered = deferred<void>(); const release = deferred<void>();
  f.onInspect(() => { entered.resolve(); return release.promise; });
  const acquisition = f.connect(); await entered.promise;
  const stop = f.binding.stopObservation(f.taskId);
  release.resolve(); await expect(acquisition).rejects.toThrow('binding_scope_revoked'); await stop;
  expect(f.bodyReads).toEqual([]);
  expect(f.store.all('SELECT * FROM binding_root_segments')).toEqual([]);
  expect(f.life.state(f.taskId)).toBe('registered');
});

test('old members are skipped before body while a fresh Start permit admits only its exact source', async () => {
  const f = fixture(); const old = f.identity(f.current()); f.advance();
  const connected = await f.connect(); f.advance(); const fresh = f.identity(f.current()); f.usage(fresh); f.advance();
  await f.binding.tick(f.taskId);
  expect(f.bodyReads).not.toContain(old.sessionId);
  expect(f.bodyReads).toContain(fresh.sessionId);
  expect(f.binding.status(f.taskId)).toMatchObject({ roots: 1, children: 1, requests: 1 });
  expect(f.binding.status(f.taskId).gaps).toContain('binding_unobserved_context');
  const child = f.store.get<{ session_id: string }>("SELECT session_id FROM session_bindings WHERE session_id!=root_id");
  expect(f.scopes.at(-1)?.sessions.find(row => row.sourceId === fresh.sessionId)).toMatchObject({
    sessionId: child?.session_id, rootSessionId: connected.session_id, parentSessionId: connected.session_id,
    nativeSessionId: f.current().sessionId, agentId: fresh.nativeMapping?.agentId,
  });
});

test('handover never migrates task one children into task two', async () => {
  const f = fixture(); await f.connect(); f.advance(); const child = f.identity(f.current()); f.usage(child); f.advance();
  await f.binding.tick(f.taskId); await f.binding.stopObservation(f.taskId);
  const second = f.task(); f.use(f.binding, second); f.advance();
  await f.binding.connect(second, 'claude_code', f.receipt()); const reads = f.bodyReads.length;
  await f.binding.tick(second);
  expect(f.bodyReads.slice(reads)).not.toContain(child.sessionId);
  expect(f.binding.status(second)).toMatchObject({ children: 0, requests: 0 });
  expect(f.binding.status(f.taskId)).toMatchObject({ children: 1, requests: 1 });
});

test('explicit relaunch closes history and pause resume baselines only the exact selected family', async () => {
  const f = fixture(); const first = await f.connect();
  const firstNative = f.current().sessionId;
  f.usage(); f.advance(); await f.binding.tick(f.taskId);
  f.advance(); f.setCurrent(f.identity()); const second = await f.connect();
  f.advance(); const member = f.identity(f.current()); f.usage(member); f.advance(); await f.binding.tick(f.taskId);
  f.binding.pause(f.taskId); f.usage(); f.usage(member); f.advance(); const reads = f.bodyReads.length;
  await f.binding.resume(f.taskId);
  expect(f.bodyReads.slice(reads)).not.toContain(firstNative);
  expect(f.binding.status(f.taskId)).toMatchObject({ roots: 2, children: 1, selected_root_id: second.session_id, requests: 2 });
  f.usage(); f.advance(); await f.binding.tick(f.taskId);
  expect(f.binding.status(f.taskId).requests).toBe(3);
  expect(f.store.get<{ state: string }>('SELECT state FROM binding_root_segments WHERE root_session_id=?', [first.session_id])?.state).toBe('closed');
});

test('clean restart leaves selected root paused with no automatic reads and resumes it explicitly', async () => {
  const f = fixture(); await f.connect(); const historicalNative = f.current().sessionId;
  f.usage(); f.advance(); await f.binding.tick(f.taskId);
  f.advance(); f.setCurrent(f.identity()); const connected = await f.connect();
  await f.binding.close(); const reads = f.bodyReads.length;
  const restart = f.service(); f.use(restart);
  expect(f.bodyReads).toHaveLength(reads);
  expect(restart.resumeAvailable(f.taskId)).toBe(true);
  await restart.resume(f.taskId);
  expect(restart.status(f.taskId)).toMatchObject({ selected_root_id: connected.session_id, roots: 2, requests: 1 });
  expect(f.bodyReads.slice(reads)).not.toContain(historicalNative);
  expect(f.store.get<{ observer_identity: string | null }>('SELECT observer_identity FROM binding_root_segments WHERE root_session_id=?', [connected.session_id])?.observer_identity).not.toBeNull();
});

test('resume exclusion gaps cover the committed family boundary after a root completion during child baseline', async () => {
  const f = fixture(); const connected = await f.connect();
  f.advance(); const member = f.identity(f.current()); f.usage(member); f.advance();
  await f.binding.tick(f.taskId); f.binding.pause(f.taskId);
  let baselines = 0;
  let requestId = '';
  f.onRead(boundary => {
    if (boundary?.baseline && ++baselines === 2) {
      requestId = f.usage().requestId;
      f.advance();
    }
    return Promise.resolve();
  });
  await f.binding.resume(f.taskId);
  const boundary = f.clock();
  expect(f.store.get<{ ended_at: string }>(
    'SELECT max(ended_at) AS ended_at FROM observation_gaps WHERE session_id=?', [connected.session_id])?.ended_at).toBe(boundary);
  await f.binding.tick(f.taskId);
  const key = createHash('sha256').update(JSON.stringify(['binding-request-v1', 'claude_code', requestId])).digest('hex');
  expect(f.store.get('SELECT 1 FROM binding_baseline_exclusions WHERE session_id=? AND request_key=?',
    [connected.session_id, key])).toBeDefined();
  expect(f.binding.status(f.taskId).requests).toBe(1);
});

test('a second instance never steals a live owner even when its timestamps are old', async () => {
  const f = fixture(); await f.connect(); f.binding.pause(f.taskId); const reads = f.bodyReads.length;
  const other = f.service(); f.use(other); f.advance(86400000);
  await expect(other.resume(f.taskId)).rejects.toThrow('binding_observer_owned');
  await expect(other.connect(f.taskId, 'claude_code', f.receipt())).rejects.toThrow('binding_observer_owned');
  expect(f.bodyReads).toHaveLength(reads);
});

test('explicit stop from another instance fences a live owner without taking observation ownership', async () => {
  const f = fixture(); await f.connect(); f.usage();
  const entered = deferred<BindingReadBoundary | undefined>(); const release = deferred<void>();
  f.onRead(boundary => { entered.resolve(boundary); return release.promise; });
  const reading = f.binding.tick(f.taskId); const boundary = await entered.promise;
  const other = f.service();
  await other.stopObservation(f.taskId);
  expect(() => boundary?.baselineLedger?.add('after-stop')).toThrow('binding_scope_revoked');
  expect(other.status(f.taskId).selected_root_id).toBeNull();
  expect(other.status(f.taskId).segment_state).toBeNull();
  release.resolve();
  await expect(reading).rejects.toThrow('binding_scope_revoked');
  expect(f.store.eventCount()).toBe(0);
  expect(f.life.state(f.taskId)).toBe('paused');
});

test('resume refuses process or source changes without repairing immutable identity', async () => {
  const f = fixture(); await f.connect(); f.binding.pause(f.taskId);
  const old = f.store.get<{ identity: string }>('SELECT identity FROM session_bindings')?.identity;
  const original = f.current();
  f.setCurrent({ ...original, sourceIdentity: randomUUID() });
  await expect(f.binding.resume(f.taskId)).rejects.toThrow('binding_identity_mismatch');
  expect(f.store.get<{ identity: string }>('SELECT identity FROM session_bindings')?.identity).toBe(old);
  expect(f.binding.status(f.taskId).segment_state).toBe('paused');
});

test('native request conflicts roll back the entire batch and cursor', async () => {
  const f = fixture(); await f.connect(); const record = f.usage(); f.advance(); await f.binding.tick(f.taskId);
  const cursor = f.store.get<{ cursor: string }>('SELECT cursor FROM session_bindings')?.cursor;
  f.usage();
  f.records.set(f.current().sessionId, [...(f.records.get(f.current().sessionId) ?? []),
    { ...record, occurredAt: f.clock(), payload: { ...record.payload, output_total: { status: 'observed', value: 99, reason: null } } }]);
  f.advance();
  await expect(f.binding.tick(f.taskId)).rejects.toThrow('binding_request_conflict');
  expect(f.store.eventCount()).toBe(1);
  expect(f.store.get<{ cursor: string }>('SELECT cursor FROM session_bindings')?.cursor).toBe(cursor);
});

test.each(['gpt-6.1-sol', 'claudex', 'not-claude-opus', null])('rejects foreign model %s atomically without advancing its cursor', async model => {
  const f = fixture(); await f.connect();
  const cursor = f.store.get<{ cursor: string }>('SELECT cursor FROM session_bindings')?.cursor;
  const supported = f.usage(); const unsupported = f.usage();
  f.records.set(f.current().sessionId, [
    supported, { ...unsupported, payload: { ...unsupported.payload, model } },
  ]);
  f.advance();
  await expect(f.binding.tick(f.taskId)).rejects.toMatchObject(
    model === null ? { name: 'ZodError' } : { message: 'binding_runtime_unsupported' },
  );
  expect(f.store.eventCount()).toBe(0);
  expect(f.store.get<{ cursor: string }>('SELECT cursor FROM session_bindings')?.cursor).toBe(cursor);
  expect(f.store.all('SELECT * FROM binding_requests')).toEqual([]);
});

test('revocation and native tombstone prevent discovery and every body callback', async () => {
  const f = fixture(); await f.connect(); const reads = f.bodyReads.length;
  revokeOrdinaryObservation(f.store, f.taskId, f.clock);
  await expect(f.binding.tick(f.taskId)).rejects.toThrow('binding_scope_revoked');
  expect(f.bodyReads).toHaveLength(reads);
});

test('native tombstones refuse new acquisition before resolve and retain queued forgetting', async () => {
  const f = fixture();
  f.store.execute("INSERT INTO tombstones(kind,id,deleted_at) VALUES ('session',?,?)", [f.current().sessionId, f.clock()]);
  await expect(f.connect()).rejects.toThrow('deleted_identifier');
  expect(f.bodyReads).toEqual([]);
  expect(f.store.all('SELECT * FROM sessions')).toEqual([]);
  f.store.execute("INSERT INTO session_binding_forgets(product,native_session_id,task_id,project_root) VALUES ('claude_code',?,?,?)",
    [f.current().sessionId, f.taskId, '/synthetic/project']);
  await f.binding.flushForgotten();
  expect(f.forgotten).toEqual([f.current().sessionId]);
  expect(f.store.all('SELECT * FROM session_binding_forgets')).toEqual([]);
});

test.each([
  ['2.1.296', '2.2.0'],
  ['2.1.296', '2.1.301'],
  ['2.1.301', '2.1.296'],
])('task version %s refuses proof version %s before acquisition or comparison mutation', async (version, proofVersion) => {
  const f = fixture(version); const request = f.receipt(); const proof = f.proofs.get(request.receipt);
  if (!proof) throw new Error('fixture_proof_missing');
  f.proofs.set(request.receipt, { ...proof, productVersion: proofVersion });
  await expect(f.binding.connect(f.taskId, 'claude_code', request)).rejects.toThrow('binding_identity_mismatch');
  expect(f.bodyReads).toEqual([]);
  expect(f.life.state(f.taskId)).toBe('registered');
  expect(f.store.all('SELECT * FROM comparison_assignments')).toEqual([]);
});

test.each([
  ['2.1.296', '2.1.301'],
  ['2.1.301', '2.1.296'],
])('task version %s refuses resolved identity version %s despite a matching proof', async (version, identityVersion) => {
  const f = fixture(version); const request = f.receipt();
  f.setCurrent({ ...f.current(), productVersion: identityVersion });
  await expect(f.binding.connect(f.taskId, 'claude_code', request)).rejects.toThrow('binding_identity_mismatch');
  expect(f.bodyReads).toEqual([f.current().sessionId]);
  expect(f.store.all('SELECT * FROM session_bindings')).toEqual([]);
  expect(f.store.all('SELECT * FROM session_source_compatibility')).toEqual([]);
});

test('a failed provisional reservation rolls back activation and all measurement rows', async () => {
  const f = fixture();
  f.store.execute("CREATE TRIGGER fixture_reservation_failure BEFORE INSERT ON binding_root_segments BEGIN SELECT RAISE(ABORT,'fixture_conflict'); END", []);
  await expect(f.connect()).rejects.toThrow('fixture_conflict');
  expect(f.life.state(f.taskId)).toBe('registered');
  expect(f.store.all('SELECT * FROM sessions')).toEqual([]);
  expect(f.store.all('SELECT * FROM active_intervals')).toEqual([]);
  expect(f.bodyReads).toEqual([]);
});

test('acquisition body failure leaves an exclusive paused reservation but never a connected binding', async () => {
  const f = fixture();
  f.onResolve(() => Promise.reject(new Error('fixture_source_failed')));
  await expect(f.connect()).rejects.toThrow('fixture_source_failed');
  expect(f.binding.status(f.taskId)).toMatchObject({ state: 'unconnected', roots: 0, segment_state: 'paused' });
  expect(f.binding.resumeAvailable(f.taskId)).toBe(false);
  expect(f.store.all('SELECT * FROM session_bindings')).toEqual([]);
  expect(f.store.get<{ state: string }>('SELECT state FROM binding_root_segments')?.state).toBe('paused');
  const second = f.task(); f.use(f.binding, second);
  await expect(f.binding.connect(second, 'claude_code', f.receipt())).rejects.toThrow('binding_session_conflict');
});

test('member permits authorize only exact metadata and disappear outside the discovery attempt', async () => {
  const f = fixture(); await f.connect(); f.advance(); const child = f.identity(f.current());
  const metadata = f.metadata.get(child.sessionId);
  if (!metadata) throw new Error('fixture_metadata_missing');
  const discover = f.provider.discoverChildren.bind(f.provider);
  f.provider.discoverChildren = async parent => {
    expect(f.binding.memberEligible(f.taskId, metadata)).toBe(true);
    expect(() => f.binding.assertSource(f.taskId, { ...metadata, sourceIdentity: randomUUID() })).toThrow('binding_member_ineligible');
    f.binding.assertSource(f.taskId, metadata);
    return discover(parent);
  };
  await f.binding.tick(f.taskId);
  expect(() => f.binding.assertSource(f.taskId, metadata)).toThrow('binding_scope_revoked');
  f.binding.pause(f.taskId);
  expect(f.binding.memberEligible(f.taskId, metadata)).toBe(false);
});

test.each([
  ['2.1.296', 7],
  ['2.1.301', 2],
  ['2.1.306', 2],
] as const)('version %s admits %s children once despite duplicate metadata admission callbacks', async (version, maxChildren) => {
  const f = fixture(version);
  saveOrdinaryProjectSettings(f.store, 'project', {
    ...ordinaryTaskSettings(f.store, f.taskId), product_version: version === '2.1.296' ? '2.1.301' : '2.1.296',
  }, f.clock);
  for (let index = 0; index < 10; index++) f.identity(f.current());
  f.advance(); await f.connect(); f.advance();
  const fresh = Array.from({ length: maxChildren }, () => f.identity(f.current()));
  await f.binding.tick(f.taskId);
  expect(f.binding.status(f.taskId).children).toBe(maxChildren);
  expect(f.bodyReads.filter(id => fresh.some(member => member.sessionId === id))).toHaveLength(maxChildren * 2);
  expect(f.store.all<{ session_id: string }>('SELECT session_id FROM session_bindings').map(row =>
    sessionCompatibility(f.store, row.session_id)?.product_version)).toEqual(Array.from({ length: maxChildren + 1 }, () => version));
  f.advance(); const overflow = f.identity(f.current()); const reads = f.bodyReads.length;
  await expect(f.binding.tick(f.taskId)).rejects.toThrow('binding_family_limit');
  expect(f.bodyReads.slice(reads)).not.toContain(overflow.sessionId);
});

test('explicit recovery requires a proved-dead process-start owner rather than elapsed time', async () => {
  const f = fixture(); const connected = await f.connect(); f.binding.pause(f.taskId);
  f.store.execute('UPDATE binding_root_segments SET observer_identity=?',
    [JSON.stringify({ pid: process.pid, start: 'synthetic-prior-process-start', instance: randomUUID() })]);
  const restart = f.service(); f.use(restart);
  await restart.resume(f.taskId);
  expect(restart.status(f.taskId)).toMatchObject({ selected_root_id: connected.session_id, state: 'observing', roots: 1 });
});

test('deleting closed task history tombstones its native root and fences the live handover task', async () => {
  const f = fixture(); await f.connect(); await f.binding.stopObservation(f.taskId);
  const second = f.task(); f.advance(); f.use(f.binding, second);
  await f.binding.connect(second, 'claude_code', f.receipt()); const reads = f.bodyReads.length;
  new Deletion(f.store, f.clock).deleteTask(f.taskId);
  expect(f.life.state(second)).toBe('paused');
  expect(f.store.get("SELECT 1 FROM tombstones WHERE kind='session' AND id=?", [f.current().sessionId])).toBeDefined();
  await expect(f.binding.resume(second)).rejects.toThrow('deleted_identifier');
  await expect(f.binding.connect(second, 'claude_code', f.receipt())).rejects.toThrow('deleted_identifier');
  expect(f.bodyReads).toHaveLength(reads);
  await f.binding.flushForgotten();
  expect(f.forgotten).toEqual([f.current().sessionId]);
});

test('deleting an acquiring provisional root fences its pending result and queues native forgetting', async () => {
  const f = fixture(); const entered = deferred<void>(); const release = deferred<void>();
  f.onResolve(() => { entered.resolve(); return release.promise; });
  const acquisition = f.connect(); await entered.promise;
  new Deletion(f.store, f.clock).deleteTask(f.taskId);
  release.resolve(); await expect(acquisition).rejects.toThrow('unknown_task');
  expect(f.store.all('SELECT * FROM sessions')).toEqual([]);
  expect(f.store.get("SELECT 1 FROM tombstones WHERE kind='session' AND id=?", [f.current().sessionId])).toBeDefined();
  await f.binding.flushForgotten();
  expect(f.forgotten).toEqual([f.current().sessionId]);
});

test('pause fences before a clock-regressed gap can fail and forbids subsequent body reads', async () => {
  const f = fixture(); await f.connect(); const correct = f.clock(); const reads = f.bodyReads.length;
  f.setTime('2026-10-13T08:00:00.000Z');
  expect(() => f.binding.pause(f.taskId)).toThrow('invalid_gap');
  expect(f.store.get<{ state: string }>('SELECT state FROM binding_root_segments')?.state).toBe('paused');
  expect(f.store.get<{ state: string; cursor: string | null }>('SELECT state,cursor FROM session_bindings')).toEqual({ state: 'stopped', cursor: null });
  f.setTime(correct);
  await f.binding.tick(f.taskId);
  expect(f.bodyReads).toHaveLength(reads);
});

test('ordinary native admission permits receipt inspection without promoting qualification evidence', async () => {
  const f = fixture();
  const provider = new ClaudeSessionBindingProvider({ receiptDir: '/synthetic/receipts',
    claudeProjectsDir: '/synthetic/projects', projectRoot: f.current().cwd, ordinaryAdmission: true });
  const service = createOrdinarySessionBindingService({ store: f.store, providersForTask: () => [provider], clock: f.clock });
  expect(service.sourceSupported(f.taskId, 'claude_code')).toBe(true);
  await expect(service.connect(f.taskId, 'claude_code', f.receipt())).rejects.toThrow('claude_receipt_missing');
  expect(f.life.state(f.taskId)).toBe('registered');
  await service.close();
});

test.each([
  ['claude-sonnet-4-5', 'low'],
  ['claude-haiku-4-5-20251001', null],
  ['CLAUDE-OPUS-4-6', 'max'],
  ['claude-future-synthetic', 'medium'],
] as const)('records ordinary %s usage at its observed effort %s', async (model, effort) => {
  const f = fixture(); await f.connect();
  const record = f.usage();
  f.records.set(f.current().sessionId, [{ ...record, effort, payload: { ...record.payload, model } }]);
  f.advance();
  await f.binding.tick(f.taskId);
  expect(f.store.get<{ model: string; effort: string | null }>(
    "SELECT json_extract(payload,'$.model') AS model,json_extract(payload,'$.effort') AS effort FROM runtime_evidence",
  )).toEqual({ model, effort });
  expect(f.binding.status(f.taskId)).toMatchObject({ requests: 1, complete_cost: null, cost_coverage: 'partial' });
  expect(f.binding.status(f.taskId).sessions[0]?.models).toEqual([model]);
  if (model === 'claude-future-synthetic') expect(f.binding.status(f.taskId).summary.unpriced_events).toBeGreaterThan(0);
});

test('completed reads fence retained ledger callbacks with their original cursor snapshot', async () => {
  const f = fixture(); let boundary: BindingReadBoundary | undefined;
  f.onRead(value => { boundary = value; return Promise.resolve(); });
  await f.connect();
  expect(() => boundary?.baselineLedger?.add('after-completion')).toThrow('binding_scope_revoked');
  expect(() => boundary?.baselineLedger?.has('after-completion')).toThrow('binding_scope_revoked');
  expect(f.store.all('SELECT * FROM binding_baseline_exclusions')).toEqual([]);
});

test('an exact stop-boundary receipt cannot acquire the native root for task two', async () => {
  const f = fixture(); await f.connect(); f.advance(); await f.binding.stopObservation(f.taskId);
  const request = f.receipt(); const second = f.task(); f.use(f.binding, second);
  const reads = f.bodyReads.length;
  await expect(f.binding.connect(second, 'claude_code', request)).rejects.toThrow('binding_receipt_stale');
  expect(f.bodyReads).toHaveLength(reads);
});

test('resume rechecks persisted ownership inside its writer transaction when another instance wins the claim', async () => {
  const f = fixture(); await f.connect();
  const liveOwner = f.store.get<{ observer_identity: string }>('SELECT observer_identity FROM binding_root_segments')?.observer_identity;
  if (!liveOwner) throw new Error('fixture_owner_missing');
  await f.binding.close(); const restart = f.service(); f.use(restart);
  const transaction = f.store.immediateTransaction.bind(f.store);
  const claim = vi.spyOn(f.store, 'immediateTransaction').mockImplementationOnce(action => {
    f.store.execute('UPDATE binding_root_segments SET observer_identity=?', [liveOwner]);
    return transaction(action);
  });
  const reads = f.bodyReads.length;
  await expect(restart.resume(f.taskId)).rejects.toThrow('binding_observer_owned');
  claim.mockRestore();
  expect(f.bodyReads).toHaveLength(reads);
  expect(f.store.get<{ observer_identity: string }>('SELECT observer_identity FROM binding_root_segments')?.observer_identity).toBe(liveOwner);
});
