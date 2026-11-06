import { z } from 'zod';
import { IdSchema, TimestampSchema } from '../contracts.js';
import type { Store } from '../store.js';
import {
  assertOrdinaryWindowDecision,
  matchingOrdinaryWindowRevocation,
  ordinaryWindowDecisionKeyForSelection,
  readOrdinaryWindowDecision,
  revokeOrdinaryWindowDecisionRow
} from './ordinary-window-activation.js';
import { OrdinaryWindowRevocationPacketSchema, type OrdinaryWindowScope } from './ordinary-window-decision.js';
export type { OrdinaryWindowScope } from './ordinary-window-decision.js';
import { assertOrdinaryWindowSegment, assertOrdinaryWindowDeletionFence, pauseOrdinaryWindowSegment } from './ordinary-window-trial.js';
export { ordinaryWindowRuntimeRevision } from './ordinary-window-decision.js';
export { pauseOrdinaryWindowSegment, terminateOrdinaryWindowTrial } from './ordinary-window-trial.js';
import {
  emptyOrdinaryWindowCoverage,
  OrdinaryWindowConnectionProofSchema,
  ordinaryWindowSelectionHash,
  type OrdinaryWindowSelection,
  OrdinaryWindowSelectionSchema,
  resolveOrdinaryWindow
} from './ordinary-window-policy.js';

