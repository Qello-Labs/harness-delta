import { expect, test } from 'vitest';
import { ClaudeProbeCoordinator, type ClaudeProbeOptions } from '../src/claude-probe-coordinator.js';
import { Store } from '../src/store.js';
import { attrs, receivedAt, span, startedAt, traceScope, traces } from './helpers/claude-trace-fixture.js';
import { sessionCompatibility } from '../src/source-compatibility.js';
import { claudeWorkflowChildProfileId, claudeWorkflowProfileId } from '../src/claude-workflow-versions.js';

const rootScope = { ...traceScope, sessions: traceScope.sessions.slice(0, 1) };
function fixture(workflow?: ClaudeProbeOptions['workflow'], version = workflow ? '2.1.296' : '2.1.288') {
  // A workflow run uses the admitted workflow version; the internal probe stays on 2.1.288.
  const store = new Store(':memory:');
  store.execute("INSERT INTO projects(id) VALUES ('project-1')", []);
  store.execute("INSERT INTO tasks(id,project_id,state) VALUES ('task-1','project-1','active')", []);
  store.execute("INSERT INTO sessions(id,project_id,task_id,product,product_version) VALUES ('root','project-1','task-1','claude_code',?)", [version]);
  let now = startedAt; let reservations = 0;
  let probe: ClaudeProbeCoordinator;
  try { probe = new ClaudeProbeCoordinator(store, { rootScope, child: { sessionId: 'child', sourceId: 'source-child', agentType: 'qualification-child' },
    generation: 0, startedAt, model: 'root-model', effort: 'high', clock: () => now, reserveChild: () => { reservations++; }, ...(workflow ? { workflow, productVersion: version } : {}) });
  } catch (error) { store.close(); throw error; }
  const token = probe.exporterHeaders()['x-harness-delta-token']!;
  const hook = (name: string, patch: Record<string, unknown> = {}) => probe.acceptHook(token, () => ({ hook_event_name: name, session_id: 'native-root', ...patch }));
  const logs = (records: unknown[]) => probe.ingestLogs(token, () => ({ resourceLogs: [{ resource: { attributes: attrs({ 'harness_delta.process_id': 'process-1' }) }, scopeLogs: [{ logRecords: records }] }] }));
  const log = (sequence: number, name = 'api_request', patch: Record<string, unknown> = {}) => ({ attributes: attrs({ 'event.name': name, 'event.sequence': sequence, 'event.timestamp': startedAt,
    'session.id': 'native-root', 'app.version': version, 'managed_settings.trigger': 'startup', ...patch }) });
  const startup = () => ({ ...log(0, 'managed_settings_resolved'), attributes: [...log(0, 'managed_settings_resolved').attributes, { key: 'managed_settings.sources', value: { arrayValue: { values: [] } } }] });
  const ready = () => { hook('SessionStart', { source: 'startup', model: 'root-model' }); logs([startup()]); now = receivedAt; };
  const child = () => { hook('PreToolUse', { tool_name: 'Agent', tool_use_id: 'tool-child', tool_input: { subagent_type: 'qualification-child', prompt: 'PRIVATE_SENTINEL' } }); hook('SubagentStart', { agent_id: 'agent-child', agent_type: 'qualification-child', transcript_path: 'PRIVATE_SENTINEL' }); };
  return { store, probe, token, hook, logs, log, startup, ready, child, reservations: () => reservations, set: (s: string) => { now = s; } };
}

test('a conditional non-synthetic coordinator rejects children but pins parent-only own-trace compatibility', () => {
  const workflow = { synthetic: false, childEnabled: true, childRuntime: { model: 'root-model', effort: 'high' },
    requestLimit: 4, durationMs: 60000, assertActive: () => undefined, onChildBound: () => undefined };
  expect(() => fixture(workflow, '2.1.297')).toThrow(/^claude_probe_invalid_options$/);
  const f = fixture({ ...workflow, childEnabled: false }, '2.1.297'); try {
    expect(sessionCompatibility(f.store, 'root')).toMatchObject({ profile_id: claudeWorkflowProfileId, state: 'compatibility_unverified',
      product_version: '2.1.297', parser_version: '2.1.296', source: 'claude_workflow' });
    f.ready();
    expect(f.probe.ingestTraces(f.token, () => traces([span(false, { 'app.version': '2.1.297', effort: 'high' })]))).toMatchObject({ inserted: 1 });
    expect(f.store.get("SELECT json_extract(payload,'$.source_compatibility.profile_id') AS profile,json_extract(payload,'$.source_compatibility.state') AS state FROM events"))
      .toEqual({ profile: claudeWorkflowProfileId, state: 'compatibility_unverified' });
  } finally { f.store.close(); }
});

