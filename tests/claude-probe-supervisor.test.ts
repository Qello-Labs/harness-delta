import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from 'vitest';
import { prepareClaudeProbeSupervisor } from '../src/claude-probe-supervisor.js';
import { Store } from '../src/store.js';
import { traceScope } from './helpers/claude-trace-fixture.js';
import { compiledWorker } from './helpers/compiled-worker.js';

function fixture(script = 'process.exit(0);', durationMs = 5000, version = '2.1.288') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'claude-supervisor-'))); const cwd = join(root, 'fixture'); mkdirSync(cwd);
  const workspace = join(root, 'ledger'); mkdirSync(workspace); const compiled = compiledWorker(root);
  const binary = join(root, 'synthetic-product'); const bytes = `#!${process.execPath}\nif(process.argv.includes('--version')){console.log(${JSON.stringify(version+' (Claude Code)')});process.exit(0); }\n${script}\n`; writeFileSync(binary, bytes, { mode: 0o700 });
  const store = new Store(':memory:');
  store.execute('INSERT INTO projects(id,local_root) VALUES (?,?)', ['project-1', cwd]);
  store.execute("INSERT INTO tasks(id,project_id,state) VALUES ('task-1','project-1','active')", []);
  store.execute("INSERT INTO sessions(id,project_id,task_id,product,product_version) VALUES ('root','project-1','task-1','claude_code',?)", [version]);
  const rootScope = { ...traceScope, sessions: traceScope.sessions.slice(0, 1) };
  rootScope.sessions[0] = { ...rootScope.sessions[0]!, nativeSessionId: '11111111-1111-4111-8111-111111111111' };
  const options = { store, rootScope, child: { sessionId: 'child', sourceId: 'source-child', agentType: 'qualification-child' }, generation: 0,
    workspace, cwd, binary: { path: binary, version, sha256: createHash('sha256').update(bytes).digest('hex') },
    mediatorPath: join(compiled, 'claude-probe-hook-mediator.js'), durationMs };
  return { store, options, root, cleanup: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}
test('preparation pins the executable and private settings without consuming a launch or running the synthetic executable', async () => {
  const f = fixture("require('node:fs').writeFileSync('UNEXPECTED', 'x');");
  try {
    const prepared = await prepareClaudeProbeSupervisor(f.options);
    try {
      expect(prepared.manifest.nativeSchemaQualified).toBe(false);
      expect(JSON.stringify(prepared.manifest)).not.toContain('x-harness-delta-token');
      expect(f.store.eventCount()).toBe(0);
    } finally { await prepared.dispose(); }
    expect(() => readFileSync(join(f.options.cwd, 'UNEXPECTED'))).toThrow();
  } finally { f.cleanup(); }
});
test('synthetic launch without terminal telemetry fails safely and permanently consumes its reservation', async () => {
  const f = fixture(); try {
    const prepared = await prepareClaudeProbeSupervisor(f.options);
    const result = await prepared.run();
    expect(result).toMatchObject({ status: 'failed', reason: 'claude_probe_terminal_missing', exitCode: 0, completeCost: null, hardBillingBound: null });
    await expect(prepared.run()).rejects.toThrow('claude_probe_already_reserved');
  } finally { f.cleanup(); }
});
test('absolute supervisor cutoff stops a synthetic process and does not retry', async () => {
  const f = fixture('setTimeout(() => {}, 10000);', 150); try {
    const prepared = await prepareClaudeProbeSupervisor(f.options);
    const result = await prepared.run();
    expect(result).toMatchObject({ status: 'timed_out', reason: 'claude_probe_deadline', completeCost: null, diagnostic: { reason: 'deadline', route: null, category: 'claude_probe_deadline' } });
    expect(f.store.eventCount()).toBe(0);
  } finally { f.cleanup(); }
});
test('changed executable and paused generation fail before synthetic launch', async () => {
  const f = fixture(); try {
    const prepared = await prepareClaudeProbeSupervisor(f.options);
    writeFileSync(f.options.binary.path, '#!/bin/sh\nexit 0\n');
    await expect(prepared.run()).rejects.toThrow('claude_probe_executable_mismatch'); await prepared.dispose();
  } finally { f.cleanup(); }
  const other = fixture(); try {
    const prepared = await prepareClaudeProbeSupervisor(other.options);
    other.store.execute("UPDATE tasks SET state='paused',generation=1 WHERE id='task-1'", []);
    await expect(prepared.run()).rejects.toThrow('claude_trace_scope_revoked'); await prepared.dispose();
  } finally { other.cleanup(); }
});

