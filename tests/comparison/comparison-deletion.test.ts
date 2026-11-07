import { expect, test } from 'vitest';
import { Store } from '../../src/store.js';
import { Lifecycle } from '../../src/core/lifecycle.js';
import { Deletion } from '../../src/deletion.js';
import { assignTask } from '../../src/comparison/allocation.js';
import { confirmConfiguration } from '../../src/comparison/config-confirmation-write.js';
import { freezeProtocol, registerProtocol, registerVariant } from '../../src/comparison/comparison.js';
import { showProtocol } from '../../src/readiness-store.js';
import { assignmentInput, assignmentTime, beforeRecruitment, protocol, seedProject, variantA, variantB } from '../helpers/comparison-fixture.js';

const dependencies = { clock: () => assignmentTime, shuffle: (values: readonly string[]) => values };
function setup(store: Store): void {
  seedProject(store);
  registerVariant(store, variantA);
  registerVariant(store, variantB);
  registerProtocol(store, protocol);
  freezeProtocol(store, protocol.id, beforeRecruitment);
  assignTask(store, { ...assignmentInput, alias_ids: ['alias-1'] }, dependencies);
  assignTask(store, { ...assignmentInput, task_id: 'retained', logical_task_id: 'retained-logical' }, dependencies);
}
function confirm(store: Store, taskId: string): void {
  const assignment = store.get<{ variant_id: string }>('SELECT variant_id FROM comparison_assignments WHERE task_id = ?', [taskId])!;
  confirmConfiguration(
    store,
    {
      schema_version: 1,
      id: `confirmation-${taskId}`,
      task_id: taskId,
      occurred_at: assignmentTime,
      evidence_method: 'self_attested',
      actual_variant_id: assignment.variant_id,
      product: 'synthetic',
      product_version: '1.0.0',
      model: 'synthetic-model',
      reasoning_setting: 'none',
      environment_id: 'environment-1'
    },
    assignmentTime
  );
}

test('assigned deletion erases identity and replay material, invalidates experiment and prevents resurrection', () => {
  const store = new Store(':memory:');
  try {
    setup(store);
    confirm(store, 'task-1');
    new Deletion(store, () => assignmentTime).deleteTask('task-1');
    expect(showProtocol(store, protocol.id)).toMatchObject({ status: 'invalidated_by_deletion', data_revision: 1, invalidated_reason: 'deletion' });
    expect(store.all('SELECT * FROM comparison_allocation_state')).toEqual([]);
    expect(store.all('SELECT * FROM comparison_preregistrations WHERE task_id = ?', ['task-1'])).toEqual([]);
    expect(store.all('SELECT * FROM comparison_assignments WHERE task_id = ?', ['task-1'])).toEqual([]);
    expect(store.all('SELECT * FROM comparison_confirmations WHERE task_id = ?', ['task-1'])).toEqual([]);
    expect(store.all('SELECT * FROM comparison_deviations WHERE task_id = ?', ['task-1'])).toEqual([]);
    expect(store.all<{ key_id: string }>('SELECT key_id FROM comparison_identity_tombstones ORDER BY key_id').map(row => row.key_id)).toEqual([
      'alias-1',
      'logical-1'
    ]);
    for (const key of ['logical-1', 'alias-1']) {
      expect(() => assignTask(store, { ...assignmentInput, task_id: 'new-id', logical_task_id: key }, dependencies)).toThrow('deleted_identifier');
    }
    expect(() => assignTask(store, { ...assignmentInput, task_id: 'new-id', logical_task_id: 'new-logical' }, dependencies)).toThrow('protocol_not_active');
    confirm(store, 'retained');
    const life = new Lifecycle(store, () => assignmentTime);
    life.start('retained');
    life.finalize('retained', 'success', ['criterion-1']);
    expect(life.state('retained')).toBe('finalized');
    new Deletion(store).deleteTask('task-1');
    expect(showProtocol(store, protocol.id).data_revision).toBe(1);
  } finally {
    store.close();
  }
});

test('failed assigned deletion rolls back invalidation, state, tombstones and all evidence', () => {
  const store = new Store(':memory:');
  try {
    setup(store);
    confirm(store, 'task-1');
    const prior = store.all('SELECT * FROM comparison_allocation_state');
    store.execute("CREATE TRIGGER fixture_delete_failure BEFORE DELETE ON tasks BEGIN SELECT RAISE(ABORT,'delete_failure'); END", []);
    expect(() => new Deletion(store).deleteTask('task-1')).toThrow('delete_failure');
    expect(showProtocol(store, protocol.id)).toMatchObject({ status: 'frozen', data_revision: 0 });
    expect(store.all('SELECT * FROM comparison_allocation_state')).toEqual(prior);
    expect(store.all('SELECT * FROM comparison_assignments')).toHaveLength(2);
    expect(store.all('SELECT * FROM comparison_confirmations')).toHaveLength(1);
    expect(store.all('SELECT * FROM tombstones')).toEqual([]);
    expect(store.all('SELECT * FROM comparison_identity_tombstones')).toEqual([]);
  } finally {
    store.close();
  }
});

test('retention and project deletion share comparison invalidation and identity tombstones', () => {
  const store = new Store(':memory:');
  try {
    setup(store);
    confirm(store, 'task-1');
    const life = new Lifecycle(store, () => assignmentTime);
    life.start('task-1');
    life.finalize('task-1', 'aborted', []);
    const deletion = new Deletion(store, () => '2026-01-03T00:00:00Z');
    deletion.configureRetention('project-1', 1);
    expect(deletion.applyRetention('project-1', '2026-01-03T00:00:00Z')).toBe(1);
    expect(showProtocol(store, protocol.id)).toMatchObject({ status: 'invalidated_by_deletion' });
    deletion.deleteProject('project-1');
    expect(store.all('SELECT * FROM comparison_protocols')).toEqual([]);
    expect(store.all('SELECT * FROM comparison_assignments')).toEqual([]);
    expect(store.all('SELECT * FROM comparison_identity_keys')).toEqual([]);
    expect(store.all('SELECT * FROM comparison_identity_tombstones')).toHaveLength(3);
    expect(() => registerProtocol(store, protocol)).toThrow('deleted_identifier');
  } finally {
    store.close();
  }
});