test('an exact non-synthetic direct-child run stops a second Agent call before additional usage access', () => {
  const f = fixture({ synthetic: false, childEnabled: true, childRuntime: { model: 'root-model', effort: 'high' },
    requestLimit: 4, durationMs: 60000, assertActive: () => undefined, onChildBound: () => undefined }); try {
    f.ready(); f.child();
    expect(f.probe.ingestTraces(f.token, () => traces([span(false, { 'app.version': '2.1.296', effort: 'high' }),
      span(true, { 'app.version': '2.1.296', model: 'root-model', effort: 'high' })]))).toMatchObject({ inserted: 2 });
    for (const session of ['root', 'child']) expect(sessionCompatibility(f.store, session))
      .toMatchObject({ profile_id: claudeWorkflowChildProfileId, state: 'verified', product_version: '2.1.296' });
    expect(() => f.hook('PreToolUse', { tool_name: 'Agent', tool_use_id: 'second-child', tool_input: { subagent_type: 'qualification-child' } }))
      .toThrow(/^claude_probe_child_limit$/);
    let reads = 0;
    expect(() => f.probe.ingestTraces(f.token, () => { reads++; return traces(); })).toThrow(/^claude_probe_revoked$/);
    expect(reads).toBe(0); expect(f.store.eventCount()).toBe(2); expect(f.reservations()).toBe(1);
    expect(f.probe.state()).toMatchObject({ revoked: true, requestsInserted: 2, rootRequests: 1, childRequests: 1 });
  } finally { f.store.close(); }
});
test('credential and active root scope precede every hook/log/trace callback', () => {
  const f = fixture(); let reads = 0; const read = () => { reads++; return {}; }; try {
    for (const run of [() => f.probe.acceptHook('foreign', read), () => f.probe.ingestLogs('foreign', read), () => f.probe.ingestTraces('foreign', read)]) expect(run).toThrow('claude_probe_unauthorized');
    f.store.execute("UPDATE tasks SET generation=1 WHERE id='task-1'", []);
    expect(() => f.probe.acceptHook(f.token, read)).toThrow('claude_trace_scope_revoked'); expect(reads).toBe(0);
  } finally { f.store.close(); }
});
test('startup and exactly one scoped child bind before request trace ingestion; logs never count usage', () => {
  const f = fixture(); try {
    f.ready(); f.logs([f.startup(), f.log(1, 'api_request', { input_tokens: 999999, effort: 'other' })]);
    expect(f.store.eventCount()).toBe(0); f.child();
    const body = traces([span(false, { effort: 'high' }), span(true, { model: 'root-model' })]);
    expect(f.probe.ingestTraces(f.token, () => body)).toMatchObject({ inserted: 2 });
    expect(f.probe.ingestTraces(f.token, () => body)).toMatchObject({ inserted: 0 });
    expect(f.store.all('SELECT id,parent_id FROM sessions ORDER BY id')).toEqual([{ id: 'child', parent_id: 'root' }, { id: 'root', parent_id: null }]);
    expect(f.reservations()).toBe(1); expect(f.store.eventCount()).toBe(2);
    expect(JSON.stringify(f.store.all('SELECT * FROM sessions')) + JSON.stringify(f.store.all('SELECT * FROM runtime_evidence'))).not.toContain('PRIVATE_SENTINEL');
  } finally { f.store.close(); }
});
test('matching hook replay binds once; a second child invocation or different identity stops', () => {
  const f = fixture(); try {
    f.ready(); f.child(); f.hook('SubagentStart', { agent_id: 'agent-child', agent_type: 'qualification-child' });
    f.hook('PreToolUse', { tool_name: 'Agent', tool_use_id: 'tool-child', tool_input: { subagent_type: 'qualification-child' } });
    expect(f.reservations()).toBe(1);
    expect(() => f.hook('PreToolUse', { tool_name: 'Agent', tool_use_id: 'another', tool_input: { subagent_type: 'qualification-child' } })).toThrow('claude_probe_child_limit');
    expect(f.probe.state().revoked).toBe(true);
  } finally { f.store.close(); }
});
test.each(['missing', 'gap', 'conflict', 'policy', 'content'] as const)('startup/log %s boundary stops and creates a fixed unavailable gap', reason => {
  const f = fixture(); try {
    f.hook('SessionStart', { source: 'startup', model: 'root-model' });
    if (reason === 'missing') expect(() => f.logs([f.log(1)])).toThrow();
    else if (reason === 'policy') {
      const s = f.startup(); s.attributes = s.attributes.map(a => a.key === 'managed_settings.sources' ? { key: a.key, value: { arrayValue: { values: [{ stringValue: 'policy' }] } } } : a);
      expect(() => f.logs([s])).toThrow();
    } else {
      f.logs([f.startup()]);
      const row = reason === 'gap' ? f.log(2) : reason === 'conflict' ? f.log(0, 'different') : f.log(1, 'user_prompt', { prompt_text: 'PRIVATE_SENTINEL' });
      expect(() => f.logs([row])).toThrow();
    }
    expect(f.probe.state().revoked).toBe(true); expect(f.store.eventCount()).toBe(0);
    expect(f.store.all('SELECT reason FROM observation_gaps')).toHaveLength(1);
    expect(JSON.stringify(f.store.all('SELECT * FROM observation_gaps'))).not.toContain('PRIVATE_SENTINEL');
  } finally { f.store.close(); }
});
test('unknown child identity, missing start and unsupported hook never register a child', () => {
  const f = fixture(); try {
    expect(() => f.hook('SubagentStart', { agent_id: 'foreign', agent_type: 'qualification-child' })).toThrow();
    expect(f.store.all('SELECT * FROM sessions')).toHaveLength(1);
  } finally { f.store.close(); }
});
test('trace requires startup evidence before reading and exact model/effort before persistence', () => {
  const f = fixture(); let reads = 0; try {
    expect(() => f.probe.ingestTraces(f.token, () => { reads++; return traces(); })).toThrow('claude_probe_not_ready'); expect(reads).toBe(0);
  } finally { f.store.close(); }
  for (const patch of [{ model: 'foreign' }, { effort: undefined }]) {
    const p = fixture(); try { p.ready(); p.child(); expect(() => p.probe.ingestTraces(p.token, () => traces([span(false, patch)]))).toThrow('claude_probe_configuration_changed'); expect(p.store.eventCount()).toBe(0); }
    finally { p.store.close(); }
  }
});
test('tombstoned child is not created; deadline and generation cannot be resumed', () => {
  const f = fixture(); try {
    f.ready(); f.hook('PreToolUse', { tool_name: 'Agent', tool_use_id: 'tool-child', tool_input: { subagent_type: 'qualification-child' } });
    f.store.execute("INSERT INTO tombstones(kind,id,deleted_at) VALUES ('session','child',?)", [receivedAt]);
    expect(() => f.hook('SubagentStart', { agent_id: 'agent-child', agent_type: 'qualification-child' })).toThrow('claude_probe_child_scope');
    expect(f.store.all('SELECT * FROM sessions')).toHaveLength(1);
  } finally { f.store.close(); }
  const p = fixture(); try { p.set('2026-01-01T00:02:01Z'); expect(() => p.hook('SessionStart', { source: 'startup', model: 'root-model' })).toThrow('claude_probe_deadline'); }
  finally { p.store.close(); }
});

