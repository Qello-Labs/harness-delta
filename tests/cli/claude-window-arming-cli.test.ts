import '../helpers/claude-window-preservation.mjs';
import { readFileSync } from 'node:fs';
import { afterEach, expect, test } from 'vitest';
import { Lifecycle } from '../../src/core/lifecycle.js';
import { Deletion } from '../../src/deletion.js';
import { createOrdinaryWindowTask, revokeOrdinaryObservation } from '../../src/ordinary-observation.js';
import { armOrdinaryWindowTrial } from '../../src/cli/ordinary-window-activation-cli.js';
import { activateOrdinaryWindowDecision } from '../../src/core/ordinary-window-activation.js';
import { disarmOrdinaryWindowTrial, ordinaryWindowArmingStatus, publishOrdinaryWindowEmissionControl } from '../../src/ordinary-window-emission.js';
import { collectOrdinaryClaudeWindow, connectOrdinaryClaudeWindow } from '../../src/ordinary-session-binding.js';
import { createClaudeWindowArmingFixture, createCodexArmingSibling, runClaudeArmingHook } from '../helpers/claude-window-arming-fixture.js';
import { windowDecisionPacket, windowRevocationPacket, windowTrialPacket } from '../helpers/ordinary-window-decision-fixture.js';

const fixtures: ReturnType<typeof createClaudeWindowArmingFixture>[] = [];
function fixture(install = true) {
  const f = createClaudeWindowArmingFixture(install);
  fixtures.push(f);
  return f;
}
afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup();
});
const armArgs = (taskId: string) => ['compatibility', 'ordinary-window', 'arm', taskId, '--duration-ms', '60000'];
function noNative(result: Awaited<ReturnType<typeof runClaudeArmingHook>>) {
  expect(result.effects).toMatchObject({ unauthorizedCalls: 0, nativeCalls: 0, processCalls: 0, operations: [] });
  expect(result.code, result.stderr).toBe(0);
}

test('arms Claude through the CLI and activates the unchanged trial using the installed hook root before connecting and collecting', async () => {
  const f = fixture();
  const armed = await f.run(armArgs(f.taskId));
  expect(armed.code, armed.stderr).toBe(0);
  expect(armed.effects).toEqual({ nativeCalls: 0, processCalls: 0, operations: [] });
  expect(JSON.parse(armed.stdout) as unknown).toMatchObject({ state: 'receipt_only', runtime_authority: false });
  expect(f.store.all('SELECT * FROM ordinary_window_activations')).toEqual([]);
  const emitted = await runClaudeArmingHook(f);
  noNative(emitted);
  expect(emitted.receipts).toHaveLength(1);
  const receipt = emitted.receipts[0];
  if (!receipt) throw new Error('fixture_hook_receipt_missing');
  expect(receipt).toMatchObject({ nativeSessionId: f.nativeSessionId, event: 'connect', agentId: null, cwd: f.projectRoot });
  expect(JSON.stringify(receipt)).not.toContain('SYNTHETIC_PRIVATE_SENTINEL');
  const activated = await f.run([
    'compatibility',
    'ordinary-window',
    'activate',
    f.packet(windowTrialPacket(f.selection, { nativeRootId: receipt.nativeSessionId, durationMs: 60000, tokenLimit: 1000 }))
  ]);
  expect(activated.code, activated.stderr).toBe(0);
  expect(ordinaryWindowArmingStatus(f.store, f.taskId, f.options.clock()).state).toBe('consumed');
  const connected = await connectOrdinaryClaudeWindow(f.options, { receipt: receipt.receipt });
  expect(connected.automatic_children).toBe(false);
  f.append([{ ...f.assistant('live-request'), timestamp: f.options.clock() }]);
  await collectOrdinaryClaudeWindow(f.options, connected.rootSessionId);
  expect(f.store.eventCount()).toBe(1);
  expect(f.store.get<{ trial_tokens_consumed: number }>('SELECT trial_tokens_consumed FROM ordinary_window_activations')?.trial_tokens_consumed).toBe(26);
}, 20000);

test('receipt-only arming has durable status but cannot connect or collect without a decision', async () => {
  const f = fixture();
  const armed = await f.run(armArgs(f.taskId));
  expect(armed.code, armed.stderr).toBe(0);
  const status = await f.run(['compatibility', 'ordinary-window', 'status', f.taskId, '--arming']);
  expect(status.code, status.stderr).toBe(0);
  expect(JSON.parse(status.stdout) as unknown).toMatchObject({ task_id: f.taskId, state: 'receipt_only', runtime_authority: false });
  const emitted = await runClaudeArmingHook(f);
  noNative(emitted);
  expect(emitted.receipts).toHaveLength(1);
  const receipt = emitted.receipts[0];
  if (!receipt) throw new Error('fixture_hook_receipt_missing');
  await expect(connectOrdinaryClaudeWindow(f.options, { receipt: receipt.receipt })).rejects.toThrow('binding_window_activation_required');
  await expect(collectOrdinaryClaudeWindow(f.options, 'unlinked-root')).rejects.toThrow('binding_window_activation_required');
  expect(f.binary.operations).toEqual([]);
  expect(f.store.all('SELECT * FROM sessions')).toEqual([]);
  expect(f.store.eventCount()).toBe(0);
}, 20000);

