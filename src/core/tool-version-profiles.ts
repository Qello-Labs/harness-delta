import profileData from './tool-version-profiles.json' with { type: 'json' };
import recipeData from './tool-version-recipes.json' with { type: 'json' };
import identityData from './tool-version-identities.json' with { type: 'json' };
import { z } from 'zod';

const id = z.string().min(1);
const version = z.string().regex(/^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().positive();
const order = z.number().int().nonnegative();
const exportOrder = z
  .strictObject({
    file: order.optional(),
    receipt: order.optional(),
    humanPilot: order.optional(),
    qualificationRecipe: order.optional(),
    ordinaryBinding: order.optional(),
    transcriptProfile: order.optional(),
    workflow: order.optional(),
    retiredWorkflow: order.optional(),
    syntheticCandidate: order.optional(),
    internalTrace: order.optional()
  })
  .readonly();
const file = z
  .strictObject({
    status: z.enum(['registered', 'ledger_registered']),
    profileId: z.enum(['codex-file-legacy-v1', 'codex-file-checkpoint-v1', 'claude-file-message-components-v1']),
    parserVariant: z.enum(['codex_legacy_v1', 'codex_checkpoint_v1', 'claude_message_components_v1']),
    policyRevision: id.optional()
  })
  .readonly();
const humanPilot = z
  .strictObject({
    status: z.literal('candidate'),
    profileId: id,
    maxDepth: z.literal(1),
    maxFamilyMembers: z.union([z.literal(1), z.literal(3)])
  })
  .readonly();
const workflowProfileId = z.enum([
  'codex-workflow-own-response-v1',
  'codex-workflow-direct-child-v1',
  'claude-workflow-own-trace-v1',
  'claude-workflow-direct-child-v1'
]);
const workflow = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('admitted'),
    profileId: workflowProfileId,
    operationVariant: z.enum(['codex_own_response_workflow_v1', 'claude_parent_workflow_v1', 'claude_exact_child_workflow_v1'])
  }),
  z.strictObject({
    status: z.literal('retired'),
    profileId: workflowProfileId,
    retiredAt: z.iso.date()
  })
]);
const readiness = z
  .strictObject({
    order,
    id,
    profileId: id,
    semanticsDigest: hash,
    validationKind: z.literal('real_operations'),
    completeCost: z.literal(false)
  })
  .readonly();
const scope = z.enum(['file_v1', 'codex_binding_v1', 'claude_binding_v1', 'codex_workflow_v1', 'claude_workflow_v1']);
const common = {
  version,
  sourceRef: id.optional(),
  exportOrder,
  file: file.optional(),
  workflow: z.array(workflow).readonly().optional(),
  humanPilot: humanPilot.optional(),
  qualificationRecipes: z.array(id).readonly(),
  assessmentScopes: z.array(scope).readonly(),
  evidenceRefs: z.array(id).readonly(),
  readiness: z.array(readiness).readonly().optional(),
  syntheticCandidate: z
    .strictObject({
      status: z.literal('candidate'),
      profileId: id,
      admitted: z.literal(false)
    })
    .readonly()
    .optional()
};
const codexOrdinary = z
  .strictObject({
    status: z.literal('admitted'),
    costStatus: z.literal('partial'),
    profileId: id,
    qualification: z.enum(['implicit_verified', 'verified', 'unqualified']),
    model: id,
    effort: id,
    maxDepth: z.literal(1),
    maxFamilyMembers: z.literal(3),
    modelPolicy: z.literal('gpt_family_observed_effort_v1'),
    historyVariant: z.enum(['codex_paginated_own_suffix_v1', 'codex_reject_inherited_history_v1']),
    rootOnlyOverride: z.boolean(),
    evidenceId: id.optional(),
    evidenceIntentSha256: hash.optional()
  })
  .readonly();
