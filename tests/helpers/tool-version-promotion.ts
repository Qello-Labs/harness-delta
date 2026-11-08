import type { PromotionDecision } from '../../scripts/tool-update/promotion-records.mjs';
import {
  parseToolVersionPromotionDescriptor,
  previewToolVersionPromotion,
  projectToolVersionPromotions,
  promotionDecisionDigest,
  promotionDescriptorDigest,
  promotionProjectionDigest,
  type ToolVersionPromotionDescriptor,
  type ToolVersionPromotionLedger
} from '../../src/core/tool-version-promotion.js';

export function promotionFixture(product: 'codex' | 'claude_code' = 'codex') {
  const codex = product === 'codex';
  const descriptor = parseToolVersionPromotionDescriptor({
    kind: 'promoted_descriptor',
    schemaVersion: 1,
    state: 'pending',
    product,
    version: codex ? '0.169.0' : '2.1.318',
    sourceRef: 'a'.repeat(40),
    profileId: codex ? 'codex-binding-01690-direct-family-v1' : 'claude-binding-2-1-318-family-v1',
    route: codex ? 'codex_binding' : 'claude_binding',
    scopes: [
      {
        operation: 'collect',
        topology: 'bounded_family',
        maxDepth: 1,
        maxFamilyMembers: 3,
        grants: ['admission', 'children', 'qualification']
      },
      {
        operation: 'collect',
        topology: 'root',
        maxDepth: 0,
        maxFamilyMembers: 1,
        grants: ['admission', 'qualification']
      },
      {
        operation: 'link',
        topology: 'root',
        maxDepth: 0,
        maxFamilyMembers: 1,
        grants: ['admission', 'qualification']
      },
      {
        operation: 'restart',
        topology: 'root',
        maxDepth: 0,
        maxFamilyMembers: 1,
        grants: ['admission', 'qualification']
      }
    ],
    variants: codex
      ? {
          parser: 'codex_binding_tokens_v1',
          history: 'codex_reject_inherited_history_v1',
          finality: 'codex_usage_event_v1',
          identity: 'codex_hook_header_v1'
        }
      : {
          parser: 'claude_transcript_v1',
          history: 'claude_flattened_family_v1',
          finality: 'claude_terminal_message_v1',
          identity: 'claude_exact_image_v1'
        },
    model: codex ? 'gpt-6.1-sol' : 'claude-sonnet-5-5',
    ...(codex ? { effort: 'high' } : {}),
    nativeIdentity: `synthetic-${product}-image`,
    recipeReferences: [`synthetic-${product}-recipe`],
    qualificationClaims: {
      semanticsDigest: 'd'.repeat(64),
      scenarios: ['interrupted', 'normal', 'scope_denial']
    },
    platforms: ['darwin_arm64'],
    runtimes: ['node24', 'node26']
  });
  const ledger: ToolVersionPromotionLedger = {
    schema_version: 1,
    records: []
  };
  return {
    descriptors: [descriptor],
    ledger,
    registryDigest: 'b'.repeat(64),
    implementationDigest: 'c'.repeat(64)
  };
}
export type PromotionFixture = ReturnType<typeof promotionFixture>;

export function appendPromotionDecision(fixture: PromotionFixture, overrides: Partial<PromotionDecision> = {}) {
  const descriptor: ToolVersionPromotionDescriptor | undefined = fixture.descriptors[0];
  if (!descriptor) throw new Error('synthetic_descriptor_required');
  const scope: PromotionDecision['scope'] = overrides.scope ?? {
    target: { version: descriptor.version, commit: descriptor.sourceRef },
    lane: {
      product: descriptor.product,
      route: descriptor.route,
      profile_id: descriptor.profileId,
      operation: 'collect',
      topology: 'root'
    },
    platform: 'darwin_arm64',
    runtime: Number(process.versions.node.split('.')[0]) === 24 ? 'node24' : 'node26'
  };
  const previous = fixture.ledger.records.findLast(record => JSON.stringify(record.decision.scope) === JSON.stringify(scope));
  const payload: Omit<PromotionDecision, 'registry_before_digest' | 'effective_projection_digest'> = {
    schema_version: 1,
    kind: 'promotion_decision',
    authority: 'none',
    proposal_id: '1'.repeat(64),
    scope,
    proposed_scope: scope,
    requested_grants: ['admission', 'qualification'],
    grants: ['admission'],
    accepted_validation_ids: ['2'.repeat(64)],
    descriptor_digest: promotionDescriptorDigest(descriptor),
    implementation_digest: fixture.implementationDigest,
    implementation_scheme: 'promotion-implementation-v1',
    predecessor: previous
      ? {
          id: previous.id,
          sequence: previous.decision.sequence,
          decision: previous.decision.decision
        }
      : null,
    sequence: previous ? previous.decision.sequence + 1 : 1,
    decision: 'approve',
    reason: 'scoped_approval',
    prior_deny_ids: [],
    independent_review_ids: ['3'.repeat(64)],
    authorization_reference_ids: ['4'.repeat(64)],
    ...overrides
  };
  const before = projectToolVersionPromotions(fixture);
  const after = previewToolVersionPromotion(before, descriptor, payload);
  const decision: PromotionDecision = {
    ...payload,
    registry_before_digest: promotionProjectionDigest(before),
    effective_projection_digest: promotionProjectionDigest(after)
  };
  const record = { id: promotionDecisionDigest(decision), decision };
  fixture.ledger = {
    schema_version: 1,
    records: [...fixture.ledger.records, record]
  };
  return record;
}
