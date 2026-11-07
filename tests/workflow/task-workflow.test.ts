import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { beginAssignedWorkflow, finishAssignedWorkflow, runAssignedWorkflow, workflowStatus } from '../../src/workflow/task-workflow.js';
import type { WorkflowAdapter, WorkflowAdapterResult } from '../../src/workflow/task-workflow.js';
import { Store } from '../../src/store.js';
import { Lifecycle } from '../../src/core/lifecycle.js';
import { registerVariant, registerProtocol, freezeProtocol } from '../../src/comparison/comparison.js';
import { registerPriceTable } from '../../src/pricing/pricing.js';
import { createComparisonSnapshot } from '../../src/comparison/reports/comparison-snapshot.js';
import { Deletion } from '../../src/deletion.js';
import { putUsageWithEvidence } from '../../src/core/runtime-history.js';
import { assignmentInput, beforeRecruitment } from '../helpers/comparison-fixture.js';
import { makeFlexibleFixture } from '../helpers/flexible-fixture.js';

function fixture(native = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'task-workflow-')));
  const f = makeFlexibleFixture();
  let now = '2026-01-01T00:00:00Z';
  const clock = () => now;
  const store = new Store(':memory:', clock);
  new Lifecycle(store, clock).registerProject('project-1', root);
  const artifacts = f.variants.map(variant => {
    const path = join(root, `${variant.id}.md`);
    writeFileSync(path, 'SYNTHETIC_PRIVATE_INSTRUCTION');
    const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
    variant.instruction_manifest_hash = createHash('sha256')
      .update(JSON.stringify([{ artifact_id: 'instruction', sha256 }]))
      .digest('hex');
    registerVariant(store, variant);
    return { variant_id: variant.id, selected_artifacts: [{ artifact_id: 'instruction', path }] };
  });
  if (native) {
    f.protocol.purpose = 'real_experiment';
    f.protocol.source_profiles = [{ product: 'codex', product_version: '0.160.0', profile_id: 'codex-own-request-v1' }];
  }
  registerPriceTable(store, f.priceTable);
  registerProtocol(store, f.protocol);
  freezeProtocol(store, f.protocol.id, beforeRecruitment);
  const input = {
    schema_version: 1 as const,
    assignment: { ...assignmentInput, schema_version: 2 as const, metadata: { ...f.metadata, product: native ? 'codex' : 'synthetic' } },
    product_version: native ? '0.160.0' : '1.0.0',
    confirmation_id: 'confirmation-1',
    artifacts
  };
  return {
    root,
    store,
    input,
    f,
    clock,
    set: (at: string) => {
      now = at;
    },
    cleanup: () => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  };
}
const runtime = { model: 'synthetic-model', effort: 'high' };

test('begin applies only assigned bytes and aliases/runtime changes retain the canonical assignment', () => {
  const f = fixture();
  try {
    const first = beginAssignedWorkflow(f.store, f.input, runtime, f.clock);
    expect(first.instructions).toEqual([{ artifact_id: 'instruction', content: 'SYNTHETIC_PRIVATE_INSTRUCTION' }]);
    expect(first.receipt).toMatchObject({ task_id: 'task-1', reused: false, harness_application: 'prepared_only', state: 'active' });
    f.set('2026-01-01T00:00:01Z');
    const again = beginAssignedWorkflow(
      f.store,
      { ...f.input, confirmation_id: 'confirmation-2', assignment: { ...f.input.assignment, task_id: 'alias-task', alias_ids: ['issue-1'] } },
      { model: 'other-model', effort: null },
      f.clock
    );
    expect(again.receipt).toMatchObject({ task_id: 'task-1', assigned_variant_id: first.receipt.assigned_variant_id, reused: true });
    expect(f.store.all('SELECT id FROM tasks')).toEqual([{ id: 'task-1' }]);
    expect(f.store.all('SELECT allocation_index FROM comparison_assignments')).toEqual([{ allocation_index: 0 }]);
    expect(JSON.stringify(f.store.all('SELECT payload FROM comparison_confirmations'))).not.toContain('SYNTHETIC_PRIVATE_INSTRUCTION');
    expect(JSON.stringify(again.receipt)).not.toContain(f.root);
    expect(workflowStatus(f.store, 'comparison-1', f.clock())).toMatchObject({ native_execution: false });
  } finally {
    f.cleanup();
  }
});

