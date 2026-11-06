import { createHash } from 'node:crypto';
import { z } from 'zod';
import { IdSchema, TimestampSchema } from '../contracts.js';
import type { Store } from '../store.js';
import {
  emptyOrdinaryWindowCoverage,
  OrdinaryWindowConnectionProofSchema,
  OrdinaryWindowCoverageSchema,
  type OrdinaryWindowSelection,
  OrdinaryWindowSelectionSchema,
  resolveOrdinaryWindow
} from './ordinary-window-policy.js';

export const ordinaryWindowRuntimeRevision = 'ordinary-window-runtime-v1';
export const ordinaryWindowSelectionHash = (value: OrdinaryWindowSelection): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
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
export interface OrdinaryWindowScope {
  readonly taskId: string;
  readonly rootSessionId?: string;
  readonly generation?: number;
  readonly segmentRevision?: number;
  readonly cursor?: string | null;
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
  const decision = store.get<{
    accepted_risks: string;
    implementation_revision: string;
    evidence_ref: string;
    review_ref: string;
  }>(
    `SELECT accepted_risks,implementation_revision,evidence_ref,review_ref FROM ordinary_window_activations
    WHERE project_id=? AND product=? AND source=? AND policy_id=? AND policy_revision=? AND policy_digest=?
      AND evidence_mode=? AND revoked_at IS NULL`,
    [
      selection.projectId,
      selection.policy.product,
      selection.policy.source,
      selection.policy.policyId,
      selection.policy.ruleRevision,
      selection.policyDigest,
      selection.policy.evidenceMode
    ]
  );
  if (
    !decision ||
    decision.implementation_revision !== ordinaryWindowRuntimeRevision ||
    !IdSchema.safeParse(decision.evidence_ref).success ||
    !IdSchema.safeParse(decision.review_ref).success
  ) {
    throw new Error('binding_window_activation_required');
  }
  const risks = z.array(z.enum(['source_identity_limits', 'root_ownership_unverified'])).safeParse(JSON.parse(decision.accepted_risks));
  if (!risks.success || new Set(risks.data).size !== 2) {
    throw new Error('binding_window_activation_required');
  }
  if (scope.rootSessionId !== undefined) {
    assertOrdinaryWindowSegment(store, scope, selection);
  }
  return selection;
}
function assertOrdinaryWindowSegment(store: Store, scope: OrdinaryWindowScope, selection: OrdinaryWindowSelection): void {
  const row = store.get<{
    root_session_id: string;
    product: string;
    native_root_id: string;
    state: string;
    revision: number;
    project_root: string;
    proof: string;
    selection_hash: string;
    cursor: string | null;
    generation: number;
    identity: string;
    connect_receipt: string | null;
  }>(
    `SELECT s.*,w.proof,w.selection_hash,b.cursor,b.generation,b.identity,b.connect_receipt FROM binding_root_segments s
    JOIN ordinary_window_segments w ON w.root_session_id=s.root_session_id
    JOIN ordinary_tasks t ON t.task_id=s.task_id AND t.selected_root_id=s.root_session_id
    JOIN session_bindings b ON b.session_id=s.root_session_id AND b.root_id=s.root_session_id
    WHERE s.root_session_id=? AND s.task_id=? AND b.state='observing'`,
    [scope.rootSessionId, scope.taskId]
  );
  if (
    !row ||
    !['acquiring', 'observing'].includes(row.state) ||
    (scope.segmentRevision !== undefined && row.revision !== scope.segmentRevision) ||
    (scope.generation !== undefined && row.generation !== scope.generation) ||
    (scope.cursor !== undefined && row.cursor !== scope.cursor)
  ) {
    throw new Error('binding_scope_revoked');
  }
  const proof = OrdinaryWindowConnectionProofSchema.parse(JSON.parse(row.proof));
  const identity = z
    .object({
      sessionId: IdSchema,
      sourceRef: z.string(),
      sourceIdentity: IdSchema,
      product: z.string(),
      productVersion: z.string(),
      parentSessionId: z.null(),
      cwd: z.string(),
      nativeMapping: z.object({
        nativeSessionId: IdSchema,
        processId: IdSchema.nullable(),
        agentId: z.null()
      })
    })
    .parse(JSON.parse(row.identity));
  if (
    row.selection_hash !== ordinaryWindowSelectionHash(selection) ||
    row.product !== selection.policy.product ||
    proof.product !== row.product ||
    proof.productVersion !== selection.declaredVersion ||
    proof.nativeSessionId !== row.native_root_id ||
    proof.cwd !== row.project_root ||
    row.project_root !== store.get<{ local_root: string }>('SELECT local_root FROM projects WHERE id=?', [selection.projectId])?.local_root ||
    identity.cwd !== proof.cwd ||
    row.connect_receipt !== proof.receipt ||
    identity.nativeMapping.nativeSessionId !== proof.nativeSessionId ||
    identity.nativeMapping.processId !== proof.processId ||
    identity.sessionId !== row.native_root_id ||
    identity.product !== row.product ||
    identity.productVersion !== proof.productVersion ||
    identity.sourceRef !== proof.sourceRef ||
    identity.sourceIdentity !== proof.sourceIdentity
  ) {
    throw new Error('binding_identity_mismatch');
  }
  assertOrdinaryWindowDeletionFence(store, row);
}
function assertOrdinaryWindowDeletionFence(
  store: Store,
  segment: {
    readonly root_session_id: string;
    readonly product: string;
    readonly native_root_id: string;
  }
): void {
  if (
    store.get(
      `SELECT 1 FROM tombstones WHERE kind='session' AND (id=? OR (id=? AND NOT EXISTS(
      SELECT 1 FROM binding_native_tombstones WHERE native_session_id=?
    )))
    UNION ALL SELECT 1 FROM binding_native_tombstones WHERE product=? AND native_session_id=?
    UNION ALL SELECT 1 FROM session_binding_forgets WHERE product=? AND native_session_id=?`,
      [
        segment.root_session_id,
        segment.native_root_id,
        segment.native_root_id,
        segment.product,
        segment.native_root_id,
        segment.product,
        segment.native_root_id
      ]
    )
  )
    throw new Error('deleted_identifier');
}
export function recordOrdinaryWindowSegment(store: Store, scope: OrdinaryWindowScope, proofInput: unknown): void {
  const proof = OrdinaryWindowConnectionProofSchema.parse(proofInput);
  store.immediateTransaction(() => {
    const selection = assertOrdinaryWindowAuthority(store, {
      taskId: scope.taskId,
      ...(scope.generation === undefined ? {} : { generation: scope.generation })
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
    if (!['binding_scope_revoked', 'compatibility_invalidated', 'binding_window_activation_required'].includes(error.message)) throw error;
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
  if (!ordinaryWindowSelection(store, taskId)) return;
  const status = ordinaryWindowStatus(store, taskId);
  throw new Error(status.reason);
}
export function revokeOrdinaryWindowActivation(store: Store, taskId: string, at: string): void {
  const selection = assertOrdinaryWindowPrepared(store, taskId);
  const timestamp = TimestampSchema.parse(at);
  store.immediateTransaction(() => {
    store.execute(
      `UPDATE ordinary_window_activations SET revoked_at=? WHERE project_id=? AND product=? AND source=?
      AND policy_id=? AND policy_revision=? AND policy_digest=? AND evidence_mode=? AND revoked_at IS NULL`,
      [
        timestamp,
        selection.projectId,
        selection.policy.product,
        selection.policy.source,
        selection.policy.policyId,
        selection.policy.ruleRevision,
        selection.policyDigest,
        selection.policy.evidenceMode
      ]
    );
    const affected = store.all<{ task_id: string }>(
      `SELECT task_id FROM ordinary_window_selections WHERE
      json_extract(selection,'$.projectId')=? AND json_extract(selection,'$.policyDigest')=?`,
      [selection.projectId, selection.policyDigest]
    );
    for (const row of affected) {
      pauseOrdinaryWindowSegment(store, row.task_id, timestamp, 'binding_scope_revoked');
    }
  });
}
export function pauseOrdinaryWindowSegment(store: Store, taskId: string, at: string, reason: string): void {
  const timestamp = TimestampSchema.parse(at);
  const root = store.get<{ selected_root_id: string | null }>('SELECT selected_root_id FROM ordinary_tasks WHERE task_id=?', [taskId])?.selected_root_id;
  if (!root) return;
  store.execute("UPDATE binding_root_segments SET state='paused',revision=revision+1,observer_identity=NULL WHERE root_session_id=? AND state!='closed'", [
    root
  ]);
  store.execute("UPDATE session_bindings SET state='stopped' WHERE root_id=?", [root]);
  store.execute("UPDATE tasks SET state='paused',generation=generation+1,last_transition_at=? WHERE id=? AND state='active'", [timestamp, taskId]);
  store.execute('UPDATE active_intervals SET ended_at=? WHERE task_id=? AND ended_at IS NULL', [timestamp, taskId]);
  const existing = store.get<{ coverage: string }>('SELECT coverage FROM ordinary_window_segments WHERE root_session_id=?', [root]);
  if (existing) {
    const coverage = OrdinaryWindowCoverageSchema.parse(JSON.parse(existing.coverage));
    store.execute('UPDATE ordinary_window_segments SET coverage=? WHERE root_session_id=?', [
      JSON.stringify({
        ...coverage,
        status: reason === 'compatibility_invalidated' ? 'invalidated' : 'partial',
        reason
      }),
      root
    ]);
  }
}
export function ordinaryWindowCompatibility(store: Store, taskId: string) {
  const selection = assertOrdinaryWindowPrepared(store, taskId);
  const resolved = resolveOrdinaryWindow(selection.policy.product, selection.declaredVersion, selection.policy.policyId);
  if (!resolved) throw new Error('binding_version_out_of_window');
  return resolved.compatibility;
}
