export { aggregateOrdinaryWindowMetrics as readOrdinaryWindowBindingReport } from './pricing/metrics-ordinary-window.js';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { addTokens, TimestampSchema } from './contracts.js';
import { getClaudeBindingAdmission, getEffectiveClaudeBindingAdmission, isClaudeModel } from './claude-binding-admission.js';
import { assertPromotionBindingCheckpoint, promotionBindingBaseline, promotionBindingCheckpoint } from './binding/session-binding-promotion.js';
import type { ToolVersionPromotionAuthority } from './core/tool-version-promotion-store.js';
import { childReadinessDeadline } from './binding/binding-child-readiness.js';
import { assertApplicationWorkingIdentity, bindApplicationEpoch, effectiveTaskWorkspace } from './harness/harness-application.js';
import { type Clock, Lifecycle, utcNow } from './core/lifecycle.js';
import { assertOrdinaryTaskPrepared, ordinaryTask, ordinaryTaskSettings } from './ordinary-observation.js';
import { captureObservedCostInput } from './pricing/observed-cost-report.js';
import { projectCatalogCost } from './pricing/catalog-cost-report.js';
import { readPriceBasis } from './pricing/price-catalog-store.js';
import { putUsageWithEvidence, recordObservationGap } from './core/runtime-history.js';
import { assertCompatibilityAllowed, pinSessionCompatibility, resolveSourceCompatibility } from './source-compatibility.js';
import {
  bindingIdentityKey,
  type BindingProduct,
  type BindingUsageRecord,
  BindingUsageRecordSchema,
  type CurrentIdentityRequest,
  CurrentIdentityRequestSchema,
  type NativeConnectionProof,
  type SessionBindingProvider,
  type VerifiedSessionIdentity,
  VerifiedSessionIdentitySchema
} from './session-binding-contract.js';
import type { CandidateScope } from './nested-candidate.js';
import type { UsageEvent } from './flexible-contracts.js';
import type { Store } from './store.js';
import { ordinaryWindowDecisionKeyForSelection, readOrdinaryWindowDecision } from './core/ordinary-window-activation.js';
import { assertOrdinaryWindowSurfaceClosed, ordinaryWindowSelection } from './core/ordinary-window-store.js';
import { readOrdinaryWindowBatch } from './ordinary-window-binding.js';
import { type CodexWindowPendingReceipt, CodexWindowSessionBindingProvider } from './session-binding-codex.js';
import { type ClaudeWindowBindingOptions, type ClaudeWindowPendingReceipt, ClaudeWindowSessionBindingProvider } from './session-binding-claude.js';
import { OrdinaryWindowConnectionProofSchema } from './core/ordinary-window-policy.js';
import { type ClaudeWindowSourceAuthorization, issueClaudeWindowSourceAuthorization } from './core/ordinary-window-store.js';
import {
  assertOrdinaryWindowAuthority,
  type CodexWindowSourceAuthorization,
  issueCodexWindowSourceAuthorization,
  type OrdinaryWindowScope,
  pauseOrdinaryWindowSegment,
  recordOrdinaryWindowSegment,
  terminateOrdinaryWindowTrial
} from './core/ordinary-window-store.js';

interface BindingRow {
  session_id: string;
  task_id: string;
  root_id: string;
  identity: string;
  relation_evidence_id: string | null;
  connect_receipt: string | null;
  cursor: string | null;
  observed_since: string;
  generation: number;
  state: string;
  gaps: string;
}
interface Segment {
  root_session_id: string;
  task_id: string;
  native_root_id: string;
  state: string;
  revision: number;
  project_root: string;
  observer_identity: string | null;
  opened_at: string;
  baseline_at: string | null;
  closed_at: string | null;
}
export interface OrdinarySourceMetadata {
  readonly nativeSessionId: string;
  readonly agentId: string | null;
  readonly sourceRef: string;
  readonly sourceIdentity: string;
  readonly birthtimeMs: number;
  readonly recordedAt?: string;
  readonly processId?: string;
}
interface Attempt {
  readonly segment: Segment;
  readonly generation: number;
  readonly row?: BindingRow;
  readonly proof?: NativeConnectionProof;
  readonly members: Map<string, OrdinarySourceMetadata>;
  readonly promotion: ToolVersionPromotionAuthority | undefined;
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identityFor = (row: BindingRow) => VerifiedSessionIdentitySchema.parse(JSON.parse(row.identity) as unknown);
const ownerSchema = z.strictObject({
  pid: z.number().int().positive(),
  start: z.string().min(1),
  instance: z.uuid()
});
const metadataKey = (metadata: OrdinarySourceMetadata) => JSON.stringify([metadata.nativeSessionId, metadata.agentId]);
const sameSource = (metadata: OrdinarySourceMetadata, identity: VerifiedSessionIdentity) =>
  metadata.nativeSessionId === (identity.nativeMapping?.nativeSessionId ?? identity.sessionId) &&
  metadata.agentId === (identity.nativeMapping?.agentId ?? null) &&
  metadata.sourceRef === identity.sourceRef &&
  metadata.sourceIdentity === identity.sourceIdentity;

async function flushOrdinaryBindingForgets(
  store: Store,
  providersForTask: (taskId: string, deletedProjectRoot?: string) => SessionBindingProvider[]
): Promise<void> {
  for (const row of store.all<{
    product: BindingProduct;
    native_session_id: string;
    task_id: string;
    project_root: string;
  }>('SELECT * FROM session_binding_forgets')) {
    try {
      if (store.get('SELECT 1 FROM ordinary_window_forget_fences WHERE product=? AND native_session_id=?', [row.product, row.native_session_id])) {
        throw new Error('binding_window_unavailable');
      }
      const provider = providersForTask(row.task_id, row.project_root).find(p => p.product === row.product);
      if (!provider?.forgetSession) {
        throw new Error('binding_provider_unavailable');
      }
      await provider.forgetSession(row.native_session_id);
      store.execute('DELETE FROM session_binding_forgets WHERE product=? AND native_session_id=?', [row.product, row.native_session_id]);
    } catch {
      store.execute("UPDATE session_binding_forgets SET reason_code='binding_forget_pending' WHERE product=? AND native_session_id=?", [
        row.product,
        row.native_session_id
      ]);
    }
  }
}

interface OrdinaryBindingState {
  readonly options: Parameters<typeof createOrdinarySessionBindingService>[0];
  readonly store: Store;
  readonly clock: Clock;
  readonly life: Lifecycle;
  readonly queues: Map<string, Promise<void>>;
  readonly epochs: Map<string, number>;
  readonly attempts: Map<string, Attempt>;
  observerIdentity: string | null;
  closed: boolean;
  forgetting: Promise<void> | undefined;
}

function processStart(pid: number) {
  return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
    encoding: 'utf8',
    timeout: 2000,
    env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    stdio: ['ignore', 'pipe', 'ignore']
  }).trim();
}

function ownIdentity(state: OrdinaryBindingState) {
  return (state.observerIdentity ??= JSON.stringify(
    ownerSchema.parse({
      pid: process.pid,
      start: processStart(process.pid),
      instance: randomUUID()
    })
  ));
}

function now(state: OrdinaryBindingState) {
  const { clock } = state;
  return new Date(TimestampSchema.parse(clock())).toISOString();
}

function rows(state: OrdinaryBindingState, taskId: string, rootId?: string) {
  const { store } = state;
  return store.all<BindingRow>(
    `SELECT * FROM session_bindings WHERE task_id=?${rootId ? ' AND root_id=?' : ''} ORDER BY rowid`,
    rootId ? [taskId, rootId] : [taskId]
  );
}

function selected(state: OrdinaryBindingState, taskId: string) {
  const { store } = state;
  return store.get<Segment>('SELECT s.* FROM binding_root_segments s JOIN ordinary_tasks t ON t.selected_root_id=s.root_session_id WHERE t.task_id=?', [
    taskId
  ]);
}

function providerFor(state: OrdinaryBindingState, taskId: string, product: BindingProduct = 'claude_code') {
  const { store, options } = state;
  assertOrdinaryWindowSurfaceClosed(store, taskId);
  const provider = options.providersForTask(taskId).find(p => p.product === product);
  if (!provider) throw new Error('binding_provider_unavailable');
  return provider;
}

function admissionFor(state: OrdinaryBindingState, taskId: string) {
  const { store } = state;
  const admission = getEffectiveClaudeBindingAdmission(ordinaryTaskSettings(store, taskId).product_version);
  if (!admission?.admitted) throw new Error('binding_source_unqualified');
  return admission;
}

function compatibility(state: OrdinaryBindingState, taskId: string) {
  const { store } = state;
  const admission = admissionFor(state, taskId);
  const value = resolveSourceCompatibility('claude_code', admission.productVersion, 'claude_binding', admission.profileId);
  if (!value) throw new Error('binding_source_unqualified');
  assertCompatibilityAllowed(store, value);
  return value;
}

