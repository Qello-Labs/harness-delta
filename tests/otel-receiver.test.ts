import { afterEach, expect, test } from 'vitest';
import { request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Lifecycle } from '../src/lifecycle.js';
import { Deletion } from '../src/deletion.js';
import { aggregateTask } from '../src/metrics.js';
import { OtelReceiver } from '../src/otel-receiver.js';
import {
  apiError,
  apiRequest,
  assistantResponse,
  launchSessionId,
  logRecord,
  logsRequest,
  profile,
  sessionStart,
  syntheticVersion,
  userPrompt
} from './helpers/otel-fixture.js';

const resources: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const clean of resources.splice(0).reverse()) await clean();
});
const metadata = { type: 'feature', expected_size: 'small', assignee: 'u1', product: 'claude_code', model: 'synthetic-model', criterion_ids: ['c1'] };
const launch = { runId: 'run-1', processId: 'process-1', taskId: 't1', sessionId: launchSessionId, productVersion: syntheticVersion };
const options = { processId: 'process-1' };
const secretHeader = 'Bearer synthetic-user-credential';
let tick: ((ms: number) => void) | undefined;

function setup(taskMetadata: object = metadata) {
  const root = mkdtempSync(join(tmpdir(), 'otel-test-'));
  const store = new Store(':memory:');
  resources.push(
    () => rmSync(root, { recursive: true, force: true }),
    () => store.close()
  );
  let time = Date.parse('2026-01-01T00:00:00.000Z');
  const clock = () => new Date(time).toISOString();
  const life = new Lifecycle(store, clock);
  life.registerProject('p1', root);
  life.createTask('p1', 't1', taskMetadata);
  life.start('t1');
  const advance = (ms: number) => {
    time += ms;
  };
  tick = advance;
  return { store, life, clock, advance };
}
async function open(store: Store, clock: () => string, input = launch) {
  const receiver = await OtelReceiver.start(store, input, profile, { clock });
  resources.push(() => receiver.close());
  tick?.(2000);
  return receiver;
}
interface Reply {
  status: number;
  body: string;
}
function post(
  receiver: OtelReceiver,
  body: unknown,
  init: { path?: string; method?: string; headers?: Record<string, string>; auth?: boolean } = {}
): Promise<Reply> {
  const url = new URL(init.path ?? '/v1/logs', receiver.endpoint);
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  const headers = {
    'content-type': 'application/json',
    authorization: secretHeader,
    ...(init.auth === false ? {} : receiver.exporterHeaders()),
    ...init.headers
  };
  return new Promise((resolve, reject) => {
    const outgoing = request(url, { method: init.method ?? 'POST', headers }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        text += chunk;
      });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: text }));
    });
    outgoing.on('error', reject);
    outgoing.end(payload);
  });
}
const count = (store: Store, table: string) => store.get<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)!.n;
const processRow = (store: Store, id = 'process-1') =>
  store.get<{ state: string; ordering: string; uncertain_reason: string | null; revoke_reason: string | null; next_sequence: number | null }>(
    'SELECT state,ordering,uncertain_reason,revoke_reason,next_sequence FROM otel_processes WHERE id=?',
    [id]
  );
function dump(store: Store): string {
  return JSON.stringify(['otel_processes', 'otel_records', 'events', 'sessions', 'observations'].map(table => store.all(`SELECT * FROM ${table}`)));
}
const ready = [sessionStart(0, options)];

test('the receiver listens only on an ephemeral loopback port after durable registration', async () => {
  const { store, clock } = setup();
  const receiver = await open(store, clock);
  const url = new URL(receiver.endpoint);
  expect(url.hostname).toBe('127.0.0.1');
  expect(['0', '4317', '4318']).not.toContain(url.port);
  expect(processRow(store)).toMatchObject({ state: 'listening', ordering: 'pending' });
  expect(store.get('SELECT product,product_version,source_path FROM sessions WHERE id=?', [launchSessionId])).toEqual({
    product: 'claude_code',
    product_version: syntheticVersion,
    source_path: null
  });
  const headers = receiver.exporterHeaders();
  expect(Object.keys(headers)).toEqual(['x-harness-delta-token']);
  expect(headers['x-harness-delta-token']).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(dump(store)).not.toContain(headers['x-harness-delta-token']);
});

