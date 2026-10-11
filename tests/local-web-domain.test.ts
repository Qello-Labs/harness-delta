import { randomUUID } from 'node:crypto';
import { expect, test, vi } from 'vitest';
import { localWebFixture } from './helpers/local-web-fixture.js';
import { projectBaseline } from '../src/local-web-domain.js';
import { createLocalWebServer } from '../src/local-web-server.js';
import { Lifecycle } from '../src/lifecycle.js';
import { Deletion } from '../src/deletion.js';
import { selectTaskPriceTable } from '../src/price-catalog-selection.js';
import { join } from 'node:path';
import { z } from 'zod';
import { createLocalWebDomain } from '../src/local-web-domain.js';
import { codexHumanPilotProfileId } from '../src/session-binding-human-pilot.js';

test.each([
  ['finalized', false, 'finalized'],
  ['unprepared', false, 'external_preparation_required'],
  ['released', false, 'external_preparation_required'],
  ['closed', false, 'external_window_closed'],
  ['missing-provider', false, 'binding_provider_unavailable'],
  ['unqualified', false, 'binding_source_unqualified'],
  ['ready', true, null],
] as const)('session-connect diagnostic selects %s prerequisite without changing eligibility', async (condition, enabled, reason) => {
  const f = localWebFixture(codexHumanPilotProfileId, { product: 'codex', productVersion: '0.160.0' });
  const profile = { ...f.profile,
    ...(condition === 'missing-provider' ? {} : { session_binding: { product: 'codex' as const, receipt_directory: f.root, source_roots: [join(f.home, 'sessions')], project_root: f.project } }),
  };
  let domain = createLocalWebDomain({ store: f.store, metadataFile: f.metadataFile, profiles: [profile] });
  try {
    const { id } = z.object({ id: z.string() }).parse(await domain.createTask({ name: 'Synthetic diagnostic task', project_id: 'project-1', setup_id: f.profile.id }));
    if (condition !== 'unprepared') await domain.taskAction(id, 'apply', {});
    // Deadline-based tasks predate the explicit-stop collection control.
    if (condition === 'closed') f.store.execute('DELETE FROM binding_collection_controls WHERE task_id=?', [id]);
    await domain.close?.();
    domain = createLocalWebDomain({
      store: f.store, metadataFile: f.metadataFile, profiles: [profile],
      ...(['missing-provider', 'unqualified'].includes(condition) ? {} : { nativePilot: { taskId: id, observe: true } }),
    });
    if (condition === 'finalized') f.store.execute("UPDATE tasks SET state='finalized' WHERE id=?", [id]);
    if (condition === 'released') f.store.execute("UPDATE external_preparations SET state='released' WHERE task_id=?", [id]);
    if (condition === 'closed') {
      const life = new Lifecycle(f.store); life.start(id); life.pause(id);
      const startedAt = life.task(id).started_at;
      if (!startedAt) throw new Error('invalid_fixture_window');
      const endsAt = new Date(Date.parse(startedAt) + 3600000).toISOString();
      f.store.execute('UPDATE external_task_contracts SET started_at=?,ends_at=? WHERE task_id=?', [startedAt, endsAt, id]);
      vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(endsAt));
    }
    const snapshot = z.object({ actions: z.array(z.object({ code: z.string(), enabled: z.boolean(), reason: z.string().nullable() })) }).parse(domain.task(id));
    expect(snapshot.actions.find(action => action.code === 'session-connect')).toEqual({ code: 'session-connect', enabled, reason });
    expect(f.store.all('SELECT * FROM session_bindings')).toHaveLength(0);
    expect(f.store.eventCount()).toBe(0);
    expect(f.store.all('SELECT * FROM active_intervals WHERE ended_at IS NULL')).toHaveLength(0);
  } finally { vi.useRealTimers(); await domain.close?.(); f.cleanup(); }
});

