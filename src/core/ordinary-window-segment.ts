import { z } from 'zod';
import { IdSchema, TimestampSchema } from '../contracts.js';
import type { Store } from '../store.js';
import type { OrdinaryWindowScope } from './ordinary-window-decision.js';
import { queueTaskOrdinaryWindowEmissionControl } from './ordinary-window-activation.js';
import {
  OrdinaryWindowConnectionProofSchema,
  OrdinaryWindowCoverageSchema,
  type OrdinaryWindowSelection,
  ordinaryWindowSelectionHash
} from './ordinary-window-policy.js';

export function assertOrdinaryWindowSegment(store: Store, scope: OrdinaryWindowScope, selection: OrdinaryWindowSelection): void {
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
export function assertOrdinaryWindowDeletionFence(
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
  ) {
    throw new Error('deleted_identifier');
  }
}
export function pauseOrdinaryWindowSegment(store: Store, taskId: string, at: string, reason: string): void {
  const timestamp = TimestampSchema.parse(at);
  store.immediateTransaction(() => {
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
    queueTaskOrdinaryWindowEmissionControl(store, taskId);
  });
}
