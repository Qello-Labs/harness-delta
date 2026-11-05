import { expect, test } from 'vitest';
import { parseExchangePackage } from '../../src/comparison/exchange/contracts.js';
import { freshSource, assignAndSnapshot, dataPackage } from '../helpers/exchange-fixture.js';

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
