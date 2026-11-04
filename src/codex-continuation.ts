import { isAbsolute, resolve } from 'node:path';
import { checkedCandidateScope, authorizeCandidateScope, type CandidateScope } from './nested-candidate.js';
import type { CodexCandidateSources } from './codex-candidate-rollout.js';
import type { Store } from './store.js';

/** Internal explicit candidate only; never discovers or admits product sources.
 * Each family retains the existing single-root/direct-child accounting rules.
 */
export interface CodexContinuationFamily {
  scope: CandidateScope;
  sources: CodexCandidateSources;
}
export function checkedCodexContinuation(input: readonly CodexContinuationFamily[]): CodexContinuationFamily[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 2) throw new Error('candidate_invalid_mapping');
  const families: CodexContinuationFamily[] = input.map((family: CodexContinuationFamily) => ({
    scope: checkedCandidateScope(family.scope),
    sources: { projectRoot: family.sources.projectRoot, paths: { ...family.sources.paths } }
  }));
  const first = families[0]!;
  const sessionIds = new Set<string>();
  const nativeIds = new Set<string>();
  const paths = new Set<string>();
  for (const { scope, sources } of families) {
    if (
      scope.projectId !== first.scope.projectId ||
      scope.taskId !== first.scope.taskId ||
      sources.projectRoot !== first.sources.projectRoot ||
      !isAbsolute(sources.projectRoot) ||
      resolve(sources.projectRoot) !== sources.projectRoot ||
      scope.sessions.length > 2 ||
      scope.sessions.some(session => session.product !== 'codex' || (session.parentSessionId !== null && session.parentSessionId !== session.rootSessionId)) ||
      Object.keys(sources.paths).length !== scope.sessions.length
    )
      throw new Error('candidate_invalid_mapping');
    for (const session of scope.sessions) {
      const path = sources.paths[session.sourceId];
      if (
        sessionIds.has(session.sessionId) ||
        nativeIds.has(session.nativeSessionId) ||
        typeof path !== 'string' ||
        !isAbsolute(path) ||
        resolve(path) !== path ||
        paths.has(path)
      )
        throw new Error('candidate_invalid_mapping');
      sessionIds.add(session.sessionId);
      nativeIds.add(session.nativeSessionId);
      paths.add(path);
    }
  }
  return families;
}
/** Authorize the entire exact manifest before opening even one source, including
 * temporarily unreadable old sources. Recheck at every family/read boundary.
 */
export function authorizeCodexContinuation(store: Store, families: readonly CodexContinuationFamily[]): void {
  const first = families[0]!;
  const links = store.all<{ id: string; source_path: string | null; local_root: string | null }>(
    'SELECT s.id,s.source_path,p.local_root FROM sessions s JOIN projects p ON p.id=s.project_id WHERE s.task_id=?',
    [first.scope.taskId]
  );
  if (links.length !== families.reduce((sum, family) => sum + family.scope.sessions.length, 0)) throw new Error('candidate_scope_mismatch');
  for (const { scope, sources } of families) {
    authorizeCandidateScope(store, scope);
    for (const session of scope.sessions) {
      const link = links.find(link => link.id === session.sessionId);
      if (!link || link.source_path !== sources.paths[session.sourceId] || link.local_root !== sources.projectRoot) throw new Error('candidate_scope_mismatch');
    }
  }
}
