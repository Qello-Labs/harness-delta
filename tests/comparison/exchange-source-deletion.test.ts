import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { Deletion } from '../../src/deletion.js';
import { buildExchangePackage } from '../../src/comparison/exchange/source.js';
import { freshSource, assignAndSnapshot, dataPackage, namespaceId, exportTime } from '../helpers/exchange-fixture.js';

test('project deletion leaves compact exportable denial and purges producer retry evidence', () => {
  const store = freshSource();
  try {
    assignAndSnapshot(store);
    dataPackage(store);
    new Deletion(store, () => exportTime).deleteProject('project-1');
    expect(() => dataPackage(store)).toThrow('export_invalidated');
    const pkg = buildExchangePackage(store, { kind: 'deletion_metadata', namespaceId, packageId: '44444444-4444-4444-8444-444444444444' }, () => exportTime);
    expect(pkg.tombstones).toEqual([{ kind: 'project', target_id: '22222222-2222-4222-8222-222222222222', reason: 'deletion', invalidated_at: exportTime }]);
    expect(store.all('SELECT * FROM exchange_export_identities')).toEqual([]);
    expect(JSON.stringify(store.all('SELECT * FROM exchange_export_receipts'))).not.toContain('snapshot_hash');
  } finally {
    store.close();
  }
});

test('failed source deletion rolls back notice, sealed identities, snapshot and task together', () => {
  const store = freshSource();
  try {
    assignAndSnapshot(store);
    const pkg = dataPackage(store);
    store.execute("CREATE TRIGGER fail_delete BEFORE DELETE ON tasks BEGIN SELECT RAISE(ABORT,'forced_failure'); END", []);
    expect(() => new Deletion(store).deleteTask('task-1')).toThrow('forced_failure');
    expect(store.all('SELECT * FROM exchange_scope_notices')).toEqual([]);
    expect(dataPackage(store)).toEqual(pkg);
  } finally {
    store.close();
  }
});

test('source alias conflict survives restart as an outbound invalidation and never hides behind sealing', async () => {
  const { Store } = await import('../../src/store.js');
  const { assignTask } = await import('../../src/comparison/allocation.js');
  const { assignmentInput, protocol } = await import('../helpers/comparison-fixture.js');
  const dir = mkdtempSync(join(tmpdir(), 'exchange-restart-'));
  const path = join(dir, 'source.db');
  let store = freshSource(path);
  try {
    assignAndSnapshot(store);
    dataPackage(store);
    assignTask(store, { ...assignmentInput, task_id: 'task-2', logical_task_id: 'logical-2' }, { clock: () => protocol.recruitment_start, shuffle: a => a });
    expect(() => assignTask(store, { ...assignmentInput, alias_ids: ['logical-2'] })).toThrow('identity_conflict');
    store.close();
    store = new Store(path);
    const pkg = buildExchangePackage(
      store,
      { kind: 'deletion_metadata', namespaceId, packageId: '55555555-5555-4555-8555-555555555555' },
      () => '2026-10-02T00:00:00Z'
    );
    expect(pkg.tombstones).toMatchObject([{ kind: 'protocol_invalidated', reason: 'identity_conflict', target_id: protocol.id }]);
    expect(() => dataPackage(store)).toThrow('export_invalidated');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