test('registration requires a registered project, an active claude_code task and a matching profile', async () => {
  const inactive = setup();
  inactive.life.pause('t1');
  await expect(OtelReceiver.start(inactive.store, launch, profile, { clock: inactive.clock })).rejects.toThrow('otel_scope_revoked');
  const codex = setup({ ...metadata, product: 'codex' });
  await expect(OtelReceiver.start(codex.store, launch, profile, { clock: codex.clock })).rejects.toThrow('otel_scope_revoked');
  const version = setup();
  await expect(OtelReceiver.start(version.store, { ...launch, productVersion: '1.0.1' }, profile, { clock: version.clock })).rejects.toThrow(
    'otel_unsupported_version'
  );
  expect(count(version.store, 'otel_processes')).toBe(0);
});

test('OTel and file adapter sources are exclusive within one task', async () => {
  const adapter = setup();
  adapter.life.linkSession('t1', 'file-session', '/synthetic/file.jsonl', 'claude_code', '2.1.283');
  await expect(OtelReceiver.start(adapter.store, launch, profile, { clock: adapter.clock })).rejects.toThrow('otel_source_conflict');
  const otel = setup();
  await open(otel.store, otel.clock);
  expect(() => otel.life.linkSession('t1', 'file-session', '/synthetic/file.jsonl', 'claude_code', '2.1.283')).toThrow('source_conflict');
});

test('missing, forged and foreign tokens are rejected before the body is decoded', async () => {
  const { store, clock } = setup();
  const receiver = await open(store, clock);
  const other = await open(store, clock, { ...launch, processId: 'process-2', runId: 'run-2', sessionId: '00000000-0000-4000-8000-000000000002' });
  const before = dump(store);
  // An undecodable body proves ordering: a decoded body would produce 400, not 401.
  for (const headers of [{}, { 'x-harness-delta-token': 'A'.repeat(43) }, other.exporterHeaders()]) {
    expect((await post(receiver, '{not json', { auth: false, headers })).status).toBe(401);
  }
  expect((await post(receiver, logsRequest(ready), { auth: false, headers: other.exporterHeaders() })).status).toBe(401);
  expect(dump(store)).toBe(before);
});

test('only OTLP http/json log posts on known paths are decoded', async () => {
  const { store, clock } = setup();
  const receiver = await open(store, clock);
  expect((await post(receiver, logsRequest(ready), { headers: { 'content-type': 'application/x-protobuf' } })).status).toBe(415);
  expect((await post(receiver, logsRequest(ready), { headers: { 'content-encoding': 'gzip' } })).status).toBe(415);
  expect((await post(receiver, logsRequest(ready), { path: '/v1/other' })).status).toBe(404);
  expect((await post(receiver, '', { method: 'GET' })).status).toBe(405);
  expect((await post(receiver, '{not json')).status).toBe(400);
  expect((await post(receiver, { resourceLogs: 'x' })).status).toBe(400);
  expect(count(store, 'otel_records')).toBe(0);
  expect(processRow(store)).toMatchObject({ state: 'listening', ordering: 'pending' });
});

test('oversized bodies are dropped undecoded', async () => {
  const { store, clock } = setup();
  const receiver = await OtelReceiver.start(store, launch, profile, { clock, maxBodyBytes: 64 });
  resources.push(() => receiver.close());
  expect((await post(receiver, logsRequest(ready))).status).toBe(413);
  expect(count(store, 'otel_records')).toBe(0);
});