test('documented API error log stops qualification without adding error usage', () => {
  const f = fixture(); try {
    f.ready(); expect(() => f.logs([f.log(1, 'api_error', { error: 'PRIVATE_SENTINEL', attempt: 1 })])).toThrow('claude_probe_request_boundary');
    expect(f.store.eventCount()).toBe(0); expect(f.probe.state().revoked).toBe(true);
  } finally { f.store.close(); }
});
test('ambiguous duplicate log attributes cannot establish startup policy', () => {
  const f = fixture(); try {
    f.hook('SessionStart', { source: 'startup', model: 'root-model' });
    const s = f.startup(); s.attributes.push(...attrs({ 'event.sequence': 9 }));
    expect(() => f.logs([s])).toThrow('claude_probe_invalid_logs');
  } finally { f.store.close(); }
});

test('request conflict revokes the probe and preserves previously committed partial usage', () => {
  const f = fixture(); try {
    f.ready(); f.child(); f.probe.ingestTraces(f.token, () => traces([span(false, { effort: 'high' })]));
    expect(() => f.probe.ingestTraces(f.token, () => traces([span(false, { effort: 'high', output_tokens: 16 })]))).toThrow('claude_probe_request_conflict');
    expect(f.probe.state().revoked).toBe(true); expect(f.store.eventCount()).toBe(1);
  } finally { f.store.close(); }
});