function authorize(state: OrdinaryBindingState, taskId: string, active = false) {
  const { store, life } = state;
  if (state.closed) throw new Error('binding_scope_revoked');
  assertOrdinaryWindowSurfaceClosed(store, taskId);
  assertOrdinaryTaskPrepared(store, taskId);
  const task = life.task(taskId);
  if (active && task.state !== 'active') {
    throw new Error('binding_scope_revoked');
  }
  if (!getClaudeBindingAdmission(ordinaryTaskSettings(store, taskId).product_version)) {
    const provider = providerFor(state, taskId);
    if (!provider.promotionAuthority) {
      admissionFor(state, taskId);
      throw new Error('promoted_provider_unavailable');
    }
    promotionBindingCheckpoint(provider);
  }
  compatibility(state, taskId);
  return task;
}

function nativeAvailable(state: OrdinaryBindingState, nativeId: string) {
  const { store } = state;
  if (
    store.get(
      "SELECT 1 FROM tombstones WHERE kind='session' AND id=? UNION ALL SELECT 1 FROM session_binding_forgets WHERE product='claude_code' AND native_session_id=?",
      [nativeId, nativeId]
    )
  ) {
    throw new Error('deleted_identifier');
  }
}

function assertAttempt(state: OrdinaryBindingState, taskId: string, attempt: Attempt) {
  const { store } = state;
  const task = authorize(state, taskId, true);
  assertPromotionBindingCheckpoint(providerFor(state, taskId), attempt.promotion);
  const current = selected(state, taskId);
  nativeAvailable(state, attempt.segment.native_root_id);
  if (
    task.generation !== attempt.generation ||
    !current ||
    current.root_session_id !== attempt.segment.root_session_id ||
    current.revision !== attempt.segment.revision ||
    current.observer_identity !== state.observerIdentity ||
    !['acquiring', 'observing'].includes(current.state)
  ) {
    throw new Error('binding_scope_revoked');
  }
  if (attempt.row) {
    const row = store.get<BindingRow>('SELECT * FROM session_bindings WHERE session_id=?', [attempt.row.session_id]);
    if (
      !row ||
      row.state !== 'observing' ||
      row.generation !== attempt.generation ||
      row.identity !== attempt.row.identity ||
      row.cursor !== attempt.row.cursor
    ) {
      throw new Error('binding_scope_revoked');
    }
  }
  return task;
}

function assertSource(state: OrdinaryBindingState, taskId: string, metadata: OrdinarySourceMetadata): void {
  const { attempts } = state;
  nativeAvailable(state, metadata.nativeSessionId);
  const attempt = attempts.get(taskId);
  if (!attempt) throw new Error('binding_scope_revoked');
  assertAttempt(state, taskId, attempt);
  if (metadata.nativeSessionId !== attempt.segment.native_root_id) {
    throw new Error('binding_identity_mismatch');
  }
  if (metadata.agentId === null) {
    const proof = attempt.proof;
    const root = rows(state, taskId, attempt.segment.root_session_id).find(r => r.session_id === r.root_id);
    if (
      proof ? metadata.sourceRef !== proof.sourceRef || metadata.sourceIdentity !== proof.sourceIdentity : !root || !sameSource(metadata, identityFor(root))
    ) {
      throw new Error('binding_identity_mismatch');
    }
    return;
  }
  const bound = rows(state, taskId, attempt.segment.root_session_id).find(row => sameSource(metadata, identityFor(row)));
  const admitted = attempt.members.get(metadataKey(metadata));
  if (
    !bound &&
    (!admitted ||
      admitted.sourceRef !== metadata.sourceRef ||
      admitted.sourceIdentity !== metadata.sourceIdentity ||
      admitted.birthtimeMs !== metadata.birthtimeMs)
  ) {
    throw new Error('binding_member_ineligible');
  }
}

function memberEligible(state: OrdinaryBindingState, taskId: string, metadata: OrdinarySourceMetadata): boolean {
  const { attempts } = state;
  nativeAvailable(state, metadata.nativeSessionId);
  const attempt = attempts.get(taskId);
  if (!attempt) return false;
  assertAttempt(state, taskId, attempt);
  if (metadata.agentId === null || metadata.nativeSessionId !== attempt.segment.native_root_id) return false;
  const existing = rows(state, taskId, attempt.segment.root_session_id).find(row => {
    const value = identityFor(row);
    return value.nativeMapping?.nativeSessionId === metadata.nativeSessionId && value.nativeMapping.agentId === metadata.agentId;
  });
  if (existing) {
    if (!sameSource(metadata, identityFor(existing))) {
      throw new Error('binding_identity_mismatch');
    }
    return true;
  }
  const permitted = attempt.members.get(metadataKey(metadata));
  if (permitted) {
    if (permitted.sourceRef !== metadata.sourceRef || permitted.sourceIdentity !== metadata.sourceIdentity || permitted.birthtimeMs !== metadata.birthtimeMs) {
      throw new Error('binding_identity_mismatch');
    }
    return true;
  }
  const root = rows(state, taskId, attempt.segment.root_session_id).find(row => row.session_id === row.root_id);
  const processId = root ? identityFor(root).nativeMapping?.processId : attempt.proof?.processId;
  const boundary = Date.parse(attempt.segment.baseline_at ?? attempt.segment.opened_at);
  if (metadata.recordedAt === undefined) {
    if (Number.isFinite(metadata.birthtimeMs) && metadata.birthtimeMs <= boundary) return false;
    throw new Error('binding_ancestry_unverified');
  }
  if (
    !Number.isFinite(metadata.birthtimeMs) ||
    metadata.birthtimeMs <= boundary ||
    metadata.birthtimeMs > Date.parse(now(state)) ||
    !metadata.recordedAt ||
    !Number.isFinite(Date.parse(metadata.recordedAt)) ||
    Date.parse(metadata.recordedAt) <= boundary ||
    Date.parse(metadata.recordedAt) > Date.parse(now(state)) ||
    !metadata.processId ||
    metadata.processId !== processId
  ) {
    return false;
  }
  if (rows(state, taskId, attempt.segment.root_session_id).length + attempt.members.size >= admissionFor(state, taskId).maxFamilyMembers) {
    throw new Error('binding_family_limit');
  }
  attempt.members.set(metadataKey(metadata), metadata);
  return true;
}

function ownerAvailable(state: OrdinaryBindingState, segment: Segment) {
  const { store } = state;
  const current = store.get<Segment>('SELECT * FROM binding_root_segments WHERE root_session_id=?', [segment.root_session_id]);
  if (!current || current.state === 'closed' || selected(state, segment.task_id)?.root_session_id !== segment.root_session_id) {
    throw new Error('binding_scope_revoked');
  }
  if (current.observer_identity === null || current.observer_identity === state.observerIdentity) return;
  const owner = ownerSchema.parse(JSON.parse(current.observer_identity) as unknown);
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return;
    throw new Error('binding_observer_owned', { cause: error });
  }
  // A reused PID is a proved-dead owner. Failure to inspect a live PID is not.
  let start: string;
  try {
    start = processStart(owner.pid);
  } catch (error) {
    throw new Error('binding_observer_owned', { cause: error });
  }
  if (!start || start === owner.start) {
    throw new Error('binding_observer_owned');
  }
}

function serialized<T>(state: OrdinaryBindingState, taskId: string, work: () => Promise<T>): Promise<T> {
  const { epochs, queues } = state;
  const epoch = epochs.get(taskId) ?? 0;
  const result = (queues.get(taskId) ?? Promise.resolve()).then(() => {
    if (state.closed || epoch !== (epochs.get(taskId) ?? 0)) {
      throw new Error('binding_scope_revoked');
    }
    return work();
  });
  const tail = result.then(
    () => {},
    () => {}
  );
  queues.set(taskId, tail);
  return result.finally(() => {
    if (queues.get(taskId) === tail) queues.delete(taskId);
  });
}

async function scoped<T>(state: OrdinaryBindingState, taskId: string, attempt: Attempt, work: () => Promise<T>): Promise<T> {
  const { attempts } = state;
  assertAttempt(state, taskId, attempt);
  attempts.set(taskId, attempt);
  try {
    const result = await work();
    assertAttempt(state, taskId, attempt);
    return result;
  } finally {
    if (attempts.get(taskId) === attempt) attempts.delete(taskId);
  }
}

function scopeFor(state: OrdinaryBindingState, taskId: string, rootId: string): CandidateScope {
  const { life, store } = state;
  const family = rows(state, taskId, rootId);
  const root = family.find(row => row.session_id === rootId);
  if (!root) throw new Error('binding_reconnect_required');
  const processId = identityFor(root).nativeMapping?.processId ?? null;
  return {
    taskId,
    projectId: life.task(taskId).project_id,
    allowedRootTurnIds: ['binding-observation'],
    sessions: family.map(row => {
      const value = identityFor(row);
      const parent = store.get<{
        parent_id: string | null;
      }>('SELECT parent_id FROM sessions WHERE id=?', [row.session_id]);
      return {
        sessionId: row.session_id,
        rootSessionId: rootId,
        parentSessionId: parent?.parent_id ?? null,
        sourceId: value.sessionId,
        product: value.product,
        nativeSessionId: value.nativeMapping?.nativeSessionId ?? value.sessionId,
        agentId: value.nativeMapping?.agentId ?? null,
        processId
      };
    })
  };
}

