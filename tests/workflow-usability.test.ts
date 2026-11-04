import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { main } from '../src/cli.js';
import { createSyntheticCodexWorkflowAdapter } from '../src/codex-workflow-adapter.js';
import { recoverCodexWorkflow, stopCodexWorkflow } from '../src/codex-workflow-journal.js';
import { recoverClaudeWorkflow } from '../src/claude-workflow-adapter.js';
import { runAssignedWorkflow, workflowTaskStatus } from '../src/task-workflow.js';
import type { WorkflowAdapter, WorkflowAdapterResult } from '../src/task-workflow.js';
import { codexWorkflowFixture } from './helpers/codex-workflow-fixture.js';

const runtime = { model: null, effort: null };
afterEach(() => {
  vi.restoreAllMocks();
});

/** A journal row as a run leaves it; 'running' is what a SIGKILLed or crashed collector leaves behind. */
function journalRun(f: ReturnType<typeof codexWorkflowFixture>, id: string, state: 'running' | 'completed', sessionId: string | null, startedAt: string) {
  f.store.execute(
    "INSERT INTO codex_workflow_runs(id,task_id,project_id,confirmation_id,purpose,generation,operation,state,instruction_manifest_hash,application,started_at,session_id) SELECT ?,t.id,t.project_id,(SELECT id FROM comparison_confirmations ORDER BY rowid DESC LIMIT 1),'development',t.generation,'launch',?,?,'pending',?,? FROM tasks t",
    [id, state, 'a'.repeat(64), startedAt, sessionId]
  );
}
/** No native process: these tests cover lifecycle, status and CLI logic only. */
function stub(result?: WorkflowAdapterResult): WorkflowAdapter {
  return { product: 'synthetic', productVersion: '1.0.0', profileId: 'synthetic-flexible-v1', run: () => Promise.resolve(result) };
}

test('a run stranded as running blocks the task until it is explicitly recovered', async () => {
  const f = codexWorkflowFixture();
  try {
    const first = await runAssignedWorkflow(f.store, f.input, createSyntheticCodexWorkflowAdapter(f.store, f.execution('run-1'), f.script), runtime);
    const session = first.adapter_result!.session_id!;
    const strandedAt = new Date().toISOString();
    journalRun(f, 'stranded', 'running', session, strandedAt);
    const blocked = () => runAssignedWorkflow(f.store, { ...f.input, confirmation_id: 'blocked-confirmation' }, stub(), runtime);
    await expect(blocked()).rejects.toThrow('workflow_run_active');
    expect(stopCodexWorkflow(f.store, 'stranded')).toMatchObject({ stop_requested: true, state: 'running' });
    await expect(blocked()).rejects.toThrow('workflow_run_active');
    const recovered = recoverCodexWorkflow(f.store, 'stranded');
    expect(recovered).toMatchObject({ run_id: 'stranded', state: 'failed', reason: 'abandoned', observation_gaps: 1 });
    expect(f.store.get('SELECT state,reason,ended_at IS NOT NULL AS ended FROM codex_workflow_runs WHERE id=?', ['stranded'])).toEqual({
      state: 'failed',
      reason: 'abandoned',
      ended: 1
    });
    // No backfill: the unobserved interval is a recorded gap, never usage.
    expect(f.store.all('SELECT reason FROM observation_gaps WHERE session_id=?', [session])).toEqual([{ reason: 'incomplete' }]);
    expect(() => recoverCodexWorkflow(f.store, 'stranded')).toThrow('workflow_run_not_running');
    expect(() => recoverCodexWorkflow(f.store, 'run-1')).toThrow('workflow_run_not_running');
    // No longer blocked: the next invocation reaches its adapter.
    expect(await runAssignedWorkflow(f.store, { ...f.input, confirmation_id: 'after-recover' }, stub(), runtime)).toMatchObject({
      state: 'active',
      execution: 'adapter_returned'
    });
  } finally {
    f.cleanup();
  }
}, 15000);

