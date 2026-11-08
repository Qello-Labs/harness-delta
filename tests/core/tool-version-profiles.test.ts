import { expect, test } from 'vitest';
import profileData from '../../src/core/tool-version-profiles.json' with { type: 'json' };
import recipeData from '../../src/core/tool-version-recipes.json' with { type: 'json' };
import identityData from '../../src/core/tool-version-identities.json' with { type: 'json' };
import {
  legacyClaudeBindingAdmissions,
  legacyClaudeTranscriptProfiles,
  legacyCodexBindingAdmissions,
  lookupToolVersionProfile,
  parseToolVersionRegistry,
  toolVersionIdentity,
  toolVersionReadCeilings,
  toolVersionRecipe
} from '../../src/core/tool-version-profiles.js';
import { codexBindingAdmissions } from '../../src/codex-binding-admission.js';
import { claudeBindingAdmissions } from '../../src/claude-binding-admission.js';
import { codex01580Candidate } from '../../scripts/conformance/candidate.js';
import { claudeBindingProfiles, ClaudeSessionBindingProvider } from '../../src/session-binding-claude.js';
import { promotionRegistryFixture } from '../helpers/tool-version-promotion-registry.js';

const unregistered = {
  product: 'codex',
  version: '9.1.1',
  exportOrder: {},
  qualificationRecipes: [],
  assessmentScopes: [],
  evidenceRefs: [],
  qualificationReader: { mode: 'not_registered' },
  externalTicket: { mode: 'not_registered' }
};
const registry = () => ({
  profiles: profileData,
  recipes: recipeData,
  identities: identityData.entries
});

test.each([
  { ...unregistered, version: '09.1.1' },
  { ...unregistered, ordinaryWindow: { upper: '9.2.0' } },
  {
    ...unregistered,
    transcriptProfile: {
      status: 'candidate',
      evidence: 'synthetic',
      finalityVariant: 'claude_candidate_quiescence_v1',
      legacyDefault: false
    }
  },
  { ...unregistered, qualificationReader: { mode: 'future_reader' } },
  {
    ...unregistered,
    file: {
      status: 'registered',
      profileId: 'claude-file-message-components-v1',
      parserVariant: 'claude_message_components_v1'
    }
  },
  { ...unregistered, qualificationRecipes: ['not-a-recipe'] }
])('rejects invalid or cross-product declaration %# at the registry boundary', profile => {
  expect(() =>
    parseToolVersionRegistry({
      profiles: [profile],
      recipes: [],
      identities: []
    })
  ).toThrow();
});

test('rejects duplicate exact keys instead of selecting an arbitrary admission', () => {
  expect(() =>
    parseToolVersionRegistry({
      profiles: [unregistered, unregistered],
      recipes: [],
      identities: []
    })
  ).toThrow('tool_version_registry_invalid');
});

test('rejects unknown recipe variants before their constraints can be consumed', () => {
  expect(() =>
    parseToolVersionRegistry({
      ...registry(),
      recipes: recipeData.map((recipe, index) => (index === 0 ? { ...recipe, kind: 'future_recipe' } : recipe))
    })
  ).toThrow();
});

test('rejects missing and wrong-owner native identities', () => {
  const admission = lookupToolVersionProfile('claude_code', '2.1.306')?.ordinaryBinding;
  if (!admission || !('imageIdentity' in admission)) {
    throw new Error('missing_fixture_admission');
  }
  const original = toolVersionIdentity(admission.imageIdentity);
  for (const replacement of [
    undefined,
    { ...original, product: 'codex' },
    {
      ...original,
      version: '2.1.301'
    }
  ]) {
    const identities = identityData.entries.filter(identity => identity.id !== original.id);
    expect(() =>
      parseToolVersionRegistry({
        ...registry(),
        identities: replacement ? [...identities, replacement] : identities
      })
    ).toThrow('tool_version_registry_invalid');
  }
});

test.each(['duplicate', 'exact-size', 'image-conflict'] as const)('rejects inconsistent %s artifact constraints', mode => {
  const original = toolVersionIdentity('claude-2.1.306-ordinary-image');
  const extra =
    mode === 'duplicate'
      ? original
      : mode === 'exact-size'
        ? {
            ...original,
            id: 'oversized',
            exactSizeMode: 'always',
            maxBytes: 272984176,
            exactBytes: 272984177
          }
        : { ...original, id: 'conflicting', sha256: '0'.repeat(64) };
  expect(() =>
    parseToolVersionRegistry({
      ...registry(),
      identities: [...identityData.entries, extra]
    })
  ).toThrow('tool_version_registry_invalid');
});

