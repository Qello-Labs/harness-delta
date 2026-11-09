import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { projectToolVersionPromotions, promotionProjectionDigest } from '../src/core/tool-version-promotion.js';
import { appendPromotionDecision } from './helpers/tool-version-promotion.js';
import { promotionRegistryFixture } from './helpers/tool-version-promotion-registry.js';
import { makeFlexibleFixture } from './helpers/flexible-fixture.js';

const live: {
  fixture: ReturnType<typeof promotionRegistryFixture> | null;
  projection: ReturnType<typeof projectToolVersionPromotions> | null;
} = vi.hoisted(() => ({ fixture: null, projection: null }));
vi.mock('../src/core/tool-version-profiles.json', async importOriginal => {
  const original = await importOriginal<{ default: unknown }>();
  return {
    get default() {
      return live.fixture?.registry.profiles ?? original.default;
    }
  };
});
vi.mock('../src/core/tool-version-recipes.json', async importOriginal => {
  const original = await importOriginal<{ default: unknown }>();
  return {
    get default() {
      return live.fixture?.registry.recipes ?? original.default;
    }
  };
});
vi.mock('../src/core/tool-version-identities.json', async importOriginal => {
  const original = await importOriginal<{ default: unknown }>();
  return {
    get default() {
      return live.fixture
        ? {
            readCeilings: { claudeProcessImage: 272984176 },
            entries: live.fixture.registry.identities
          }
        : original.default;
    }
  };
});
vi.mock('../src/core/tool-version-promotions.json', async importOriginal => {
  const original = await importOriginal<{ default: unknown }>();
  return {
    get default() {
      return live.fixture?.ledger ?? original.default;
    }
  };
});
vi.mock('../src/core/tool-version-promotion-result.json', async importOriginal => {
  const original = await importOriginal<{ default: unknown }>();
  return {
    get default() {
      return live.fixture && live.projection
        ? {
            schema_version: 1,
            implementation_scheme: 'promotion-implementation-v1',
            implementation_digest: live.fixture.implementationDigest,
            effective_projection_digest: promotionProjectionDigest(live.projection)
          }
        : original.default;
    }
  };
});
beforeEach(() => {
  live.fixture = null;
  live.projection = null;
  vi.resetModules();
});
async function loadFixture(fixture: ReturnType<typeof promotionRegistryFixture>) {
  const projection = projectToolVersionPromotions(fixture);
  live.fixture = fixture;
  live.projection = projection;
  vi.resetModules();
  const [codex, claude, readiness, compatibility, core] = await Promise.all([
    import('../src/codex-binding-admission.js'),
    import('../src/claude-binding-admission.js'),
    import('../src/readiness.js'),
    import('../src/source-compatibility.js'),
    import('../src/core/tool-version-profiles.js')
  ]);
  expect(core.promotedToolVersionDescriptors).toEqual(fixture.descriptors);
  expect(core.toolVersionPromotionProjection).toEqual(projection);
  return { codex, claude, readiness, compatibility, core };
}
afterEach(() => {
  live.fixture = null;
  live.projection = null;
  vi.resetModules();
});

test.each(['codex', 'claude_code'] as const)('a pending %s descriptor is absent from every effective use projection', async product => {
  const fixture = promotionRegistryFixture(product);
  const descriptor = fixture.descriptors[0];
  if (!descriptor) throw new Error('synthetic_descriptor_required');
  const { codex, claude, readiness, compatibility } = await loadFixture(fixture);
  expect(codex.getEffectiveCodexBindingAdmission(descriptor.version)).toBeUndefined();
  expect(claude.getEffectiveClaudeBindingAdmission(descriptor.version)).toBeUndefined();
  expect(claude.getEffectiveClaudeExactImages().some(image => image.productVersion === descriptor.version)).toBe(false);
  expect(readiness.productionSourceEvidence.some(evidence => evidence.product_version === descriptor.version)).toBe(false);
  expect(compatibility.resolveSourceCompatibility(product, descriptor.version, descriptor.route, descriptor.profileId)).toBeNull();
  expect(codex.defaultCodexBindingVersion).toBe('0.163.0');
  expect(claude.defaultClaudeBindingVersion).toBe('2.1.306');
});