function parseUsageBatch(batch: Awaited<ReturnType<SessionBindingProvider['readUsage']>>) {
  if (
    typeof batch.cursor !== 'string' ||
    batch.cursor.length > 6 * 1024 * 1024 ||
    batch.records.length > 65536 ||
    (batch.excludedRecords?.length ?? 0) > 65536
  ) {
    throw new Error('binding_usage_invalid');
  }
  const records = batch.records.map(record => BindingUsageRecordSchema.parse(record));
  const excluded = (batch.excludedRecords ?? []).map(record => BindingUsageRecordSchema.parse(record));
  return { records, excluded };
}

function recordMatchesIdentity(record: BindingUsageRecord, value: VerifiedSessionIdentity) {
  return record.sessionId === value.sessionId && record.payload.product === value.product && record.payload.product_version === value.productVersion;
}

async function read(state: OrdinaryBindingState, taskId: string, segment: Segment, row: BindingRow, baseline: boolean) {
  const { store, options, clock } = state;
  if (ordinaryWindowSelection(store, taskId)) {
    await readOrdinaryWindowBatch({
      store,
      taskId,
      rootSessionId: segment.root_session_id,
      baseline,
      clock,
      provider: () => options.providersForTask(taskId).find(p => p.product === identityFor(row).product)
    });
    return;
  }
  const value = identityFor(row);
  const provider = providerFor(state, taskId);
  const attempt: Attempt = {
    segment,
    row,
    generation: row.generation,
    members: new Map(),
    promotion: promotionBindingCheckpoint(provider)
  };
  const keyFor = (requestId: string) => hash(['binding-request-v1', value.product, requestId]);
  const stagedLedger = attempt.promotion
    ? promotionBindingBaseline(store, {
        product: value.product,
        sessionId: row.session_id,
        sourceIdentity: value.sourceIdentity,
        assertAuthorized: () => {
          assertAttempt(state, taskId, attempt);
        }
      })
    : undefined;
  const addExcluded = (requestIds: readonly string[]) => {
    store.immediateTransaction(() => {
      assertAttempt(state, taskId, attempt);
      for (const requestId of requestIds) {
        store.execute('INSERT OR IGNORE INTO binding_baseline_exclusions(session_id,source_identity,request_key) VALUES (?,?,?)', [
          row.session_id,
          value.sourceIdentity,
          keyFor(requestId)
        ]);
      }
    });
  };
  const ledger = stagedLedger ?? {
    has: (requestId: string) => {
      assertAttempt(state, taskId, attempt);
      return !!store.get('SELECT 1 FROM binding_baseline_exclusions WHERE session_id=? AND source_identity=? AND request_key=?', [
        row.session_id,
        value.sourceIdentity,
        keyFor(requestId)
      ]);
    },
    add: (requestId: string) => addExcluded([requestId]),
    addMany: addExcluded
  };
  const batch = await scoped(state, taskId, attempt, () =>
    providerFor(state, taskId).readUsage(value, baseline ? null : row.cursor, scopeFor(state, taskId, row.root_id), { baseline, baselineLedger: ledger })
  );
  assertAttempt(state, taskId, attempt);
  const { records, excluded } = parseUsageBatch(batch);
  store.immediateTransaction(() => {
    const task = assertAttempt(state, taskId, attempt);
    let excludedBoundary = baseline;
    for (const record of [...records, ...excluded]) {
      if (!recordMatchesIdentity(record, value) || Date.parse(record.occurredAt) > Date.parse(now(state))) throw new Error('binding_usage_invalid');
      if (!isClaudeModel(record.payload.model)) {
        throw new Error('binding_runtime_unsupported');
      }
    }
    for (const record of excluded) ledger.add(record.requestId);
    for (const record of records) {
      if (baseline) {
        ledger.add(record.requestId);
        continue;
      }
      if (ledger.has(record.requestId)) continue;
      if (Date.parse(record.occurredAt) < Date.parse(row.observed_since)) {
        ledger.add(record.requestId);
        excludedBoundary = true;
        continue;
      }
      const key = keyFor(record.requestId);
      const fingerprint = hash(record);
      const old = store.get<{
        fingerprint: string;
      }>('SELECT fingerprint FROM binding_requests WHERE request_key=?', [key]);
      if (old) {
        if (old.fingerprint !== fingerprint) {
          throw new Error('binding_request_conflict');
        }
        continue;
      }
      if (
        store.get(
          "SELECT 1 FROM runtime_evidence r LEFT JOIN session_bindings b ON b.session_id=r.session_id WHERE json_extract(r.payload,'$.request_id')=? AND (json_extract(r.payload,'$.product')=? OR (json_extract(r.payload,'$.product')='synthetic' AND (b.identity IS NULL OR json_extract(b.identity,'$.product')=?)))",
          [record.requestId, value.product, value.product]
        )
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
          project_id: task.project_id,
          session_id: row.session_id,
          occurred_at: record.occurredAt,
          payload: {
            ...record.payload,
            runtime_evidence_id: runtimeId
          }
        },
        {
          id: runtimeId,
          task_id: taskId,
          session_id: row.session_id,
          turn_id: record.turnId,
          request_id: record.requestId,
          model: record.payload.model,
          effort: record.effort,
          product: value.product,
          product_version: value.productVersion,
          source: 'product_log',
          occurred_at: record.occurredAt,
          recorded_at: now(state),
          boundary: 'request'
        }
      );
      store.execute('INSERT INTO binding_requests(request_key,event_id,fingerprint) VALUES (?,?,?)', [key, key, fingerprint]);
    }
    const previousGaps = z.array(z.string()).parse(JSON.parse(row.gaps) as unknown);
    const currentGaps = [...batch.gaps, ...(excludedBoundary ? ['binding_unobserved_context'] : [])];
    const gaps = [...new Set([...previousGaps, ...currentGaps])];
    if (!baseline && currentGaps.some(gap => !previousGaps.includes(gap))) {
      recordObservationGap(store, taskId, row.session_id, row.observed_since, now(state), 'incomplete', now(state));
    }
    stagedLedger?.commit();
    store.execute('UPDATE session_bindings SET cursor=?,gaps=? WHERE session_id=?', [batch.cursor, JSON.stringify(gaps), row.session_id]);
    assertAttempt(state, taskId, {
      ...attempt,
      row: { ...row, cursor: batch.cursor }
    });
  });
}

function checkIdentity(state: OrdinaryBindingState, taskId: string, input: VerifiedSessionIdentity, measurementSessionId?: string) {
  const { store } = state;
  const value = VerifiedSessionIdentitySchema.parse(input);
  authorize(state, taskId, true);
  if (
    value.product !== 'claude_code' ||
    value.productVersion !== admissionFor(state, taskId).productVersion ||
    value.cwd !== effectiveTaskWorkspace(store, taskId)
  ) {
    throw new Error('binding_identity_mismatch');
  }
  nativeAvailable(state, value.nativeMapping?.nativeSessionId ?? value.sessionId);
  assertApplicationWorkingIdentity(store, taskId, value, measurementSessionId);
  return value;
}

function insertBinding(
  state: OrdinaryBindingState,
  taskId: string,
  segment: Segment,
  input: {
    value: VerifiedSessionIdentity;
    measurementId: string;
    parentId: string | null;
    relation: string | null;
    receipt: string | null;
  }
) {
  const { store } = state;
  const task = authorize(state, taskId, true);
  if (input.parentId !== null) {
    store.execute('INSERT INTO sessions(id,project_id,task_id,parent_id,product,product_version) VALUES (?,?,?,?,?,?)', [
      input.measurementId,
      task.project_id,
      taskId,
      input.parentId,
      input.value.product,
      input.value.productVersion
    ]);
  }
  pinSessionCompatibility(store, input.measurementId, compatibility(state, taskId));
  bindApplicationEpoch(store, taskId, input.measurementId);
  store.execute(
    "INSERT INTO session_bindings(session_id,task_id,root_id,identity,relation_evidence_id,connect_receipt,observed_since,generation,state) VALUES (?,?,?,?,?,?,?,?,'observing')",
    [
      input.measurementId,
      taskId,
      segment.root_session_id,
      JSON.stringify(input.value),
      input.relation,
      input.receipt,
      segment.baseline_at ?? segment.opened_at,
      task.generation
    ]
  );
}