test('recovering a Claude run marks it failed once and rejects unknown or finished runs', async () => {
  const f = codexWorkflowFixture();
  try {
    await runAssignedWorkflow(f.store, f.input, stub(), runtime);
    const at = new Date().toISOString();
    f.store.execute(
      "INSERT INTO sessions(id,project_id,task_id,product,product_version) SELECT 'claude-session',project_id,id,'synthetic','1.0.0' FROM tasks",
      []
    );
    f.store.execute(
      "INSERT INTO claude_workflow_runs(id,task_id,project_id,session_id,confirmation_id,generation,instruction_manifest_hash,state,started_at) SELECT 'claude-run',id,project_id,'claude-session',(SELECT id FROM comparison_confirmations LIMIT 1),generation,?,'running',? FROM tasks",
      ['a'.repeat(64), at]
    );
    expect(recoverClaudeWorkflow(f.store, 'claude-run')).toMatchObject({ run_id: 'claude-run', state: 'failed', reason: 'abandoned' });
    expect(() => recoverClaudeWorkflow(f.store, 'claude-run')).toThrow('workflow_run_not_running');
    expect(() => recoverClaudeWorkflow(f.store, 'missing-run')).toThrow('claude_workflow_run_missing');
  } finally {
    f.cleanup();
  }
});

test('task status shows the deadline, runs and next actions without paths or text', async () => {
  const f = codexWorkflowFixture();
  try {
    const first = await runAssignedWorkflow(f.store, f.input, stub(), runtime);
    const deadline = first.followup_ends_at;
    const before = new Date(Date.parse(deadline) - 1000).toISOString();
    journalRun(f, 'run-1', 'completed', null, first.assigned_at);
    const open = workflowTaskStatus(f.store, first.task_id, before);
    expect(open).toMatchObject({
      task_id: first.task_id,
      state: 'active',
      followup_ends_at: deadline,
      followup: 'open',
      outcome: null,
      runs: [{ product: 'codex', run_id: 'run-1', operation: 'launch', state: 'completed' }],
      next_actions: ['finish_before_followup_deadline']
    });
    expect(JSON.stringify(open)).not.toMatch(/SYNTHETIC_PRIVATE|\/sessions\/|codex-workflow-/);
    const after = new Date(Date.parse(deadline) + 1000).toISOString();
    expect(workflowTaskStatus(f.store, first.task_id, after)).toMatchObject({
      followup: 'closed',
      next_actions: ['finish_now_outcome_excluded_after_deadline']
    });
    journalRun(f, 'stranded', 'running', null, before);
    expect(workflowTaskStatus(f.store, first.task_id, before).next_actions).toEqual(['stop_or_recover_running_run', 'finish_before_followup_deadline']);
    expect(() => workflowTaskStatus(f.store, 'unknown-task', before)).toThrow('unknown_task');
  } finally {
    f.cleanup();
  }
});

test('--confirmation supplies a fresh confirmation ID without editing the config file', async () => {
  const f = codexWorkflowFixture();
  try {
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(value => {
      output += String(value);
      return true;
    });
    let errors = '';
    vi.spyOn(process.stderr, 'write').mockImplementation(value => {
      errors += String(value);
      return true;
    });
    const config = join(f.root, 'workflow.json');
    const runtimeFile = join(f.root, 'runtime.json');
    const execution = join(f.root, 'execution.json');
    writeFileSync(config, JSON.stringify(f.input));
    writeFileSync(runtimeFile, JSON.stringify(runtime));
    const deps = { codexAdapter: () => stub() };
    writeFileSync(execution, JSON.stringify(f.execution('cli-1')));
    expect(
      await main(['--db', f.database, 'workflow', 'codex', 'launch', '--config', config, '--runtime', runtimeFile, '--execution', execution], deps),
      errors
    ).toBe(0);
    expect(JSON.parse(output)).toMatchObject({ confirmation_id: 'confirmation-1' });
    output = '';
    writeFileSync(execution, JSON.stringify(f.execution('cli-2', 'resume', '00000000-0000-4000-8000-000000000000')));
    expect(await main(['--db', f.database, 'workflow', 'codex', 'resume', '--config', config, '--runtime', runtimeFile, '--execution', execution], deps)).toBe(
      2
    );
    expect(errors).toMatch(/^confirmation_conflict\nhint: /);
    errors = '';
    expect(
      await main(
        [
          '--db',
          f.database,
          'workflow',
          'codex',
          'resume',
          '--config',
          config,
          '--runtime',
          runtimeFile,
          '--execution',
          execution,
          '--confirmation',
          'confirmation-2'
        ],
        deps
      ),
      errors
    ).toBe(0);
    expect(JSON.parse(output)).toMatchObject({ confirmation_id: 'confirmation-2' });
    output = '';
    expect(await main(['--db', f.database, 'workflow', 'task', 'task-1'])).toBe(0);
    expect(JSON.parse(output)).toMatchObject({ task_id: 'task-1', state: 'active', next_actions: ['finish_before_followup_deadline'] });
    output = '';
    journalRun(f, 'cli-done', 'completed', null, new Date().toISOString());
    expect(await main(['--db', f.database, 'workflow', 'codex', 'stop', 'cli-done'])).toBe(0);
    expect(JSON.parse(output)).toMatchObject({ run_id: 'cli-done', stop_requested: false });
    output = '';
    expect(await main(['--db', f.database, 'workflow', 'codex', 'recover', 'cli-done'])).toBe(2);
    expect(errors).toMatch(/^workflow_run_not_running\n/);
  } finally {
    f.cleanup();
  }
}, 15000);

