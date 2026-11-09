import { expect, test } from 'vitest';
import { ExchangePackageSchema, FlexibleDataPackageSchema, parseExchangePackage } from '../../src/comparison/exchange/contracts.js';
import { buildExchangePackage, registerExchangeSource } from '../../src/comparison/exchange/source.js';
import { assignTask } from '../../src/comparison/allocation.js';
import { createComparisonSnapshot } from '../../src/comparison/reports/comparison-snapshot.js';
import { Store } from '../../src/store.js';
import { seedFlexibleComparison } from '../helpers/flexible-store.js';
import { freshSource, assignAndSnapshot, dataPackage, exportTime, packageId, sourceConfig } from '../helpers/exchange-fixture.js';

test('strict sharing schema rejects private nested fields and unsafe counters without echoes', () => {
  const store = freshSource();
  try {
    assignAndSnapshot(store);
    const pkg = dataPackage(store);
    if (pkg.kind !== 'assignment_metadata') throw new Error('wrong_kind');
    expect(parseExchangePackage(pkg)).toEqual(pkg);
    for (const mutation of [
      { ...pkg, source_path: 'PRIVATE_SENTINEL' },
      { ...pkg, schema_version: 2 },
      { ...pkg, assignments: [{ ...pkg.assignments[0], evidence: { ...pkg.assignments[0]!.evidence, prompt: 'PRIVATE_SENTINEL' } }] },
      { ...pkg, assignments: [{ ...pkg.assignments[0], allocation_index: Number.MAX_SAFE_INTEGER + 1 }] },
      { ...pkg, assignments: Array.from({ length: 10001 }, () => pkg.assignments[0]) }
    ])
      expect(() => parseExchangePackage(mutation)).toThrow(/^(invalid_exchange_package|unsupported_exchange_version|exchange_limit_exceeded)$/);
  } finally {
    store.close();
  }
});

test('duplicate records, unbounded criteria and reversed protocol windows are invalid sharing metadata', () => {
  const store = freshSource();
  try {
    assignAndSnapshot(store);
    const pkg = dataPackage(store);
    if (pkg.kind !== 'assignment_metadata') throw new Error('wrong_kind');
    for (const candidate of [
      { ...pkg, assignments: [pkg.assignments[0], pkg.assignments[0]] },
      { ...pkg, authority: [pkg.authority[0], pkg.authority[0]] },
      {
        ...pkg,
        assignments: [
          { ...pkg.assignments[0]!, metadata: { ...pkg.assignments[0]!.metadata, criterion_ids: Array.from({ length: 10001 }, (_, i) => `criterion-${i}`) } }
        ]
      },
      { ...pkg, protocol: { ...pkg.protocol, settings: { ...pkg.protocol.settings, recruitment_end: '2025-01-01T00:00:00Z' } } }
    ])
      expect(() => parseExchangePackage(candidate)).toThrow('invalid_exchange_package');
  } finally {
    store.close();
  }
});

test('sharing rejects duplicate variant definitions and conflicting identity keys', () => {
  const store = freshSource();
  try {
    assignAndSnapshot(store);
    const pkg = dataPackage(store);
    if (pkg.kind !== 'assignment_metadata') throw new Error('wrong_kind');
    expect(() => parseExchangePackage({ ...pkg, variants: [pkg.variants[0], pkg.variants[0]] })).toThrow('invalid_exchange_package');
    expect(() => parseExchangePackage({ ...pkg, assignments: [{ ...pkg.assignments[0]!, alias_ids: [pkg.assignments[0]!.logical_task_id] }] })).toThrow(
      'invalid_exchange_package'
    );
  } finally {
    store.close();
  }
});

