import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { addTokens, TimestampSchema } from './contracts.js';
import { getClaudeBindingAdmission, isClaudeModel } from './claude-binding-admission.js';
import { childReadinessDeadline } from './binding-child-readiness.js';
import { assertApplicationWorkingIdentity, bindApplicationEpoch, effectiveTaskWorkspace } from './harness-application.js';
import { Lifecycle, utcNow, type Clock } from './lifecycle.js';
import { assertOrdinaryTaskPrepared, ordinaryTask, ordinaryTaskSettings } from './ordinary-observation.js';
import { captureObservedCostInput } from './observed-cost-report.js';
import { projectCatalogCost } from './catalog-cost-report.js';
import { readPriceBasis } from './price-catalog-store.js';
import { putUsageWithEvidence, recordObservationGap } from './runtime-history.js';
import { assertCompatibilityAllowed, pinSessionCompatibility, resolveSourceCompatibility } from './source-compatibility.js';
import { BindingUsageRecordSchema, bindingIdentityKey, CurrentIdentityRequestSchema, VerifiedSessionIdentitySchema,
  type BindingProduct, type CurrentIdentityRequest, type NativeConnectionProof, type SessionBindingProvider,
  type VerifiedSessionIdentity } from './session-binding-contract.js';
import type { CandidateScope } from './nested-candidate.js';
import type { UsageEvent } from './flexible-contracts.js';
import type { Store } from './store.js';

