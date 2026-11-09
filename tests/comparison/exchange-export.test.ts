import { expect, test } from 'vitest';
import { assignTask } from '../../src/comparison/allocation.js';
import { buildExchangePackage, registerExchangeSource } from '../../src/comparison/exchange/source.js';
import { assignmentInput, protocol } from '../helpers/comparison-fixture.js';
import { freshSource, assignAndSnapshot, dataPackage, sourceConfig, exportTime, namespaceId, packageId } from '../helpers/exchange-fixture.js';

test('export preserves assignment and private state while retry uses identical sealed bytes', () => {
  const store = freshSource();
  try {
    assignAndSnapshot(store);
    assignTask(store, { ...assignmentInput, logical_task_id: 'logical-0', alias_ids: ['alias-1'] });
    const allocation = store.all('SELECT * FROM comparison_allocation_state');
    const pkg = dataPackage(store);
    expect(pkg.kind).toBe('assignment_metadata');
    if (pkg.kind !== 'assignment_metadata') throw new Error('wrong_kind');
    expect(pkg.assignments).toHaveLength(1);
    expect(pkg.assignments[0]).toMatchObject({
      task_id: 'task-1',
      logical_task_id: 'logical-0',
      alias_ids: ['alias-1', 'logical-1'],
      original_variant_id: protocol.variant_ids[0],
      allocation_index: 0
    });
    expect(pkg.assignments[0]!.evidence.usage).toMatchObject({ status: 'missing', partial_tokens: null, complete_tokens: null });
    expect(JSON.stringify(pkg)).not.toMatch(/code_base_commit|session_id|source_key|pending_variants|next_index/);
    expect(() => assignTask(store, { ...assignmentInput, alias_ids: ['new-alias'] })).toThrow('identity_sealed');
    expect(dataPackage(store)).toEqual(pkg);
    expect(store.all('SELECT * FROM comparison_allocation_state')).toEqual(allocation);
    expect(() => registerExchangeSource(store, sourceConfig)).not.toThrow();
  } finally {
    store.close();
  }
});

test('historical and conflicting source registration fail closed', () => {
  const store = freshSource();
  try {
    assignAndSnapshot(store);
    expect(() => registerExchangeSource(store, { ...sourceConfig, namespace_id: '44444444-4444-4444-8444-444444444444' })).toThrow('source_scope_not_empty');
    expect(() => registerExchangeSource(store, { ...sourceConfig, root: 'PRIVATE_SENTINEL' })).toThrow('invalid_exchange_package');
  } finally {
    store.close();
  }
});

test('source registration and export requests reject promotion authority before any write or replay', () => {
  const store = freshSource();
  try {
    assignAndSnapshot(store);
    dataPackage(store);
    const before = store.get('SELECT total_changes() AS changes');
    for (const field of ['promotion_authority', 'promotion_decision', 'promotion_grants', 'promotion_denials', 'promotion_origins']) {
      const injection = {
        [field]: { decision: 'approve', prior_deny_ids: [] }
      };
      expect(() => registerExchangeSource(store, { ...sourceConfig, ...injection })).toThrow('invalid_exchange_package');
      for (const request of [
        {
          kind: 'assignment_metadata' as const,
          protocolId: protocol.id,
          snapshotId: 'report-1',
          packageId
        },
        {
          kind: 'deletion_metadata' as const,
          namespaceId,
          packageId
        }
      ]) {
        expect(() => buildExchangePackage(store, { ...request, ...injection }, () => exportTime)).toThrow('invalid_exchange_package');
      }
    }
    expect(store.get('SELECT total_changes() AS changes')).toEqual(before);
  } finally {
    store.close();
  }
});
