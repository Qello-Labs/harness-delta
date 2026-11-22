import { chmodSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { registerOrdinaryWindowActivationCommands } from '../src/cli/ordinary-window-activation-cli.js';
import { activateOrdinaryWindowDecision } from '../src/core/ordinary-window-activation.js';
import { readOrdinaryWindowControl, writeOrdinaryWindowControl } from '../src/core/ordinary-window-control.js';
import { Deletion } from '../src/deletion.js';
import { createOrdinaryWindowTask } from '../src/ordinary-observation.js';
import { ordinaryWindowEmissionControlStale, publishOrdinaryWindowEmissionControl } from '../src/ordinary-window-emission.js';
import { createClaudeWindowFixture } from './helpers/claude-window-fixture.js';
import { createCodexWindowProviderFixture } from './helpers/codex-window-provider-fixture.js';
import { windowDecisionPacket, windowTrialPacket } from './helpers/ordinary-window-decision-fixture.js';

vi.mock('node:fs', { spy: true });
vi.mock('../src/core/ordinary-window-control.js', { spy: true });
const products = ['codex', 'claude_code'] as const;
const cleanups: (() => void)[] = [];
beforeEach(async () => {
  const native = await vi.importActual<typeof import('node:fs')>('node:fs');
  vi.mocked(renameSync).mockImplementation(native.renameSync);
  const controls = await vi.importActual<typeof import('../src/core/ordinary-window-control.js')>('../src/core/ordinary-window-control.js');
  vi.mocked(readOrdinaryWindowControl).mockImplementation(controls.readOrdinaryWindowControl);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function fixture(product: (typeof products)[number]) {
  const f = product === 'codex' ? await createCodexWindowProviderFixture({ activate: false }) : createClaudeWindowFixture();
  cleanups.push(f.cleanup);
  f.life.start(f.taskId);
  const packet = windowTrialPacket(f.selection, { nativeRootId: f.nativeSessionId });
  activateOrdinaryWindowDecision(f.store, packet, f.clock());
  publishOrdinaryWindowEmissionControl(f.store, packet, f.clock());
  vi.setSystemTime(new Date(f.clock()));
  const control = () => readOrdinaryWindowControl(f.projectRoot, product);
  const command = (taskId = f.taskId, flag?: '--decision' | '--arming') => {
    const results: unknown[] = [];
    const program = new Command('window');
    registerOrdinaryWindowActivationCommands(
      program,
      () => f.store,
      result => results.push(result)
    );
    return { program, args: ['node', 'window', 'status', taskId, ...(flag ? [flag] : [])], results };
  };
  const status = async (flag?: '--decision' | '--arming', taskId = f.taskId) => {
    const invocation = command(taskId, flag);
    await invocation.program.parseAsync(invocation.args);
    return invocation.results[0];
  };
  return { ...f, control, status, command };
}

const touches = ['connect', 'collect', 'status', '--decision', '--arming'] as const;
test.each(products.flatMap(product => touches.map(touch => ({ product, touch }))))(
  '$product next $touch repairs a failed automatic termination publication without changing its result',
  async ({ product, touch }) => {
    const f = await fixture(product);
    await f.connect();
    f.advance(60_000);
    vi.setSystemTime(new Date(f.clock()));
    vi.mocked(renameSync).mockImplementation(() => {
      throw new Error('synthetic_control_write_failure');
    });
    await expect(f.collect()).rejects.toThrow('binding_window_trial_expired');
    expect(f.control()?.state).toBe('active');
    const native = await vi.importActual<typeof import('node:fs')>('node:fs');
    vi.mocked(renameSync).mockImplementation(native.renameSync);

    if (touch === 'connect') await expect(f.connect()).rejects.toThrow('binding_scope_revoked');
    else if (touch === 'collect') await expect(f.collect()).rejects.toThrow('binding_scope_revoked');
    else expect(await f.status(touch === 'status' ? undefined : touch)).toMatchObject({ emission_control_stale: false });

    expect(f.control()?.state).toBe('inactive');
    expect(f.store.get('SELECT revocation_reason FROM ordinary_window_activations')).toEqual({ revocation_reason: 'trial_expired' });
  }
);

test.each(products)('%s status reports a persistently stale control while preserving revoked authority', async product => {
  const f = await fixture(product);
  f.store.execute("UPDATE ordinary_window_activations SET revoked_at=?,revocation_reason='operator_revoked'", [f.clock()]);
  vi.mocked(renameSync).mockImplementation(() => {
    throw new Error('synthetic_control_write_failure');
  });

  expect(await f.status('--decision')).toMatchObject({ state: 'revoked', emission_control_stale: true, runtime_authority: false });
  await expect(f.connect()).rejects.toThrow('binding_window_activation_required');
  expect(f.control()?.state).toBe('active');
  expect(f.store.get('SELECT revocation_reason FROM ordinary_window_activations')).toEqual({ revocation_reason: 'operator_revoked' });
});

test.each(products)('%s status repairs a crash between revocation commit and publication', async product => {
  const f = await fixture(product);
  f.store.execute("UPDATE ordinary_window_activations SET revoked_at=?,revocation_reason='operator_revoked'", [f.clock()]);

  expect(await f.status('--decision')).toMatchObject({ state: 'revoked', emission_control_stale: false });

  expect(f.control()?.state).toBe('inactive');
});

test.each(products)('%s status preserves its decision fields when the control cannot be inspected', async product => {
  const f = await fixture(product);
  f.store.execute("UPDATE ordinary_window_activations SET revoked_at=?,revocation_reason='operator_revoked'", [f.clock()]);
  chmodSync(join(f.projectRoot, '.harness-delta', product === 'codex' ? 'window-receipts' : 'claude-window-receipts', 'ordinary-window-control.json'), 0o644);

  expect(await f.status('--decision')).toMatchObject({ state: 'revoked', emission_control_stale: null, runtime_authority: false });

  expect(f.store.get('SELECT revocation_reason FROM ordinary_window_activations')).toEqual({ revocation_reason: 'operator_revoked' });
});

test.each(products)('%s missing root keeps the existing status error and leaves control inspection unknown', async product => {
  const f = await fixture(product);
  f.store.execute('UPDATE projects SET local_root=NULL', []);

  await expect(f.status()).rejects.toThrow('binding_scope_mismatch');
  expect(ordinaryWindowEmissionControlStale(f.store, { taskId: f.taskId })).toBeNull();

  expect(f.control()?.state).toBe('active');
});

test.each(products)('%s matching active control is not written on status or successful baseline', async product => {
  const f = await fixture(product);
  vi.mocked(renameSync).mockClear();
  vi.mocked(writeOrdinaryWindowControl).mockClear();

  await f.connect();
  expect(await f.status('--decision')).toMatchObject({ state: 'recorded', emission_control_stale: false });

  expect(vi.mocked(renameSync)).not.toHaveBeenCalled();
  expect(vi.mocked(writeOrdinaryWindowControl)).not.toHaveBeenCalled();
  expect(f.control()?.state).toBe('active');
});

test.each(products)('%s a different project status preserves shared-root recorded emission without writing', async product => {
  const f = await fixture(product);
  f.life.registerProject('same-root-project', f.projectRoot);
  const taskId = createOrdinaryWindowTask(f.store, {
    schema_version: 2,
    mode: 'ordinary_window',
    project_id: 'same-root-project',
    product,
    declared_version: f.selection.declaredVersion,
    policy_id: f.selection.policy.policyId,
    criterion_ids: ['accepted']
  });
  vi.mocked(writeOrdinaryWindowControl).mockClear();

  expect(await f.status('--decision', taskId)).toMatchObject({ state: 'absent', emission_control_stale: false });

  expect(vi.mocked(writeOrdinaryWindowControl)).not.toHaveBeenCalled();
  expect(f.control()?.state).toBe('active');
});

test.each(products)('%s surviving-task status repairs an absent decision after failed task deletion publication', async product => {
  const f = await fixture(product);
  const survivor = createOrdinaryWindowTask(f.store, {
    schema_version: 2,
    mode: 'ordinary_window',
    project_id: f.selection.projectId,
    product,
    declared_version: f.selection.declaredVersion,
    policy_id: f.selection.policy.policyId,
    criterion_ids: ['accepted']
  });
  vi.mocked(renameSync).mockImplementation(() => {
    throw new Error('synthetic_control_write_failure');
  });
  expect(() => new Deletion(f.store, f.clock).deleteTask(f.taskId)).toThrow('binding_window_control_unavailable');
  const native = await vi.importActual<typeof import('node:fs')>('node:fs');
  vi.mocked(renameSync).mockImplementation(native.renameSync);

  expect(await f.status('--decision', survivor)).toMatchObject({ state: 'absent', emission_control_stale: false });

  expect(f.control()?.state).toBe('inactive');
});

test.each(products)('%s status skips repair in an enclosing transaction and repairs at the outer boundary', async product => {
  const f = await fixture(product);
  f.store.execute("UPDATE ordinary_window_activations SET revoked_at=?,revocation_reason='operator_revoked'", [f.clock()]);
  const nested = f.command(f.taskId, '--decision');
  vi.mocked(renameSync).mockClear();
  f.store.transaction(() => {
    nested.program.parse(nested.args);
    expect(nested.results[0]).toMatchObject({ state: 'revoked', emission_control_stale: true });
    expect(vi.mocked(renameSync)).not.toHaveBeenCalled();
  });
  expect(f.control()?.state).toBe('active');

  expect(await f.status('--decision')).toMatchObject({ state: 'revoked', emission_control_stale: false });

  expect(f.control()?.state).toBe('inactive');
});

test.each(products.flatMap(product => ['activation', 'arming'].map(replacement => ({ product, replacement }))))(
  '$product a newer $replacement wins after stale detection',
  async ({ product, replacement }) => {
    const f = await fixture(product);
    f.store.execute("UPDATE ordinary_window_activations SET revoked_at=?,revocation_reason='operator_revoked'", [f.clock()]);
    const controls = await vi.importActual<typeof import('../src/core/ordinary-window-control.js')>('../src/core/ordinary-window-control.js');
    let reads = 0;
    vi.mocked(readOrdinaryWindowControl).mockImplementation((root, selectedProduct) => {
      if (++reads === 2) {
        f.store.execute('DELETE FROM ordinary_window_activations', []);
        if (replacement === 'activation') {
          activateOrdinaryWindowDecision(f.store, { ...windowDecisionPacket(f.selection), decision_ref: 'newer-decision' }, f.clock());
        } else {
          writeOrdinaryWindowControl({
            schemaVersion: 1,
            projectRoot: f.projectRoot,
            product,
            policyId: f.selection.policy.policyId,
            policyRevision: f.selection.policy.ruleRevision,
            evidenceMode: f.selection.policy.evidenceMode,
            state: 'receipt_only',
            arming: {
              projectId: f.selection.projectId,
              taskId: f.taskId,
              generation: f.life.task(f.taskId).generation,
              policyDigest: f.selection.policyDigest,
              armedAt: f.clock(),
              expiresAt: new Date(Date.parse(f.clock()) + 60000).toISOString()
            }
          });
        }
      }
      return controls.readOrdinaryWindowControl(root, selectedProduct);
    });

    await expect(f.connect()).rejects.toThrow('binding_window_activation_required');

    expect(f.control()?.state).toBe(replacement === 'activation' ? 'active' : 'receipt_only');
    expect(f.store.get('SELECT decision_ref,revoked_at FROM ordinary_window_activations')).toEqual(
      replacement === 'activation' ? { decision_ref: 'newer-decision', revoked_at: null } : undefined
    );
  }
);

test.each(products)('%s status preserves valid receipt-only arming without publication', async product => {
  const f = await fixture(product);
  f.store.execute('DELETE FROM ordinary_window_activations', []);
  writeOrdinaryWindowControl({
    schemaVersion: 1,
    projectRoot: f.projectRoot,
    product,
    policyId: f.selection.policy.policyId,
    policyRevision: f.selection.policy.ruleRevision,
    evidenceMode: f.selection.policy.evidenceMode,
    state: 'receipt_only',
    arming: {
      projectId: f.selection.projectId,
      taskId: f.taskId,
      generation: f.life.task(f.taskId).generation,
      policyDigest: f.selection.policyDigest,
      armedAt: f.clock(),
      expiresAt: new Date(Date.parse(f.clock()) + 60000).toISOString()
    }
  });
  vi.mocked(renameSync).mockClear();

  expect(await f.status('--arming')).toMatchObject({ state: 'receipt_only', emission_control_stale: false });

  expect(vi.mocked(renameSync)).not.toHaveBeenCalled();
  expect(f.control()).toMatchObject({ state: 'receipt_only', arming: { taskId: f.taskId } });
});
