import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Lifecycle } from '../src/lifecycle.js';
import { Deletion } from '../src/deletion.js';
import { aggregateTask } from '../src/metrics.js';
import { Collector } from '../src/collection.js';
import { ManagedObservation, recoverManagedRuns, taskManagedEvidence } from '../src/managed-observation.js';
import type { ManagedProducer } from '../src/managed-protocol.js';

const resources: (() => void)[] = [];
afterEach(() => {
  for (const clean of resources.splice(0).reverse()) clean();
});
const at = '2026-01-01T00:00:00.000Z';
const metadata = { type: 'feature', expected_size: 'small', assignee: 'u1', product: 'synthetic', model: 'synthetic-model', criterion_ids: ['c1'] };
const observed = (value: number) => ({ status: 'observed', value, reason: null });
const usage = (sequence: number, input = 10, output = 7) => ({
  kind: 'usage',
  sequence,
  request_id: `request-${sequence}`,
  occurred_at: at,
  payload: {
    kind: 'usage',
    input_total: observed(input),
    cached_input: observed(0),
    output_total: observed(output),
    reasoning_output: observed(0),
    product: 'synthetic',
    product_version: '1.0.0',
    model: 'synthetic-model',
    epoch: 'epoch-1'
  }
});

class Producer implements ManagedProducer {
  identity = { sessionId: 'session-1', product: 'synthetic', version: '1.0.0', model: 'synthetic-model' };
  reads = 0;
  releases = 0;
  stops = 0;
  acknowledgments = 0;
  queue: unknown[] = [];
  ready: Promise<void> = Promise.resolve();
  beforeRead = () => {};
  beforeRelease = () => {};
  prepare(): Promise<void> {
    return this.ready;
  }
  release(): void {
    this.beforeRelease();
    this.releases++;
  }
  read(): unknown {
    this.reads++;
    this.beforeRead();
    return [...this.queue];
  }
  acknowledge(count: number): void {
    this.acknowledgments += count;
    this.queue.splice(0, count);
  }
  stop(): void {
    this.stops++;
  }
}
function setup(file = ':memory:') {
  const root = mkdtempSync(join(tmpdir(), 'managed-test-'));
  const store = new Store(file);
  resources.push(
    () => rmSync(root, { recursive: true, force: true }),
    () => store.close()
  );
  let time = Date.parse(at);
  const clock = () => new Date(time).toISOString();
  const life = new Lifecycle(store, clock);
  life.registerProject('p1', root);
  life.createTask('p1', 't1', metadata);
  life.start('t1');
  const controller = new ManagedObservation(store, clock, { runTimeoutMs: 1000, drainTimeoutMs: 100 });
  const producer = new Producer();
  const prepare = () => controller.prepare({ runId: 'run-1', taskId: 't1', sessionId: 'session-1' }, producer);
  return {
    store,
    life,
    clock,
    controller,
    producer,
    prepare,
    advance: (ms: number) => {
      time += ms;
    }
  };
}
function state(store: Store, id = 'run-1') {
  return store.get<{ state: string; stop_reason: string | null }>('SELECT state,stop_reason FROM observation_runs WHERE id=?', [id]);
}

// Releasing early would expose first-request usage before durable authorization.
test('durable exact linkage and readiness precede first release even with equal timestamps', async () => {
  const { store, controller, producer, prepare } = setup();
  let ready!: () => void;
  producer.ready = new Promise(resolve => {
    ready = resolve;
  });
  const preparing = prepare();
  expect(state(store)?.state).toBe('preparing');
  expect(store.get('SELECT id FROM sessions WHERE id=? AND source_path IS NULL', ['session-1'])).toBeDefined();
  expect(() => controller.submit()).toThrow('managed_not_ready');
  controller.poll();
  expect(producer.reads).toBe(0);
  expect(producer.releases).toBe(0);
  ready();
  await preparing;
  producer.beforeRelease = () => {
    expect(store.get<{ submitted_at: string }>('SELECT submitted_at FROM observation_runs WHERE id=?', ['run-1'])?.submitted_at).toBe(at);
  };
  controller.submit();
  expect(producer.releases).toBe(1);
  expect(() => controller.submit()).toThrow('managed_not_ready');
  producer.queue.push(usage(1));
  controller.poll();
  expect(store.eventCount()).toBe(1);
  expect(controller.evidence('input_total').facts.readyBeforeFirstRequest).toBe('verified');
});

