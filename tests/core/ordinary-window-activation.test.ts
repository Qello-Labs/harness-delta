import { afterEach, expect, test, vi } from 'vitest';
import {
  activateOrdinaryWindowDecision,
  ordinaryWindowDecisionKeyForSelection,
  ordinaryWindowDecisionStatus,
  readOrdinaryWindowDecision
} from '../../src/core/ordinary-window-activation.js';
import { assertOrdinaryWindowAuthority, revokeOrdinaryWindowDecision } from '../../src/core/ordinary-window-store.js';
import { createOrdinarySessionBindingService } from '../../src/ordinary-session-binding.js';
import { createOrdinaryWindowTask } from '../../src/ordinary-observation.js';
import { Deletion } from '../../src/deletion.js';
import { ordinaryWindowFixture } from '../helpers/ordinary-window-fixture.js';
import { windowDecisionPacket, windowRevocationPacket, windowTrialPacket } from '../helpers/ordinary-window-decision-fixture.js';

const fixtures: ReturnType<typeof ordinaryWindowFixture>[] = [];
function fixture(product: 'codex' | 'claude_code' = 'codex') {
  const f = ordinaryWindowFixture(product);
  fixtures.push(f);
  return f;
}
afterEach(() => {
  for (const f of fixtures.splice(0)) f.store.close();
});

test.each(['codex', 'claude_code'] as const)('records only a fixed %s product decision and keeps public collection closed', async product => {
  const f = fixture(product);
  const pins = f.store.all('SELECT settings,settings_hash,price_table_id FROM ordinary_tasks');
  const decision = activateOrdinaryWindowDecision(f.store, windowDecisionPacket(f.selection), f.clock());
  expect(decision).toMatchObject({
    decision_kind: 'product',
    decision_ref: 'synthetic-decision',
    revoked_at: null,
    accepted_risks: ['root_ownership_unverified', 'source_identity_limits'],
    trial_task_id: null,
    trial_tokens_consumed: 0
  });
  expect(f.store.all('SELECT settings,settings_hash,price_table_id FROM ordinary_tasks')).toEqual(pins);
  expect(f.store.all('SELECT * FROM sessions')).toEqual([]);
  expect(f.store.eventCount()).toBe(0);
  f.life.start(f.taskId);
  expect(assertOrdinaryWindowAuthority(f.store, { taskId: f.taskId })).toEqual(f.selection);
  const factory = vi.fn(() => [f.provider]);
  const service = createOrdinarySessionBindingService({
    store: f.store,
    providersForTask: factory,
    clock: f.clock
  });
  expect(() => service.sourceSupported(f.taskId, product)).toThrow('binding_window_unavailable');
  await expect(service.connect(f.taskId, product, { receipt: f.proof.receipt })).rejects.toThrow('binding_window_unavailable');
  expect(factory).not.toHaveBeenCalled();
  expect(f.calls).toEqual([]);
  await service.close();
});

test.each([
  { activated: true },
  { qualified: true },
  { policy_body: {} },
  { max_members: 2 },
  { code: 'unexpected' },
  { accepted_risks: ['source_identity_limits'] },
  { accepted_risks: ['source_identity_limits', 'source_identity_limits'] },
  { implementation_revision: 'unreviewed' },
  { evidence_ref: '' },
  { review_ref: '' },
  { decision_ref: '' },
  { policy_revision: 'unreviewed' },
  { policy_digest: 'b'.repeat(64) },
  { evidence_mode: 'publisher_verified_local_pin' },
  { product: 'claude_code' },
  { source: 'claude_binding' },
  { task_id: 'unexpected' }
])('rejects forged decision fields before any activation or source effect: %j', changes => {
  const f = fixture();
  const before = f.snapshot();
  expect(() =>
    activateOrdinaryWindowDecision(
      f.store,
      {
        ...windowDecisionPacket(f.selection),
        ...changes
      },
      f.clock()
    )
  ).toThrow();
  expect(f.store.all('SELECT * FROM ordinary_window_activations')).toEqual([]);
  expect(f.snapshot()).toEqual(before);
  expect(f.calls).toEqual([]);
});

