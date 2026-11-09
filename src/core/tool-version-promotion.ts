import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { PromotionDecision } from '../../scripts/tool-update/promotion-records.mjs';

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const commit = z.string().regex(/^[a-f0-9]{40}$/);
const version = z.string().regex(/^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/);
const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const product = z.enum(['codex', 'claude_code']);
const platform = z.enum(['darwin_arm64', 'darwin_x64', 'linux_arm64', 'linux_x64', 'win32_x64']);
const runtime = z.enum(['node24', 'node26']);
const operation = z.enum(['link', 'collect', 'restart', 'resume']);
const grants = z.enum(['admission', 'children', 'qualification']);
const sortedUnique = (values: readonly string[]) => values.every((value, index) => index === 0 || value > (values[index - 1] ?? value));
const grantList = z.array(grants).max(3).refine(sortedUnique).readonly();
const scopeSchema = z
  .strictObject({
    operation,
    topology: z.enum(['root', 'bounded_family']),
    maxDepth: z.number().int().min(0).max(1),
    maxFamilyMembers: z.number().int().min(1).max(32),
    grants: grantList
  })
  .refine(scope =>
    scope.topology === 'root'
      ? scope.maxDepth === 0 && scope.maxFamilyMembers === 1 && !scope.grants.includes('children')
      : scope.maxDepth === 1 && scope.maxFamilyMembers >= 2 && scope.grants.includes('children')
  )
  .readonly();
const descriptorSchema = z
  .strictObject({
    kind: z.literal('promoted_descriptor'),
    schemaVersion: z.literal(1),
    state: z.literal('pending'),
    product,
    version,
    sourceRef: commit,
    profileId: identifier,
    route: z.enum(['codex_binding', 'claude_binding']),
    scopes: z
      .array(scopeSchema)
      .min(1)
      .max(8)
      .refine(values => sortedUnique(values.map(value => `${value.operation}:${value.topology}`)))
      .readonly(),
    variants: z
      .strictObject({
        parser: z.enum(['codex_binding_tokens_v1', 'claude_transcript_v1']),
        history: z.enum(['codex_paginated_own_suffix_v1', 'codex_reject_inherited_history_v1', 'claude_flattened_family_v1']),
        finality: z.enum(['codex_usage_event_v1', 'claude_terminal_message_v1', 'claude_candidate_quiescence_v1']),
        identity: z.enum(['codex_hook_header_v1', 'claude_exact_image_v1'])
      })
      .readonly(),
    model: identifier,
    effort: identifier.optional(),
    nativeIdentity: identifier,
    recipeReferences: z.array(identifier).min(1).max(32).refine(sortedUnique).readonly(),
    qualificationClaims: z
      .strictObject({
        semanticsDigest: sha,
        scenarios: z
          .array(z.enum(['normal', 'interrupted', 'replacement', 'cleanup', 'scope_denial', 'replay', 'counter_attribution', 'child_lifecycle']))
          .min(1)
          .max(8)
          .refine(sortedUnique)
          .readonly()
      })
      .readonly(),
    platforms: z.array(platform).min(1).max(5).refine(sortedUnique).readonly(),
    runtimes: z.array(runtime).min(1).max(2).refine(sortedUnique).readonly()
  })
  .readonly();