async function discover(state: OrdinaryBindingState, taskId: string, segment: Segment) {
  const { store } = state;
  const root = rows(state, taskId, segment.root_session_id).find(row => row.session_id === segment.root_session_id);
  if (!root) throw new Error('binding_reconnect_required');
  const attempt: Attempt = {
    segment,
    row: root,
    generation: root.generation,
    members: new Map(),
    promotion: promotionBindingCheckpoint(providerFor(state, taskId))
  };
  const result = await scoped(state, taskId, attempt, () => providerFor(state, taskId).discoverChildren(identityFor(root)));
  assertAttempt(state, taskId, attempt);
  const pending = childReadinessDeadline(result) !== undefined;
  if (result.gaps.some(gap => gap !== 'binding_unobserved_context' && !(pending && gap === 'source_unavailable'))) {
    throw new Error('binding_ancestry_unverified');
  }
  store.immediateTransaction(() => {
    assertAttempt(state, taskId, attempt);
    if (providerFor(state, taskId).promotionAuthority?.key.topology === 'root' && result.children.length) {
      throw new Error('binding_root_only_required');
    }
    if (result.gaps.length) {
      const prior = z.array(z.string()).parse(JSON.parse(root.gaps) as unknown);
      const reason = pending ? 'binding_child_pending' : 'binding_unobserved_context';
      if (!prior.includes(reason)) {
        recordObservationGap(store, taskId, root.session_id, root.observed_since, now(state), 'incomplete', now(state));
        store.execute('UPDATE session_bindings SET gaps=? WHERE session_id=?', [JSON.stringify([...prior, reason]), root.session_id]);
      }
    }
    for (const child of result.children) {
      const value = checkIdentity(state, taskId, child.identity);
      if (
        value.parentSessionId !== identityFor(root).sessionId ||
        child.parentSessionId !== value.parentSessionId ||
        !child.relationEvidenceId ||
        value.nativeMapping?.nativeSessionId !== segment.native_root_id ||
        !value.nativeMapping.agentId
      ) {
        throw new Error('binding_relation_invalid');
      }
      const old = rows(state, taskId, segment.root_session_id).find(row => identityFor(row).sessionId === value.sessionId);
      if (old) {
        checkIdentity(state, taskId, value, old.session_id);
        if (bindingIdentityKey(identityFor(old)) !== bindingIdentityKey(value) || old.relation_evidence_id !== child.relationEvidenceId) {
          throw new Error('binding_identity_mismatch');
        }
        continue;
      }
      const admitted = attempt.members.get(
        metadataKey({
          nativeSessionId: value.nativeMapping.nativeSessionId,
          agentId: value.nativeMapping.agentId,
          sourceRef: value.sourceRef,
          sourceIdentity: value.sourceIdentity,
          birthtimeMs: 0
        })
      );
      if (!admitted || !sameSource(admitted, value) || Date.parse(value.createdAt) < Date.parse(segment.baseline_at ?? segment.opened_at)) {
        throw new Error('binding_member_ineligible');
      }
      if (rows(state, taskId, segment.root_session_id).length >= admissionFor(state, taskId).maxFamilyMembers) throw new Error('binding_family_limit');
      insertBinding(state, taskId, segment, {
        value,
        measurementId: randomUUID(),
        parentId: root.session_id,
        relation: child.relationEvidenceId,
        receipt: null
      });
    }
  });
}

function fence(state: OrdinaryBindingState, taskId: string, segmentState: 'paused' | 'stopping', explicitStop = false) {
  const { epochs, store } = state;
  const segment = selected(state, taskId);
  if (segment && segment.state !== 'closed' && !explicitStop) {
    ownerAvailable(state, segment);
  }
  epochs.set(taskId, (epochs.get(taskId) ?? 0) + 1);
  if (!segment || segment.state === 'closed') return segment;
  store.immediateTransaction(() => {
    if (!explicitStop) ownerAvailable(state, segment);
    store.execute(
      'UPDATE binding_root_segments SET state=?,revision=revision+1,observer_identity=CASE WHEN ? THEN NULL ELSE observer_identity END WHERE root_session_id=?',
      [segmentState, explicitStop ? 1 : 0, segment.root_session_id]
    );
    store.execute("UPDATE session_bindings SET state='stopped',cursor=NULL WHERE root_id=?", [segment.root_session_id]);
  });
  return segment;
}

function gapAndPause(state: OrdinaryBindingState, taskId: string, segment: Segment) {
  const { store, life } = state;
  for (const row of rows(state, taskId, segment.root_session_id)) {
    store.execute('UPDATE session_bindings SET gaps=? WHERE session_id=?', [
      JSON.stringify([...new Set([...z.array(z.string()).parse(JSON.parse(row.gaps) as unknown), 'unobserved_interval'])]),
      row.session_id
    ]);
  }
  if (life.state(taskId) === 'active') {
    for (const row of rows(state, taskId, segment.root_session_id)) {
      recordObservationGap(store, taskId, row.session_id, row.observed_since, now(state), 'incomplete', now(state));
    }
    life.pause(taskId);
  }
}

function pause(state: OrdinaryBindingState, taskId: string): void {
  const segment = fence(state, taskId, 'paused');
  if (segment) gapAndPause(state, taskId, segment);
}

function closeSegment(state: OrdinaryBindingState, taskId: string, segment: Segment) {
  const { store } = state;
  store.immediateTransaction(() => {
    const current = selected(state, taskId);
    if (!current || current.root_session_id !== segment.root_session_id) {
      throw new Error('binding_scope_revoked');
    }
    ownerAvailable(state, current);
    store.execute("UPDATE binding_root_segments SET state='closed',revision=revision+1,observer_identity=NULL,closed_at=? WHERE root_session_id=?", [
      now(state),
      segment.root_session_id
    ]);
    store.execute('UPDATE ordinary_tasks SET selected_root_id=NULL WHERE task_id=?', [taskId]);
  });
}

function stopObservation(state: OrdinaryBindingState, taskId: string): Promise<void> {
  const { queues } = state;
  const segment = fence(state, taskId, 'stopping', true);
  const drain = queues.get(taskId) ?? Promise.resolve();
  if (!segment) return drain;
  return drain.then(() => {
    try {
      gapAndPause(state, taskId, segment);
    } finally {
      closeSegment(state, taskId, segment);
    }
  });
}

function flushForgotten(state: OrdinaryBindingState): Promise<void> {
  const { store, options } = state;
  if (state.forgetting) return state.forgetting;
  state.forgetting = flushOrdinaryBindingForgets(store, options.providersForTask).finally(() => {
    state.forgetting = undefined;
  });
  return state.forgetting;
}

function sourceSupported(state: OrdinaryBindingState, taskId: string, product: BindingProduct): boolean {
  const { options } = state;
  authorize(state, taskId);
  if (product !== 'claude_code') return false;
  const provider = providerFor(state, taskId, product);
  return (
    !!provider.inspectCurrent &&
    provider.capabilities().usage === 'own_requests' &&
    (options.syntheticProviderForTask?.(taskId) === true || (admissionFor(state, taskId).admitted && provider.capabilities().productionSupported))
  );
}

function tokenTotal(events: UsageEvent[], field: 'input_total' | 'output_total') {
  const readings = events.map(event => event.payload[field]);
  const observed = readings.filter(reading => reading.status === 'observed');
  return {
    status: readings.length && readings.length === observed.length ? 'observed' : observed.length ? 'partial' : 'missing',
    value: observed.length ? addTokens(observed.map(reading => reading.value)) : null,
    statuses: [...new Set(readings.map(reading => reading.status))].sort(),
    reasons: [...new Set(readings.flatMap(reading => (reading.reason ? [reading.reason] : [])))].sort()
  };
}

function status(state: OrdinaryBindingState, taskId: string) {
  const { store, life } = state;
  assertOrdinaryWindowSurfaceClosed(store, taskId);
  const task = life.task(taskId);
  const all = rows(state, taskId);
  const segment = selected(state, taskId);
  const tableId = ordinaryTask(store, taskId)?.price_table_id;
  if (!tableId) throw new Error('ordinary_preparation_required');
  const cutoff = now(state);
  const capture = captureObservedCostInput(store, taskId, tableId, cutoff, 'output-only-v1');
  const keys = new Set(
    store
      .all<{
        event_id: string;
      }>('SELECT r.event_id FROM binding_requests r JOIN events e ON e.id=r.event_id WHERE e.task_id=?', [taskId])
      .map(row => row.event_id)
  );
  const eligible = capture.events.filter(event => keys.has(event.id));

  const summarize = (events: UsageEvent[]) => {
    const priced = projectCatalogCost(events, readPriceBasis(store, tableId), taskId, cutoff, 'output-only-v1', {
      referenceBinding: true,
      runtimeEvidence: capture.runtimeEvidence
    });
    return {
      requests: events.length || null,
      input_total: tokenTotal(events, 'input_total'),
      output_total: tokenTotal(events, 'output_total'),
      partial_amount: priced.partial_amount,
      compatibility_unverified_partial_amount: priced.compatibility_unverified_partial_amount,
      legacy_unverified_partial_amount: priced.legacy_unverified_partial_amount,
      compatibility: priced.compatibility,
      unpriced_events: priced.unpriced_events,
      currency: priced.currency,
      price_table_id: tableId,
      cost_coverage: 'partial' as const,
      complete_cost: null
    };
  };
  return {
    state: task.state === 'active' && segment?.state === 'observing' ? 'observing' : all.length ? 'stopped' : 'unconnected',
    selected_root_id: segment?.root_session_id ?? null,
    segment_state: segment?.state ?? null,
    price_table_hash: capture.report.price_table_hash,
    roots: all.filter(row => row.session_id === row.root_id).length,
    children: all.filter(row => row.session_id !== row.root_id).length,
    sessions: all.map(row => {
      const value = identityFor(row);
      const events = eligible.filter(event => event.session_id === row.session_id);
      const parent = store.get<{
        parent_id: string | null;
      }>('SELECT parent_id FROM sessions WHERE id=?', [row.session_id]);
      return {
        session_id: row.session_id,
        parent_session_id: parent?.parent_id ?? null,
        identity_basis: 'native_metadata_receipt',
        agent_metadata:
          value.agentMetadata?.source === 'claude_hook'
            ? {
                source: value.agentMetadata.source,
                agent_type: value.agentMetadata.agentType
              }
            : null,
        models: [...new Set(events.flatMap(event => (event.payload.model ? [event.payload.model] : [])))].sort(),
        ...summarize(events)
      };
    }),
    summary: summarize(eligible),
    requests: keys.size,
    gaps: [...new Set(all.flatMap(row => z.array(z.string()).parse(JSON.parse(row.gaps) as unknown)))],
    cost_coverage: 'partial' as const,
    complete_cost: null,
    inference: false
  };
}

