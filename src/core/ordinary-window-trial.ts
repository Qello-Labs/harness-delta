import { createHash } from 'node:crypto';
import type { BindingUsageRecord } from '../session-binding-contract.js';
import type { Store } from '../store.js';
import { type OrdinaryWindowSelection, ordinaryWindowSelectionHash, OrdinaryWindowSelectionSchema } from './ordinary-window-policy.js';
import type { OrdinaryWindowDecision, OrdinaryWindowScope } from './ordinary-window-decision.js';
import {
  ordinaryWindowDecisionKeyForSelection,
  ordinaryWindowDecisionKeyValues,
  ordinaryWindowDecisionWhere,
  readOrdinaryWindowDecision,
  revokeOrdinaryWindowDecisionRow
} from './ordinary-window-activation.js';
import { assertOrdinaryWindowSegment, pauseOrdinaryWindowSegment } from './ordinary-window-segment.js';
export { assertOrdinaryWindowSegment, assertOrdinaryWindowDeletionFence, pauseOrdinaryWindowSegment } from './ordinary-window-segment.js';
export {
  clearOrdinaryWindowArming,
  clearTaskOrdinaryWindowArming,
  type OrdinaryWindowEmissionControl,
  readOrdinaryWindowControl,
  writeOrdinaryWindowControl
} from './ordinary-window-control.js';

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
