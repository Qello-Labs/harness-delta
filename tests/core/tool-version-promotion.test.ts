import { expect, test } from 'vitest';
import type { PromotionDecision } from '../../scripts/tool-update/promotion-records.mjs';
import { digest } from '../../scripts/tool-update/manifest.mjs';
import { parsePromotionDecision } from '../../scripts/tool-update/promotion-records.mjs';
import {
  parseToolVersionPromotionDescriptor,
  previewToolVersionPromotion,
  projectToolVersionPromotions,
  promotionDecisionDigest,
  promotionDescriptorDigest,
  promotionProjectionDigest
} from '../../src/core/tool-version-promotion.js';
import { appendPromotionDecision, promotionFixture } from '../helpers/tool-version-promotion.js';

function descriptorOf(fixture = promotionFixture()) {
  const descriptor = fixture.descriptors[0];
  if (!descriptor) throw new Error('synthetic_descriptor_required');
  return descriptor;
}

test('a self-consistent projection cannot authorize a grant outside the requested subset', () => {
  const fixture = promotionFixture();
  const record = appendPromotionDecision(fixture);
  const projection = projectToolVersionPromotions(fixture);
  const requested_grants: PromotionDecision['requested_grants'] = ['qualification'];
  const forgedProjection = {
    ...projection,
    facets: projection.facets.map(facet => ({
      ...facet,
      decision: { ...facet.decision, requested_grants }
    }))
  };
  const decision = {
    ...record.decision,
    requested_grants,
    effective_projection_digest: promotionProjectionDigest(forgedProjection)
  };
  expect(() =>
    projectToolVersionPromotions({
      ...fixture,
      ledger: {
        schema_version: 1,
        records: [{ id: digest(decision), decision }]
      }
    })
  ).toThrow('tool_version_promotion_invalid');
});
test.each(['codex', 'claude_code'] as const)('a pending %s descriptor grants no facet', product => {
  const fixture = promotionFixture(product);
  expect(projectToolVersionPromotions(fixture)).toEqual({
    schema_version: 1,
    registry_digest: fixture.registryDigest,
    implementation_digest: fixture.implementationDigest,
    facets: [],
    denials: []
  });
});

test('descriptor hashes use the portable canonical scheme and bind semantic definitions', () => {
  const descriptor = descriptorOf();
  expect(promotionDescriptorDigest(descriptor)).toBe(digest(descriptor));
  expect(promotionDescriptorDigest({ ...descriptor, sourceRef: 'f'.repeat(40) })).not.toBe(promotionDescriptorDigest(descriptor));
  expect(promotionDescriptorDigest({ ...descriptor, model: 'gpt-synthetic' })).not.toBe(promotionDescriptorDigest(descriptor));
});

test.each([
  { schemaVersion: 2 },
  { state: 'admitted' },
  { version: '0.170.0' },
  { route: 'claude_binding' },
  {
    variants: {
      parser: 'future',
      history: 'future',
      finality: 'future',
      identity: 'future'
    }
  },
  {
    scopes: [
      {
        operation: 'collect',
        topology: 'root',
        maxDepth: 1,
        maxFamilyMembers: 3,
        grants: ['admission']
      }
    ]
  },
  {
    scopes: [
      {
        operation: 'collect',
        topology: 'root',
        maxDepth: 0,
        maxFamilyMembers: 1,
        grants: ['admission', 'children']
      }
    ]
  }
])('unknown or unsupported descriptor authority fails closed %#', changes => {
  expect(() =>
    parseToolVersionPromotionDescriptor({
      ...descriptorOf(),
      ...changes
    })
  ).toThrow();
});

test('a valid P1 decision grants exactly its root operation, with no qualification or child authority', () => {
  const fixture = promotionFixture();
  const record = appendPromotionDecision(fixture);
  expect(parsePromotionDecision(record.decision)).toEqual(record.decision);
  expect(record.id).toBe(digest(record.decision));
  const projection = projectToolVersionPromotions(fixture);
  expect(projection.facets).toHaveLength(1);
  expect(projection.facets[0]?.decision.grants).toEqual(['admission']);
  expect(projection.facets[0]?.decision.scope.lane).toEqual({
    product: 'codex',
    route: 'codex_binding',
    profile_id: 'codex-binding-01690-direct-family-v1',
    operation: 'collect',
    topology: 'root'
  });
  expect(projection.denials).toEqual([]);
  expect(promotionProjectionDigest(projection)).toBe(record.decision.effective_projection_digest);
});

test('root and child grants are separate scopes rather than version-wide authority', () => {
  const fixture = promotionFixture();
  const root = appendPromotionDecision(fixture);
  const scope = {
    ...root.decision.scope,
    lane: {
      ...root.decision.scope.lane,
      topology: 'bounded_family' as const
    }
  };
  appendPromotionDecision(fixture, {
    scope,
    proposed_scope: scope,
    requested_grants: ['admission', 'children'],
    grants: ['admission', 'children']
  });
  expect(projectToolVersionPromotions(fixture).facets.map(row => row.decision.scope.lane.topology)).toEqual(['bounded_family', 'root']);
});

