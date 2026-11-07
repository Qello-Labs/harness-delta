import { assignTask } from '../../src/comparison/allocation.js';
import { freezeProtocol, registerProtocol, registerVariant } from '../../src/comparison/comparison.js';
import { Lifecycle } from '../../src/core/lifecycle.js';
import { Store } from '../../src/store.js';
import { assignmentInput, beforeRecruitment, metadata, protocol, seedProject, variantA, variantB } from './comparison-fixture.js';

export const cutoff = '2026-01-03T00:00:00.000Z';
export const evaluation = '2026-01-04T00:00:00.000Z';
export const request = { reportId: 'report-1', protocolId: protocol.id, cutoff, revisionReason: 'initial' as const };
export function reportStore(path = ':memory:'): Store {
  const store = new Store(path, () => '2026-01-02T00:00:00.000Z');
  seedProject(store);
  registerVariant(store, variantA);
  registerVariant(store, variantB);
  registerProtocol(store, protocol);
  freezeProtocol(store, protocol.id, beforeRecruitment);
  assignTask(store, assignmentInput, { clock: () => protocol.recruitment_start, shuffle: values => values });
  return store;
}
export function unassigned(store: Store, id = 'unassigned'): void {
  new Lifecycle(store, () => '2026-01-01T00:30:00.000Z').createTask('project-1', id, metadata);
}
export function syntheticUsage(store: Store, id = 'event-1'): void {
  store.execute('INSERT OR IGNORE INTO sessions(id,project_id,task_id,product,source_path) VALUES (?,?,?,?,?)', [
    'session-1',
    'project-1',
    'task-1',
    'synthetic',
    null
  ]);
  store.putEvent({
    id,
    project_id: 'project-1',
    task_id: 'task-1',
    session_id: 'session-1',
    source_key: `key-${id}`,
    occurred_at: '2026-01-01T00:10:00.000Z',
    payload: {
      kind: 'usage',
      product: 'synthetic',
      product_version: '1.0.0',
      model: 'synthetic-model',
      epoch: 'epoch-1',
      input_total: { status: 'observed', value: 7, reason: null },
      output_total: { status: 'observed', value: 3, reason: null },
      cached_input: { status: 'observed', value: 2, reason: null },
      reasoning_output: { status: 'observed', value: 1, reason: null }
    }
  });
}