const recipeReference = z.strictObject({ recipeId: id }).readonly();
const codexProfile = z
  .strictObject({
    ...common,
    product: z.literal('codex'),
    receipt: z
      .strictObject({
        mode: z.literal('codex_metadata_v1'),
        legacyDefault: z.boolean()
      })
      .readonly()
      .optional(),
    qualificationReader: z
      .strictObject({
        mode: z.enum(['legacy_header_v1', 'family_qualification_v1', 'not_registered'])
      })
      .readonly(),
    externalTicket: z
      .strictObject({
        mode: z.enum(['codex_01600_ticket_v1', 'not_registered'])
      })
      .readonly(),
    ordinaryBinding: codexOrdinary.optional(),
    historicalCandidate: recipeReference.optional(),
    fileConformance: recipeReference.optional(),
    instrumentedSource: recipeReference.optional()
  })
  .readonly();
const claudeProfile = z
  .strictObject({
    ...common,
    product: z.literal('claude_code'),
    ordinaryBinding: z
      .strictObject({
        status: z.literal('admitted'),
        costStatus: z.literal('partial'),
        profileId: id,
        qualified: z.literal(false),
        model: id,
        maxFamilyMembers: count.max(32),
        modelPolicy: z.literal('claude_family_observed_effort_v1'),
        historyVariant: z.literal('claude_flattened_family_v1'),
        imageIdentity: id,
        evidenceId: id
      })
      .readonly()
      .optional(),
    transcriptProfile: z
      .strictObject({
        status: z.enum(['qualified', 'candidate']),
        evidence: id,
        finalityVariant: z.enum(['claude_terminal_message_v1', 'claude_candidate_quiescence_v1']),
        legacyDefault: z.boolean()
      })
      .readonly()
      .optional(),
    internalProbe: recipeReference.optional(),
    manualCandidate: recipeReference.optional()
  })
  .readonly();
const identitySchema = z
  .strictObject({
    id,
    product: z.enum(['codex', 'claude_code']),
    version,
    kind: z.enum(['native_image', 'component', 'recorder', 'toolchain']),
    sha256: hash,
    maxBytes: count.optional(),
    exactBytes: count.optional(),
    exactSizeMode: z.enum(['native_only', 'always']).optional()
  })
  .readonly();