test('legacy admission projections preserve serialized order and historical omissions', () => {
  expect(legacyCodexBindingAdmissions().map(admission => JSON.stringify(admission))).toEqual(
    codexBindingAdmissions.map(admission => JSON.stringify(admission))
  );
  expect(legacyClaudeBindingAdmissions().map(admission => JSON.stringify(admission))).toEqual(
    claudeBindingAdmissions.map(admission => JSON.stringify(admission))
  );
  expect(legacyClaudeTranscriptProfiles()).toEqual(claudeBindingProfiles);
});

test.each(['codex', 'claude_code'] as const)('a pending %s descriptor is parsed separately from every historical registration', product => {
  const fixture = promotionRegistryFixture(product);
  const parsed = parseToolVersionRegistry(fixture.registry);
  expect(parsed.profiles).toEqual(profileData);
  expect(parsed.promotedDescriptors).toEqual(fixture.descriptors);
  expect(parsed.profiles.some(profile => profile.version === fixture.descriptors[0]?.version)).toBe(false);
});

test('pending descriptors cannot alias a historical exact key or reference another owner', () => {
  const fixture = promotionRegistryFixture();
  const descriptor = fixture.descriptors[0];
  if (!descriptor) throw new Error('synthetic_descriptor_required');
  expect(() =>
    parseToolVersionRegistry({
      ...fixture.registry,
      profiles: [
        ...fixture.registry.profiles,
        {
          ...descriptor,
          version: '0.166.0'
        }
      ]
    })
  ).toThrow('tool_version_registry_invalid');
  expect(() =>
    parseToolVersionRegistry({
      ...fixture.registry,
      profiles: [
        ...profileData,
        {
          ...descriptor,
          nativeIdentity: 'claude-2.1.306-ordinary-image'
        }
      ]
    })
  ).toThrow('tool_version_registry_invalid');
});

test('receipt, qualification reader, ordinary admission and native tickets remain distinct', () => {
  const historical = lookupToolVersionProfile('codex', '0.160.0');
  const current = lookupToolVersionProfile('codex', '0.166.0');
  expect(historical).toMatchObject({
    qualificationReader: { mode: 'legacy_header_v1' },
    externalTicket: { mode: 'codex_01600_ticket_v1' }
  });
  expect(historical?.ordinaryBinding).toBeUndefined();
  expect(current).toMatchObject({
    qualificationReader: { mode: 'not_registered' },
    externalTicket: { mode: 'not_registered' },
    ordinaryBinding: {
      costStatus: 'partial',
      qualification: 'unqualified',
      rootOnlyOverride: true
    }
  });
});

test('workflow retirement preserves independent Claude candidate and probe recipes', () => {
  const profile = lookupToolVersionProfile('claude_code', '2.1.288');
  if (profile?.product !== 'claude_code' || !profile.internalProbe || !profile.manualCandidate) throw new Error('missing_fixture_profile');
  expect(profile.workflow?.[0]?.status).toBe('retired');
  expect(toolVersionRecipe(profile.internalProbe.recipeId).kind).toBe('claude_probe');
  expect(toolVersionRecipe(profile.manualCandidate.recipeId).kind).toBe('claude_manual_candidate');
  expect(profile.ordinaryBinding).toBeUndefined();
});

test('exact image size and read ceilings remain separate from ordinary admission', () => {
  const ordinary = toolVersionIdentity('claude-2.1.306-ordinary-image');
  const localhost = toolVersionIdentity('claude-2.1.306-localhost-image');
  expect(ordinary.exactBytes).toBeUndefined();
  expect(ordinary.maxBytes).toBeUndefined();
  expect(localhost.exactBytes).toBe(toolVersionReadCeilings.claudeProcessImage);
  expect(localhost.sha256).toBe(ordinary.sha256);
  expect(toolVersionIdentity('codex-0.163.0-code-mode-host').exactBytes).toBeUndefined();
  expect(toolVersionIdentity('codex-0.166.0-code-mode-host')).toMatchObject({
    exactBytes: 69182864,
    exactSizeMode: 'always'
  });
  expect(toolVersionIdentity('codex-0.166.0-cli').exactSizeMode).toBe('native_only');
});

