import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { prepareExternalWorkflow, runExternalWorkflow, externalWorkflowState, releaseExternalWorkflow } from '../src/external-session-workflow.js';
import { createSyntheticCodexWorkflowAdapter } from '../src/codex-workflow-adapter.js';
import { stopCodexWorkflow } from '../src/codex-workflow-journal.js';
import { Lifecycle } from '../src/lifecycle.js';
import { Deletion } from '../src/deletion.js';
import { selectedArtifactSnapshot } from '../src/config-confirmation.js';
import { codexWorkflowFixture } from './helpers/codex-workflow-fixture.js';

const runtime = { model: null, effort: null };
function fixture() {
  const f = codexWorkflowFixture();
  const spec = {
    schema_version: 1,
    common_artifacts: [],
    common_manifest_hash: null,
    allowed_preimage_hashes: f.input.artifacts.map(a => createHash('sha256').update(readFileSync(a.selected_artifacts[0]!.path)).digest('hex'))
  };
  const target = join(f.project, '.harness-delta-managed', 'active-instructions.md');
  const run = (id: string, operation: 'link' | 'collect', source: { id: string; path: string }) => {
    const execution = f.execution(id, operation, source.id, source.path);
    return runExternalWorkflow(
      f.store,
      { ...f.input, confirmation_id: id + '-confirmation' },
      execution,
      runtime,
      spec,
      createSyntheticCodexWorkflowAdapter(f.store, execution, f.script)
    );
  };
  return { ...f, spec, target, run };
}

test('preparation assigns once without activation and applies only the exclusive managed file', () => {
  const f = fixture();
  try {
    const pending = prepareExternalWorkflow(f.store, f.input, runtime, f.spec);
    expect(pending).toMatchObject({ state: 'preparation_needed', first_connected_at: null, loading_evidence: 'unverified' });
    expect(new Lifecycle(f.store).state('task-1')).toBe('registered');
    expect(f.store.all('SELECT * FROM active_intervals')).toHaveLength(0);
    const assignment = f.store.get('SELECT * FROM comparison_assignments WHERE task_id=?', ['task-1']);
    const prepared = prepareExternalWorkflow(f.store, { ...f.input, confirmation_id: 'apply-confirmation' }, runtime, f.spec, true);
    expect(prepared.state).toBe('configuration_verified');
    expect(readFileSync(f.target, 'utf8')).toBe(
      f.input.artifacts
        .find(a => a.variant_id === prepared.assigned_variant_id)!
        .selected_artifacts.map(a => readFileSync(a.path, 'utf8'))
        .join('\n\n')
    );
    expect(f.store.get('SELECT * FROM comparison_assignments WHERE task_id=?', ['task-1'])).toEqual(assignment);
    expect(JSON.stringify(prepared)).not.toContain(f.project);
  } finally {
    f.cleanup();
  }
});

test('a user-owned preimage is preserved and a second task cannot claim the project surface', () => {
  const f = fixture();
  try {
    mkdirSync(join(f.project, '.harness-delta-managed'));
    writeFileSync(f.target, 'SYNTHETIC_USER_CHANGE');
    expect(() => prepareExternalWorkflow(f.store, f.input, runtime, f.spec, true)).toThrow('external_preimage_unapproved');
    expect(readFileSync(f.target, 'utf8')).toBe('SYNTHETIC_USER_CHANGE');
    const other = {
      ...f.input,
      confirmation_id: 'other-confirmation',
      assignment: { ...f.input.assignment, task_id: 'task-2', logical_task_id: 'logical-2', alias_ids: ['other-alias'] }
    };
    expect(() => prepareExternalWorkflow(f.store, other, runtime, f.spec)).toThrow('external_surface_busy');
  } finally {
    f.cleanup();
  }
});

test('external link starts measurement with zero backfill and preserves the original comparison deadline', async () => {
  const f = fixture();
  try {
    prepareExternalWorkflow(f.store, f.input, runtime, f.spec, true);
    const assignment = f.store.get('SELECT * FROM comparison_assignments WHERE task_id=?', ['task-1']);
    const source = f.newRoot();
    f.appendUsage(source);
    const linked = await f.run('external-link', 'link', source);
    expect(linked.adapter_result).toMatchObject({ state: 'completed', observed_requests: 0, harness_application: 'external_unverified' });
    expect(externalWorkflowState(f.store, 'task-1')).toMatchObject({ state: 'connected', loading_evidence: 'unverified' });
    expect(externalWorkflowState(f.store, 'task-1').first_connected_at).not.toBeNull();
    expect(f.store.eventCount()).toBe(0);
    const promise = f.run('external-collect', 'collect', source);
    const timer = setInterval(() => {
      if (
        f.store.get<{ source_identity: string | null }>('SELECT source_identity FROM codex_workflow_runs WHERE id=?', ['external-collect'])?.source_identity
      ) {
        clearInterval(timer);
        f.appendUsage(source);
        setTimeout(() => stopCodexWorkflow(f.store, 'external-collect'), 100);
      }
    }, 10);
    try {
      await promise;
    } finally {
      clearInterval(timer);
    }
    expect(f.store.eventCount()).toBe(1);
    expect(f.store.get('SELECT * FROM comparison_assignments WHERE task_id=?', ['task-1'])).toEqual(assignment);
    expect(externalWorkflowState(f.store, 'task-1').loading_evidence).toBe('unverified');
    await f.run('external-replay', 'link', source);
    expect(f.store.eventCount()).toBe(1);
    const firstConnected = externalWorkflowState(f.store, 'task-1').first_connected_at;
    releaseExternalWorkflow(f.store, 'task-1', true);
    prepareExternalWorkflow(f.store, { ...f.input, confirmation_id: 'reprepare' }, runtime, f.spec, true);
    const restarted = f.newRoot();
    f.appendUsage(restarted);
    await f.run('external-new-session', 'link', restarted);
    expect(externalWorkflowState(f.store, 'task-1').first_connected_at).toBe(firstConnected);
    expect(f.store.eventCount()).toBe(1);
    expect(f.store.get('SELECT * FROM comparison_assignments WHERE task_id=?', ['task-1'])).toEqual(assignment);
  } finally {
    f.cleanup();
  }
}, 10000);