test('finish discloses whether the outcome counts toward deadline status', async () => {
  const f = codexWorkflowFixture();
  try {
    const { finishAssignedWorkflow } = await import('../src/task-workflow.js');
    const first = await runAssignedWorkflow(f.store, f.input, stub(), runtime);
    const late = new Date(Date.parse(first.followup_ends_at) + 60000).toISOString();
    expect(finishAssignedWorkflow(f.store, first.task_id, 'failed', [], () => late)).toEqual({
      task_id: first.task_id,
      assigned_variant_id: first.assigned_variant_id,
      protocol_id: first.protocol_id,
      outcome: 'failed',
      assessed_at: late,
      followup_ends_at: first.followup_ends_at,
      counted_in_deadline_status: false,
      warnings: ['assessment_after_followup_deadline'],
      comparison_snapshot: 'explicit_later_cutoff_required'
    });
    expect(workflowTaskStatus(f.store, first.task_id, late)).toMatchObject({
      outcome: { status: 'failed', counted_in_deadline_status: false },
      next_actions: ['create_report']
    });
  } finally {
    f.cleanup();
  }
});

test('new reports disclose a late outcome separately; version 1 inputs project unchanged', async () => {
  const f = codexWorkflowFixture();
  try {
    const { finishAssignedWorkflow } = await import('../src/task-workflow.js');
    const { createComparisonSnapshot } = await import('../src/reports/comparison-snapshot.js');
    const { projectFlexibleComparison, FlexibleSnapshotInputSchema } = await import('../src/reports/flexible-comparison.js');
    const { renderComparisonReport } = await import('../src/reports/comparison-render.js');
    const first = await runAssignedWorkflow(f.store, f.input, stub(), runtime);
    const late = new Date(Date.parse(first.followup_ends_at) + 60000).toISOString();
    const cutoff = new Date(Date.parse(late) + 60000).toISOString();
    finishAssignedWorkflow(f.store, first.task_id, 'success', ['criterion-1'], () => late);
    const report = createComparisonSnapshot(f.store, { protocolId: first.protocol_id, reportId: 'report-1', cutoff, revisionReason: 'initial' }, () => cutoff);
    if (report.schema_version !== 2) throw new Error('expected a flexible report');
    expect(report.descriptive_version).toBe('flexible-cost-descriptive-2');
    expect(report.tasks[0]).toMatchObject({
      deadline_status: 'outcome_missing',
      quality: { outcome: null },
      late_outcome: { status: 'success', assessed_at: late }
    });
    expect(report.arms.find(arm => arm.variant_id === first.assigned_variant_id)).toMatchObject({ late_outcome_count: 1, deadline_success_rate: null });
    expect(renderComparisonReport(report, 'markdown')).toContain('1 outcome was assessed after the follow-up deadline');
    const saved = f.store.get<{ input_json: string; report_json: string }>('SELECT input_json,report_json FROM flexible_report_snapshots WHERE report_id=?', [
      'report-1'
    ])!;
    const legacy = FlexibleSnapshotInputSchema.parse({ ...(JSON.parse(saved.input_json) as object), descriptive_version: 'flexible-cost-descriptive-1' });
    const projected = projectFlexibleComparison(legacy);
    expect(projected.descriptive_version).toBe('flexible-cost-descriptive-1');
    expect(projected.tasks[0]).not.toHaveProperty('late_outcome');
    expect(projected.arms[0]).not.toHaveProperty('late_outcome_count');
  } finally {
    f.cleanup();
  }
});