test.each(['codex', 'claude_code'] as const)('a %s collect grant remains root-only and unqualified', async product => {
  const fixture = promotionRegistryFixture(product);
  appendPromotionDecision(fixture);
  const descriptor = fixture.descriptors[0];
  if (!descriptor) throw new Error('synthetic_descriptor_required');
  const { codex, claude, readiness, compatibility } = await loadFixture(fixture);
  const get = product === 'codex' ? codex.getEffectiveCodexBindingAdmission : claude.getEffectiveClaudeBindingAdmission;
  expect(get(descriptor.version)).toMatchObject({
    kind: 'promoted',
    qualified: false,
    maxDepth: 0,
    maxFamilyMembers: 1
  });
  expect(get(descriptor.version, 'link', 'root')).toBeUndefined();
  expect(get(descriptor.version, 'collect', 'bounded_family')).toBeUndefined();
  expect(readiness.productionSourceEvidence.some(evidence => evidence.product_version === descriptor.version)).toBe(false);
  expect(compatibility.resolveSourceCompatibility(product, descriptor.version, descriptor.route, descriptor.profileId)?.state).toBe('compatibility_unverified');
  expect(compatibility.resolveSourceCompatibility(product, descriptor.version, descriptor.route, descriptor.profileId, 'link', 'root')).toBeNull();
  expect(codex.codexBindingAdmissions.some(admission => admission.productVersion === descriptor.version)).toBe(false);
  expect(claude.claudeBindingAdmissions.some(admission => admission.productVersion === descriptor.version)).toBe(false);
});

test.each(['codex', 'claude_code'] as const)('a qualified %s root grant has only its exact scoped support evidence', async product => {
  const fixture = promotionRegistryFixture(product);
  appendPromotionDecision(fixture, {
    grants: ['admission', 'qualification']
  });
  const descriptor = fixture.descriptors[0];
  if (!descriptor) throw new Error('synthetic_descriptor_required');
  const { codex, claude, readiness, compatibility } = await loadFixture(fixture);
  const get = product === 'codex' ? codex.getEffectiveCodexBindingAdmission : claude.getEffectiveClaudeBindingAdmission;
  expect(get(descriptor.version)?.qualified).toBe(true);
  expect(
    compatibility.resolveSourceCompatibility(product, descriptor.version, product === 'codex' ? 'codex_workflow' : 'claude_workflow', descriptor.profileId)
  ).toBeNull();
  expect(get(descriptor.version, 'collect', 'bounded_family')).toBeUndefined();
  expect(readiness.productionSourceEvidence.filter(evidence => evidence.product_version === descriptor.version)).toEqual([
    expect.objectContaining({
      product,
      product_version: descriptor.version,
      profile_id: descriptor.profileId,
      semantics_digest: descriptor.qualificationClaims.semanticsDigest,
      complete_cost: false
    })
  ]);
  expect(compatibility.resolveSourceCompatibility(product, descriptor.version, descriptor.route, descriptor.profileId)?.state).toBe('verified');
});

test.each(['codex', 'claude_code'] as const)('a denied %s descriptor cannot remain an image, admission or support fact', async product => {
  const fixture = promotionRegistryFixture(product);
  appendPromotionDecision(fixture, {
    grants: ['admission', 'qualification']
  });
  appendPromotionDecision(fixture, {
    decision: 'revoke',
    reason: 'authority_withdrawn',
    grants: []
  });
  const descriptor = fixture.descriptors[0];
  if (!descriptor) throw new Error('synthetic_descriptor_required');
  const { codex, claude, readiness, compatibility } = await loadFixture(fixture);
  expect(codex.getEffectiveCodexBindingAdmission(descriptor.version)).toBeUndefined();
  expect(claude.getEffectiveClaudeBindingAdmission(descriptor.version)).toBeUndefined();
  expect(claude.getEffectiveClaudeExactImages().some(image => image.productVersion === descriptor.version)).toBe(false);
  expect(readiness.productionSourceEvidence.some(evidence => evidence.product_version === descriptor.version)).toBe(false);
  expect(compatibility.resolveSourceCompatibility(product, descriptor.version, descriptor.route, descriptor.profileId)).toBeNull();
});

