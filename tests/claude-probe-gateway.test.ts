import { expect, test } from 'vitest';
import { startClaudeProbeGateway } from '../src/claude-probe-gateway.js';
import { projectClaudeProbeHook } from '../src/claude-probe-hook-mediator.js';
import { ClaudeProbeCoordinator } from '../src/claude-probe-coordinator.js';
import { Store } from '../src/store.js';
import { attrs, receivedAt, span, startedAt, traceScope, traces } from './helpers/claude-trace-fixture.js';

async function fixture(maxBodyBytes = 1024, hookError?: Error, durationMs = 120000) {
  let revoked = false; let decoded = 0; const accepted: string[] = []; const stops: string[] = []; const diagnostics: unknown[] = [];
  const coordinator = {
    exporterHeaders: () => ({ 'x-harness-delta-token': 'synthetic-token' }),
    authorizeRequest: (token: string) => { if (token !== 'synthetic-token') throw new Error('claude_probe_unauthorized'); if (revoked) throw new Error('claude_probe_revoked'); },
    authorizeTraceRequest: (token: string) => { if (token !== 'synthetic-token') throw new Error('claude_probe_unauthorized'); if (revoked) throw new Error('claude_probe_revoked'); },
    acceptHook: (_token: string, read: () => unknown) => { read(); decoded++; if (hookError !== undefined) throw hookError; accepted.push('hook'); },
    ingestLogs: (_token: string, read: () => unknown) => { read(); decoded++; accepted.push('logs'); return { accepted: 1, replayed: 0 }; },
    ingestTraces: (_token: string, read: () => unknown) => { read(); decoded++; accepted.push('traces'); return { requests: 1, inserted: 1, excluded: 0, unattributed: 0 }; },
    revoke: () => { revoked = true; },
  };
  const gateway = await startClaudeProbeGateway(coordinator, { maxBodyBytes, durationMs, onStop: (reason, diagnostic) => { stops.push(reason); diagnostics.push(diagnostic); } });
  const post = (path: string, body: string, token = 'synthetic-token', contentType = 'application/json') => fetch(gateway.endpoint + path,
    { method: 'POST', headers: { 'content-type': contentType, 'x-harness-delta-token': token }, body });
  return { gateway, post, accepted, stops, diagnostics, decoded: () => decoded, revoke: () => { revoked = true; } };
}
test('authenticated loopback routes hooks, logs and traces to one coordinator', async () => {
  const f = await fixture(); try {
    expect(f.gateway.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    for (const path of ['/v1/hooks', '/v1/logs', '/v1/traces']) expect((await f.post(path, '{}')).status).toBe(200);
    expect(f.accepted).toEqual(['hook', 'logs', 'traces']);
  } finally { await f.gateway.close(); }
});
test('wrong token and revoked scope reject undecodable bodies before any callback', async () => {
  const f = await fixture(); try {
    expect((await f.post('/v1/hooks', 'PRIVATE invalid-json', 'wrong')).status).toBe(401);
    expect(f.decoded()).toBe(0); f.revoke();
    expect((await f.post('/v1/traces', 'PRIVATE invalid-json')).status).toBe(403); expect(f.decoded()).toBe(0);
  } finally { await f.gateway.close(); }
});
test('unsupported route/type and oversize bodies do not reach the coordinator', async () => {
  const f = await fixture(); try {
    expect((await f.post('/v1/metrics', '{}')).status).toBe(404);
    expect((await f.post('/v1/traces', '{}', undefined, 'application/x-protobuf')).status).toBe(415);
    expect((await f.post('/v1/hooks', 'x'.repeat(1025))).status).toBe(413);
    expect(f.decoded()).toBe(0);
  } finally { await f.gateway.close(); }
});
test('malformed authenticated body emits only a fixed stop and revokes further requests', async () => {
  const f = await fixture(); try {
    const response = await f.post('/v1/hooks', 'PRIVATE malformed-json'); expect(response.status).toBe(400);
    expect(await response.text()).not.toContain('PRIVATE'); expect(f.stops).toEqual(['metadata']);
    expect((await f.post('/v1/hooks', '{}')).status).toBe(403); expect(f.decoded()).toBe(0);
  } finally { await f.gateway.close(); }
});
test('hook mediator projects identities and child control markers without content or transcript paths', () => {
  const metadata = projectClaudeProbeHook({ hook_event_name: 'PreToolUse', session_id: 'native-root', tool_name: 'Agent', tool_use_id: 'tool-child',
    tool_input: { subagent_type: 'qualification-child', model: 'claude-sonnet-5-5', prompt: 'PRIVATE_SENTINEL', resume: 'PRIVATE_SENTINEL' },
    transcript_path: 'PRIVATE_SENTINEL', last_assistant_message: 'PRIVATE_SENTINEL' });
  expect(metadata).toEqual({ hook_event_name: 'PreToolUse', session_id: 'native-root', tool_name: 'Agent', tool_use_id: 'tool-child',
    tool_input: { subagent_type: 'qualification-child', model: 'claude-sonnet-5-5', resume: true } });
  expect(JSON.stringify(metadata)).not.toContain('PRIVATE_SENTINEL');
  expect(() => projectClaudeProbeHook({ hook_event_name: 'SubagentStart', session_id: 'native-root', agent_id: 'PRIVATE CONTENT' })).toThrow('claude_probe_hook_invalid');
});

test('hook mediator accepts the observed 2.1.288 print-mode SessionStart shape, which carries no model', () => {
  // Key set captured from the pinned binary in print mode; values are synthetic.
  const native = { hook_event_name: 'SessionStart', session_id: 'native-root', source: 'startup', cwd: 'PRIVATE_SENTINEL', transcript_path: 'PRIVATE_SENTINEL' };
  expect(projectClaudeProbeHook(native)).toEqual({ hook_event_name: 'SessionStart', session_id: 'native-root', source: 'startup' });
  expect(projectClaudeProbeHook({ ...native, model: 'claude-sonnet-5-5' })).toEqual({ hook_event_name: 'SessionStart', session_id: 'native-root', source: 'startup', model: 'claude-sonnet-5-5' });
  expect(() => projectClaudeProbeHook({ ...native, model: 'PRIVATE CONTENT' })).toThrow('claude_probe_hook_invalid');
  expect(() => projectClaudeProbeHook({ ...native, source: undefined })).toThrow('claude_probe_hook_invalid');
});

test.each(['logs-first', 'hook-first'])('gateway binds startup in %s order before child trace accounting', async order => {
  const store = new Store(':memory:');
  store.execute("INSERT INTO projects(id) VALUES ('project-1')", []);
  store.execute("INSERT INTO tasks(id,project_id,state) VALUES ('task-1','project-1','active')", []);
  store.execute("INSERT INTO sessions(id,project_id,task_id,product,product_version) VALUES ('root','project-1','task-1','claude_code','2.1.288')", []);
  let now = startedAt; let children = 0;
  const coordinator = new ClaudeProbeCoordinator(store, { rootScope: { ...traceScope, sessions: traceScope.sessions.slice(0, 1) },
    child: { sessionId: 'child', sourceId: 'source-child', agentType: 'qualification-child' }, generation: 0, startedAt,
    model: 'root-model', effort: 'high', clock: () => now, reserveChild: () => { children++; } });
  const gateway = await startClaudeProbeGateway(coordinator);
  const post = (path: string, body: unknown) => fetch(gateway.endpoint + path, { method: 'POST', headers: { 'content-type': 'application/json', ...coordinator.exporterHeaders() }, body: JSON.stringify(body) });
  const hook = (hookEvent: string, fields = {}) => post('/v1/hooks', { hook_event_name: hookEvent, session_id: 'native-root', ...fields });
  try {
    // Pinned 2.1.288 OTLP exporter retries only 429/502/503/504; any other rejection drops the batch.
    const earlyTrace = () => fetch(gateway.endpoint + '/v1/traces', { method: 'POST', headers: { 'content-type': 'application/json', ...coordinator.exporterHeaders() }, body: 'PRIVATE invalid-json' });
    expect((await earlyTrace()).status).toBe(503);
    const startup = { resourceLogs: [{ resource: { attributes: attrs({ 'harness_delta.process_id': 'process-1' }) }, scopeLogs: [{ logRecords: [{ attributes: [
      ...attrs({ 'event.sequence': 0, 'event.name': 'managed_settings_resolved', 'event.timestamp': startedAt, 'managed_settings.trigger': 'startup', 'session.id': 'native-root', 'app.version': '2.1.288', input_tokens: 999999 }),
      { key: 'managed_settings.sources', value: { arrayValue: { values: [] } } },
    ] }] }] }] };
    if (order === 'logs-first') {
      expect((await post('/v1/logs', startup)).status).toBe(200);
      expect((await earlyTrace()).status).toBe(503);
      expect((await hook('SessionStart', { source: 'startup', model: 'root-model' })).status).toBe(200);
    } else {
      expect((await hook('SessionStart', { source: 'startup', model: 'root-model' })).status).toBe(200);
      expect((await earlyTrace()).status).toBe(503);
      expect((await post('/v1/logs', startup)).status).toBe(200);
    }
    expect(store.eventCount()).toBe(0);
    const early = await fetch(gateway.endpoint + '/v1/traces', { method: 'POST', headers: { 'content-type': 'application/json', ...coordinator.exporterHeaders() }, body: 'PRIVATE invalid-json' });
    expect(early.status).toBe(503); expect(coordinator.state().revoked).toBe(false); expect(store.eventCount()).toBe(0);
    expect((await hook('PreToolUse', { tool_name: 'Agent', tool_use_id: 'tool-child', tool_input: { subagent_type: 'qualification-child' } })).status).toBe(200);
    expect((await hook('SubagentStart', { agent_id: 'agent-child', agent_type: 'qualification-child' })).status).toBe(200);
    expect(children).toBe(1); now = receivedAt;
    const requests = traces([span(false, { effort: 'high' }), span(true, { model: 'root-model' })]);
    expect((await post('/v1/traces', requests)).status).toBe(200); expect((await post('/v1/traces', requests)).status).toBe(200);
    expect(store.eventCount()).toBe(2); expect(store.all('SELECT * FROM otel_processes')).toEqual([]);
    expect(store.all('SELECT id,parent_id FROM sessions ORDER BY id')).toEqual([{ id: 'child', parent_id: 'root' }, { id: 'root', parent_id: null }]);
  } finally { await gateway.close(); store.close(); }
});


test.each([
  ['known coordinator failure', new Error('claude_probe_policy_override'), 'claude_probe_policy_override'],
  ['unknown private error', new Error('PRIVATE_TOKEN_AND_CONTENT', { cause: 'PRIVATE_CAUSE' }), 'unknown'],
] as const)('gateway retains only a fixed first diagnostic for %s', async (_name, error, category) => {
  const f = await fixture(1024, error); try {
    expect((await f.post('/v1/hooks', '{}')).status).toBe(400);
    expect(f.diagnostics).toEqual([{ reason: 'metadata', route: 'hooks', category }]);
    expect((await f.post('/v1/hooks', '{}')).status).toBe(403); expect(f.diagnostics).toHaveLength(1);
    expect(JSON.stringify(f.diagnostics)).not.toContain('PRIVATE');
  } finally { await f.gateway.close(); }
});
test('gateway deadline has a fixed category with no route or exception data', async () => {
  const f = await fixture(1024, undefined, 30); try {
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(f.diagnostics).toEqual([{ reason: 'deadline', route: null, category: 'claude_probe_deadline' }]);
  } finally { await f.gateway.close(); }
});
test('malformed JSON classification never retains decoder exception text', async () => {
  const f = await fixture(); try {
    expect((await f.post('/v1/hooks', 'PRIVATE malformed-json')).status).toBe(400);
    expect(f.diagnostics).toEqual([{ reason: 'metadata', route: 'hooks', category: 'invalid_json' }]);
    expect(JSON.stringify(f.diagnostics)).not.toContain('PRIVATE');
  } finally { await f.gateway.close(); }
});

test('hook mediator forwards an Agent effort and marks an isolation request without its value', () => {
  const input = { hook_event_name: 'PreToolUse', session_id: 'native-root', tool_name: 'Agent', tool_use_id: 'tool-child' };
  const metadata = projectClaudeProbeHook({ ...input, tool_input: { subagent_type: 'workflow-child', effort: 'max', isolation: 'PRIVATE_SENTINEL', prompt: 'PRIVATE_SENTINEL' } });
  expect(metadata.tool_input).toEqual({ subagent_type: 'workflow-child', effort: 'max', isolation: true });
  expect(JSON.stringify(metadata)).not.toContain('PRIVATE_SENTINEL');
  expect(() => projectClaudeProbeHook({ ...input, tool_input: { subagent_type: 'workflow-child', effort: 'PRIVATE CONTENT' } })).toThrow('claude_probe_hook_invalid');
});
