import { lookupToolVersionProfile, orderedToolVersionProfiles } from './core/tool-version-profiles.js';
import { familyProviderError } from './binding-family-diagnostics.js';
import { comparisonProtocol, protocolRow } from './core/protocol-store.js';
import { Lifecycle } from './lifecycle.js';
import { parseTaskMetadata, type FlexibleProtocol } from './flexible-contracts.js';
import { ClaudeSessionBindingProvider } from './session-binding-claude.js';
import { bindingCollectionControl, registerBindingCollectionControl } from './external-session-contract.js';
import { bindingIdentityKey, VerifiedSessionIdentitySchema, type SessionBindingProvider, type VerifiedSessionIdentity } from './session-binding-contract.js';
import type { Store } from './store.js';

/** Isolated descriptive pilot, never an ordinary production admission. */
const pilotProfiles = orderedToolVersionProfiles('humanPilot', 'claude_code');
export const claudeHumanPilotProfileId = lookupToolVersionProfile('claude_code', '2.1.294')?.humanPilot?.profileId as 'claude-ordinary-human-pilot';
export interface ClaudeHumanPilotScope {
  readonly taskId: string;
}
interface Scope {
  store: Store;
  taskId: string;
  provider: ClaudeSessionBindingProvider;
  metadata: string;
  protocol: string;
  projectRoot: string;
  collection: string;
  version: string;
  openedAt: number;
}
const scopes = new WeakMap<ClaudeHumanPilotScope, Scope>();
export function isClaudeHumanPilotProtocol(protocol: FlexibleProtocol): boolean {
  return (
    protocol.purpose === 'functional_pilot' &&
    protocol.source_profiles.length === 1 &&
    protocol.source_profiles.every(
      p => p.product === 'claude_code' && p.profile_id === claudeHumanPilotProfileId && pilotProfiles.some(candidate => candidate.version === p.product_version)
    )
  );
}
function context(store: Store, taskId: string) {
  const task = new Lifecycle(store).task(taskId);
  const metadata = parseTaskMetadata(JSON.parse(task.metadata) as unknown);
  const assignment = store.get<{ protocol_id: string }>('SELECT protocol_id FROM comparison_assignments WHERE task_id=?', [taskId]);
  if (!assignment) throw new Error('binding_pilot_scope_invalid');
  const protocol = comparisonProtocol(store, protocolRow(store, assignment.protocol_id));
  const project = store.get<{ local_root: string }>('SELECT local_root FROM projects WHERE id=?', [task.project_id]);
  if (
    metadata.product !== 'claude_code' ||
    protocol.schema_version !== 2 ||
    !isClaudeHumanPilotProtocol(protocol) ||
    protocol.project_id !== task.project_id ||
    !project
  )
    throw new Error('binding_pilot_scope_invalid');
  return {
    metadata: task.metadata,
    protocol: JSON.stringify(protocol),
    projectRoot: project.local_root,
    collection: JSON.stringify(bindingCollectionControl(store, taskId) ?? null),
    version: protocol.source_profiles[0]!.product_version
  };
}
export function issueClaudeHumanPilotScope(
  store: Store,
  taskId: string,
  provider: ClaudeSessionBindingProvider,
  options: { untilExplicitStop?: boolean } = {}
): ClaudeHumanPilotScope {
  if (!(provider instanceof ClaudeSessionBindingProvider)) throw new Error('binding_pilot_scope_invalid');
  provider.assertProjectRoot(context(store, taskId).projectRoot);
  if (options.untilExplicitStop && !bindingCollectionControl(store, taskId)) registerBindingCollectionControl(store, taskId);
  const scope = Object.freeze({ taskId });
  scopes.set(scope, { store, taskId, provider, ...context(store, taskId), openedAt: Date.now() });
  return scope;
}
export const isClaudeHumanPilotScope = (scope: ClaudeHumanPilotScope) => scopes.has(scope);
export function assertClaudeHumanPilotScope(scope: ClaudeHumanPilotScope, store: Store, taskId: string, provider?: SessionBindingProvider): void {
  const original = scopes.get(scope);
  const current = context(store, taskId);
  if (
    !original ||
    original.store !== store ||
    original.taskId !== taskId ||
    (provider && provider !== original.provider) ||
    current.metadata !== original.metadata ||
    current.protocol !== original.protocol ||
    current.projectRoot !== original.projectRoot ||
    current.collection !== original.collection
  )
    throw new Error('binding_pilot_scope_invalid');
}
function members(store: Store, taskId: string) {
  return store
    .all<{ identity: string }>('SELECT identity FROM session_bindings WHERE task_id=?', [taskId])
    .map(row => VerifiedSessionIdentitySchema.parse(JSON.parse(row.identity) as unknown));
}
function rejectSource(reason: string): never {
  throw familyProviderError(new Error('binding_pilot_family_scope'), reason);
}
/** Callback is reached from exact receipt/path/stat metadata before any native row scan. */
export function assertClaudeHumanPilotSource(
  scope: ClaudeHumanPilotScope,
  store: Store,
  taskId: string,
  source: { nativeSessionId: string; agentId: string | null; sourceRef: string; sourceIdentity: string; birthtimeMs: number }
): void {
  assertClaudeHumanPilotScope(scope, store, taskId);
  const state = scopes.get(scope)!;
  const family = members(store, taskId);
  const root = family.find(member => member.parentSessionId === null);
  const id = source.agentId === null ? source.nativeSessionId : `${source.nativeSessionId}:${source.agentId}`;
  const bound = family.find(member => member.sessionId === id);
  if (bound) {
    if (bound.sourceRef !== source.sourceRef || bound.sourceIdentity !== source.sourceIdentity) rejectSource('pilot_source_identity_changed');
  } else if (source.agentId === null) {
    if (root) rejectSource('pilot_duplicate_root');
    if (!Number.isFinite(source.birthtimeMs)) rejectSource('pilot_source_time_invalid');
    if (source.birthtimeMs < state.openedAt) rejectSource('pilot_root_predates_observer');
  } else {
    if (!root) rejectSource('pilot_root_unlinked');
    if (root.sessionId !== source.nativeSessionId) rejectSource('pilot_native_session_mismatch');
    if (family.length >= 3) rejectSource('pilot_family_limit');
    if (source.birthtimeMs < Date.parse(root.createdAt)) rejectSource('pilot_member_predates_root');
  }
  if (root && source.nativeSessionId !== root.sessionId) rejectSource('pilot_native_session_mismatch');
}
export function checkClaudeHumanPilotIdentity(scope: ClaudeHumanPilotScope, store: Store, taskId: string, identity: VerifiedSessionIdentity): void {
  assertClaudeHumanPilotScope(scope, store, taskId);
  const state = scopes.get(scope)!;
  const family = members(store, taskId);
  const root = family.find(member => member.parentSessionId === null);
  const existing = family.find(member => member.sessionId === identity.sessionId);
  if (
    identity.product !== 'claude_code' ||
    identity.productVersion !== state.version ||
    identity.cwd !== state.projectRoot ||
    (existing && bindingIdentityKey(existing) !== bindingIdentityKey(identity)) ||
    (identity.parentSessionId === null && (root ? root.sessionId !== identity.sessionId : Date.parse(identity.createdAt) < state.openedAt)) ||
    (identity.parentSessionId !== null &&
      (!root || identity.parentSessionId !== root.sessionId || Date.parse(identity.createdAt) < Date.parse(root.createdAt))) ||
    (!existing && family.length >= 3)
  )
    throw familyProviderError(new Error('binding_pilot_family_scope'), 'pilot_identity_mismatch');
}