test('an ordered batch stores allowlisted records and api_request usage as partial data', async () => {
  const { store, clock, advance } = setup();
  const receiver = await open(store, clock);
  advance(5000);
  const reply = await post(
    receiver,
    logsRequest([
      sessionStart(0, options),
      userPrompt(1, options),
      apiRequest(2, options),
      apiError(3, options),
      apiRequest(4, options, { query_source: 'private-subagent-name', input_tokens: 5 })
    ])
  );
  expect(reply).toEqual({ status: 200, body: '{}' });
  expect(count(store, 'otel_records')).toBe(5);
  expect(count(store, 'events')).toBe(2);
  expect(processRow(store)).toMatchObject({ state: 'listening', ordering: 'ready', next_sequence: 5 });
  const usage = store
    .all<{ payload: string }>('SELECT payload FROM events ORDER BY occurred_at,source_key')
    .map(row => JSON.parse(row.payload) as Record<string, unknown>);
  expect(usage).toContainEqual({
    kind: 'usage',
    product: 'claude_code',
    product_version: syntheticVersion,
    model: 'synthetic-model',
    epoch: 'process-1',
    input_total: { status: 'observed', value: 15, reason: null },
    cached_input: { status: 'observed', value: 3, reason: null },
    output_total: { status: 'observed', value: 7, reason: null },
    reasoning_output: { status: 'unmeasurable', value: null, reason: 'unsupported' }
  });
  const categories = store
    .all<{ payload: string }>("SELECT payload FROM otel_records WHERE event_type IN ('api_request','api_error')")
    .map(row => (JSON.parse(row.payload) as { query_source_category: string }).query_source_category)
    .sort();
  expect(categories).toEqual(['compact', 'main', 'other']);
  const text = dump(store);
  for (const value of [
    'synthetic.person',
    'org-synthetic',
    'account-synthetic',
    'synthetic-repo',
    'synthetic-host',
    'private-subagent-name',
    'repl_main_thread',
    'synthetic private error text',
    '/synthetic/private',
    'synthetic-private-agent',
    '500000',
    'synthetic-user-credential',
    receiver.exporterHeaders()['x-harness-delta-token']!
  ])
    expect(text).not.toContain(value);
  const report = aggregateTask(store, 't1', '2026-01-01T01:00:00.000Z');
  expect(report.usage).toMatchObject({ status: 'missing', complete_tokens: null, partial_tokens: null, legacy_unverified: { partial_tokens: 39 } });
});

test('metrics and traces are acknowledged without decoding and never become usage', async () => {
  const { store, clock } = setup();
  const receiver = await open(store, clock);
  expect((await post(receiver, '{"resourceMetrics":[]}', { path: '/v1/metrics' })).status).toBe(200);
  expect((await post(receiver, 'not decoded', { path: '/v1/metrics', headers: { 'content-type': 'application/x-protobuf' } })).status).toBe(200);
  expect((await post(receiver, '{}', { path: '/v1/traces' })).status).toBe(200);
  expect((await post(receiver, '{}', { path: '/v1/metrics', auth: false })).status).toBe(401);
  expect(count(store, 'events')).toBe(0);
  expect(count(store, 'otel_records')).toBe(0);
});

test('a replayed batch is idempotent', async () => {
  const { store, clock } = setup();
  const receiver = await open(store, clock);
  const batch = logsRequest([sessionStart(0, options), apiRequest(1, options)]);
  expect((await post(receiver, batch)).status).toBe(200);
  const before = dump(store);
  expect((await post(receiver, batch)).status).toBe(200);
  expect(dump(store).replace(/"updated_at":"[^"]+"/g, '')).toBe(before.replace(/"updated_at":"[^"]+"/g, ''));
});

test('a conflicting payload for an existing key is rejected and ends measurement', async () => {
  const { store, clock } = setup();
  const receiver = await open(store, clock);
  expect((await post(receiver, logsRequest([sessionStart(0, options), apiRequest(1, options)]))).status).toBe(200);
  const events = count(store, 'events');
  expect((await post(receiver, logsRequest([apiRequest(1, options, { output_tokens: 8 })]))).status).toBe(400);
  expect(processRow(store)).toMatchObject({ state: 'revoked', ordering: 'uncertain', uncertain_reason: 'identity_conflict' });
  expect(count(store, 'events')).toBe(events);
  expect((await post(receiver, logsRequest([apiRequest(2, options)]))).status).toBe(403);
});