test.each(['paused', 'finalized', 'deleted'] as const)('readiness revoked by %s cannot release or read', async action => {
  const { store, life, controller, producer, prepare, clock } = setup();
  let ready!: () => void;
  producer.ready = new Promise(resolve => {
    ready = resolve;
  });
  const preparing = prepare();
  if (action === 'paused') life.pause('t1');
  if (action === 'finalized') life.finalize('t1', 'success', ['c1']);
  if (action === 'deleted') new Deletion(store, clock).deleteTask('t1');
  ready();
  await expect(preparing).rejects.toThrow('managed_scope_revoked');
  expect(() => controller.submit()).toThrow();
  controller.poll();
  expect(producer.releases).toBe(0);
  expect(producer.reads).toBe(0);
  expect(store.eventCount()).toBe(0);
});

test('inactive or foreign task and reused session are rejected before producer preparation', async () => {
  const { store, life, clock, controller, producer, prepare } = setup();
  life.pause('t1');
  await expect(prepare()).rejects.toThrow('managed_scope_revoked');
  expect(store.get('SELECT id FROM sessions WHERE id=?', ['session-1'])).toBeUndefined();
  life.resume('t1');
  await prepare();
  const another = new ManagedObservation(store, clock, { runTimeoutMs: 1000, drainTimeoutMs: 100 });
  await expect(another.prepare({ runId: 'run-2', taskId: 't1', sessionId: 'session-1' }, producer)).rejects.toThrow();
  await expect(another.prepare({ runId: 'run-2', taskId: 'foreign', sessionId: 'session-2' }, producer)).rejects.toThrow();
  expect(producer.reads).toBe(0);
  expect(producer.releases).toBe(0);
  expect(() => controller.submit()).not.toThrow();
});

test('exit and quiet polls do not seal; last usage after exit drains and commits before sealing', async () => {
  const { store, controller, producer, prepare } = setup();
  await prepare();
  controller.submit();
  producer.queue.push(usage(1), { kind: 'exit' });
  controller.poll();
  expect(state(store)?.state).toBe('draining');
  controller.poll();
  expect(controller.evidence('input_total').facts.terminalAccounting).toBe('unknown');
  producer.queue.push(usage(2, 20, 3), { kind: 'terminal', final_sequence: 2 }, { kind: 'end' });
  controller.poll();
  expect(state(store)?.state).toBe('sealed');
  expect(store.eventCount()).toBe(2);
  const evidence = controller.evidence('input_total');
  expect(evidence.facts).toMatchObject({
    terminalAccounting: 'verified',
    durableFlush: 'verified',
    requestUniverse: 'unknown',
    counterSemantics: 'unknown',
    boundedTopology: 'unknown',
    fixedModel: 'unknown'
  });
  expect(evidence.hasObservedValue).toBe(true);
});

test.each(['finalize', 'pause'] as const)('direct human %s interrupts run and forbids late source reads', async action => {
  const { store, life, controller, producer, prepare } = setup();
  await prepare();
  controller.submit();
  producer.queue.push(usage(1));
  controller.poll();
  if (action === 'finalize') life.finalize('t1', 'success', ['c1']);
  else life.pause('t1');
  expect(state(store)?.state).toBe('interrupted');
  producer.queue.push(usage(2), { kind: 'terminal', final_sequence: 2 }, { kind: 'end' });
  controller.poll();
  expect(producer.reads).toBe(1);
  expect(store.eventCount()).toBe(1);
  expect(controller.evidence('input_total').facts.continuousObservation).toBe('violated');
});