test('another in-progress run prevents pausing; a paused task suggests continuing', async () => {
  const f = codexWorkflowFixture();
  try {
    const failed = (id: string): WorkflowAdapterResult => ({
      run_id: id,
      session_id: null,
      state: 'failed',
      reason: 'binary_mismatch',
      observed_requests: 0,
      harness_application: 'unapplied',
      process_started: false
    });
    const racing: WorkflowAdapter = {
      ...stub(),
      run: () => {
        journalRun(f, 'other-live', 'running', null, new Date().toISOString());
        return Promise.resolve(failed('mine'));
      }
    };
    expect(await runAssignedWorkflow(f.store, f.input, racing, runtime)).toMatchObject({ state: 'active', activation_reverted: false });
    // The pause itself marks the stranded run's interval; recover afterwards cannot add another and says so.
    const { Lifecycle } = await import('../src/lifecycle.js');
    f.store.execute(
      "INSERT INTO sessions(id,project_id,task_id,product,product_version) SELECT 'stranded-session',project_id,id,'synthetic','1.0.0' FROM tasks",
      []
    );
    f.store.execute("UPDATE codex_workflow_runs SET session_id='stranded-session' WHERE id='other-live'", []);
    new Lifecycle(f.store).pause('task-1');
    expect(f.store.all("SELECT reason FROM observation_gaps WHERE session_id='stranded-session'")).toEqual([{ reason: 'incomplete' }]);
    expect(recoverCodexWorkflow(f.store, 'other-live')).toMatchObject({ observation_gaps: 0, gaps_not_recorded: 1, gap_warning: 'task_not_active' });
    const status = workflowTaskStatus(f.store, 'task-1', new Date().toISOString());
    expect(status).toMatchObject({ state: 'paused', next_actions: ['continue_with_launch_or_resume', 'finish_before_followup_deadline'] });
  } finally {
    f.cleanup();
  }
});

test('begin also accepts --confirmation', async () => {
  const f = codexWorkflowFixture();
  try {
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(value => {
      output += String(value);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const config = join(f.root, 'workflow.json');
    const runtimeFile = join(f.root, 'runtime.json');
    writeFileSync(config, JSON.stringify(f.input));
    writeFileSync(runtimeFile, JSON.stringify(runtime));
    expect(await main(['--db', f.database, 'workflow', 'begin', '--config', config, '--runtime', runtimeFile, '--confirmation', 'begin-confirmation'])).toBe(0);
    expect(JSON.parse(output)).toMatchObject({ confirmation_id: 'begin-confirmation', state: 'active' });
  } finally {
    f.cleanup();
  }
});

test('a stored version 1 flexible snapshot still reads back unchanged', async () => {
  const f = codexWorkflowFixture();
  try {
    const { createComparisonSnapshot, readComparisonSnapshot } = await import('../src/reports/comparison-snapshot.js');
    const { canonicalJson } = await import('../src/canonical-json.js');
    const { projectFlexibleComparison, FlexibleSnapshotInputSchema } = await import('../src/reports/flexible-comparison.js');
    const first = await runAssignedWorkflow(f.store, f.input, stub(), runtime);
    const cutoff = new Date(Date.parse(first.followup_ends_at) + 60000).toISOString();
    createComparisonSnapshot(f.store, { protocolId: first.protocol_id, reportId: 'report-2', cutoff, revisionReason: 'initial' }, () => cutoff);
    const saved = f.store.get<{ input_json: string }>('SELECT input_json FROM flexible_report_snapshots WHERE report_id=?', ['report-2'])!;
    // Write the row exactly as the previous release stored it.
    const input = FlexibleSnapshotInputSchema.parse({
      ...(JSON.parse(saved.input_json) as object),
      report_id: 'legacy-1',
      snapshot_sequence: 99,
      descriptive_version: 'flexible-cost-descriptive-1'
    });
    const report = projectFlexibleComparison(input);
    f.store.execute(
      'INSERT INTO flexible_report_snapshots(report_id,protocol_id,cutoff,evaluated_at,data_revision,snapshot_sequence,schema_version,descriptive_version,revision_reason,supersedes_report_id,input_json,report_json,snapshot_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [
        report.report_id,
        report.protocol_id,
        report.cutoff,
        report.evaluated_at,
        report.data_revision,
        report.snapshot_sequence,
        2,
        report.descriptive_version,
        report.revision_reason,
        null,
        canonicalJson(input),
        canonicalJson(report),
        report.snapshot_hash
      ]
    );
    const read = readComparisonSnapshot(f.store, 'legacy-1');
    expect(canonicalJson(read)).toBe(canonicalJson(report));
    expect(JSON.stringify(read)).not.toContain('late_outcome');
  } finally {
    f.cleanup();
  }
});