test('the same request id at a different sequence is a conflict, and the batch is rolled back', async () => {
  const { store, clock } = setup();
  const receiver = await open(store, clock);
  expect((await post(receiver, logsRequest([sessionStart(0, options), apiRequest(1, options)]))).status).toBe(200);
  expect((await post(receiver, logsRequest([apiRequest(2, options), apiRequest(3, options, { request_id: 'req_synthetic_1' })]))).status).toBe(400);
  expect(count(store, 'otel_records')).toBe(2);
  expect(processRow(store)).toMatchObject({ uncertain_reason: 'identity_conflict' });
});

test('usage without the session-start event at the lowest sequence is uncertain, not measured', async () => {
  for (const batch of [[apiRequest(0, options)], [sessionStart(1, options), apiRequest(2, options)], [userPrompt(0, options)]]) {
    const { store, clock } = setup();
    const receiver = await open(store, clock);
    expect((await post(receiver, logsRequest(batch))).status).toBe(200);
    expect(count(store, 'events')).toBe(0);
    expect(processRow(store)).toMatchObject({ state: 'revoked', ordering: 'uncertain', uncertain_reason: 'ordering_missing' });
    expect(store.get('SELECT status,reason,ended_at FROM observations')).toEqual({ status: 'unmeasurable', reason: 'incomplete', ended_at: null });
    expect((await post(receiver, logsRequest([sessionStart(0, options)]))).status).toBe(403);
  }
});

test('a managed settings source is treated as a possible exporter override', async () => {
  const { store, clock } = setup();
  const receiver = await open(store, clock);
  expect((await post(receiver, logsRequest([sessionStart(0, options, ['file']), apiRequest(1, options)]))).status).toBe(200);
  expect(count(store, 'events')).toBe(0);
  expect(processRow(store)).toMatchObject({ uncertain_reason: 'managed_override' });
});

test('a later managed settings change with a source ends measurement but keeps the earlier prefix', async () => {
  const { store, clock } = setup();
  const receiver = await open(store, clock);
  const change = sessionStart(2, options, ['remote']);
  change.attributes = change.attributes.map(item => (item.key === 'managed_settings.trigger' ? { key: item.key, value: { stringValue: 'change' } } : item));
  expect((await post(receiver, logsRequest([sessionStart(0, options), apiRequest(1, options), change, apiRequest(3, options)]))).status).toBe(200);
  expect(count(store, 'events')).toBe(1);
  expect(processRow(store)).toMatchObject({ uncertain_reason: 'managed_override', next_sequence: 2 });
});

test('a sequence gap keeps the contiguous prefix and opens an unmeasurable window', async () => {
  const { store, clock, advance } = setup();
  const receiver = await open(store, clock);
  expect((await post(receiver, logsRequest([sessionStart(0, options), apiRequest(1, options, {})]))).status).toBe(200);
  advance(60000);
  expect((await post(receiver, logsRequest([apiRequest(3, options, {}), apiRequest(4, options)]))).status).toBe(200);
  expect(count(store, 'events')).toBe(1);
  expect(processRow(store)).toMatchObject({ state: 'revoked', ordering: 'uncertain', uncertain_reason: 'sequence_gap', next_sequence: 2 });
  expect(store.get('SELECT started_at,status,reason FROM observations')).toEqual({
    started_at: '2026-01-01T00:00:01.000Z',
    status: 'unmeasurable',
    reason: 'incomplete'
  });
  const report = aggregateTask(store, 't1', '2026-01-01T01:00:00.000Z');
  expect(report.usage.status).toBe('missing');
  expect(report.usage.compatibility.legacy_unverified_events).toBeGreaterThan(0);
  expect(report.observation_windows).toContainEqual(expect.objectContaining({ status: 'unmeasurable', reason: 'incomplete' }));
});