test('artifact drift keeps assignment durable without starting or calling the adapter', async () => {
  const f = fixture();
  let called = 0;
  try {
    for (const artifact of f.input.artifacts) writeFileSync(artifact.selected_artifacts[0]!.path, 'CHANGED_PRIVATE');
    await expect(
      runAssignedWorkflow(
        f.store,
        f.input,
        {
          product: 'synthetic',
          productVersion: '1.0.0',
          profileId: 'synthetic-flexible-v1',
          run: () => {
            called++;
            return Promise.resolve();
          }
        },
        runtime,
        f.clock
      )
    ).rejects.toThrow('workflow_manifest_mismatch');
    expect(called).toBe(0);
    expect(new Lifecycle(f.store).state('task-1')).toBe('registered');
    expect(f.store.all('SELECT id FROM comparison_assignments')).toHaveLength(1);
  } finally {
    f.cleanup();
  }
});

test('unqualified native allocation rejects before missing artifacts or adapter access', async () => {
  const f = fixture(true);
  let called = 0;
  try {
    for (const artifact of f.input.artifacts) rmSync(artifact.selected_artifacts[0]!.path);
    await expect(
      runAssignedWorkflow(
        f.store,
        f.input,
        {
          product: 'codex',
          productVersion: '0.160.0',
          profileId: 'codex-own-request-v1',
          run: () => {
            called++;
            return Promise.resolve();
          }
        },
        { model: 'gpt-6-astra', effort: 'high' },
        f.clock
      )
    ).rejects.toThrow('real_experiment_disabled');
    expect(called).toBe(0);
    expect(f.store.all('SELECT id FROM tasks')).toEqual([]);
    const status = workflowStatus(f.store, 'comparison-1', f.clock());
    expect(status.native_execution).toBe(false);
    expect(status.blockers).toContain('native_source_unqualified');
  } finally {
    f.cleanup();
  }
});

test('synthetic adapter receives canonical task, generation and flexible runtime; completion remains human', async () => {
  const f = fixture();
  try {
    const result = await runAssignedWorkflow(
      f.store,
      f.input,
      {
        product: 'synthetic',
        productVersion: '1.0.0',
        profileId: 'synthetic-flexible-v1',
        run: context => {
          expect(context).toMatchObject({
            taskId: 'task-1',
            projectId: 'project-1',
            projectRoot: f.root,
            generation: 1,
            runtime,
            instructions: [{ content: 'SYNTHETIC_PRIVATE_INSTRUCTION' }]
          });
          return Promise.resolve();
        }
      },
      runtime,
      f.clock
    );
    expect(result).toMatchObject({ task_id: 'task-1', execution: 'adapter_returned', outcome: null });
    expect(new Lifecycle(f.store).state('task-1')).toBe('active');
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC_PRIVATE_INSTRUCTION');
  } finally {
    f.cleanup();
  }
});