test('an exact row never registers adjacent or malformed versions', () => {
  for (const version of ['0.165.0', '0.167.0', '00.166.0', '0.166.0-alpha.1']) {
    expect(lookupToolVersionProfile('codex', version)).toBeUndefined();
  }
});

test('qualification final stops preserve strict child limits independently of root limits', () => {
  expect(toolVersionRecipe('codex-binding-0.166.0')).toMatchObject({
    finalStopVariant: 'greater_or_equal',
    childFinalStopVariant: 'greater_than',
    childRequestStop: 1
  });
  expect(toolVersionRecipe('codex-binding-0.163.0')).toMatchObject({
    finalStopVariant: 'greater_than',
    childFinalStopVariant: 'greater_than',
    childRequestStop: 1
  });
});

test('historical file conformance metadata matches the existing candidate owner', () => {
  const profile = lookupToolVersionProfile('codex', '0.158.0');
  if (profile?.product !== 'codex' || !profile.fileConformance) {
    throw new Error('missing_file_conformance_recipe');
  }
  const recipe = toolVersionRecipe(profile.fileConformance.recipeId);
  if (recipe.kind !== 'codex_file_conformance') {
    throw new Error('wrong_file_conformance_recipe');
  }
  expect({
    product: recipe.product,
    version: recipe.version,
    previousVersion: recipe.previousVersion,
    sourceRef: recipe.sourceRef,
    admitted: recipe.admitted
  }).toEqual({
    product: codex01580Candidate.product,
    version: codex01580Candidate.version,
    previousVersion: codex01580Candidate.previousVersion,
    sourceRef: codex01580Candidate.sourceRef,
    admitted: codex01580Candidate.admitted
  });
});

test.each([
  ['codex_legacy_v1', 'codex-file-legacy-v1', 'claude-file-message-components-v1'],
  ['codex_checkpoint_v1', 'codex-file-checkpoint-v1', 'codex-file-legacy-v1']
] as const)('rejects a file profile ID change without changing %s', (parserVariant, profileId, invalidId) => {
  const profile = {
    ...unregistered,
    file: { status: 'registered', profileId, parserVariant }
  };
  expect(() =>
    parseToolVersionRegistry({
      profiles: [profile],
      recipes: [],
      identities: []
    })
  ).not.toThrow();
  expect(() =>
    parseToolVersionRegistry({
      profiles: [
        {
          ...profile,
          file: { ...profile.file, profileId: invalidId }
        }
      ],
      recipes: [],
      identities: []
    })
  ).toThrow('tool_version_registry_invalid');
});

test.each([
  ['codex', 'codex_own_response_workflow_v1', 'codex-workflow-own-response-v1', 'claude-workflow-own-trace-v1'],
  ['claude_code', 'claude_parent_workflow_v1', 'claude-workflow-own-trace-v1', 'claude-workflow-direct-child-v1'],
  ['claude_code', 'claude_exact_child_workflow_v1', 'claude-workflow-direct-child-v1', 'codex-workflow-direct-child-v1']
] as const)('rejects a %s workflow ID change without changing %s', (product, operationVariant, profileId, invalidId) => {
  const profile = {
    product,
    version: '9.1.1',
    exportOrder: {},
    qualificationRecipes: [],
    assessmentScopes: [],
    evidenceRefs: [],
    ...(product === 'codex'
      ? {
          qualificationReader: { mode: 'not_registered' },
          externalTicket: { mode: 'not_registered' }
        }
      : {}),
    workflow: [{ status: 'admitted', profileId, operationVariant }]
  };
  expect(() =>
    parseToolVersionRegistry({
      profiles: [profile],
      recipes: [],
      identities: []
    })
  ).not.toThrow();
  const invalid = {
    ...profile,
    workflow: profile.workflow.map(workflow => ({
      ...workflow,
      profileId: invalidId
    }))
  };
  expect(() =>
    parseToolVersionRegistry({
      profiles: [invalid],
      recipes: [],
      identities: []
    })
  ).toThrow('tool_version_registry_invalid');
});