function selectedRootMismatch(root: BindingRow | undefined, proof: NativeConnectionProof) {
  return (
    !root ||
    proof.sourceRef !== identityFor(root).sourceRef ||
    proof.sourceIdentity !== identityFor(root).sourceIdentity ||
    proof.processId !== identityFor(root).nativeMapping?.processId
  );
}

function nativeRootMismatch(value: VerifiedSessionIdentity, proof: NativeConnectionProof) {
  return (
    value.sessionId !== proof.nativeSessionId ||
    value.parentSessionId !== null ||
    value.sourceRef !== proof.sourceRef ||
    value.sourceIdentity !== proof.sourceIdentity ||
    value.nativeMapping?.nativeSessionId !== proof.nativeSessionId ||
    value.nativeMapping.agentId !== null ||
    value.nativeMapping.processId !== proof.processId
  );
}

function assertConnectionProof(state: OrdinaryBindingState, taskId: string, input: CurrentIdentityRequest, proof: NativeConnectionProof) {
  const { store } = state;
  if (
    proof.receipt !== input.receipt ||
    proof.agentId !== null ||
    proof.cwd !== effectiveTaskWorkspace(store, taskId) ||
    proof.productVersion !== admissionFor(state, taskId).productVersion ||
    !proof.processId ||
    !proof.sourceRef ||
    !proof.sourceIdentity ||
    Date.parse(proof.recordedAt) > Date.parse(now(state)) ||
    !Number.isFinite(Date.parse(proof.recordedAt))
  ) {
    throw new Error('binding_identity_mismatch');
  }
}

function connect(state: OrdinaryBindingState, taskId: string, product: BindingProduct, request: CurrentIdentityRequest) {
  const { epochs, life, store } = state;
  return serialized(state, taskId, async () => {
    const before = authorize(state, taskId);
    const provider = providerFor(state, taskId, product);
    const promotion = promotionBindingCheckpoint(provider);
    const epoch = epochs.get(taskId) ?? 0;
    const input = CurrentIdentityRequestSchema.parse(request);
    if (!sourceSupported(state, taskId, product) || !provider.inspectCurrent) throw new Error('binding_source_unqualified');
    const previous = selected(state, taskId);
    if (previous) {
      nativeAvailable(state, previous.native_root_id);
      ownerAvailable(state, previous);
    }
    const proof = await provider.inspectCurrent(input);
    assertPromotionBindingCheckpoint(provider, promotion);
    authorize(state, taskId);
    if (epoch !== (epochs.get(taskId) ?? 0) || life.task(taskId).generation !== before.generation) throw new Error('binding_scope_revoked');
    nativeAvailable(state, proof.nativeSessionId);
    assertConnectionProof(state, taskId, input, proof);
    const stop = store.get<{
      boundary: string | null;
    }>("SELECT max(closed_at) AS boundary FROM binding_root_segments WHERE product='claude_code' AND native_root_id=?", [proof.nativeSessionId])?.boundary;
    if (stop && Date.parse(proof.recordedAt) <= Date.parse(stop)) {
      throw new Error('binding_receipt_stale');
    }
    const reservation = store.get<Segment>("SELECT * FROM binding_root_segments WHERE native_root_id=? AND state!='closed'", [proof.nativeSessionId]);
    if (reservation && reservation.task_id !== taskId) {
      throw new Error('binding_session_conflict');
    }
    if (previous?.state === 'observing' && previous.native_root_id === proof.nativeSessionId) {
      const root = rows(state, taskId, previous.root_session_id).find(row => row.session_id === row.root_id);
      if (selectedRootMismatch(root, proof)) {
        throw new Error('binding_identity_mismatch');
      }
      if (previous.observer_identity !== state.observerIdentity) {
        throw new Error('binding_reconnect_required');
      }
      return {
        ...status(state, taskId),
        status: 'already_connected',
        session_id: previous.root_session_id,
        automatic_children: provider.promotionAuthority?.key.topology !== 'root'
      };
    }
    // Explicit connect replaces the selected segment; resume is the only path
    // that can reactivate that same measurement root.
    if (previous) {
      const fenced = fence(state, taskId, 'stopping');
      if (fenced) {
        gapAndPause(state, taskId, fenced);
        closeSegment(state, taskId, fenced);
      }
    }
    const rootId = randomUUID();
    const at = now(state);
    const segment: Segment = {
      root_session_id: rootId,
      task_id: taskId,
      native_root_id: proof.nativeSessionId,
      project_root: proof.cwd,
      state: 'acquiring',
      revision: 0,
      observer_identity: ownIdentity(state),
      opened_at: at,
      baseline_at: null,
      closed_at: null
    };
    store.immediateTransaction(() => {
      assertPromotionBindingCheckpoint(provider, promotion);
      authorize(state, taskId);
      const task = life.task(taskId);
      if (task.generation !== before.generation && !previous) {
        throw new Error('binding_scope_revoked');
      }
      if (task.state === 'registered') life.start(taskId);
      else if (task.state === 'paused') life.resume(taskId);
      store.execute('INSERT INTO sessions(id,project_id,task_id,product,product_version) VALUES (?,?,?,?,?)', [
        rootId,
        task.project_id,
        taskId,
        'claude_code',
        proof.productVersion
      ]);
      store.execute(
        "INSERT INTO binding_root_segments(root_session_id,task_id,product,native_root_id,project_root,state,observer_identity,opened_at) VALUES (?,?,'claude_code',?,?,'acquiring',?,?)",
        [rootId, taskId, proof.nativeSessionId, proof.cwd, ownIdentity(state), at]
      );
      store.execute('UPDATE ordinary_tasks SET selected_root_id=? WHERE task_id=?', [rootId, taskId]);
      assertPromotionBindingCheckpoint(provider, promotion);
    });
    const attempt: Attempt = {
      segment,
      generation: life.task(taskId).generation,
      proof,
      members: new Map(),
      promotion
    };
    try {
      const value = checkIdentity(state, taskId, await scoped(state, taskId, attempt, () => provider.resolveCurrent(input)), rootId);
      assertAttempt(state, taskId, attempt);
      if (nativeRootMismatch(value, proof)) {
        throw new Error('binding_identity_mismatch');
      }
      store.immediateTransaction(() => {
        assertAttempt(state, taskId, attempt);
        insertBinding(state, taskId, segment, {
          value,
          measurementId: rootId,
          parentId: null,
          relation: null,
          receipt: input.receipt
        });
        store.execute("UPDATE binding_root_segments SET state='observing',baseline_at=? WHERE root_session_id=?", [at, rootId]);
      });
      const observing = selected(state, taskId);
      const root = rows(state, taskId, rootId).find(row => row.session_id === rootId);
      if (!observing || !root) throw new Error('binding_scope_revoked');
      await read(state, taskId, observing, root, true);
      const boundary = now(state);
      store.immediateTransaction(() => {
        assertAttempt(state, taskId, attempt);
        recordObservationGap(store, taskId, rootId, at, boundary, 'incomplete', boundary);
        store.execute('UPDATE binding_root_segments SET baseline_at=? WHERE root_session_id=?', [boundary, rootId]);
        store.execute('UPDATE session_bindings SET observed_since=? WHERE session_id=?', [boundary, rootId]);
      });
    } catch (error) {
      const current = selected(state, taskId);
      if (current?.root_session_id === rootId && current.observer_identity === state.observerIdentity && ['acquiring', 'observing'].includes(current.state)) {
        pause(state, taskId);
      }
      throw error;
    }
    return {
      ...status(state, taskId),
      status: 'connected',
      session_id: rootId,
      automatic_children: provider.promotionAuthority?.key.topology !== 'root'
    };
  });
}

function resumeAvailable(state: OrdinaryBindingState, taskId: string) {
  const { store } = state;
  assertOrdinaryWindowSurfaceClosed(store, taskId);
  const segment = selected(state, taskId);
  if (
    segment &&
    store.get(
      "SELECT 1 FROM tombstones WHERE kind='session' AND id=? UNION ALL SELECT 1 FROM session_binding_forgets WHERE product='claude_code' AND native_session_id=?",
      [segment.native_root_id, segment.native_root_id]
    )
  ) {
    return false;
  }
  const root = segment ? rows(state, taskId, segment.root_session_id).find(row => row.session_id === segment.root_session_id) : undefined;
  return (
    !!segment &&
    segment.state !== 'closed' &&
    !!root &&
    CurrentIdentityRequestSchema.safeParse({
      receipt: root.connect_receipt
    }).success
  );
}

