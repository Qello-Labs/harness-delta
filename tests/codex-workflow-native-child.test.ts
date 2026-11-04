import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { main } from '../src/cli.js';
import { prepareCodexWorkflowQualification, executeCodexWorkflowQualification } from '../src/codex-workflow-qualification.js';
import { expect, test, vi } from 'vitest';
import { createCodexWorkflowAdapter, createSyntheticCodexWorkflowAdapter, pinnedCodexWorkflowBinarySha } from '../src/codex-workflow-adapter.js';
import { codexNativeChildFixture as fixture } from './helpers/codex-native-child-fixture.js';

test.each(['callback-first', 'progress-first', 'completed-activity', 'native-start'])(
  'assigned native %s hook path binds direct child and preserves request-local model/effort',
  async mode => {
    const f = fixture(mode);
    try {
      const result = await f.run();
      expect(result.adapter_result, JSON.stringify(result.adapter_result)).toMatchObject({
        state: 'completed',
        observed_requests: 3,
        harness_application: 'invocation_settings_verified'
      });
      expect(f.store.all('SELECT task_id FROM comparison_assignments')).toHaveLength(1);
      const sessions = f.store.all<{ id: string; parent_id: string | null }>('SELECT id,parent_id FROM sessions');
      expect(sessions).toHaveLength(2);
      expect(sessions.find(s => s.parent_id !== null)?.parent_id).toBe(result.adapter_result!.session_id);
      expect(f.store.all('SELECT session_id FROM codex_workflow_children')).toHaveLength(1);
      const runtimes = f.store
        .all<{ payload: string }>('SELECT payload FROM runtime_evidence')
        .map(r => JSON.parse(r.payload) as { model: string; effort: string });
      expect(runtimes.filter(r => r.model === 'root-user-choice' && r.effort === 'medium')).toHaveLength(2);
      expect(runtimes.filter(r => r.model === 'child-user-choice' && r.effort === 'low')).toHaveLength(1);
      expect(f.store.all('SELECT DISTINCT task_id FROM events')).toEqual([{ task_id: 'task-1' }]);
      expect(f.store.all('SELECT payload FROM comparison_confirmations')).toHaveLength(1);
    } finally {
      f.cleanup();
    }
  }
);

test.each(['missing-child', 'missing-id', 'fork', 'runtime-mismatch', 'extra', 'native-start-missing-task'])(
  'native family stops on %s without claiming completion or child usage',
  async mode => {
    const f = fixture(mode);
    try {
      const result = await f.run();
      expect(result.adapter_result!.state).toBe('failed');
      expect(f.store.all('SELECT id FROM events WHERE session_id IN (SELECT id FROM sessions WHERE parent_id IS NOT NULL)')).toHaveLength(0);
      expect(f.store.get<{ state: string }>('SELECT state FROM tasks WHERE id=?', ['task-1'])?.state).toBe('active');
    } finally {
      f.cleanup();
    }
  }
);

test('production native child resume remains gated before instructions or process execution', async () => {
  const f = fixture();
  try {
    const execution = {
      ...f.execution,
      operation: 'resume' as const,
      session_id: '00000000-0000-4000-8000-000000000001',
      binary: { ...f.execution.binary, sha256: pinnedCodexWorkflowBinarySha }
    };
    const adapter = createCodexWorkflowAdapter(f.store, execution);
    expect(adapter.profileId).toBe('codex-workflow-direct-child-v1');
    const assertActive = vi.fn();
    await expect(
      adapter.run({
        projectId: 'unused',
        projectRoot: f.project,
        taskId: 'unused',
        generation: 0,
        assignedVariantId: 'unused',
        confirmationId: 'unused',
        instructionManifestHash: 'unused',
        runtime: { model: null, effort: null },
        instructions: [],
        assertActive
      })
    ).rejects.toThrow('codex_workflow_child_operation_unsupported');
    expect(assertActive).not.toHaveBeenCalled();
    expect(f.store.all('SELECT id FROM codex_workflow_runs')).toHaveLength(0);
  } finally {
    f.cleanup();
  }
});

