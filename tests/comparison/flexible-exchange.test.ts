import { expect, test } from 'vitest';
import { Store } from '../../src/store.js';
import { assignTask } from '../../src/comparison/allocation.js';
import { registerExchangeSource, buildExchangePackage } from '../../src/comparison/exchange/source.js';
import { registerExchangeMapping } from '../../src/comparison/exchange/mapping.js';
import { importExchangePackage } from '../../src/comparison/exchange/import.js';
import { protocolDigest } from '../../src/comparison/exchange/contracts.js';
import { createComparisonSnapshot } from '../../src/comparison/reports/comparison-snapshot.js';
import { putUsageWithEvidence } from '../../src/runtime-history.js';
import { registerPriceTable } from '../../src/pricing.js';
import { Deletion } from '../../src/deletion.js';
import { createTeamSnapshot } from '../../src/comparison/reports/team-snapshot.js';
import { seedFlexibleComparison } from '../helpers/flexible-store.js';
import { namespaceId, sharedProjectId, packageId } from '../helpers/exchange-fixture.js';
function fixture(finalized = false) {
  const source = new Store(':memory:', () => '2026-01-01T00:00:04Z');
  const destination = new Store(':memory:');
  const f = seedFlexibleComparison(source);
  registerExchangeSource(source, {
    schema_version: 1,
    namespace_id: namespaceId,
    shared_project_id: sharedProjectId,
    local_project_id: 'project-1',
    protocol_id: f.protocol.id,
    owned_strata: f.protocol.strata.map(s => s.id)
  });
  assignTask(source, f.input, { clock: () => f.protocol.recruitment_start, shuffle: x => x });
  source.execute("UPDATE tasks SET state='active',started_at=? WHERE id='task-1'", [f.protocol.recruitment_start]);
  source.execute("INSERT INTO sessions(id,task_id,project_id,product,product_version) VALUES ('session-1','task-1','project-1','synthetic','1.0.0')", []);
  putUsageWithEvidence(source, f.events[0]!, f.runtime[0]!);
  if (finalized) {
    source.execute("UPDATE tasks SET state='finalized',finalized_at='2026-01-01T00:00:20Z' WHERE id='task-1'", []);
    source.execute("INSERT INTO outcomes(task_id,status,assessed_at,criteria_met) VALUES ('task-1','success','2026-01-01T00:00:20Z','[\"criterion-1\"]')", []);
  }
  createComparisonSnapshot(
    source,
    { reportId: 'r1', protocolId: f.protocol.id, cutoff: '2026-01-01T02:00:00Z', revisionReason: 'initial' },
    () => '2026-01-01T02:00:00Z'
  );
  const pkg = buildExchangePackage(
    source,
    { kind: 'assignment_metadata', protocolId: f.protocol.id, snapshotId: 'r1', packageId },
    () => '2026-01-01T03:00:00Z'
  );
  destination.execute("INSERT INTO projects(id) VALUES ('destination-1')", []);
  if (pkg.kind !== 'assignment_metadata') throw new Error('expected_data_package');
  registerExchangeMapping(destination, {
    schema_version: 1,
    local_project_id: 'destination-1',
    shared_project_id: sharedProjectId,
    protocol_id: f.protocol.id,
    protocol_digest: protocolDigest(pkg),
    writers: f.protocol.strata.map(s => ({ namespace_id: namespaceId, stratum_id: s.id, allocator_id: s.allocator_id }))
  });
  return {
    source,
    destination,
    f,
    pkg,
    cleanup: () => {
      source.close();
      destination.close();
    }
  };
}
test('flexible_exchange_shares_only_allowlisted_cost_and_runtime_summary', () => {
  const f = fixture();
  try {
    expect(f.pkg.schema_version).toBe(2);
    expect(JSON.stringify(f.pkg)).not.toContain('session-1');
    expect(JSON.stringify(f.pkg)).not.toContain('runtime-1');
    expect(importExchangePackage(f.destination, f.pkg, 'destination-1', () => '2026-01-01T04:00:00Z').status).toBe('imported');
    expect(importExchangePackage(f.destination, f.pkg, 'destination-1', () => '2026-01-01T04:00:00Z').status).toBe('replayed');
  } finally {
    f.cleanup();
  }
});
test('price_table_conflict_quarantines', () => {
  const f = fixture();
  try {
    registerPriceTable(f.destination, { ...f.f.priceTable, currency: 'EUR' });
    expect(importExchangePackage(f.destination, f.pkg, 'destination-1', () => '2026-01-01T04:00:00Z')).toEqual({
      status: 'conflict_recorded',
      reason: 'price_table_conflict'
    });
    expect(f.destination.all('SELECT * FROM exchange_tasks')).toEqual([]);
  } finally {
    f.cleanup();
  }
});
test('deleted_runtime_cannot_resurrect_and_team_denominator_not_invented', () => {
  const f = fixture();
  try {
    importExchangePackage(f.destination, f.pkg, 'destination-1', () => '2026-01-01T04:00:00Z');
    const report = createTeamSnapshot(
      f.destination,
      {
        schema_version: 2,
        snapshot_id: 'team-r1',
        local_project_id: 'destination-1',
        shared_project_id: sharedProjectId,
        protocol_id: f.f.protocol.id,
        cutoff: '2026-01-01T02:00:00Z',
        as_of: '2026-01-01T04:00:00Z',
        required_namespaces: [namespaceId]
      },
      () => '2026-01-01T05:00:00Z'
    );
    expect(report.team_assignment_denominator).toBeNull();
    expect(report.team_completeness).toBe('unverified');
    new Deletion(f.source, () => '2026-01-01T05:00:00Z').deleteTask('task-1');
    const deletion = buildExchangePackage(
      f.source,
      { kind: 'deletion_metadata', namespaceId, packageId: '44444444-4444-4444-8444-444444444444' },
      () => '2026-01-01T06:00:00Z'
    );
    importExchangePackage(f.destination, deletion, 'destination-1', () => '2026-01-01T07:00:00Z');
    expect(() => importExchangePackage(f.destination, f.pkg, 'destination-1', () => '2026-01-01T08:00:00Z')).toThrow('deleted_identifier');
    expect(f.destination.all('SELECT * FROM exchange_tasks')).toEqual([]);
    expect(f.destination.all('SELECT * FROM exchange_team_snapshots')).toEqual([]);
  } finally {
    f.cleanup();
  }
});
test('mixed_currency_and_private_content_are_rejected_before_import', () => {
  const f = fixture();
  try {
    if (f.pkg.schema_version !== 2) throw new Error('expected_flexible');
    for (const pkg of [
      { ...f.pkg, price_table: { ...f.pkg.price_table, currency: 'EUR' } },
      { ...f.pkg, assignments: f.pkg.assignments.map(a => ({ ...a, evidence: { ...a.evidence, prompt: 'PRIVATE_SENTINEL' } })) },
      {
        ...f.pkg,
        assignments: f.pkg.assignments.map(a => ({
          ...a,
          evidence: { ...a.evidence, runtime_summary: { ...a.evidence.runtime_summary, session_id: 'PRIVATE_SESSION' } }
        }))
      }
    ])
      expect(() => importExchangePackage(f.destination, pkg, 'destination-1', () => '2026-01-01T04:00:00Z')).toThrow('invalid_exchange_package');
    expect(f.destination.all('SELECT * FROM exchange_tasks')).toEqual([]);
  } finally {
    f.cleanup();
  }
});
test('runtime_model_summary_cannot_carry_multiline_content_and_rejection_is_atomic', () => {
  const f = fixture();
  try {
    if (f.pkg.schema_version !== 2) throw new Error('expected_flexible');
    const pkg = {
      ...f.pkg,
      assignments: f.pkg.assignments.map(a => ({
        ...a,
        evidence: { ...a.evidence, runtime_summary: { ...a.evidence.runtime_summary, models: ['synthetic-model\nPRIVATE_CONTENT_SENTINEL'] } }
      }))
    };
    expect(() => importExchangePackage(f.destination, pkg, 'destination-1', () => '2026-01-01T04:00:00Z')).toThrow('invalid_exchange_package');
    for (const table of ['exchange_tasks', 'exchange_import_revisions', 'exchange_import_receipts', 'exchange_team_snapshots'])
      expect(f.destination.all(`SELECT * FROM ${table}`)).toEqual([]);
  } finally {
    f.cleanup();
  }
});

