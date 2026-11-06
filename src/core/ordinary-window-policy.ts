import { createHash } from 'node:crypto';
import { z } from 'zod';
import { IdSchema, ProductVersionSchema, SourceCompatibilitySchema, TimestampSchema } from '../contracts.js';

const stableVersion = z.string().regex(/^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/);
export const OrdinaryWindowPolicyIdSchema = z.enum(['codex-binding-root-window-v1', 'claude-binding-root-window-v1']);
export const OrdinaryWindowEvidenceModeSchema = z.enum(['source_only', 'publisher_verified_local_pin']);
export const OrdinaryWindowPolicySchema = z.strictObject({
  schemaVersion: z.literal(2),
  policyId: OrdinaryWindowPolicyIdSchema,
  ruleRevision: IdSchema,
  product: z.enum(['codex', 'claude_code']),
  source: z.enum(['codex_binding', 'claude_binding']),
  baseVersion: stableVersion,
  upperExclusive: stableVersion,
  parserProfileId: IdSchema,
  parserRevision: IdSchema,
  algorithmId: IdSchema,
  finalityContractId: IdSchema,
  identityPolicyRevision: IdSchema,
  ownershipPolicyRevision: z.literal('root-source-ownership-unverified-v1'),
  evidenceMode: OrdinaryWindowEvidenceModeSchema,
  operations: z.tuple([z.literal('link'), z.literal('collect'), z.literal('restart')]).readonly(),
  maxDepth: z.literal(0),
  maxMembers: z.literal(1),
  trust: z.literal('compatibility_unverified')
});
export type OrdinaryWindowPolicy = z.infer<typeof OrdinaryWindowPolicySchema>;
const common = {
  schemaVersion: 2,
  ownershipPolicyRevision: 'root-source-ownership-unverified-v1',
  operations: ['link', 'collect', 'restart'],
  maxDepth: 0,
  maxMembers: 1,
  trust: 'compatibility_unverified'
} as const;
export const ordinaryWindowPolicies = Object.freeze([
  Object.freeze(
    OrdinaryWindowPolicySchema.parse({
      ...common,
      policyId: 'codex-binding-root-window-v1',
      ruleRevision: 'codex-ordinary-root-window-v1',
      product: 'codex',
      source: 'codex_binding',
      baseVersion: '0.163.0',
      upperExclusive: '0.170.0',
      parserProfileId: 'codex-binding-01630-direct-family-v1',
      parserRevision: 'codex-binding-root-window-v1',
      algorithmId: 'codex_root_response_v1',
      finalityContractId: 'codex_root_response_window_v1',
      identityPolicyRevision: 'codex-source-only-v1',
      evidenceMode: 'source_only'
    })
  ),
  Object.freeze(
    OrdinaryWindowPolicySchema.parse({
      ...common,
      policyId: 'claude-binding-root-window-v1',
      ruleRevision: 'claude-ordinary-root-window-v1',
      product: 'claude_code',
      source: 'claude_binding',
      baseVersion: '2.1.306',
      upperExclusive: '2.2.0',
      parserProfileId: 'claude-binding-2-1-306-family-v1',
      parserRevision: 'claude-binding-root-window-v1',
      algorithmId: 'claude_terminal_message_v1',
      finalityContractId: 'claude_terminal_message_window_v1',
      identityPolicyRevision: 'claude-publisher-local-pin-v1',
      evidenceMode: 'publisher_verified_local_pin'
    })
  )
]);
export const ordinaryWindowDigest = (value: OrdinaryWindowPolicy): string =>
  createHash('sha256')
    .update(JSON.stringify(OrdinaryWindowPolicySchema.parse(value)))
    .digest('hex');