test('records out of order within one batch are ordered by sequence', async () => {
  const { store, clock } = setup();
  const receiver = await open(store, clock);
  expect((await post(receiver, logsRequest([apiRequest(2, options), sessionStart(0, options), apiRequest(1, options)]))).status).toBe(200);
  expect(processRow(store)).toMatchObject({ ordering: 'ready', next_sequence: 3 });
});

test('version, process attribute and first session mismatches are scope mismatches', async () => {
  const cases = [
    [sessionStart(0, { ...options, version: '1.0.1' })],
    [sessionStart(0, { processId: 'process-9' })],
    [sessionStart(0, { ...options, sessionId: '00000000-0000-4000-8000-000000000099' })],
    [sessionStart(0, options), apiRequest(1, { ...options, version: '1.0.1' })]
  ];
  for (const batch of cases) {
    const { store, clock } = setup();
    const receiver = await open(store, clock);
    expect((await post(receiver, logsRequest(batch))).status).toBe(200);
    expect(processRow(store)).toMatchObject({ state: 'revoked', uncertain_reason: 'scope_mismatch' });
    expect(count(store, 'events')).toBe(0);
  }
});

test('a new session id after /clear stays linked to the run', async () => {
  const { store, clock } = setup();
  const receiver = await open(store, clock);
  const cleared = '00000000-0000-4000-8000-000000000003';
  expect(
    (
      await post(
        receiver,
        logsRequest([
          sessionStart(0, options),
          apiRequest(1, options),
          sessionStart(2, { ...options, sessionId: cleared }),
          apiRequest(3, { ...options, sessionId: cleared })
        ])
      )
    ).status
  ).toBe(200);
  expect(store.all('SELECT session_id FROM events ORDER BY session_id')).toEqual([{ session_id: launchSessionId }, { session_id: cleared }]);
  expect(store.get('SELECT task_id,product,source_path FROM sessions WHERE id=?', [cleared])).toEqual({
    task_id: 't1',
    product: 'claude_code',
    source_path: null
  });
  expect(processRow(store)).toMatchObject({ ordering: 'ready', next_sequence: 4 });
});

test('a later session id owned by another task or deleted is a scope mismatch', async () => {
  const { store, clock, life } = setup();
  life.createTask('p1', 't2', metadata);
  store.execute('INSERT INTO sessions(id,project_id,task_id,product) VALUES (?,?,?,?)', ['00000000-0000-4000-8000-000000000004', 'p1', 't2', 'claude_code']);
  store.execute("INSERT INTO tombstones(kind,id,deleted_at) VALUES ('session','00000000-0000-4000-8000-000000000005','2026-01-01T00:00:00.000Z')", []);
  for (const [index, sessionId] of ['00000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000005'].entries()) {
    const receiver = await open(store, clock, {
      ...launch,
      runId: `run-${sessionId.slice(-1)}`,
      processId: `process-${sessionId.slice(-1)}`,
      sessionId: `00000000-0000-4000-8000-00000000010${sessionId.slice(-1)}`
    });
    const own = {
      processId: `process-${sessionId.slice(-1)}`,
      sessionId: `00000000-0000-4000-8000-00000000010${sessionId.slice(-1)}`,
      at: `2026-01-01T00:00:0${1 + index * 2}.000Z`
    };
    expect((await post(receiver, logsRequest([sessionStart(0, own), apiRequest(1, { ...own, sessionId })]))).status).toBe(200);
    expect(processRow(store, own.processId)).toMatchObject({ uncertain_reason: 'scope_mismatch' });
  }
  expect(count(store, 'events')).toBe(0);
});

test('raw body events show content capture was enabled and end measurement', async () => {
  const { store, clock } = setup();
  const receiver = await open(store, clock);
  expect((await post(receiver, logsRequest([sessionStart(0, options), logRecord('api_request_body', 1, { body: 'synthetic content' }, options)]))).status).toBe(
    200
  );
  expect(processRow(store)).toMatchObject({ uncertain_reason: 'content_enabled' });
  expect(dump(store)).not.toContain('synthetic content');
});