test('keeps a scoped trial restricted to its task/root, immutable and one-shot', () => {
  const f = fixture();
  const packet = windowTrialPacket(f.selection, { tokenLimit: 100 });
  const decision = activateOrdinaryWindowDecision(f.store, packet, f.clock());
  expect(decision).toMatchObject({
    decision_kind: 'trial',
    trial_task_id: f.taskId,
    trial_native_root_id: 'native-root',
    trial_project_root: '/synthetic/window-project',
    trial_expires_at: '2026-11-06T01:01:00.000Z',
    trial_token_limit: 100
  });
  f.life.start(f.taskId);
  expect(() =>
    assertOrdinaryWindowAuthority(f.store, {
      taskId: f.taskId,
      nativeRootId: 'other-root',
      clock: f.clock
    })
  ).toThrow('binding_scope_mismatch');
  const other = createOrdinaryWindowTask(
    f.store,
    {
      schema_version: 2,
      mode: 'ordinary_window',
      project_id: 'project',
      product: 'codex',
      declared_version: '0.167.0',
      policy_id: 'codex-binding-root-window-v1',
      criterion_ids: ['accepted']
    },
    f.clock
  );
  f.life.start(other);
  expect(() =>
    assertOrdinaryWindowAuthority(f.store, {
      taskId: other,
      clock: f.clock
    })
  ).toThrow('binding_scope_mismatch');
  for (const field of ['decision_ref', 'trial_native_root_id', 'trial_task_id', 'trial_project_root', 'trial_expires_at', 'trial_token_limit']) {
    expect(() => f.store.execute(`UPDATE ordinary_window_activations SET ${field}=?`, ['changed'])).toThrow('ordinary_configuration_changed');
  }
  expect(() => activateOrdinaryWindowDecision(f.store, windowDecisionPacket(f.selection), f.clock())).toThrow('binding_window_decision_exists');
  expect(f.store.all('SELECT * FROM sessions')).toEqual([]);
});

test.each([
  { duration_ms: 0 },
  { duration_ms: 2_147_483_648 },
  { token_limit: 0 },
  { token_limit: Number.MAX_SAFE_INTEGER + 1 },
  { native_root_id: '' },
  { task_id: 'other' },
  { token_budget_basis: 'vendor_generation_or_billing' }
])('rejects an unbounded, mislabeled or mismatched trial: %j', changes => {
  const f = fixture();
  expect(() =>
    activateOrdinaryWindowDecision(
      f.store,
      {
        ...windowTrialPacket(f.selection),
        ...changes
      },
      f.clock()
    )
  ).toThrow();
  expect(f.store.all('SELECT * FROM ordinary_window_activations')).toEqual([]);
});

test('revokes only the captured decision and never resurrects it', () => {
  const f = fixture();
  const decision = activateOrdinaryWindowDecision(f.store, windowDecisionPacket(f.selection), f.clock());
  expect(() =>
    revokeOrdinaryWindowDecision(
      f.store,
      {
        ...windowRevocationPacket(f.selection),
        decision_ref: 'other'
      },
      f.clock()
    )
  ).toThrow('binding_window_decision_mismatch');
  expect(readOrdinaryWindowDecision(f.store, decision)?.revoked_at).toBeNull();
  revokeOrdinaryWindowDecision(f.store, windowRevocationPacket(f.selection), f.clock());
  expect(ordinaryWindowDecisionStatus(f.store, ordinaryWindowDecisionKeyForSelection(f.selection), f.clock())).toMatchObject({
    state: 'revoked',
    runtime_authority: false
  });
  expect(() => f.store.execute('UPDATE ordinary_window_activations SET revoked_at=NULL', [])).toThrow('binding_scope_revoked');
  expect(() => activateOrdinaryWindowDecision(f.store, windowDecisionPacket(f.selection), f.clock())).toThrow('binding_window_decision_exists');
});

test('task deletion removes only its trial decision and never reconstructs authority', () => {
  const f = fixture();
  activateOrdinaryWindowDecision(f.store, windowTrialPacket(f.selection), f.clock());
  new Deletion(f.store, f.clock).deleteTask(f.taskId);
  expect(f.store.all('SELECT * FROM ordinary_window_activations')).toEqual([]);
  expect(f.store.get("SELECT 1 FROM tombstones WHERE kind='task' AND id=?", [f.taskId])).toBeDefined();
  expect(() => activateOrdinaryWindowDecision(f.store, windowTrialPacket(f.selection), f.clock())).toThrow('binding_scope_revoked');
});
