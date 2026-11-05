import { expect, test } from 'vitest';
import { teamFixture } from '../helpers/team-fixture.js';
import { importExchangePackage } from '../../src/comparison/exchange/import.js';
import { applyImportedRetention, configureImportedRetention } from '../../src/comparison/exchange/retention.js';
import { Deletion } from '../../src/deletion.js';
import { buildExchangePackage } from '../../src/comparison/exchange/source.js';
const now = '2026-01-06T00:00:00.000Z';
for (const mode of ['project', 'protocol', 'alias-conflict'] as const)
  test(`${mode} retires all writer contributions`, () => {
    const f = teamFixture();
    try {
      for (const p of f.packages) importExchangePackage(f.dest, p, 'destination', () => f.request.as_of);
      if (mode === 'alias-conflict') {
        const pkg = structuredClone(f.packages[1]!);
        pkg.export_revision = 2;
        pkg.package_id = '99999999-9999-4999-8999-999999999999';
        pkg.source_snapshot_sequence++;
        pkg.assignments[0]!.alias_ids.push('logical-1');
        expect(importExchangePackage(f.dest, pkg, 'destination', () => now)).toEqual({ status: 'conflict_recorded', reason: 'identity_conflict' });
      } else {
        if (mode === 'project') new Deletion(f.sources[0]!, () => now).deleteProject('project-1');
        else new Deletion(f.sources[0]!, () => now).deleteTask('task-1');
        const notice = buildExchangePackage(
          f.sources[0]!,
          { kind: 'deletion_metadata', namespaceId: f.packages[0]!.namespace_id, packageId: '99999999-9999-4999-8999-999999999999' },
          () => now
        );
        expect(importExchangePackage(f.dest, notice, 'destination', () => now).status).toBe('deletions_applied');
      }
      expect(f.dest.all('SELECT * FROM exchange_tasks')).toEqual([]);
      expect(f.dest.all('SELECT * FROM exchange_import_revisions')).toEqual([]);
      expect(() => importExchangePackage(f.dest, f.packages[1], 'destination', () => now)).toThrow('deleted_identifier');
    } finally {
      f.close();
    }
  });
test('higher revisions cannot rewrite finalized human assessments', () => {
  const f = teamFixture();
  try {
    const pkg = f.packages[0]!;
    importExchangePackage(f.dest, pkg, 'destination', () => f.request.as_of);
    const revised = structuredClone(pkg);
    revised.export_revision = 2;
    revised.package_id = '99999999-9999-4999-8999-999999999999';
    revised.source_snapshot_sequence++;
    revised.assignments[0]!.evidence.current_outcome = 'failed';
    revised.assignments[0]!.evidence.criteria_met = [];
    expect(() => importExchangePackage(f.dest, revised, 'destination', () => now)).toThrow('evidence_conflict');
    expect(f.dest.all('SELECT * FROM exchange_tasks')).toHaveLength(4);
  } finally {
    f.close();
  }
});
test('notice before first data denies both writers; retention boundary is exact and atomic', () => {
  const f = teamFixture();
  try {
    new Deletion(f.sources[0]!, () => now).deleteTask('task-1');
    const notice = buildExchangePackage(
      f.sources[0]!,
      { kind: 'deletion_metadata', namespaceId: f.packages[0]!.namespace_id, packageId: '99999999-9999-4999-8999-999999999999' },
      () => now
    );
    importExchangePackage(f.dest, notice, 'destination', () => now);
    for (const pkg of f.packages) expect(() => importExchangePackage(f.dest, pkg, 'destination', () => now)).toThrow('deleted_identifier');
  } finally {
    f.close();
  }
  const g = teamFixture();
  try {
    for (const pkg of g.packages) importExchangePackage(g.dest, pkg, 'destination', () => g.request.as_of);
    const scope = { local_project_id: 'destination', shared_project_id: g.mapping.shared_project_id };
    configureImportedRetention(g.dest, { ...scope, days: 1 });
    expect(applyImportedRetention(g.dest, scope, () => '2026-01-02T00:06:59.999Z').expired_tasks).toBe(0);
    g.dest.execute("CREATE TRIGGER block_retirement BEFORE INSERT ON exchange_protocol_invalidations BEGIN SELECT RAISE(ABORT,'synthetic_failure'); END", []);
    expect(() => applyImportedRetention(g.dest, scope, () => '2026-01-02T00:07:00.000Z')).toThrow();
    expect(g.dest.all('SELECT * FROM exchange_tasks')).toHaveLength(8);
    g.dest.execute('DROP TRIGGER block_retirement', []);
    expect(applyImportedRetention(g.dest, scope, () => '2026-01-02T00:07:00.000Z')).toMatchObject({ expired_tasks: 6, status: 'protocol_retired' });
    expect(g.dest.all('SELECT * FROM exchange_tasks')).toEqual([]);
  } finally {
    g.close();
  }
});

test('identity collision across distinct protocol mappings retires both cohorts', async () => {
  const { paired, receivedAt } = await import('../helpers/exchange-import-fixture.js');
  const { registerExchangeMapping } = await import('../../src/comparison/exchange/mapping.js');
  const { protocolDigest } = await import('../../src/comparison/exchange/contracts.js');
  const f = paired();
  try {
    importExchangePackage(f.dest, f.pkg, 'destination', () => receivedAt);
    const p = structuredClone(f.pkg);
    p.namespace_id = '99999999-9999-4999-8999-999999999999';
    p.package_id = p.namespace_id;
    p.protocol_id = 'protocol-2';
    p.protocol.settings.id = p.protocol_id;
    p.assignments[0]!.protocol_id = p.protocol_id;
    p.assignments[0]!.task_id = 'task-2';
    p.assignments[0]!.assignment_id = 'assignment-2';
    registerExchangeMapping(f.dest, {
      ...f.mapping,
      protocol_id: p.protocol_id,
      protocol_digest: protocolDigest(p),
      writers: [{ ...f.mapping.writers[0]!, namespace_id: p.namespace_id }]
    });
    expect(importExchangePackage(f.dest, p, 'destination', () => receivedAt)).toEqual({ status: 'conflict_recorded', reason: 'identity_conflict' });
    expect(f.dest.all('SELECT * FROM exchange_protocol_invalidations')).toHaveLength(2);
    expect(f.dest.all('SELECT * FROM exchange_tasks')).toEqual([]);
  } finally {
    f.source.close();
    f.dest.close();
  }
});