test('native adapter cannot execute via synthetic protocol, and adapter errors are sanitized', async () => {
  const f = fixture();
  try {
    await expect(
      runAssignedWorkflow(f.store, f.input, { product: 'codex', productVersion: '0.160.0', profileId: 'any', run: () => Promise.resolve() }, runtime, f.clock)
    ).rejects.toThrow('workflow_adapter_mismatch');
    await expect(
      runAssignedWorkflow(
        f.store,
        f.input,
        {
          product: 'synthetic',
          productVersion: '1.0.0',
          profileId: 'synthetic-flexible-v1',
          run: () => {
            throw new Error('PRIVATE_SECRET');
          }
        },
        runtime,
        f.clock
      )
    ).rejects.toThrow(/^workflow_adapter_failed$/);
    // A throwing adapter never started a native process; this invocation's activation is paused.
    expect(new Lifecycle(f.store).state('task-1')).toBe('paused');
    await expect(
      runAssignedWorkflow(
        f.store,
        { ...f.input, confirmation_id: 'confirmation-2' },
        {
          product: 'synthetic',
          productVersion: '1.0.0',
          profileId: 'synthetic-flexible-v1',
          run: () => {
            throw new Error('binary_mismatch');
          }
        },
        runtime,
        f.clock
      )
    ).rejects.toThrow(/^binary_mismatch$/);
  } finally {
    f.cleanup();
  }
});

const syntheticAdapter = (extra: Partial<WorkflowAdapter>): WorkflowAdapter => ({
  product: 'synthetic',
  productVersion: '1.0.0',
  profileId: 'synthetic-flexible-v1',
  run: () => Promise.resolve(),
  ...extra
});
const failedBeforeLaunch: WorkflowAdapterResult = {
  run_id: 'run-1',
  session_id: null,
  state: 'failed',
  reason: 'binary_mismatch',
  observed_requests: 0,
  harness_application: 'unapplied',
  process_started: false
};

test('adapter preflight failure leaves no assignment, activation or open interval', async () => {
  const f = fixture();
  try {
    let ran = false;
    await expect(
      runAssignedWorkflow(
        f.store,
        f.input,
        syntheticAdapter({
          preflight: () => {
            throw new Error('binary_mismatch');
          },
          run: () => {
            ran = true;
            return Promise.resolve();
          }
        }),
        runtime,
        f.clock
      )
    ).rejects.toThrow(/^binary_mismatch$/);
    expect(ran).toBe(false);
    expect(f.store.all('SELECT id FROM comparison_assignments')).toEqual([]);
    expect(f.store.all('SELECT id FROM active_intervals')).toEqual([]);
    expect(f.store.all("SELECT id FROM tasks WHERE state <> 'registered'")).toEqual([]);
    await expect(
      runAssignedWorkflow(
        f.store,
        f.input,
        syntheticAdapter({
          preflight: () => {
            throw new Error('PRIVATE_SECRET');
          }
        }),
        runtime,
        f.clock
      )
    ).rejects.toThrow(/^workflow_preflight_failed$/);
  } finally {
    f.cleanup();
  }
});

test('a failure before native launch pauses only an activation made by this invocation', async () => {
  const f = fixture();
  try {
    const first = await runAssignedWorkflow(f.store, f.input, syntheticAdapter({ run: () => Promise.resolve(failedBeforeLaunch) }), runtime, f.clock);
    expect(first).toMatchObject({ state: 'paused', activation_reverted: true, adapter_result: { state: 'failed', process_started: false } });
    expect(f.store.all('SELECT id FROM active_intervals WHERE ended_at IS NULL')).toEqual([]);
    f.set('2026-01-01T00:01:00Z');
    const started = await runAssignedWorkflow(
      f.store,
      { ...f.input, confirmation_id: 'confirmation-2' },
      syntheticAdapter({ run: () => Promise.resolve({ ...failedBeforeLaunch, run_id: 'run-2', process_started: true }) }),
      runtime,
      f.clock
    );
    expect(started).toMatchObject({ state: 'active', activation_reverted: false });
    f.set('2026-01-01T00:02:00Z');
    // Already active before this invocation: a pre-launch failure leaves it active.
    const kept = await runAssignedWorkflow(
      f.store,
      { ...f.input, confirmation_id: 'confirmation-3' },
      syntheticAdapter({ run: () => Promise.resolve({ ...failedBeforeLaunch, run_id: 'run-3' }) }),
      runtime,
      f.clock
    );
    expect(kept).toMatchObject({ state: 'active', activation_reverted: false });
    expect(new Lifecycle(f.store).state('task-1')).toBe('active');
  } finally {
    f.cleanup();
  }
});