interface BindingRow {
  session_id: string; task_id: string; root_id: string; identity: string;
  relation_evidence_id: string | null; connect_receipt: string | null; cursor: string | null;
  observed_since: string; generation: number; state: string; gaps: string;
}
interface Segment {
  root_session_id: string; task_id: string; native_root_id: string; state: string; revision: number;
  project_root: string; observer_identity: string | null; opened_at: string; baseline_at: string | null; closed_at: string | null;
}
export interface OrdinarySourceMetadata {
  readonly nativeSessionId: string; readonly agentId: string | null;
  readonly sourceRef: string; readonly sourceIdentity: string; readonly birthtimeMs: number;
  readonly recordedAt?: string; readonly processId?: string;
}
interface Attempt {
  readonly segment: Segment; readonly generation: number; readonly row?: BindingRow;
  readonly proof?: NativeConnectionProof; readonly members: Map<string, OrdinarySourceMetadata>;
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identityFor = (row: BindingRow) => VerifiedSessionIdentitySchema.parse(JSON.parse(row.identity) as unknown);
const ownerSchema = z.strictObject({ pid: z.number().int().positive(), start: z.string().min(1), instance: z.uuid() });
const metadataKey = (metadata: OrdinarySourceMetadata) => JSON.stringify([metadata.nativeSessionId, metadata.agentId]);
const sameSource = (metadata: OrdinarySourceMetadata, identity: VerifiedSessionIdentity) =>
  metadata.nativeSessionId === (identity.nativeMapping?.nativeSessionId ?? identity.sessionId) &&
  metadata.agentId === (identity.nativeMapping?.agentId ?? null) &&
  metadata.sourceRef === identity.sourceRef && metadata.sourceIdentity === identity.sourceIdentity;

// This is one transactional state machine: its callback fences share the exact
// acquisition/read snapshot, rather than delegating authority to a provider.
export function createOrdinarySessionBindingService(options: {
  store: Store; providersForTask: (taskId: string, deletedProjectRoot?: string) => SessionBindingProvider[]; clock?: Clock;
  syntheticProviderForTask?: (taskId: string) => boolean;
}) {
  const { store } = options; const clock = options.clock ?? utcNow; const life = new Lifecycle(store, clock);
  const processStart = (pid: number) => execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
    encoding: 'utf8', timeout: 2000, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  let observerIdentity: string | null = null;
  const ownIdentity = () => observerIdentity ??= JSON.stringify(ownerSchema.parse({
    pid: process.pid, start: processStart(process.pid), instance: randomUUID(),
  }));
  const queues = new Map<string, Promise<void>>(); const epochs = new Map<string, number>();
  const attempts = new Map<string, Attempt>(); let closed = false;
  const now = () => new Date(TimestampSchema.parse(clock())).toISOString();
  const rows = (taskId: string, rootId?: string) => store.all<BindingRow>(
    `SELECT * FROM session_bindings WHERE task_id=?${rootId ? ' AND root_id=?' : ''} ORDER BY rowid`,
    rootId ? [taskId, rootId] : [taskId]);
  const selected = (taskId: string) => store.get<Segment>(
    'SELECT s.* FROM binding_root_segments s JOIN ordinary_tasks t ON t.selected_root_id=s.root_session_id WHERE t.task_id=?', [taskId]);
  const providerFor = (taskId: string, product: BindingProduct = 'claude_code') => {
    const provider = options.providersForTask(taskId).find(p => p.product === product);
    if (!provider) throw new Error('binding_provider_unavailable');
    return provider;
  };
  const admissionFor = (taskId: string) => {
    const admission = getClaudeBindingAdmission(ordinaryTaskSettings(store, taskId).product_version);
    if (!admission?.admitted) throw new Error('binding_source_unqualified');
    return admission;
  };
  const compatibility = (taskId: string) => {
    const admission = admissionFor(taskId);
    const value = resolveSourceCompatibility('claude_code', admission.productVersion, 'claude_binding', admission.profileId);
    if (!value) throw new Error('binding_source_unqualified');
    assertCompatibilityAllowed(store, value); return value;
  };
  const authorize = (taskId: string, active = false) => {
    if (closed) throw new Error('binding_scope_revoked');
    assertOrdinaryTaskPrepared(store, taskId); const task = life.task(taskId);
    if (active && task.state !== 'active') throw new Error('binding_scope_revoked');
    compatibility(taskId); return task;
  };
  const nativeAvailable = (nativeId: string) => {
    if (store.get("SELECT 1 FROM tombstones WHERE kind='session' AND id=? UNION ALL SELECT 1 FROM session_binding_forgets WHERE product='claude_code' AND native_session_id=?", [nativeId, nativeId]))
      throw new Error('deleted_identifier');
  };
  const assertAttempt = (taskId: string, attempt: Attempt) => {
    const task = authorize(taskId, true); const current = selected(taskId);
    nativeAvailable(attempt.segment.native_root_id);
    if (task.generation !== attempt.generation || !current ||
      current.root_session_id !== attempt.segment.root_session_id || current.revision !== attempt.segment.revision ||
      current.observer_identity !== observerIdentity || !['acquiring', 'observing'].includes(current.state))
      throw new Error('binding_scope_revoked');
    if (attempt.row) {
      const row = store.get<BindingRow>('SELECT * FROM session_bindings WHERE session_id=?', [attempt.row.session_id]);
      if (!row || row.state !== 'observing' || row.generation !== attempt.generation ||
        row.identity !== attempt.row.identity || row.cursor !== attempt.row.cursor) throw new Error('binding_scope_revoked');
    }
    return task;
  };
  const assertSource = (taskId: string, metadata: OrdinarySourceMetadata): void => {
    nativeAvailable(metadata.nativeSessionId);
    const attempt = attempts.get(taskId);
    if (!attempt) throw new Error('binding_scope_revoked');
    assertAttempt(taskId, attempt);
    if (metadata.nativeSessionId !== attempt.segment.native_root_id) throw new Error('binding_identity_mismatch');
    if (metadata.agentId === null) {
      const proof = attempt.proof;
      const root = rows(taskId, attempt.segment.root_session_id).find(r => r.session_id === r.root_id);
      if (proof ? metadata.sourceRef !== proof.sourceRef || metadata.sourceIdentity !== proof.sourceIdentity :
        !root || !sameSource(metadata, identityFor(root))) throw new Error('binding_identity_mismatch');
      return;
    }
    const bound = rows(taskId, attempt.segment.root_session_id).find(row => sameSource(metadata, identityFor(row)));
    const admitted = attempt.members.get(metadataKey(metadata));
    if (!bound && (!admitted || admitted.sourceRef !== metadata.sourceRef || admitted.sourceIdentity !== metadata.sourceIdentity ||
      admitted.birthtimeMs !== metadata.birthtimeMs)) throw new Error('binding_member_ineligible');
  };
  const memberEligible = (taskId: string, metadata: OrdinarySourceMetadata): boolean => {
    nativeAvailable(metadata.nativeSessionId);
    const attempt = attempts.get(taskId); if (!attempt) return false;
    assertAttempt(taskId, attempt);
    if (metadata.agentId === null || metadata.nativeSessionId !== attempt.segment.native_root_id) return false;
    const existing = rows(taskId, attempt.segment.root_session_id).find(row => {
      const value = identityFor(row);
      return value.nativeMapping?.nativeSessionId === metadata.nativeSessionId && value.nativeMapping.agentId === metadata.agentId;
    });
    if (existing) {
      if (!sameSource(metadata, identityFor(existing))) throw new Error('binding_identity_mismatch');
      return true;
    }
    const permitted = attempt.members.get(metadataKey(metadata));
    if (permitted) {
      if (permitted.sourceRef !== metadata.sourceRef || permitted.sourceIdentity !== metadata.sourceIdentity ||
        permitted.birthtimeMs !== metadata.birthtimeMs) throw new Error('binding_identity_mismatch');
      return true;
    }
    const root = rows(taskId, attempt.segment.root_session_id).find(row => row.session_id === row.root_id);
    const processId = root ? identityFor(root).nativeMapping?.processId : attempt.proof?.processId;
    const boundary = Date.parse(attempt.segment.baseline_at ?? attempt.segment.opened_at);
    if (metadata.recordedAt === undefined) {
      if (Number.isFinite(metadata.birthtimeMs) && metadata.birthtimeMs <= boundary) return false;
      throw new Error('binding_ancestry_unverified');
    }
    if (!Number.isFinite(metadata.birthtimeMs) || metadata.birthtimeMs <= boundary || metadata.birthtimeMs > Date.parse(now()) ||
      !metadata.recordedAt || !Number.isFinite(Date.parse(metadata.recordedAt)) ||
      Date.parse(metadata.recordedAt) <= boundary || Date.parse(metadata.recordedAt) > Date.parse(now()) ||
      !metadata.processId || metadata.processId !== processId) return false;
    if (rows(taskId, attempt.segment.root_session_id).length + attempt.members.size >= admissionFor(taskId).maxFamilyMembers)
      throw new Error('binding_family_limit');
    attempt.members.set(metadataKey(metadata), metadata); return true;
  };
  const ownerAvailable = (segment: Segment) => {
    const current = store.get<Segment>('SELECT * FROM binding_root_segments WHERE root_session_id=?', [segment.root_session_id]);
    if (!current || current.state === 'closed' || selected(segment.task_id)?.root_session_id !== segment.root_session_id)
      throw new Error('binding_scope_revoked');
    if (current.observer_identity === null || current.observer_identity === observerIdentity) return;
    const owner = ownerSchema.parse(JSON.parse(current.observer_identity) as unknown);
    try {
      process.kill(owner.pid, 0);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return;
      throw new Error('binding_observer_owned', { cause: error });
    }
    // A reused PID is a proved-dead owner. Failure to inspect a live PID is not.
    let start: string;
    try { start = processStart(owner.pid); } catch (error) { throw new Error('binding_observer_owned', { cause: error }); }
    if (!start || start === owner.start) throw new Error('binding_observer_owned');
  };
  const serialized = <T>(taskId: string, work: () => Promise<T>): Promise<T> => {
    const epoch = epochs.get(taskId) ?? 0;
    const result = (queues.get(taskId) ?? Promise.resolve()).then(() => {
      if (closed || epoch !== (epochs.get(taskId) ?? 0)) throw new Error('binding_scope_revoked');
      return work();
    });
    const tail = result.then(() => {}, () => {}); queues.set(taskId, tail);
    return result.finally(() => { if (queues.get(taskId) === tail) queues.delete(taskId); });
  };
  const scoped = async <T>(taskId: string, attempt: Attempt, work: () => Promise<T>): Promise<T> => {
    assertAttempt(taskId, attempt); attempts.set(taskId, attempt);
    try { return await work(); } finally { if (attempts.get(taskId) === attempt) attempts.delete(taskId); }
  };
  const scopeFor = (taskId: string, rootId: string): CandidateScope => {
    const family = rows(taskId, rootId);
    const root = family.find(row => row.session_id === rootId);
    if (!root) throw new Error('binding_reconnect_required');
    const processId = identityFor(root).nativeMapping?.processId ?? null;
    return {
    taskId, projectId: life.task(taskId).project_id, allowedRootTurnIds: ['binding-observation'],
    sessions: family.map(row => {
      const value = identityFor(row);
      const parent = store.get<{ parent_id: string | null }>('SELECT parent_id FROM sessions WHERE id=?', [row.session_id]);
      return { sessionId: row.session_id, rootSessionId: rootId, parentSessionId: parent?.parent_id ?? null,
        sourceId: value.sessionId, product: value.product, nativeSessionId: value.nativeMapping?.nativeSessionId ?? value.sessionId,
        agentId: value.nativeMapping?.agentId ?? null, processId };
    }),
    };
  };
  const read = async (taskId: string, segment: Segment, row: BindingRow, baseline: boolean) => {
    const value = identityFor(row); const attempt: Attempt = { segment, row, generation: row.generation, members: new Map() };
    const keyFor = (requestId: string) => hash(['binding-request-v1', value.product, requestId]);
    const addExcluded = (requestIds: readonly string[]) => store.immediateTransaction(() => {
      assertAttempt(taskId, attempt);
      for (const requestId of requestIds)
        store.execute('INSERT OR IGNORE INTO binding_baseline_exclusions(session_id,source_identity,request_key) VALUES (?,?,?)',
          [row.session_id, value.sourceIdentity, keyFor(requestId)]);
    });
    const ledger = {
      has: (requestId: string) => {
        assertAttempt(taskId, attempt);
        return !!store.get('SELECT 1 FROM binding_baseline_exclusions WHERE session_id=? AND source_identity=? AND request_key=?',
          [row.session_id, value.sourceIdentity, keyFor(requestId)]);
      },
      add: (requestId: string) => addExcluded([requestId]),
      addMany: addExcluded,
    };
    const batch = await scoped(taskId, attempt, () => providerFor(taskId).readUsage(value, baseline ? null : row.cursor,
      scopeFor(taskId, row.root_id), { baseline, baselineLedger: ledger }));
    assertAttempt(taskId, attempt);
    if (typeof batch.cursor !== 'string' || batch.cursor.length > 6 * 1024 * 1024 ||
      batch.records.length > 65536 || (batch.excludedRecords?.length ?? 0) > 65536) throw new Error('binding_usage_invalid');
    const records = batch.records.map(record => BindingUsageRecordSchema.parse(record));
    const excluded = (batch.excludedRecords ?? []).map(record => BindingUsageRecordSchema.parse(record));
    store.immediateTransaction(() => {
      const task = assertAttempt(taskId, attempt);
      let excludedBoundary = baseline;
      for (const record of [...records, ...excluded]) {
        if (record.sessionId !== value.sessionId || record.payload.product !== value.product ||
          record.payload.product_version !== value.productVersion || Date.parse(record.occurredAt) > Date.parse(now()))
          throw new Error('binding_usage_invalid');
        if (!isClaudeModel(record.payload.model)) throw new Error('binding_runtime_unsupported');
      }
      for (const record of excluded) ledger.add(record.requestId);
      for (const record of records) {
        if (baseline) { ledger.add(record.requestId); continue; }
        if (ledger.has(record.requestId)) continue;
        if (Date.parse(record.occurredAt) < Date.parse(row.observed_since)) {
          ledger.add(record.requestId); excludedBoundary = true; continue;
        }
        const key = keyFor(record.requestId); const fingerprint = hash(record);
        const old = store.get<{ fingerprint: string }>('SELECT fingerprint FROM binding_requests WHERE request_key=?', [key]);
        if (old) { if (old.fingerprint !== fingerprint) throw new Error('binding_request_conflict'); continue; }
        if (store.get("SELECT 1 FROM runtime_evidence r LEFT JOIN session_bindings b ON b.session_id=r.session_id WHERE json_extract(r.payload,'$.request_id')=? AND (json_extract(r.payload,'$.product')=? OR (json_extract(r.payload,'$.product')='synthetic' AND (b.identity IS NULL OR json_extract(b.identity,'$.product')=?)))", [record.requestId, value.product, value.product]))
          throw new Error('binding_request_conflict');
        const runtimeId = hash(['binding-runtime', key]);
        putUsageWithEvidence(store, { id: key, source_key: key, task_id: taskId, project_id: task.project_id,
          session_id: row.session_id, occurred_at: record.occurredAt, payload: { ...record.payload, runtime_evidence_id: runtimeId } },
        { id: runtimeId, task_id: taskId, session_id: row.session_id, turn_id: record.turnId, request_id: record.requestId,
          model: record.payload.model, effort: record.effort, product: value.product, product_version: value.productVersion,
          source: 'product_log', occurred_at: record.occurredAt, recorded_at: now(), boundary: 'request' });
        store.execute('INSERT INTO binding_requests(request_key,event_id,fingerprint) VALUES (?,?,?)', [key, key, fingerprint]);
      }
      const previousGaps = z.array(z.string()).parse(JSON.parse(row.gaps) as unknown);
      const currentGaps = [...batch.gaps, ...(excludedBoundary ? ['binding_unobserved_context'] : [])];
      const gaps = [...new Set([...previousGaps, ...currentGaps])];
      if (!baseline && currentGaps.some(gap => !previousGaps.includes(gap)))
        recordObservationGap(store, taskId, row.session_id, row.observed_since, now(), 'incomplete', now());
      store.execute('UPDATE session_bindings SET cursor=?,gaps=? WHERE session_id=?', [batch.cursor, JSON.stringify(gaps), row.session_id]);
    });
  };
  const checkIdentity = (taskId: string, input: VerifiedSessionIdentity, measurementSessionId?: string) => {
    const value = VerifiedSessionIdentitySchema.parse(input); authorize(taskId, true);
    if (value.product !== 'claude_code' || value.productVersion !== admissionFor(taskId).productVersion ||
      value.cwd !== effectiveTaskWorkspace(store, taskId)) throw new Error('binding_identity_mismatch');
    nativeAvailable(value.nativeMapping?.nativeSessionId ?? value.sessionId);
    assertApplicationWorkingIdentity(store, taskId, value, measurementSessionId); return value;
  };
  const insertBinding = (taskId: string, segment: Segment, input: {
    value: VerifiedSessionIdentity; measurementId: string; parentId: string | null; relation: string | null; receipt: string | null;
  }) => {
    const task = authorize(taskId, true);
    if (input.parentId !== null) store.execute('INSERT INTO sessions(id,project_id,task_id,parent_id,product,product_version) VALUES (?,?,?,?,?,?)',
      [input.measurementId, task.project_id, taskId, input.parentId, input.value.product, input.value.productVersion]);
    pinSessionCompatibility(store, input.measurementId, compatibility(taskId));
    bindApplicationEpoch(store, taskId, input.measurementId);
    store.execute("INSERT INTO session_bindings(session_id,task_id,root_id,identity,relation_evidence_id,connect_receipt,observed_since,generation,state) VALUES (?,?,?,?,?,?,?,?,'observing')",
      [input.measurementId, taskId, segment.root_session_id, JSON.stringify(input.value), input.relation, input.receipt,
        segment.baseline_at ?? segment.opened_at, task.generation]);
  };
  const discover = async (taskId: string, segment: Segment) => {
    const root = rows(taskId, segment.root_session_id).find(row => row.session_id === segment.root_session_id);
    if (!root) throw new Error('binding_reconnect_required');
    const attempt: Attempt = { segment, row: root, generation: root.generation, members: new Map() };
    const result = await scoped(taskId, attempt, () => providerFor(taskId).discoverChildren(identityFor(root)));
    assertAttempt(taskId, attempt);
    const pending = childReadinessDeadline(result) !== undefined;
    if (result.gaps.some(gap => gap !== 'binding_unobserved_context' && !(pending && gap === 'source_unavailable')))
      throw new Error('binding_ancestry_unverified');
    store.immediateTransaction(() => {
      assertAttempt(taskId, attempt);
      if (result.gaps.length) {
        const prior = z.array(z.string()).parse(JSON.parse(root.gaps) as unknown);
        const reason = pending ? 'binding_child_pending' : 'binding_unobserved_context';
        if (!prior.includes(reason)) {
          recordObservationGap(store, taskId, root.session_id, root.observed_since, now(), 'incomplete', now());
          store.execute('UPDATE session_bindings SET gaps=? WHERE session_id=?',
            [JSON.stringify([...prior, reason]), root.session_id]);
        }
      }
      for (const child of result.children) {
        const value = checkIdentity(taskId, child.identity);
        if (value.parentSessionId !== identityFor(root).sessionId || child.parentSessionId !== value.parentSessionId ||
          !child.relationEvidenceId || value.nativeMapping?.nativeSessionId !== segment.native_root_id ||
          !value.nativeMapping.agentId) throw new Error('binding_relation_invalid');
        const old = rows(taskId, segment.root_session_id).find(row => identityFor(row).sessionId === value.sessionId);
        if (old) {
          checkIdentity(taskId, value, old.session_id);
          if (bindingIdentityKey(identityFor(old)) !== bindingIdentityKey(value) || old.relation_evidence_id !== child.relationEvidenceId)
            throw new Error('binding_identity_mismatch');
          continue;
        }
        const admitted = attempt.members.get(metadataKey({
          nativeSessionId: value.nativeMapping.nativeSessionId, agentId: value.nativeMapping.agentId,
          sourceRef: value.sourceRef, sourceIdentity: value.sourceIdentity, birthtimeMs: 0,
        }));
        if (!admitted || !sameSource(admitted, value) || Date.parse(value.createdAt) < Date.parse(segment.baseline_at ?? segment.opened_at))
          throw new Error('binding_member_ineligible');
        if (rows(taskId, segment.root_session_id).length >= admissionFor(taskId).maxFamilyMembers) throw new Error('binding_family_limit');
        insertBinding(taskId, segment, { value, measurementId: randomUUID(), parentId: root.session_id,
          relation: child.relationEvidenceId, receipt: null });
      }
    });
  };
  const fence = (taskId: string, state: 'paused' | 'stopping', explicitStop = false) => {
    const segment = selected(taskId);
    if (segment && segment.state !== 'closed' && !explicitStop) ownerAvailable(segment);
    epochs.set(taskId, (epochs.get(taskId) ?? 0) + 1);
    if (!segment || segment.state === 'closed') return segment;
    store.immediateTransaction(() => {
      if (!explicitStop) ownerAvailable(segment);
      store.execute('UPDATE binding_root_segments SET state=?,revision=revision+1,observer_identity=CASE WHEN ? THEN NULL ELSE observer_identity END WHERE root_session_id=?',
        [state, explicitStop ? 1 : 0, segment.root_session_id]);
      store.execute("UPDATE session_bindings SET state='stopped',cursor=NULL WHERE root_id=?", [segment.root_session_id]);
    });
    return segment;
  };
  const gapAndPause = (taskId: string, segment: Segment) => {
    for (const row of rows(taskId, segment.root_session_id))
      store.execute('UPDATE session_bindings SET gaps=? WHERE session_id=?',
        [JSON.stringify([...new Set([...z.array(z.string()).parse(JSON.parse(row.gaps) as unknown), 'unobserved_interval'])]), row.session_id]);
    if (life.state(taskId) === 'active') {
      for (const row of rows(taskId, segment.root_session_id))
        recordObservationGap(store, taskId, row.session_id, row.observed_since, now(), 'incomplete', now());
      life.pause(taskId);
    }
  };
  const pause = (taskId: string): void => { const segment = fence(taskId, 'paused'); if (segment) gapAndPause(taskId, segment); };
  const closeSegment = (taskId: string, segment: Segment) => {
    store.immediateTransaction(() => {
      const current = selected(taskId);
      if (!current || current.root_session_id !== segment.root_session_id) throw new Error('binding_scope_revoked');
      ownerAvailable(current);
      store.execute("UPDATE binding_root_segments SET state='closed',revision=revision+1,observer_identity=NULL,closed_at=? WHERE root_session_id=?", [now(), segment.root_session_id]);
      store.execute('UPDATE ordinary_tasks SET selected_root_id=NULL WHERE task_id=?', [taskId]);
    });
  };
  const stopObservation = (taskId: string): Promise<void> => {
    const segment = fence(taskId, 'stopping', true); const drain = queues.get(taskId) ?? Promise.resolve();
    if (!segment) return drain;
    return drain.then(() => {
      try { gapAndPause(taskId, segment); } finally { closeSegment(taskId, segment); }
    });
  };
  let forgetting: Promise<void> | undefined;
  const flushForgotten = (): Promise<void> => {
    if (forgetting) return forgetting;
    forgetting = (async () => {
      for (const row of store.all<{ product: BindingProduct; native_session_id: string; task_id: string; project_root: string }>('SELECT * FROM session_binding_forgets')) {
        try {
          const provider = options.providersForTask(row.task_id, row.project_root).find(p => p.product === row.product);
          if (!provider?.forgetSession) throw new Error('binding_provider_unavailable');
          await provider.forgetSession(row.native_session_id);
          store.execute('DELETE FROM session_binding_forgets WHERE product=? AND native_session_id=?', [row.product, row.native_session_id]);
        } catch {
          store.execute("UPDATE session_binding_forgets SET reason_code='binding_forget_pending' WHERE product=? AND native_session_id=?", [row.product, row.native_session_id]);
        }
      }
    })().finally(() => { forgetting = undefined; });
    return forgetting;
  };
  const sourceSupported = (taskId: string, product: BindingProduct): boolean => {
    authorize(taskId);
    if (product !== 'claude_code') return false;
    const provider = providerFor(taskId, product);
    return !!provider.inspectCurrent && provider.capabilities().usage === 'own_requests' &&
      (options.syntheticProviderForTask?.(taskId) === true ||
        (admissionFor(taskId).admitted && provider.capabilities().productionSupported));
  };
  const status = (taskId: string) => {
    const task = life.task(taskId); const all = rows(taskId); const segment = selected(taskId);
    const tableId = ordinaryTask(store, taskId)?.price_table_id;
    if (!tableId) throw new Error('ordinary_preparation_required');
    const cutoff = now(); const capture = captureObservedCostInput(store, taskId, tableId, cutoff, 'output-only-v1');
    const keys = new Set(store.all<{ event_id: string }>('SELECT r.event_id FROM binding_requests r JOIN events e ON e.id=r.event_id WHERE e.task_id=?', [taskId]).map(row => row.event_id));
    const eligible = capture.events.filter(event => keys.has(event.id));
    const total = (events: UsageEvent[], field: 'input_total' | 'output_total') => {
      const readings = events.map(event => event.payload[field]); const observed = readings.filter(reading => reading.status === 'observed');
      return { status: readings.length && readings.length === observed.length ? 'observed' : observed.length ? 'partial' : 'missing',
        value: observed.length ? addTokens(observed.map(reading => reading.value)) : null,
        statuses: [...new Set(readings.map(reading => reading.status))].sort(),
        reasons: [...new Set(readings.flatMap(reading => reading.reason ? [reading.reason] : []))].sort() };
    };
    const summarize = (events: UsageEvent[]) => {
      const priced = projectCatalogCost(events, readPriceBasis(store, tableId), taskId, cutoff, 'output-only-v1',
        { referenceBinding: true, runtimeEvidence: capture.runtimeEvidence });
      return { requests: events.length || null, input_total: total(events, 'input_total'), output_total: total(events, 'output_total'),
        partial_amount: priced.partial_amount, compatibility_unverified_partial_amount: priced.compatibility_unverified_partial_amount,
        legacy_unverified_partial_amount: priced.legacy_unverified_partial_amount, compatibility: priced.compatibility,
        unpriced_events: priced.unpriced_events, currency: priced.currency, price_table_id: tableId, cost_coverage: 'partial' as const, complete_cost: null };
    };
    return { state: task.state === 'active' && segment?.state === 'observing' ? 'observing' : all.length ? 'stopped' : 'unconnected',
      selected_root_id: segment?.root_session_id ?? null, segment_state: segment?.state ?? null,
      price_table_hash: capture.report.price_table_hash,
      roots: all.filter(row => row.session_id === row.root_id).length, children: all.filter(row => row.session_id !== row.root_id).length,
      sessions: all.map(row => {
        const value = identityFor(row); const events = eligible.filter(event => event.session_id === row.session_id);
        const parent = store.get<{ parent_id: string | null }>('SELECT parent_id FROM sessions WHERE id=?', [row.session_id]);
        return { session_id: row.session_id, parent_session_id: parent?.parent_id ?? null, identity_basis: 'native_metadata_receipt',
          agent_metadata: value.agentMetadata?.source === 'claude_hook' ?
            { source: value.agentMetadata.source, agent_type: value.agentMetadata.agentType } : null,
          models: [...new Set(events.flatMap(event => event.payload.model ? [event.payload.model] : []))].sort(), ...summarize(events) };
      }), summary: summarize(eligible), requests: keys.size,
      gaps: [...new Set(all.flatMap(row => z.array(z.string()).parse(JSON.parse(row.gaps) as unknown)))],
      cost_coverage: 'partial' as const, complete_cost: null, inference: false };
  };
  const connect = (taskId: string, product: BindingProduct, request: CurrentIdentityRequest) => serialized(taskId, async () => {
    const before = authorize(taskId); const provider = providerFor(taskId, product);
    const epoch = epochs.get(taskId) ?? 0;
    const input = CurrentIdentityRequestSchema.parse(request);
    if (!sourceSupported(taskId, product) || !provider.inspectCurrent) throw new Error('binding_source_unqualified');
    const previous = selected(taskId);
    if (previous) { nativeAvailable(previous.native_root_id); ownerAvailable(previous); }
    const proof = await provider.inspectCurrent(input);
    authorize(taskId);
    if (epoch !== (epochs.get(taskId) ?? 0) || life.task(taskId).generation !== before.generation)
      throw new Error('binding_scope_revoked');
    nativeAvailable(proof.nativeSessionId);
    if (proof.receipt !== input.receipt || proof.agentId !== null || proof.cwd !== effectiveTaskWorkspace(store, taskId) ||
      proof.productVersion !== admissionFor(taskId).productVersion || !proof.processId ||
      !proof.sourceRef || !proof.sourceIdentity || Date.parse(proof.recordedAt) > Date.parse(now()) ||
      !Number.isFinite(Date.parse(proof.recordedAt))) throw new Error('binding_identity_mismatch');
    const stop = store.get<{ boundary: string | null }>("SELECT max(closed_at) AS boundary FROM binding_root_segments WHERE product='claude_code' AND native_root_id=?", [proof.nativeSessionId])?.boundary;
    if (stop && Date.parse(proof.recordedAt) <= Date.parse(stop)) throw new Error('binding_receipt_stale');
    const reservation = store.get<Segment>("SELECT * FROM binding_root_segments WHERE native_root_id=? AND state!='closed'", [proof.nativeSessionId]);
    if (reservation && reservation.task_id !== taskId) throw new Error('binding_session_conflict');
    if (previous?.state === 'observing' && previous.native_root_id === proof.nativeSessionId) {
      const root = rows(taskId, previous.root_session_id).find(row => row.session_id === row.root_id);
      if (!root || proof.sourceRef !== identityFor(root).sourceRef || proof.sourceIdentity !== identityFor(root).sourceIdentity ||
        proof.processId !== identityFor(root).nativeMapping?.processId) throw new Error('binding_identity_mismatch');
      if (previous.observer_identity !== observerIdentity) throw new Error('binding_reconnect_required');
      return { ...status(taskId), status: 'already_connected', session_id: previous.root_session_id, automatic_children: true };
    }
    // Explicit connect replaces the selected segment; resume is the only path
    // that can reactivate that same measurement root.
    if (previous) {
      const fenced = fence(taskId, 'stopping');
      if (fenced) { gapAndPause(taskId, fenced); closeSegment(taskId, fenced); }
    }
    const rootId = randomUUID(); const at = now();
    const segment: Segment = { root_session_id: rootId, task_id: taskId, native_root_id: proof.nativeSessionId,
      project_root: proof.cwd, state: 'acquiring', revision: 0, observer_identity: ownIdentity(), opened_at: at, baseline_at: null, closed_at: null };
    store.immediateTransaction(() => {
      authorize(taskId);
      const task = life.task(taskId);
      if (task.generation !== before.generation && !previous) throw new Error('binding_scope_revoked');
      if (task.state === 'registered') life.start(taskId); else if (task.state === 'paused') life.resume(taskId);
      store.execute('INSERT INTO sessions(id,project_id,task_id,product,product_version) VALUES (?,?,?,?,?)',
        [rootId, task.project_id, taskId, 'claude_code', proof.productVersion]);
      store.execute("INSERT INTO binding_root_segments(root_session_id,task_id,product,native_root_id,project_root,state,observer_identity,opened_at) VALUES (?,?,'claude_code',?,?,'acquiring',?,?)",
        [rootId, taskId, proof.nativeSessionId, proof.cwd, ownIdentity(), at]);
      store.execute('UPDATE ordinary_tasks SET selected_root_id=? WHERE task_id=?', [rootId, taskId]);
    });
    const attempt: Attempt = { segment, generation: life.task(taskId).generation, proof, members: new Map() };
    try {
      const value = checkIdentity(taskId, await scoped(taskId, attempt, () => provider.resolveCurrent(input)), rootId);
      assertAttempt(taskId, attempt);
      if (value.sessionId !== proof.nativeSessionId || value.parentSessionId !== null ||
        value.sourceRef !== proof.sourceRef || value.sourceIdentity !== proof.sourceIdentity ||
        value.nativeMapping?.nativeSessionId !== proof.nativeSessionId || value.nativeMapping.agentId !== null ||
        value.nativeMapping.processId !== proof.processId) throw new Error('binding_identity_mismatch');
      store.immediateTransaction(() => {
        assertAttempt(taskId, attempt);
        insertBinding(taskId, segment, { value, measurementId: rootId, parentId: null, relation: null, receipt: input.receipt });
        store.execute("UPDATE binding_root_segments SET state='observing',baseline_at=? WHERE root_session_id=?", [at, rootId]);
      });
      const observing = selected(taskId);
      const root = rows(taskId, rootId).find(row => row.session_id === rootId);
      if (!observing || !root) throw new Error('binding_scope_revoked');
      await read(taskId, observing, root, true);
      const boundary = now();
      store.immediateTransaction(() => {
        assertAttempt(taskId, attempt);
        recordObservationGap(store, taskId, rootId, at, boundary, 'incomplete', boundary);
        store.execute('UPDATE binding_root_segments SET baseline_at=? WHERE root_session_id=?', [boundary, rootId]);
        store.execute('UPDATE session_bindings SET observed_since=? WHERE session_id=?', [boundary, rootId]);
      });
    } catch (error) {
      const current = selected(taskId);
      if (current?.root_session_id === rootId && current.observer_identity === observerIdentity && ['acquiring', 'observing'].includes(current.state))
        pause(taskId);
      throw error;
    }
    return { ...status(taskId), status: 'connected', session_id: rootId, automatic_children: true };
  });
  const resumeAvailable = (taskId: string) => {
    const segment = selected(taskId);
    if (segment && store.get("SELECT 1 FROM tombstones WHERE kind='session' AND id=? UNION ALL SELECT 1 FROM session_binding_forgets WHERE product='claude_code' AND native_session_id=?",
      [segment.native_root_id, segment.native_root_id])) return false;
    const root = segment ? rows(taskId, segment.root_session_id).find(row => row.session_id === segment.root_session_id) : undefined;
    return !!segment && segment.state !== 'closed' && !!root &&
      CurrentIdentityRequestSchema.safeParse({ receipt: root.connect_receipt }).success;
  };
  const resume = (taskId: string) => serialized(taskId, async () => {
    authorize(taskId); const segment = selected(taskId);
    if (!segment || segment.state === 'closed' || segment.state === 'stopping')
      throw new Error('binding_reconnect_required');
    nativeAvailable(segment.native_root_id); ownerAvailable(segment);
    if (!resumeAvailable(taskId)) throw new Error('binding_reconnect_required');
    if (segment.state === 'observing' && segment.observer_identity === observerIdentity) throw new Error('binding_reconnect_required');
    const root = rows(taskId, segment.root_session_id).find(row => row.session_id === segment.root_session_id);
    if (!root?.connect_receipt || !providerFor(taskId).revalidateBound) throw new Error('binding_reconnect_required');
    const expected = identityFor(root);
    store.immediateTransaction(() => {
      authorize(taskId); ownerAvailable(segment);
      store.execute("UPDATE binding_root_segments SET state='paused',revision=revision+1,observer_identity=? WHERE root_session_id=?", [ownIdentity(), segment.root_session_id]);
      store.execute("UPDATE session_bindings SET state='stopped',cursor=NULL WHERE root_id=?", [segment.root_session_id]);
    });
    gapAndPause(taskId, segment);
    store.immediateTransaction(() => {
      authorize(taskId); if (life.state(taskId) === 'paused') life.resume(taskId);
      const generation = life.task(taskId).generation;
      store.execute("UPDATE binding_root_segments SET state='acquiring',revision=revision+1 WHERE root_session_id=?", [segment.root_session_id]);
      store.execute("UPDATE session_bindings SET state='observing',generation=?,cursor=NULL WHERE root_id=?", [generation, segment.root_session_id]);
    });
    const current = selected(taskId);
    if (!current) throw new Error('binding_scope_revoked');
    const attempt: Attempt = { segment: current, generation: life.task(taskId).generation, members: new Map() };
    try {
      const provider = providerFor(taskId);
      if (!provider.revalidateBound) throw new Error('binding_reconnect_required');
      const value = await scoped(taskId, attempt, () => provider.revalidateBound
        ? provider.revalidateBound({ receipt: root.connect_receipt ?? '' }, expected) : Promise.reject(new Error('binding_reconnect_required')));
      assertAttempt(taskId, attempt); checkIdentity(taskId, value, root.session_id);
      if (bindingIdentityKey(expected) !== bindingIdentityKey(value)) throw new Error('binding_identity_mismatch');
      for (const row of rows(taskId, current.root_session_id)) await read(taskId, current, row, true);
      const boundary = now();
      store.immediateTransaction(() => {
        assertAttempt(taskId, attempt);
        for (const row of rows(taskId, current.root_session_id))
          recordObservationGap(store, taskId, row.session_id, row.observed_since, boundary, 'incomplete', boundary);
        store.execute("UPDATE binding_root_segments SET state='observing',baseline_at=? WHERE root_session_id=?", [boundary, current.root_session_id]);
        store.execute('UPDATE session_bindings SET observed_since=? WHERE root_id=?', [boundary, current.root_session_id]);
      });
    } catch (error) { pause(taskId); throw error; }
    return { ...status(taskId), status: 'reconnected', session_id: current.root_session_id, automatic_children: true };
  });
  const tick = (taskId: string) => serialized(taskId, async () => {
    const segment = selected(taskId);
    if (!segment || segment.state !== 'observing' || life.state(taskId) !== 'active') return status(taskId);
    authorize(taskId, true); nativeAvailable(segment.native_root_id);
    if (segment.observer_identity !== observerIdentity) throw new Error('binding_observer_owned');
    await discover(taskId, segment);
    for (const row of rows(taskId, segment.root_session_id)) await read(taskId, segment, row, false);
    return status(taskId);
  });
  const close = (): Promise<void> => {
    if (observerIdentity === null) { closed = true; return Promise.resolve(); }
    const owned = store.all<Segment>("SELECT * FROM binding_root_segments WHERE observer_identity=? AND state!='closed'", [observerIdentity]);
    const failures: unknown[] = [];
    for (const segment of owned) {
      try { pause(segment.task_id); } catch (error) { failures.push(error); }
    }
    closed = true;
    return Promise.all([...queues.values()]).then(() => {
      store.execute("UPDATE binding_root_segments SET observer_identity=NULL,revision=revision+1 WHERE observer_identity=? AND state='paused'", [observerIdentity]);
      if (failures.length) throw new AggregateError(failures, 'binding_close_failed');
    });
  };
  for (const segment of store.all<Segment>("SELECT * FROM binding_root_segments WHERE state!='closed'")) {
    try { ownerAvailable(segment); }
    catch (error) {
      if (error instanceof Error && error.message === 'binding_observer_owned') continue;
      throw error;
    }
    const stopped = fence(segment.task_id, 'paused');
    if (stopped) {
      gapAndPause(segment.task_id, stopped);
      store.execute('UPDATE binding_root_segments SET observer_identity=NULL WHERE root_session_id=?',
        [stopped.root_session_id]);
    }
  }
  return { status, connect, resume, resumeAvailable, tick, pause, stopObservation, close, flushForgotten,
    sourceSupported, capabilities: (taskId: string, product: BindingProduct) => providerFor(taskId, product).capabilities(),
    assertSource, memberEligible };
}
export type OrdinarySessionBindingService = ReturnType<typeof createOrdinarySessionBindingService>;
