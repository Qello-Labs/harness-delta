import { expect, test } from 'vitest';
import { importExchangePackage } from '../../src/comparison/exchange/import.js';
import { deleteImportedTask, configureImportedRetention, applyImportedRetention } from '../../src/comparison/exchange/retention.js';
import { paired, receivedAt } from '../helpers/exchange-import-fixture.js';
import { sharedProjectId } from '../helpers/exchange-fixture.js';
const scope = { local_project_id: 'destination', shared_project_id: sharedProjectId };
test('valid retirement wins over stale live data and prevents resurrection with a new package ID', () => {
  const { source, dest, pkg } = paired();
  try {
    importExchangePackage(dest, pkg, 'destination', () => receivedAt);
    const retired = {
      ...pkg,
      produced_at: receivedAt,
      package_id: '66666666-6666-4666-8666-666666666666',
      tombstones: [{ kind: 'protocol_invalidated', target_id: pkg.protocol_id, reason: 'deletion', invalidated_at: receivedAt }]
    };
    expect(importExchangePackage(dest, retired, 'destination', () => receivedAt)).toMatchObject({
      status: 'deletions_applied_data_rejected',
      reason: 'deleted_identifier'
    });
    expect(dest.all('SELECT * FROM exchange_tasks')).toEqual([]);
    expect(() => importExchangePackage(dest, pkg, 'destination', () => receivedAt)).toThrow('deleted_identifier');
    expect(() =>
      importExchangePackage(dest, { ...pkg, package_id: '77777777-7777-4777-8777-777777777777', export_revision: 3 }, 'destination', () => receivedAt)
    ).toThrow('deleted_identifier');
    expect(dest.all<{ digest: string | null }>('SELECT digest FROM exchange_import_receipts').every(r => r.digest === null)).toBe(true);
  } finally {
    source.close();
    dest.close();
  }
});
test('local imported-task deletion does not delete a colliding local source task', () => {
  const { source, dest, pkg } = paired();
  try {
    importExchangePackage(dest, pkg, 'destination', () => receivedAt);
    dest.execute("INSERT INTO tasks(id,project_id) VALUES ('task-1','destination')", []);
    expect(deleteImportedTask(dest, { ...scope, task_id: 'task-1' }, () => receivedAt).status).toBe('deleted');
    expect(dest.get("SELECT id FROM tasks WHERE id='task-1'")).toBeDefined();
    expect(deleteImportedTask(dest, { ...scope, task_id: 'task-1' }, () => receivedAt).status).toBe('replayed');
    expect(dest.all('SELECT * FROM exchange_tasks')).toEqual([]);
  } finally {
    source.close();
    dest.close();
  }
});
test('destination retention is explicit and expires by finalized time, never receipt time', () => {
  const { source, dest, pkg } = paired();
  try {
    importExchangePackage(dest, pkg, 'destination', () => receivedAt);
    expect(() => applyImportedRetention(dest, scope, () => receivedAt)).toThrow('retention_not_configured');
    configureImportedRetention(dest, { ...scope, days: 1 });
    expect(applyImportedRetention(dest, scope, () => receivedAt)).toMatchObject({ expired_tasks: 0, status: 'unchanged' });
    // The final-result fixture is inserted at the import storage seam; arithmetic tested separately end-to-end.
    dest.execute("UPDATE exchange_tasks SET finalized_at='2026-01-02T00:00:00.000Z'", []);
    expect(applyImportedRetention(dest, scope, () => receivedAt)).toMatchObject({ expired_tasks: 1, status: 'protocol_retired' });
    expect(dest.all('SELECT * FROM exchange_tasks')).toEqual([]);
  } finally {
    source.close();
    dest.close();
  }
});

test('large lifetime denial history transmits as one bounded protocol retirement', async () => {
  const { source, dest, pkg } = paired();
  try {
    importExchangePackage(dest, pkg, 'destination', () => receivedAt);
    source.execute(
      "WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<140000) INSERT INTO exchange_source_tombstones SELECT printf('%0128d',n),'2026-01-04T00:00:00.000Z' FROM seq",
      []
    );
    const { Deletion } = await import('../../src/deletion.js');
    const { buildExchangePackage } = await import('../../src/comparison/exchange/source.js');
    new Deletion(source, () => receivedAt).deleteTask('task-1');
    const notice = buildExchangePackage(
      source,
      { kind: 'deletion_metadata', namespaceId: pkg.namespace_id, packageId: '66666666-6666-4666-8666-666666666666' },
      () => receivedAt
    );
    expect(JSON.stringify(notice).length).toBeLessThan(1000);
    expect(notice.tombstones).toHaveLength(1);
    expect(importExchangePackage(dest, notice, 'destination', () => receivedAt).status).toBe('deletions_applied');
    expect(dest.all('SELECT * FROM exchange_tasks')).toEqual([]);
    expect(() => importExchangePackage(dest, pkg, 'destination', () => receivedAt)).toThrow('deleted_identifier');
  } finally {
    source.close();
    dest.close();
  }
});

test('authorized deletion commits even when schema-valid live assignment conflicts', () => {
  const { source, dest, pkg } = paired();
  try {
    importExchangePackage(dest, pkg, 'destination', () => receivedAt);
    const mixed = structuredClone(pkg);
    mixed.produced_at = receivedAt;
    mixed.export_revision = 2;
    mixed.tombstones = [{ kind: 'protocol_invalidated', target_id: pkg.protocol_id, reason: 'deletion', invalidated_at: receivedAt }];
    mixed.assignments[0]!.original_variant_id = 'unknown-variant';
    expect(importExchangePackage(dest, mixed, 'destination', () => receivedAt)).toEqual({
      status: 'deletions_applied_data_rejected',
      reason: 'deleted_identifier'
    });
    expect(dest.all('SELECT * FROM exchange_tasks')).toEqual([]);
    expect(dest.all('SELECT * FROM exchange_protocol_invalidations')).toHaveLength(1);
  } finally {
    source.close();
    dest.close();
  }
});