export type ToolVersionPromotionDescriptor = z.infer<typeof descriptorSchema>;
export type ToolVersionPromotionScope = z.infer<typeof scopeSchema>;
export type PromotionDecisionPayload = Omit<PromotionDecision, 'registry_before_digest' | 'effective_projection_digest'>;
export interface ToolVersionPromotionRecord {
  readonly id: string;
  readonly decision: PromotionDecision;
}
export interface ToolVersionPromotionLedger {
  readonly schema_version: 1;
  readonly records: readonly ToolVersionPromotionRecord[];
}
export interface ToolVersionPromotionFacet {
  readonly descriptor: ToolVersionPromotionDescriptor;
  readonly decision: PromotionDecisionPayload;
}
export interface ToolVersionPromotionProjection {
  readonly schema_version: 1;
  readonly registry_digest: string;
  readonly implementation_digest: string;
  readonly facets: readonly ToolVersionPromotionFacet[];
  readonly denials: readonly ToolVersionPromotionFacet[];
}
export interface ToolVersionPromotionInput {
  readonly descriptors: readonly unknown[];
  readonly ledger: unknown;
  readonly registryDigest: string;
  readonly implementationDigest: string;
}
export class ToolVersionPromotionError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super('tool_version_promotion_invalid');
    this.reason = reason;
  }
}
function reject(reason: string): never {
  throw new ToolVersionPromotionError(reason);
}
function canonical(value: unknown): string {
  const visit = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(visit);
    if (item !== null && typeof item === 'object') {
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, field]) => [key, visit(field)])
      );
    }
    return item;
  };
  return `${JSON.stringify(visit(value))}\n`;
}
export function promotionRegistryDigest(input: unknown): string {
  return createHash('sha256').update(canonical(input)).digest('hex');
}
export function promotionDescriptorDigest(descriptor: ToolVersionPromotionDescriptor): string {
  return promotionRegistryDigest(descriptor);
}
export function promotionDecisionDigest(decision: PromotionDecision): string {
  return promotionRegistryDigest(decision);
}
export function promotionProjectionDigest(projection: ToolVersionPromotionProjection): string {
  return promotionRegistryDigest(projection);
}
export function promotionEvidenceId(facet: ToolVersionPromotionFacet): string {
  return `promotion:${promotionRegistryDigest({
    descriptor_digest: facet.decision.descriptor_digest,
    scope: facet.decision.scope
  })}`;
}
function compareVersions(a: string, b: string): number {
  const right = b.split('.').map(Number);
  for (const [index, part] of a.split('.').map(Number).entries()) {
    const delta = part - (right[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}
export function parseToolVersionPromotionDescriptor(input: unknown): ToolVersionPromotionDescriptor {
  const parsed = descriptorSchema.safeParse(input);
  if (!parsed.success) return reject('descriptor_schema');
  const descriptor = parsed.data;
  const codex = descriptor.product === 'codex';
  const prefix = codex ? 'codex_' : 'claude_';
  if (
    descriptor.route !== (codex ? 'codex_binding' : 'claude_binding') ||
    !Object.values(descriptor.variants).every(variant => variant.startsWith(prefix)) ||
    !(codex
      ? /^codex-binding-[0-9]{5,27}-direct-family-v1$/.test(descriptor.profileId) && descriptor.effort !== undefined && /^gpt(?:-|$)/i.test(descriptor.model)
      : /^claude-binding-(?:[0-9]{5,27}|[0-9]{1,9}-[0-9]{1,9}-[0-9]{1,9})-family-v1$/.test(descriptor.profileId) &&
        descriptor.effort === undefined &&
        /^claude(?:-|$)/i.test(descriptor.model))
  ) {
    return reject('descriptor_variant');
  }
  const base = codex ? '0.163.0' : '2.1.306';
  const ceiling = codex ? '0.170.0' : '2.2.0';
  if (compareVersions(descriptor.version, base) <= 0 || compareVersions(descriptor.version, ceiling) >= 0) return reject('target_refused');
  return descriptor;
}
const ids = z.array(sha).max(256).refine(sortedUnique).readonly();
const decisions = z.enum(['approve', 'demote', 'retire', 'revoke', 'invalidate', 'delete']);
const decisionScope = z.strictObject({
  target: z.strictObject({ version, commit }),
  lane: z.strictObject({
    product,
    route: z.enum(['file', 'codex_workflow', 'claude_workflow', 'codex_binding', 'claude_binding']),
    profile_id: identifier,
    operation: z.enum(['launch', 'link', 'collect', 'restart', 'resume']),
    topology: z.enum(['root', 'root_direct_child', 'bounded_family'])
  }),
  platform,
  runtime
});
const decisionSchema = z.strictObject({
  schema_version: z.literal(1),
  kind: z.literal('promotion_decision'),
  authority: z.literal('none'),
  proposal_id: sha,
  scope: decisionScope,
  proposed_scope: decisionScope,
  requested_grants: grantList.refine(values => values.length > 0),
  grants: grantList,
  accepted_validation_ids: ids,
  descriptor_digest: sha,
  implementation_digest: sha,
  implementation_scheme: z.literal('promotion-implementation-v1'),
  registry_before_digest: sha,
  effective_projection_digest: sha,
  predecessor: z
    .strictObject({
      id: sha,
      sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      decision: decisions
    })
    .nullable(),
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  decision: decisions,
  reason: z.enum(['scoped_approval', 'qualification_withdrawn', 'maintenance_ended', 'authority_withdrawn', 'confirmed_incompatibility', 'authority_deleted']),
  prior_deny_ids: ids,
  independent_review_ids: ids.refine(values => values.length > 0),
  authorization_reference_ids: ids.refine(values => values.length > 0)
});
const decisionReasons = {
  approve: 'scoped_approval',
  demote: 'qualification_withdrawn',
  retire: 'maintenance_ended',
  revoke: 'authority_withdrawn',
  invalidate: 'confirmed_incompatibility',
  delete: 'authority_deleted'
} as const;
function parseDecision(input: unknown): PromotionDecision {
  const parsed = decisionSchema.safeParse(input);
  if (!parsed.success) return reject('decision_schema');
  const decision: PromotionDecision = parsed.data;
  if (
    Buffer.byteLength(canonical(decision)) > 256 * 1024 ||
    canonical(decision.scope) !== canonical(decision.proposed_scope) ||
    decision.grants.some(grant => !decision.requested_grants.includes(grant)) ||
    (decision.grants.includes('children') && decision.scope.lane.topology === 'root') ||
    decision.sequence !== (decision.predecessor ? decision.predecessor.sequence + 1 : 1) ||
    decision.predecessor?.decision === 'delete' ||
    decision.reason !== decisionReasons[decision.decision]
  ) {
    return reject('decision_contract');
  }
  if (decision.decision === 'approve') {
    if (
      decision.grants.length === 0 ||
      decision.accepted_validation_ids.length === 0 ||
      decision.prior_deny_ids.length !== 0 ||
      (decision.predecessor !== null && decision.predecessor.decision !== 'approve')
    ) {
      return reject('decision_approval');
    }
  } else if (decision.predecessor === null) {
    return reject('decision_predecessor');
  }
  return decision;
}
function scopeKey(scope: PromotionDecision['scope']): string {
  const lane = scope.lane;
  return [lane.product, scope.target.version, lane.route, lane.profile_id, lane.operation, lane.topology, scope.platform, scope.runtime].join(':');
}
function validateDecisionScope(descriptor: ToolVersionPromotionDescriptor, decision: PromotionDecisionPayload) {
  const scope = descriptor.scopes.find(scope => scope.operation === decision.scope.lane.operation && scope.topology === decision.scope.lane.topology);
  if (
    descriptor.product !== decision.scope.lane.product ||
    descriptor.version !== decision.scope.target.version ||
    descriptor.sourceRef !== decision.scope.target.commit ||
    descriptor.route !== decision.scope.lane.route ||
    descriptor.profileId !== decision.scope.lane.profile_id ||
    !descriptor.platforms.includes(decision.scope.platform) ||
    !descriptor.runtimes.includes(decision.scope.runtime) ||
    promotionDescriptorDigest(descriptor) !== decision.descriptor_digest ||
    !scope ||
    decision.requested_grants.some(grant => !scope.grants.includes(grant)) ||
    decision.grants.some(grant => !scope.grants.includes(grant))
  ) {
    return reject('decision_scope');
  }
}
export function previewToolVersionPromotion(
  before: ToolVersionPromotionProjection,
  descriptor: ToolVersionPromotionDescriptor,
  input: PromotionDecisionPayload
): ToolVersionPromotionProjection {
  const { registry_before_digest, effective_projection_digest, ...decision } = parseDecision({
    ...input,
    registry_before_digest: promotionProjectionDigest(before),
    effective_projection_digest: '0'.repeat(64)
  });
  void registry_before_digest;
  void effective_projection_digest;
  validateDecisionScope(descriptor, decision);
  if (decision.implementation_digest !== before.implementation_digest) {
    return reject('implementation_changed');
  }
  const key = scopeKey(decision.scope);
  const previous = before.facets.find(facet => scopeKey(facet.decision.scope) === key);
  const facet = { descriptor, decision };
  let facets = before.facets.filter(facet => scopeKey(facet.decision.scope) !== key);
  let denials = before.denials;
  switch (decision.decision) {
    case 'approve':
      if (denials.some(denial => scopeKey(denial.decision.scope) === key)) return reject('prior_denial');
      facets = [...facets, facet];
      break;
    case 'demote':
      if (!previous || decision.grants.some(grant => !previous.decision.grants.includes(grant)) || decision.grants.some(grant => grant !== 'admission')) {
        return reject('demotion_subset');
      }
      if (decision.grants.length > 0) facets = [...facets, facet];
      denials = [...denials, facet];
      break;
    case 'retire':
    case 'revoke':
    case 'invalidate':
    case 'delete':
      if (decision.grants.length !== 0) return reject('denial_grants');
      denials = [...denials, facet];
      break;
    default:
      return reject('decision_schema');
  }
  return {
    ...before,
    facets: [...facets].sort((a, b) => scopeKey(a.decision.scope).localeCompare(scopeKey(b.decision.scope), 'en')),
    denials
  };
}
export function projectToolVersionPromotions(input: ToolVersionPromotionInput): ToolVersionPromotionProjection {
  const descriptors = z.array(z.unknown()).max(256).parse(input.descriptors).map(parseToolVersionPromotionDescriptor);
  if (new Set(descriptors.map(descriptor => `${descriptor.product}:${descriptor.version}`)).size !== descriptors.length) return reject('duplicate_descriptor');
  const ledger = z
    .strictObject({
      schema_version: z.literal(1),
      records: z.array(z.strictObject({ id: sha, decision: z.unknown() })).max(256)
    })
    .safeParse(input.ledger);
  if (!ledger.success) return reject('ledger_schema');
  let projection: ToolVersionPromotionProjection = {
    schema_version: 1,
    registry_digest: sha.parse(input.registryDigest),
    implementation_digest: sha.parse(input.implementationDigest),
    facets: [],
    denials: []
  };
  const seen = new Set<string>();
  const tips = new Map<string, ToolVersionPromotionRecord>();
  for (const record of ledger.data.records) {
    const decision = parseDecision(record.decision);
    if (seen.has(record.id) || promotionDecisionDigest(decision) !== record.id) return reject('decision_id');
    const key = scopeKey(decision.scope);
    const previous = tips.get(key);
    if (
      (previous === undefined) !== (decision.predecessor === null) ||
      (previous !== undefined &&
        (decision.predecessor?.id !== previous.id ||
          decision.predecessor.sequence !== previous.decision.sequence ||
          decision.predecessor.decision !== previous.decision.decision))
    ) {
      return reject('decision_chain');
    }
    const descriptor = descriptors.find(descriptor => promotionDescriptorDigest(descriptor) === decision.descriptor_digest);
    if (!descriptor) return reject('descriptor_changed');
    if (promotionProjectionDigest(projection) !== decision.registry_before_digest) return reject('projection_before');
    const { registry_before_digest, effective_projection_digest, ...payload } = decision;
    void registry_before_digest;
    projection = previewToolVersionPromotion(projection, descriptor, payload);
    if (promotionProjectionDigest(projection) !== effective_projection_digest) return reject('projection_after');
    seen.add(record.id);
    tips.set(key, { id: record.id, decision });
  }
  return projection;
}
