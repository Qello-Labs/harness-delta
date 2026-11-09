import { z } from 'zod';
import { TimestampSchema } from '../contracts.js';
import type { Store } from '../store.js';
import { toolVersionPromotionProjection } from './tool-version-profiles.js';
import {
  promotionDescriptorDigest,
  promotionProjectionDigest,
  promotionRegistryDigest,
  type ToolVersionPromotionFacet,
  type ToolVersionPromotionProjection
} from './tool-version-promotion.js';

const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const keySchema = z
  .strictObject({
    product: z.enum(['codex', 'claude_code']),
    productVersion: z.string().regex(/^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/),
    source: z.enum(['codex_binding', 'claude_binding']),
    profileId: identifier,
    operation: z.enum(['link', 'collect', 'restart', 'resume']),
    topology: z.enum(['root', 'bounded_family']),
    descriptorLineage: z.string().regex(/^[a-f0-9]{40}$/),
    platform: z.enum(['darwin_arm64', 'darwin_x64', 'linux_arm64', 'linux_x64', 'win32_x64']),
    runtime: z.enum(['node24', 'node26'])
  })
  .readonly();
export type ToolVersionPromotionKey = z.infer<typeof keySchema>;
const reasonSchema = z.enum(['revoke', 'retire', 'invalidate', 'delete']);
const denialSchema = z.strictObject({
  key: keySchema,
  reason: reasonSchema,
  recordedAt: TimestampSchema
});
const grantSchema = z.enum(['admission', 'children', 'qualification']);
const querySchema = z.strictObject({
  key: keySchema,
  requiredGrants: z
    .array(grantSchema)
    .min(1)
    .max(3)
    .refine(values => new Set(values).size === values.length)
    .readonly()
});
export function toolVersionPromotionKey(facet: ToolVersionPromotionFacet): ToolVersionPromotionKey {
  const { descriptor, decision } = facet;
  return keySchema.parse({
    product: descriptor.product,
    productVersion: descriptor.version,
    source: descriptor.route,
    profileId: descriptor.profileId,
    operation: decision.scope.lane.operation,
    topology: decision.scope.lane.topology,
    // Same-release descriptor successors retain this lineage even when their content IDs change.
    descriptorLineage: descriptor.sourceRef,
    platform: decision.scope.platform,
    runtime: decision.scope.runtime
  });
}
function generation(store: Store): number {
  const row = store.get<{ generation: number }>('SELECT generation FROM tool_version_promotion_generation WHERE singleton=1');
  if (!row) throw new Error('promotion_generation_missing');
  return z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(row.generation);
}
function storedKey(key: ToolVersionPromotionKey) {
  const { productVersion, profileId, descriptorLineage, ...scope } = key;
  return {
    ...scope,
    product_version: productVersion,
    profile_id: profileId,
    descriptor_lineage: descriptorLineage
  };
}
export function recordToolVersionPromotionDenial(store: Store, input: z.input<typeof denialSchema>): string {
  const denial = denialSchema.parse(input);
  const scopeKey = promotionRegistryDigest(denial.key);
  const id = promotionRegistryDigest({
    key: denial.key,
    reason: denial.reason
  });
  store.immediateTransaction(() => {
    generation(store);
    store.execute('INSERT OR IGNORE INTO tool_version_promotion_denials(denial_id,scope_key,key_json,reason,recorded_at) VALUES (?,?,?,?,?)', [
      id,
      scopeKey,
      JSON.stringify(storedKey(denial.key)),
      denial.reason,
      denial.recordedAt
    ]);
  });
  return id;
}
export interface ToolVersionPromotionAuthority {
  readonly state: 'allowed' | 'denied' | 'missing_grant';
  readonly generation: number;
  readonly projectionDigest: string;
  readonly denialIds: readonly string[];
}
/** Promotion decisions cannot replace independent task, project or native-root fences. */
export function readToolVersionPromotionAuthority(
  store: Store,
  input: z.input<typeof querySchema>,
  projection: ToolVersionPromotionProjection = toolVersionPromotionProjection
): ToolVersionPromotionAuthority {
  const { key, requiredGrants } = querySchema.parse(input);
  const scopeKey = promotionRegistryDigest(key);
  const currentGeneration = generation(store);
  const rows = store.all<{ denial_id: string; key_json: string; reason: string }>(
    'SELECT denial_id,key_json,reason FROM tool_version_promotion_denials WHERE scope_key=? ORDER BY denial_id',
    [scopeKey]
  );
  for (const row of rows) {
    const reason = reasonSchema.parse(row.reason);
    if (row.key_json !== JSON.stringify(storedKey(key)) || promotionRegistryDigest({ key, reason }) !== row.denial_id) {
      throw new Error('promotion_denial_invalid');
    }
  }
  const matches = (facet: ToolVersionPromotionFacet) => promotionRegistryDigest(toolVersionPromotionKey(facet)) === scopeKey;
  const shipped = projection.denials.filter(facet => matches(facet) && requiredGrants.some(grant => !facet.decision.grants.includes(grant)));
  const denialIds = [...rows.map(row => row.denial_id), ...shipped.map(facet => promotionRegistryDigest(facet.decision))].sort();
  const facet = projection.facets.find(matches);
  const allowed =
    facet !== undefined &&
    facet.decision.implementation_digest === projection.implementation_digest &&
    facet.decision.descriptor_digest === promotionDescriptorDigest(facet.descriptor) &&
    requiredGrants.every(grant => facet.decision.grants.includes(grant)) &&
    (key.topology === 'root' || facet.decision.grants.includes('children'));
  return {
    state: denialIds.length ? 'denied' : allowed ? 'allowed' : 'missing_grant',
    generation: currentGeneration,
    projectionDigest: promotionProjectionDigest(projection),
    denialIds
  };
}