test('v2_retention_purges_cost_runtime_headers_snapshots_and_blocks_replay', async () => {
  const { configureImportedRetention, applyImportedRetention } = await import('../../src/comparison/exchange/retention.js');
  const f = fixture(true);
  try {
    importExchangePackage(f.destination, f.pkg, 'destination-1', () => '2026-01-01T04:00:00Z');
    createTeamSnapshot(
      f.destination,
      {
        schema_version: 2,
        snapshot_id: 'retention-team',
        local_project_id: 'destination-1',
        shared_project_id: sharedProjectId,
        protocol_id: f.f.protocol.id,
        cutoff: '2026-01-01T02:00:00Z',
        as_of: '2026-01-01T04:00:00Z',
        required_namespaces: [namespaceId]
      },
      () => '2026-01-01T05:00:00Z'
    );
    const scope = { local_project_id: 'destination-1', shared_project_id: sharedProjectId };
    configureImportedRetention(f.destination, { ...scope, days: 1 });
    expect(applyImportedRetention(f.destination, scope, () => '2026-01-03T00:00:00Z').status).toBe('protocol_retired');
    for (const table of ['exchange_tasks', 'exchange_import_revisions', 'exchange_team_snapshots', 'exchange_team_dependencies'])
      expect(f.destination.all(`SELECT * FROM ${table}`)).toEqual([]);
    expect(() => importExchangePackage(f.destination, f.pkg, 'destination-1', () => '2026-01-03T01:00:00Z')).toThrow('deleted_identifier');
  } finally {
    f.cleanup();
  }
});

test('synthetic exchange rejects native compatibility provenance and reference estimates atomically', () => {
  const f = fixture();
  try {
    if (f.pkg.schema_version !== 2) throw new Error('expected_flexible');
    const fields = [
      {
        compatibility: {
          verified_events: 0,
          compatibility_unverified_events: 1,
          legacy_unverified_events: 0,
          invalidated_events: 0,
          sources: [
            {
              state: 'compatibility_unverified',
              product: 'codex',
              product_version: '0.161.0',
              source: 'codex_workflow',
              parser_version: '0.160.0',
              parser_revision: 'synthetic-parser',
              profile_id: 'synthetic-profile',
              rule_revision: 'synthetic-rule',
              event_count: 1
            }
          ]
        }
      },
      { compatibility_unverified_partial_amount: '0.26' },
      { legacy_unverified_partial_amount: '0.26' }
    ];
    for (const field of fields) {
      const pkg = { ...f.pkg, assignments: f.pkg.assignments.map(a => ({ ...a, evidence: { ...a.evidence, cost: { ...a.evidence.cost, ...field } } })) };
      expect(() => importExchangePackage(f.destination, pkg, 'destination-1', () => '2026-01-01T04:00:00Z')).toThrow('invalid_exchange_package');
    }
    expect(f.destination.all('SELECT * FROM exchange_tasks')).toEqual([]);
    expect(f.destination.all('SELECT * FROM exchange_import_receipts')).toEqual([]);
  } finally {
    f.cleanup();
  }
});