export { ordinaryWindowSelectionHash } from './ordinary-window-policy.js';
export function ordinaryWindowSelection(store: Store, taskId: string): OrdinaryWindowSelection | undefined {
  const row = store.get<{ selection: string; selection_hash: string }>('SELECT selection,selection_hash FROM ordinary_window_selections WHERE task_id=?', [
    IdSchema.parse(taskId)
  ]);
  if (!row) return undefined;
  const selection = OrdinaryWindowSelectionSchema.parse(JSON.parse(row.selection));
  if (selection.taskId !== taskId || ordinaryWindowSelectionHash(selection) !== row.selection_hash) {
    throw new Error('ordinary_configuration_changed');
  }
  return selection;
}
export function assertOrdinaryWindowPrepared(store: Store, taskId: string): OrdinaryWindowSelection {
  const selection = ordinaryWindowSelection(store, taskId);
  if (!selection) throw new Error('ordinary_preparation_required');
  const task = store.get<{ project_id: string; state: string; metadata: string }>('SELECT project_id,state,metadata FROM tasks WHERE id=?', [taskId]);
  const prepared = store.get<{
    settings: string;
    settings_hash: string;
    price_table_id: string;
    revoked_at: string | null;
  }>('SELECT settings,settings_hash,price_table_id,revoked_at FROM ordinary_tasks WHERE task_id=?', [taskId]);
  if (
    !task ||
    !prepared ||
    prepared.revoked_at !== null ||
    task.state === 'finalized' ||
    store.get("SELECT 1 FROM tombstones WHERE (kind='task' AND id=?) OR (kind='project' AND id=?)", [taskId, selection.projectId])
  ) {
    throw new Error('binding_scope_revoked');
  }
  if (store.get('SELECT 1 FROM comparison_assignments WHERE task_id=?', [taskId])) {
    throw new Error('binding_ordinary_assignment_conflict');
  }
  const metadata = z.object({ product: z.string() }).parse(JSON.parse(task.metadata));
  if (
    task.project_id !== selection.projectId ||
    metadata.product !== selection.policy.product ||
    prepared.settings !== JSON.stringify(selection) ||
    prepared.settings_hash !== ordinaryWindowSelectionHash(selection) ||
    prepared.price_table_id !== selection.priceTableId
  ) {
    throw new Error('ordinary_configuration_changed');
  }
  if (!store.get('SELECT 1 FROM projects WHERE id=? AND local_root IS NOT NULL', [selection.projectId])) {
    throw new Error('binding_scope_mismatch');
  }
  return selection;
}
export function assertOrdinaryWindowAuthority(store: Store, scope: OrdinaryWindowScope): OrdinaryWindowSelection {
  const selection = assertOrdinaryWindowPrepared(store, scope.taskId);
  const task = store.get<{ state: string; generation: number }>('SELECT state,generation FROM tasks WHERE id=?', [scope.taskId]);
  if (!task || task.state !== 'active' || (scope.generation !== undefined && task.generation !== scope.generation)) {
    throw new Error('binding_scope_revoked');
  }
  if (
    store.get('SELECT 1 FROM source_compatibility_blocks WHERE product=? AND product_version=? AND source=?', [
      selection.policy.product,
      selection.declaredVersion,
      selection.policy.source
    ])
  ) {
    throw new Error('compatibility_invalidated');
  }
  const nativeRootId =
    scope.nativeRootId ??
    (scope.rootSessionId === undefined
      ? undefined
      : store.get<{ native_root_id: string }>('SELECT native_root_id FROM binding_root_segments WHERE root_session_id=?', [scope.rootSessionId])
          ?.native_root_id);
  assertOrdinaryWindowDecision(store, selection, { ...scope, ...(nativeRootId === undefined ? {} : { nativeRootId }) });
  if (scope.rootSessionId !== undefined) {
    assertOrdinaryWindowSegment(store, scope, selection);
  }
  return selection;
}
export function recordOrdinaryWindowSegment(store: Store, scope: OrdinaryWindowScope, proofInput: unknown): void {
  const proof = OrdinaryWindowConnectionProofSchema.parse(proofInput);
  store.immediateTransaction(() => {
    const selection = assertOrdinaryWindowAuthority(store, {
      taskId: scope.taskId,
      nativeRootId: proof.nativeSessionId,
      ...(scope.generation === undefined ? {} : { generation: scope.generation }),
      ...(scope.clock === undefined ? {} : { clock: scope.clock }),
      ...(scope.decisionRef === undefined ? {} : { decisionRef: scope.decisionRef })
    });
    if (!scope.rootSessionId || proof.product !== selection.policy.product || proof.productVersion !== selection.declaredVersion) {
      throw new Error('binding_identity_mismatch');
    }
    const segment = store.get<{
      root_session_id: string;
      product: string;
      native_root_id: string;
      project_root: string;
    }>("SELECT root_session_id,product,native_root_id,project_root FROM binding_root_segments WHERE root_session_id=? AND task_id=? AND state='acquiring'", [
      scope.rootSessionId,
      scope.taskId
    ]);
    if (
      !segment ||
      segment.product !== proof.product ||
      segment.native_root_id !== proof.nativeSessionId ||
      segment.project_root !== proof.cwd ||
      proof.cwd !== store.get<{ local_root: string }>('SELECT local_root FROM projects WHERE id=?', [selection.projectId])?.local_root
    ) {
      throw new Error('binding_identity_mismatch');
    }
    assertOrdinaryWindowDeletionFence(store, segment);
    store.execute('INSERT INTO ordinary_window_segments(root_session_id,selection_hash,proof,coverage) VALUES (?,?,?,?)', [
      scope.rootSessionId,
      ordinaryWindowSelectionHash(selection),
      JSON.stringify(proof),
      JSON.stringify(emptyOrdinaryWindowCoverage())
    ]);
  });
}
export function ordinaryWindowStatus(store: Store, taskId: string) {
  const selection = assertOrdinaryWindowPrepared(store, taskId);
  let reason = 'binding_window_unavailable';
  try {
    assertOrdinaryWindowAuthority(store, { taskId });
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    if (
      ![
        'binding_scope_revoked',
        'binding_scope_mismatch',
        'compatibility_invalidated',
        'binding_window_activation_required',
        'binding_window_trial_expired',
        'binding_window_trial_budget_exhausted'
      ].includes(error.message)
    )
      throw error;
    reason = error.message;
  }
  return {
    schemaVersion: 2,
    mode: 'ordinary_window',
    policyId: selection.policy.policyId,
    declaredVersion: selection.declaredVersion,
    state: 'unavailable',
    reason,
    automaticChildren: false,
    inference: false
  };
}
export function assertOrdinaryWindowSurfaceClosed(store: Store, taskId: string): void {
  if (!ordinaryWindowSelection(store, taskId)) {
    const orphan = store.get(
      `SELECT 1 FROM ordinary_tasks WHERE task_id=? AND json_extract(settings,'$.mode')='ordinary_window'
      UNION ALL SELECT 1 FROM ordinary_window_forget_fences WHERE task_id=? LIMIT 1`,
      [taskId, taskId]
    );
    if (orphan) throw new Error('binding_window_unavailable');
    return;
  }
  const status = ordinaryWindowStatus(store, taskId);
  throw new Error(status.reason);
}
export function revokeOrdinaryWindowActivation(store: Store, taskId: string, at: string): void {
  const selection = assertOrdinaryWindowPrepared(store, taskId);
  const key = ordinaryWindowDecisionKeyForSelection(selection);
  const decision = readOrdinaryWindowDecision(store, key);
  if (!decision) throw new Error('binding_window_activation_required');
  revokeOrdinaryWindowDecision(
    store,
    { schema_version: 1, kind: 'ordinary_window_revocation', ...key, decision_ref: decision.decision_ref, reason: 'operator_revoked' },
    at
  );
}
export function revokeOrdinaryWindowDecision(store: Store, input: unknown, at: string) {
  const packet = OrdinaryWindowRevocationPacketSchema.parse(input);
  const timestamp = TimestampSchema.parse(at);
  return store.immediateTransaction(() => {
    const decision = matchingOrdinaryWindowRevocation(store, packet);
    if (decision.revoked_at !== null) return decision;
    revokeOrdinaryWindowDecisionRow(store, decision, { at: timestamp, reason: packet.reason });
    const affected = store.all<{ task_id: string }>(
      `SELECT task_id FROM ordinary_window_selections WHERE
      json_extract(selection,'$.projectId')=? AND json_extract(selection,'$.policyDigest')=? AND (? IS NULL OR task_id=?)
      AND (? IS NULL OR task_id IN (SELECT t.task_id FROM ordinary_tasks t
        JOIN binding_root_segments s ON s.root_session_id=t.selected_root_id WHERE s.native_root_id=? AND s.project_root=?))`,
      [
        decision.project_id,
        decision.policy_digest,
        decision.trial_task_id,
        decision.trial_task_id,
        decision.trial_native_root_id,
        decision.trial_native_root_id,
        decision.trial_project_root
      ]
    );
    for (const row of affected) {
      pauseOrdinaryWindowSegment(store, row.task_id, timestamp, 'binding_scope_revoked');
    }
    return { ...decision, revoked_at: timestamp, revocation_reason: packet.reason };
  });
}
export function ordinaryWindowCompatibility(store: Store, taskId: string) {
  const selection = assertOrdinaryWindowPrepared(store, taskId);
  const resolved = resolveOrdinaryWindow(selection.policy.product, selection.declaredVersion, selection.policy.policyId);
  if (!resolved) throw new Error('binding_version_out_of_window');
  return resolved.compatibility;
}