const recipeCommon = { id, version };
const codexRecipe = { ...recipeCommon, product: z.literal('codex') };
const claudeRecipe = { ...recipeCommon, product: z.literal('claude_code') };
const recipeSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...codexRecipe,
    kind: z.literal('codex_file_conformance'),
    previousVersion: version,
    sourceRef: id,
    admitted: z.literal(false)
  }),
  z.strictObject({
    ...codexRecipe,
    kind: z.literal('codex_binding'),
    imageIdentity: id,
    hostIdentity: id.optional(),
    rootRequestStop: z.union([z.literal(4), z.literal(5), z.literal(8), z.literal(10)]),
    totalRequestStop: z.union([z.literal(6), z.literal(7), z.literal(10), z.literal(12)]),
    tokenStop: z.union([z.literal(100000), z.literal(200000), z.literal(300000)]),
    durationMs: count.min(100).max(900000),
    childRequestStop: z.literal(1),
    helperNetworkPermission: z.enum(['none', 'single_command_network_only']),
    model: z.literal('gpt-6.1-sol'),
    effort: z.literal('high'),
    runtime: z.literal('node24_darwin_arm64'),
    scenarioVariant: z.enum(['codex_01660_explicit_scenarios_v1', 'codex_two_child_qualification_v1']),
    restartWitnessVariant: z.enum(['codex_strict_post_boundary_v1', 'codex_legacy_restart_v1']),
    finalStopVariant: z.enum(['greater_or_equal', 'greater_than']),
    childFinalStopVariant: z.literal('greater_than'),
    qualificationCompatibility: z.literal('codex-workflow-own-response-v1').nullable()
  }),
  z.strictObject({
    ...codexRecipe,
    kind: z.literal('codex_historical_candidate'),
    sourceRef: id,
    rootModel: z.literal('gpt-6-astra'),
    childModel: z.literal('gpt-6.1-sol'),
    effort: z.literal('high'),
    durationMs: count.max(180000),
    handshakeMs: count,
    pollMs: count.max(1000),
    maxPollMs: z.literal(1000),
    maxDepth: z.literal(1),
    plannedChildren: z.literal(1),
    permissions: z.literal('read-only'),
    runtime: z.literal('node24_darwin_arm64')
  }),
  z.strictObject({
    ...codexRecipe,
    kind: z.literal('codex_workflow'),
    imageIdentity: id,
    recorderIdentity: id,
    durationMs: count.min(1000).max(180000),
    rootModel: z.literal('gpt-6-astra'),
    childModel: z.literal('gpt-6.1-sol'),
    effort: z.literal('high'),
    permissions: z.literal('read-only'),
    runtime: z.literal('node24_darwin_arm64'),
    scenarioVariant: z.literal('codex_root_resume_or_direct_child_v1'),
    rootResumeInvocations: z.literal(2),
    rootResumeOwnResponses: z.literal(2),
    directChildInvocations: z.literal(1),
    directChildOwnResponses: z.literal(4)
  }),
  z.strictObject({
    ...claudeRecipe,
    kind: z.literal('claude_probe'),
    model: z.literal('claude-sonnet-5-5'),
    effort: z.literal('high'),
    durationMs: z.literal(120000),
    plannedRequests: z.literal(3),
    rootRequestStop: z.literal(2),
    childRequestStop: z.literal(1),
    estimatedUsd: z.literal('0.10'),
    maxBinaryBytes: z.literal(536870912),
    runtime: z.literal('node24_or_26_non_windows'),
    identityMode: z.literal('measured_image')
  }),
  z.strictObject({
    ...claudeRecipe,
    kind: z.literal('claude_manual_candidate'),
    imageIdentity: id,
    model: z.literal('claude-sonnet-5-5'),
    effort: z.literal('high'),
    plannedRequests: z.literal(1),
    plannedChildren: z.literal(0),
    estimatedUsd: z.literal('0.10'),
    status: z.literal('candidate_unadmitted'),
    persistent: z.literal(false)
  }),
  z.strictObject({
    ...claudeRecipe,
    kind: z.literal('claude_localhost'),
    imageIdentity: id,
    profileId: id,
    model: z.literal('claude-sonnet-5-5'),
    runtime: z.literal('node24_darwin_arm64'),
    scenarios: z.tuple([z.literal('normal'), z.literal('sigint')]),
    roots: z.literal(1),
    members: z.literal(2),
    durationMinMs: z.literal(10000),
    durationMaxMs: z.literal(120000),
    terminationMinMs: z.literal(1000),
    terminationMaxMs: z.literal(10000),
    graceMinMs: z.literal(100),
    graceMaxMs: z.literal(2000),
    approvalLifetimeMaxMs: z.literal(3600000),
    mode: z.literal('manual')
  }),
  z.strictObject({
    ...codexRecipe,
    kind: z.literal('codex_instrumented'),
    sourceRef: id,
    profileId: id,
    target: z.literal('aarch64-apple-darwin'),
    toolchainVersion: z.literal('1.95.0'),
    compilerManifestIdentity: id,
    compilerTreeIdentity: id,
    recipeVersion: z.literal(1),
    command: z.tuple([
      z.literal('build'),
      z.literal('--locked'),
      z.literal('--offline'),
      z.literal('--target'),
      z.literal('aarch64-apple-darwin'),
      z.literal('-p'),
      z.literal('codex-cli'),
      z.literal('--bin'),
      z.literal('codex')
    ]),
    buildProfile: z.literal('dev'),
    incremental: z.literal(false),
    debug: z.literal(0),
    transportContract: z.literal('http1-responses-no-redirect-no-implicit-retry-no-pool-v1'),
    counterContract: z.literal('presence-preserving-disjoint-tokens-v1'),
    configurationPolicy: z.literal('fresh-root-direct-v2-two-children-gpt-61-sol-high-telemetry-off-v1'),
    producerProtocol: z.literal('harness-codex-accounting-v1'),
    model: z.literal('gpt-6.1-sol'),
    effort: z.literal('high'),
    maxRoots: z.literal(1),
    maxDirectChildren: z.literal(2),
    maxDepth: z.literal(1)
  })
]);
const identityDocument = z
  .strictObject({
    readCeilings: z
      .strictObject({
        claudeProcessImage: z.literal(272984176)
      })
      .readonly(),
    entries: z.array(identitySchema).readonly()
  })
  .parse(identityData);