test('real Store bridge prepares inactive, persists labels, reads HEAD, respects CLI pause and deleted scope', async () => {
  const f = localWebFixture(); let domain = f.create();
  try {
    const head = projectBaseline(f.project);
    const created = await domain.createTask({ name: 'Synthetic visible task', project_id: 'project-1', setup_id: f.profile.id });
    const task = created as { id: string; version: string; status: string };
    expect(task.status).toBe('draft'); expect(new Lifecycle(f.store).state(task.id)).toBe('registered');
    expect(f.store.all('SELECT * FROM active_intervals')).toHaveLength(0);
    expect(f.store.get<{ code_base_commit: string }>('SELECT code_base_commit FROM comparison_preregistrations WHERE task_id=?', [task.id])?.code_base_commit).toBe(head);
    expect(JSON.stringify(f.store.all('SELECT * FROM tasks'))).not.toContain('Synthetic visible task');
    await domain.close?.(); domain = f.create();
    expect(domain.task(task.id)).toMatchObject({ name: 'Synthetic visible task', version: task.version });
    await domain.taskAction(task.id, 'apply', {});
    expect(domain.task(task.id)).toMatchObject({ status: 'validation_ready', binding: { support: 'synthetic_validation_only' } });
    expect(domain.task(task.id)).toMatchObject({ price: { partial_amount: null }, measurement: { requests: null, window: { started_at: null } }, support_details: { context: 'synthetic_validation_only', product: 'synthetic', complete_cost: false, inference: false } });
    expect(domain.task(task.id).binding).not.toHaveProperty('product');
    expect(await domain.bootstrap()).toMatchObject({ tasks: [domain.task(task.id)] });
    await domain.taskAction(task.id, 'ticket', {});
    const ticket = domain.task(task.id).startup as { ticket_id: string }; const source = f.sourceFor(ticket.ticket_id); f.appendUsage(source);
    f.pick(source.path); const selected = await domain.chooseSession(task.id) as { handle: string };
    await domain.taskAction(task.id, 'connect', { source_handle: selected.handle });
    expect(f.store.eventCount()).toBe(0);
    const before = domain.task(task.id).version; new Lifecycle(f.store).pause(task.id);
    expect(domain.task(task.id).version).not.toBe(before);
    new Deletion(f.store).deleteTask(task.id);
    expect(() => domain.task(task.id)).toThrow('unknown_task');
    expect(await domain.bootstrap()).toMatchObject({ tasks: [] });
  } finally { await domain.close?.(); f.cleanup(); }
});

test.each([
  ['codex-workflow-own-response-v1', 'codex', '0.160.0', 'verified', 'exact_version_only', 'qualification_required'],
  ['codex-workflow-own-response-v1', 'codex', '0.161.0', 'compatibility_unverified', 'unsupported', 'qualification_required'],
  ['codex-workflow-own-response-v1', 'codex', '0.162.1', 'compatibility_unverified', 'unsupported', 'qualification_required'],
  ['claude-workflow-own-trace-v1', 'claude_code', '2.1.291', 'verified', 'unsupported', 'qualification_required'],
  ['claude-workflow-own-trace-v1', 'claude_code', '2.1.294', 'compatibility_unverified', 'unsupported', 'qualification_required'],
  ['claude-workflow-own-trace-v1', 'claude_code', '2.1.296', 'compatibility_unverified', 'unsupported', 'qualification_required'],
  ['codex-01600-ordinary-human-pilot', 'codex', '0.160.0', 'unsupported', 'exact_version_only', 'candidate_pilot'],
  ['claude-ordinary-human-pilot', 'claude_code', '2.1.294', 'unsupported', 'unsupported', 'candidate_pilot'],
  ['claude-ordinary-human-pilot', 'claude_code', '2.1.296', 'unsupported', 'unsupported', 'candidate_pilot'],
  ['codex-01620-ordinary-root-human-pilot', 'codex', '0.162.1', 'unsupported', 'unsupported', 'candidate_root_pilot'],
] as const)('support keeps %s %s %s route boundaries separate', async (profileId, product, productVersion, launch, ticket, family) => {
  const f = localWebFixture(profileId, { product, productVersion }); const domain = f.create();
  try {
    const snapshot = await domain.bootstrap();
    expect(snapshot).toMatchObject({ setups: [{ support_details: {
      context: 'real', product, product_version: productVersion,
      launch: [{ profile_id: profileId, state: launch }], ticket, family, complete_cost: false, inference: false,
    } }] });
    expect(f.store.eventCount()).toBe(0);
    expect(f.store.all('SELECT * FROM active_intervals')).toHaveLength(0);
  } finally { await domain.close?.(); f.cleanup(); }
});

test('configuration-ready real tasks retain session waiting while synthetic tasks use validation readiness', async () => {
  const f = localWebFixture('codex-workflow-own-response-v1', { product: 'codex', productVersion: '0.160.0' });
  const domain = f.create();
  try {
    const created = await domain.createTask({ name: 'Synthetic native-route test', project_id: 'project-1', setup_id: f.profile.id }) as { id: string };
    expect(domain.task(created.id)).toMatchObject({ status: 'draft' });
    await domain.taskAction(created.id, 'apply', {});
    expect(domain.task(created.id)).toMatchObject({
      status: 'waiting_for_session', state: 'registered',
      measurement: { state: 'waiting_connection', window: { started_at: null } },
      support_details: { context: 'real' },
    });
    expect(f.store.eventCount()).toBe(0);
    expect(f.store.all('SELECT * FROM active_intervals')).toHaveLength(0);
  } finally { await domain.close?.(); f.cleanup(); }
});