test.each([
  { schema_version: 2 },
  { decision: 'future_deny' },
  { implementation_scheme: 'future' },
  { implementation_digest: 'f'.repeat(64) },
  { descriptor_digest: 'f'.repeat(64) },
  { registry_before_digest: 'f'.repeat(64) },
  { effective_projection_digest: 'f'.repeat(64) },
  { sequence: 2 },
  { grants: ['admission', 'children'] },
  { requested_grants: ['qualification'] },
  { timestamp: '2099-01-01T00:00:00Z' }
])('invalid decision or projection identity is never skipped %#', changes => {
  const fixture = promotionFixture();
  const record = appendPromotionDecision(fixture);
  const decision = { ...record.decision, ...changes };
  const ledger = {
    schema_version: 1,
    records: [{ id: digest(decision), decision }]
  };
  expect(() => projectToolVersionPromotions({ ...fixture, ledger })).toThrow();
});

test('decision content IDs and duplicate records are checked before granting', () => {
  const fixture = promotionFixture();
  const record = appendPromotionDecision(fixture);
  expect(() =>
    projectToolVersionPromotions({
      ...fixture,
      ledger: {
        schema_version: 1,
        records: [{ ...record, id: 'f'.repeat(64) }]
      }
    })
  ).toThrow();
  expect(() =>
    projectToolVersionPromotions({
      ...fixture,
      ledger: { schema_version: 1, records: [record, record] }
    })
  ).toThrow();
});

test('successors require the actual latest predecessor and reject forks', () => {
  const fixture = promotionFixture();
  const first = appendPromotionDecision(fixture);
  appendPromotionDecision(fixture, {
    grants: ['admission', 'qualification']
  });
  const current = fixture.ledger.records[1];
  if (!current) throw new Error('synthetic_successor_required');
  const decision = {
    ...current.decision,
    predecessor: {
      id: 'f'.repeat(64),
      sequence: 1,
      decision: 'approve' as const
    }
  };
  expect(() =>
    projectToolVersionPromotions({
      ...fixture,
      ledger: {
        schema_version: 1,
        records: [first, { id: digest(decision), decision }]
      }
    })
  ).toThrow();
  expect(() =>
    projectToolVersionPromotions({
      ...fixture,
      ledger: { schema_version: 1, records: [current, first] }
    })
  ).toThrow();
});

test.each([
  ['retire', 'maintenance_ended'],
  ['revoke', 'authority_withdrawn'],
  ['invalidate', 'confirmed_incompatibility'],
  ['delete', 'authority_deleted']
] as const)('%s removes current authority and preserves a non-bypassable denial', (decision, reason) => {
  const fixture = promotionFixture();
  appendPromotionDecision(fixture, {
    grants: ['admission', 'qualification']
  });
  appendPromotionDecision(fixture, { decision, reason, grants: [] });
  const projection = projectToolVersionPromotions(fixture);
  expect(projection.facets).toEqual([]);
  expect(projection.denials.map(row => row.decision.decision)).toEqual([decision]);
  expect(() => appendPromotionDecision(fixture)).toThrow();
});

test('demotion can retain only a subset of the prior grant', () => {
  const fixture = promotionFixture();
  appendPromotionDecision(fixture, {
    grants: ['admission', 'qualification']
  });
  appendPromotionDecision(fixture, {
    decision: 'demote',
    reason: 'qualification_withdrawn',
    grants: ['admission']
  });
  const projection = projectToolVersionPromotions(fixture);
  expect(projection.facets.map(row => row.decision.grants)).toEqual([['admission']]);
  expect(projection.denials.map(row => row.decision.decision)).toEqual(['demote']);
});

test('a descriptor replacement cannot escape an existing scope denial', () => {
  const fixture = promotionFixture();
  appendPromotionDecision(fixture);
  appendPromotionDecision(fixture, {
    decision: 'revoke',
    reason: 'authority_withdrawn',
    grants: []
  });
  const descriptors = fixture.descriptors.map(descriptor => ({
    ...descriptor,
    sourceRef: 'f'.repeat(40)
  }));
  expect(() => projectToolVersionPromotions({ ...fixture, descriptors })).toThrow();
});

test('prospective hashing excludes self-referential fields but binds evidence and authority references', () => {
  const fixture = promotionFixture();
  const before = projectToolVersionPromotions(fixture);
  const record = appendPromotionDecision(fixture);
  const { registry_before_digest, effective_projection_digest, ...payload } = record.decision;
  expect(registry_before_digest).toBe(promotionProjectionDigest(before));
  const after = previewToolVersionPromotion(before, descriptorOf(fixture), payload);
  expect(promotionProjectionDigest(after)).toBe(effective_projection_digest);
  expect(promotionProjectionDigest(after)).not.toBe(
    promotionProjectionDigest(
      previewToolVersionPromotion(before, descriptorOf(fixture), {
        ...payload,
        authorization_reference_ids: ['e'.repeat(64)]
      })
    )
  );
  expect(promotionProjectionDigest(after)).not.toBe(
    promotionProjectionDigest(
      previewToolVersionPromotion(before, descriptorOf(fixture), {
        ...payload,
        accepted_validation_ids: ['e'.repeat(64)]
      })
    )
  );
  expect(promotionDecisionDigest(record.decision)).toBe(record.id);
});
