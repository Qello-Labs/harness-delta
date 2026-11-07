import { afterEach, expect, test, vi } from 'vitest';
import { ordinaryWindowFixture } from '../helpers/ordinary-window-fixture.js';
import {
  assertOrdinaryWindowAuthority,
  assertOrdinaryWindowPrepared,
  ordinaryWindowSelection,
  ordinaryWindowStatus,
  revokeOrdinaryWindowActivation
} from '../../src/core/ordinary-window-store.js';
import { createOrdinarySessionBindingService } from '../../src/ordinary-session-binding.js';
import { bindingSourceSupported, createSessionBindingService } from '../../src/session-binding-service.js';
import { aggregateOrdinaryTaskReport } from '../../src/comparison/reports/ordinary-task.js';
import { createOrdinaryWindowTask, ordinaryTaskSettings } from '../../src/ordinary-observation.js';
import { captureObservedCostInput } from '../../src/pricing/observed-cost-report.js';
import { readOrdinaryWindowBatch } from '../../src/ordinary-window-binding.js';
import { localWebError } from '../../src/web/local-web-server.js';
import { Deletion } from '../../src/deletion.js';
import { pinSessionCompatibility } from '../../src/source-compatibility.js';
import { resolveOrdinaryWindow } from '../../src/core/ordinary-window-policy.js';

const fixtures: ReturnType<typeof ordinaryWindowFixture>[] = [];
const fixture = (product: 'codex' | 'claude_code' = 'codex') => {
  const f = ordinaryWindowFixture(product);
  fixtures.push(f);
  return f;
};
afterEach(() => {
  for (const f of fixtures.splice(0)) f.store.close();
});

test.each(['workspace', 'binding_cwd', 'process', 'native_root', 'receipt'] as const)(
  'denies mismatched persisted %s proof before provider construction',
  async kind => {
    const f = fixture();
    f.activate();
    const native = f.identity.nativeMapping;
    if (!native) throw new Error('fixture_native_mapping_missing');
    const bound = {
      ...f.identity,
      ...(kind === 'binding_cwd' ? { cwd: '/synthetic/other' } : {}),
      nativeMapping: {
        ...native,
        ...(kind === 'process' ? { processId: 'invented' } : {}),
        ...(kind === 'native_root' ? { nativeSessionId: 'other-root' } : {})
      }
    };
    f.connect(bound, kind === 'receipt' ? '00000000-0000-4000-8000-000000000001' : f.proof.receipt);
    if (kind === 'workspace') {
      f.store.execute("UPDATE projects SET local_root='/synthetic/replaced' WHERE id='project'", []);
    }
    const factory = vi.fn(() => f.provider);
    await expect(
      readOrdinaryWindowBatch({
        store: f.store,
        taskId: f.taskId,
        rootSessionId: f.rootId,
        baseline: false,
        provider: factory,
        clock: f.clock
      })
    ).rejects.toThrow('binding_identity_mismatch');
    expect(factory).not.toHaveBeenCalled();
    expect(f.calls).toEqual([]);
  }
);

test('keeps the other product authorized after deleting an identical native root ID', () => {
  const f = fixture();
  f.activate();
  f.connect();
  const other = createOrdinaryWindowTask(
    f.store,
    {
      schema_version: 2,
      mode: 'ordinary_window',
      project_id: 'project',
      product: 'claude_code',
      declared_version: '2.1.318',
      policy_id: 'claude-binding-root-window-v1',
      criterion_ids: ['accepted']
    },
    f.clock
  );
  f.store.execute("INSERT INTO sessions(id,project_id,task_id,product,product_version) VALUES ('other-root','project',?,'claude_code','2.1.318')", [other]);
  f.store.execute(
    `INSERT INTO binding_root_segments(root_session_id,task_id,product,native_root_id,project_root,state,opened_at)
    VALUES ('other-root',?,'claude_code','native-root','/synthetic/window-project','observing',?)`,
    [other, f.clock()]
  );
  new Deletion(f.store, f.clock).deleteTask(other);
  expect(f.store.get("SELECT 1 FROM tombstones WHERE kind='session' AND id='native-root'")).toBeDefined();
  expect(
    assertOrdinaryWindowAuthority(f.store, {
      taskId: f.taskId,
      rootSessionId: f.rootId
    })
  ).toEqual(f.selection);
});

