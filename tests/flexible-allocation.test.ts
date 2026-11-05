import { expect, test } from 'vitest';
import { Store } from '../src/store.js';
import { assignTask } from '../src/comparison/allocation.js';
import { confirmConfiguration } from '../src/comparison/config-confirmation-write.js';
import { Lifecycle } from '../src/lifecycle.js';
import { recordRuntimeEvidence, readRuntimeHistory } from '../src/runtime-history.js';
import { FlexibleProtocolSchema } from '../src/flexible-contracts.js';
import { makeFlexibleFixture } from './helpers/flexible-fixture.js';
import { seedFlexibleComparison } from './helpers/flexible-store.js';
test('model_and_effort_change_do_not_pause', async () => {
  const store = new Store(':memory:');
  try {
    const f = seedFlexibleComparison(store);
    const now = '2026-01-01T00:00:00Z';
    const receipt = assignTask(store, f.input, { clock: () => now, shuffle: x => x });
    confirmConfiguration(
      store,
      {
        schema_version: 1,
        id: 'confirmation-1',
        task_id: 'task-1',
        evidence_method: 'self_attested',
        actual_variant_id: receipt.assigned_variant_id,
        product: 'synthetic',
        product_version: '1.0.0',
        model: null,
        reasoning_setting: null,
        environment_id: 'environment-1'
      },
      now
    );
    const lifecycle = new Lifecycle(store, () => now);
    lifecycle.start('task-1');
    store.execute("INSERT INTO sessions(id,task_id,project_id,product,product_version) VALUES ('session-1','task-1','project-1','synthetic','1.0.0')", []);
    const first = f.runtime[0]!;
    const next = { ...first, id: 'runtime-2', model: 'other-model', effort: 'high', occurred_at: '2026-01-01T00:00:04Z', recorded_at: '2026-01-01T00:00:05Z' };
    recordRuntimeEvidence(store, first);
    recordRuntimeEvidence(store, next);
    const { classifyFlexibleConfirmation } = await import('../src/core/configuration-evidence.js');
    expect(classifyFlexibleConfirmation(receipt.assigned_variant_id, next, first, receipt.assigned_variant_id)).toEqual({
      runtime_change: true,
      harness_deviation: 'none'
    });
    expect(classifyFlexibleConfirmation(receipt.assigned_variant_id, next, first, 'other-variant').harness_deviation).toBe('crossover');
    expect(lifecycle.state('task-1')).toBe('active');
    expect(readRuntimeHistory(store, 'task-1', '2026-01-01T01:00:00Z')).toHaveLength(2);
    expect(store.get<{ id: string }>('SELECT id FROM comparison_assignments')?.id).toBe(receipt.assignment_id);
  } finally {
    store.close();
  }
});
test('alias_retry_consumes_no_slot', () => {
  const store = new Store(':memory:');
  try {
    const f = seedFlexibleComparison(store);
    const deps = { clock: () => '2026-01-01T00:00:00Z', shuffle: (x: readonly string[]) => x };
    const first = assignTask(store, { ...f.input, alias_ids: ['known-alias'] }, deps);
    const replay = assignTask(store, { ...f.input, task_id: 'retry-task', logical_task_id: 'known-alias' }, deps);
    expect(replay.assignment_id).toBe(first.assignment_id);
    expect(replay.reused).toBe(true);
    expect(store.get<{ next_index: number }>("SELECT next_index FROM comparison_allocation_state WHERE stratum_id='stratum-user-1'")?.next_index).toBe(1);
  } finally {
    store.close();
  }
});
test('requires_single_assignee_strata', () => {
  const f = makeFlexibleFixture();
  expect(FlexibleProtocolSchema.safeParse({ ...f.protocol, strata: [{ ...f.protocol.strata[0], assignees: ['user-1', 'user-2'] }] }).success).toBe(false);
});
