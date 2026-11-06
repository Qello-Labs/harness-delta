import { prepareOrdinaryWindowDecisionCliFixture } from '../helpers/ordinary-window-decision-cli-fixture.js';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { Store } from '../../src/store.js';
import { ordinaryWindowFixture } from '../helpers/ordinary-window-fixture.js';
import { windowDecisionPacket, windowRevocationPacket, windowTrialPacket } from '../helpers/ordinary-window-decision-fixture.js';
import { runCodexWindowHook } from '../helpers/codex-window-hook-fixture.js';
import { CodexWindowPendingReceiptSchema } from '../../src/session-binding-codex.js';

const fixtures: { readonly store: Store; readonly directory: string }[] = [];
function fixture(product: 'codex' | 'claude_code' = 'codex') {
  const f = ordinaryWindowFixture(product);
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'window-decision-cli-')));
  fixtures.push({ store: f.store, directory });
  return prepareOrdinaryWindowDecisionCliFixture(f, directory);
}
afterEach(() => {
  for (const f of fixtures.splice(0)) {
    f.store.close();
    rmSync(f.directory, { recursive: true, force: true });
  }
});
function noNative(result: Awaited<ReturnType<ReturnType<typeof fixture>['run']>>) {
  expect(result.effects).toEqual({
    nativeCalls: 0,
    processCalls: 0,
    operations: []
  });
}

test.each(['codex', 'claude_code'] as const)(
  'real %s decision CLI records/revokes data and derives only an emission control',
  async product => {
    const f = fixture(product);
    const original = f.rows();
    const activate = await f.run(['compatibility', 'ordinary-window', 'activate', f.packet(windowDecisionPacket(f.selection))]);
    noNative(activate);
    expect(activate.code).toBe(0);
    expect(JSON.parse(activate.stdout) as unknown).toMatchObject({
      kind: 'ordinary_window_decision_result',
      runtime_authority: false,
      decision: {
        decision_kind: 'product',
        decision_ref: 'synthetic-decision'
      },
      emission_control: { state: 'active', runtime_authority: false }
    });
    expect(JSON.parse(readFileSync(f.controlPath, 'utf8')) as unknown).toEqual({
      schemaVersion: 1,
      projectRoot: f.projectRoot,
      product,
      policyId: f.selection.policy.policyId,
      policyRevision: f.selection.policy.ruleRevision,
      evidenceMode: f.selection.policy.evidenceMode,
      state: 'active'
    });
    const active = f.rows();
    expect(active.settings).toEqual(original.settings);
    expect(active.sessions).toEqual([]);
    expect(active.events).toEqual([]);
    const status = await f.run(['compatibility', 'ordinary-window', 'status', f.taskId, '--decision']);
    noNative(status);
    expect(status.code).toBe(0);
    expect(JSON.parse(status.stdout) as unknown).toMatchObject({
      state: 'recorded',
      runtime_authority: false
    });
    expect(f.rows()).toEqual(active);
    const closed = await f.run(['report', 'task', f.taskId, '--cutoff', '2026-11-06T01:00:10.000Z']);
    noNative(closed);
    expect(closed.code).toBe(2);
    expect(closed.stderr).toBe('binding_window_unavailable\n');
    const revoke = await f.run(['compatibility', 'ordinary-window', 'revoke', f.packet(windowRevocationPacket(f.selection))]);
    noNative(revoke);
    expect(revoke.code).toBe(0);
    expect(JSON.parse(revoke.stdout) as unknown).toMatchObject({
      decision: { revocation_reason: 'operator_revoked' },
      emission_control: { state: 'inactive', runtime_authority: false }
    });
    expect(JSON.parse(readFileSync(f.controlPath, 'utf8')) as unknown).toMatchObject({ state: 'inactive' });
    const replay = await f.run(['compatibility', 'ordinary-window', 'activate', f.packet(windowDecisionPacket(f.selection))]);
    noNative(replay);
    expect(replay.code).toBe(2);
    expect(f.rows().decisions).toHaveLength(1);
  },
  20000
);

test.each([
  { activated: true },
  { qualified: true },
  { policy_body: {} },
  {
    max_depth: 1
  },
  { accepted_risks: [] }
])(
  'real CLI rejects forged packet %j without decisions/control/native access',
  async changes => {
    const f = fixture();
    const before = f.rows();
    const result = await f.run(['compatibility', 'ordinary-window', 'activate', f.packet({ ...windowDecisionPacket(f.selection), ...changes })]);
    noNative(result);
    expect(result.code).toBe(2);
    expect(f.rows()).toEqual(before);
    expect(readdirSync(f.projectRoot)).toEqual([]);
  },
  10000
);