test('startup alone cannot read any trace bytes before the direct child binds', () => {
  const f = fixture(); let reads = 0; try {
    f.ready();
    expect(() => f.probe.ingestTraces(f.token, () => { reads++; return traces(); })).toThrow('claude_probe_not_ready');
    expect(reads).toBe(0); expect(f.store.eventCount()).toBe(0); expect(f.probe.state().revoked).toBe(false);
    f.child(); expect(f.probe.ingestTraces(f.token, () => traces([span(false, { effort: 'high' })]))).toMatchObject({ inserted: 1 });
  } finally { f.store.close(); }
});

test('three root requests cannot replace the required direct-child request', () => {
  const f = fixture(); try {
    f.ready(); f.child();
    const roots = [0, 1, 2].map(index => ({ ...span(false, { effort: 'high', request_id: `root-request-${index}` }), spanId: `${index + 5}`.repeat(16) }));
    expect(() => f.probe.ingestTraces(f.token, () => traces(roots))).toThrow('claude_probe_request_boundary');
    expect(f.probe.state().revoked).toBe(true);
  } finally { f.store.close(); }
});

test('request accounting retains per-session insertion counts across exact replay', () => {
  const f = fixture(); try {
    f.ready(); f.child();
    const body = traces([span(false, { effort: 'high' }), span(true, { model: 'root-model' }),
      { ...span(false, { effort: 'high', request_id: 'root-final' }), spanId: '5'.repeat(16) }]);
    f.probe.ingestTraces(f.token, () => body); f.probe.ingestTraces(f.token, () => body);
    expect(f.probe.state()).toMatchObject({ requestsInserted: 3, rootRequests: 2, childRequests: 1, revoked: false });
  } finally { f.store.close(); }
});