function resume(state: OrdinaryBindingState, taskId: string) {
  const { store, life } = state;
  return serialized(state, taskId, async () => {
    authorize(state, taskId);
    const promotion = promotionBindingCheckpoint(providerFor(state, taskId));
    const segment = selected(state, taskId);
    if (!segment || segment.state === 'closed' || segment.state === 'stopping') throw new Error('binding_reconnect_required');
    nativeAvailable(state, segment.native_root_id);
    ownerAvailable(state, segment);
    if (!resumeAvailable(state, taskId)) {
      throw new Error('binding_reconnect_required');
    }
    if (segment.state === 'observing' && segment.observer_identity === state.observerIdentity) throw new Error('binding_reconnect_required');
    const root = rows(state, taskId, segment.root_session_id).find(row => row.session_id === segment.root_session_id);
    if (!root?.connect_receipt || !providerFor(state, taskId).revalidateBound) throw new Error('binding_reconnect_required');
    const expected = identityFor(root);
    store.immediateTransaction(() => {
      assertPromotionBindingCheckpoint(providerFor(state, taskId), promotion);
      authorize(state, taskId);
      ownerAvailable(state, segment);
      store.execute("UPDATE binding_root_segments SET state='paused',revision=revision+1,observer_identity=? WHERE root_session_id=?", [
        ownIdentity(state),
        segment.root_session_id
      ]);
      store.execute("UPDATE session_bindings SET state='stopped',cursor=NULL WHERE root_id=?", [segment.root_session_id]);
    });
    gapAndPause(state, taskId, segment);
    store.immediateTransaction(() => {
      assertPromotionBindingCheckpoint(providerFor(state, taskId), promotion);
      authorize(state, taskId);
      if (life.state(taskId) === 'paused') life.resume(taskId);
      const generation = life.task(taskId).generation;
      store.execute("UPDATE binding_root_segments SET state='acquiring',revision=revision+1 WHERE root_session_id=?", [segment.root_session_id]);
      store.execute("UPDATE session_bindings SET state='observing',generation=?,cursor=NULL WHERE root_id=?", [generation, segment.root_session_id]);
    });
    const current = selected(state, taskId);
    if (!current) throw new Error('binding_scope_revoked');
    const attempt: Attempt = {
      segment: current,
      generation: life.task(taskId).generation,
      members: new Map(),
      promotion
    };
    try {
      const provider = providerFor(state, taskId);
      if (!provider.revalidateBound) {
        throw new Error('binding_reconnect_required');
      }
      const value = await scoped(state, taskId, attempt, () =>
        provider.revalidateBound
          ? provider.revalidateBound(
              {
                receipt: root.connect_receipt ?? ''
              },
              expected
            )
          : Promise.reject(new Error('binding_reconnect_required'))
      );
      assertAttempt(state, taskId, attempt);
      checkIdentity(state, taskId, value, root.session_id);
      if (bindingIdentityKey(expected) !== bindingIdentityKey(value)) {
        throw new Error('binding_identity_mismatch');
      }
      for (const row of rows(state, taskId, current.root_session_id)) {
        await read(state, taskId, current, row, true);
      }
      const boundary = now(state);
      store.immediateTransaction(() => {
        assertAttempt(state, taskId, attempt);
        for (const row of rows(state, taskId, current.root_session_id)) {
          recordObservationGap(store, taskId, row.session_id, row.observed_since, boundary, 'incomplete', boundary);
        }
        store.execute("UPDATE binding_root_segments SET state='observing',baseline_at=? WHERE root_session_id=?", [boundary, current.root_session_id]);
        store.execute('UPDATE session_bindings SET observed_since=? WHERE root_id=?', [boundary, current.root_session_id]);
      });
    } catch (error) {
      pause(state, taskId);
      throw error;
    }
    return {
      ...status(state, taskId),
      status: 'reconnected',
      session_id: current.root_session_id,
      automatic_children: providerFor(state, taskId).promotionAuthority?.key.topology !== 'root'
    };
  });
}

function tick(state: OrdinaryBindingState, taskId: string) {
  const { store, life } = state;
  return serialized(state, taskId, async () => {
    assertOrdinaryWindowSurfaceClosed(store, taskId);
    const segment = selected(state, taskId);
    if (!segment || segment.state !== 'observing' || life.state(taskId) !== 'active') return status(state, taskId);
    authorize(state, taskId, true);
    nativeAvailable(state, segment.native_root_id);
    if (segment.observer_identity !== state.observerIdentity) {
      throw new Error('binding_observer_owned');
    }
    await discover(state, taskId, segment);
    for (const row of rows(state, taskId, segment.root_session_id)) {
      await read(state, taskId, segment, row, false);
    }
    return status(state, taskId);
  });
}

function close(state: OrdinaryBindingState): Promise<void> {
  const { store, queues } = state;
  if (state.observerIdentity === null) {
    state.closed = true;
    return Promise.resolve();
  }
  const owned = store.all<Segment>("SELECT * FROM binding_root_segments WHERE observer_identity=? AND state!='closed'", [state.observerIdentity]);
  const failures: unknown[] = [];
  for (const segment of owned) {
    try {
      pause(state, segment.task_id);
    } catch (error) {
      failures.push(error);
    }
  }
  state.closed = true;
  return Promise.all([...queues.values()]).then(() => {
    store.execute("UPDATE binding_root_segments SET observer_identity=NULL,revision=revision+1 WHERE observer_identity=? AND state='paused'", [
      state.observerIdentity
    ]);
    if (failures.length) {
      throw new AggregateError(failures, 'binding_close_failed');
    }
  });
}

export function createOrdinarySessionBindingService(options: {
  store: Store;
  providersForTask: (taskId: string, deletedProjectRoot?: string) => SessionBindingProvider[];
  clock?: Clock;
  syntheticProviderForTask?: (taskId: string) => boolean;
}) {
  const { store } = options;
  const clock = options.clock ?? utcNow;
  const life = new Lifecycle(store, clock);
  const state: OrdinaryBindingState = {
    options,
    store,
    clock,
    life,
    queues: new Map(),
    epochs: new Map(),
    attempts: new Map(),
    observerIdentity: null,
    closed: false,
    forgetting: undefined
  };
  for (const segment of store.all<Segment>("SELECT * FROM binding_root_segments WHERE state!='closed'")) {
    if (ordinaryWindowSelection(store, segment.task_id)) continue;
    try {
      ownerAvailable(state, segment);
    } catch (error) {
      if (error instanceof Error && error.message === 'binding_observer_owned') continue;
      throw error;
    }
    const stopped = fence(state, segment.task_id, 'paused');
    if (stopped) {
      gapAndPause(state, segment.task_id, stopped);
      store.execute('UPDATE binding_root_segments SET observer_identity=NULL WHERE root_session_id=?', [stopped.root_session_id]);
    }
  }
  return {
    status: (taskId: string) => status(state, taskId),
    connect: (taskId: string, product: BindingProduct, request: CurrentIdentityRequest) => connect(state, taskId, product, request),
    resume: (taskId: string) => resume(state, taskId),
    resumeAvailable: (taskId: string) => resumeAvailable(state, taskId),
    tick: (taskId: string) => tick(state, taskId),
    pause: (taskId: string): void => pause(state, taskId),
    stopObservation: (taskId: string): Promise<void> => stopObservation(state, taskId),
    close: (): Promise<void> => close(state),
    flushForgotten: (): Promise<void> => flushForgotten(state),
    sourceSupported: (taskId: string, product: BindingProduct): boolean => sourceSupported(state, taskId, product),
    capabilities: (taskId: string, product: BindingProduct) => providerFor(state, taskId, product).capabilities(),
    assertSource: (taskId: string, metadata: OrdinarySourceMetadata): void => assertSource(state, taskId, metadata),
    memberEligible: (taskId: string, metadata: OrdinarySourceMetadata): boolean => memberEligible(state, taskId, metadata)
  };
}

export type OrdinarySessionBindingService = ReturnType<typeof createOrdinarySessionBindingService>;