test.each(['artifact', 'binary', 'credential'] as const)('a synthetic FIFO %s rejects without blocking file validation', kind => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'claude-fifo-')));
  try {
    const compiled = compiledWorker(root); const fifo = join(root, 'synthetic.fifo'); execFileSync('/usr/bin/mkfifo', [fifo]);
    const module = (name: string) => JSON.stringify(pathToFileURL(join(compiled, name)).href);
    const script = kind === 'artifact'
      ? `import {selectedArtifactSnapshot} from ${module('config-confirmation.js')}; try {selectedArtifactSnapshot([{artifactId:'instruction',path:${JSON.stringify(fifo)}}]);process.exitCode=1;}catch {console.log('rejected');}`
      : kind === 'binary'
        ? `import {prepareClaudeProbeSupervisor} from ${module('claude-probe-supervisor.js')};try {await prepareClaudeProbeSupervisor({binary:{version:'2.1.288',sha256:'0'.repeat(64),path:${JSON.stringify(fifo)}}});process.exitCode=1;}catch {console.log('rejected');}`
        : `import {runClaudeProbeHookMediator} from ${module('claude-probe-hook-mediator.js')}; const code=await runClaudeProbeHookMediator(['http://127.0.0.1:1',${JSON.stringify(fifo)}]);if(code===2)console.log('rejected');else process.exitCode=1;`;
    expect(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 3000 })).toContain('rejected');
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 15000);


test('synthetic native metadata rejection reaches the supervisor as a safe fixed diagnostic', async () => {
  const f = fixture(`
const fs = require('node:fs'); const args = process.argv.slice(2);
const settings = JSON.parse(fs.readFileSync(args[args.indexOf('--settings') + 1], 'utf8'));
const token = settings.env.OTEL_EXPORTER_OTLP_HEADERS.split('=')[1];
fetch(settings.env.OTEL_EXPORTER_OTLP_ENDPOINT + '/v1/hooks', { method: 'POST', headers: { 'content-type': 'application/json', 'x-harness-delta-token': token }, body: JSON.stringify({ hook_event_name: 'SessionStart', session_id: args[args.indexOf('--session-id') + 1], source: 'startup', model: 'synthetic-wrong-model' }) }).then(() => process.exit(0));
console.error('PRIVATE_SYNTHETIC_OUTPUT');
`);
  try {
    const prepared = await prepareClaudeProbeSupervisor(f.options); const result = await prepared.run();
    expect(result).toMatchObject({ status: 'stopped', reason: 'claude_probe_observation_stopped', diagnostic: {
      reason: 'metadata', route: 'hooks', category: 'claude_probe_configuration_changed',
    }, nativeSchemaQualified: false, completeCost: null });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  } finally { f.cleanup(); }
});