test.each(['cancel', 'timeout', 'crash'] as const)('%s drains bounded partial usage without repairing continuity', async reason => {
  const { store, controller, producer, prepare, advance } = setup();
  await prepare();
  controller.submit();
  if (reason === 'timeout') {
    advance(1000);
    controller.poll();
  } else controller.stop(reason);
  producer.queue.push(usage(1));
  controller.poll();
  advance(100);
  controller.poll();
  expect(state(store)?.state).toBe('interrupted');
  expect(store.eventCount()).toBe(1);
  expect(controller.evidence('input_total').facts).toMatchObject({ continuousObservation: 'violated', terminalAccounting: 'unknown' });
  expect(producer.stops).toBeGreaterThan(0);
});

test('restart interrupts open evidence, excludes old queue and requires a new session', async () => {
  const { store, controller, producer, prepare, clock } = setup();
  await prepare();
  controller.submit();
  producer.queue.push(usage(1));
  controller.poll();
  recoverManagedRuns(store, 't1', clock);
  producer.queue.push(usage(2));
  controller.poll();
  expect(producer.reads).toBe(1);
  const next = new ManagedObservation(store, clock, { runTimeoutMs: 1000, drainTimeoutMs: 100 });
  const nextProducer = new Producer();
  nextProducer.identity.sessionId = 'session-2';
  await next.prepare({ runId: 'run-2', taskId: 't1', sessionId: 'session-2' }, nextProducer);
  next.submit();
  nextProducer.queue.push(usage(1, 0, 0), { kind: 'terminal', final_sequence: 1 }, { kind: 'end' });
  next.poll();
  expect(store.eventCount()).toBe(2);
  expect(taskManagedEvidence(store, 't1', 'input_total').facts.continuousObservation).toBe('violated');
});

test('out-of-order exact replays count once while conflicting identity taints completed evidence', async () => {
  const { store, controller, producer, prepare } = setup();
  await prepare();
  controller.submit();
  producer.queue.push(usage(2), usage(1), usage(1));
  controller.poll();
  expect(store.eventCount()).toBe(2);
  producer.queue.push({ ...usage(1), payload: { ...usage(1).payload, cached_input: observed(1) } });
  expect(() => controller.poll()).toThrow('managed_identity_conflict');
  expect(store.eventCount()).toBe(2);
  expect(state(store)?.state).toBe('interrupted');
  expect(controller.evidence('input_total').facts.immutableIdentity).toBe('violated');
});

test('record, event and terminal evidence roll back together and transport does not consume failed batch', async () => {
  const { store, controller, producer, prepare } = setup();
  await prepare();
  controller.submit();
  store.execute("CREATE TRIGGER reject_usage BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'synthetic_failure'); END", []);
  producer.queue.push(usage(1), { kind: 'terminal', final_sequence: 1 }, { kind: 'end' });
  expect(() => controller.poll()).toThrow('managed_storage_error');
  expect(store.eventCount()).toBe(0);
  expect(store.all('SELECT * FROM observation_records')).toHaveLength(0);
  expect(state(store)?.state).not.toBe('sealed');
  expect(producer.acknowledgments).toBe(0);
  expect(controller.evidence('input_total').facts.durableFlush).not.toBe('verified');
});

test('deletion cascades evidence and tombstones reject queued data and fresh reconstruction', async () => {
  const { store, controller, producer, prepare, clock } = setup();
  await prepare();
  controller.submit();
  producer.queue.push(usage(1));
  controller.poll();
  new Deletion(store, clock).deleteProject('p1');
  producer.queue.push(usage(2));
  controller.poll();
  expect(store.eventCount()).toBe(0);
  expect(store.all('SELECT * FROM observation_runs')).toHaveLength(0);
  expect(store.all('SELECT * FROM observation_records')).toHaveLength(0);
  expect(producer.reads).toBe(1);
  const next = new ManagedObservation(store, clock, { runTimeoutMs: 1000, drainTimeoutMs: 100 });
  await expect(next.prepare({ runId: 'run-2', taskId: 't1', sessionId: 'session-1' }, producer)).rejects.toThrow();
});