test('HTTP observation returns promptly, pause settles, human rework retains arm/window and success stays final', async () => {
  const f = localWebFixture(); const domain = f.create(); const origin = 'http://127.0.0.1:4318';
  const app = createLocalWebServer({ origin, domain, metadataFile: f.metadataFile });
  try {
    const created = await domain.createTask({ name: 'Synthetic result task', project_id: 'project-1', setup_id: f.profile.id }) as { id: string };
    const id = created.id;
    await domain.taskAction(id, 'apply', {}); await domain.taskAction(id, 'ticket', {});
    const ticket = domain.task(id).startup as { ticket_id: string }; const source = f.sourceFor(ticket.ticket_id);
    f.pick(source.path); const selection = await domain.chooseSession(id) as { handle: string };
    await domain.taskAction(id, 'connect', { source_handle: selection.handle });
    const baseline = domain.task(id); const csrf = (await app.inject({ url: '/api/bootstrap', headers: { host: '127.0.0.1:4318' } })).json<{ csrf: string }>().csrf;
    const post = async (action: string, body: unknown = {}) => app.inject({ method: 'POST', url: `/api/tasks/${id}/${action}`, payload: JSON.stringify(body),
      headers: { host: '127.0.0.1:4318', origin, 'content-type': 'application/json', 'x-harness-csrf': csrf, 'idempotency-key': randomUUID(), 'if-match': domain.task(id).version } });
    const start = Date.now(); const observing = await post('observe'); expect(observing.statusCode).toBe(200); expect(Date.now() - start).toBeLessThan(1000);
    // Wait only for the exact collector's guarded baseline; never use fixture source contents as evidence.
    await expect.poll(() => f.store.get<{ source_identity: string | null }>("SELECT source_identity FROM codex_workflow_runs WHERE task_id=? AND operation='collect' ORDER BY rowid DESC LIMIT 1", [id])?.source_identity, { timeout: 2000 }).toBeTruthy();
    const controlVersion = domain.task(id).version;
    f.appendUsage(source); await expect.poll(() => f.store.eventCount(), { timeout: 2000 }).toBe(1);
    expect(domain.task(id).version).toBe(controlVersion);
    expect((await post('finish-success')).json()).toMatchObject({ error: 'workflow_run_active' });
    expect((await post('pause')).statusCode).toBe(200);
    expect(domain.task(id)).toMatchObject({ measurement: { state: 'paused' }, reason: null });
    expect((await post('rework')).statusCode).toBe(200);
    expect(domain.task(id)).toMatchObject({ attempt: 2, preparation: { assigned_variant_id: (baseline.preparation as {assigned_variant_id: string}).assigned_variant_id }, measurement: { window: (baseline.measurement as { window: unknown }).window } });
    expect((await post('finish-success')).statusCode).toBe(200);
    expect(domain.task(id)).toMatchObject({ status: 'success', outcome: { status: 'success' } });
    expect((await post('rework')).json()).toMatchObject({ error: 'invalid_transition' });
    expect(f.store.eventCount()).toBe(1);
  } finally { await app.close(); f.cleanup(); }
}, 10000);

test('deleting a sibling preserves retained task reads and price pin while protocol gates stay closed', async () => {
  const f = localWebFixture(); const domain = f.create();
  try {
    const create = () => domain.createTask({ name: 'Synthetic retained task', project_id: 'project-1', setup_id: f.profile.id }) as Promise<{ id: string }>;
    const deleted = await create();
    await domain.taskAction(deleted.id, 'release', { external_session_stopped: true });
    const retained = await create(); const id = retained.id;
    await domain.taskAction(id, 'apply', {}); await domain.taskAction(id, 'ticket', {});
    const ticket = domain.task(id).startup as { ticket_id: string }; const source = f.sourceFor(ticket.ticket_id);
    f.pick(source.path); const selected = await domain.chooseSession(id) as { handle: string };
    await domain.taskAction(id, 'connect', { source_handle: selected.handle });
    const pin = selectTaskPriceTable(f.store, id); const price = domain.task(id).price;
    new Deletion(f.store).deleteTask(deleted.id);
    expect(selectTaskPriceTable(f.store, id)).toEqual(pin);
    expect(domain.task(id)).toMatchObject({ id, price });
    expect(await domain.bootstrap()).toMatchObject({ setups: [], tasks: [{ id, price }] });
    expect(() => create()).toThrow('protocol_not_active');
    await domain.taskAction(id, 'observe', {});
    // Use the public settlement boundary instead of racing the collector's rejection.
    await domain.taskAction(id, 'pause', {});
    expect(domain.task(id).reason).toBe('protocol_not_active');
    expect(f.store.all("SELECT id FROM codex_workflow_runs WHERE task_id=? AND operation='collect'", [id])).toEqual([]);
    await domain.taskAction(id, 'finish-success', {});
    expect(domain.task(id)).toMatchObject({ status: 'success', outcome: { status: 'success' } });
    expect(await domain.bootstrap()).toMatchObject({ tasks: [{ id, status: 'success', price }] });
    expect(() => domain.task(deleted.id)).toThrow('unknown_task');
  } finally { await domain.close?.(); f.cleanup(); }
});
