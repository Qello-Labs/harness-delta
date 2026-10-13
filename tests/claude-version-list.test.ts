import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { claudeProbeProductVersion, claudeWorkflowProductVersions } from '../src/claude-workflow-versions.js';
import { prepareClaudeNativeProbe } from '../src/claude-native-probe.js';
import { verifyClaudeProbeBinary } from '../src/claude-probe-supervisor.js';
import { ClaudeProbeCoordinator } from '../src/claude-probe-coordinator.js';
import { ingestClaudeTraceBatch } from '../src/claude-trace-candidate.js';
import { projectCandidateObservation } from '../src/nested-candidate.js';
import { Store } from '../src/store.js';
import { createClaudeWorkflowAdapter } from '../src/claude-workflow-adapter.js';
import { beginAssignedWorkflow } from '../src/task-workflow.js';
import { claudeWorkflowFixture } from './helpers/claude-workflow-fixture.js';
import { attrs, receivedAt, seedTraceScope, span, startedAt, traceScope, traces } from './helpers/claude-trace-fixture.js';

// A workflow list without the probe version and with a second, fictional version: the internal
// probe path must not depend on the list, and the adapter must label sessions by binary version.
vi.mock('../src/claude-workflow-versions.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/claude-workflow-versions.js')>();
  const list = Object.freeze(['2.1.296', '2.1.999'] as const);
  return { ...actual, claudeWorkflowProductVersions: list, isClaudeWorkflowProductVersion: (value: unknown) => (list as readonly unknown[]).includes(value) };
});

