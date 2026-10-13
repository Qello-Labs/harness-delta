import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { prepareClaudeNativeProbe } from '../src/claude-native-probe.js';
import { verifyClaudeProbeBinary } from '../src/claude-probe-supervisor.js';
import { ClaudeProbeCoordinator, type ClaudeProbeOptions } from '../src/claude-probe-coordinator.js';
import { ingestClaudeTraceBatch } from '../src/claude-trace-candidate.js';
import { ClaudeWorkflowExecutionSchema, createClaudeWorkflowAdapter } from '../src/claude-workflow-adapter.js';
import { claudeWorkflowProductVersions, claudeWorkflowProfileId, claudeWorkflowChildProfileId, newestAdmittedClaudeWorkflowVersion, requireLatestClaudeWorkflowProfile } from '../src/claude-workflow-versions.js';
import { projectCandidateObservation, type CandidateScope } from '../src/nested-candidate.js';
import { productionSourceEvidence, type SourceReadinessEvidence } from '../src/readiness.js';
import { EventSchema } from '../src/contracts.js';
import { Store } from '../src/store.js';
import { attrs, receivedAt, span, startedAt, traceScope, traces } from './helpers/claude-trace-fixture.js';

// Exact evidence stays separate from conditional workflow versions; the probe remains pinned.
test('the Claude exact evidence list stays closed while workflow validation rejects retired and out-of-window versions', () => {
  // 2.1.288 and 2.1.291 are retired workflow admissions.
  expect(claudeWorkflowProductVersions).toEqual(['2.1.296']);
  expect(Object.isFrozen(claudeWorkflowProductVersions)).toBe(true);
  const execution = { operation: 'launch', run_id: 'run-1', binary: { path: '/synthetic/claude', version: '2.1.296', sha256: 'a'.repeat(64) },
    workspace: '/synthetic/ws', mediator_path: '/synthetic/mediator.js', prompt_file: '/synthetic/prompt.txt', timeout_ms: 1000, max_turns: 1, request_limit: 1 };
  expect(ClaudeWorkflowExecutionSchema.safeParse(execution).success).toBe(true);
  for (const version of ['2.1.288', '2.1.289', '2.1.290', '2.1.291', '2.1.292', '2.1.293', '2.1.294', '2.1.295', '2.2.0', '2.1.296-rc.1', '2.1.296 ', '2.1.29'])
    expect(ClaudeWorkflowExecutionSchema.safeParse({ ...execution, binary: { ...execution.binary, version } }).success).toBe(false);
});
test('every admitted Claude workflow registry version is accepted by the workflow code', () => {
  const admitted = productionSourceEvidence.filter(row => row.product === 'claude_code' && row.profile_id === claudeWorkflowProfileId);
  expect(admitted.length).toBeGreaterThan(0);
  for (const row of admitted) expect(claudeWorkflowProductVersions).toContain(row.product_version);
  // Code list and registry agree today: 2.1.296 is accepted and admitted; 2.1.288 is retired from both.
  expect(admitted.map(row => row.product_version)).toEqual(['2.1.296']);
});
test('the native adapter reports the version its pinned binary declares', () => {
  const store = new Store(':memory:'); try {
    const base = { operation: 'launch', run_id: 'run-1', workspace: '/synthetic/ws', mediator_path: '/synthetic/mediator.js', prompt_file: '/synthetic/prompt.txt',
      timeout_ms: 1000, max_turns: 1, request_limit: 1 };
    for (const version of claudeWorkflowProductVersions)
      expect(createClaudeWorkflowAdapter(store, { ...base, binary: { path: '/synthetic/claude', version, sha256: 'a'.repeat(64) } })).toMatchObject({ product: 'claude_code', productVersion: version });
  } finally { store.close(); }
});

const entry = (product_version: string, patch: Partial<SourceReadinessEvidence> = {}): SourceReadinessEvidence => ({ id: `e-${product_version}`, product: 'claude_code', product_version,
  profile_id: claudeWorkflowProfileId, semantics_digest: '0'.repeat(64), validation_kind: 'real_operations', complete_cost: false, ...patch });