test('an unredacted prompt shows content capture was enabled and ends measurement', async () => {
  const { store, clock } = setup();
  const receiver = await open(store, clock);
  expect((await post(receiver, logsRequest([sessionStart(0, options), userPrompt(1, options, 'synthetic prompt text')]))).status).toBe(200);
  expect(processRow(store)).toMatchObject({ uncertain_reason: 'content_enabled' });
  expect(dump(store)).not.toContain('synthetic prompt text');
});

test('an unredacted response ends measurement after earlier batches stay partial', async () => {
  const { store, clock } = setup();
  const receiver = await open(store, clock);
  expect((await post(receiver, logsRequest([sessionStart(0, options), apiRequest(1, options)]))).status).toBe(200);
  expect((await post(receiver, logsRequest([assistantResponse(2, options, 'synthetic response text')]))).status).toBe(200);
  expect(processRow(store)).toMatchObject({ uncertain_reason: 'content_enabled' });
  expect(count(store, 'events')).toBe(1);
  expect(dump(store)).not.toContain('synthetic response text');
});

test('content exposure is reported even when an invalid record precedes it in the batch', async () => {
  const { store, clock } = setup();
  const receiver = await open(store, clock);
  const invalid = apiRequest(1, { ...options, at: 'yesterday' });
  expect((await post(receiver, logsRequest([sessionStart(0, options), invalid, userPrompt(2, options, 'synthetic prompt text')]))).status).toBe(200);
  expect(processRow(store)).toMatchObject({ uncertain_reason: 'content_enabled' });
  expect(dump(store)).not.toContain('synthetic prompt text');
});

test('pause, finalization and deletion revoke the token before late batches are decoded', async () => {
  for (const action of ['pause', 'finalize', 'delete'] as const) {
    const { store, clock, life } = setup();
    const receiver = await open(store, clock);
    expect((await post(receiver, logsRequest(ready))).status).toBe(200);
    if (action === 'pause') life.pause('t1');
    else if (action === 'finalize') life.finalize('t1', 'failed', []);
    else new Deletion(store, clock).deleteTask('t1');
    const before = dump(store);
    expect((await post(receiver, '{not json')).status).toBe(403);
    expect((await post(receiver, logsRequest([apiRequest(1, options)]))).status).toBe(403);
    expect(dump(store)).toBe(before);
    if (action !== 'delete') expect(processRow(store)).toMatchObject({ state: 'revoked', revoke_reason: action });
    // Resuming the task does not reopen a revoked process token.
    if (action === 'pause') {
      life.resume('t1');
      expect((await post(receiver, logsRequest([apiRequest(1, options)]))).status).toBe(403);
    }
  }
});

test('closing the receiver revokes the process and closes its uncertain window', async () => {
  const { store, clock, advance } = setup();
  const receiver = await open(store, clock);
  expect((await post(receiver, logsRequest([apiRequest(0, options)]))).status).toBe(200);
  advance(1000);
  await receiver.close();
  expect(processRow(store)).toMatchObject({ state: 'revoked', revoke_reason: 'uncertain' });
  expect(store.get('SELECT started_at,ended_at FROM observations')).toEqual({ started_at: '2026-01-01T00:00:00.000Z', ended_at: '2026-01-01T00:00:03.000Z' });
  const ready = setup();
  const second = await open(ready.store, ready.clock);
  expect((await post(second, logsRequest([sessionStart(0, options)]))).status).toBe(200);
  await second.close();
  expect(processRow(ready.store)).toMatchObject({ state: 'revoked', revoke_reason: 'closed', ordering: 'ready' });
  expect(count(ready.store, 'observations')).toBe(0);
});