export interface OrdinaryCodexWindowBindingOptions {
  readonly store: Store;
  readonly taskId: string;
  readonly receiptDirectory: string;
  readonly sourceRoots: readonly string[];
  readonly clock?: Clock;
}
interface CodexWindowSelectedRoot {
  readonly root_session_id: string;
  readonly native_root_id: string;
  readonly state: string;
  readonly revision: number;
  readonly generation: number | null;
  readonly cursor: string | null;
}
function selectedCodexWindowRoot(store: Store, taskId: string): CodexWindowSelectedRoot | undefined {
  return store.get<CodexWindowSelectedRoot>(
    `SELECT s.root_session_id,s.native_root_id,s.state,s.revision,b.generation,b.cursor FROM ordinary_tasks t
    JOIN binding_root_segments s ON s.root_session_id=t.selected_root_id
    LEFT JOIN session_bindings b ON b.session_id=s.root_session_id WHERE t.task_id=?`,
    [taskId]
  );
}
function codexWindowProvider(options: OrdinaryCodexWindowBindingOptions, authorization: CodexWindowSourceAuthorization) {
  return new CodexWindowSessionBindingProvider({
    authorization,
    receiptDirectory: options.receiptDirectory,
    sourceRoots: options.sourceRoots,
    projectRoot: authorization().projectRoot,
    clock: options.clock ?? utcNow
  });
}
function reserveCodexWindowRoot(
  options: OrdinaryCodexWindowBindingOptions,
  pending: CodexWindowPendingReceipt,
  generation: number,
  authorization: CodexWindowSourceAuthorization,
  previous: CodexWindowSelectedRoot | undefined,
  at: string
): { readonly rootSessionId: string; readonly rejected: boolean } {
  const { store, taskId } = options;
  return store.immediateTransaction(() => {
    const context = authorization();
    assertOrdinaryWindowAuthority(store, {
      taskId,
      generation,
      nativeRootId: pending.nativeSessionId,
      decisionRef: context.decisionRef,
      clock: options.clock ?? utcNow
    });
    if (JSON.stringify(selectedCodexWindowRoot(store, taskId)) !== JSON.stringify(previous)) throw new Error('binding_scope_revoked');
    if (pending.event !== 'SessionStart' || pending.nativeRootSessionId !== pending.nativeSessionId || pending.agentId !== null || pending.turnId !== null) {
      throw new Error('binding_root_only_required');
    }
    const rejected = pending.lifecycle !== 'startup' || pending.sourceRef === null;
    if (rejected && previous?.native_root_id === pending.nativeSessionId) {
      pauseOrdinaryWindowSegment(store, taskId, at, 'binding_fresh_root_required');
      return { rootSessionId: previous.root_session_id, rejected };
    }
    if (previous && previous.state !== 'paused' && previous.state !== 'closed' && (previous.generation === null || previous.generation === generation)) {
      throw new Error('binding_fresh_root_required');
    }
    if (
      store.get('SELECT 1 FROM binding_root_segments WHERE product=? AND native_root_id=?', ['codex', pending.nativeSessionId]) ||
      store.get("SELECT 1 FROM ordinary_window_segments WHERE json_extract(proof,'$.product')='codex' AND json_extract(proof,'$.sourceRef')=?", [
        pending.sourceRef
      ])
    ) {
      throw new Error('binding_fresh_root_required');
    }
    if (previous) {
      store.execute(
        "UPDATE binding_root_segments SET state='closed',closed_at=?,revision=revision+1,observer_identity=NULL WHERE root_session_id=? AND state!='closed'",
        [at, previous.root_session_id]
      );
      store.execute("UPDATE session_bindings SET state='stopped' WHERE root_id=?", [previous.root_session_id]);
    }
    const rootSessionId = randomUUID();
    store.execute('INSERT INTO sessions(id,project_id,task_id,product,product_version) VALUES (?,?,?,?,?)', [
      rootSessionId,
      context.selection.projectId,
      taskId,
      'codex',
      context.selection.declaredVersion
    ]);
    store.execute(
      `INSERT INTO binding_root_segments(root_session_id,task_id,product,native_root_id,project_root,state,opened_at)
      VALUES (?,?,?,?,?,'acquiring',?)`,
      [rootSessionId, taskId, 'codex', pending.nativeSessionId, context.projectRoot, at]
    );
    store.execute('UPDATE ordinary_tasks SET selected_root_id=? WHERE task_id=?', [rootSessionId, taskId]);
    issueCodexWindowSourceAuthorization(
      store,
      {
        taskId,
        rootSessionId,
        generation,
        segmentRevision: 0,
        decisionRef: context.decisionRef,
        clock: options.clock ?? utcNow
      },
      'acquiring'
    );
    if (rejected) {
      pauseOrdinaryWindowSegment(store, taskId, at, 'binding_fresh_root_required');
    }
    return { rootSessionId, rejected };
  });
}

export async function collectOrdinaryCodexWindow(options: OrdinaryCodexWindowBindingOptions, rootSessionId: string, baseline = false): Promise<void> {
  await readOrdinaryWindowBatch({
    store: options.store,
    taskId: options.taskId,
    rootSessionId,
    baseline,
    clock: options.clock ?? utcNow,
    provider: (_authorizeSource, scope) => codexWindowProvider(options, issueCodexWindowSourceAuthorization(options.store, scope, 'observing'))
  });
}

export async function connectOrdinaryCodexWindow(
  options: OrdinaryCodexWindowBindingOptions,
  input: CurrentIdentityRequest
): Promise<{ readonly rootSessionId: string; readonly automatic_children: false }> {
  const { store, taskId } = options;
  const clock = options.clock ?? utcNow;
  const generation = new Lifecycle(store, clock).task(taskId).generation;
  const selection = ordinaryWindowSelection(store, taskId);
  const decision = selection ? readOrdinaryWindowDecision(store, ordinaryWindowDecisionKeyForSelection(selection)) : null;
  let scope: OrdinaryWindowScope = {
    taskId,
    generation,
    clock,
    ...(decision === null ? {} : { decisionRef: decision.decision_ref })
  };
  let authorization: CodexWindowSourceAuthorization | undefined;
  try {
    const metadataAuthorization = issueCodexWindowSourceAuthorization(store, scope, 'metadata');
    const previous = selectedCodexWindowRoot(store, taskId);
    const pending = codexWindowProvider(options, metadataAuthorization).pendingReceipt(input);
    const at = TimestampSchema.parse(clock());
    const reservation = reserveCodexWindowRoot(options, pending, generation, metadataAuthorization, previous, at);
    if (reservation.rejected) {
      throw new Error('binding_fresh_root_required');
    }
    scope = {
      ...scope,
      rootSessionId: reservation.rootSessionId,
      segmentRevision: 0
    };
    const acquiringAuthorization = issueCodexWindowSourceAuthorization(store, scope, 'acquiring');
    authorization = acquiringAuthorization;
    const proof = await codexWindowProvider(options, acquiringAuthorization).inspectWindowCurrent(input);
    store.immediateTransaction(() => {
      acquiringAuthorization();
      if (proof.mode !== 'codex_source_only') {
        throw new Error('binding_identity_mismatch');
      }
      if (
        store.get(
          `SELECT 1 FROM ordinary_window_segments WHERE json_extract(proof,'$.product')='codex'
        AND (json_extract(proof,'$.sourceIdentity')=? OR json_extract(proof,'$.sourceRef')=?)`,
          [proof.sourceIdentity, proof.sourceRef]
        )
      ) {
        throw new Error('binding_fresh_root_required');
      }
      recordOrdinaryWindowSegment(store, scope, proof);
      const identity = VerifiedSessionIdentitySchema.parse({
        product: 'codex',
        productVersion: proof.productVersion,
        sessionId: proof.nativeSessionId,
        sourceRef: proof.sourceRef,
        sourceIdentity: proof.sourceIdentity,
        cwd: proof.cwd,
        identityEvidenceId: proof.receipt,
        parentSessionId: null,
        createdAt: proof.recordedAt,
        nativeMapping: {
          nativeSessionId: proof.nativeSessionId,
          processId: null,
          agentId: null
        }
      });
      store.execute(
        `INSERT INTO session_bindings(session_id,task_id,root_id,identity,connect_receipt,observed_since,generation,state,cursor)
        VALUES (?,?,?,?,?,?,?,'observing',NULL)`,
        [reservation.rootSessionId, taskId, reservation.rootSessionId, JSON.stringify(identity), proof.receipt, at, generation]
      );
      store.execute("UPDATE binding_root_segments SET state='observing',revision=revision+1 WHERE root_session_id=?", [reservation.rootSessionId]);
    });
    scope = { ...scope, segmentRevision: 1, cursor: null };
    await collectOrdinaryCodexWindow(options, reservation.rootSessionId, true);
    assertOrdinaryWindowAuthority(store, {
      taskId,
      rootSessionId: reservation.rootSessionId,
      generation,
      clock,
      ...(scope.decisionRef === undefined ? {} : { decisionRef: scope.decisionRef })
    });
    return {
      rootSessionId: reservation.rootSessionId,
      automatic_children: false
    };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    if (
      ['binding_window_trial_expired', 'binding_window_trial_budget_exhausted'].includes(error.message) ||
      scope.rootSessionId === undefined ||
      scope.segmentRevision === 0
    ) {
      terminateOrdinaryWindowTrial(store, scope, {
        at: clock(),
        reason:
          error.message === 'binding_window_trial_expired'
            ? 'trial_expired'
            : error.message === 'binding_window_trial_budget_exhausted'
              ? 'trial_budget_exhausted'
              : 'trial_failed'
      });
    }
    store.immediateTransaction(() => {
      let current = false;
      try {
        authorization?.();
        current = authorization !== undefined;
      } catch (failure) {
        if (!(failure instanceof Error)) throw failure;
      }
      if (current) {
        pauseOrdinaryWindowSegment(store, taskId, TimestampSchema.parse(clock()), 'binding_scope_revoked');
      }
    });
    throw error;
  }
}

