import { lookupFileProfile, type RegisteredFileProfile } from './adapter-profiles.js';
import { EventSchema, SourceCompatibilitySchema, type SourceCompatibility } from './contracts.js';
import { productionSourceEvidence } from './readiness.js';
import type { Store } from './store.js';
import { codexBindingAdmission } from './codex-binding-admission.js';

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
  { product: 'claude_code', source: 'claude_workflow', base: '2.1.296', upper_exclusive: '2.2.0', profile_id: 'claude-workflow-own-trace-v1' },
] as const);

export function resolveSourceCompatibility(product: string, version: string, source: CompatibilitySource, profileId?: string): SourceCompatibility | null {
  const numbers = stableVersion(version);
  if (!numbers || !['codex', 'claude_code'].includes(product)) return null;
  if (source === 'codex_binding') return product === 'codex' &&
    version === codexBindingAdmission.productVersion &&
    (profileId === undefined || profileId === codexBindingAdmission.profileId)
    ? SourceCompatibilitySchema.parse({
      state: 'verified', product, product_version: version, source,
      parser_version: version, parser_revision: codexBindingAdmission.profileId,
      profile_id: codexBindingAdmission.profileId, rule_revision: compatibilityRuleRevision,
    }) : null;
  const file = source === 'file' ? lookupFileProfile(product, version) : 'unsupported';
  const native = source === 'file' ? undefined : productionSourceEvidence.find(row => row.product === product && row.product_version === version &&
    row.profile_id !== codexBindingAdmission.profileId &&
    (profileId === undefined || row.profile_id === profileId) && (product === 'codex' ? source === 'codex_workflow' : source === 'claude_workflow'));
  const exactId = file !== 'unsupported' ? file.product === 'claude_code' ? 'claude-file-message-components-v1' : file.boundaryMode === 'legacy' ? 'codex-file-legacy-v1' : 'codex-file-checkpoint-v1' : native?.profile_id;
  if (exactId && (profileId === undefined || profileId === exactId)) return SourceCompatibilitySchema.parse({
    state: 'verified', product, product_version: version, source, parser_version: version,
    parser_revision: exactId, profile_id: exactId, rule_revision: compatibilityRuleRevision,
  });
  const window = sourceCompatibilityWindows.find(row => row.product === product && row.source === source &&
    (profileId === undefined || row.profile_id === profileId) && compare(numbers, stableVersion(row.base)!) > 0 && compare(numbers, stableVersion(row.upper_exclusive)!) < 0);
  if (!window) return null;
  return SourceCompatibilitySchema.parse({ state: 'compatibility_unverified', product, product_version: version, source,
    parser_version: window.base, parser_revision: window.profile_id, profile_id: window.profile_id, rule_revision: compatibilityRuleRevision });
}

export function lookupCompatibleFileProfile(product: string, version: string, pinned?: SourceCompatibility): RegisteredFileProfile | 'unsupported' {
  const compatibility = pinned ?? resolveSourceCompatibility(product, version, 'file');
  if (!compatibility || compatibility.product !== product || compatibility.product_version !== version || compatibility.source !== 'file' ||
    compatibility.state === 'invalidated' || compatibility.rule_revision !== compatibilityRuleRevision) return 'unsupported';
  const selected = resolveSourceCompatibility(product, compatibility.parser_version, 'file', compatibility.profile_id);
  if (!selected || selected.state !== 'verified' || selected.parser_revision !== compatibility.parser_revision) return 'unsupported';
  const permitted = resolveSourceCompatibility(product, version, 'file', compatibility.profile_id);
  if (!permitted) return 'unsupported';
  return lookupFileProfile(product, compatibility.parser_version);
}

export function effectiveSourceCompatibility(store: Store, input: SourceCompatibility): SourceCompatibility {
  const compatibility = SourceCompatibilitySchema.parse(input);
  return store.get('SELECT 1 FROM source_compatibility_blocks WHERE product=? AND product_version=? AND source=?',
    [compatibility.product, compatibility.product_version, compatibility.source]) ? { ...compatibility, state: 'invalidated' } : compatibility;
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
  const selected = resolveSourceCompatibility(compatibility.product, compatibility.product_version, compatibility.source, compatibility.profile_id);
  if (!selected || JSON.stringify(selected) !== JSON.stringify(compatibility)) throw new Error('compatibility_scope_mismatch');
  store.immediateTransaction(() => {
    assertCompatibilityAllowed(store, compatibility);
    const session = store.get<{ product: string; product_version: string }>('SELECT product,product_version FROM sessions WHERE id=?', [sessionId]);
    if (!session || session.product !== compatibility.product || session.product_version !== compatibility.product_version) throw new Error('compatibility_scope_mismatch');
    const existing = sessionCompatibility(store, sessionId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(compatibility)) throw new Error('compatibility_conflict');
    if (!existing) store.execute('INSERT INTO session_source_compatibility(session_id,payload) VALUES (?,?)', [sessionId, JSON.stringify(compatibility)]);
  });
}
export function invalidateCompatibility(store: Store, input: SourceCompatibility, reason: CompatibilityBlockReason): void {
  const compatibility = SourceCompatibilitySchema.parse(input);
  if (!['contract_failed', 'semantic_incompatibility'].includes(reason)) throw new Error('invalid_compatibility_reason');
  store.execute('INSERT OR IGNORE INTO source_compatibility_blocks(product,product_version,source,reason) VALUES (?,?,?,?)',
    [compatibility.product, compatibility.product_version, compatibility.source, reason]);
}
/** Read-time trust overlay; immutable event bytes and replay fingerprints never change. */
export function overlayEventCompatibility(store: Store, input: import('zod').infer<typeof EventSchema>): import('zod').infer<typeof EventSchema> {
  const event = EventSchema.parse(input);
  if (event.payload.kind !== 'usage' || event.payload.product === 'synthetic') return event;
  if (!event.payload.source_compatibility) {
    // Binding observations always carry a pin; unpinned history predates that source.
    return store.get("SELECT 1 FROM source_compatibility_blocks WHERE product=? AND product_version=? AND source!='codex_binding'",
      [event.payload.product, event.payload.product_version]) ? { ...event, payload: { ...event.payload, source_invalidated: true } } : event;
  }
  return { ...event, payload: { ...event.payload, source_compatibility: effectiveSourceCompatibility(store, event.payload.source_compatibility) } };
}
