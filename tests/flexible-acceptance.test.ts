import { expect, test } from 'vitest';
import { Store } from '../src/store.js';
import { assignTask } from '../src/comparison/allocation.js';
import { Lifecycle } from '../src/lifecycle.js';
import { registerProtocol, freezeProtocol } from '../src/comparison.js';
import { seedFlexibleComparison } from './helpers/flexible-store.js';
import { putUsageWithEvidence } from '../src/runtime-history.js';
import { createComparisonSnapshot, readComparisonSnapshot } from '../src/comparison/reports/comparison-snapshot.js';
import { registerExchangeSource, buildExchangePackage } from '../src/comparison/exchange/source.js';
import { registerExchangeMapping } from '../src/comparison/exchange/mapping.js';
import { importExchangePackage } from '../src/comparison/exchange/import.js';
import { protocolDigest } from '../src/comparison/exchange/contracts.js';
import { Deletion } from '../src/deletion.js';
import { namespaceId, sharedProjectId, packageId } from './helpers/exchange-fixture.js';
test('synthetic_end_to_end_flexible_cost_preserves_assignment_sessions_quality_and_deletion', () => {
  const source = new Store(':memory:', () => '2026-01-01T00:00:10Z');
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
    const assigned = assignTask(source, f.input, { clock: () => f.protocol.recruitment_start, shuffle: x => x });
    source.execute("UPDATE tasks SET state='active',started_at=? WHERE id='task-1'", [f.protocol.recruitment_start]);
    for (let n = 1; n <= 3; n++) {
      const session = `session-${n}`;
      source.execute('INSERT INTO sessions(id,task_id,project_id,product,product_version) VALUES (?,?,?,?,?)', [
        session,
        'task-1',
        'project-1',
        'synthetic',
        '1.0.0'
      ]);
      const runtime = {
        ...f.runtime[0]!,
        id: `runtime-${n}`,
        session_id: session,
        request_id: `request-${n}`,
        model: n === 3 ? 'synthetic-unpriced' : 'synthetic-model',
        effort: n === 1 ? null : 'high',
        occurred_at: `2026-01-01T00:00:0${n}Z`,
        recorded_at: '2026-01-01T00:00:10Z'
      };
      putUsageWithEvidence(
        source,
        {
          ...f.events[0]!,
          id: `event-${n}`,
          source_key: `event-${n}`,
          session_id: session,
          occurred_at: `2026-01-01T00:00:0${n + 2}Z`,
          payload: { ...f.events[0]!.payload, runtime_evidence_id: runtime.id, model: runtime.model }
        },
        runtime
      );
    }
    new Lifecycle(source, () => '2026-01-01T00:00:11Z').finalize('task-1', 'success', ['criterion-1']);
    expect(assignTask(source, f.input, { clock: () => '2026-01-01T00:00:12Z' })).toMatchObject({
      assignment_id: assigned.assignment_id,
      assigned_variant_id: assigned.assigned_variant_id,
      reused: true
    });
    const report = createComparisonSnapshot(
      source,
      { reportId: 'r1', protocolId: f.protocol.id, cutoff: '2026-01-01T02:00:00Z', revisionReason: 'initial' },
      () => '2026-01-01T02:00:00Z'
    );
    if (report.schema_version !== 2) throw new Error('expected_flexible');
    expect(report.tasks[0]).toMatchObject({
      cost: { partial_amount: '0.52', complete_amount: null },
      quality: { outcome: 'success', criteria_total: 1 },
      runtime_summary: { changes: 2 },
      original_variant_id: assigned.assigned_variant_id
    });
    expect(report.arms.reduce((n, a) => n + a.assigned_count, 0)).toBe(1);
    expect(report.relative_change).toBeNull();
    const pkg = buildExchangePackage(
      source,
      { kind: 'assignment_metadata', protocolId: f.protocol.id, snapshotId: 'r1', packageId },
      () => '2026-01-01T03:00:00Z'
    );
    if (pkg.kind !== 'assignment_metadata') throw new Error('expected_data');
    dest.execute("INSERT INTO projects(id) VALUES ('destination-1')", []);
    registerExchangeMapping(dest, {
      schema_version: 1,
      local_project_id: 'destination-1',
      shared_project_id: sharedProjectId,
      protocol_id: f.protocol.id,
      protocol_digest: protocolDigest(pkg),
      writers: f.protocol.strata.map(s => ({ namespace_id: namespaceId, stratum_id: s.id, allocator_id: s.allocator_id }))
    });
    expect(importExchangePackage(dest, pkg, 'destination-1', () => '2026-01-01T04:00:00Z').status).toBe('imported');
    new Deletion(source, () => '2026-01-01T05:00:00Z').deleteTask('task-1');
    expect(readComparisonSnapshot(source, 'r1').validity_status).toBe('invalidated');
    expect(source.all('SELECT * FROM runtime_evidence')).toEqual([]);
    const notice = buildExchangePackage(
      source,
      { kind: 'deletion_metadata', namespaceId, packageId: '44444444-4444-4444-8444-444444444444' },
      () => '2026-01-01T06:00:00Z'
    );
    importExchangePackage(dest, notice, 'destination-1', () => '2026-01-01T07:00:00Z');
    expect(dest.all('SELECT * FROM exchange_tasks')).toEqual([]);
    expect(() => importExchangePackage(dest, pkg, 'destination-1', () => '2026-01-01T08:00:00Z')).toThrow('deleted_identifier');
  } finally {
    source.close();
    dest.close();
  }
});
test('incomplete_protocol_cannot_freeze_and_real_assignment_denied_without_evidence', () => {
  const store = new Store(':memory:');
  try {
    const f = seedFlexibleComparison(store);
    for (const key of ['price_table_id', 'followup_seconds', 'minimum_effect', 'sample_plan', 'quality_margin', 'planning_basis_id'] as const) {
      const raw: Record<string, unknown> = { ...f.protocol, id: `missing-${key}` };
      delete raw[key];
      registerProtocol(store, raw);
      expect(() => freezeProtocol(store, raw.id as string, '2025-12-31T00:00:00Z')).toThrow('incomplete_protocol');
    }
    registerProtocol(store, {
      ...f.protocol,
      id: 'real',
      purpose: 'real_experiment',
      source_profiles: [{ product: 'codex', product_version: '0.158.0', profile_id: 'unverified-source' }]
    });
    freezeProtocol(store, 'real', '2025-12-31T00:00:00Z');
    expect(() =>
      assignTask(
        store,
        { ...f.input, protocol_id: 'real', task_id: 'real-task', logical_task_id: 'real-logical', metadata: { ...f.metadata, product: 'codex' } },
        { clock: () => f.protocol.recruitment_start }
      )
    ).toThrow('real_experiment_disabled');
  } finally {
    store.close();
  }
});
test('synthetic_store_cannot_convert_even_after_tasks_are_deleted', () => {
  const store = new Store(':memory:');
  try {
    const f = seedFlexibleComparison(store);
    assignTask(store, f.input, { clock: () => f.protocol.recruitment_start });
    new Deletion(store).deleteTask('task-1');
    expect(() => store.execute('DELETE FROM comparison_workspace_scope', [])).toThrow('immutable_workspace_scope');
    expect(() => store.execute("INSERT INTO flexible_workspace_scope VALUES (1,'real_experiment')", [])).toThrow('separate_store_required');
  } finally {
    store.close();
  }
});

test('reserved_real_store_rejects_missing_product_before_insert', () => {
  const store = new Store(':memory:');
  try {
    store.execute("INSERT INTO projects(id) VALUES ('real-project')", []);
    store.execute("INSERT INTO flexible_workspace_scope VALUES (1,'real_experiment')", []);
    expect(() =>
      store.execute("INSERT INTO tasks(id,project_id,state,metadata) VALUES ('bad','real-project','registered',?)", [JSON.stringify({ schema_version: 2 })])
    ).toThrow('real_store_required');
  } finally {
    store.close();
  }
});