test('does not reconstruct either cleanup provider after a window selection is deleted', async () => {
  const f = fixture();
  f.activate();
  f.connect();
  new Deletion(f.store, f.clock).deleteTask(f.taskId);
  const factory = vi.fn(() => [f.provider]);
  const ordinary = createOrdinarySessionBindingService({
    store: f.store,
    providersForTask: factory,
    clock: f.clock
  });
  const assigned = createSessionBindingService({
    store: f.store,
    providers: [],
    providersForTask: factory,
    setupFor: () => {
      throw new Error('deleted_window_setup_forbidden');
    }
  });
  await ordinary.flushForgotten();
  await assigned.flushForgotten();
  expect(factory).not.toHaveBeenCalled();
  expect(f.calls).toEqual([]);
  expect(f.store.all('SELECT reason_code FROM session_binding_forgets')).toEqual([{ reason_code: 'binding_forget_pending' }]);
  await ordinary.close();
});

test.each(['codex', 'claude_code'] as const)('prepares %s without activation, providers or sessions and preserves immutable pins', product => {
  const f = fixture(product);
  expect(assertOrdinaryWindowPrepared(f.store, f.taskId)).toEqual(f.selection);
  expect(f.store.all('SELECT * FROM ordinary_window_activations')).toEqual([]);
  expect(f.store.all('SELECT * FROM sessions')).toEqual([]);
  expect(f.store.eventCount()).toBe(0);
  expect(() => f.store.execute('UPDATE ordinary_window_selections SET selection_hash=? WHERE task_id=?', ['b'.repeat(64), f.taskId])).toThrow(
    'ordinary_configuration_changed'
  );
  expect(ordinaryWindowSelection(f.store, f.taskId)).toEqual(f.selection);
});

test.each(['absent', 'revoked', 'other_product', 'wrong_policy', 'wrong_revision', 'wrong_digest', 'wrong_mode', 'wrong_project'])(
  'refuses %s activation before constructing a provider or changing usage state',
  async kind => {
    const f = fixture();
    f.activate();
    f.connect();
    if (kind === 'revoked') {
      f.store.execute('UPDATE ordinary_window_activations SET revoked_at=?', [f.clock()]);
    } else if (kind === 'absent') {
      f.store.execute('DELETE FROM ordinary_window_activations', []);
    } else {
      const row = f.store.get<Record<string, string>>('SELECT * FROM ordinary_window_activations');
      if (!row) throw new Error('fixture_activation_missing');
      f.store.execute('DELETE FROM ordinary_window_activations', []);
      if (kind === 'wrong_project') {
        f.store.execute('INSERT INTO projects(id,local_root) VALUES (?,?)', ['other-project', '/synthetic/other']);
      }
      const changes: Record<string, readonly [string, string]> = {
        other_product: ['product', 'claude_code'],
        wrong_policy: ['policy_id', 'claude-binding-root-window-v1'],
        wrong_revision: ['policy_revision', 'other-revision'],
        wrong_digest: ['policy_digest', 'b'.repeat(64)],
        wrong_mode: ['evidence_mode', 'publisher_verified_local_pin'],
        wrong_project: ['project_id', 'other-project']
      };
      const change = changes[kind];
      if (!change) throw new Error('fixture_activation_case_missing');
      row[change[0]] = change[1];
      const columns = Object.keys(row);
      f.store.execute(`INSERT INTO ordinary_window_activations(${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`, Object.values(row));
    }
    const before = f.snapshot();
    const factory = vi.fn(() => [f.provider]);
    const service = createOrdinarySessionBindingService({
      store: f.store,
      providersForTask: factory,
      clock: f.clock
    });
    expect(() =>
      assertOrdinaryWindowAuthority(f.store, {
        taskId: f.taskId,
        rootSessionId: f.rootId
      })
    ).toThrow('binding_window_activation_required');
    expect(ordinaryWindowStatus(f.store, f.taskId).reason).toBe('binding_window_activation_required');
    expect(() => service.sourceSupported(f.taskId, 'codex')).toThrow('binding_window_activation_required');
    await expect(service.connect(f.taskId, 'codex', { receipt: f.proof.receipt })).rejects.toThrow('binding_window_activation_required');
    await expect(service.resume(f.taskId)).rejects.toThrow('binding_window_activation_required');
    await expect(service.tick(f.taskId)).rejects.toThrow('binding_window_activation_required');
    expect(() => service.status(f.taskId)).toThrow('binding_window_activation_required');
    expect(() => service.capabilities(f.taskId, 'codex')).toThrow('binding_window_activation_required');
    expect(factory).not.toHaveBeenCalled();
    expect(f.calls).toEqual([]);
    expect(f.snapshot()).toEqual(before);
    await service.close();
  }
);