test('actual CLI schema/coordinator resumes a linked root with one child and replays both without reallocating', async () => {
  const f = fixture();
  let output = '';
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(value => {
    output += String(value);
    return true;
  });
  try {
    const config = join(f.root, 'cli-config.json');
    const runtime = join(f.root, 'cli-runtime.json');
    const execution = join(f.root, 'cli-execution.json');
    const call = async (id: string, operation: 'launch' | 'resume' | 'link', e: unknown) => {
      output = '';
      writeFileSync(config, JSON.stringify({ ...f.input, confirmation_id: id + '-confirmation' }));
      writeFileSync(runtime, JSON.stringify({ model: 'root-user-choice', effort: 'medium' }));
      writeFileSync(execution, JSON.stringify(e));
      const code = await main(['--db', f.database, 'workflow', 'codex', operation, '--config', config, '--runtime', runtime, '--execution', execution], {
        codexAdapter: (store, input) => createSyntheticCodexWorkflowAdapter(store, input, f.script)
      });
      expect(code, output).toBe(0);
      return JSON.parse(output) as { adapter_result: { state: string; session_id: string; observed_requests: number } };
    };
    writeFileSync(f.script, f.baseScript);
    const first = await call('cli-root', 'launch', f.executionFactory('cli-root'));
    writeFileSync(f.script, f.nativeScript);
    const resumed = await call('cli-child', 'resume', {
      ...f.execution,
      run_id: 'cli-child',
      operation: 'resume',
      session_id: first.adapter_result.session_id
    });
    expect(resumed.adapter_result).toMatchObject({ state: 'completed', observed_requests: 3, session_id: first.adapter_result.session_id });
    const kid = f.store.get<{ session_id: string; source_path: string }>('SELECT session_id,source_path FROM codex_workflow_children WHERE run_id=?', [
      'cli-child'
    ])!;
    const replay = await call('cli-replay', 'link', {
      ...f.executionFactory('cli-replay', 'link', first.adapter_result.session_id),
      source_path: f.store.get<{ source_path: string }>('SELECT source_path FROM codex_workflow_runs WHERE id=?', ['cli-child'])!.source_path,
      direct_child: kid
    });
    expect(replay.adapter_result).toMatchObject({ state: 'completed', observed_requests: 0 });
    expect(f.store.eventCount()).toBe(4);
    expect(f.store.all('SELECT id FROM comparison_assignments')).toHaveLength(1);
    expect(output).not.toContain('SYNTHETIC_PRIVATE');
  } finally {
    out.mockRestore();
    f.cleanup();
  }
}, 20000);