test.each(['unarmed', 'other-project', 'SubagentStart', 'SubagentStop'] as const)(
  'installed Claude hook emits nothing for %s receipt-only scope',
  async kind => {
    const f = fixture();
    if (kind !== 'unarmed') armOrdinaryWindowTrial(f.store, f.taskId, 60000, f.options.clock());
    const child = kind === 'SubagentStart' || kind === 'SubagentStop';
    const emitted = await runClaudeArmingHook(f, {
      input: {
        ...f.input,
        cwd: kind === 'other-project' ? '/synthetic/other-project' : f.projectRoot,
        hook_event_name: child ? kind : 'SessionStart',
        ...(child ? { agent_id: 'synthetic-child' } : {})
      }
    });
    noNative(emitted);
    expect([emitted.receipts, emitted.effects.metadataWrites, emitted.stdout]).toEqual([[], 0, '']);
    expect(f.store.all('SELECT * FROM ordinary_window_activations')).toEqual([]);
  },
  20000
);
test.each(['disarm', 'expired', 'pause', 'finalize', 'revoke-collection', 'delete-task', 'delete-project'] as const)(
  '%s clears Claude arming without creating a decision or permitting a receipt',
  async operation => {
    const f = fixture();
    armOrdinaryWindowTrial(f.store, f.taskId, 60000, operation === 'expired' ? '2000-01-01T00:00:00.000Z' : f.options.clock());
    switch (operation) {
      case 'expired':
        expect((await runClaudeArmingHook(f)).receipts).toEqual([]);
        expect(ordinaryWindowArmingStatus(f.store, f.taskId, f.options.clock()).state).toBe('expired');
        break;
      case 'disarm': {
        const result = await f.run(['compatibility', 'ordinary-window', 'disarm', f.taskId]);
        expect(result.code, result.stderr).toBe(0);
        break;
      }
      case 'pause':
        new Lifecycle(f.store).pause(f.taskId);
        break;
      case 'finalize':
        new Lifecycle(f.store).finalize(f.taskId, 'aborted', []);
        break;
      case 'revoke-collection':
        revokeOrdinaryObservation(f.store, f.taskId);
        break;
      case 'delete-task':
        new Deletion(f.store).deleteTask(f.taskId);
        break;
      case 'delete-project':
        new Deletion(f.store).deleteProject(f.selection.projectId);
        break;
      default: {
        const exhaustive: never = operation;
        throw new Error('fixture_unhandled_operation', { cause: exhaustive });
      }
    }
    expect(JSON.parse(readFileSync(f.controlPath, 'utf8')) as unknown).toMatchObject({ state: 'inactive' });
    const emitted = await runClaudeArmingHook(f);
    noNative(emitted);
    expect([emitted.receipts, emitted.effects.metadataWrites, emitted.stdout]).toEqual([[], 0, '']);
    expect(f.store.all('SELECT * FROM ordinary_window_activations')).toEqual([]);
  },
  20000
);

test.each(['disarm', 'consume'] as const)(
  'rejects an in-flight receipt-only hook after %s through product APIs',
  async operation => {
    const f = fixture();
    armOrdinaryWindowTrial(f.store, f.taskId, 60000, f.options.clock());
    const emitted = await runClaudeArmingHook(f, {
      afterControlRead: () => {
        switch (operation) {
          case 'consume': {
            const key = activateOrdinaryWindowDecision(f.store, windowDecisionPacket(f.selection), f.options.clock());
            publishOrdinaryWindowEmissionControl(f.store, key, f.options.clock());
            break;
          }
          case 'disarm':
            disarmOrdinaryWindowTrial(f.store, f.taskId, f.options.clock());
            break;
          default: {
            const exhaustive: never = operation;
            throw new Error('fixture_unhandled_operation', { cause: exhaustive });
          }
        }
      }
    });
    noNative(emitted);
    expect([emitted.receipts, emitted.effects.metadataWrites, emitted.stdout]).toEqual([[], 0, '']);
    expect(ordinaryWindowArmingStatus(f.store, f.taskId, f.options.clock()).state).toBe(operation === 'consume' ? 'consumed' : 'inactive');
  },
  20000
);