test('deleted identity and symlink artifacts prevent execution; human criteria guard finalization', async () => {
  const f = fixture();
  try {
    const original = f.input.artifacts[0]!.selected_artifacts[0]!.path;
    const target = join(f.root, 'symlink.md');
    symlinkSync(original, target);
    for (const artifact of f.input.artifacts) artifact.selected_artifacts[0]!.path = target;
    expect(() => beginAssignedWorkflow(f.store, f.input, runtime, f.clock)).toThrow('selected_artifact_error');
    for (const artifact of f.input.artifacts) artifact.selected_artifacts[0]!.path = original;
    // Both registered variants have the same synthetic instruction manifest.
    beginAssignedWorkflow(f.store, f.input, runtime, f.clock);
    expect(() => finishAssignedWorkflow(f.store, 'task-1', 'success', [], f.clock)).toThrow('invalid_criteria');
    new Deletion(f.store, f.clock).deleteTask('task-1');
    await expect(
      runAssignedWorkflow(
        f.store,
        f.input,
        { product: 'synthetic', productVersion: '1.0.0', profileId: 'synthetic-flexible-v1', run: () => Promise.resolve() },
        runtime,
        f.clock
      )
    ).rejects.toThrow('protocol_not_active');
  } finally {
    f.cleanup();
  }
});

test('human finish then explicit snapshot retains original assignment and incomplete cost', () => {
  const f = fixture();
  try {
    const first = beginAssignedWorkflow(f.store, f.input, runtime, f.clock);
    f.set('2026-01-01T00:00:04Z');
    for (const number of [1, 2]) {
      const session = `session-${number}`;
      const event = f.f.events[0]!;
      const evidence = f.f.runtime[0]!;
      f.store.execute('INSERT INTO sessions(id,project_id,task_id,product,product_version) VALUES (?,?,?,?,?)', [
        session,
        'project-1',
        'task-1',
        'synthetic',
        '1.0.0'
      ]);
      putUsageWithEvidence(
        f.store,
        {
          ...event,
          id: `event-${number}`,
          source_key: `event-${number}`,
          session_id: session,
          payload: { ...event.payload, runtime_evidence_id: `runtime-${number}` }
        },
        { ...evidence, id: `runtime-${number}`, session_id: session, request_id: `request-${number}` }
      );
    }
    f.set('2026-01-01T00:00:05Z');
    finishAssignedWorkflow(f.store, 'task-1', 'success', ['criterion-1'], f.clock);
    expect(() => finishAssignedWorkflow(f.store, 'task-1', 'failed', [], f.clock)).toThrow('invalid_transition');
    f.set('2026-01-01T02:00:00Z');
    const report = createComparisonSnapshot(
      f.store,
      { protocolId: 'comparison-1', reportId: 'report-1', cutoff: f.clock(), revisionReason: 'initial' },
      f.clock
    );
    expect(report).toMatchObject({
      tasks: [
        { original_variant_id: first.receipt.assigned_variant_id, quality: { outcome: 'success' }, cost: { complete_amount: null, partial_amount: '0.52' } }
      ],
      adoption: { status: 'inconclusive' }
    });
  } finally {
    f.cleanup();
  }
});

test('pause during adapter execution revokes generation checks and prevents successful completion', async () => {
  const f = fixture();
  try {
    await expect(
      runAssignedWorkflow(
        f.store,
        f.input,
        {
          product: 'synthetic',
          productVersion: '1.0.0',
          profileId: 'synthetic-flexible-v1',
          run: context => {
            new Lifecycle(f.store, f.clock).pause(context.taskId);
            expect(() => context.assertActive()).toThrow('workflow_scope_revoked');
            return Promise.resolve();
          }
        },
        runtime,
        f.clock
      )
    ).rejects.toThrow('workflow_scope_revoked');
  } finally {
    f.cleanup();
  }
});
