import { createHash } from 'node:crypto';
import { lookupEffectiveToolVersionFacet } from '../core/tool-version-profiles.js';
import { readToolVersionPromotionAuthority, type ToolVersionPromotionAuthority, toolVersionPromotionKey } from '../core/tool-version-promotion-store.js';
import { assertOrdinaryWindowSurfaceClosed } from '../core/ordinary-window-store.js';
import type { BindingProduct, PromotionBindingAuthority, SessionBindingProvider } from '../session-binding-contract.js';
import type { Store } from '../store.js';

export function issuePromotionBindingAuthority(
  store: Store,
  selection: {
    readonly taskId: string;
    readonly product: BindingProduct;
    readonly productVersion: string;
    readonly topology: 'root' | 'bounded_family';
    readonly bundleContract: 'codex-promoted-bundle-v1' | 'claude-promoted-bundle-v1';
    readonly assertProducerContract?: () => void;
  }
): PromotionBindingAuthority {
  const { taskId, product, productVersion, topology, bundleContract } = selection;
  if (bundleContract !== (product === 'codex' ? 'codex-promoted-bundle-v1' : 'claude-promoted-bundle-v1')) {
    throw new Error('promoted_producer_contract_unverified');
  }
  const facet = lookupEffectiveToolVersionFacet(
    product,
    productVersion,
    'collect',
    topology,
    `${process.platform}_${process.arch}`,
    `node${process.versions.node.split('.')[0]}`
  );
  if (!facet) throw new Error('promoted_provider_unavailable');
  const key = toolVersionPromotionKey(facet);
  const grants = facet.decision.grants;
  const lifecycle = (nativeRootId?: string) => {
    assertOrdinaryWindowSurfaceClosed(store, taskId);
    const task = store.get<{ project_id: string; state: string; generation: number }>('SELECT project_id,state,generation FROM tasks WHERE id=?', [taskId]);
    if (!task || store.get("SELECT 1 FROM tombstones WHERE (kind='task' AND id=?) OR (kind='project' AND id=?)", [taskId, task.project_id])) {
      throw new Error('deleted_identifier');
    }
    if (
      task.state === 'finalized' ||
      store.get('SELECT 1 FROM ordinary_tasks WHERE task_id=? AND revoked_at IS NOT NULL', [taskId]) ||
      store.get('SELECT 1 FROM binding_collection_controls WHERE task_id=? AND revoked_at IS NOT NULL', [taskId])
    ) {
      throw new Error('binding_scope_revoked');
    }
    const project = store.get<{ local_root: string }>('SELECT local_root FROM projects WHERE id=?', [task.project_id]);
    if (!project) throw new Error('deleted_identifier');
    const nativeRoots = store.all<{ native_root_id: string }>(
      `SELECT native_root_id FROM binding_root_segments WHERE task_id=? AND state!='closed'
      UNION SELECT COALESCE(json_extract(identity,'$.nativeMapping.nativeSessionId'),json_extract(identity,'$.sessionId')) AS native_root_id
      FROM session_bindings WHERE task_id=? AND session_id=root_id`,
      [taskId, taskId]
    );
    const roots = [...nativeRoots.map(row => row.native_root_id), ...(nativeRootId === undefined ? [] : [nativeRootId])];
    for (const root of roots) {
      if (
        store.get(
          `SELECT 1 FROM binding_native_tombstones WHERE product=? AND native_session_id=?
          UNION ALL SELECT 1 FROM tombstones WHERE kind='session' AND id=?
          UNION ALL SELECT 1 FROM session_binding_forgets WHERE product=? AND native_session_id=?`,
          [product, root, root, product, root]
        )
      ) {
        throw new Error('deleted_identifier');
      }
    }
    return JSON.stringify([
      task,
      project,
      store.all('SELECT root_session_id,native_root_id,state,revision FROM binding_root_segments WHERE task_id=? ORDER BY root_session_id', [taskId]),
      store.all('SELECT session_id,root_id,state,generation,identity FROM session_bindings WHERE task_id=? ORDER BY session_id', [taskId])
    ]);
  };
  const assertAuthorized: PromotionBindingAuthority['assertAuthorized'] = (nativeRootId, operation = 'collect') => {
    const beforeLifecycle = lifecycle(nativeRootId);
    const currentKey = {
      ...key,
      operation,
      topology: operation === 'collect' ? topology : ('root' as const)
    };
    const requiredGrants = operation === 'collect' ? grants : grants.filter(grant => grant !== 'children');
    const current = readToolVersionPromotionAuthority(store, {
      key: currentKey,
      requiredGrants
    });
    if (current.state === 'denied') {
      throw new Error('promotion_authority_denied');
    }
    if (current.state !== 'allowed') {
      throw new Error('promotion_authority_missing');
    }
    if (selection.assertProducerContract) {
      selection.assertProducerContract();
      if (lifecycle(nativeRootId) !== beforeLifecycle) {
        throw new Error('binding_scope_revoked');
      }
      const verified = readToolVersionPromotionAuthority(store, {
        key: currentKey,
        requiredGrants
      });
      if (verified.state === 'denied') {
        throw new Error('promotion_authority_denied');
      }
      if (verified.state !== 'allowed') {
        throw new Error('promotion_authority_missing');
      }
      if (verified.generation !== current.generation || verified.projectionDigest !== current.projectionDigest) {
        throw new Error('promotion_generation_changed');
      }
    }
    return current;
  };
  assertAuthorized();
  return {
    key,
    producerContract: 'promoted-payload-v1',
    grants,
    assertAuthorized
  };
}

export function promotionBindingCheckpoint(provider: Pick<SessionBindingProvider, 'promotionAuthority'>): ToolVersionPromotionAuthority | undefined {
  return provider.promotionAuthority?.assertAuthorized();
}

export function assertPromotionBindingCheckpoint(
  provider: Pick<SessionBindingProvider, 'promotionAuthority'>,
  expected: ToolVersionPromotionAuthority | undefined
): void {
  const current = promotionBindingCheckpoint(provider);
  if (current?.generation !== expected?.generation || current?.projectionDigest !== expected?.projectionDigest) {
    throw new Error('promotion_generation_changed');
  }
}

export function promotionBindingBaseline(
  store: Store,
  source: {
    readonly product: BindingProduct;
    readonly sessionId: string;
    readonly sourceIdentity: string;
    readonly assertAuthorized: () => void;
  }
) {
  const staged = new Set<string>();
  const keyFor = (requestId: string) =>
    createHash('sha256')
      .update(JSON.stringify(['binding-request-v1', source.product, requestId]))
      .digest('hex');
  const addMany = (requestIds: readonly string[]) => {
    source.assertAuthorized();
    for (const requestId of requestIds) staged.add(requestId);
  };
  return {
    has: (requestId: string) => {
      source.assertAuthorized();
      return (
        staged.has(requestId) ||
        !!store.get('SELECT 1 FROM binding_baseline_exclusions WHERE session_id=? AND source_identity=? AND request_key=?', [
          source.sessionId,
          source.sourceIdentity,
          keyFor(requestId)
        ])
      );
    },
    add: (requestId: string) => addMany([requestId]),
    addMany,
    commit: () => {
      source.assertAuthorized();
      for (const requestId of staged) {
        store.execute('INSERT OR IGNORE INTO binding_baseline_exclusions(session_id,source_identity,request_key) VALUES (?,?,?)', [
          source.sessionId,
          source.sourceIdentity,
          keyFor(requestId)
        ]);
      }
      source.assertAuthorized();
    }
  };
}