test.each(['logs-first', 'hook-first'])('startup prerequisites are independent in %s order and traces await every prerequisite', order => {
  const f = fixture(); let reads = 0;
  try {
    const earlyTrace = () => f.probe.ingestTraces(f.token, () => { reads++; return {}; });
    expect(earlyTrace).toThrow('claude_probe_not_ready');
    if (order === 'logs-first') {
      expect(f.logs([f.startup()])).toEqual({ accepted: 1, replayed: 0 });
      expect(f.probe.state()).toMatchObject({ rootStarted: false, lastSequence: 0, revoked: false });
      expect(earlyTrace).toThrow('claude_probe_not_ready');
      f.hook('SessionStart', { source: 'startup', model: 'root-model' });
    } else {
      f.hook('SessionStart', { source: 'startup', model: 'root-model' });
      expect(earlyTrace).toThrow('claude_probe_not_ready');
      f.logs([f.startup()]);
    }
    expect(earlyTrace).toThrow('claude_probe_not_ready'); expect(reads).toBe(0);
    f.child(); f.set(receivedAt);
    const body = traces([span(false, { effort: 'high' }), span(true, { model: 'root-model' })]);
    expect(f.probe.ingestTraces(f.token, () => body).inserted).toBe(2);
    expect(f.probe.ingestTraces(f.token, () => body).inserted).toBe(0);
    expect(f.probe.state()).toMatchObject({ rootRequests: 1, childRequests: 1, revoked: false });
  } finally { f.store.close(); }
});
test('early startup replay is idempotent and never creates usage or a child', () => {
  const f = fixture(); try {
    expect(f.logs([f.startup()])).toEqual({ accepted: 1, replayed: 0 });
    expect(f.logs([f.startup()])).toEqual({ accepted: 0, replayed: 1 });
    f.hook('SessionStart', { source: 'startup', model: 'root-model' });
    f.hook('SessionStart', { source: 'startup', model: 'root-model' });
    expect(f.probe.state()).toMatchObject({ rootStarted: true, childBound: false, requestsInserted: 0, lastSequence: 0 });
    expect(f.store.eventCount()).toBe(0); expect(f.reservations()).toBe(0);
  } finally { f.store.close(); }
});
test('missing early sequence zero revokes rather than filling an unobserved interval', () => {
  const f = fixture(); try {
    expect(() => f.logs([f.log(1)])).toThrow('claude_probe_log_gap');
    expect(f.probe.state()).toMatchObject({ rootStarted: false, lastSequence: -1, revoked: true });
    expect(f.store.eventCount()).toBe(0);
  } finally { f.store.close(); }
});
test('early startup scope cancellation and foreign credentials precede callback access', () => {
  const f = fixture(); let reads = 0; try {
    expect(() => f.probe.ingestLogs('foreign', () => { reads++; return {}; })).toThrow('claude_probe_unauthorized');
    f.logs([f.startup()]); f.store.execute("UPDATE tasks SET state='paused',generation=1 WHERE id='task-1'", []);
    expect(() => f.probe.acceptHook(f.token, () => { reads++; return {}; })).toThrow('claude_trace_scope_revoked');
    expect(reads).toBe(0); expect(f.store.eventCount()).toBe(0);
  } finally { f.store.close(); }
});
test('a probe bounds unique log keys while exact replay does not consume the limit', () => {
  const f = fixture(); try {
    f.logs([f.startup()]); f.logs(Array.from({ length: 127 }, (_, i) => f.log(i + 1)));
    expect(f.logs([f.startup(), f.log(127)])).toEqual({ accepted: 0, replayed: 2 });
    expect(() => f.logs([f.log(128)])).toThrow('claude_probe_log_limit');
    expect(f.probe.state()).toMatchObject({ lastSequence: 127, revoked: true }); expect(f.store.eventCount()).toBe(0);
  } finally { f.store.close(); }
});
test('a workflow run accepts exporter-sized batches, more keys and its own longer window', () => {
  const f = fixture({ synthetic: false, childEnabled: false, requestLimit: 1024, durationMs: 600000, assertActive: () => undefined, onChildBound: () => undefined });
  const at = (ms: number) => new Date(Date.parse(startedAt) + ms).toISOString();
  try {
    f.hook('SessionStart', { source: 'startup' }); f.logs([f.startup()]);
    f.logs(Array.from({ length: 400 }, (_, i) => f.log(i + 1)));
    f.set(at(300000)); expect(f.logs(Array.from({ length: 400 }, (_, i) => f.log(i + 401)))).toEqual({ accepted: 400, replayed: 0 });
    expect(f.probe.state()).toMatchObject({ lastSequence: 800, revoked: false });
    expect(() => f.logs(Array.from({ length: 513 }, (_, i) => f.log(i + 801)))).toThrow('claude_probe_invalid_logs');
  } finally { f.store.close(); }
  const late = fixture({ synthetic: false, childEnabled: false, requestLimit: 1024, durationMs: 600000, assertActive: () => undefined, onChildBound: () => undefined });
  try {
    late.hook('SessionStart', { source: 'startup' }); late.set(at(600001));
    expect(() => late.logs([late.startup()])).toThrow('claude_probe_deadline');
  } finally { late.store.close(); }
});
test('model-less native SessionStart starts the root; a present mismatched model still stops', () => {
  const f = fixture(); try {
    f.hook('SessionStart', { source: 'startup' }); f.logs([f.startup()]); f.set(receivedAt); f.child();
    expect(f.probe.state()).toMatchObject({ rootStarted: true, childBound: true, revoked: false });
    // Requested runtime is still enforced on every request trace.
    expect(() => f.probe.ingestTraces(f.token, () => traces([span(false, { model: 'other-model' })]))).toThrow('claude_probe_configuration_changed');
  } finally { f.store.close(); }
  const g = fixture(); try {
    expect(() => g.hook('SessionStart', { source: 'startup', model: 'other-model' })).toThrow('claude_probe_configuration_changed');
    expect(g.probe.state()).toMatchObject({ rootStarted: false, revoked: true });
  } finally { g.store.close(); }
});
test('SessionStart after terminal marker is a rejected restart', () => {
  const f = fixture(); try {
    f.ready(); f.hook('SessionEnd');
    expect(() => f.hook('SessionStart', { source: 'startup', model: 'root-model' })).toThrow('claude_probe_restart');
    expect(f.probe.state().revoked).toBe(true); expect(f.store.eventCount()).toBe(0);
  } finally { f.store.close(); }
});