test('control publication refuses an ancestor symlink without touching its native target', async () => {
  const f = fixture();
  const alias = join(f.projectRoot, '.harness-delta');
  symlinkSync(f.sourceRoot, alias, 'dir');
  const result = await f.run(
    ['compatibility', 'ordinary-window', 'activate', f.packet(windowDecisionPacket(f.selection))],
    [{ path: alias, target: f.sourceRoot }]
  );
  noNative(result);
  expect(result.code).toBe(2);
  expect(result.stderr).toBe('binding_window_control_unavailable\n');
  expect(readdirSync(f.sourceRoot)).toEqual([]);
  expect(f.rows().decisions).toHaveLength(1);
  expect(f.rows().events).toEqual([]);
}, 10000);

test('a scoped trial cannot reserve/read another root even with its active derived control', async () => {
  const f = fixture();
  const result = await f.run([
    'compatibility',
    'ordinary-window',
    'activate',
    f.packet(
      windowTrialPacket(f.selection, {
        nativeRootId: 'selected-trial-root',
        durationMs: 3_600_000
      })
    )
  ]);
  noNative(result);
  expect(result.code).toBe(0);
  const emitted = await runCodexWindowHook({
    receiptDirectory: f.receiptDirectory,
    projectRoot: f.projectRoot,
    nativePrefixes: [f.sourceRoot],
    input: {
      hook_event_name: 'SessionStart',
      session_id: 'other-root',
      cwd: f.projectRoot,
      transcript_path: join(f.sourceRoot, 'other-root.jsonl'),
      source: 'startup'
    }
  });
  noNative(emitted);
  expect(emitted.code).toBe(0);
  expect(emitted.receipts).toHaveLength(1);
  const receipt = CodexWindowPendingReceiptSchema.parse(emitted.receipts[0]);
  const denied = await runCodexWindowHook({
    scriptPath: resolve('tests/helpers/ordinary-window-decision-connect.mjs'),
    receiptDirectory: f.receiptDirectory,
    projectRoot: f.projectRoot,
    nativePrefixes: [f.sourceRoot],
    args: [],
    input: {
      database: f.database,
      taskId: f.taskId,
      receiptDirectory: f.receiptDirectory,
      sourceRoot: f.sourceRoot,
      receipt: receipt.receipt
    }
  });
  noNative(denied);
  expect(denied.code).toBe(0);
  expect(JSON.parse(denied.stdout) as unknown).toEqual({
    outcome: 'binding_scope_mismatch'
  });
  expect(f.rows()).toMatchObject({
    sessions: [],
    segments: [],
    proofs: [],
    bindings: [],
    replay: [],
    exclusions: [],
    events: [],
    pins: []
  });
  expect(f.rows().decisions).toEqual([
    expect.objectContaining({
      decision_kind: 'trial',
      revocation_reason: 'trial_failed'
    })
  ]);
}, 20000);

test('a stale active control after CLI revocation emits metadata but cannot authorize a source read', async () => {
  const f = fixture();
  noNative(await f.run(['compatibility', 'ordinary-window', 'activate', f.packet(windowDecisionPacket(f.selection))]));
  const control: unknown = JSON.parse(readFileSync(f.controlPath, 'utf8'));
  noNative(await f.run(['compatibility', 'ordinary-window', 'revoke', f.packet(windowRevocationPacket(f.selection))]));
  writeFileSync(f.controlPath, JSON.stringify(control), { mode: 0o600 });
  const before = f.rows();
  const emitted = await runCodexWindowHook({
    receiptDirectory: f.receiptDirectory,
    projectRoot: f.projectRoot,
    nativePrefixes: [f.sourceRoot],
    input: {
      hook_event_name: 'SessionStart',
      session_id: 'native-root',
      cwd: f.projectRoot,
      transcript_path: join(f.sourceRoot, 'root.jsonl'),
      source: 'startup'
    }
  });
  noNative(emitted);
  expect(emitted.receipts).toHaveLength(1);
  const receipt = CodexWindowPendingReceiptSchema.parse(emitted.receipts[0]);
  const denied = await runCodexWindowHook({
    scriptPath: resolve('tests/helpers/ordinary-window-decision-connect.mjs'),
    receiptDirectory: f.receiptDirectory,
    projectRoot: f.projectRoot,
    nativePrefixes: [f.sourceRoot],
    args: [],
    input: {
      database: f.database,
      taskId: f.taskId,
      receiptDirectory: f.receiptDirectory,
      sourceRoot: f.sourceRoot,
      receipt: receipt.receipt
    }
  });
  noNative(denied);
  expect(JSON.parse(denied.stdout) as unknown).toEqual({
    outcome: 'binding_window_activation_required'
  });
  expect(f.rows()).toEqual(before);
}, 20000);