test('explicit zero stays observed, no usage stays missing and polling never opens managed channels', async () => {
  const { store, controller, producer, prepare, clock } = setup();
  await prepare();
  controller.submit();
  expect(controller.evidence('input_total').hasObservedValue).toBe(false);
  producer.queue.push(usage(1, 0, 0), { kind: 'terminal', final_sequence: 1 }, { kind: 'end' });
  controller.poll();
  expect(controller.evidence('input_total').hasObservedValue).toBe(true);
  new Collector(store, clock, () => {
    throw new Error('managed_channel_must_not_be_polled');
  }).tick('t1');
  expect(store.all('SELECT * FROM observations')).toHaveLength(0);
});

test('unknown fields and raw transport errors are rejected with fixed diagnostics', async () => {
  const { store, controller, producer, prepare } = setup();
  await prepare();
  controller.submit();
  producer.queue.push({ ...usage(1), response: 'SYNTHETIC_PRIVATE_SENTINEL' });
  expect(() => controller.poll()).toThrow(/^managed_invalid_envelope$/);
  expect(store.eventCount()).toBe(0);
  expect(JSON.stringify(store.all('SELECT * FROM observation_runs'))).not.toContain('SYNTHETIC_PRIVATE_SENTINEL');
});

test('a stale controller cannot attach to a reused run ID after deleting its task', async () => {
  const { store, controller, producer, prepare, life, clock } = setup();
  await prepare();
  controller.submit();
  new Deletion(store, clock).deleteTask('t1');
  life.createTask('p1', 't2', metadata);
  life.start('t2');
  const next = new ManagedObservation(store, clock, { runTimeoutMs: 1000, drainTimeoutMs: 100 });
  const fresh = new Producer();
  fresh.identity.sessionId = 'session-2';
  await next.prepare({ runId: 'run-1', taskId: 't2', sessionId: 'session-2' }, fresh);
  next.submit();
  producer.queue.push(usage(1));
  controller.poll();
  expect(producer.reads).toBe(0);
  expect(store.eventCount()).toBe(0);
  expect(state(store)?.state).toBe('running');
});

test('non-synthetic task metadata cannot authorize a managed producer', async () => {
  const { store, producer, prepare } = setup();
  store.execute('UPDATE tasks SET metadata=? WHERE id=?', [JSON.stringify({ ...metadata, product: 'codex' }), 't1']);
  await expect(prepare()).rejects.toThrow('managed_scope_revoked');
  expect(producer.reads).toBe(0);
  expect(store.all('SELECT * FROM observation_runs')).toHaveLength(0);
});

test('competing acquisition rolls back its session and explicit takeover fences old owner', async () => {
  const { store, controller, producer, prepare, clock } = setup();
  await prepare();
  controller.submit();
  const next = new ManagedObservation(store, clock, { runTimeoutMs: 1000, drainTimeoutMs: 100 });
  const fresh = new Producer();
  fresh.identity.sessionId = 'session-2';
  await expect(next.prepare({ runId: 'run-2', taskId: 't1', sessionId: 'session-2' }, fresh)).rejects.toThrow('managed_storage_error');
  expect(store.get('SELECT id FROM sessions WHERE id=?', ['session-2'])).toBeUndefined();
  recoverManagedRuns(store, 't1', clock);
  await next.prepare({ runId: 'run-2', taskId: 't1', sessionId: 'session-2' }, fresh);
  next.submit();
  producer.queue.push(usage(1));
  controller.poll();
  expect(producer.reads).toBe(0);
});

test('committed submission intent is visible while release fences another connection finalization', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'managed-db-'));
  resources.push(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'store.db');
  const { store, controller, producer, prepare, clock } = setup(file);
  const competing = new Store(file);
  resources.push(() => competing.close());
  competing.execute('PRAGMA busy_timeout=0', []);
  const otherLife = new Lifecycle(competing, clock);
  await prepare();
  producer.beforeRelease = () => {
    expect(competing.get<{ submitted_at: string }>('SELECT submitted_at FROM observation_runs WHERE id=?', ['run-1'])?.submitted_at).toBe(at);
    expect(() => otherLife.finalize('t1', 'success', ['c1'])).toThrow();
  };
  controller.submit();
  otherLife.finalize('t1', 'success', ['c1']);
  controller.poll();
  expect(producer.releases).toBe(1);
  expect(producer.reads).toBe(0);
  expect(state(store)?.state).toBe('interrupted');
});