test('managed-file drift stops before another source read, preserves user bytes and pauses active time', async () => {
  const f = fixture();
  try {
    prepareExternalWorkflow(f.store, f.input, runtime, f.spec, true);
    const source = f.newRoot();
    await f.run('drift-link', 'link', source);
    writeFileSync(f.target, 'SYNTHETIC_DRIFT');
    await expect(f.run('drift-collect', 'collect', source)).rejects.toThrow('external_configuration_drift');
    expect(new Lifecycle(f.store).state('task-1')).toBe('paused');
    expect(readFileSync(f.target, 'utf8')).toBe('SYNTHETIC_DRIFT');
    expect(f.store.eventCount()).toBe(0);
    expect(externalWorkflowState(f.store, 'task-1').state).toBe('configuration_changed');
  } finally {
    f.cleanup();
  }
});

test('common-file drift is preserved and managed-file symlinks cannot replace another file', () => {
  const f = fixture();
  try {
    const common = join(f.project, 'AGENTS.md');
    writeFileSync(common, 'SYNTHETIC_COMMON');
    const spec = {
      ...f.spec,
      common_artifacts: [{ artifact_id: 'common', path: common }],
      common_manifest_hash: selectedArtifactSnapshot([{ artifactId: 'common', path: common }]).hash
    };
    writeFileSync(common, 'SYNTHETIC_COMMON_CHANGED');
    expect(() => prepareExternalWorkflow(f.store, f.input, runtime, spec, true)).toThrow('external_common_drift');
    expect(readFileSync(common, 'utf8')).toBe('SYNTHETIC_COMMON_CHANGED');
    mkdirSync(join(f.project, '.harness-delta-managed'));
    symlinkSync(common, f.target);
    expect(() => prepareExternalWorkflow(f.store, { ...f.input, confirmation_id: 'symlink-confirmation' }, runtime, f.spec, true)).toThrow();
    expect(readFileSync(common, 'utf8')).toBe('SYNTHETIC_COMMON_CHANGED');
    expect(externalWorkflowState(f.store, 'task-1').state).toBe('recovery_needed');
  } finally {
    f.cleanup();
  }
});

test('release requires an external-session stop acknowledgement and deletion cascades local preparation', () => {
  const f = fixture();
  try {
    prepareExternalWorkflow(f.store, f.input, runtime, f.spec, true);
    expect(() => releaseExternalWorkflow(f.store, 'task-1', false)).toThrow('external_stop_acknowledgement_required');
    releaseExternalWorkflow(f.store, 'task-1', true);
    expect(f.store.all('SELECT * FROM external_surface_leases')).toHaveLength(0);
    new Deletion(f.store).deleteTask('task-1');
    expect(f.store.all('SELECT * FROM external_preparations')).toHaveLength(0);
    expect(() => prepareExternalWorkflow(f.store, f.input, runtime, f.spec)).toThrow('deleted_identifier');
  } finally {
    f.cleanup();
  }
});

test('drift during foreground collection rejects before newly appended usage is ingested', async () => {
  const f = fixture();
  try {
    prepareExternalWorkflow(f.store, f.input, runtime, f.spec, true);
    const source = f.newRoot();
    await f.run('live-drift-link', 'link', source);
    const collecting = f.run('live-drift-collect', 'collect', source);
    const assertion = expect(collecting).rejects.toThrow('external_configuration_drift');
    const timer = setInterval(() => {
      if (
        f.store.get<{ source_identity: string | null }>('SELECT source_identity FROM codex_workflow_runs WHERE id=?', ['live-drift-collect'])?.source_identity
      ) {
        clearInterval(timer);
        writeFileSync(f.target, 'SYNTHETIC_LIVE_DRIFT');
        f.appendUsage(source);
      }
    }, 10);
    try {
      await assertion;
    } finally {
      clearInterval(timer);
    }
    expect(f.store.eventCount()).toBe(0);
    expect(new Lifecycle(f.store).state('task-1')).toBe('paused');
    expect(readFileSync(f.target, 'utf8')).toBe('SYNTHETIC_LIVE_DRIFT');
  } finally {
    f.cleanup();
  }
}, 10000);

test('a connection preflight failure leaves no active interval or false pending connection', async () => {
  const f = fixture();
  try {
    prepareExternalWorkflow(f.store, f.input, runtime, f.spec, true);
    const source = f.newRoot();
    const execution = f.execution('preflight-failure', 'link', source.id, source.path);
    const adapter = createSyntheticCodexWorkflowAdapter(f.store, execution, f.script);
    await expect(
      runExternalWorkflow(f.store, { ...f.input, confirmation_id: 'preflight-confirmation' }, execution, runtime, f.spec, {
        ...adapter,
        preflight() {
          throw new Error('binary_mismatch');
        }
      })
    ).rejects.toThrow('binary_mismatch');
    expect(f.store.all('SELECT * FROM active_intervals')).toHaveLength(0);
    expect(externalWorkflowState(f.store, 'task-1')).toMatchObject({ state: 'stopped', first_connected_at: null });
  } finally {
    f.cleanup();
  }
});
