import { lookupFileProfile, type RegisteredFileProfile } from './adapter-profiles.js';
import { EventSchema, type SourceCompatibility, SourceCompatibilitySchema } from './contracts.js';
import { productionSourceEvidence } from './readiness.js';
import type { Store } from './store.js';
import { getEffectiveCodexBindingAdmission } from './codex-binding-admission.js';
import { getEffectiveClaudeBindingAdmission } from './claude-binding-admission.js';
import { OrdinaryWindowSelectionSchema, resolveOrdinaryWindow } from './core/ordinary-window-policy.js';
import {
  lookupEffectiveToolVersionFacet,
  lookupToolVersionProfile,
  promotedToolVersionDescriptors,
  toolVersionPromotionProjection
} from './core/tool-version-profiles.js';
import { readToolVersionPromotionAuthority, recordToolVersionPromotionOrigin, toolVersionPromotionKey } from './core/tool-version-promotion-store.js';

export type CompatibilitySource = SourceCompatibility['source'];
export type CompatibilityBlockReason = 'contract_failed' | 'semantic_incompatibility';
export const compatibilityRuleRevision = 'forward-version-v1';
const stableVersion = (value: string): number[] | null => {
  if (!/^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/.test(value)) return null;
  return value.split('.').map(Number);
};
const compare = (a: number[], b: number[]): number => {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
};
/** Finite application-owned windows, not a claim that semver implies stable semantics. */
export const sourceCompatibilityWindows = Object.freeze([
  { product: 'codex', source: 'file', base: '0.158.0', upper_exclusive: '0.164.0', profile_id: 'codex-file-checkpoint-v1' },
  { product: 'claude_code', source: 'file', base: '2.1.283', upper_exclusive: '2.2.0', profile_id: 'claude-file-message-components-v1' },
  { product: 'codex', source: 'codex_workflow', base: '0.160.0', upper_exclusive: '0.164.0', profile_id: 'codex-workflow-own-response-v1' },
  { product: 'codex', source: 'codex_workflow', base: '0.160.0', upper_exclusive: '0.164.0', profile_id: 'codex-workflow-direct-child-v1' },
  { product: 'claude_code', source: 'claude_workflow', base: '2.1.296', upper_exclusive: '2.2.0', profile_id: 'claude-workflow-own-trace-v1' }
] as const);

export function resolveSourceCompatibility(
  product: string,
  version: string,
  source: CompatibilitySource,
  profileId?: string,
  operation = 'collect',
  topology = 'root'
): SourceCompatibility | null {
  const numbers = stableVersion(version);
  if (!numbers || !['codex', 'claude_code'].includes(product)) return null;
  const claudeBindingAdmission = getEffectiveClaudeBindingAdmission(version, operation, topology);
  if (source === 'claude_binding') {
    return product === 'claude_code' && claudeBindingAdmission && (profileId === undefined || profileId === claudeBindingAdmission.profileId)
      ? SourceCompatibilitySchema.parse({
          state: claudeBindingAdmission.qualified ? 'verified' : 'compatibility_unverified',
          product,
          product_version: version,
          source,
          parser_version: version,
          parser_revision: claudeBindingAdmission.profileId,
          profile_id: claudeBindingAdmission.profileId,
          rule_revision: compatibilityRuleRevision
        })
      : null;
  }
  const bindingAdmission = getEffectiveCodexBindingAdmission(version, operation, topology);
  if (source === 'codex_binding') {
    return product === 'codex' && bindingAdmission && (profileId === undefined || profileId === bindingAdmission.profileId)
      ? SourceCompatibilitySchema.parse({
          state: bindingAdmission.qualified ? 'verified' : 'compatibility_unverified',
          product,
          product_version: version,
          source,
          parser_version: version,
          parser_revision: bindingAdmission.profileId,
          profile_id: bindingAdmission.profileId,
          rule_revision: compatibilityRuleRevision
        })
      : null;
  }
  const file = source === 'file' ? lookupFileProfile(product, version) : 'unsupported';
  const native =
    source === 'file'
      ? undefined
      : productionSourceEvidence.find(
          row =>
            row.product === product &&
            row.product_version === version &&
            row.profile_id.includes('-workflow-') &&
            (profileId === undefined || row.profile_id === profileId) &&
            (product === 'codex' ? source === 'codex_workflow' : source === 'claude_workflow')
        );
  const exactId =
    file !== 'unsupported'
      ? file.product === 'claude_code'
        ? 'claude-file-message-components-v1'
        : file.boundaryMode === 'legacy'
          ? 'codex-file-legacy-v1'
          : 'codex-file-checkpoint-v1'
      : native?.profile_id;
  if (exactId && (profileId === undefined || profileId === exactId)) {
    return SourceCompatibilitySchema.parse({
      state: 'verified',
      product,
      product_version: version,
      source,
      parser_version: version,
      parser_revision: exactId,
      profile_id: exactId,
      rule_revision: compatibilityRuleRevision
    });
  }
  const window = sourceCompatibilityWindows.find(
    row =>
      row.product === product &&
      row.source === source &&
      (profileId === undefined || row.profile_id === profileId) &&
      compare(numbers, stableVersion(row.base)!) > 0 &&
      compare(numbers, stableVersion(row.upper_exclusive)!) < 0
  );
  if (!window) return null;
  return SourceCompatibilitySchema.parse({
    state: 'compatibility_unverified',
    product,
    product_version: version,
    source,
    parser_version: window.base,
    parser_revision: window.profile_id,
    profile_id: window.profile_id,
    rule_revision: compatibilityRuleRevision
  });
}

