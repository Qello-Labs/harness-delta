import { expect, test } from 'vitest';
import { paired, receivedAt } from '../helpers/exchange-import-fixture.js';
import { importExchangePackage } from '../../src/comparison/exchange/import.js';
import { createTeamSnapshot, readTeamSnapshot } from '../helpers/legacy-exchange.js';
import { deleteImportedTask } from '../../src/comparison/exchange/retention.js';
import { renderTeamReport } from '../../src/comparison/reports/team-render.js';
const now = '2026-01-06T00:00:00.000Z';
function setup() {
  const f = paired();
  importExchangePackage(f.dest, f.pkg, 'destination', () => receivedAt);
  const request = {
    schema_version: 1,
    snapshot_id: 'team-1',
    local_project_id: 'destination',
    shared_project_id: f.mapping.shared_project_id,
    protocol_id: f.pkg.protocol_id,
    cutoff: f.pkg.cutoff,
    as_of: receivedAt,
    required_namespaces: [f.pkg.namespace_id]
  };
  return { ...f, request };
}
test('freezes a reproducible current vector without inventing complete team evidence', () => {
  const f = setup();
  try {
    const report = createTeamSnapshot(f.dest, f.request, () => now);
    expect(report).toMatchObject({
      validity_status: 'valid',
      purpose: 'synthetic_validation',
      team_completeness: 'unverified',
      team_assignment_denominator: null,
      declared_writer_coverage: 'complete',
      missing_namespaces: [],
      total: { assigned_tasks: 1, deadline_counts: { not_started: 1 }, usage: { missing_tasks: 1, complete_tokens_mean: null, cost: null } },
      adoption: { status: 'inconclusive' }
    });
    expect(report.source_vector).toMatchObject([
      { namespace_id: f.pkg.namespace_id, export_revision: 1, source_evaluated_at: f.pkg.source_evaluated_at, received_at: receivedAt }
    ]);
    expect(createTeamSnapshot(f.dest, f.request, () => now)).toEqual(report);
    const newer = structuredClone(f.pkg);
    newer.package_id = '55555555-5555-4555-8555-555555555555';
    newer.export_revision = 2;
    importExchangePackage(f.dest, newer, 'destination', () => now);
    expect(readTeamSnapshot(f.dest, 'team-1')).toEqual(report);
    expect(createTeamSnapshot(f.dest, f.request, () => now)).toEqual(report);
    expect(() => createTeamSnapshot(f.dest, { ...f.request, as_of: now }, () => now)).toThrow('report_conflict');
    expect(renderTeamReport(report, 'markdown')).toContain('Team completeness: unverified');
    expect(JSON.parse(renderTeamReport(report, 'json')) as unknown).toEqual(report);
  } finally {
    f.source.close();
    f.dest.close();
  }
});
test('rejects unavailable historical arrivals, cutoff mismatch, omitted writers and future requests', () => {
  const f = setup();
  try {
    expect(() => createTeamSnapshot(f.dest, { ...f.request, as_of: f.pkg.produced_at }, () => now)).toThrow('snapshot_as_of_unavailable');
    expect(() => createTeamSnapshot(f.dest, { ...f.request, cutoff: '2026-01-02T00:00:00Z' }, () => now)).toThrow('cutoff_mismatch');
    expect(() => createTeamSnapshot(f.dest, { ...f.request, required_namespaces: [] }, () => now)).toThrow();
    expect(() => createTeamSnapshot(f.dest, { ...f.request, as_of: '2026-01-07T00:00:00Z' }, () => now)).toThrow('invalid_snapshot_request');
    expect(f.dest.all('SELECT * FROM exchange_team_snapshots')).toEqual([]);
  } finally {
    f.source.close();
    f.dest.close();
  }
});
test('retirement purges frozen payload hashes and dependencies and cannot create another snapshot', () => {
  const f = setup();
  try {
    createTeamSnapshot(f.dest, f.request, () => now);
    deleteImportedTask(f.dest, { local_project_id: 'destination', shared_project_id: f.mapping.shared_project_id, task_id: 'task-1' }, () => now);
    expect(readTeamSnapshot(f.dest, 'team-1')).toEqual({
      schema_version: 1,
      snapshot_id: 'team-1',
      validity_status: 'invalidated',
      reason: 'deletion',
      original_cohort: 'unavailable_due_to_deletion',
      adoption: { status: 'inconclusive', reason: 'deletion' }
    });
    for (const table of ['exchange_team_snapshots', 'exchange_team_dependencies', 'exchange_team_sequences'])
      expect(f.dest.all(`SELECT * FROM ${table}`)).toEqual([]);
    expect(() => createTeamSnapshot(f.dest, { ...f.request, snapshot_id: 'team-2' }, () => now)).toThrow('deleted_identifier');
    expect(() => importExchangePackage(f.dest, f.pkg, 'destination', () => now)).toThrow('deleted_identifier');
  } finally {
    f.source.close();
    f.dest.close();
  }
});
test('snapshot transaction rolls back payload and sequence on dependency storage failure', () => {
  const f = setup();
  try {
    f.dest.execute("CREATE TRIGGER fail_team BEFORE INSERT ON exchange_team_dependencies BEGIN SELECT RAISE(ABORT,'synthetic_failure'); END", []);
    expect(() => createTeamSnapshot(f.dest, f.request, () => now)).toThrow();
    expect(f.dest.all('SELECT * FROM exchange_team_snapshots')).toEqual([]);
    expect(f.dest.all('SELECT * FROM exchange_team_sequences')).toEqual([]);
  } finally {
    f.source.close();
    f.dest.close();
  }
});

test('empty accepted writer contribution has an empty denominator, not a missing writer', () => {
  const f = paired();
  try {
    f.pkg.assignments = [];
    importExchangePackage(f.dest, f.pkg, 'destination', () => receivedAt);
    const request = {
      schema_version: 1,
      snapshot_id: 'empty',
      local_project_id: 'destination',
      shared_project_id: f.mapping.shared_project_id,
      protocol_id: f.pkg.protocol_id,
      cutoff: f.pkg.cutoff,
      as_of: receivedAt,
      required_namespaces: [f.pkg.namespace_id]
    };
    const r = createTeamSnapshot(f.dest, request, () => now);
    expect(r.total.assigned_tasks).toBe(0);
    expect(r.total.deadline_success).toMatchObject({ denominator: 0, value: null, reason: 'empty_denominator' });
    expect(r.declared_writer_coverage).toBe('complete');
    expect(r.team_assignment_denominator).toBeNull();
  } finally {
    f.source.close();
    f.dest.close();
  }
});
test('tampered snapshot storage fails integrity validation and unknown request fields fail closed', () => {
  const f = setup();
  try {
    expect(() => createTeamSnapshot(f.dest, { ...f.request, PRIVATE_SENTINEL: 'private' }, () => now)).toThrow('invalid_snapshot_request');
    createTeamSnapshot(f.dest, f.request, () => now);
    f.dest.execute("UPDATE exchange_team_snapshots SET snapshot_hash='0'", []);
    expect(() => readTeamSnapshot(f.dest, 'team-1')).toThrow('invalid_snapshot');
  } finally {
    f.source.close();
    f.dest.close();
  }
});