const registrySchema = z
  .strictObject({
    profiles: z.array(z.discriminatedUnion('product', [codexProfile, claudeProfile])).readonly(),
    recipes: z.array(recipeSchema).readonly(),
    identities: z.array(identitySchema).readonly()
  })
  .readonly();
export type ToolVersionProfile = z.infer<typeof codexProfile> | z.infer<typeof claudeProfile>;
export type ToolVersionRecipe = z.infer<typeof recipeSchema>;
export type ToolVersionIdentity = z.infer<typeof identitySchema>;
export type ToolVersionView = keyof z.infer<typeof exportOrder>;
type Registry = z.infer<typeof registrySchema>;

export class ToolVersionRegistryError extends Error {
  constructor(readonly reason: string) {
    super('tool_version_registry_invalid');
  }
}
function reject(reason: string): never {
  throw new ToolVersionRegistryError(reason);
}
function unique(keys: readonly string[], reason: string) {
  if (new Set(keys).size !== keys.length) reject(reason);
}
function sameOwner(a: { readonly product: string; readonly version: string }, b: { readonly product: string; readonly version: string }) {
  return a.product === b.product && a.version === b.version;
}
function validateProfileVariants(profile: ToolVersionProfile) {
  if (profile.file && (profile.product === 'codex') !== profile.file.parserVariant.startsWith('codex_')) reject('wrong_product_file');
  const fileIds = {
    codex_legacy_v1: 'codex-file-legacy-v1',
    codex_checkpoint_v1: 'codex-file-checkpoint-v1',
    claude_message_components_v1: 'claude-file-message-components-v1'
  } as const;
  if (profile.file && profile.file.profileId !== fileIds[profile.file.parserVariant]) reject('file_profile_variant');
  const productPrefix = profile.product === 'codex' ? 'codex_' : 'claude_';
  const workflowIds = {
    codex_own_response_workflow_v1: ['codex-workflow-own-response-v1', 'codex-workflow-direct-child-v1'],
    claude_parent_workflow_v1: ['claude-workflow-own-trace-v1'],
    claude_exact_child_workflow_v1: ['claude-workflow-direct-child-v1']
  } as const;
  for (const workflow of profile.workflow ?? []) {
    if (!workflow.profileId.startsWith(profile.product === 'codex' ? 'codex-' : 'claude-')) reject('wrong_product_workflow_profile');
    if (workflow.status !== 'admitted') continue;
    if (!workflow.operationVariant.startsWith(productPrefix)) {
      reject('wrong_product_workflow');
    }
    const expectedIds: readonly string[] = workflowIds[workflow.operationVariant];
    if (!expectedIds.includes(workflow.profileId)) {
      reject('workflow_profile_variant');
    }
  }
  if (profile.assessmentScopes.some(scope => scope !== 'file_v1' && !scope.startsWith(productPrefix))) reject('wrong_product_scope');
  if (profile.file && (profile.file.status === 'ledger_registered') !== (profile.file.policyRevision !== undefined)) reject('registration_policy');
}
function validateProfile(profile: ToolVersionProfile, registry: Registry) {
  validateProfileVariants(profile);
  for (const recipeId of profile.qualificationRecipes) {
    const recipe = registry.recipes.find(value => value.id === recipeId);
    if (!recipe || !sameOwner(profile, recipe)) reject('recipe_reference');
  }
  const references: readonly (readonly [{ readonly recipeId: string } | undefined, ToolVersionRecipe['kind']])[] =
    profile.product === 'codex'
      ? [
          [profile.historicalCandidate, 'codex_historical_candidate'],
          [profile.fileConformance, 'codex_file_conformance'],
          [profile.instrumentedSource, 'codex_instrumented']
        ]
      : [
          [profile.internalProbe, 'claude_probe'],
          [profile.manualCandidate, 'claude_manual_candidate']
        ];
  for (const [reference, kind] of references) {
    if (!reference) continue;
    if (!profile.qualificationRecipes.includes(reference.recipeId) || registry.recipes.find(value => value.id === reference.recipeId)?.kind !== kind) {
      reject('facet_recipe_reference');
    }
  }
  if (profile.product === 'codex' && profile.ordinaryBinding) {
    const admission = profile.ordinaryBinding;
    if (!profile.sourceRef) reject('ordinary_source_ref');
    if (
      admission.qualification === 'unqualified'
        ? admission.evidenceId !== undefined || admission.evidenceIntentSha256 !== undefined
        : admission.evidenceId === undefined || admission.evidenceIntentSha256 === undefined
    ) {
      reject('qualification_evidence');
    }
  }
  if (profile.product === 'claude_code' && profile.ordinaryBinding) {
    const image = registry.identities.find(value => value.id === profile.ordinaryBinding?.imageIdentity);
    if (!image || !sameOwner(profile, image) || image.kind !== 'native_image') reject('ordinary_image_reference');
  }
}
function recipeIdentityReferences(recipe: ToolVersionRecipe): readonly (readonly [string | undefined, ToolVersionIdentity['kind']])[] {
  switch (recipe.kind) {
    case 'codex_binding':
      return [
        [recipe.imageIdentity, 'native_image'],
        [recipe.hostIdentity, 'component']
      ];
    case 'codex_workflow':
      return [
        [recipe.imageIdentity, 'native_image'],
        [recipe.recorderIdentity, 'recorder']
      ];
    case 'claude_manual_candidate':
    case 'claude_localhost':
      return [[recipe.imageIdentity, 'native_image']];
    case 'codex_instrumented':
      return [
        [recipe.compilerManifestIdentity, 'toolchain'],
        [recipe.compilerTreeIdentity, 'toolchain']
      ];
    case 'codex_historical_candidate':
    case 'codex_file_conformance':
    case 'claude_probe':
      return [];
  }
}
function validateRecipe(recipe: ToolVersionRecipe, registry: Registry) {
  if (recipe.kind === 'codex_historical_candidate' && recipe.handshakeMs > recipe.durationMs) reject('historical_handshake_duration');
  for (const [reference, kind] of recipeIdentityReferences(recipe)) {
    if (reference === undefined) continue;
    const identity = registry.identities.find(value => value.id === reference);
    if (!identity || !sameOwner(recipe, identity)) {
      reject('recipe_identity_reference');
    }
    if (identity.kind !== kind) reject('recipe_identity_kind');
  }
}
export function parseToolVersionRegistry(input: unknown): Registry {
  const registry = registrySchema.parse(input);
  unique(
    registry.profiles.map(profile => profile.product + ':' + profile.version),
    'duplicate_profile'
  );
  unique(
    registry.recipes.map(recipe => recipe.id),
    'duplicate_recipe'
  );
  unique(
    registry.identities.map(identity => identity.id),
    'duplicate_identity'
  );
  unique(
    registry.profiles.flatMap(profile =>
      Object.entries(profile.exportOrder)
        .filter(([, value]) => value !== undefined)
        .map(([view, value]) => profile.product + ':' + view + ':' + value)
    ),
    'duplicate_export_order'
  );
  const readiness = registry.profiles.flatMap(profile => profile.readiness ?? []);
  unique(
    readiness.map(value => value.id),
    'duplicate_readiness'
  );
  unique(
    readiness.map(value => String(value.order)),
    'duplicate_readiness_order'
  );
  for (const profile of registry.profiles) validateProfile(profile, registry);
  for (const recipe of registry.recipes) validateRecipe(recipe, registry);
  for (const identity of registry.identities) {
    if ((identity.exactBytes === undefined) !== (identity.exactSizeMode === undefined)) reject('image_exact_mode');
    if (identity.exactBytes !== undefined && identity.maxBytes !== undefined && identity.exactBytes > identity.maxBytes) reject('image_size');
    if (identity.kind !== 'native_image') continue;
    for (const other of registry.identities.filter(value => value.kind === 'native_image' && sameOwner(value, identity))) {
      if (
        other.sha256 !== identity.sha256 ||
        (other.exactBytes !== undefined && identity.exactBytes !== undefined && other.exactBytes !== identity.exactBytes)
      ) {
        reject('inconsistent_image');
      }
    }
  }
  return registry;
}
const registry = parseToolVersionRegistry({
  profiles: profileData,
  recipes: recipeData,
  identities: identityDocument.entries
});
export const toolVersionProfiles = registry.profiles;
export const toolVersionRecipes = registry.recipes;
export const toolVersionIdentities = registry.identities;
export const toolVersionReadCeilings = identityDocument.readCeilings;
export function lookupToolVersionProfile(product: string, productVersion: string) {
  return toolVersionProfiles.find(profile => profile.product === product && profile.version === productVersion);
}
export function toolVersionRecipe(recipeId: string): ToolVersionRecipe {
  return toolVersionRecipes.find(recipe => recipe.id === recipeId) ?? reject('recipe_reference');
}
export function toolVersionIdentity(identityId: string): ToolVersionIdentity {
  return toolVersionIdentities.find(identity => identity.id === identityId) ?? reject('identity_reference');
}
export function orderedToolVersionProfiles(view: ToolVersionView, product?: ToolVersionProfile['product']) {
  return toolVersionProfiles
    .filter(profile => profile.exportOrder[view] !== undefined && (product === undefined || profile.product === product))
    .sort((a, b) => (a.exportOrder[view] ?? 0) - (b.exportOrder[view] ?? 0));
}
type LegacyCodexBindingAdmission = {
  readonly profileId: string;
  readonly productVersion: string;
  readonly model: string;
  readonly effort: string;
  readonly maxDepth: 1;
  readonly maxFamilyMembers: 3;
  readonly sourceRef: string;
} & (
  | {
      readonly qualified: false;
      readonly evidenceId?: never;
      readonly evidenceIntentSha256?: never;
    }
  | {
      readonly qualified?: true;
      readonly evidenceId: string;
      readonly evidenceIntentSha256: string;
    }
);
export function legacyCodexBindingAdmissions(): readonly LegacyCodexBindingAdmission[] {
  return orderedToolVersionProfiles('ordinaryBinding', 'codex').flatMap<LegacyCodexBindingAdmission>(profile => {
    if (profile.product !== 'codex' || !profile.ordinaryBinding) {
      return [];
    }
    const admission = profile.ordinaryBinding;
    const sourceRef = profile.sourceRef ?? reject('ordinary_source_ref');
    const common = {
      profileId: admission.profileId,
      productVersion: profile.version,
      model: admission.model,
      effort: admission.effort,
      maxDepth: admission.maxDepth,
      maxFamilyMembers: admission.maxFamilyMembers
    };
    if (admission.qualification === 'unqualified') {
      return [
        {
          ...common,
          sourceRef,
          qualified: false as const
        }
      ];
    }
    const qualified = {
      ...common,
      evidenceId: admission.evidenceId ?? reject('qualification_evidence'),
      sourceRef,
      evidenceIntentSha256: admission.evidenceIntentSha256 ?? reject('qualification_evidence')
    };
    return admission.qualification === 'implicit_verified' ? [qualified] : [{ ...qualified, qualified: true as const }];
  });
}
export function legacyClaudeBindingAdmissions() {
  return orderedToolVersionProfiles('ordinaryBinding', 'claude_code').flatMap(profile => {
    if (profile.product !== 'claude_code' || !profile.ordinaryBinding) {
      return [];
    }
    const admission = profile.ordinaryBinding;
    return [
      {
        profileId: admission.profileId,
        productVersion: profile.version,
        binarySha256: toolVersionIdentity(admission.imageIdentity).sha256,
        model: admission.model,
        admitted: true as const,
        maxFamilyMembers: admission.maxFamilyMembers,
        evidenceId: admission.evidenceId,
        qualified: false as const
      }
    ];
  });
}
export function legacyClaudeTranscriptProfiles() {
  return orderedToolVersionProfiles('transcriptProfile', 'claude_code').flatMap(profile => {
    if (profile.product !== 'claude_code' || !profile.transcriptProfile) return [];
    return [
      {
        version: profile.version,
        status: profile.transcriptProfile.status,
        evidence: profile.transcriptProfile.evidence
      }
    ];
  });
}