test('early policy and content failure revoke before SessionStart and child creation still requires SessionStart', () => {
  for (const scenario of ['policy', 'content', 'child'] as const) {
    const f = fixture(); try {
      if (scenario === 'policy') {
        const record = f.startup(); record.attributes = record.attributes.filter(a => a.key !== 'managed_settings.sources');
        record.attributes.push({ key: 'managed_settings.sources', value: { arrayValue: { values: [{ stringValue: 'synthetic-policy' }] } } });
        expect(() => f.logs([record])).toThrow('claude_probe_policy_override');
      } else if (scenario === 'content') {
        const record = f.startup(); record.attributes.push({ key: 'prompt_text', value: { stringValue: 'PRIVATE_SYNTHETIC' } });
        expect(() => f.logs([record])).toThrow('claude_probe_content_enabled');
      } else {
        f.logs([f.startup()]); expect(() => f.child()).toThrow('claude_probe_not_started');
      }
      expect(f.probe.state()).toMatchObject({ rootStarted: false, childBound: false, revoked: true });
      expect(f.store.eventCount()).toBe(0); expect(f.reservations()).toBe(0);
    } finally { f.store.close(); }
  }
});


test('SessionStart and child binding cannot substitute for missing startup logs', () => {
  const f = fixture(); let reads = 0; try {
    f.hook('SessionStart', { source: 'startup', model: 'root-model' }); f.child();
    expect(() => f.probe.ingestTraces(f.token, () => { reads++; return traces(); })).toThrow('claude_probe_not_ready');
    expect(reads).toBe(0); expect(f.store.eventCount()).toBe(0); expect(f.probe.state().revoked).toBe(false);
    f.logs([f.startup()]); f.set(receivedAt);
    const body = traces([span(false, { effort: 'high' }), span(true, { model: 'root-model' })]);
    expect(f.probe.ingestTraces(f.token, () => body).inserted).toBe(2);
  } finally { f.store.close(); }
});

test('a child call that overrides effort or asks for an isolated directory stops before any child is reserved', () => {
  const workflow = { synthetic: false, childEnabled: true, childRuntime: { model: 'root-model', effort: 'low' },
    requestLimit: 4, durationMs: 60000, assertActive: () => undefined, onChildBound: () => undefined };
  // 2.1.292 added effort and 2.1.296 exposes isolation on the Agent tool input.
  for (const patch of [{ effort: 'max' }, { isolation: true }]) {
    const f = fixture(workflow); try {
      f.ready();
      expect(() => f.hook('PreToolUse', { tool_name: 'Agent', tool_use_id: 'tool-child', tool_input: { subagent_type: 'qualification-child', ...patch } }))
        .toThrow(/^claude_probe_child_scope$/);
      expect(f.reservations()).toBe(0); expect(f.probe.state()).toMatchObject({ revoked: true, childBound: false });
    } finally { f.store.close(); }
  }
  const same = fixture(workflow); try {
    same.ready();
    expect(() => same.hook('PreToolUse', { tool_name: 'Agent', tool_use_id: 'tool-child', tool_input: { subagent_type: 'qualification-child', effort: 'low' } })).not.toThrow();
    expect(same.reservations()).toBe(1);
  } finally { same.store.close(); }
});

test('a resumed workflow run requires SessionStart source resume and a fresh run requires startup', () => {
  const workflow = { synthetic: false, childEnabled: false, requestLimit: 4, durationMs: 60000, assertActive: () => undefined, onChildBound: () => undefined };
  const resumed = fixture({ ...workflow, startSource: 'resume' }); try {
    expect(() => resumed.hook('SessionStart', { source: 'resume' })).not.toThrow();
    // Observed 2.1.291 and 2.1.296: a resumed process restarts its log sequence at 0 with the startup policy record.
    resumed.logs([resumed.startup()]); resumed.set(receivedAt);
    expect(resumed.probe.ingestTraces(resumed.token, () => traces([span(false, { 'app.version': '2.1.296', effort: 'high' })]))).toMatchObject({ inserted: 1 });
  } finally { resumed.store.close(); }
  for (const [startSource, source] of [['resume', 'startup'], [undefined, 'resume']] as const) {
    const f = fixture({ ...workflow, ...(startSource ? { startSource } : {}) }); try {
      expect(() => f.hook('SessionStart', { source })).toThrow(/^claude_probe_configuration_changed$/);
      expect(f.probe.state()).toMatchObject({ rootStarted: false, revoked: true });
    } finally { f.store.close(); }
  }
});