type CodexWindowSourcePhase = 'metadata' | 'acquiring' | 'observing';
export interface CodexWindowSourceContext {
  readonly selection: OrdinaryWindowSelection;
  readonly decisionRef: string;
  readonly projectRoot: string;
  readonly rootSessionId: string | null;
  readonly cursor: string | null;
  readonly nativeRootId: string | null;
  readonly sourceRef: string | null;
  readonly sourceIdentity: string | null;
}
export type CodexWindowSourceAuthorization = () => CodexWindowSourceContext;
const codexWindowSourceAuthorizations = new WeakMap<
  CodexWindowSourceAuthorization,
  {
    readonly phase: CodexWindowSourcePhase;
    readonly authorize: CodexWindowSourceAuthorization;
  }
>();

export function issueCodexWindowSourceAuthorization(
  store: Store,
  inputScope: OrdinaryWindowScope,
  phase: CodexWindowSourcePhase
): CodexWindowSourceAuthorization {
  const prepared = assertOrdinaryWindowAuthority(store, {
    taskId: inputScope.taskId,
    ...(inputScope.generation === undefined ? {} : { generation: inputScope.generation }),
    ...(inputScope.clock === undefined ? {} : { clock: inputScope.clock }),
    ...(inputScope.decisionRef === undefined ? {} : { decisionRef: inputScope.decisionRef })
  });
  const decision = assertOrdinaryWindowDecision(store, prepared, inputScope);
  const scope = Object.freeze({ ...inputScope, decisionRef: decision.decision_ref });
  const generation = scope.generation;
  if (phase === 'observing' && scope.cursor === undefined) {
    throw new Error('binding_scope_revoked');
  }
  if (generation === undefined || (phase !== 'metadata' && (!scope.rootSessionId || scope.segmentRevision === undefined))) {
    throw new Error('binding_scope_revoked');
  }
  const authorize = (): CodexWindowSourceContext => {
    const selection = assertOrdinaryWindowAuthority(store, {
      taskId: scope.taskId,
      generation,
      decisionRef: scope.decisionRef,
      ...(scope.clock === undefined ? {} : { clock: scope.clock }),
      ...(phase === 'observing' ? scope : {})
    });
    if (selection.policy.product !== 'codex' || selection.policy.evidenceMode !== 'source_only') {
      throw new Error('binding_window_unavailable');
    }
    const projectRoot = store.get<{ local_root: string }>('SELECT local_root FROM projects WHERE id=?', [selection.projectId])?.local_root;
    if (!projectRoot) throw new Error('binding_scope_mismatch');
    let nativeRootId: string | null = null;
    let sourceRef: string | null = null;
    let sourceIdentity: string | null = null;
    if (phase === 'acquiring') {
      const segment = store.get<{
        root_session_id: string;
        product: string;
        native_root_id: string;
        project_root: string;
        revision: number;
      }>(
        `SELECT s.* FROM binding_root_segments s
        JOIN ordinary_tasks t ON t.task_id=s.task_id AND t.selected_root_id=s.root_session_id
        WHERE s.root_session_id=? AND s.task_id=? AND s.state='acquiring'`,
        [scope.rootSessionId, scope.taskId]
      );
      if (!segment || segment.product !== 'codex' || segment.revision !== scope.segmentRevision || segment.project_root !== projectRoot) {
        throw new Error('binding_scope_revoked');
      }
      assertOrdinaryWindowDeletionFence(store, segment);
      assertOrdinaryWindowAuthority(store, {
        taskId: scope.taskId,
        generation,
        nativeRootId: segment.native_root_id,
        decisionRef: scope.decisionRef,
        ...(scope.clock === undefined ? {} : { clock: scope.clock })
      });
      if (
        store.get('SELECT 1 FROM binding_root_segments WHERE product=? AND native_root_id=? AND root_session_id!=?', [
          segment.product,
          segment.native_root_id,
          segment.root_session_id
        ])
      ) {
        throw new Error('binding_fresh_root_required');
      }
      nativeRootId = segment.native_root_id;
    } else if (phase === 'observing') {
      const row = store.get<{ proof: string }>('SELECT proof FROM ordinary_window_segments WHERE root_session_id=?', [scope.rootSessionId]);
      if (!row) throw new Error('binding_scope_revoked');
      const proof = OrdinaryWindowConnectionProofSchema.parse(JSON.parse(row.proof));
      nativeRootId = proof.nativeSessionId;
      sourceRef = proof.sourceRef;
      sourceIdentity = proof.sourceIdentity;
    }
    return {
      selection,
      decisionRef: scope.decisionRef,
      projectRoot,
      rootSessionId: scope.rootSessionId ?? null,
      cursor: scope.cursor ?? null,
      nativeRootId,
      sourceRef,
      sourceIdentity
    };
  };
  authorize();
  codexWindowSourceAuthorizations.set(authorize, { phase, authorize });
  return authorize;
}

export function assertCodexWindowSourceAuthorization(
  authorization: CodexWindowSourceAuthorization,
  access: 'metadata' | 'source' | 'observe'
): CodexWindowSourceContext {
  const issued = codexWindowSourceAuthorizations.get(authorization);
  if (!issued || (access !== 'metadata' && issued.phase === 'metadata') || (access === 'observe' && issued.phase !== 'observing')) {
    throw new Error('binding_scope_revoked');
  }
  return issued.authorize();
}