test.each(
  [
    [{ kind: 'terminal', final_sequence: 0 }, { kind: 'end' }],
    [usage(2), { kind: 'terminal', final_sequence: 2 }, { kind: 'end' }],
    [usage(1), { kind: 'end' }]
  ].map(envelopes => ({ envelopes }))
)('empty or incomplete closure never manufactures an observed value', async ({ envelopes }) => {
  const { controller, producer, prepare } = setup();
  await prepare();
  controller.submit();
  producer.queue.push(...envelopes);
  controller.poll();
  const evidence = controller.evidence('input_total');
  if (envelopes[0]?.kind === 'terminal') {
    expect(evidence.hasObservedValue).toBe(false);
    expect(evidence.facts.terminalAccounting).toBe('verified');
  } else {
    expect(evidence.facts.terminalAccounting).toBe('unknown');
  }
});

test.each(
  [
    [
      { kind: 'terminal', final_sequence: 1 },
      { kind: 'terminal', final_sequence: 2 }
    ],
    [usage(2), { kind: 'terminal', final_sequence: 1 }],
    [{ kind: 'terminal', final_sequence: 1 }, usage(2)],
    [usage(1), { ...usage(2), request_id: 'request-1' }]
  ].map(envelopes => ({ envelopes }))
)('conflicting terminal or request identity rejects the batch and survives recovery', async ({ envelopes }) => {
  const { store, controller, producer, prepare, clock } = setup();
  await prepare();
  controller.submit();
  producer.queue.push(...envelopes);
  expect(() => controller.poll()).toThrow('managed_identity_conflict');
  expect(store.eventCount()).toBe(0);
  expect(producer.acknowledgments).toBe(0);
  recoverManagedRuns(store, 't1', clock);
  expect(controller.evidence('input_total').facts.immutableIdentity).toBe('violated');
});

test('terminal replay is idempotent and clean drain cannot erase prior cancellation', async () => {
  const { store, controller, producer, prepare } = setup();
  await prepare();
  controller.submit();
  controller.stop('cancel');
  producer.queue.push(usage(1), { kind: 'terminal', final_sequence: 1 }, { kind: 'terminal', final_sequence: 1 }, { kind: 'end' });
  controller.poll();
  expect(state(store)?.state).toBe('sealed');
  expect(controller.evidence('input_total').facts).toMatchObject({ continuousObservation: 'violated', terminalAccounting: 'verified' });
});

test('deadline is not extended by quiet draining and clock regression stops reads', async () => {
  const { store, controller, producer, prepare, advance } = setup();
  await prepare();
  controller.submit();
  producer.queue.push({ kind: 'exit' });
  controller.poll();
  advance(50);
  controller.poll();
  advance(50);
  producer.queue.push(usage(1), { kind: 'terminal', final_sequence: 1 }, { kind: 'end' });
  controller.poll();
  expect(producer.reads).toBe(2);
  expect(store.eventCount()).toBe(0);
  expect(state(store)?.state).toBe('interrupted');
  const another = setup();
  await another.prepare();
  another.controller.submit();
  another.advance(-1);
  expect(() => another.controller.poll()).toThrow('managed_clock_regressed');
  expect(another.producer.reads).toBe(0);
});

test('read and acknowledge failures sanitize errors and preserve committed usage only', async () => {
  const first = setup();
  await first.prepare();
  first.controller.submit();
  first.producer.beforeRead = () => {
    throw new Error('SYNTHETIC_PRIVATE_SENTINEL');
  };
  expect(() => first.controller.poll()).toThrow(/^managed_transport_error$/);
  expect(first.store.eventCount()).toBe(0);
  const second = setup();
  await second.prepare();
  second.controller.submit();
  second.producer.queue.push(usage(1));
  second.producer.acknowledge = () => {
    throw new Error('SYNTHETIC_PRIVATE_SENTINEL');
  };
  expect(() => second.controller.poll()).toThrow(/^managed_transport_error$/);
  expect(second.store.eventCount()).toBe(1);
  second.controller.poll();
  expect(second.producer.reads).toBe(1);
});