test('the pinned probe version is independent of a workflow list without it', () => {
  expect(claudeWorkflowProductVersions).toEqual(['2.1.296', '2.1.999']);
  expect(claudeProbeProductVersion).toBe('2.1.288');
});
test('probe preparation and binary verification keep 2.1.288 while the workflow refuses it', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'claude-probe-version-'))); const path = join(root, 'claude'); writeFileSync(path, 'synthetic');
  try {
    const options = (workspace: string) => ({ workspace, binary: { path: '/synthetic/claude-2.1.288', version: '2.1.288', sha256: 'a'.repeat(64) },
      destination: { endpoint: 'http://127.0.0.1:43123', headers: { 'x-harness-delta-token': 'SYNTHETIC_TOKEN' }, processId: 'process-1' },
      nativeSessionId: '00000000-0000-4000-8000-000000000001', model: 'claude-sonnet-5-5', effort: 'high' as const, hookCommand: 'node synthetic-hook.js' });
    const prepared = await prepareClaudeNativeProbe(options(join(root, 'probe'))); await prepared.dispose();
    await expect(prepareClaudeNativeProbe(options(join(root, 'workflow')), { model: null, effort: null, instructions: 'SYNTHETIC', maxTurns: 1, requestLimit: 1,
      durationMs: 1000, permissions: 'read-only' })).rejects.toThrow(/^claude_probe_invalid_preparation$/);
    // Only an explicitly pinned, unadmitted candidate keeps the probe binary in workflow-shaped preparation.
    const pinned = await prepareClaudeNativeProbe(options(join(root, 'candidate')), { model: null, effort: null, instructions: 'SYNTHETIC', maxTurns: 1, requestLimit: 1,
      durationMs: 1000, permissions: 'read-only', pinnedProbeCandidate: true }); await pinned.dispose();
    await expect(prepareClaudeNativeProbe({ ...options(join(root, 'candidate-new')), binary: { path: '/synthetic/claude-2.1.296', version: '2.1.296', sha256: 'a'.repeat(64) } },
      { model: null, effort: null, instructions: 'SYNTHETIC', maxTurns: 1, requestLimit: 1, durationMs: 1000, permissions: 'read-only', pinnedProbeCandidate: true }))
      .rejects.toThrow(/^claude_probe_invalid_preparation$/);
    const binary = { path, version: '2.1.288', sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
    expect(() => verifyClaudeProbeBinary(binary)).not.toThrow();
    expect(() => verifyClaudeProbeBinary(binary, claudeWorkflowProductVersions)).toThrow(/^claude_probe_executable_mismatch$/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('the probe coordinator and trace path still store 2.1.288 usage', () => {
  const store = new Store(':memory:'); try {
    store.execute("INSERT INTO projects(id) VALUES ('project-1')", []);
    store.execute("INSERT INTO tasks(id,project_id,state) VALUES ('task-1','project-1','active')", []);
    store.execute("INSERT INTO sessions(id,project_id,task_id,product,product_version) VALUES ('root','project-1','task-1','claude_code','2.1.288')", []);
    let now = startedAt;
    const options = { rootScope: { ...traceScope, sessions: traceScope.sessions.slice(0, 1) }, child: { sessionId: 'child', sourceId: 'source-child', agentType: 'qualification-child' },
      generation: 0, startedAt, model: 'root-model', effort: 'high', clock: () => now, reserveChild: () => undefined };
    const probe = new ClaudeProbeCoordinator(store, options); const token = probe.exporterHeaders()['x-harness-delta-token']!;
    const hook = (name: string, patch: Record<string, unknown> = {}) => probe.acceptHook(token, () => ({ hook_event_name: name, session_id: 'native-root', ...patch }));
    hook('SessionStart', { source: 'startup', model: 'root-model' });
    probe.ingestLogs(token, () => ({ resourceLogs: [{ resource: { attributes: attrs({ 'harness_delta.process_id': 'process-1' }) }, scopeLogs: [{ logRecords: [{ attributes: [
      ...attrs({ 'event.name': 'managed_settings_resolved', 'event.sequence': 0, 'event.timestamp': startedAt, 'session.id': 'native-root', 'app.version': '2.1.288', 'managed_settings.trigger': 'startup' }),
      { key: 'managed_settings.sources', value: { arrayValue: { values: [] } } }] }] }] }] }));
    now = receivedAt;
    hook('PreToolUse', { tool_name: 'Agent', tool_use_id: 'tool-child', tool_input: { subagent_type: 'qualification-child' } });
    hook('SubagentStart', { agent_id: 'agent-child', agent_type: 'qualification-child' });
    expect(probe.ingestTraces(token, () => traces([span(false, { effort: 'high' }), span(true, { model: 'root-model' })]))).toMatchObject({ inserted: 2 });
    expect(store.all("SELECT DISTINCT json_extract(payload,'$.product_version') AS v FROM events")).toEqual([{ v: '2.1.288' }]);
    // A workflow coordinator can no longer use the retired version.
    expect(() => new ClaudeProbeCoordinator(store, { ...options, child: { ...options.child, sessionId: 'child-2', sourceId: 'source-child-2' }, productVersion: '2.1.288',
      workflow: { synthetic: false, childEnabled: false, requestLimit: 1, durationMs: 1000, assertActive: () => undefined, onChildBound: () => undefined } })).toThrow(/^claude_probe_invalid_options$/);
  } finally { store.close(); }
  const trace = new Store(':memory:'); try {
    seedTraceScope(trace);
    expect(ingestClaudeTraceBatch(trace, traceScope, () => traces(), { startedAt, receivedAt, generation: 0 })).toMatchObject({ inserted: 2 });
  } finally { trace.close(); }
  const projected = projectCandidateObservation(traceScope, 'source-root', { kind: 'claude_trace', productVersion: '2.1.288', processId: 'process-1', nativeSessionId: 'native-root',
    occurredAt: receivedAt, completed: true, span: { name: 'claude_code.llm_request', agent_id: null, parent_agent_id: null, success: true, attempt: 1, request_id: 'request-root',
      model: 'root-model', effort: 'high', input_tokens: 1, output_tokens: 1 } }, receivedAt);
  expect(projected).toMatchObject({ kind: 'usage', event: { payload: { product_version: '2.1.288' } } });
});
test('the native adapter labels its session with the declared binary version, not a literal', async () => {
  const f = claudeWorkflowFixture(); try {
    const prepared = beginAssignedWorkflow(f.store, f.input, { model: null, effort: null });
    // A non-private workspace stops the run after the session insert and before any process starts.
    const workspace = join(dirname(f.project), 'open-workspace'); mkdirSync(workspace); chmodSync(workspace, 0o755);
    const adapter = createClaudeWorkflowAdapter(f.store, { ...f.execution, workspace, permissions: 'read-only', binary: { ...f.execution.binary, version: '2.1.999' } });
    expect(adapter.productVersion).toBe('2.1.999');
    const result = await adapter.run({ taskId: prepared.receipt.task_id, projectId: 'project-1', projectRoot: f.project, generation: prepared.receipt.generation,
      assignedVariantId: prepared.receipt.assigned_variant_id, confirmationId: 'confirmation-1', instructionManifestHash: prepared.receipt.instruction_manifest_hash,
      runtime: { model: null, effort: null }, instructions: prepared.instructions, assertActive: () => undefined });
    expect(result).toMatchObject({ state: 'failed', reason: 'claude_workflow_private_workspace_required', process_started: false });
    expect(f.store.all('SELECT product,product_version FROM sessions')).toEqual([{ product: 'claude_code', product_version: '2.1.999' }]);
  } finally { f.cleanup(); }
});