test.each(['spawn', 'empty-wait', 'empty-wait-missing-child-usage', 'foreign-wait', 'empty-spawn', 'unknown-item'])(
  'one-shot family qualification validates %s with source-owned child evidence',
  async stdoutMode => {
    const f = fixture();
    try {
      // The fixture projects the pinned JSON stdout marker/collab contract; no
      // native provider or authentication action is performed.
      const markerScript =
        f.nativeScript.replace(
          "if(!['SYNTHETIC_PRIVATE_HARNESS_0','SYNTHETIC_PRIVATE_HARNESS_1'].includes(dev)||!prompt.startsWith('SYNTHETIC_PRIVATE_TASK'))process.exit(3);",
          'const marker=dev.match(/QUALIFICATION_LAUNCH=([a-f0-9]{32})/)?.[1];if(!marker)process.exit(3);'
        ) +
        `\nconsole.log(JSON.stringify({type:'item.completed',item:{id:'spawn-1',type:${JSON.stringify(stdoutMode === 'unknown-item' ? 'SYNTHETIC_PRIVATE_STDOUT_BODY' : 'collab_tool_call')},text:'SYNTHETIC_PRIVATE_STDOUT_BODY',tool:${JSON.stringify(stdoutMode.includes('wait') ? 'wait' : 'spawn_agent')},sender_thread_id:native,receiver_thread_ids:${stdoutMode === 'foreign-wait' ? '[native]' : stdoutMode.startsWith('empty') ? '[]' : '[kid]'},status:'completed'}}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:marker}}));\n`;
      writeFileSync(
        f.script,
        stdoutMode === 'empty-wait-missing-child-usage' ? markerScript.replace(/appendFileSync\(kidPath,kidRow\('token_usage_record'.*\n/, '') : markerScript
      );
      const input = { binary: f.execution.binary, codex_home: f.home, hook_recorder: f.execution.hook_recorder, topology: 'root_direct_child' };
      const dependency = { fixtureScript: f.script, durationMs: 180000 };
      const prepared = prepareCodexWorkflowQualification(join(f.root, 'qualification'), input, dependency);
      expect(prepared.intent).toMatchObject({ topology: 'root_direct_child', planned_native_invocations: 1, planned_own_responses: 4 });
      const result = await executeCodexWorkflowQualification(
        prepared.intentPath,
        {
          intent_sha256: prepared.sha256,
          approval_reference: 'synthetic-only',
          actual_model_run: true,
          transient_harness_hooks: true,
          marker_response_validation: true
        },
        dependency
      );
      if (stdoutMode === 'empty-wait-missing-child-usage') {
        expect(result).toMatchObject({ status: 'failed', native_invocations: 1, replay_insertions: null, complete_cost: null });
        expect(result.phases[0]).toMatchObject({ state: 'failed', reason: 'hook_missing', marker_verified: false });
        const db = new Store(join(f.root, 'qualification', 'measurement.sqlite'));
        try {
          expect(db.get('SELECT count(*) AS count FROM events WHERE session_id IN (SELECT id FROM sessions WHERE parent_id IS NOT NULL)')).toEqual({
            count: 0
          });
        } finally {
          db.close();
        }
        return;
      }
      if (stdoutMode !== 'spawn' && stdoutMode !== 'empty-wait') {
        expect(result).toMatchObject({ status: 'failed', native_invocations: 1, replay_insertions: null, complete_cost: null });
        const eventKind = stdoutMode.includes('wait') ? 'collab_wait' : stdoutMode === 'empty-spawn' ? 'collab_spawn' : 'other_item';
        const code = stdoutMode.startsWith('empty')
          ? 'qualification_receiver_missing'
          : stdoutMode === 'foreign-wait'
            ? 'qualification_receiver_mismatch'
            : 'unexpected_qualification_item';
        expect(result.phases[0]).toMatchObject({ state: 'failed', diagnostic: { stage: 'stdout', code, event_kind: eventKind } });
        const saved = readFileSync(join(f.root, 'qualification', 'execution-evidence.json'), 'utf8');
        expect(JSON.parse(saved) as unknown).toMatchObject({ phases: [{ diagnostic: { stage: 'stdout', code, event_kind: eventKind } }] });
        expect(saved).not.toContain('SYNTHETIC_PRIVATE_STDOUT_BODY');
        expect(JSON.stringify(result)).not.toContain('SYNTHETIC_PRIVATE_STDOUT_BODY');
        return;
      }
      expect(result, JSON.stringify(result.phases)).toMatchObject({
        status: 'completed',
        native_invocations: 1,
        own_responses: 3,
        replay_insertions: 0,
        marker_verified: [true],
        product_gate_delta: false,
        complete_cost: null
      });
      const db = new Store(join(f.root, 'qualification', 'measurement.sqlite'));
      try {
        expect(db.all('SELECT id FROM sessions')).toHaveLength(2);
        expect(db.all('SELECT id FROM comparison_assignments')).toHaveLength(0);
      } finally {
        db.close();
      }
    } finally {
      f.cleanup();
    }
  },
  20000
);