test('finalization rollback also restores open managed evidence', async () => {
  const { store, life, controller, prepare } = setup();
  await prepare();
  controller.submit();
  store.execute("CREATE TRIGGER reject_outcome BEFORE INSERT ON outcomes BEGIN SELECT RAISE(ABORT, 'synthetic_failure'); END", []);
  expect(() => life.finalize('t1', 'success', ['c1'])).toThrow();
  expect(life.state('t1')).toBe('active');
  expect(state(store)?.state).toBe('running');
  expect(controller.evidence('input_total').facts.continuousObservation).toBe('verified');
});

test.each([{ sessionId: 'foreign-session' }, { product: 'claude_code' }, { version: '9.9.9' }, { model: 'other-model' }])(
  'wrong transport descriptor is rejected before preparation or reads: %j',
  async change => {
    const { store, producer, prepare } = setup();
    producer.identity = { ...producer.identity, ...change };
    let prepared = false;
    producer.prepare = () => {
      prepared = true;
      return Promise.resolve();
    };
    await expect(prepare()).rejects.toThrow('managed_scope_revoked');
    expect(prepared).toBe(false);
    expect(producer.reads).toBe(0);
    expect(store.all('SELECT * FROM observation_runs')).toHaveLength(0);
  }
);

test('transport identity mutation while awaiting readiness prevents release and any read', async () => {
  const { producer, prepare, controller } = setup();
  let ready!: () => void;
  producer.ready = new Promise(resolve => {
    ready = resolve;
  });
  const pending = prepare();
  producer.identity.sessionId = 'foreign-session';
  ready();
  await expect(pending).rejects.toThrow('managed_scope_revoked');
  expect(() => controller.submit()).toThrow();
  controller.poll();
  expect(producer.reads).toBe(0);
});

test('completed flush violation stays sticky while a later run is pending', async () => {
  const { store, controller, producer, prepare, clock } = setup();
  await prepare();
  controller.submit();
  store.execute("CREATE TRIGGER reject_usage BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'synthetic_failure'); END", []);
  producer.queue.push(usage(1));
  expect(() => controller.poll()).toThrow('managed_storage_error');
  store.execute('DROP TRIGGER reject_usage', []);
  const next = new ManagedObservation(store, clock, { runTimeoutMs: 1000, drainTimeoutMs: 100 });
  const fresh = new Producer();
  fresh.identity.sessionId = 'session-2';
  await next.prepare({ runId: 'run-2', taskId: 't1', sessionId: 'session-2' }, fresh);
  expect(taskManagedEvidence(store, 't1', 'input_total').facts.durableFlush).toBe('violated');
});

test('sealed synthetic usage remains partial after successful human finalization', async () => {
  const { store, life, controller, producer, prepare, clock } = setup();
  await prepare();
  controller.submit();
  producer.queue.push(usage(1, 60, 7), { kind: 'terminal', final_sequence: 1 }, { kind: 'end' });
  controller.poll();
  life.finalize('t1', 'success', ['c1']);
  expect(aggregateTask(store, 't1', clock()).usage).toMatchObject({ status: 'partial', partial_tokens: 67, complete_tokens: null });
});

test('storage failure during sealing rolls back usage and closure, retaining the whole queue', async () => {
  const { store, controller, producer, prepare } = setup();
  await prepare();
  controller.submit();
  store.execute(
    "CREATE TRIGGER reject_seal BEFORE UPDATE OF state ON observation_runs WHEN NEW.state='sealed' BEGIN SELECT RAISE(ABORT, 'synthetic_failure'); END",
    []
  );
  producer.queue.push(usage(1), { kind: 'terminal', final_sequence: 1 }, { kind: 'end' });
  expect(() => controller.poll()).toThrow('managed_storage_error');
  expect(producer.queue).toHaveLength(3);
  expect(store.eventCount()).toBe(0);
  expect(controller.evidence('input_total').facts.durableFlush).toBe('violated');
});

