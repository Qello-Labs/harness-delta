import { createHash } from 'node:crypto';
import { z } from 'zod';
import { IdSchema, TimestampSchema } from '../contracts.js';
import type { BindingUsageRecord } from '../session-binding-contract.js';
import type { Store } from '../store.js';
import {
  OrdinaryWindowConnectionProofSchema,
  OrdinaryWindowCoverageSchema,
  type OrdinaryWindowSelection,
  ordinaryWindowSelectionHash,
  OrdinaryWindowSelectionSchema
} from './ordinary-window-policy.js';
import type { OrdinaryWindowDecision, OrdinaryWindowScope } from './ordinary-window-decision.js';
import {
  ordinaryWindowDecisionKeyForSelection,
  ordinaryWindowDecisionKeyValues,
  ordinaryWindowDecisionWhere,
  readOrdinaryWindowDecision,
  revokeOrdinaryWindowDecisionRow
} from './ordinary-window-activation.js';

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

function ownsOrdinaryWindowSegment(store: Store, scope: OrdinaryWindowScope, selection: OrdinaryWindowSelection): boolean {
  if (scope.cursor === undefined || scope.segmentRevision === undefined) {
    return false;
  }
  try {
    assertOrdinaryWindowSegment(store, scope, selection);
    return true;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return false;
  }
}

export function terminateOrdinaryWindowTrial(
  store: Store,
  scope: OrdinaryWindowScope,
  termination: {
    readonly at: string;
    readonly reason: 'trial_expired' | 'trial_budget_exhausted' | 'trial_failed';
  }
): boolean {
  return store.immediateTransaction(() => {
    const row = store.get<{
      selection: string;
      selection_hash: string;
      settings: string;
      settings_hash: string;
      price_table_id: string;
      project_id: string;
      generation: number;
      selected_root_id: string | null;
    }>(
      `SELECT w.selection,w.selection_hash,o.settings,o.settings_hash,o.price_table_id,t.project_id,t.generation,o.selected_root_id FROM ordinary_window_selections w
      JOIN tasks t ON t.id=w.task_id JOIN ordinary_tasks o ON o.task_id=t.id WHERE t.id=?`,
      [scope.taskId]
    );
    if (!row || scope.generation === undefined || row.generation !== scope.generation) return false;
    const parsed = OrdinaryWindowSelectionSchema.safeParse(JSON.parse(row.selection));
    if (
      !parsed.success ||
      parsed.data.taskId !== scope.taskId ||
      parsed.data.projectId !== row.project_id ||
      row.selection_hash !== ordinaryWindowSelectionHash(parsed.data) ||
      row.settings_hash !== row.selection_hash ||
      row.settings !== JSON.stringify(parsed.data) ||
      row.price_table_id !== parsed.data.priceTableId ||
      store.get('SELECT 1 FROM comparison_assignments WHERE task_id=?', [scope.taskId])
    ) {
      return false;
    }
    const decision = readOrdinaryWindowDecision(store, ordinaryWindowDecisionKeyForSelection(parsed.data));
    if (
      !decision ||
      decision.revoked_at !== null ||
      decision.decision_kind !== 'trial' ||
      decision.trial_task_id !== scope.taskId ||
      scope.decisionRef !== decision.decision_ref
    ) {
      return false;
    }
    if (scope.rootSessionId === undefined) {
      if (row.selected_root_id !== null) return false;
    } else {
      const segment = store.get<{
        revision: number;
        state: string;
        native_root_id: string;
        cursor: string | null;
      }>(
        `SELECT s.revision,s.state,s.native_root_id,b.cursor FROM binding_root_segments s
        LEFT JOIN session_bindings b ON b.session_id=s.root_session_id
        WHERE s.root_session_id=? AND s.task_id=? AND s.state IN ('acquiring','observing')`,
        [scope.rootSessionId, scope.taskId]
      );
      if (
        row.selected_root_id !== scope.rootSessionId ||
        !segment ||
        segment.native_root_id !== decision.trial_native_root_id ||
        (scope.segmentRevision !== undefined && segment.revision !== scope.segmentRevision) ||
        (scope.cursor !== undefined && segment.cursor !== scope.cursor)
      ) {
        return false;
      }
      if (segment.state === 'observing' && !ownsOrdinaryWindowSegment(store, scope, parsed.data)) return false;
    }
    revokeOrdinaryWindowDecisionRow(store, decision, termination);
    pauseOrdinaryWindowSegment(store, scope.taskId, termination.at, `binding_window_${termination.reason}`);
    return true;
  });
}

export interface OrdinaryWindowTrialCharge {
  readonly decision: Extract<OrdinaryWindowDecision, { decision_kind: 'trial' }>;
  readonly nextTokens: number;
}
export function stageOrdinaryWindowTrialCharge(
  store: Store,
  selection: OrdinaryWindowSelection,
  batch: {
    readonly rootSessionId: string;
    readonly sourceIdentity: string;
    readonly records: readonly {
      readonly key: string;
      readonly record: BindingUsageRecord;
    }[];
  }
): OrdinaryWindowTrialCharge | null {
  const decision = readOrdinaryWindowDecision(store, ordinaryWindowDecisionKeyForSelection(selection));
  if (!decision || decision.decision_kind !== 'trial') return null;
  const seen = new Map<string, string>();
  let nextTokens = decision.trial_tokens_consumed;
  for (const { key, record } of batch.records) {
    const fingerprint = JSON.stringify(record);
    const previous = seen.get(key);
    if (previous !== undefined) {
      if (previous !== fingerprint) {
        throw new Error('binding_request_conflict');
      }
      continue;
    }
    seen.set(key, fingerprint);
    const committed = store.get<{ fingerprint: string }>('SELECT fingerprint FROM binding_requests WHERE request_key=?', [key]);
    if (committed) {
      if (committed.fingerprint !== createHash('sha256').update(fingerprint).digest('hex')) throw new Error('binding_request_conflict');
      continue;
    }
    if (
      store.get('SELECT 1 FROM binding_baseline_exclusions WHERE session_id=? AND source_identity=? AND request_key=?', [
        batch.rootSessionId,
        batch.sourceIdentity,
        key
      ])
    ) {
      continue;
    }
    const input = record.payload.input_total;
    const output = record.payload.output_total;
    if (input.status !== 'observed' || output.status !== 'observed') {
      throw new Error('binding_window_trial_usage_unmeasurable');
    }
    if (input.value > decision.trial_token_limit - nextTokens - output.value) throw new Error('binding_window_trial_budget_exhausted');
    nextTokens += input.value + output.value;
  }
  return { decision, nextTokens };
}
export function commitOrdinaryWindowTrialCharge(store: Store, charge: OrdinaryWindowTrialCharge | null): boolean {
  if (!charge) return false;
  store.execute(
    `UPDATE ordinary_window_activations SET trial_tokens_consumed=?
    WHERE ${ordinaryWindowDecisionWhere} AND decision_ref=? AND revoked_at IS NULL AND trial_tokens_consumed=?`,
    [charge.nextTokens, ...ordinaryWindowDecisionKeyValues(charge.decision), charge.decision.decision_ref, charge.decision.trial_tokens_consumed]
  );
  return charge.nextTokens === charge.decision.trial_token_limit;
}
