import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test, vi } from 'vitest';
import { evaluateReadiness, productionSourceEvidence, productionAnalysisEvidence, type ReadinessInput } from '../src/readiness.js';
import { evaluateCostCoverage } from '../src/cost-coverage.js';
import { main } from '../src/cli.js';
import { Store } from '../src/store.js';
import { Lifecycle } from '../src/lifecycle.js';
import { registerVariant, registerProtocol, freezeProtocol, showProtocol } from '../src/comparison.js';
import { registerPriceTable } from '../src/pricing.js';
import { comparisonReadiness } from '../src/readiness-store.js';
import { codexWorkflowProfileId } from '../src/codex-workflow-journal.js';
import { createCodexWorkflowAdapter, pinnedCodexWorkflowBinarySha } from '../src/codex-workflow-adapter.js';
import { runAssignedWorkflow } from '../src/task-workflow.js';
import { makeFlexibleFixture } from './helpers/flexible-fixture.js';
import { assignmentInput } from './helpers/comparison-fixture.js';

const evidenceId = 'codex-workflow-01600-root-native-v1';
const profile = { product: 'codex' as const, product_version: '0.160.0', profile_id: codexWorkflowProfileId };
function readiness(): ReadinessInput {
  const f = makeFlexibleFixture();
  return {
    protocol: { ...f.protocol, purpose: 'real_experiment', source_profiles: [profile] },
    source_evidence_ids: [evidenceId],
    coverage: [{ evidence: f.coverage, decision: evaluateCostCoverage(f.coverage) }],
    analysis_evidence_id: null,
    invalidated: false,
    followup_complete: true
  };
}
test('exact native root evidence admits allocation while even complete synthetic facts cannot admit cost or inference', () => {
  expect(evaluateReadiness(readiness())).toMatchObject({ real_allocation: true, complete_cost: false, inference: false });
  expect(evaluateReadiness(readiness()).reasons).toContain('cost_incomplete');
  expect(productionSourceEvidence.filter(row => row.profile_id === codexWorkflowProfileId)).toEqual([
    {
      id: evidenceId,
      ...profile,
      validation_kind: 'real_operations',
      complete_cost: false,
      semantics_digest: 'f97979e1c7878fc8b54a9ab004f7cf69ddd9df39f409f357104f72317937aa8b'
    }
  ]);
  expect(Object.isFrozen(productionSourceEvidence)).toBe(true);
  expect(Object.isFrozen(productionSourceEvidence[0])).toBe(true);
  expect(productionAnalysisEvidence).toHaveLength(0);
  expect(evaluateReadiness({ ...readiness(), analysis_evidence_id: 'bounded-confidence-v1' })).toMatchObject({ inference: false });
});
test.each([
  { ...profile, product_version: '0.160.1' },
  { ...profile, profile_id: 'codex-own-request-v1' },
  { product: 'claude_code' as const, product_version: '2.1.288', profile_id: codexWorkflowProfileId }
])('unmatched source $product/$product_version/$profile_id remains closed', mismatch => {
  expect(evaluateReadiness({ ...readiness(), protocol: { ...readiness().protocol, source_profiles: [mismatch] } })).toMatchObject({
    real_allocation: false,
    complete_cost: false,
    inference: false
  });
});
test('invalidated, mixed, unknown and synthetic-purpose claims cannot use the native registration', () => {
  const i = readiness();
  for (const changed of [
    { invalidated: true },
    { source_evidence_ids: ['untrusted-native'] },
    {
      protocol: {
        ...i.protocol,
        source_profiles: [profile, { product: 'claude_code' as const, product_version: '2.1.288', profile_id: 'claude-child-own-v1' }]
      }
    },
    { protocol: { ...i.protocol, purpose: 'synthetic_validation' as const } }
  ]) {
    expect(evaluateReadiness({ ...i, ...changed })).toMatchObject({ real_allocation: false, complete_cost: false, inference: false });
  }
});