test('the newest admitted Claude workflow version uses semantic version order', () => {
  expect(newestAdmittedClaudeWorkflowVersion()).toBe('2.1.296');
  expect(newestAdmittedClaudeWorkflowVersion([entry('2.1.296'), entry('2.1.288'), entry('2.1.1000', { profile_id: 'claude-child-own-v1' }), entry('9.0.0', { product: 'codex' })])).toBe('2.1.296');
  expect(newestAdmittedClaudeWorkflowVersion([entry('2.1.99'), entry('2.1.100')])).toBe('2.1.100');
  expect(newestAdmittedClaudeWorkflowVersion([])).toBeNull();
  expect(() => newestAdmittedClaudeWorkflowVersion([entry('2.1.296-rc.1')])).toThrow(/^claude_workflow_version_not_latest$/);
});
test('a new protocol may name only one Claude workflow profile at the newest admitted version', () => {
  const claude = (product_version: string) => ({ product: 'claude_code', product_version, profile_id: claudeWorkflowProfileId });
  const codex = { product: 'codex', product_version: '0.160.0', profile_id: 'codex-workflow-own-response-v1' };
  expect(() => requireLatestClaudeWorkflowProfile([claude('2.1.296'), codex])).not.toThrow();
  expect(() => requireLatestClaudeWorkflowProfile([codex, { product: 'claude_code', product_version: '2.1.283', profile_id: 'claude-child-own-v1' }])).not.toThrow();
  for (const profiles of [[claude('2.1.288')], [claude('2.1.288'), claude('2.1.296')], [claude('2.1.296'), claude('2.1.296')]])
    expect(() => requireLatestClaudeWorkflowProfile(profiles)).toThrow(/^claude_workflow_version_not_latest$/);
  const later = [entry('2.1.296'), entry('2.1.300')];
  expect(() => requireLatestClaudeWorkflowProfile([claude('2.1.300')], later)).not.toThrow();
  expect(() => requireLatestClaudeWorkflowProfile([claude('2.1.296')], later)).toThrow(/^claude_workflow_version_not_latest$/);
  expect(() => requireLatestClaudeWorkflowProfile([claude('2.1.296')], [])).toThrow(/^claude_workflow_version_not_latest$/);
});

test('direct-child latest admission is independent and permits one entry per workflow profile', () => {
  const child = (product_version: string) => ({ product: 'claude_code', product_version, profile_id: claudeWorkflowChildProfileId });
  const registry = [entry('2.1.300'), entry('2.1.291', { profile_id: claudeWorkflowChildProfileId }),
    entry('2.1.296', { profile_id: claudeWorkflowChildProfileId }), entry('2.1.999', { profile_id: claudeWorkflowChildProfileId, validation_kind: 'synthetic' })];
  expect(newestAdmittedClaudeWorkflowVersion(undefined, claudeWorkflowChildProfileId)).toBe('2.1.296');
  expect(newestAdmittedClaudeWorkflowVersion(registry, claudeWorkflowChildProfileId)).toBe('2.1.296');
  expect(newestAdmittedClaudeWorkflowVersion([], claudeWorkflowChildProfileId)).toBeNull();
  expect(() => requireLatestClaudeWorkflowProfile([child('2.1.296'), { ...child('2.1.296'), profile_id: claudeWorkflowProfileId }])).not.toThrow();
  expect(() => requireLatestClaudeWorkflowProfile([child('2.1.296')], registry)).not.toThrow();
  expect(() => requireLatestClaudeWorkflowProfile([child('2.1.296'), { ...child('2.1.300'), profile_id: claudeWorkflowProfileId }], registry)).not.toThrow();
  for (const profiles of [[child('2.1.296'), child('2.1.296')], [child('2.1.291')], [child('2.1.297')]]) {
    expect(() => requireLatestClaudeWorkflowProfile(profiles, registry)).toThrow(/^claude_workflow_version_not_latest$/);
  }
  expect(() => requireLatestClaudeWorkflowProfile([child('2.1.297')], undefined, true)).toThrow(/^claude_workflow_version_not_latest$/);
  expect(() => requireLatestClaudeWorkflowProfile([{ ...child('2.1.297'), profile_id: claudeWorkflowProfileId }], undefined, true)).not.toThrow();
});