test('a process that never proved readiness leaves an unmeasurable window when it ends', async () => {
  for (const action of ['close', 'pause', 'finalize'] as const) {
    const { store, clock, life } = setup();
    const receiver = await open(store, clock);
    if (action === 'close') await receiver.close();
    else if (action === 'pause') life.pause('t1');
    else life.finalize('t1', 'failed', []);
    expect(processRow(store)).toMatchObject({
      state: 'revoked',
      revoke_reason: action === 'close' ? 'closed' : action,
      ordering: 'uncertain',
      uncertain_reason: 'ordering_missing'
    });
    expect(store.get('SELECT started_at,ended_at,status,reason FROM observations')).toEqual({
      started_at: '2026-01-01T00:00:00.000Z',
      ended_at: '2026-01-01T00:00:02.000Z',
      status: 'unmeasurable',
      reason: 'incomplete'
    });
  }
});

test('records timed outside the process lifetime are invalid', async () => {
  const { store, clock, life, advance } = setup();
  advance(60000);
  life.pause('t1');
  advance(60000);
  life.resume('t1');
  advance(60000);
  const receiver = await open(store, clock);
  // 00:01:30 lies inside the paused interval, before this process was registered.
  expect(
    (
      await post(
        receiver,
        logsRequest([sessionStart(0, { ...options, at: '2026-01-01T00:03:01.000Z' }), apiRequest(1, { ...options, at: '2026-01-01T00:01:30.000Z' })])
      )
    ).status
  ).toBe(200);
  expect(processRow(store)).toMatchObject({ uncertain_reason: 'invalid_record' });
  const future = setup();
  const later = await open(future.store, future.clock);
  expect((await post(later, logsRequest([sessionStart(0, { ...options, at: '2026-01-01T01:00:00.000Z' })]))).status).toBe(200);
  expect(processRow(future.store)).toMatchObject({ uncertain_reason: 'invalid_record' });
  expect(count(store, 'events') + count(future.store, 'events')).toBe(0);
});

test('the listener is bound to the IPv4 loopback address', async () => {
  const { store, clock } = setup();
  const receiver = await open(store, clock);
  expect(receiver.boundAddress()).toBe('127.0.0.1');
  expect(new URL(receiver.endpoint).hostname).toBe(receiver.boundAddress());
});

test('a pause during an upload rejects the body before it is decoded', async () => {
  const { store, clock, life } = setup();
  const receiver = await open(store, clock);
  const status = await new Promise<number>((resolve, reject) => {
    const outgoing = request(
      new URL('/v1/logs', receiver.endpoint),
      { method: 'POST', headers: { 'content-type': 'application/json', ...receiver.exporterHeaders() } },
      response => {
        response.resume();
        resolve(response.statusCode ?? 0);
      }
    );
    outgoing.on('error', reject);
    outgoing.write('{not json', () => {
      setTimeout(() => {
        life.pause('t1');
        outgoing.end();
      }, 20);
    });
  });
  expect(status).toBe(403);
});

test('oversized uploads receive a status instead of a connection error', async () => {
  const { store, clock } = setup();
  const receiver = await OtelReceiver.start(store, launch, profile, { clock, maxBodyBytes: 4096 });
  resources.push(() => receiver.close());
  tick?.(2000);
  const large = 'x'.repeat(2 * 1024 * 1024);
  expect((await post(receiver, large)).status).toBe(413);
  expect((await post(receiver, large, { headers: { 'transfer-encoding': 'chunked' } })).status).toBe(413);
  expect((await post(receiver, large, { auth: false })).status).toBe(401);
  // Undecoded metrics are acknowledged even above the log body limit.
  expect((await post(receiver, large, { path: '/v1/metrics' })).status).toBe(200);
  expect((await post(receiver, logsRequest([sessionStart(0, options)]))).status).toBe(200);
});

test('a later session with another product version is a scope mismatch', async () => {
  const { store, clock } = setup();
  store.execute(
    "INSERT INTO sessions(id,project_id,task_id,product,product_version) VALUES ('00000000-0000-4000-8000-000000000006','p1','t1','claude_code','0.9.0')",
    []
  );
  const receiver = await open(store, clock);
  expect(
    (await post(receiver, logsRequest([sessionStart(0, options), apiRequest(1, { ...options, sessionId: '00000000-0000-4000-8000-000000000006' })]))).status
  ).toBe(200);
  expect(processRow(store)).toMatchObject({ uncertain_reason: 'scope_mismatch' });
  expect(count(store, 'events')).toBe(0);
});

