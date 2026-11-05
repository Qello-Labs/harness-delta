import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalWebServer } from '../../../dist/web/local-web-server.js';
import { run } from '../scripts/connect.mjs';

// Real current-main HTTP schema/idempotency/If-Match/CSRF gates via injection.
// The domain is deliberately synthetic: this does not admit a live source.
const session = '00000000-0000-4000-8000-000000000001';
const origin = 'http://127.0.0.1:4319';
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'harness-connect-transport-'));
  const task = { id: 'task-a', project_id: 'project-a', setup_id: 'setup-a', version: '"' + 'b'.repeat(64) + '"', state: 'registered',
    actions: [{ code: 'connect', enabled: true }], startup: { ticket_id: 'synthetic-ticket' }, source: null,
    measurement: { state: 'waiting_connection', window: { started_at: null, ends_at: null } },
    preparation: { state: 'configuration_verified', configuration_evidence: 'verified_at_preparation', assigned_variant_id: 'arm-b', native_context_evidence: 'unverified', freshness_evidence: 'unverified' } };
  let deleted = false;
  let connected = 0;
  const domain = {
    bootstrap: () => ({ projects: [{ id: 'project-a' }], setups: [{ id: 'setup-a', project_id: 'project-a',
      support: 'Server-reported source support' }], tasks: deleted ? [] : [task] }),
    task: () => { if (deleted) throw new Error('unknown_task'); return task; },
    chooseSession: async () => ({ handle: 'source-a', label: `rollout-${session}.jsonl` }),
    taskAction: async (_id, action, input) => {
      assert.equal(action, 'connect'); assert.deepEqual(input, { source_handle: 'source-a' }); connected++;
      Object.assign(task, { state: 'active', startup: null, source: { handle: 'source-a', label: `rollout-${session}.jsonl` },
        measurement: { state: 'connected', window: { started_at: new Date(Date.now() - 1000).toISOString(), ends_at: new Date(Date.now() + 3600000).toISOString() } },
        preparation: { state: 'connected', configuration_evidence: 'verified_at_preparation', assigned_variant_id: 'arm-b', native_context_evidence: 'native_developer_context_observed', freshness_evidence: 'fresh_root_after_ticket' } });
      return task;
    },
  };
  const app = createLocalWebServer({ origin, domain, metadataFile: join(directory, 'synthetic-ui.sqlite') });
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const calls = [];
  const transport = async (url, options) => {
    calls.push({ url, ...options });
    const reply = await app.inject({ method: options.method, url: new URL(url).pathname,
      headers: { host: new URL(origin).host, ...options.headers }, ...(options.body ? { payload: options.body } : {}) });
    return new Response(reply.body, { status: reply.statusCode, headers: { 'Content-Type': 'application/json' } });
  };
  return { app, transport, calls, connected: () => connected, remove() { deleted = true; },
    options: { origin, product: 'codex', project: 'project-a', task: 'task-a', session } };
}
test('helper uses real existing UI transport and duplicate call performs no second connect', async t => {
  const f = await fixture(t);
  assert.equal((await run('connect', f.options, f.transport)).status, 'connected');
  assert.equal((await run('connect', f.options, f.transport)).status, 'already_connected');
  assert.equal(f.connected(), 1);
});
test('deletion invalidates prior evidence without helper cache or replay', async t => {
  const f = await fixture(t); await run('connect', f.options, f.transport); f.remove();
  await assert.rejects(run('connect', f.options, f.transport), /selection_required/);
  assert.equal(f.connected(), 1);
});
test('current UI rejects stale If-Match and missing CSRF', async t => {
  const f = await fixture(t);
  const bootstrap = await f.app.inject({ method: 'GET', url: '/api/bootstrap', headers: { host: new URL(origin).host } });
  const { csrf } = bootstrap.json();
  const headers = { host: new URL(origin).host, Origin: origin, 'X-Harness-CSRF': csrf,
    'Idempotency-Key': '00000000-0000-4000-8000-000000000003', 'If-Match': '"stale"' };
  const stale = await f.app.inject({ method: 'POST', url: '/api/tasks/task-a/connect', headers, payload: { source_handle: 'source-a' } });
  assert.equal(stale.statusCode, 409); assert.equal(stale.json().error, 'ui_state_changed');
  delete headers['X-Harness-CSRF'];
  const denied = await f.app.inject({ method: 'POST', url: '/api/tasks/task-a/connect', headers, payload: { source_handle: 'source-a' } });
  assert.equal(denied.statusCode, 403); assert.equal(f.connected(), 0);
});