test.each([1, 2])('schema %i rejects promotion authority at root and nested package boundaries', schemaVersion => {
  const store = schemaVersion === 1 ? freshSource() : new Store(':memory:');
  try {
    if (schemaVersion === 1) assignAndSnapshot(store);
    else {
      const f = seedFlexibleComparison(store);
      registerExchangeSource(store, {
        ...sourceConfig,
        owned_strata: f.protocol.strata.map(s => s.id)
      });
      assignTask(store, f.input, {
        clock: () => f.protocol.recruitment_start,
        shuffle: a => a
      });
      createComparisonSnapshot(
        store,
        {
          reportId: 'report-1',
          protocolId: f.protocol.id,
          cutoff: '2026-01-03T00:00:00Z',
          revisionReason: 'initial'
        },
        () => '2026-01-04T00:00:00Z'
      );
    }
    const pkg = buildExchangePackage(
      store,
      {
        kind: 'assignment_metadata',
        protocolId: sourceConfig.protocol_id,
        snapshotId: 'report-1',
        packageId
      },
      () => exportTime
    );
    if (pkg.kind !== 'assignment_metadata') {
      throw new Error('wrong_kind');
    }
    const schema = schemaVersion === 1 ? ExchangePackageSchema : FlexibleDataPackageSchema;
    expect(schema.safeParse(pkg).success).toBe(true);
    expect(parseExchangePackage(pkg)).toEqual(pkg);
    const assignment = pkg.assignments[0];
    if (!assignment) throw new Error('missing_assignment');
    const promotion = {
      promotion_authority: {
        decision: 'approve',
        prior_deny_ids: []
      }
    };
    for (const candidate of [
      { ...pkg, ...promotion },
      {
        ...pkg,
        promotion_decision: {
          kind: 'promotion_decision',
          decision: 'approve'
        }
      },
      { ...pkg, promotion_grants: [{ operation: 'collect' }] },
      { ...pkg, promotion_denials: [] },
      { ...pkg, promotion_origins: [] },
      {
        ...pkg,
        authority: pkg.authority.map(a => ({
          ...a,
          ...promotion
        }))
      },
      { ...pkg, protocol: { ...pkg.protocol, ...promotion } },
      {
        ...pkg,
        protocol: {
          ...pkg.protocol,
          settings: {
            ...pkg.protocol.settings,
            ...promotion
          }
        }
      },
      {
        ...pkg,
        variants: pkg.variants.map(v => ({
          ...v,
          ...promotion
        }))
      },
      { ...pkg, assignments: [{ ...assignment, ...promotion }] },
      {
        ...pkg,
        assignments: [
          {
            ...assignment,
            metadata: {
              ...assignment.metadata,
              ...promotion
            }
          }
        ]
      },
      {
        ...pkg,
        assignments: [
          {
            ...assignment,
            evidence: {
              ...assignment.evidence,
              ...promotion
            }
          }
        ]
      }
    ]) {
      expect(schema.safeParse(candidate).success).toBe(false);
      expect(() => parseExchangePackage(candidate)).toThrow('invalid_exchange_package');
    }
  } finally {
    store.close();
  }
});

test('deletion packages cannot carry promotion decisions or reinterpret tombstones as promotion authority', () => {
  const store = freshSource();
  try {
    assignAndSnapshot(store);
    const pkg = dataPackage(store);
    const deletion = {
      schema_version: 1,
      kind: 'deletion_metadata',
      package_id: pkg.package_id,
      namespace_id: pkg.namespace_id,
      shared_project_id: pkg.shared_project_id,
      export_revision: pkg.export_revision,
      produced_at: pkg.produced_at,
      tombstones: [
        {
          kind: 'project',
          target_id: pkg.shared_project_id,
          reason: 'deletion',
          invalidated_at: pkg.produced_at
        }
      ]
    };
    expect(ExchangePackageSchema.safeParse(deletion).success).toBe(true);
    for (const candidate of [
      {
        ...deletion,
        promotion_decision: {
          decision: 'approve',
          prior_deny_ids: []
        }
      },
      {
        ...deletion,
        tombstones: deletion.tombstones.map(t => ({
          ...t,
          promotion_denials: []
        }))
      }
    ]) {
      expect(ExchangePackageSchema.safeParse(candidate).success).toBe(false);
      expect(() => parseExchangePackage(candidate)).toThrow('invalid_exchange_package');
    }
  } finally {
    store.close();
  }
});