test('synthetic process completes reversed startup, one child, exact trace replay and terminal accounting', async () => {
  const f = fixture(`
const fs = require('node:fs'); const args = process.argv.slice(2);
const settings = JSON.parse(fs.readFileSync(args[args.indexOf('--settings') + 1], 'utf8'));
const env = settings.env; const session = args[args.indexOf('--session-id') + 1];
const token = env.OTEL_EXPORTER_OTLP_HEADERS.split('=')[1];
const attrs = value => Object.entries(value).map(([key, v]) => ({ key, value: typeof v === 'number' ? { intValue: String(v) } : typeof v === 'boolean' ? { boolValue: v } : { stringValue: v } }));
const post = async (path, body) => { const result = await fetch(env.OTEL_EXPORTER_OTLP_ENDPOINT + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-harness-delta-token': token }, body: JSON.stringify(body) }); if (result.status !== 200) process.exit(1); };
const hook = (name, fields = {}) => post('/v1/hooks', { hook_event_name: name, session_id: session, ...fields });
(async () => {
 const startup = { resourceLogs: [{ resource: { attributes: attrs({ 'harness_delta.process_id': 'process-1' }) }, scopeLogs: [{ logRecords: [{ attributes: [...attrs({ 'event.name': 'managed_settings_resolved', 'event.sequence': 0, 'event.timestamp': new Date().toISOString(), 'session.id': session, 'app.version': '2.1.288', 'managed_settings.trigger': 'startup' }), { key: 'managed_settings.sources', value: { arrayValue: { values: [] } } }] }] }] }] };
 await post('/v1/logs', startup); await post('/v1/logs', startup);
 await hook('SessionStart', { source: 'startup', model: 'claude-sonnet-5-5' });
 await hook('SessionStart', { source: 'startup', model: 'claude-sonnet-5-5' });
 await hook('PreToolUse', { tool_name: 'Agent', tool_use_id: 'tool-child', tool_input: { subagent_type: 'qualification-child' } });
 await hook('SubagentStart', { agent_id: 'synthetic-agent', agent_type: 'qualification-child' });
 await hook('SubagentStart', { agent_id: 'synthetic-agent', agent_type: 'qualification-child' });
 const end = BigInt(Date.now()) * 1000000n;
 const spans = [0, 1, 2].map(i => ({ name: 'claude_code.llm_request', traceId: '1'.repeat(32), spanId: String(i + 2).repeat(16), startTimeUnixNano: String(end - 1n), endTimeUnixNano: String(end), attributes: attrs({ 'session.id': session, 'app.version': '2.1.288', 'harness_delta.process_id': 'process-1', model: 'claude-sonnet-5-5', effort: 'high', request_id: 'synthetic-request-' + i, success: true, attempt: 1, input_tokens: 10, output_tokens: 5, ...(i === 1 ? { agent_id: 'synthetic-agent' } : {}) }) }));
 const traces = { resourceSpans: [{ scopeSpans: [{ spans }] }] };
 await post('/v1/traces', traces); await post('/v1/traces', traces);
 await hook('SubagentStop', { agent_id: 'synthetic-agent', agent_type: 'qualification-child' });
 await hook('SessionEnd'); process.exit(0);
})().catch(() => process.exit(1));
`);
  try {
    const prepared = await prepareClaudeProbeSupervisor(f.options); const result = await prepared.run();
    expect(result).toMatchObject({ status: 'completed', reason: null, diagnostic: null, state: {
      rootStarted: true, childBound: true, childStopped: true, sessionEnded: true, requestsInserted: 3, rootRequests: 2, childRequests: 1, revoked: false,
    }, nativeSchemaQualified: false, completeCost: null, hardBillingBound: null });
    expect(f.store.eventCount()).toBe(3);
    expect(f.store.all('SELECT id,parent_id FROM sessions ORDER BY id')).toEqual([{ id: 'child', parent_id: 'root' }, { id: 'root', parent_id: null }]);
    await expect(prepared.run()).rejects.toThrow('claude_probe_already_reserved');
  } finally { f.cleanup(); }
});
test('the internal probe keeps its 120 s window while an assigned workflow may use one hour', async () => {
  const probe = fixture(); try { await expect(prepareClaudeProbeSupervisor({ ...probe.options, durationMs: 120001 })).rejects.toThrow('claude_probe_invalid_supervisor'); }
  finally { probe.cleanup(); }
  // The assigned workflow runs an admitted workflow version.
  const f = fixture(undefined, undefined, '2.1.296'); try {
    const workflow = { synthetic: false, prompt: 'SYNTHETIC', model: null, effort: null, instructions: 'SYNTHETIC', maxTurns: 1, requestLimit: 1, durationMs: 3600001,
      permissions: 'read-only' as const, assertActive: () => undefined, onChildBound: () => undefined, stopRequested: () => false };
    await expect(prepareClaudeProbeSupervisor({ ...f.options, durationMs: 3600001, workflow })).rejects.toThrow('claude_probe_invalid_supervisor');
    const prepared = await prepareClaudeProbeSupervisor({ ...f.options, durationMs: 600000, workflow: { ...workflow, durationMs: 600000 } });
    expect(prepared.manifest.limits.wallTimeMs).toBe(600000); await prepared.dispose();
  } finally { f.cleanup(); }
});
