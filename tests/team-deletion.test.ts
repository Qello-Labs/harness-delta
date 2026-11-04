import { expect, test } from 'vitest';
import { teamFixture } from './helpers/team-fixture.js';
import { importExchangePackage } from '../src/exchange/import.js';
import { createTeamSnapshot, readTeamSnapshot } from '../src/reports/team-snapshot.js';
import { Deletion } from '../src/deletion.js';
import { buildExchangePackage } from '../src/exchange/source.js';
import { assignTask } from '../src/allocation.js';
import { assignmentInput } from './helpers/comparison-fixture.js';
const now = '2026-01-06T00:00:00.000Z';
for (const mode of ['source-delete', 'source-conflict', 'project-delete', 'local-project-delete'] as const)
  test(`${mode} purges every writer and frozen cohort`, () => {
    const f = teamFixture();
    try {
      for (const p of f.packages) importExchangePackage(f.dest, p, 'destination', () => f.request.as_of);
      createTeamSnapshot(f.dest, f.request, () => now);
      if (mode === 'local-project-delete') new Deletion(f.dest, () => now).deleteProject('destination');
      else {
        if (mode === 'source-delete') new Deletion(f.sources[0]!, () => now).deleteTask('task-1');
        if (mode === 'project-delete') new Deletion(f.sources[0]!, () => now).deleteProject('project-1');
        if (mode === 'source-conflict')
          expect(() => assignTask(f.sources[0]!, { ...assignmentInput, task_id: 'task-1', logical_task_id: 'logical-2' }, { clock: () => now })).toThrow(
            'identity_conflict'
          );
        const notice = buildExchangePackage(
          f.sources[0]!,
          { kind: 'deletion_metadata', namespaceId: f.packages[0]!.namespace_id, packageId: '99999999-9999-4999-8999-999999999999' },
          () => now
        );
        expect(importExchangePackage(f.dest, notice, 'destination', () => now).status).toBe('deletions_applied');
      }
      expect(readTeamSnapshot(f.dest, f.request.snapshot_id)).toMatchObject({
        validity_status: 'invalidated',
        reason: mode === 'source-conflict' ? 'identity_conflict' : 'deletion'
      });
      for (const table of [
        'exchange_tasks',
        'exchange_identity_keys',
        'exchange_import_revisions',
        'exchange_team_snapshots',
        'exchange_team_dependencies',
        'exchange_team_sequences'
      ])
        expect(f.dest.all(`SELECT * FROM ${table}`)).toEqual([]);
      expect(
        f.dest.all<{ digest: string | null }>("SELECT digest FROM exchange_import_receipts WHERE kind='assignment_metadata'").every(r => r.digest === null)
      ).toBe(true);
      expect(() => importExchangePackage(f.dest, f.packages[1], 'destination', () => now)).toThrow('deleted_identifier');
    } finally {
      f.close();
    }
  });
test('failed purge rolls back reports and live tasks together', () => {
  const f = teamFixture();
  try {
    for (const p of f.packages) importExchangePackage(f.dest, p, 'destination', () => f.request.as_of);
    const r = createTeamSnapshot(f.dest, f.request, () => now);
    f.dest.execute("CREATE TRIGGER stop_purge BEFORE DELETE ON exchange_team_snapshots BEGIN SELECT RAISE(ABORT,'synthetic_failure'); END", []);
    expect(() => new Deletion(f.dest, () => now).deleteProject('destination')).toThrow();
    expect(readTeamSnapshot(f.dest, f.request.snapshot_id)).toEqual(r);
    expect(f.dest.all('SELECT * FROM exchange_tasks')).toHaveLength(8);
    expect(f.dest.all('SELECT * FROM exchange_protocol_invalidations')).toEqual([]);
  } finally {
    f.close();
  }
});
