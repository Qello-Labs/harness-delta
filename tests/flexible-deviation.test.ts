import { expect, test } from 'vitest';
import { Store } from '../src/store.js';
import { assignTask } from '../src/allocation.js';
import { confirmConfiguration } from '../src/config-confirmation-write.js';
import { createComparisonSnapshot, readComparisonSnapshot } from '../src/reports/comparison-snapshot.js';
import { registerExchangeSource, buildExchangePackage } from '../src/exchange/source.js';
import { registerExchangeMapping } from '../src/exchange/mapping.js';
import { protocolDigest } from '../src/exchange/contracts.js';
import { importExchangePackage } from '../src/exchange/import.js';
import { seedFlexibleComparison } from './helpers/flexible-store.js';
import { namespaceId, sharedProjectId, packageId } from './helpers/exchange-fixture.js';
test('crossover_is_frozen_exported_imported_and_late_confirmation_needs_new_revision', () => {
  const source = new Store(':memory:');
  const dest = new Store(':memory:');
  try {
    const f = seedFlexibleComparison(source);
    registerExchangeSource(source, {
      schema_version: 1,
      namespace_id: namespaceId,
      shared_project_id: sharedProjectId,
      local_project_id: 'project-1',
      protocol_id: f.protocol.id,
      owned_strata: f.protocol.strata.map(s => s.id)
    });
    const receipt = assignTask(source, f.input, { clock: () => f.protocol.recruitment_start, shuffle: x => x });
    const config = {
      schema_version: 1,
      id: 'cross-1',
      task_id: 'task-1',
      actual_variant_id: receipt.assigned_variant_id === 'variant-a' ? 'variant-b' : 'variant-a',
      evidence_method: 'self_attested',
      product: 'synthetic',
      product_version: '1.0.0',
      model: null,
      reasoning_setting: null,
      environment_id: 'environment-1'
    };
    confirmConfiguration(source, config, '2026-01-01T00:01:00Z');
    const request = { reportId: 'r1', protocolId: f.protocol.id, cutoff: '2026-01-01T02:00:00Z', revisionReason: 'initial' as const };
    const first = createComparisonSnapshot(source, request, () => request.cutoff);
    const raw = JSON.parse(source.get<{ input_json: string }>('SELECT input_json FROM flexible_report_snapshots WHERE report_id=?', ['r1'])!.input_json) as {
      assignments: { deviations: { reason_code: string }[]; confirmations: unknown[] }[];
    };
    expect(raw.assignments[0]!.deviations).toMatchObject([{ reason_code: 'crossover' }]);
    expect(raw.assignments[0]!.confirmations).toHaveLength(1);
    expect(first.tasks[0]).toMatchObject({ original_variant_id: receipt.assigned_variant_id, deviations: [{ reason_code: 'crossover' }] });
    const pkg = buildExchangePackage(
      source,
      { kind: 'assignment_metadata', protocolId: f.protocol.id, snapshotId: 'r1', packageId },
      () => '2026-01-01T03:00:00Z'
    );
    if (pkg.kind !== 'assignment_metadata') throw new Error('expected_data');
    expect(pkg.assignments[0]!.evidence.deviations).toMatchObject([{ reason_code: 'crossover' }]);
    dest.execute("INSERT INTO projects(id) VALUES ('dest')", []);
    registerExchangeMapping(dest, {
      schema_version: 1,
      local_project_id: 'dest',
      shared_project_id: sharedProjectId,
      protocol_id: f.protocol.id,
      protocol_digest: protocolDigest(pkg),
      writers: f.protocol.strata.map(s => ({ namespace_id: namespaceId, stratum_id: s.id, allocator_id: s.allocator_id }))
    });
    importExchangePackage(dest, pkg, 'dest', () => '2026-01-01T04:00:00Z');
    const imported = JSON.parse(dest.get<{ assignment_json: string }>('SELECT assignment_json FROM exchange_tasks')!.assignment_json) as {
      evidence: { deviations: unknown[] };
    };
    expect(imported.evidence.deviations).toEqual(pkg.assignments[0]!.evidence.deviations);
    confirmConfiguration(source, { ...config, id: 'cross-late', occurred_at: '2026-01-01T00:10:00Z' }, '2026-01-01T05:00:00Z');
    expect(readComparisonSnapshot(source, 'r1')).toEqual(first);
    const revised = createComparisonSnapshot(
      source,
      { ...request, reportId: 'r2', revisionReason: 'evidence_updated', supersedesReportId: 'r1' },
      () => '2026-01-01T06:00:00Z'
    );
    expect(revised.tasks[0]).toMatchObject({ deviations: [{ reason_code: 'crossover' }, { reason_code: 'crossover' }] });
  } finally {
    source.close();
    dest.close();
  }
});