function fixture(version = '0.160.0', purpose: 'real_experiment' | 'functional_pilot' = 'real_experiment') {
  const root = realpathSync(mkdtempSync('/tmp/hdw-admission-'));
  const home = join(root, 'home');
  mkdirSync(home);
  mkdirSync(join(home, 'sessions'));
  const database = join(root, 'measurement.sqlite');
  const store = new Store(database);
  new Lifecycle(store).registerProject('project-1', root);
  const f = makeFlexibleFixture();
  const now = Date.now();
  f.protocol.purpose = purpose;
  if (purpose === 'functional_pilot') {
    delete f.protocol.minimum_effect;
    delete f.protocol.quality_margin;
    delete f.protocol.confidence_level;
  }
  f.protocol.source_profiles = [{ ...profile, product_version: version }];
  f.protocol.recruitment_start = new Date(now - 10000).toISOString();
  f.protocol.recruitment_end = new Date(now + 3600000).toISOString();
  const artifacts = f.variants.map((v, index) => {
    const path = join(root, v.id + '.md');
    const content = 'SYNTHETIC_PRIVATE_ADMISSION_' + String(index);
    writeFileSync(path, content);
    const sha256 = createHash('sha256').update(content).digest('hex');
    v.instruction_manifest_hash = createHash('sha256')
      .update(JSON.stringify([{ artifact_id: 'instructions', sha256 }]))
      .digest('hex');
    registerVariant(store, v);
    return { variant_id: v.id, selected_artifacts: [{ artifact_id: 'instructions', path }] };
  });
  // Synthetic price/protocol values exist only in this isolated offline test.
  registerPriceTable(store, f.priceTable);
  registerProtocol(store, f.protocol);
  freezeProtocol(store, f.protocol.id, new Date(now - 20000).toISOString());
  const input = {
    schema_version: 1,
    assignment: { ...assignmentInput, schema_version: 2, metadata: { ...f.metadata, product: 'codex' } },
    product_version: version,
    confirmation_id: 'begin-confirmation',
    artifacts
  };
  const config = join(root, 'workflow.json');
  const runtime = join(root, 'runtime.json');
  const execution = join(root, 'execution.json');
  writeFileSync(runtime, JSON.stringify({ model: null, effort: null }));
  const prompt = join(root, 'prompt.txt');
  writeFileSync(prompt, 'SYNTHETIC_PRIVATE_PROMPT');
  let stdout = '';
  let stderr = '';
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(value => {
    stdout += String(value);
    return true;
  });
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(value => {
    stderr += String(value);
    return true;
  });
  const call = async (args: string[]) => {
    stdout = '';
    stderr = '';
    const code = await main(['--db', database, ...args]);
    return { code, stdout, stderr };
  };
  const configure = (id: string, operation: 'launch' | 'resume' | 'link' | 'collect', session?: string, source?: string) => {
    writeFileSync(config, JSON.stringify({ ...input, confirmation_id: id + '-confirmation' }));
    writeFileSync(
      execution,
      JSON.stringify({
        run_id: id,
        operation,
        product_version: version,
        // Node's bytes differ from the native pinned hash: launch/resume must fail before spawn.
        binary: { path: realpathSync(process.execPath), sha256: pinnedCodexWorkflowBinarySha },
        codex_home: home,
        hook_recorder: realpathSync(resolve('scripts/conformance/candidate-start-recorder.mjs')),
        prompt_file: prompt,
        sandbox: 'read-only',
        timeout_ms: 3000,
        poll_ms: 10,
        ...(session ? { session_id: session } : {}),
        ...(source ? { source_path: source } : {})
      })
    );
    return ['workflow', 'codex', operation, '--config', config, '--runtime', runtime, '--execution', execution];
  };
  const source = (origin = 'exec') => {
    const id = randomUUID();
    const path = join(home, 'sessions', id + '.jsonl');
    writeFileSync(
      path,
      JSON.stringify({
        type: 'session_meta',
        payload: { id, session_id: id, cwd: root, cli_version: version, source: origin, history_mode: 'paginated' },
        ordinal: 0
      }) + '\n'
    );
    return { id, path };
  };
  const appendUsage = (s: { id: string; path: string }) => {
    const turn = randomUUID();
    const request = randomUUID();
    let ordinal = 1; // One future request after the baseline header.
    const row = (type: string, payload: unknown) => JSON.stringify({ type, payload, ordinal: ordinal++, timestamp: new Date().toISOString() }) + '\n';
    appendFileSync(
      s.path,
      row('event_msg', { type: 'task_started', turn_id: turn }) +
        row('turn_context', { cwd: root, turn_id: turn, model: 'synthetic-observed-model', effort: 'high', multi_agent_version: 'disabled' }) +
        row('token_usage_record', {
          session_id: s.id,
          thread_id: s.id,
          root_turn_id: turn,
          turn_id: turn,
          response_id: request,
          usage: { input_tokens: 10, cached_input_tokens: 2, cache_write_input_tokens: 0, output_tokens: 3, reasoning_output_tokens: 1, total_tokens: 13 }
        }) +
        row('event_msg', { type: 'task_complete', turn_id: turn })
    );
  };
  return {
    root,
    store,
    input,
    config,
    runtime,
    call,
    configure,
    source,
    appendUsage,
    cleanup: () => {
      out.mockRestore();
      err.mockRestore();
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  };
}
test('production CLI reports source readiness and begins a single canonical assignment without applying or launching a harness', async () => {
  const f = fixture();
  try {
    const status = await f.call(['workflow', 'status', 'comparison-1']);
    expect(status.code).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({
      native_execution: true,
      readiness: { real_allocation: true, complete_cost: false, inference: false },
      blockers: ['whole_task_cost_unconfirmed', 'analysis_unverified']
    });
    const shown = await f.call(['comparison', 'show', 'comparison-1']);
    expect(shown.code).toBe(0);
    expect(JSON.parse(shown.stdout)).toMatchObject({ real_allocation_enabled: true, experiment_readiness: 'source_qualified_partial' });
    writeFileSync(f.config, JSON.stringify(f.input));
    const begun = await f.call(['workflow', 'begin', '--config', f.config, '--runtime', f.runtime]);
    expect(begun.code).toBe(0);
    expect(JSON.parse(begun.stdout)).toMatchObject({
      task_id: 'task-1',
      state: 'active',
      harness_application: 'prepared_only',
      inference: false,
      complete_cost: null
    });
    expect(f.store.all('SELECT id FROM comparison_assignments')).toHaveLength(1);
    expect(f.store.all('SELECT id FROM sessions')).toHaveLength(0);
    expect(f.store.all('SELECT id FROM codex_workflow_runs')).toHaveLength(0);
    writeFileSync(f.config, JSON.stringify({ ...f.input, confirmation_id: 'begin-again-confirmation' }));
    const again = await f.call(['workflow', 'begin', '--config', f.config, '--runtime', f.runtime]);
    expect(again.code).toBe(0);
    expect(JSON.parse(again.stdout)).toMatchObject({ task_id: 'task-1', reused: true });
    expect(begun.stdout + status.stdout + shown.stdout).not.toContain('SYNTHETIC_PRIVATE_ADMISSION');
  } finally {
    f.cleanup();
  }
});
test('a child mapping added after factory creation is rejected before selected artifacts are read', async () => {
  const f = fixture();
  try {
    const root = f.source();
    const execution: { direct_child?: { session_id: string; source_path: string }; [key: string]: unknown } = {
      run_id: 'mutated-child',
      operation: 'link',
      session_id: root.id,
      source_path: root.path,
      binary: { path: realpathSync(process.execPath), sha256: pinnedCodexWorkflowBinarySha },
      codex_home: join(f.root, 'home'),
      hook_recorder: realpathSync(resolve('scripts/conformance/candidate-start-recorder.mjs')),
      sandbox: 'read-only',
      timeout_ms: 3000
    };
    const adapter = createCodexWorkflowAdapter(f.store, execution);
    execution.direct_child = { session_id: randomUUID(), source_path: join(f.root, 'home', 'sessions', 'unread-child.jsonl') };
    for (const artifact of f.input.artifacts) rmSync(artifact.selected_artifacts[0]!.path);
    await expect(runAssignedWorkflow(f.store, f.input, adapter, { model: null, effort: null })).rejects.toThrow('workflow_adapter_mismatch');
    expect(f.store.all('SELECT id FROM comparison_assignments')).toHaveLength(0);
    expect(f.store.all('SELECT id FROM codex_workflow_runs')).toHaveLength(0);
  } finally {
    f.cleanup();
  }
});
test('source admission cannot fill missing experiment settings or start a task with absent harness artifacts', async () => {
  const f = fixture();
  try {
    registerProtocol(f.store, { schema_version: 2, id: 'incomplete-real', project_id: 'project-1', mode: 'randomized_task', purpose: 'real_experiment' });
    expect(() => freezeProtocol(f.store, 'incomplete-real', new Date().toISOString())).toThrow('incomplete_protocol');
    expect(showProtocol(f.store, 'incomplete-real')).toMatchObject({
      status: 'draft',
      real_allocation_enabled: false,
      experiment_readiness: 'source_unqualified'
    });
    expect((await f.call(['workflow', 'status', 'incomplete-real'])).code).toBe(2);
    for (const artifact of f.input.artifacts) rmSync(artifact.selected_artifacts[0]!.path);
    writeFileSync(f.config, JSON.stringify(f.input));
    expect((await f.call(['workflow', 'begin', '--config', f.config, '--runtime', f.runtime])).code).toBe(2);
    expect(new Lifecycle(f.store).state('task-1')).toBe('registered');
    expect(f.store.all('SELECT id FROM comparison_assignments')).toHaveLength(1);
    expect(f.store.all('SELECT id FROM codex_workflow_runs')).toHaveLength(0);
  } finally {
    f.cleanup();
  }
});
test('production CLI launch and explicit resume reach the guarded binary check without spawning a product', async () => {
  const f = fixture();
  try {
    // Preflight rejects before assignment, activation or a run journal row.
    const launch = await f.call(f.configure('bad-launch', 'launch'));
    expect(launch).toMatchObject({ code: 2, stdout: '' });
    expect(launch.stderr).toMatch(/^binary_mismatch\nhint: /);
    expect(f.store.all('SELECT id FROM comparison_assignments')).toHaveLength(0);
    expect(f.store.all('SELECT id FROM codex_workflow_runs')).toHaveLength(0);
    const s = f.source();
    expect((await f.call(f.configure('link-before-resume', 'link', s.id, s.path))).code).toBe(0);
    const resumed = await f.call(f.configure('bad-resume', 'resume', s.id));
    expect(resumed).toMatchObject({ code: 2, stdout: '' });
    expect(resumed.stderr).toMatch(/^binary_mismatch\n/);
    expect(f.store.all("SELECT id FROM codex_workflow_runs WHERE id='bad-resume'")).toHaveLength(0);
    expect(f.store.eventCount()).toBe(0);
    expect(f.store.all('SELECT id FROM comparison_assignments')).toHaveLength(1);
    expect(showProtocol(f.store, 'comparison-1')).toMatchObject({ real_allocation_enabled: true });
  } finally {
    f.cleanup();
  }
});
test.each(['vscode', 'mcp', 'app-server', 'unknown'])('production root workflow rejects %s source origin before accepting usage', async origin => {
  const f = fixture();
  try {
    const s = f.source(origin);
    f.appendUsage(s);
    const linked = await f.call(f.configure('unsupported-origin', 'link', s.id, s.path));
    expect(linked.code).toBe(2);
    expect(JSON.parse(linked.stdout)).toMatchObject({
      adapter_result: {
        state: 'failed',
        reason: 'unsupported_session',
        observed_requests: 0,
        diagnostic: { stage: 'root_header', code: 'unsupported_session' }
      }
    });
    expect(f.store.eventCount()).toBe(0);
    expect(f.store.all('SELECT id FROM runtime_evidence')).toHaveLength(0);
    expect(f.store.get("SELECT scope_verified,identity_verified FROM codex_workflow_runs WHERE id='unsupported-origin'")).toEqual({
      scope_verified: 0,
      identity_verified: 0
    });
  } finally {
    f.cleanup();
  }
});
test('production workflow still permits an explicitly linked CLI root while excluding its existing usage baseline', async () => {
  const f = fixture();
  try {
    const s = f.source('cli');
    f.appendUsage(s);
    const linked = await f.call(f.configure('explicit-cli-origin', 'link', s.id, s.path));
    expect(linked.code).toBe(0);
    expect(JSON.parse(linked.stdout)).toMatchObject({
      adapter_result: { state: 'completed', observed_requests: 0, harness_application: 'external_unverified' }
    });
    expect(f.store.eventCount()).toBe(0);
  } finally {
    f.cleanup();
  }
});
test('production CLI links only an explicit synthetic root, observes future own usage, stops durably and replays without backfill', async () => {
  const f = fixture();
  try {
    const s = f.source();
    const linked = await f.call(f.configure('root-link', 'link', s.id, s.path));
    expect(linked.code).toBe(0);
    expect(JSON.parse(linked.stdout)).toMatchObject({
      adapter_result: { state: 'completed', observed_requests: 0, harness_application: 'external_unverified' }
    });
    const collecting = f.call(f.configure('root-collect', 'collect', s.id));
    const deadline = Date.now() + 2000;
    while (!f.store.get("SELECT 1 FROM codex_workflow_runs WHERE id='root-collect' AND identity_verified=1") && Date.now() < deadline)
      await new Promise(ok => setTimeout(ok, 10));
    expect(f.store.get("SELECT 1 FROM codex_workflow_runs WHERE id='root-collect' AND identity_verified=1")).toBeDefined();
    f.appendUsage(s);
    while (f.store.eventCount() === 0 && Date.now() < deadline) await new Promise(ok => setTimeout(ok, 10));
    expect(f.store.eventCount()).toBe(1);
    const stopped = await main(['--db', join(f.root, 'measurement.sqlite'), 'workflow', 'codex', 'stop', 'root-collect']);
    expect(stopped).toBe(0);
    const collected = await collecting;
    expect(collected.code).toBe(0);
    expect(f.store.get('SELECT state,stop_requested,observed_requests FROM codex_workflow_runs WHERE id=?', ['root-collect'])).toEqual({
      state: 'stopped',
      stop_requested: 1,
      observed_requests: 1
    });
    const replaying = f.call(f.configure('root-replay', 'collect', s.id));
    while (!f.store.get("SELECT 1 FROM codex_workflow_runs WHERE id='root-replay' AND identity_verified=1") && Date.now() < deadline)
      await new Promise(ok => setTimeout(ok, 10));
    expect(await main(['--db', join(f.root, 'measurement.sqlite'), 'workflow', 'codex', 'stop', 'root-replay'])).toBe(0);
    expect((await replaying).code).toBe(0);
    expect(f.store.eventCount()).toBe(1);
    expect(f.store.get("SELECT observed_requests FROM codex_workflow_runs WHERE id='root-replay'")).toEqual({ observed_requests: 0 });
    expect(comparisonReadiness(f.store, 'comparison-1')).toMatchObject({ real_allocation: true, complete_cost: false, inference: false });
    expect(new Lifecycle(f.store).state('task-1')).toBe('active');
    expect((await f.call(['workflow', 'finish', 'task-1', '--outcome', 'success', '--met', 'criterion-1'])).code).toBe(0);
    const report = await f.call(['workflow', 'report', 'comparison-1', '--id', 'offline-report', '--cutoff', new Date().toISOString(), '--reason', 'initial']);
    expect(report.code).toBe(0);
    expect(JSON.parse(report.stdout)).toMatchObject({ adoption: { status: 'inconclusive' } });
    expect(report.stdout).not.toContain('SYNTHETIC_PRIVATE');
  } finally {
    f.cleanup();
  }
});

test('conditional native pilot links actual 0.161.0 and collects labeled future usage without exact admission', async () => {
  const f = fixture('0.161.0', 'functional_pilot');
  try {
    expect(comparisonReadiness(f.store, 'comparison-1')).toMatchObject({ real_allocation: false, complete_cost: false, inference: false });
    const status = await f.call(['workflow', 'status', 'comparison-1']);
    expect(JSON.parse(status.stdout)).toMatchObject({ native_execution: true, readiness: { real_allocation: false } });
    const s = f.source();
    expect(await f.call(f.configure('forward-link', 'link', s.id, s.path))).toMatchObject({ code: 0 });
    expect(f.store.get('SELECT product_version FROM sessions WHERE id=?', [s.id])).toEqual({ product_version: '0.161.0' });
    const collecting = f.call(f.configure('forward-collect', 'collect', s.id));
    const deadline = Date.now() + 2000;
    while (!f.store.get("SELECT 1 FROM codex_workflow_runs WHERE id='forward-collect' AND identity_verified=1") && Date.now() < deadline)
      await new Promise(ok => setTimeout(ok, 10));
    f.appendUsage(s);
    while (f.store.eventCount() === 0 && Date.now() < deadline) await new Promise(ok => setTimeout(ok, 10));
    expect(await main(['--db', join(f.root, 'measurement.sqlite'), 'workflow', 'codex', 'stop', 'forward-collect'])).toBe(0);
    expect((await collecting).code).toBe(0);
    expect(f.store.eventCount()).toBe(1);
    expect(
      f.store.get("SELECT json_extract(payload,'$.product_version') AS version,json_extract(payload,'$.source_compatibility.state') AS state FROM events")
    ).toEqual({ version: '0.161.0', state: 'compatibility_unverified' });
  } finally {
    f.cleanup();
  }
});
test('a conditional native version cannot run under a frozen real experiment', async () => {
  const f = fixture('0.161.0');
  try {
    const s = f.source();
    expect((await f.call(f.configure('forward-experiment', 'link', s.id, s.path))).code).toBe(2);
    expect(f.store.all('SELECT id FROM comparison_assignments')).toHaveLength(0);
    expect(f.store.eventCount()).toBe(0);
  } finally {
    f.cleanup();
  }
});

test.each(['0.160.0', '0.161.0'])('durable native block disables %s readiness and pilot execution before source reads', async version => {
  const f = fixture(version, version === '0.160.0' ? 'real_experiment' : 'functional_pilot');
  try {
    const { resolveSourceCompatibility, invalidateCompatibility } = await import('../src/source-compatibility.js');
    const compatibility = resolveSourceCompatibility('codex', version, 'codex_workflow', codexWorkflowProfileId)!;
    invalidateCompatibility(f.store, compatibility, 'semantic_incompatibility');
    expect(comparisonReadiness(f.store, 'comparison-1')).toMatchObject({ real_allocation: false, complete_cost: false, inference: false });
    const status = await f.call(['workflow', 'status', 'comparison-1']);
    expect(JSON.parse(status.stdout)).toMatchObject({ native_execution: false, source_compatibility: [{ state: 'invalidated', product_version: version }] });
    const s = f.source();
    expect((await f.call(f.configure('blocked-native', 'link', s.id, s.path))).code).toBe(2);
    expect(f.store.eventCount()).toBe(0);
    expect(f.store.all('SELECT id FROM sessions')).toHaveLength(0);
  } finally {
    f.cleanup();
  }
});