test('a resumed session with a different product version is rejected at launch', async () => {
  const { store, clock } = setup();
  const first = await open(store, clock);
  await first.close();
  await expect(
    OtelReceiver.start(store, { ...launch, processId: 'process-2', productVersion: '2.0.0-synthetic' }, { ...profile, version: '2.0.0-synthetic' }, { clock })
  ).rejects.toThrow('otel_scope_revoked');
});

test('conflicting process attributes on the record and resource are a scope mismatch', async () => {
  const { store, clock } = setup();
  const receiver = await open(store, clock);
  expect((await post(receiver, logsRequest([sessionStart(0, options)], { 'harness_delta.process_id': 'process-9' }))).status).toBe(200);
  expect(processRow(store)).toMatchObject({ uncertain_reason: 'scope_mismatch' });
});

test('storage failure is retryable and acknowledges nothing', async () => {
  const { store, clock } = setup();
  const receiver = await open(store, clock);
  store.execute("CREATE TRIGGER synthetic_failure BEFORE INSERT ON otel_records BEGIN SELECT RAISE(ABORT, 'synthetic'); END", []);
  expect((await post(receiver, logsRequest([sessionStart(0, options), apiRequest(1, options)]))).status).toBe(503);
  expect(count(store, 'events')).toBe(0);
  store.execute('DROP TRIGGER synthetic_failure', []);
  expect((await post(receiver, logsRequest([sessionStart(0, options), apiRequest(1, options)]))).status).toBe(200);
  expect(count(store, 'events')).toBe(1);
});

test('stored OTel records are immutable', async () => {
  const { store, clock } = setup();
  const receiver = await open(store, clock);
  expect((await post(receiver, logsRequest(ready))).status).toBe(200);
  expect(() => store.execute("UPDATE otel_records SET payload='{}'", [])).toThrow('immutable_otel_record');
  expect(() => store.execute("UPDATE otel_processes SET task_id='t2'", [])).toThrow('immutable_otel_process');
});

test('a resumed session gets a new process and token under the same task', async () => {
  const { store, clock } = setup();
  const first = await open(store, clock);
  await first.close();
  const resumed = await open(store, clock, { ...launch, processId: 'process-2' });
  expect(resumed.exporterHeaders()).not.toEqual(first.exporterHeaders());
  const own = { processId: 'process-2', at: '2026-01-01T00:00:03.000Z' };
  expect((await post(resumed, logsRequest([sessionStart(0, own), apiRequest(1, own)]))).status).toBe(200);
  expect(processRow(store, 'process-2')).toMatchObject({ ordering: 'ready', next_sequence: 2 });
  expect(count(store, 'events')).toBe(1);
});

test('a session owned by another task cannot be adopted at launch', async () => {
  const { store, clock, life } = setup();
  life.createTask('p1', 't2', metadata);
  life.start('t2');
  await open(store, clock, { ...launch, taskId: 't2', processId: 'process-2' });
  await expect(OtelReceiver.start(store, launch, profile, { clock })).rejects.toThrow('otel_scope_revoked');
});

test('the receiver is not exported from the package entry point', async () => {
  const api = await import('../src/index.js');
  expect(Object.keys(api).filter(name => /otel/i.test(name))).toEqual([]);
});

test('scope lost outside the lifecycle hooks is detected before the body is decoded', async () => {
  for (const change of [
    "INSERT INTO tombstones(kind,id,deleted_at) VALUES ('task','t1','2026-01-01T00:00:00.000Z')",
    'UPDATE projects SET local_root=NULL',
    'UPDATE tasks SET generation=generation+1'
  ]) {
    const { store, clock } = setup();
    const receiver = await open(store, clock);
    store.execute(change, []);
    expect((await post(receiver, '{not json')).status).toBe(403);
    expect(processRow(store)).toMatchObject({ state: 'revoked', revoke_reason: 'scope_revoked' });
  }
});