test('another connection recovers durable open state without reading or importing its queued data', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'managed-restart-'));
  resources.push(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'store.db');
  const { controller, producer, prepare, clock } = setup(file);
  await prepare();
  controller.submit();
  producer.queue.push(usage(1));
  controller.poll();
  const restarted = new Store(file);
  resources.push(() => restarted.close());
  recoverManagedRuns(restarted, 't1', clock);
  producer.queue.push(usage(2));
  controller.poll();
  expect(producer.reads).toBe(1);
  expect(restarted.eventCount()).toBe(1);
  expect(taskManagedEvidence(restarted, 't1', 'input_total').facts.continuousObservation).toBe('violated');
});

test('retention deletes managed evidence only with finalized task and preserves active runs', async () => {
  const { store, life, controller, producer, prepare, clock } = setup();
  await prepare();
  controller.submit();
  producer.queue.push(usage(1));
  controller.poll();
  const deletion = new Deletion(store, clock);
  expect(() => deletion.applyRetention('p1', '2026-02-01T00:00:00Z')).toThrow('retention_not_configured');
  deletion.configureRetention('p1', 1);
  expect(deletion.applyRetention('p1', '2026-02-01T00:00:00Z')).toBe(0);
  life.finalize('t1', 'success', ['c1']);
  expect(deletion.applyRetention('p1', '2026-02-01T00:00:00Z')).toBe(1);
  expect(store.all('SELECT * FROM observation_runs')).toHaveLength(0);
  expect(store.all('SELECT * FROM observation_records')).toHaveLength(0);
  producer.queue.push(usage(2));
  controller.poll();
  expect(producer.reads).toBe(1);
});

test.each([
  { input_total: observed(-1) },
  { output_total: observed(Number.MAX_SAFE_INTEGER + 1) },
  { cached_input: observed(11) },
  { reasoning_output: observed(8) },
  { model: 'other-model' }
])('malformed or mismatched usage does not enter measurement data: %j', async change => {
  const { store, controller, producer, prepare } = setup();
  await prepare();
  controller.submit();
  producer.queue.push({ ...usage(1), payload: { ...usage(1).payload, ...change } });
  expect(() => controller.poll()).toThrow('managed_invalid_envelope');
  expect(store.eventCount()).toBe(0);
});

test('bounded batch, readiness timeout and release error are explicit non-complete failures', async () => {
  const large = setup();
  await large.prepare();
  large.controller.submit();
  large.producer.queue = Array.from({ length: 257 }, (_, i) => usage(i + 1));
  expect(() => large.controller.poll()).toThrow('managed_invalid_envelope');
  expect(large.store.eventCount()).toBe(0);
  const waiting = setup();
  let ready!: () => void;
  waiting.producer.ready = new Promise(resolve => {
    ready = resolve;
  });
  const pending = waiting.prepare();
  waiting.advance(1000);
  waiting.controller.poll();
  ready();
  await expect(pending).rejects.toThrow();
  expect(waiting.producer.releases).toBe(0);
  expect(waiting.producer.reads).toBe(0);
  const release = setup();
  await release.prepare();
  release.producer.beforeRelease = () => {
    throw new Error('SYNTHETIC_PRIVATE_SENTINEL');
  };
  expect(() => release.controller.submit()).toThrow(/^managed_transport_error$/);
  expect(() => release.controller.submit()).toThrow('managed_not_ready');
  expect(release.store.eventCount()).toBe(0);
});

