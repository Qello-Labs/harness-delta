import { createHash } from 'node:crypto';
import { z } from 'zod';
import { TimestampSchema } from './contracts.js';
import { isClaudeModel } from './claude-binding-admission.js';
import { isCodexGptModel } from './codex-binding-admission.js';
import { type OrdinaryWindowCoverage, OrdinaryWindowCoverageSchema } from './core/ordinary-window-policy.js';
import {
  assertOrdinaryWindowAuthority,
  ordinaryWindowCompatibility,
  ordinaryWindowSelection,
  type OrdinaryWindowScope,
  pauseOrdinaryWindowSegment,
  terminateOrdinaryWindowTrial
} from './core/ordinary-window-store.js';
import { ordinaryWindowDecisionKeyForSelection, readOrdinaryWindowDecision } from './core/ordinary-window-activation.js';
import { commitOrdinaryWindowTrialCharge, stageOrdinaryWindowTrialCharge } from './core/ordinary-window-trial.js';
import { putUsageWithEvidence, recordObservationGap } from './core/runtime-history.js';
import { invalidateCompatibility, pinSessionCompatibility } from './source-compatibility.js';
import {
  bindingIdentityKey,
  type BindingUsageRecord,
  BindingUsageRecordSchema,
  type OrdinaryWindowUsageBatch,
  type SessionBindingProvider,
  type VerifiedSessionIdentity,
  VerifiedSessionIdentitySchema
} from './session-binding-contract.js';
import type { Store } from './store.js';

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const contractFailures = new Set([
  'binding_contract_failed',
  'binding_usage_invalid',
  'binding_request_conflict',
  'binding_finality_unsupported',
  'binding_ownership_unverified',
  'binding_source_version_mismatch',
  'candidate_invalid_metadata',
  'candidate_conflict',
  'candidate_unsupported_history',
  'unsupported_history',
  'token_overflow'
]);
const segmentFailures = new Set([
  'source_changed',
  'source_unavailable',
  'binding_source_changed',
  'binding_source_unavailable',
  'binding_executable_changed',
  'binding_executable_identity_unverified',
  'binding_fresh_root_required',
  'binding_identity_unavailable',
  'binding_receipt_stale',
  'binding_scope_revoked'
]);
interface WindowBindingRow {
  readonly session_id: string;
  readonly identity: string;
  readonly cursor: string | null;
  readonly generation: number;
  readonly observed_since: string;
  readonly connect_receipt: string | null;
  readonly revision: number;
}
function ordinaryWindowReadContext(options: Parameters<typeof readOrdinaryWindowBatch>[0]) {
  const { store, taskId, rootSessionId, clock } = options;
  const selection = ordinaryWindowSelection(store, taskId);
  if (!selection) throw new Error('ordinary_preparation_required');
  const row = store.get<WindowBindingRow>(
    `SELECT b.*,s.revision FROM session_bindings b
    JOIN binding_root_segments s ON s.root_session_id=b.session_id WHERE b.session_id=? AND b.task_id=?`,
    [rootSessionId, taskId]
  );
  if (!row) {
    assertOrdinaryWindowAuthority(store, { taskId, rootSessionId, clock });
    throw new Error('binding_scope_revoked');
  }
  const decision = readOrdinaryWindowDecision(store, ordinaryWindowDecisionKeyForSelection(selection));
  const scope: OrdinaryWindowScope = {
    taskId,
    rootSessionId,
    generation: row.generation,
    segmentRevision: row.revision,
    cursor: row.cursor,
    clock,
    ...(decision === null ? {} : { decisionRef: decision.decision_ref })
  };
  try {
    assertOrdinaryWindowAuthority(store, scope);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    terminateOrdinaryWindowTrial(store, scope, {
      at: clock(),
      reason:
        error.message === 'binding_window_trial_expired'
          ? 'trial_expired'
          : error.message === 'binding_window_trial_budget_exhausted'
            ? 'trial_budget_exhausted'
            : 'trial_failed'
    });
    throw error;
  }
  const identity = VerifiedSessionIdentitySchema.parse(JSON.parse(row.identity));
  return { selection, row, scope, identity };
}
export async function readOrdinaryWindowBatch(options: {
  readonly store: Store;
  readonly taskId: string;
  readonly rootSessionId: string;
  readonly baseline: boolean;
  readonly provider: (authorizeSource: (identity: VerifiedSessionIdentity) => void, scope: OrdinaryWindowScope) => SessionBindingProvider | undefined;
  readonly clock: () => string;
}): Promise<void> {
  const { store, taskId, rootSessionId, baseline, clock } = options;
  const { selection, row, scope, identity } = ordinaryWindowReadContext(options);
  const authorize = (input = identity): void => {
    assertOrdinaryWindowAuthority(store, scope);
    if (bindingIdentityKey(input) !== bindingIdentityKey(identity) || input.parentSessionId !== null || input.nativeMapping?.agentId != null) {
      throw new Error('binding_root_only_required');
    }
  };
  const staged = new Set<string>();
  const keyFor = (requestId: string) => hash(['binding-request-v1', identity.product, requestId]);
  const ledger = {
    has: (requestId: string) => {
      authorize();
      return (
        staged.has(requestId) ||
        !!store.get('SELECT 1 FROM binding_baseline_exclusions WHERE session_id=? AND source_identity=? AND request_key=?', [
          rootSessionId,
          identity.sourceIdentity,
          keyFor(requestId)
        ])
      );
    },
    add: (requestId: string) => {
      authorize();
      staged.add(requestId);
    },
    addMany: (ids: readonly string[]) => {
      authorize();
      for (const id of ids) staged.add(id);
    }
  };
  try {
    authorize();
    const provider = options.provider(authorize, scope);
    authorize();
    if (!provider) throw new Error('binding_provider_unavailable');
    if (
      provider.product !== selection.policy.product ||
      provider.capabilities().usage !== 'root_source_reference' ||
      !provider.readWindowUsage ||
      !provider.revalidateBound ||
      !row.connect_receipt
    ) {
      throw new Error('binding_window_unavailable');
    }
    const current = await provider.revalidateBound(
      {
        receipt: row.connect_receipt
      },
      identity
    );
    authorize(current);
    const batch = await provider.readWindowUsage(
      identity,
      baseline ? null : row.cursor,
      {
        taskId,
        projectId: selection.projectId,
        allowedRootTurnIds: ['binding-observation'],
        sessions: [
          {
            sessionId: rootSessionId,
            rootSessionId,
            parentSessionId: null,
            sourceId: identity.sessionId,
            product: identity.product,
            nativeSessionId: identity.nativeMapping?.nativeSessionId ?? identity.sessionId,
            agentId: null,
            processId: identity.nativeMapping?.processId ?? null
          }
        ]
      },
      { baseline, baselineLedger: ledger, authorizeSource: authorize }
    );
    authorize();
    const at = TimestampSchema.parse(clock());
    const { records, excluded, coverage } = parseWindowBatch(batch, identity, at);
    store.immediateTransaction(() => {
      authorize();
      const trialCharge = stageOrdinaryWindowTrialCharge(store, selection, {
        rootSessionId,
        sourceIdentity: identity.sourceIdentity,
        records: [...records, ...excluded].map(record => ({ key: keyFor(record.requestId), record }))
      });
      pinSessionCompatibility(store, rootSessionId, ordinaryWindowCompatibility(store, taskId));
      for (const record of excluded) ledger.add(record.requestId);
      for (const record of records) {
        if (baseline || Date.parse(record.occurredAt) < Date.parse(row.observed_since)) {
          ledger.add(record.requestId);
          continue;
        }
        if (ledger.has(record.requestId)) continue;
        commitRecord(store, {
          taskId,
          projectId: selection.projectId,
          rootSessionId,
          record,
          key: keyFor(record.requestId),
          at
        });
      }
      for (const requestId of staged) {
        store.execute('INSERT OR IGNORE INTO binding_baseline_exclusions(session_id,source_identity,request_key) VALUES (?,?,?)', [
          rootSessionId,
          identity.sourceIdentity,
          keyFor(requestId)
        ]);
      }
      mergeWindowCoverage(store, rootSessionId, coverage);
      if (batch.gaps.length) {
        recordObservationGap(store, taskId, rootSessionId, row.observed_since, at, 'incomplete', at);
      }
      authorize();
      store.execute('UPDATE session_bindings SET cursor=? WHERE session_id=?', [batch.cursor, rootSessionId]);
      if (commitOrdinaryWindowTrialCharge(store, trialCharge)) {
        terminateOrdinaryWindowTrial(store, { ...scope, cursor: batch.cursor }, { at, reason: 'trial_budget_exhausted' });
      }
    });
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    rejectOrdinaryWindowBatch(store, scope, {
      error,
      at: TimestampSchema.parse(clock())
    });
    throw error;
  }
}
function rejectOrdinaryWindowBatch(store: Store, scope: OrdinaryWindowScope, rejection: { readonly error: Error; readonly at: string }): void {
  store.immediateTransaction(() => {
    if (['binding_window_trial_expired', 'binding_window_trial_budget_exhausted'].includes(rejection.error.message)) {
      terminateOrdinaryWindowTrial(store, scope, {
        at: rejection.at,
        reason: rejection.error.message === 'binding_window_trial_expired' ? 'trial_expired' : 'trial_budget_exhausted'
      });
      return;
    }
    try {
      assertOrdinaryWindowAuthority(store, scope);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      if (['binding_window_trial_expired', 'binding_window_trial_budget_exhausted'].includes(error.message)) {
        terminateOrdinaryWindowTrial(store, scope, {
          at: rejection.at,
          reason: error.message === 'binding_window_trial_expired' ? 'trial_expired' : 'trial_budget_exhausted'
        });
      }
      return;
    }
    const semantic = contractFailures.has(rejection.error.message);
    if (semantic) {
      invalidateCompatibility(store, ordinaryWindowCompatibility(store, scope.taskId), 'contract_failed');
    }
    if (!terminateOrdinaryWindowTrial(store, scope, { at: rejection.at, reason: 'trial_failed' }))
      pauseOrdinaryWindowSegment(store, scope.taskId, rejection.at, semantic ? 'compatibility_invalidated' : 'binding_scope_revoked');
  });
}
function parseWindowBatch(batch: OrdinaryWindowUsageBatch, identity: VerifiedSessionIdentity, at: string) {
  if (
    typeof batch.cursor !== 'string' ||
    batch.cursor.length > 6 * 1024 * 1024 ||
    batch.records.length > 65536 ||
    (batch.excludedRecords?.length ?? 0) > 65536
  ) {
    throw new Error('binding_usage_invalid');
  }
  if (batch.gaps.some(gap => !['incomplete_request', 'binding_unobserved_context'].includes(gap))) {
    throw new Error(batch.gaps.find(gap => contractFailures.has(gap) || segmentFailures.has(gap)) ?? 'binding_contract_failed');
  }
  const parsed = z.array(BindingUsageRecordSchema).safeParse([...batch.records, ...(batch.excludedRecords ?? [])]);
  const coverage = OrdinaryWindowCoverageSchema.safeParse(batch.coverage);
  if (!parsed.success || !coverage.success) {
    throw new Error('binding_usage_invalid');
  }
  if (coverage.data.status === 'invalidated') {
    throw new Error('binding_contract_failed');
  }
  for (const record of parsed.data) validateRecord(record, identity, at);
  return {
    records: parsed.data.slice(0, batch.records.length),
    excluded: parsed.data.slice(batch.records.length),
    coverage: coverage.data
  };
}
function mergeWindowCoverage(store: Store, rootSessionId: string, coverage: OrdinaryWindowCoverage): void {
  const previous = store.get<{ coverage: string }>('SELECT coverage FROM ordinary_window_segments WHERE root_session_id=?', [rootSessionId]);
  if (!previous) throw new Error('binding_scope_revoked');
  const old = OrdinaryWindowCoverageSchema.parse(JSON.parse(previous.coverage));
  const children = new Map(old.detectedChildren.map(child => [child.identity, child]));
  for (const child of coverage.detectedChildren) {
    if (!children.has(child.identity)) children.set(child.identity, child);
  }
  store.execute('UPDATE ordinary_window_segments SET coverage=? WHERE root_session_id=?', [
    JSON.stringify({
      ...coverage,
      detectedChildren: [...children.values()]
    }),
    rootSessionId
  ]);
}
function validateRecord(record: BindingUsageRecord, identity: VerifiedSessionIdentity, at: string): void {
  if (
    record.sessionId !== identity.sessionId ||
    record.payload.product !== identity.product ||
    record.payload.product_version !== identity.productVersion ||
    Date.parse(record.occurredAt) > Date.parse(at)
  ) {
    throw new Error('binding_usage_invalid');
  }
  if (!(identity.product === 'codex' ? isCodexGptModel(record.payload.model) : isClaudeModel(record.payload.model))) {
    throw new Error('binding_usage_invalid');
  }
  const payload = record.payload;
  for (const [subset, total] of [
    [payload.cached_input, payload.input_total],
    [payload.reasoning_output, payload.output_total]
  ]) {
    if (subset?.status === 'observed' && total?.status === 'observed' && subset.value > total.value) {
      throw new Error('binding_usage_invalid');
    }
  }
}
function commitRecord(
  store: Store,
  input: {
    readonly taskId: string;
    readonly projectId: string;
    readonly rootSessionId: string;
    readonly record: BindingUsageRecord;
    readonly key: string;
    readonly at: string;
  }
): void {
  const { taskId, projectId, rootSessionId, record, key, at } = input;
  const fingerprint = hash(record);
  const existing = store.get<{ fingerprint: string }>('SELECT fingerprint FROM binding_requests WHERE request_key=?', [key]);
  if (existing) {
    if (existing.fingerprint !== fingerprint) {
      throw new Error('binding_request_conflict');
    }
    return;
  }
  if (
    store.get("SELECT 1 FROM runtime_evidence WHERE json_extract(payload,'$.request_id')=? AND json_extract(payload,'$.product')=?", [
      record.requestId,
      record.payload.product
    ])
  ) {
    throw new Error('binding_request_conflict');
  }
  const runtimeId = hash(['binding-runtime', key]);
  putUsageWithEvidence(
    store,
    {
      id: key,
      source_key: key,
      task_id: taskId,
      project_id: projectId,
      session_id: rootSessionId,
      occurred_at: record.occurredAt,
      payload: { ...record.payload, runtime_evidence_id: runtimeId }
    },
    {
      id: runtimeId,
      task_id: taskId,
      session_id: rootSessionId,
      turn_id: record.turnId,
      request_id: record.requestId,
      model: record.payload.model,
      effort: record.effort,
      product: record.payload.product,
      product_version: record.payload.product_version,
      source: 'product_log',
      occurred_at: record.occurredAt,
      recorded_at: at,
      boundary: 'request'
    }
  );
  store.execute('INSERT INTO binding_requests(request_key,event_id,fingerprint) VALUES (?,?,?)', [key, key, fingerprint]);
}
