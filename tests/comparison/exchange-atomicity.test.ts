import { expect, test } from 'vitest';
import { importExchangePackage } from '../../src/comparison/exchange/import.js';
import { deleteImportedTask } from '../../src/comparison/exchange/retention.js';
import { paired, receivedAt } from '../helpers/exchange-import-fixture.js';
import { sharedProjectId } from '../helpers/exchange-fixture.js';
for (const table of ['exchange_identity_keys', 'exchange_import_revisions', 'exchange_import_receipts'])
  test(`import rolls back when ${table} write fails`, () => {
    const { source, dest, pkg } = paired();
    try {
      dest.execute(`CREATE TRIGGER failure BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'forced_failure'); END`, []);
      expect(() => importExchangePackage(dest, pkg, 'destination', () => receivedAt)).toThrow('forced_failure');
      for (const name of ['exchange_tasks', 'exchange_identity_keys', 'exchange_import_revisions', 'exchange_import_receipts'])
        expect(dest.all(`SELECT * FROM ${name}`)).toEqual([]);
    } finally {
      source.close();
      dest.close();
    }
  });
for (const kind of ['remote', 'local'])
  test(`${kind} deletion failure rolls back evidence, markers and revision`, () => {
    const { source, dest, pkg } = paired();
    try {
      importExchangePackage(dest, pkg, 'destination', () => receivedAt);
      const before = dest.all('SELECT * FROM exchange_merge_state');
      dest.execute("CREATE TRIGGER failure BEFORE INSERT ON exchange_protocol_invalidations BEGIN SELECT RAISE(ABORT,'forced_failure'); END", []);
      expect(() =>
        kind === 'local'
          ? deleteImportedTask(dest, { local_project_id: 'destination', shared_project_id: sharedProjectId, task_id: 'task-1' }, () => receivedAt)
          : importExchangePackage(
              dest,
              {
                schema_version: 1,
                kind: 'deletion_metadata',
                namespace_id: pkg.namespace_id,
                shared_project_id: sharedProjectId,
                package_id: '66666666-6666-4666-8666-666666666666',
                export_revision: 2,
                produced_at: receivedAt,
                tombstones: [{ kind: 'project', target_id: sharedProjectId, reason: 'deletion', invalidated_at: receivedAt }]
              },
              'destination',
              () => receivedAt
            )
      ).toThrow('forced_failure');
      expect(dest.all('SELECT * FROM exchange_tasks')).toHaveLength(1);
      expect(dest.all('SELECT * FROM exchange_tombstones')).toEqual([]);
      expect(dest.all('SELECT * FROM exchange_project_denials')).toEqual([]);
      expect(dest.all('SELECT * FROM exchange_merge_state')).toEqual(before);
    } finally {
      source.close();
      dest.close();
    }
  });