export interface OrdinaryClaudeWindowBindingOptions {
  readonly store: Store;
  readonly taskId: string;
  readonly receiptDirectory: string;
  readonly claudeProjectsDirectory: string;
  readonly clock?: Clock;
  readonly binaryAdapters?: ClaudeWindowBindingOptions['binaryAdapters'];
}
function selectedClaudeWindowRoot(store: Store, taskId: string) {
  return store.get<{
    root_session_id: string;
    native_root_id: string;
    state: string;
    revision: number;
    generation: number | null;
  }>(
    `SELECT s.root_session_id,s.native_root_id,s.state,s.revision,b.generation FROM ordinary_tasks t
    JOIN binding_root_segments s ON s.root_session_id=t.selected_root_id
    LEFT JOIN session_bindings b ON b.session_id=s.root_session_id WHERE t.task_id=?`,
    [taskId]
  );
}
function claudeWindowProvider(options: OrdinaryClaudeWindowBindingOptions, authorization: ClaudeWindowSourceAuthorization, expectedDigest?: string) {
  return new ClaudeWindowSessionBindingProvider({
    authorization,
    receiptDirectory: options.receiptDirectory,
    claudeProjectsDirectory: options.claudeProjectsDirectory,
    projectRoot: authorization().projectRoot,
    clock: options.clock ?? utcNow,
    ...(options.binaryAdapters === undefined ? {} : { binaryAdapters: options.binaryAdapters }),
    ...(expectedDigest === undefined ? {} : { expectedNativePinDigest: expectedDigest })
  });
}
function reserveClaudeWindowRoot(
  options: OrdinaryClaudeWindowBindingOptions,
  pending: ClaudeWindowPendingReceipt,
  generation: number,
  authorization: ClaudeWindowSourceAuthorization,
  at: string
) {
  const { store, taskId } = options;
  return store.immediateTransaction(() => {
    const context = authorization();
    assertOrdinaryWindowAuthority(store, {
      taskId,
      generation,
      nativeRootId: pending.nativeSessionId,
      decisionRef: context.decisionRef,
      clock: options.clock ?? utcNow
    });
    if (
      pending.event !== 'connect' ||
      pending.agentId !== null ||
      pending.nativeRootSessionId !== pending.nativeSessionId ||
      pending.sourceRef === null ||
      pending.processIdHint === null
    ) {
      throw new Error('binding_root_only_required');
    }
    const previous = selectedClaudeWindowRoot(store, taskId);
    if (previous && !['paused', 'closed'].includes(previous.state) && (previous.generation === null || previous.generation === generation)) {
      throw new Error('binding_fresh_root_required');
    }
    if (
      store.get('SELECT 1 FROM binding_root_segments WHERE product=? AND native_root_id=? AND task_id!=?', ['claude_code', pending.nativeSessionId, taskId])
    ) {
      throw new Error('binding_fresh_root_required');
    }
    const old = store.get<{ proof: string }>(
      `SELECT w.proof FROM ordinary_window_segments w JOIN binding_root_segments s ON s.root_session_id=w.root_session_id
      WHERE s.product='claude_code' AND s.native_root_id=? AND s.task_id=? ORDER BY s.rowid DESC LIMIT 1`,
      [pending.nativeSessionId, taskId]
    );
    let expectedDigest: string | undefined;
    if (old) {
      const proof = OrdinaryWindowConnectionProofSchema.parse(JSON.parse(old.proof));
      if (proof.mode !== 'claude_publisher_local_pin' || proof.productVersion !== context.selection.declaredVersion || proof.sourceRef !== pending.sourceRef) {
        throw new Error('binding_fresh_root_required');
      }
      expectedDigest = proof.nativePinDigest;
    }
    if (previous) {
      store.execute(
        "UPDATE binding_root_segments SET state='closed',closed_at=?,revision=revision+1,observer_identity=NULL WHERE root_session_id=? AND state!='closed'",
        [at, previous.root_session_id]
      );
      store.execute("UPDATE session_bindings SET state='stopped' WHERE root_id=?", [previous.root_session_id]);
    }
    const rootSessionId = randomUUID();
    store.execute('INSERT INTO sessions(id,project_id,task_id,product,product_version) VALUES (?,?,?,?,?)', [
      rootSessionId,
      context.selection.projectId,
      taskId,
      'claude_code',
      context.selection.declaredVersion
    ]);
    store.execute(
      `INSERT INTO binding_root_segments(root_session_id,task_id,product,native_root_id,project_root,state,opened_at)
      VALUES (?,?,?,?,?,'acquiring',?)`,
      [rootSessionId, taskId, 'claude_code', pending.nativeSessionId, context.projectRoot, at]
    );
    store.execute('UPDATE ordinary_tasks SET selected_root_id=? WHERE task_id=?', [rootSessionId, taskId]);
    return { rootSessionId, expectedDigest };
  });
}
export async function collectOrdinaryClaudeWindow(options: OrdinaryClaudeWindowBindingOptions, rootSessionId: string, baseline = false): Promise<void> {
  await readOrdinaryWindowBatch({
    store: options.store,
    taskId: options.taskId,
    rootSessionId,
    baseline,
    clock: options.clock ?? utcNow,
    provider: (_authorizeSource, scope) => claudeWindowProvider(options, issueClaudeWindowSourceAuthorization(options.store, scope, 'observing'))
  });
}
export async function connectOrdinaryClaudeWindow(
  options: OrdinaryClaudeWindowBindingOptions,
  input: CurrentIdentityRequest
): Promise<{ readonly rootSessionId: string; readonly automatic_children: false }> {
  const { store, taskId } = options;
  const clock = options.clock ?? utcNow;
  const generation = new Lifecycle(store, clock).task(taskId).generation;
  const selection = ordinaryWindowSelection(store, taskId);
  const decision = selection ? readOrdinaryWindowDecision(store, ordinaryWindowDecisionKeyForSelection(selection)) : null;
  let scope: OrdinaryWindowScope = {
    taskId,
    generation,
    clock,
    ...(decision === null ? {} : { decisionRef: decision.decision_ref })
  };
  let authorization: ClaudeWindowSourceAuthorization | undefined;
  try {
    const metadata = issueClaudeWindowSourceAuthorization(store, scope, 'metadata');
    const pending = claudeWindowProvider(options, metadata).pendingReceipt(input);
    const at = TimestampSchema.parse(clock());
    const reservation = reserveClaudeWindowRoot(options, pending, generation, metadata, at);
    scope = {
      ...scope,
      rootSessionId: reservation.rootSessionId,
      segmentRevision: 0
    };
    const acquiring = issueClaudeWindowSourceAuthorization(store, scope, 'acquiring');
    authorization = acquiring;
    const proof = await claudeWindowProvider(options, acquiring, reservation.expectedDigest).inspectWindowCurrent(input);
    store.immediateTransaction(() => {
      acquiring();
      if (proof.mode !== 'claude_publisher_local_pin') {
        throw new Error('binding_identity_mismatch');
      }
      const duplicates = store.all<{ proof: string; task_id: string }>(
        `SELECT w.proof,s.task_id FROM ordinary_window_segments w JOIN binding_root_segments s ON s.root_session_id=w.root_session_id
        WHERE s.product='claude_code' AND (json_extract(w.proof,'$.sourceIdentity')=? OR json_extract(w.proof,'$.sourceRef')=?)`,
        [proof.sourceIdentity, proof.sourceRef]
      );
      for (const row of duplicates) {
        const old = OrdinaryWindowConnectionProofSchema.parse(JSON.parse(row.proof));
        if (
          old.mode !== 'claude_publisher_local_pin' ||
          row.task_id !== taskId ||
          old.nativeSessionId !== proof.nativeSessionId ||
          old.nativePinDigest !== proof.nativePinDigest
        ) {
          throw new Error('binding_fresh_root_required');
        }
      }
      recordOrdinaryWindowSegment(store, scope, proof);
      const identity = VerifiedSessionIdentitySchema.parse({
        product: 'claude_code',
        productVersion: proof.productVersion,
        sessionId: proof.nativeSessionId,
        sourceRef: proof.sourceRef,
        sourceIdentity: proof.sourceIdentity,
        cwd: proof.cwd,
        identityEvidenceId: proof.receipt,
        parentSessionId: null,
        createdAt: proof.recordedAt,
        nativeMapping: {
          nativeSessionId: proof.nativeSessionId,
          processId: proof.processId,
          agentId: null
        }
      });
      store.execute(
        `INSERT INTO session_bindings(session_id,task_id,root_id,identity,connect_receipt,observed_since,generation,state,cursor)
        VALUES (?,?,?,?,?,?,?,'observing',NULL)`,
        [reservation.rootSessionId, taskId, reservation.rootSessionId, JSON.stringify(identity), proof.receipt, at, generation]
      );
      store.execute("UPDATE binding_root_segments SET state='observing',revision=revision+1 WHERE root_session_id=?", [reservation.rootSessionId]);
    });
    scope = { ...scope, segmentRevision: 1, cursor: null };
    await collectOrdinaryClaudeWindow(options, reservation.rootSessionId, true);
    assertOrdinaryWindowAuthority(store, {
      taskId,
      rootSessionId: reservation.rootSessionId,
      generation,
      clock,
      ...(scope.decisionRef === undefined ? {} : { decisionRef: scope.decisionRef })
    });
    return {
      rootSessionId: reservation.rootSessionId,
      automatic_children: false
    };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    if (
      scope.rootSessionId === undefined ||
      scope.segmentRevision === 0 ||
      ['binding_window_trial_expired', 'binding_window_trial_budget_exhausted'].includes(error.message)
    ) {
      terminateOrdinaryWindowTrial(store, scope, {
        at: clock(),
        reason:
          error.message === 'binding_window_trial_expired'
            ? 'trial_expired'
            : error.message === 'binding_window_trial_budget_exhausted'
              ? 'trial_budget_exhausted'
              : 'trial_failed'
      });
    }
    store.immediateTransaction(() => {
      try {
        authorization?.();
      } catch (failure) {
        if (!(failure instanceof Error)) throw failure;
        return;
      }
      if (authorization) {
        pauseOrdinaryWindowSegment(store, taskId, TimestampSchema.parse(clock()), 'binding_scope_revoked');
      }
    });
    throw error;
  }
}