function readinessRequest(fixture: ReturnType<typeof promotionRegistryFixture>, ids: string[]) {
  const descriptor = fixture.descriptors[0];
  if (!descriptor) throw new Error('synthetic_descriptor_required');
  const { minimum_effect, quality_margin, confidence_level, ...base } = makeFlexibleFixture().protocol;
  void minimum_effect;
  void quality_margin;
  void confidence_level;
  return {
    protocol: {
      ...base,
      purpose: 'functional_pilot' as const,
      source_profiles: [{ product: descriptor.product, product_version: descriptor.version, profile_id: descriptor.profileId }]
    },
    source_evidence_ids: ids,
    coverage: [],
    analysis_evidence_id: null,
    invalidated: false,
    followup_complete: true
  };
}

test.each(['link-only', 'foreign-runtime', 'withdrawn', 'qualified'] as const)(
  'collection readiness requires its own current qualified facet: %s',
  async scenario => {
    const fixture = promotionRegistryFixture('claude_code');
    const descriptor = fixture.descriptors[0];
    if (!descriptor) throw new Error('synthetic_descriptor_required');
    const current = {
      target: { version: descriptor.version, commit: descriptor.sourceRef },
      lane: {
        product: descriptor.product,
        route: descriptor.route,
        profile_id: descriptor.profileId,
        operation: 'collect' as const,
        topology: 'root' as const
      },
      platform: 'darwin_arm64' as const,
      runtime: Number(process.versions.node.split('.')[0]) === 24 ? ('node24' as const) : ('node26' as const)
    };
    const link = { ...current, lane: { ...current.lane, operation: 'link' as const } };
    switch (scenario) {
      case 'link-only':
        appendPromotionDecision(fixture, { scope: link, grants: ['admission', 'qualification'] });
        break;
      case 'foreign-runtime':
        appendPromotionDecision(fixture, { scope: current });
        appendPromotionDecision(fixture, {
          scope: { ...current, runtime: current.runtime === 'node26' ? 'node24' : 'node26' },
          grants: ['admission', 'qualification']
        });
        break;
      case 'withdrawn':
        appendPromotionDecision(fixture, { scope: current, grants: ['admission', 'qualification'] });
        appendPromotionDecision(fixture, { scope: link, grants: ['admission', 'qualification'] });
        appendPromotionDecision(fixture, { scope: current, grants: ['admission'] });
        break;
      case 'qualified':
        appendPromotionDecision(fixture, { scope: current, grants: ['admission', 'qualification'] });
        break;
    }
    const { readiness } = await loadFixture(fixture);
    const evidence = readiness.productionSourceEvidence.filter(row => row.product_version === descriptor.version);
    expect(
      readiness.evaluateReadiness(
        readinessRequest(
          fixture,
          evidence.map(row => row.id)
        )
      ).real_allocation
    ).toBe(scenario === 'qualified');
    if (scenario === 'qualified') {
      expect(evidence).toEqual([expect.objectContaining({ validation_kind: 'real_operations', scope: current })]);
    } else {
      expect(evidence).toEqual([]);
    }
  }
);

test('readiness selection refuses withdrawn collection qualification while link remains qualified', async () => {
  const fixture = promotionRegistryFixture('claude_code');
  const collect = appendPromotionDecision(fixture, { grants: ['admission', 'qualification'] });
  appendPromotionDecision(fixture, {
    scope: { ...collect.decision.scope, lane: { ...collect.decision.scope.lane, operation: 'link' } },
    grants: ['admission', 'qualification']
  });
  const { readiness, core } = await loadFixture(fixture);
  const descriptor = fixture.descriptors[0];
  if (!descriptor) throw new Error('synthetic_descriptor_required');
  const evidence = readiness.productionSourceEvidence.filter(row => row.product_version === descriptor.version);
  const request = readinessRequest(
    fixture,
    evidence.map(row => row.id)
  );
  expect(readiness.evaluateReadiness(request).real_allocation).toBe(true);
  Object.defineProperty(core.toolVersionPromotionProjection, 'facets', {
    configurable: true,
    get: () => projectToolVersionPromotions(fixture).facets
  });
  appendPromotionDecision(fixture, { grants: ['admission'] });
  expect(readiness.evaluateReadiness(request).real_allocation).toBe(false);
});
