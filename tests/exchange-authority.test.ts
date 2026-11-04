import { expect, test } from 'vitest';
import { importExchangePackage } from '../src/exchange/import.js';
import { registerExchangeMapping } from '../src/exchange/mapping.js';
import { paired, receivedAt } from './helpers/exchange-import-fixture.js';
test('unmapped sender, changed protocol, wrong slot authority and mapping changes fail without mutation', () => {
  const { source, dest, pkg, mapping } = paired();
  try {
    expect(() => registerExchangeMapping(dest, { ...mapping, protocol_digest: '0'.repeat(64) })).toThrow('mapping_conflict');
    for (const candidate of [
      { ...pkg, namespace_id: '99999999-9999-4999-8999-999999999999' },
      { ...pkg, assignments: [{ ...pkg.assignments[0]!, allocator_id: 'rogue' }] },
      { ...pkg, protocol: { ...pkg.protocol, settings: { ...pkg.protocol.settings, followup_seconds: 7 } } }
    ])
      expect(() => importExchangePackage(dest, candidate, 'destination', () => receivedAt)).toThrow(/^(authority_conflict|protocol_conflict)$/);
    expect(dest.all('SELECT * FROM exchange_tasks')).toEqual([]);
    expect(dest.all('SELECT * FROM exchange_protocol_invalidations')).toEqual([]);
  } finally {
    source.close();
    dest.close();
  }
});

test('a pinned digest cannot admit configurations that could not freeze as a synthetic protocol', async () => {
  const { protocolDigest } = await import('../src/exchange/contracts.js');
  const { Store } = await import('../src/store.js');
  const f = paired();
  try {
    const mutations = [
      (p: typeof f.pkg) => {
        p.variants[0].product = 'codex';
        p.variants[1].product = 'codex';
      },
      (p: typeof f.pkg) => {
        p.variants[1].model = 'other-model';
      },
      (p: typeof f.pkg) => {
        p.variants[1].product_version = '2.0.0';
      },
      (p: typeof f.pkg) => {
        p.variants[1].reasoning_setting = 'high';
      },
      (p: typeof f.pkg) => {
        p.variants[1].policy_status = 'ineligible';
      },
      (p: typeof f.pkg) => {
        p.protocol.frozen_at = p.protocol.settings.recruitment_start;
      },
      (p: typeof f.pkg) => {
        p.protocol.settings.participants.push('uncovered-participant');
      }
    ];
    for (const mutate of mutations) {
      const pkg = structuredClone(f.pkg);
      mutate(pkg);
      const dest = new Store(':memory:');
      try {
        dest.execute("INSERT INTO projects(id) VALUES ('destination')", []);
        registerExchangeMapping(dest, { ...f.mapping, protocol_digest: protocolDigest(pkg) });
        expect(() => importExchangePackage(dest, pkg, 'destination', () => receivedAt)).toThrow(/^(protocol_conflict|real_experiment_disabled)$/);
        expect(dest.all('SELECT * FROM exchange_tasks')).toEqual([]);
      } finally {
        dest.close();
      }
    }
  } finally {
    f.source.close();
    f.dest.close();
  }
});