export function lookupCompatibleFileProfile(product: string, version: string, pinned?: SourceCompatibility): RegisteredFileProfile | 'unsupported' {
  const compatibility = pinned ?? resolveSourceCompatibility(product, version, 'file');
  if (
    !compatibility ||
    compatibility.product !== product ||
    compatibility.product_version !== version ||
    compatibility.source !== 'file' ||
    compatibility.state === 'invalidated' ||
    compatibility.rule_revision !== compatibilityRuleRevision
  )
    return 'unsupported';
  const selected = resolveSourceCompatibility(product, compatibility.parser_version, 'file', compatibility.profile_id);
  if (!selected || selected.state !== 'verified' || selected.parser_revision !== compatibility.parser_revision) return 'unsupported';
  const permitted = resolveSourceCompatibility(product, version, 'file', compatibility.profile_id);
  if (!permitted) return 'unsupported';
  return lookupFileProfile(product, compatibility.parser_version);
}

export function effectiveSourceCompatibility(store: Store, input: SourceCompatibility): SourceCompatibility {
  const compatibility = SourceCompatibilitySchema.parse(input);
  const blocked = store.get('SELECT 1 FROM source_compatibility_blocks WHERE product=? AND product_version=? AND source=?', [
    compatibility.product,
    compatibility.product_version,
    compatibility.source
  ]);
  if (blocked || !promotionCompatibilityAllowed(store, compatibility)) {
    return { ...compatibility, state: 'invalidated' };
  }
  return compatibility;
}
function promotionCompatibilityAllowed(store: Store, compatibility: SourceCompatibility): boolean {
  if (compatibility.source !== 'codex_binding' && compatibility.source !== 'claude_binding') return true;
  if (resolveOrdinaryWindow(compatibility.product, compatibility.product_version, compatibility.profile_id)) return true;
  const legacy = lookupToolVersionProfile(compatibility.product, compatibility.product_version)?.ordinaryBinding;
  if (legacy?.profileId === compatibility.profile_id) return true;
  if (
    store.get(
      `SELECT 1 FROM tool_version_promotion_denials WHERE json_extract(key_json,'$.product')=?
      AND json_extract(key_json,'$.product_version')=? AND json_extract(key_json,'$.source')=?
      AND json_extract(key_json,'$.profile_id')=?`,
      [compatibility.product, compatibility.product_version, compatibility.source, compatibility.profile_id]
    )
  )
    return false;
  const facets = [...toolVersionPromotionProjection.facets, ...toolVersionPromotionProjection.denials].filter(
    facet =>
      facet.descriptor.product === compatibility.product &&
      facet.descriptor.version === compatibility.product_version &&
      facet.descriptor.route === compatibility.source &&
      facet.descriptor.profileId === compatibility.profile_id &&
      facet.decision.scope.lane.operation === 'collect' &&
      facet.decision.scope.platform === `${process.platform}_${process.arch}` &&
      facet.decision.scope.runtime === `node${process.versions.node.split('.')[0]}`
  );
  const declared = promotedToolVersionDescriptors.some(
    descriptor =>
      descriptor.product === compatibility.product &&
      descriptor.version === compatibility.product_version &&
      descriptor.route === compatibility.source &&
      descriptor.profileId === compatibility.profile_id
  );
  const origin = store.get('SELECT 1 FROM tool_version_promotion_origins WHERE product=? AND product_version=? AND source=? AND profile_id=?', [
    compatibility.product,
    compatibility.product_version,
    compatibility.source,
    compatibility.profile_id
  ]);
  if (!declared && facets.length === 0) return !origin;
  // Historical compatibility pins lack a topology identity, so no overlapping denied scope may lend them authority.
  return (
    (!origin || declared) &&
    facets.length > 0 &&
    facets.every(
      facet =>
        readToolVersionPromotionAuthority(store, {
          key: toolVersionPromotionKey(facet),
          requiredGrants: compatibility.state === 'verified' ? ['admission', 'qualification'] : ['admission']
        }).state === 'allowed'
    )
  );
}
export function assertCompatibilityAllowed(store: Store, compatibility: SourceCompatibility): void {
  if (effectiveSourceCompatibility(store, compatibility).state === 'invalidated') throw new Error('compatibility_invalidated');
}
export function sessionCompatibility(store: Store, sessionId: string): SourceCompatibility | null {
  const row = store.get<{ payload: string }>('SELECT payload FROM session_source_compatibility WHERE session_id=?', [sessionId]);
  return row ? SourceCompatibilitySchema.parse(JSON.parse(row.payload) as unknown) : null;
}
export function pinSessionCompatibility(store: Store, sessionId: string, input: SourceCompatibility): void {
  const compatibility = SourceCompatibilitySchema.parse(input);
  const window = resolveOrdinaryWindow(compatibility.product, compatibility.product_version, compatibility.profile_id);
  const selected =
    window?.compatibility ?? resolveSourceCompatibility(compatibility.product, compatibility.product_version, compatibility.source, compatibility.profile_id);
  if (!selected || JSON.stringify(selected) !== JSON.stringify(compatibility)) throw new Error('compatibility_scope_mismatch');
  const admission = window
    ? undefined
    : compatibility.source === 'codex_binding'
      ? getEffectiveCodexBindingAdmission(compatibility.product_version)
      : compatibility.source === 'claude_binding'
        ? getEffectiveClaudeBindingAdmission(compatibility.product_version)
        : undefined;
  store.immediateTransaction(() => {
    assertCompatibilityAllowed(store, compatibility);
    if (window) {
      const row = store.get<{ selection: string }>(
        `SELECT w.selection FROM ordinary_window_selections w JOIN ordinary_tasks t ON t.task_id=w.task_id
        JOIN binding_root_segments s ON s.task_id=w.task_id AND s.root_session_id=t.selected_root_id
        JOIN ordinary_window_segments e ON e.root_session_id=s.root_session_id AND e.selection_hash=w.selection_hash
        JOIN sessions r ON r.id=s.root_session_id AND r.task_id=w.task_id AND r.parent_id IS NULL
        WHERE r.id=? AND s.state IN ('acquiring','observing') AND t.revoked_at IS NULL
          AND t.settings=w.selection AND t.settings_hash=w.selection_hash
          AND t.price_table_id=json_extract(w.selection,'$.priceTableId')
          AND json_extract(e.proof,'$.productVersion')=?
          AND NOT EXISTS(SELECT 1 FROM comparison_assignments WHERE task_id=w.task_id)`,
        [sessionId, compatibility.product_version]
      );
      const selection = row ? OrdinaryWindowSelectionSchema.parse(JSON.parse(row.selection)) : null;
      if (
        !selection ||
        selection.declaredVersion !== compatibility.product_version ||
        selection.policy.product !== compatibility.product ||
        selection.policyDigest !== window.policyDigest
      )
        throw new Error('compatibility_scope_mismatch');
    }
    const session = store.get<{ product: string; product_version: string }>('SELECT product,product_version FROM sessions WHERE id=?', [sessionId]);
    if (!session || session.product !== compatibility.product || session.product_version !== compatibility.product_version)
      throw new Error('compatibility_scope_mismatch');
    const existing = sessionCompatibility(store, sessionId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(compatibility)) throw new Error('compatibility_conflict');
    if (!existing) store.execute('INSERT INTO session_source_compatibility(session_id,payload) VALUES (?,?)', [sessionId, JSON.stringify(compatibility)]);
    if (admission?.kind === 'promoted') {
      const facet = lookupEffectiveToolVersionFacet(
        compatibility.product,
        compatibility.product_version,
        'collect',
        'root',
        process.platform + '_' + process.arch,
        'node' + process.versions.node.split('.')[0]
      );
      if (!facet) throw new Error('compatibility_scope_mismatch');
      recordToolVersionPromotionOrigin(store, { key: toolVersionPromotionKey(facet), recordedAt: new Date().toISOString() });
    }
  });
}
export function invalidateCompatibility(store: Store, input: SourceCompatibility, reason: CompatibilityBlockReason): void {
  const compatibility = SourceCompatibilitySchema.parse(input);
  if (!['contract_failed', 'semantic_incompatibility'].includes(reason)) throw new Error('invalid_compatibility_reason');
  store.execute('INSERT OR IGNORE INTO source_compatibility_blocks(product,product_version,source,reason) VALUES (?,?,?,?)', [
    compatibility.product,
    compatibility.product_version,
    compatibility.source,
    reason
  ]);
}
/** Read-time trust overlay; immutable event bytes and replay fingerprints never change. */
export function overlayEventCompatibility(store: Store, input: import('zod').infer<typeof EventSchema>): import('zod').infer<typeof EventSchema> {
  const event = EventSchema.parse(input);
  if (event.payload.kind !== 'usage' || event.payload.product === 'synthetic') return event;
  if (!event.payload.source_compatibility) {
    // Binding observations always carry a pin; unpinned history predates that source.
    return store.get("SELECT 1 FROM source_compatibility_blocks WHERE product=? AND product_version=? AND source NOT IN ('codex_binding','claude_binding')", [
      event.payload.product,
      event.payload.product_version
    ])
      ? { ...event, payload: { ...event.payload, source_invalidated: true } }
      : event;
  }
  return { ...event, payload: { ...event.payload, source_compatibility: effectiveSourceCompatibility(store, event.payload.source_compatibility) } };
}