function probeOptions(workspace: string, version: string) {
  return { workspace, binary: { path: `/synthetic/claude-${version}`, version, sha256: 'a'.repeat(64) },
    destination: { endpoint: 'http://127.0.0.1:43123', headers: { 'x-harness-delta-token': 'SYNTHETIC_TOKEN' }, processId: 'process-1' },
    nativeSessionId: '00000000-0000-4000-8000-000000000001', model: 'claude-sonnet-5-5', effort: 'high' as const, hookCommand: 'node synthetic-hook.js' };
}
const invocation = { model: 'claude-sonnet-5-5', effort: 'high', instructions: 'SYNTHETIC', maxTurns: 1, requestLimit: 1, durationMs: 1000, permissions: 'read-only' as const };
test('native preparation admits 2.1.296 only for a workflow invocation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'claude-versions-'));
  try {
    await expect(prepareClaudeNativeProbe(probeOptions(join(root, 'probe'), '2.1.296'))).rejects.toThrow(/^claude_probe_invalid_preparation$/);
    const prepared = await prepareClaudeNativeProbe(probeOptions(join(root, 'workflow'), '2.1.296'), invocation);
    expect(prepared.manifest.binary.version).toBe('2.1.296'); await prepared.dispose();
    for (const version of ['2.1.290', '2.2.0'])
      await expect(prepareClaudeNativeProbe(probeOptions(join(root, version), version), invocation)).rejects.toThrow(/^claude_probe_invalid_preparation$/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('binary verification keeps the internal probe on 2.1.288 and lets the workflow name its allowlist', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'claude-versions-'))); const path = join(root, 'claude'); writeFileSync(path, 'synthetic');
  try {
    const binary = { path, version: '2.1.296', sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
    expect(() => verifyClaudeProbeBinary(binary)).toThrow(/^claude_probe_executable_mismatch$/);
    expect(() => verifyClaudeProbeBinary(binary, claudeWorkflowProductVersions)).not.toThrow();
    expect(() => verifyClaudeProbeBinary({ ...binary, version: '2.1.290' }, claudeWorkflowProductVersions)).toThrow(/^claude_probe_executable_mismatch$/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const rootScope = { ...traceScope, sessions: traceScope.sessions.slice(0, 1) };
function coordinator(sessionVersion: string, productVersion: string | undefined, workflow = true, childEnabled = true) {
  const store = new Store(':memory:');
  store.execute("INSERT INTO projects(id) VALUES ('project-1')", []);
  store.execute("INSERT INTO tasks(id,project_id,state) VALUES ('task-1','project-1','active')", []);
  store.execute("INSERT INTO sessions(id,project_id,task_id,product,product_version) VALUES ('root','project-1','task-1','claude_code',?)", [sessionVersion]);
  const options: ClaudeProbeOptions = { rootScope, child: { sessionId: 'child', sourceId: 'source-child', agentType: 'qualification-child' }, generation: 0, startedAt,
    model: 'root-model', effort: 'high', clock: () => receivedAt, reserveChild: () => undefined, ...(productVersion ? { productVersion: productVersion } : {}),
    ...(workflow ? { workflow: { synthetic: false, childEnabled, childRuntime: { model: 'child-model', effort: 'high' }, requestLimit: 8, durationMs: 60000,
      assertActive: () => undefined, onChildBound: () => undefined } } : {}) };
  let probe: ClaudeProbeCoordinator;
  try { probe = new ClaudeProbeCoordinator(store, options); } catch (error) { store.close(); throw error; }
  const token = probe.exporterHeaders()['x-harness-delta-token']!;
  const hook = (name: string, patch: Record<string, unknown> = {}) => probe.acceptHook(token, () => ({ hook_event_name: name, session_id: 'native-root', ...patch }));
  const log = (sequence: number, name: string, version: string) => ({ attributes: [...attrs({ 'event.name': name, 'event.sequence': sequence, 'event.timestamp': startedAt,
    'session.id': 'native-root', 'app.version': version, 'managed_settings.trigger': 'startup' }), ...(sequence === 0 ? [{ key: 'managed_settings.sources', value: { arrayValue: { values: [] } } }] : [])] });
  const logs = (records: unknown[]) => probe.ingestLogs(token, () => ({ resourceLogs: [{ resource: { attributes: attrs({ 'harness_delta.process_id': 'process-1' }) }, scopeLogs: [{ logRecords: records }] }] }));
  return { store, probe, token, hook, log, logs };
}
test('the coordinator checks logs, traces and its child session against the launched version', () => {
  const f = coordinator('2.1.296', '2.1.296'); try {
    f.hook('SessionStart', { source: 'startup' });
    // Observed 2.1.296 order: the SessionStart hook_execution_start is sequence 1.
    expect(f.logs([f.log(0, 'managed_settings_resolved', '2.1.296'), f.log(1, 'hook_execution_start', '2.1.296')])).toEqual({ accepted: 2, replayed: 0 });
    f.hook('PreToolUse', { tool_name: 'Agent', tool_use_id: 'tool-child', tool_input: { subagent_type: 'qualification-child' } });
    f.hook('SubagentStart', { agent_id: 'agent-child', agent_type: 'qualification-child' });
    expect(f.store.get('SELECT product_version FROM sessions WHERE id=?', ['child'])).toEqual({ product_version: '2.1.296' });
    const version = { 'app.version': '2.1.296' };
    expect(f.probe.ingestTraces(f.token, () => traces([span(false, { ...version, effort: 'high' }), span(true, { ...version, effort: 'high' })]))).toMatchObject({ inserted: 2 });
    const rows = f.store.all<{ version: string; runtime: string }>("SELECT json_extract(e.payload,'$.product_version') AS version,json_extract(r.payload,'$.product_version') AS runtime FROM events e JOIN runtime_evidence r ON r.id=json_extract(e.payload,'$.runtime_evidence_id')");
    expect(rows).toEqual([{ version: '2.1.296', runtime: '2.1.296' }, { version: '2.1.296', runtime: '2.1.296' }]);
  } finally { f.store.close(); }
});
test.each([['workflow 2.1.296', '2.1.296', '2.1.288', true], ['probe 2.1.288', '2.1.288', '2.1.296', false]] as const)('a %s run stops on a %s log record', (_name, launched, logged, workflow) => {
  const f = coordinator(launched, workflow ? launched : undefined, workflow); try {
    f.hook('SessionStart', { source: 'startup' });
    expect(() => f.logs([f.log(0, 'managed_settings_resolved', logged)])).toThrow(/^claude_probe_log_scope$/);
    expect(f.probe.state().revoked).toBe(true);
  } finally { f.store.close(); }
});
test('a 2.1.296 run stops on a 2.1.288 request trace without storing usage', () => {
  const f = coordinator('2.1.296', '2.1.296'); try {
    f.hook('SessionStart', { source: 'startup' }); f.logs([f.log(0, 'managed_settings_resolved', '2.1.296')]);
    expect(() => f.probe.ingestTraces(f.token, () => traces([span(false, { effort: 'high' })]))).toThrow(/^claude_probe_invalid_traces$/);
    expect(f.store.eventCount()).toBe(0);
  } finally { f.store.close(); }
});
test('the probe coordinator defaults to its pinned 2.1.288; a workflow coordinator needs a listed version and its root session version', () => {
  const f = coordinator('2.1.288', undefined, false); try {
    f.hook('SessionStart', { source: 'startup' });
    expect(f.logs([f.log(0, 'managed_settings_resolved', '2.1.288')])).toEqual({ accepted: 1, replayed: 0 });
  } finally { f.store.close(); }
  expect(() => coordinator('2.1.296', '2.1.296', false)).toThrow(/^claude_probe_invalid_options$/);
  // Retired from the workflow: neither the explicit version nor the probe default is accepted.
  expect(() => coordinator('2.1.288', '2.1.288')).toThrow(/^claude_probe_invalid_options$/);
  expect(() => coordinator('2.1.288', undefined)).toThrow(/^claude_probe_invalid_options$/);
  expect(() => coordinator('2.1.296', '2.1.290')).toThrow(/^claude_probe_invalid_options$/);
  expect(() => coordinator('2.1.288', '2.1.296')).toThrow(/^claude_probe_invalid_options$/);
  expect(() => coordinator('2.1.296', undefined)).toThrow(/^claude_probe_invalid_options$/);
});

function traceStore(sessionVersion: string, store = new Store(':memory:'), taskId = 'task-1', prefix = '') {
  if (!store.get("SELECT 1 FROM projects WHERE id='project-1'")) store.execute("INSERT INTO projects(id) VALUES ('project-1')", []);
  store.execute("INSERT INTO tasks(id,project_id,state) VALUES (?,'project-1','active')", [taskId]);
  for (const s of traceScope.sessions) store.execute('INSERT INTO sessions(id,task_id,project_id,parent_id,product,product_version) VALUES (?,?,?,?,?,?)',
    [prefix + s.sessionId, taskId, 'project-1', s.parentSessionId && prefix + s.parentSessionId, 'claude_code', sessionVersion]);
  return store;
}
const window296 = { startedAt, receivedAt, generation: 0, productVersion: '2.1.296' as const };
test('trace ingestion records the window version and refuses a session of another version', () => {
  const ok = traceStore('2.1.296'); try {
    const body = traces([span(false, { 'app.version': '2.1.296' }), span(true, { 'app.version': '2.1.296' })]);
    expect(ingestClaudeTraceBatch(ok, traceScope, () => body, window296)).toMatchObject({ inserted: 2 });
    expect(ok.all("SELECT DISTINCT json_extract(payload,'$.product_version') AS v FROM events")).toEqual([{ v: '2.1.296' }]);
    // The window check alone: the batch's spans report 2.1.288.
    expect(() => ingestClaudeTraceBatch(ok, traceScope, () => traces(), window296)).toThrow(/^candidate_scope_mismatch$/);
  } finally { ok.close(); }
  const mixed = traceStore('2.1.288'); try {
    expect(() => ingestClaudeTraceBatch(mixed, traceScope, () => traces([span(false, { 'app.version': '2.1.296' })]), window296)).toThrow(/^candidate_scope_mismatch$/);
    expect(mixed.eventCount()).toBe(0);
  } finally { mixed.close(); }
  const unlisted = traceStore('2.1.290'); try {
    expect(() => ingestClaudeTraceBatch(unlisted, traceScope, () => traces([span(false, { 'app.version': '2.1.290' })]),
      { ...window296, productVersion: '2.1.290' })).toThrow(/^claude_trace_invalid_metadata$/);
    expect(unlisted.eventCount()).toBe(0);
  } finally { unlisted.close(); }
});
test('one native request ID is never stored under two version labels', () => {
  const store = traceStore('2.1.288'); try {
    expect(ingestClaudeTraceBatch(store, traceScope, () => traces([span()]), { startedAt, receivedAt, generation: 0 })).toMatchObject({ inserted: 1 });
    traceStore('2.1.296', store, 'task-2', 'other-');
    const other: CandidateScope = { ...traceScope, taskId: 'task-2', sessions: traceScope.sessions.map(s => ({ ...s, sessionId: 'other-' + s.sessionId, rootSessionId: 'other-root',
      parentSessionId: s.parentSessionId && 'other-' + s.parentSessionId, sourceId: 'other-' + s.sourceId })) };
    expect(() => ingestClaudeTraceBatch(store, other, () => traces([span(false, { 'app.version': '2.1.296' })]), window296)).toThrow(/^candidate_conflict$/);
    expect(store.eventCount()).toBe(1);
    // An exact replay under the same version stays idempotent.
    expect(ingestClaudeTraceBatch(store, traceScope, () => traces([span()]), { startedAt, receivedAt, generation: 0 })).toMatchObject({ inserted: 0 });
  } finally { store.close(); }
});
test('the synthetic trace path checks the window version on its own', () => {
  const store = new Store(':memory:'); try {
    store.execute("INSERT INTO comparison_workspace_scope(singleton,purpose) VALUES (1,'synthetic_validation')", []);
    store.execute("INSERT INTO projects(id) VALUES ('project-1')", []);
    store.execute("INSERT INTO tasks(id,project_id,state,metadata) VALUES ('task-1','project-1','active','{\"product\":\"synthetic\"}')", []);
    for (const s of traceScope.sessions) store.execute("INSERT INTO sessions(id,task_id,project_id,parent_id,product,product_version) VALUES (?,'task-1','project-1',?,'synthetic','1.0.0')", [s.sessionId, s.parentSessionId]);
    const window = { ...window296, synthetic: true };
    expect(() => ingestClaudeTraceBatch(store, traceScope, () => traces([span(false, { 'app.version': '2.1.288' })]), window)).toThrow(/^candidate_scope_mismatch$/);
    expect(store.eventCount()).toBe(0);
    expect(ingestClaudeTraceBatch(store, traceScope, () => traces([span(false, { 'app.version': '2.1.296' })]), window)).toMatchObject({ inserted: 1 });
    expect(store.all("SELECT json_extract(payload,'$.product') AS product,json_extract(payload,'$.product_version') AS version FROM events")).toEqual([{ product: 'synthetic', version: '1.0.0' }]);
  } finally { store.close(); }
});
test('the trace projection keys and labels usage by its own allowlisted version', () => {
  const metadata = (productVersion: string) => ({ kind: 'claude_trace', productVersion, processId: 'process-1', nativeSessionId: 'native-root', occurredAt: receivedAt, completed: true,
    span: { name: 'claude_code.llm_request', agent_id: null, parent_agent_id: null, success: true, attempt: 1, request_id: 'request-root', model: 'root-model', effort: 'high', input_tokens: 1, output_tokens: 1 } });
  const a = projectCandidateObservation(traceScope, 'source-root', metadata('2.1.288'), receivedAt);
  const b = projectCandidateObservation(traceScope, 'source-root', metadata('2.1.296'), receivedAt);
  if (a.kind !== 'usage' || b.kind !== 'usage') throw new Error('expected usage');
  expect([a.event.payload.product_version, a.runtime.product_version, b.event.payload.product_version, b.runtime.product_version]).toEqual(['2.1.288', '2.1.288', '2.1.296', '2.1.296']);
  expect(a.event.id).not.toBe(b.event.id);
  expect(() => projectCandidateObservation(traceScope, 'source-root', metadata('2.1.290'), receivedAt)).toThrow(/^candidate_invalid_metadata$/);
});

test.each(['2.1.297','2.1.298'])('conditional parent workflow preserves %s and blocks its cohort after telemetry version drift',version=>{
  const f=coordinator(version,version,true,false);try{
    f.hook('SessionStart',{source:'startup'});f.logs([f.log(0,'managed_settings_resolved',version)]);
    expect(f.probe.ingestTraces(f.token,()=>traces([span(false,{'app.version':version,effort:'high'})]))).toMatchObject({inserted:1});
    expect(f.store.get("SELECT json_extract(payload,'$.product_version') AS version,json_extract(payload,'$.source_compatibility.state') AS state FROM events")).toEqual({version,state:'compatibility_unverified'});
    const stored=f.store.get<Record<string,unknown>>('SELECT * FROM events')!;
    const replay=EventSchema.parse({...stored,payload:JSON.parse(String(stored.payload)) as unknown});
    expect(f.store.putEvent(replay)).toBe(false);expect(f.store.eventCount()).toBe(1);
    expect(()=>f.logs([f.log(1,'api_request','2.1.296')])).toThrow(/^claude_probe_log_scope$/);
    expect(f.probe.state().revoked).toBe(true);
  }finally{f.store.close();}
});
test('conditional Claude child execution remains unsupported',()=>{
  expect(()=>coordinator('2.1.297','2.1.297')).toThrow(/^claude_probe_invalid_options$/);
});

test.each(['hooks','logs','traces'])('conditional Claude authenticated malformed %s JSON invalidates prior usage with sanitized diagnostics',async route=>{
  const f=coordinator('2.1.297','2.1.297',true,false);const {startClaudeProbeGateway}=await import('../src/claude-probe-gateway.js');
  let diagnostic:unknown;const gateway=await startClaudeProbeGateway(f.probe,{onStop:(_reason,value)=>{diagnostic=value;}});try{
    f.hook('SessionStart',{source:'startup'});f.logs([f.log(0,'managed_settings_resolved','2.1.297')]);
    f.probe.ingestTraces(f.token,()=>traces([span(false,{'app.version':'2.1.297',effort:'high'})]));
    const response=await fetch(`${gateway.endpoint}/v1/${route}`,{method:'POST',headers:{'content-type':'application/json','x-harness-delta-token':f.token},body:'{"PRIVATE_SYNTHETIC":'});
    expect(response.status).toBe(400);await response.text();
    expect(f.store.all('SELECT product,product_version,source,reason FROM source_compatibility_blocks')).toEqual([{product:'claude_code',product_version:'2.1.297',source:'claude_workflow',reason:'contract_failed'}]);
    expect(diagnostic).toMatchObject({reason:'metadata',route,category:'claude_probe_invalid_json'});
    expect(f.store.eventCount()).toBe(1);expect(JSON.stringify(diagnostic)).not.toContain('PRIVATE_SYNTHETIC');
  }finally{await gateway.close();f.store.close();}
});
test('conditional Claude transport callback failure stops without declaring its version incompatible',()=>{
  const f=coordinator('2.1.297','2.1.297',true,false);try{
    expect(()=>f.probe.ingestLogs(f.token,()=>{throw new Error('PRIVATE_TRANSPORT_FAILURE');})).toThrow(/^claude_probe_source_error$/);
    expect(f.probe.state().revoked).toBe(true);expect(f.store.all('SELECT * FROM source_compatibility_blocks')).toEqual([]);
    expect(f.store.all('SELECT reason FROM observation_gaps')).toEqual([{reason:'source_error'}]);
  }finally{f.store.close();}
});