const compare = (left: string, right: string): number => {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (const index of [0, 1, 2]) {
    const x = a[index];
    const y = b[index];
    if (x !== undefined && y !== undefined && x !== y) return x - y;
  }
  return 0;
};
export function resolveOrdinaryWindow(product: string, version: string, policyId?: string) {
  if (!stableVersion.safeParse(version).success) return null;
  const policy = ordinaryWindowPolicies.find(
    row =>
      row.product === product &&
      (policyId === undefined || row.policyId === policyId) &&
      compare(version, row.baseVersion) > 0 &&
      compare(version, row.upperExclusive) < 0
  );
  if (!policy) return null;
  return {
    policy,
    policyDigest: ordinaryWindowDigest(policy),
    compatibility: SourceCompatibilitySchema.parse({
      state: policy.trust,
      product: policy.product,
      product_version: version,
      source: policy.source,
      parser_version: policy.baseVersion,
      parser_revision: policy.parserRevision,
      profile_id: policy.policyId,
      rule_revision: policy.ruleRevision
    })
  };
}
export const OrdinaryWindowSelectionSchema = z
  .strictObject({
    schemaVersion: z.literal(2),
    mode: z.literal('ordinary_window'),
    taskId: IdSchema,
    projectId: IdSchema,
    declaredVersion: stableVersion,
    policy: OrdinaryWindowPolicySchema,
    policyDigest: z.string().regex(/^[a-f0-9]{64}$/),
    priceTableId: IdSchema,
    preparedAt: TimestampSchema
  })
  .refine(value => {
    const resolved = resolveOrdinaryWindow(value.policy.product, value.declaredVersion, value.policy.policyId);
    return resolved !== null && resolved.policyDigest === value.policyDigest && JSON.stringify(resolved.policy) === JSON.stringify(value.policy);
  });
export type OrdinaryWindowSelection = z.infer<typeof OrdinaryWindowSelectionSchema>;
const proofFields = {
  schemaVersion: z.literal(2),
  receipt: z.uuid(),
  recordedAt: TimestampSchema,
  nativeSessionId: IdSchema,
  sourceRef: z.string().min(1).max(4096),
  sourceIdentity: IdSchema,
  cwd: z.string().min(1).max(4096),
  productVersion: ProductVersionSchema,
  agentId: z.null(),
  rootOwnership: z.literal('unverified'),
  possibleChildContribution: z.literal('unknown'),
  mappedImageProof: z.literal('unverified')
};
export const OrdinaryWindowConnectionProofSchema = z.discriminatedUnion('mode', [
  z.strictObject({
    ...proofFields,
    mode: z.literal('codex_source_only'),
    product: z.literal('codex'),
    processId: z.null(),
    processStart: z.null(),
    nativePinDigest: z.null(),
    sourceVersionBasis: z.literal('root_creation_header'),
    lifecycle: z.literal('startup'),
    writerVersion: z.literal('unverified'),
    publisherProof: z.literal('unavailable')
  }),
  z.strictObject({
    ...proofFields,
    mode: z.literal('claude_publisher_local_pin'),
    product: z.literal('claude_code'),
    processId: IdSchema,
    processStart: IdSchema,
    nativePinDigest: z.string().regex(/^[a-f0-9]{64}$/),
    sourceVersionBasis: z.literal('scoped_source'),
    publisherProof: z.literal('verified_disk_assets')
  })
]);
export type OrdinaryWindowConnectionProof = z.infer<typeof OrdinaryWindowConnectionProofSchema>;
export const OrdinaryWindowCoverageSchema = z
  .strictObject({
    schemaVersion: z.literal(2),
    scope: z.literal('root_only'),
    rootOwnership: z.literal('unverified'),
    possibleChildContribution: z.literal('unknown'),
    childrenStatus: z.literal('unobserved'),
    detectionCompleteness: z.literal('unknown'),
    detectedChildren: z
      .array(
        z.strictObject({
          identity: IdSchema,
          firstSeenAt: TimestampSchema,
          basis: z.enum(['root_linked_receipt', 'scoped_directory_metadata']),
          parentRelation: z.enum(['verified', 'unverified']),
          usage: z.null(),
          cost: z.null()
        })
      )
      .max(4096),
    status: z.enum(['missing', 'partial', 'invalidated']),
    reason: IdSchema.nullable()
  })
  .refine(value => new Set(value.detectedChildren.map(child => child.identity)).size === value.detectedChildren.length);
export type OrdinaryWindowCoverage = z.infer<typeof OrdinaryWindowCoverageSchema>;
export function emptyOrdinaryWindowCoverage(): OrdinaryWindowCoverage {
  return {
    schemaVersion: 2,
    scope: 'root_only',
    rootOwnership: 'unverified',
    possibleChildContribution: 'unknown',
    childrenStatus: 'unobserved',
    detectionCompleteness: 'unknown',
    detectedChildren: [],
    status: 'missing',
    reason: null
  };
}
