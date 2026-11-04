import { expect, test } from 'vitest';
import { importExchangePackage } from '../../src/comparison/exchange/import.js';
import { paired, receivedAt } from '../helpers/exchange-import-fixture.js';
test('same payload replay leaves exactly one imported task and no source assignments or allocation state', () => {
  const { source, dest, pkg } = paired();
  try {
    expect(importExchangePackage(dest, pkg, 'destination', () => receivedAt).status).toBe('imported');
    expect(importExchangePackage(dest, pkg, 'destination', () => receivedAt).status).toBe('replayed');
    expect(dest.all('SELECT * FROM exchange_tasks')).toHaveLength(1);
    for (const table of ['tasks', 'sessions', 'events', 'comparison_assignments', 'comparison_allocation_state'])
      expect(dest.all(`SELECT * FROM ${table}`)).toEqual([]);
    expect(() => importExchangePackage(dest, { ...pkg, produced_at: '2026-01-04T02:00:00Z' }, 'destination', () => receivedAt)).toThrow('package_conflict');
    expect(dest.all('SELECT * FROM exchange_tasks')).toHaveLength(1);
  } finally {
    source.close();
    dest.close();
  }
});
test('higher revision replaces a contribution but cannot rewrite original assignment or omit prior tasks', () => {
  const { source, dest, pkg } = paired();
  try {
    importExchangePackage(dest, pkg, 'destination', () => receivedAt);
    const next = { ...pkg, package_id: '66666666-6666-4666-8666-666666666666', export_revision: 2 };
    expect(importExchangePackage(dest, next, 'destination', () => receivedAt).status).toBe('imported');
    expect(dest.all('SELECT * FROM exchange_tasks')).toHaveLength(1);
    expect(() =>
      importExchangePackage(
        dest,
        { ...next, package_id: '77777777-7777-4777-8777-777777777777', export_revision: 3, assignments: [] },
        'destination',
        () => receivedAt
      )
    ).toThrow('evidence_conflict');
    const conflict = {
      ...next,
      package_id: '88888888-8888-4888-8888-888888888888',
      export_revision: 3,
      assignments: [{ ...pkg.assignments[0]!, original_variant_id: 'variant-b' }]
    };
    expect(importExchangePackage(dest, conflict, 'destination', () => receivedAt)).toMatchObject({
      status: 'conflict_recorded',
      reason: 'assignment_conflict'
    });
    expect(dest.all('SELECT * FROM exchange_tasks')).toEqual([]);
  } finally {
    source.close();
    dest.close();
  }
});
test('failure inserting receipt rolls back imported identities, rows and revisions', () => {
  const { source, dest, pkg } = paired();
  try {
    dest.execute("CREATE TRIGGER fail_receipt BEFORE INSERT ON exchange_import_receipts BEGIN SELECT RAISE(ABORT,'forced_failure'); END", []);
    expect(() => importExchangePackage(dest, pkg, 'destination', () => receivedAt)).toThrow();
    for (const table of ['exchange_tasks', 'exchange_identity_keys', 'exchange_import_revisions']) expect(dest.all(`SELECT * FROM ${table}`)).toEqual([]);
  } finally {
    source.close();
    dest.close();
  }
});

test('the same snapshot sequence cannot introduce changed evidence', () => {
  const { source, dest, pkg } = paired();
  try {
    importExchangePackage(dest, pkg, 'destination', () => receivedAt);
    const next = structuredClone(pkg);
    next.package_id = '66666666-6666-4666-8666-666666666666';
    next.export_revision++;
    next.assignments[0]!.evidence.actual_configuration.has_unknown_runtime = false;
    expect(() => importExchangePackage(dest, next, 'destination', () => receivedAt)).toThrow('evidence_conflict');
  } finally {
    source.close();
    dest.close();
  }
});

test('canonical replay ignores order of identity-keyed protocol arrays', () => {
  const { source, dest, pkg } = paired();
  try {
    importExchangePackage(dest, pkg, 'destination', () => receivedAt);
    const reordered = structuredClone(pkg);
    reordered.protocol.settings.participants.reverse();
    reordered.protocol.settings.environment_ids.reverse();
    reordered.protocol.settings.strata[0]!.assignees.reverse();
    expect(importExchangePackage(dest, reordered, 'destination', () => receivedAt).status).toBe('replayed');
  } finally {
    source.close();
    dest.close();
  }
});