test('drain deadline is rechecked under the writer lock before touching transport', async () => {
  const { store, producer } = setup();
  let samples: number[] = [0];
  const clock = () => new Date(Date.parse(at) + (samples.length > 1 ? samples.shift()! : samples[0]!)).toISOString();
  const controller = new ManagedObservation(store, clock, { runTimeoutMs: 1000, drainTimeoutMs: 100 });
  await controller.prepare({ runId: 'run-1', taskId: 't1', sessionId: 'session-1' }, producer);
  controller.submit();
  producer.queue.push({ kind: 'exit' });
  controller.poll();
  samples = [99, 100];
  producer.queue.push({ ...usage(1), occurred_at: '2026-01-01T00:00:00.100Z' }, { kind: 'terminal', final_sequence: 1 }, { kind: 'end' });
  expect(() => controller.poll()).toThrow('managed_timeout');
  expect(producer.reads).toBe(1);
  expect(store.eventCount()).toBe(0);
  expect(state(store)?.state).toBe('interrupted');
});

test('read that crosses a drain deadline rolls back instead of certifying closure', async () => {
  const { store, controller, producer, prepare, advance } = setup();
  await prepare();
  controller.submit();
  producer.queue.push({ kind: 'exit' });
  controller.poll();
  advance(99);
  producer.beforeRead = () => {
    advance(1);
  };
  producer.queue.push(usage(1), { kind: 'terminal', final_sequence: 1 }, { kind: 'end' });
  expect(() => controller.poll()).toThrow('managed_timeout');
  expect(store.eventCount()).toBe(0);
  expect(producer.queue).toHaveLength(3);
  expect(controller.evidence('input_total').facts.terminalAccounting).toBe('unknown');
});

test.each([1000, -1])('release rechecks timeout and clock after durable submission intent (%s)', async releaseAt => {
  const { store, producer } = setup();
  let samples: number[] = [0];
  const clock = () => new Date(Date.parse(at) + (samples.length > 1 ? samples.shift()! : samples[0]!)).toISOString();
  const controller = new ManagedObservation(store, clock, { runTimeoutMs: 1000, drainTimeoutMs: 100 });
  await controller.prepare({ runId: 'run-1', taskId: 't1', sessionId: 'session-1' }, producer);
  samples = [999, releaseAt];
  expect(() => controller.submit()).toThrow(releaseAt === -1 ? 'managed_clock_regressed' : 'managed_timeout');
  expect(producer.releases).toBe(0);
  expect(state(store)?.state).toBe('interrupted');
});

test.each([
  { payload: { ...usage(1).payload, cached_input: observed(11) } },
  { payload: { ...usage(1).payload, model: 'different-model' } },
  { occurred_at: '2026-01-01T00:00:10.000Z' }
])('known identity changes taint identity even when replacement semantics are invalid: %j', async change => {
  const { store, controller, producer, prepare, clock } = setup();
  await prepare();
  controller.submit();
  producer.queue.push(usage(1));
  controller.poll();
  producer.queue.push({ ...usage(1), ...change });
  expect(() => controller.poll()).toThrow('managed_identity_conflict');
  expect(store.eventCount()).toBe(1);
  recoverManagedRuns(store, 't1', clock);
  expect(controller.evidence('input_total').facts.immutableIdentity).toBe('violated');
});

test('durable fact JSON uses the approved snake_case metadata boundary', async () => {
  const { store, controller, producer, prepare } = setup();
  await prepare();
  controller.submit();
  producer.queue.push(usage(1), { kind: 'terminal', final_sequence: 1 }, { kind: 'end' });
  controller.poll();
  const row = store.get<{ input_facts: string; output_facts: string }>('SELECT input_facts,output_facts FROM observation_runs WHERE id=?', ['run-1'])!;
  const expected = {
    scope_before_access: 'verified',
    fresh_session: 'verified',
    ready_before_first_request: 'verified',
    continuous_observation: 'verified',
    fixed_model: 'unknown',
    bounded_topology: 'unknown',
    request_universe: 'unknown',
    terminal_accounting: 'verified',
    immutable_identity: 'verified',
    durable_flush: 'verified',
    counter_semantics: 'unknown'
  };
  expect(JSON.parse(row.input_facts)).toEqual(expected);
  expect(JSON.parse(row.output_facts)).toEqual(expected);
  expect(controller.evidence('input_total').facts.terminalAccounting).toBe('verified');
});