test('keeps incomplete public reports and exact service dispatch closed even with fixture authority', async () => {
  const f = fixture();
  f.activate();
  f.connect();
  const factory = vi.fn(() => [f.provider]);
  const service = createOrdinarySessionBindingService({
    store: f.store,
    providersForTask: factory,
    clock: f.clock
  });
  const assigned = createSessionBindingService({
    store: f.store,
    providers: [],
    providersForTask: factory,
    setupFor: () => {
      throw new Error('window_must_not_read_assigned_setup');
    }
  });
  expect(bindingSourceSupported(f.store, f.taskId)).toBe(false);
  expect(() => ordinaryTaskSettings(f.store, f.taskId)).toThrow('binding_window_unavailable');
  expect(() => aggregateOrdinaryTaskReport(f.store, f.taskId, f.clock())).toThrow('binding_window_unavailable');
  expect(() => captureObservedCostInput(f.store, f.taskId, f.selection.priceTableId, f.clock(), 'output-only-v1')).toThrow('binding_window_unavailable');
  expect(() => assigned.status(f.taskId)).toThrow('binding_window_unavailable');
  expect(localWebError(new Error('binding_window_unavailable'))).toBe('binding_window_unavailable');
  await expect(service.connect(f.taskId, 'codex', { receipt: f.proof.receipt })).rejects.toThrow('binding_window_unavailable');
  expect(() => assigned.sourceSupported(f.taskId, 'codex')).toThrow('binding_window_unavailable');
  expect(factory).not.toHaveBeenCalled();
  expect(f.calls).toEqual([]);
  await service.close();
});

test('requires stored segment selection rather than accepting arbitrary unverified compatibility tuples', () => {
  const f = fixture();
  f.activate();
  f.connect();
  const selected = resolveOrdinaryWindow('codex', '0.167.0');
  if (!selected) throw new Error('fixture_policy_missing');
  pinSessionCompatibility(f.store, f.rootId, selected.compatibility);
  f.store.execute('INSERT INTO sessions(id,project_id,task_id,product,product_version) VALUES (?,?,?,?,?)', [
    'unselected',
    'project',
    f.taskId,
    'codex',
    '0.167.0'
  ]);
  expect(() => pinSessionCompatibility(f.store, 'unselected', selected.compatibility)).toThrow('compatibility_scope_mismatch');
  expect(() =>
    pinSessionCompatibility(f.store, f.rootId, {
      ...selected.compatibility,
      product_version: '0.168.0'
    })
  ).toThrow('compatibility_scope_mismatch');
});

test('revocation fences persisted segments without rewriting cursor or provenance', () => {
  const f = fixture();
  f.activate();
  f.connect();
  const before = f.snapshot();
  revokeOrdinaryWindowActivation(f.store, f.taskId, f.clock());
  expect(f.life.state(f.taskId)).toBe('paused');
  expect(f.store.get<{ state: string }>('SELECT state FROM binding_root_segments')?.state).toBe('paused');
  expect(f.snapshot()).toEqual(before);
  expect(() => f.store.execute('UPDATE ordinary_window_activations SET revoked_at=NULL', [])).toThrow('binding_scope_revoked');
});

test.each(['task', 'project'] as const)('deletes window %s state and leaves only opaque forget fences', kind => {
  const f = fixture();
  f.activate();
  f.connect();
  const deletion = new Deletion(f.store, f.clock);
  if (kind === 'task') deletion.deleteTask(f.taskId);
  else deletion.deleteProject('project');
  expect(f.store.all('SELECT * FROM ordinary_window_selections')).toEqual([]);
  expect(f.store.all('SELECT * FROM ordinary_window_segments')).toEqual([]);
  expect(f.store.all('SELECT * FROM ordinary_window_forget_fences')).toEqual([
    {
      product: 'codex',
      native_session_id: 'native-root',
      task_id: f.taskId
    }
  ]);
  if (kind === 'project') {
    expect(f.store.all('SELECT * FROM ordinary_window_activations')).toEqual([]);
  }
  expect(() =>
    assertOrdinaryWindowAuthority(f.store, {
      taskId: f.taskId,
      rootSessionId: f.rootId
    })
  ).toThrow('ordinary_preparation_required');
});
