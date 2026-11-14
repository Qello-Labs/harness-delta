import { appendFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { Store } from '../../src/store.js';
import { Lifecycle } from '../../src/core/lifecycle.js';
import { Deletion } from '../../src/deletion.js';
import { revokeOrdinaryObservation } from '../../src/ordinary-observation.js';
import { armOrdinaryWindowTrial } from '../../src/cli/ordinary-window-activation-cli.js';
import { ordinaryWindowArmingStatus } from '../../src/ordinary-window-emission.js';
import { collectOrdinaryCodexWindow, connectOrdinaryCodexWindow } from '../../src/ordinary-session-binding.js';
import { installCodexConnectInstallation, previewCodexConnectInstallation } from '../../src/connect/codex-connect-installation.js';
import { CodexWindowPendingReceiptSchema } from '../../src/session-binding-codex.js';
import { ordinaryWindowFixture } from '../helpers/ordinary-window-fixture.js';
import { prepareOrdinaryWindowDecisionCliFixture } from '../helpers/ordinary-window-decision-cli-fixture.js';
import { windowDecisionPacket, windowRevocationPacket, windowTrialPacket } from '../helpers/ordinary-window-decision-fixture.js';
import { runCodexWindowHook } from '../helpers/codex-window-hook-fixture.js';
import { codexWindowJsonl } from '../helpers/codex-window-provider-fixture.js';

const fixtures: { readonly store: Store; readonly directory: string }[] = [];
function fixture(install = true) {
  const original = ordinaryWindowFixture();
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'window-arming-cli-')));
  fixtures.push({ store: original.store, directory });
  const f = prepareOrdinaryWindowDecisionCliFixture(original, directory);
  const options = {
    productVersion: f.selection.declaredVersion,
    bundleMode: 'ordinary_window' as const,
    sourceRoots: [f.sourceRoot]
  };
  const preview = previewCodexConnectInstallation(f.projectRoot, options);
  const installation = install
    ? installCodexConnectInstallation(f.projectRoot, {
        ...options,
        expectedPackageHash: preview.packageHash,
        expectedInstalledHash: preview.installedHash
      })
    : null;
  if (install) expect(installation?.state).toBe('installed');
  const sourcePath = join(f.sourceRoot, 'root.jsonl');
  writeFileSync(
    sourcePath,
    codexWindowJsonl([
      {
        type: 'session_meta',
        payload: {
          id: 'native-root',
          session_id: 'native-root',
          cli_version: f.selection.declaredVersion,
          cwd: f.projectRoot,
          source: 'cli'
        }
      }
    ])
  );
  const hook = (cwd = f.projectRoot) =>
    runCodexWindowHook({
      ...(install
        ? {
            scriptPath: join(f.projectRoot, '.harness-delta/codex-connect/session-binding-codex-window-hook.mjs')
          }
        : {}),
      receiptDirectory: f.receiptDirectory,
      projectRoot: f.projectRoot,
      nativePrefixes: [f.sourceRoot],
      input: {
        hook_event_name: 'SessionStart',
        session_id: 'native-root',
        cwd,
        transcript_path: sourcePath,
        source: 'startup',
        prompt: 'SYNTHETIC_PRIVATE_SENTINEL'
      }
    });
  return { ...f, hook, sourcePath };
}
afterEach(() => {
  for (const f of fixtures.splice(0)) {
    f.store.close();
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test('arms through the CLI, uses the installed hook receipt, then activates, connects and collects the selected trial root', async () => {
  const f = fixture();
  const armed = await f.run(['compatibility', 'ordinary-window', 'arm', f.taskId, '--duration-ms', '60000']);
  expect(armed.code, armed.stderr).toBe(0);
  expect(armed.effects).toEqual({
    nativeCalls: 0,
    processCalls: 0,
    operations: []
  });
  expect(JSON.parse(armed.stdout) as unknown).toMatchObject({
    state: 'receipt_only',
    runtime_authority: false
  });
  expect(f.rows().decisions).toEqual([]);
  const emitted = await f.hook();
  expect(emitted.code, emitted.stderr).toBe(0);
  expect(emitted.effects).toEqual({
    nativeCalls: 0,
    processCalls: 0,
    operations: []
  });
  expect(emitted.receipts).toHaveLength(1);
  const receipt = CodexWindowPendingReceiptSchema.parse(emitted.receipts[0]);
  expect(JSON.stringify(receipt)).not.toContain('SYNTHETIC_PRIVATE_SENTINEL');
  const activated = await f.run([
    'compatibility',
    'ordinary-window',
    'activate',
    f.packet(
      windowTrialPacket(f.selection, {
        nativeRootId: receipt.nativeSessionId,
        durationMs: 60000,
        tokenLimit: 1000
      })
    )
  ]);
  expect(activated.code, activated.stderr).toBe(0);
  expect(JSON.parse(readFileSync(f.controlPath, 'utf8')) as unknown).toMatchObject({ state: 'active' });
  const store = new Store(f.database);
  try {
    const options = {
      store,
      taskId: f.taskId,
      receiptDirectory: f.receiptDirectory,
      sourceRoots: [f.sourceRoot]
    };
    const connected = await connectOrdinaryCodexWindow(options, {
      receipt: receipt.receipt
    });
    expect(connected.automatic_children).toBe(false);
    const at = new Date().toISOString();
    appendFileSync(
      f.sourcePath,
      codexWindowJsonl([
        {
          type: 'turn_context',
          timestamp: at,
          payload: {
            cwd: f.projectRoot,
            turn_id: 'turn-one',
            root_turn_id: 'turn-one',
            model: 'gpt-6.1-sol',
            effort: 'high'
          }
        },
        {
          type: 'token_usage_record',
          timestamp: at,
          payload: {
            thread_id: receipt.nativeSessionId,
            session_id: receipt.nativeSessionId,
            turn_id: 'turn-one',
            root_turn_id: 'turn-one',
            response_id: 'response-one',
            usage: {
              input_tokens: 100,
              cached_input_tokens: 10,
              output_tokens: 20,
              reasoning_output_tokens: 5,
              total_tokens: 120
            }
          }
        }
      ])
    );
    await collectOrdinaryCodexWindow(options, connected.rootSessionId);
    expect(store.eventCount()).toBe(1);
    expect(store.get<{ trial_tokens_consumed: number }>('SELECT trial_tokens_consumed FROM ordinary_window_activations')?.trial_tokens_consumed).toBe(120);
  } finally {
    store.close();
  }
}, 20000);

test('arming alone never permits connect or collect and exposes only durable receipt status', async () => {
  const f = fixture();
  const armed = await f.run(['compatibility', 'ordinary-window', 'arm', f.taskId, '--duration-ms', '60000']);
  expect(armed.code, armed.stderr).toBe(0);
  const status = await f.run(['compatibility', 'ordinary-window', 'status', f.taskId, '--arming']);
  expect(status.code, status.stderr).toBe(0);
  expect(JSON.parse(status.stdout) as unknown).toMatchObject({
    task_id: f.taskId,
    state: 'receipt_only',
    runtime_authority: false
  });
  const emitted = await f.hook();
  const receipt = CodexWindowPendingReceiptSchema.parse(emitted.receipts[0]);
  const store = new Store(f.database);
  try {
    const options = {
      store,
      taskId: f.taskId,
      receiptDirectory: f.receiptDirectory,
      sourceRoots: [f.sourceRoot]
    };
    await expect(
      connectOrdinaryCodexWindow(options, {
        receipt: receipt.receipt
      })
    ).rejects.toThrow('binding_window_activation_required');
    await expect(collectOrdinaryCodexWindow(options, 'unlinked-root')).rejects.toThrow('binding_window_activation_required');
    expect(store.all('SELECT * FROM sessions')).toEqual([]);
    expect(store.eventCount()).toBe(0);
  } finally {
    store.close();
  }
}, 20000);

test('the installed hook emits no receipt without arming or outside the armed project root', async () => {
  const f = fixture();
  const unarmed = await f.hook();
  expect(unarmed.receipts).toEqual([]);
  expect(unarmed.effects).toEqual({
    nativeCalls: 0,
    processCalls: 0,
    operations: []
  });
  const armed = await f.run(['compatibility', 'ordinary-window', 'arm', f.taskId, '--duration-ms', '60000']);
  expect(armed.code, armed.stderr).toBe(0);
  const outside = await f.hook('/synthetic/other-project');
  expect(outside.receipts).toEqual([]);
  expect(outside.effects).toEqual({
    nativeCalls: 0,
    processCalls: 0,
    operations: []
  });
}, 20000);

test.each(['disarm', 'expired', 'pause', 'finalize', 'revoke-collection', 'delete-task', 'delete-project'] as const)(
  '%s closes receipt-only emission without enabling a decision',
  async operation => {
    const f = fixture();
    const store = new Store(f.database);
    try {
      const at = operation === 'expired' ? new Date(Date.now() - 120000).toISOString() : new Date().toISOString();
      armOrdinaryWindowTrial(store, f.taskId, 60000, at);
      if (operation === 'expired') {
        const expired = await f.hook();
        expect(expired.receipts).toEqual([]);
        expect(ordinaryWindowArmingStatus(store, f.taskId, new Date().toISOString()).state).toBe('expired');
      }
      if (operation === 'pause') new Lifecycle(store).pause(f.taskId);
      if (operation === 'finalize') {
        new Lifecycle(store).finalize(f.taskId, 'aborted', []);
      }
      if (operation === 'revoke-collection') {
        revokeOrdinaryObservation(store, f.taskId);
      }
      if (operation === 'delete-task') {
        new Deletion(store).deleteTask(f.taskId);
      }
      if (operation === 'delete-project') {
        new Deletion(store).deleteProject(f.selection.projectId);
      }
      if (operation === 'disarm') {
        const disarmed = await f.run(['compatibility', 'ordinary-window', 'disarm', f.taskId]);
        expect(disarmed.code, disarmed.stderr).toBe(0);
      }
      expect(JSON.parse(readFileSync(f.controlPath, 'utf8')) as unknown).toMatchObject({ state: 'inactive' });
      const result = await f.hook();
      expect(result.receipts).toEqual([]);
      expect(result.effects).toEqual({
        nativeCalls: 0,
        processCalls: 0,
        operations: []
      });
      expect(store.all('SELECT * FROM ordinary_window_activations')).toEqual([]);
    } finally {
      store.close();
    }
  },
  20000
);

test.each(['0', '-1', 'Infinity', '2147483648', 'invalid'])(
  'rejects nonfinite or out-of-bound arming lifetime %s',
  async duration => {
    const f = fixture();
    const result = await f.run(['compatibility', 'ordinary-window', 'arm', f.taskId, '--duration-ms', duration]);
    expect(result.code).toBe(2);
    expect((await f.hook()).receipts).toEqual([]);
  },
  20000
);

test('requires a started task and the installed owned window package', async () => {
  const f = fixture(false);
  const missing = await f.run(['compatibility', 'ordinary-window', 'arm', f.taskId, '--duration-ms', '60000']);
  expect(missing.stderr).toBe('binding_window_package_required\n');
  expect(missing.code).toBe(2);
  const installed = fixture();
  const store = new Store(installed.database);
  try {
    new Lifecycle(store).pause(installed.taskId);
  } finally {
    store.close();
  }
  const paused = await installed.run(['compatibility', 'ordinary-window', 'arm', installed.taskId, '--duration-ms', '60000']);
  expect(paused.code).toBe(2);
  expect(paused.stderr).toBe('binding_scope_revoked\n');
  expect((await installed.hook()).receipts).toEqual([]);
}, 20000);

test('product activation consumes arming and existing or revoked decisions cannot rearm', async () => {
  const f = fixture();
  const armed = await f.run(['compatibility', 'ordinary-window', 'arm', f.taskId, '--duration-ms', '60000']);
  expect(armed.code, armed.stderr).toBe(0);
  const activate = await f.run(['compatibility', 'ordinary-window', 'activate', f.packet(windowDecisionPacket(f.selection))]);
  expect(activate.code, activate.stderr).toBe(0);
  const control: unknown = JSON.parse(readFileSync(f.controlPath, 'utf8'));
  expect(control).toMatchObject({ state: 'active' });
  expect(control).not.toHaveProperty('arming');
  const status = await f.run(['compatibility', 'ordinary-window', 'status', f.taskId, '--arming']);
  expect(JSON.parse(status.stdout) as unknown).toMatchObject({
    state: 'consumed'
  });
  const existing = await f.run(['compatibility', 'ordinary-window', 'arm', f.taskId, '--duration-ms', '60000']);
  expect(existing.code).toBe(2);
  expect(existing.stderr).toBe('binding_window_decision_exists\n');
  const revoke = await f.run(['compatibility', 'ordinary-window', 'revoke', f.packet(windowRevocationPacket(f.selection))]);
  expect(revoke.code, revoke.stderr).toBe(0);
  const revoked = await f.run(['compatibility', 'ordinary-window', 'arm', f.taskId, '--duration-ms', '60000']);
  expect(revoked.code).toBe(2);
  expect(revoked.stderr).toBe('binding_window_decision_exists\n');
  expect((await f.hook()).receipts).toEqual([]);
}, 20000);