test('an active installed hook rejects an out-of-project receipt after real APIs replace the project and arm Claude while stdin is pending', async () => {
  const f = fixture();
  const activated = await f.run(['compatibility', 'ordinary-window', 'activate', f.packet(windowDecisionPacket(f.selection))]);
  expect(activated.code, activated.stderr).toBe(0);
  expect(JSON.parse(readFileSync(f.controlPath, 'utf8')) as unknown).toMatchObject({ state: 'active' });
  let replacementTask: string | undefined;
  const emitted = await runClaudeArmingHook(f, {
    input: { ...f.input, cwd: '/synthetic/unarmed-other-project' },
    afterControlRead: () => {
      new Deletion(f.store).deleteProject(f.selection.projectId);
      const life = new Lifecycle(f.store);
      life.registerProject('replacement-project', f.projectRoot);
      replacementTask = createOrdinaryWindowTask(f.store, {
        schema_version: 2,
        mode: 'ordinary_window',
        project_id: 'replacement-project',
        product: 'claude_code',
        declared_version: f.selection.declaredVersion,
        policy_id: f.selection.policy.policyId,
        criterion_ids: ['accepted']
      });
      life.start(replacementTask);
      expect(armOrdinaryWindowTrial(f.store, replacementTask, 60000, f.options.clock()).state).toBe('receipt_only');
    }
  });
  noNative(emitted);
  expect(f.store.get('SELECT id FROM projects WHERE id=?', [f.selection.projectId])).toBeUndefined();
  if (!replacementTask) throw new Error('fixture_replacement_task_missing');
  expect(ordinaryWindowArmingStatus(f.store, replacementTask, f.options.clock()).state).toBe('receipt_only');
  expect([emitted.receipts, emitted.effects.metadataWrites, emitted.stdout]).toEqual([[], 0, '']);
}, 20000);

test.each(['codex', 'claude_code'] as const)(
  'pausing %s clears only its own arming at a shared project root',
  product => {
    const f = fixture();
    const codexTask = createCodexArmingSibling(f);
    const life = new Lifecycle(f.store);
    armOrdinaryWindowTrial(f.store, codexTask, 60000, f.options.clock());
    armOrdinaryWindowTrial(f.store, f.taskId, 60000, f.options.clock());
    life.pause(product === 'codex' ? codexTask : f.taskId);
    expect(ordinaryWindowArmingStatus(f.store, codexTask, f.options.clock()).state).toBe(product === 'codex' ? 'inactive' : 'receipt_only');
    expect(ordinaryWindowArmingStatus(f.store, f.taskId, f.options.clock()).state).toBe(product === 'claude_code' ? 'inactive' : 'receipt_only');
    expect(f.store.all('SELECT * FROM ordinary_window_activations')).toEqual([]);
  },
  20000
);

test('product decisions consume arming, preserve active hook behavior and refuse rearming even after revocation', async () => {
  const f = fixture();
  armOrdinaryWindowTrial(f.store, f.taskId, 60000, f.options.clock());
  const activated = await f.run(['compatibility', 'ordinary-window', 'activate', f.packet(windowDecisionPacket(f.selection))]);
  expect(activated.code, activated.stderr).toBe(0);
  const control: unknown = JSON.parse(readFileSync(f.controlPath, 'utf8'));
  expect(control).toMatchObject({ state: 'active' });
  expect(control).not.toHaveProperty('arming');
  expect(ordinaryWindowArmingStatus(f.store, f.taskId, f.options.clock()).state).toBe('consumed');
  const emitted = await runClaudeArmingHook(f);
  noNative(emitted);
  expect(emitted.receipts).toHaveLength(1);
  expect(f.store.all('SELECT * FROM sessions')).toEqual([]);
  const existing = await f.run(armArgs(f.taskId));
  expect([existing.code, existing.stderr]).toEqual([2, 'binding_window_decision_exists\n']);
  const revoked = await f.run(['compatibility', 'ordinary-window', 'revoke', f.packet(windowRevocationPacket(f.selection))]);
  expect(revoked.code, revoked.stderr).toBe(0);
  const rearm = await f.run(armArgs(f.taskId));
  expect([rearm.code, rearm.stderr]).toEqual([2, 'binding_window_decision_exists\n']);
  expect((await runClaudeArmingHook(f)).effects.metadataWrites).toBe(0);
}, 20000);

test.each(['missing-package', 'paused'] as const)(
  'requires an owned Claude window package and active task: %s',
  async kind => {
    const f = fixture(kind !== 'missing-package');
    if (kind === 'paused') new Lifecycle(f.store).pause(f.taskId);
    const result = await f.run(armArgs(f.taskId));
    expect([result.code, result.stderr]).toEqual([2, kind === 'paused' ? 'binding_scope_revoked\n' : 'binding_window_package_required\n']);
    expect(f.store.all('SELECT * FROM ordinary_window_activations')).toEqual([]);
  },
  20000
);