test('retired workflow IDs still belong to their declared product', () => {
  const profile = {
    ...unregistered,
    workflow: [
      {
        status: 'retired',
        profileId: 'claude-workflow-own-trace-v1',
        retiredAt: '2026-10-06'
      }
    ]
  };
  expect(() =>
    parseToolVersionRegistry({
      profiles: [profile],
      recipes: [],
      identities: []
    })
  ).toThrow('tool_version_registry_invalid');
});

test.each([33, 1000000])('rejects a Claude family ceiling of %s before constructing its consumer', maxFamilyMembers => {
  const profile = profileData.find(profile => profile.product === 'claude_code' && profile.version === '2.1.306');
  if (!profile?.ordinaryBinding) {
    throw new Error('missing_fixture_admission');
  }
  const invalid = {
    ...profile,
    ordinaryBinding: { ...profile.ordinaryBinding, maxFamilyMembers }
  };
  expect(() =>
    parseToolVersionRegistry({
      ...registry(),
      profiles: profileData.map(value => (value === profile ? invalid : value))
    })
  ).toThrow();
});

test('the registry retains the existing Claude provider family ceiling', () => {
  const profile = profileData.find(profile => profile.product === 'claude_code' && profile.version === '2.1.306');
  if (!profile?.ordinaryBinding) throw new Error('missing_fixture_admission');
  const bounded = {
    ...profile,
    ordinaryBinding: { ...profile.ordinaryBinding, maxFamilyMembers: 32 }
  };
  expect(() =>
    parseToolVersionRegistry({
      ...registry(),
      profiles: profileData.map(value => (value === profile ? bounded : value))
    })
  ).not.toThrow();
  expect(
    () =>
      new ClaudeSessionBindingProvider({
        receiptDir: '/synthetic',
        claudeProjectsDir: '/synthetic',
        projectRoot: '/synthetic',
        ordinaryAdmission: true,
        productVersion: '2.1.306',
        maxFamilyMembers: 32
      })
  ).not.toThrow();
});

test.each([
  ['codex-binding-0.163.0', 'rootRequestStop', 9],
  ['codex-binding-0.163.0', 'totalRequestStop', 11],
  ['codex-binding-0.163.0', 'tokenStop', 100001],
  ['codex-binding-0.163.0', 'durationMs', 99],
  ['codex-binding-0.163.0', 'durationMs', 900001],
  ['codex-historical-one-child-01600', 'durationMs', 180001],
  ['codex-historical-one-child-01600', 'handshakeMs', 180001],
  ['codex-historical-one-child-01600', 'pollMs', 1001],
  ['codex-historical-one-child-01600', 'maxPollMs', 1001],
  ['codex-workflow-01600', 'durationMs', 999],
  ['codex-workflow-01600', 'durationMs', 180001],
  ['codex-workflow-01600', 'rootResumeInvocations', 3],
  ['codex-workflow-01600', 'rootResumeOwnResponses', 3],
  ['codex-workflow-01600', 'directChildInvocations', 2],
  ['codex-workflow-01600', 'directChildOwnResponses', 3],
  ['claude-internal-probe-02188', 'durationMs', 120001],
  ['claude-internal-probe-02188', 'plannedRequests', 4],
  ['claude-internal-probe-02188', 'rootRequestStop', 3],
  ['claude-internal-probe-02188', 'childRequestStop', 2],
  ['claude-internal-probe-02188', 'maxBinaryBytes', 536870913],
  ['claude-localhost-02306', 'durationMinMs', 9999],
  ['claude-localhost-02306', 'durationMaxMs', 120001],
  ['claude-localhost-02306', 'terminationMinMs', 999],
  ['claude-localhost-02306', 'terminationMaxMs', 10001],
  ['claude-localhost-02306', 'graceMinMs', 99],
  ['claude-localhost-02306', 'graceMaxMs', 2001],
  ['claude-localhost-02306', 'approvalLifetimeMaxMs', 3600001]
] as const)('rejects %s %s=%s outside its existing consumer contract', (recipeId, field, value) => {
  const recipe = recipeData.find(recipe => recipe.id === recipeId);
  if (!recipe || !Object.hasOwn(recipe, field)) {
    throw new Error('missing_numeric_fixture');
  }
  const invalid = recipeData.map(recipe => (recipe.id === recipeId ? { ...recipe, [field]: value } : recipe));
  expect(() => parseToolVersionRegistry({ ...registry(), recipes: invalid })).toThrow();
});
