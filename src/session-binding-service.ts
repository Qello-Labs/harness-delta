import { childReadinessDeadline, childReadinessStarts, type ChildReadinessObservation, type PendingChildStart } from './binding-child-readiness.js';
import { setTimeout as delay } from 'node:timers/promises';
import { familyRejection, takeFamilyDiagnostic, type FamilyDiagnostic, type FamilyPhase } from './binding-family-diagnostics.js';
import { applicationRequired, assertApplicationWorkingIdentity, bindApplicationEpoch, effectiveTaskWorkspace } from './harness-application.js';
import { CodexSessionBindingProvider } from './session-binding-codex.js';
import { addTokens } from './contracts.js';
import { captureObservedCostInput, projectObservedCost } from './observed-cost-report.js';
import { projectCatalogCost } from './catalog-cost-report.js';
import { readPriceBasis } from './price-catalog-store.js';
import type { UsageEvent } from './flexible-contracts.js';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Lifecycle, utcNow, type Clock } from './lifecycle.js';
import { parseTaskMetadata, parseProtocol } from './flexible-contracts.js';
import { externalContract, bindingCollectionControl } from './external-session-contract.js';
import { assertExternalPrepared } from './external-session-workflow.js';
import { bindConfigurationToSession } from './config-confirmation.js';
import { putUsageWithEvidence, recordObservationGap } from './runtime-history.js';
import { selectTaskPriceTable } from './price-catalog-selection.js';
import { comparisonProtocol, protocolRow } from './comparison.js';
import { BindingUsageRecordSchema, bindingIdentityKey, CurrentIdentityRequestSchema, VerifiedSessionIdentitySchema,
  type BindingProduct, type BindingUsageRecord, type CurrentIdentityRequest, type SessionBindingProvider, type VerifiedSessionIdentity } from './session-binding-contract.js';
import type { CandidateScope } from './nested-candidate.js';
import type { Store } from './store.js';
import { assertBindingQualification, bindingQualificationCompatibility, bindingQualificationOwnerLive, noteBindingQualificationTransition, checkBindingQualificationIdentity, checkBindingQualificationRecord, type BindingQualificationLease } from './session-binding-qualification-lease.js';
import type { ExternalTaskSetup } from './external-session-service.js';
import { assertHumanPilotScope, checkHumanPilotIdentity, humanPilotCompatibility, type HumanPilotScope } from './session-binding-human-pilot.js';
import { isClaudeHumanPilotScope } from './session-binding-claude-human-pilot.js';
import { assertCompatibilityAllowed, pinSessionCompatibility, invalidateCompatibility, resolveSourceCompatibility } from './source-compatibility.js';
import { codexBindingAdmission, isAdmittedCodexBindingProtocol, isCodexGptModel } from './codex-binding-admission.js';
import { lstatSync } from 'node:fs';

interface BindingRow { session_id: string; task_id: string; root_id: string; identity: string;
  relation_evidence_id: string | null; connect_receipt: string | null; cursor: string | null; observed_since: string; generation: number; state: string; gaps: string }
/** Paid-run safety counts include guarded reads whose later storage fails.
 * These callbacks may veto the run but never authorize source access. */
export interface BindingObservation {
  readonly identity: (taskId: string, identity: VerifiedSessionIdentity) => void;
  readonly record: (taskId: string, record: BindingUsageRecord, excluded: boolean) => void;
  readonly transition: (taskId: string) => void;
  readonly error: (error: unknown) => void;
}
export interface SessionBindingServiceOptions {
  store: Store; providers: SessionBindingProvider[]; setupFor(taskId: string): ExternalTaskSetup; clock?: Clock;
  providersForTask?(taskId: string, deletedProjectRoot?: string): SessionBindingProvider[];
  qualificationLease?: BindingQualificationLease;
  humanPilot?: HumanPilotScope;
  bindingObservation?: BindingObservation;
  /** Internal selected-pilot diagnostic sink; never profile/browser input. */
  onFamilyRejection?: (diagnostic: FamilyDiagnostic) => void;
  /** Opt-in internal instrumentation; callback failures never change collection decisions. */
  onChildReadiness?: (observation: Readonly<ChildReadinessObservation>) => void;
  syntheticProviderForTask?(provider: SessionBindingProvider, taskId: string): boolean;
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identityFor = (row: BindingRow) => VerifiedSessionIdentitySchema.parse(JSON.parse(row.identity) as unknown);
const gapCodes = new Set(['qualification_required', 'unsupported_history', 'missing_usage', 'missing_runtime', 'incomplete_request',
  'binding_depth_limit', 'binding_family_limit', 'binding_usage_incomplete', 'source_changed', 'source_unavailable', 'incomplete', 'partial_tail',
  'binding_ancestry_unverified', 'binding_partial_usage', 'binding_future_usage', 'binding_unobserved_context', 'candidate_unsupported_history', 'unobserved_interval', 'late_linked_member']);
const cleanGaps = (values: string[]) => [...new Set(values.map(code => gapCodes.has(code) ? code : 'binding_usage_incomplete'))];

/** Production admission is code-owned. Existing launch/ticket profiles do not
 * qualify ordinary hook-bound sessions; provider/browser assertions cannot lift it. */
export function bindingSourceSupported(store: Store, taskId: string): boolean {
  const task = new Lifecycle(store).task(taskId);
  const metadata = parseTaskMetadata(JSON.parse(task.metadata) as unknown);
  const assignment = store.get<{ protocol_id: string }>('SELECT protocol_id FROM comparison_assignments WHERE task_id=?', [taskId]);
  if (!assignment) return false;
  const protocol = comparisonProtocol(store, protocolRow(store, assignment.protocol_id));
  const initialModel = 'initial_model' in metadata ? metadata.initial_model : metadata.model;
  return metadata.product === 'synthetic' && protocol.purpose === 'synthetic_validation' ||
    metadata.product === 'codex' && protocol.schema_version === 2 && isAdmittedCodexBindingProtocol(protocol) &&
    (initialModel === null || isCodexGptModel(initialModel));
}

export function createSessionBindingService(options: SessionBindingServiceOptions) {
  if(options.qualificationLease&&options.humanPilot)throw new Error('binding_pilot_scope_invalid');
  const { store } = options; const clock = options.clock ?? utcNow; const life = new Lifecycle(store, clock);
  const rows = (taskId: string) => store.all<BindingRow>('SELECT * FROM session_bindings WHERE task_id=? ORDER BY rowid', [taskId]);
  const compatibilityFor = (taskId: string) => options.humanPilot ? humanPilotCompatibility(options.humanPilot,store,taskId)
    : options.qualificationLease ? bindingQualificationCompatibility(options.qualificationLease)
      : ordinaryAdmitted(taskId)
        ? resolveSourceCompatibility('codex',codexBindingAdmission.productVersion,'codex_binding',codexBindingAdmission.profileId) : null;
  const queues = new Map<string, Promise<void>>();
  const readiness = new Map<string, { waited: boolean; deadline: number; monotonicDeadline: bigint | null;
    observation: { attemptId: string; enteredAt: bigint; root: BindingRow; starts: Map<string, Readonly<PendingChildStart>> } | null }>();
  const serialized = async <T>(taskId: string, product: BindingProduct, work: () => Promise<T>): Promise<T> => {
    if (product !== 'claude_code') return work();
    const generation = life.task(taskId).generation;
    const previous = queues.get(taskId) ?? Promise.resolve();
    const result = previous.then(async () => {
      if (life.task(taskId).generation !== generation) throw new Error('binding_scope_revoked');
      readiness.set(taskId, { waited: false, deadline: Infinity, monotonicDeadline: null, observation: null });
      try { return await work(); } finally { readiness.delete(taskId); }
    });
    const tail = result.then(() => {}, () => {}); queues.set(taskId, tail);
    try { return await result; } finally { if (queues.get(taskId) === tail) queues.delete(taskId); }
  };

  const providerFor = (product: BindingProduct, taskId: string) => {
    const provider = (options.providersForTask?.(taskId) ?? options.providers).find(p => p.product === product);
    if (!provider) throw new Error('binding_provider_unavailable'); return provider;
  };
  // Ordinary admission is independent of test ownership. Only explicitly
  // injected providers may use the synthetic protocol's validation authority.
  const sourceSupported = (taskId: string, product: BindingProduct) => {
    const provider = providerFor(product, taskId);
    const task = life.task(taskId);
    const metadata = parseTaskMetadata(JSON.parse(task.metadata) as unknown);
    return bindingSourceSupported(store, taskId) &&
      (metadata.product === 'synthetic'
        ? options.providers.includes(provider) || options.syntheticProviderForTask?.(provider, taskId) === true
        : metadata.product === product && provider instanceof CodexSessionBindingProvider && provider.admissionProfile() === codexBindingAdmission.profileId);
  };
  const ordinaryAdmitted = (taskId: string) =>
    parseTaskMetadata(JSON.parse(life.task(taskId).metadata) as unknown).product === 'codex' &&
    providerFor('codex',taskId) instanceof CodexSessionBindingProvider &&
    sourceSupported(taskId,'codex');
  let forgetting: Promise<void> | undefined;
  const flushForgotten = (): Promise<void> => {
    if (forgetting) return forgetting;
    forgetting = (async () => {
      for (const row of store.all<{product: BindingProduct;native_session_id: string;task_id: string;project_root: string}>('SELECT * FROM session_binding_forgets')) {
        try {
          const provider = (options.providersForTask?.(row.task_id, row.project_root) ?? options.providers).find(p => p.product === row.product);
          if (!provider?.forgetSession) throw new Error('binding_provider_unavailable');
          await provider.forgetSession(row.native_session_id);
          store.execute('DELETE FROM session_binding_forgets WHERE product=? AND native_session_id=?', [row.product, row.native_session_id]);
        } catch {
          // Keep retryable metadata cleanup durable. Deletion/tombstone fences
          // revoke collection immediately, independently of provider availability.
          store.execute("UPDATE session_binding_forgets SET reason_code='binding_forget_pending' WHERE product=? AND native_session_id=?", [row.product, row.native_session_id]);
        }
      }
    })().finally(() => { forgetting = undefined; });
    return forgetting;
  };
  const authorize = (taskId: string, active = false, generation?: number) => {
    const task = life.task(taskId);
    if (store.get("SELECT 1 FROM tombstones WHERE (kind='task' AND id=?) OR (kind='project' AND id=?)", [taskId, task.project_id])) throw new Error('deleted_identifier');
    if (task.state === 'finalized' || active && task.state !== 'active' || generation !== undefined && task.generation !== generation) throw new Error('binding_scope_revoked');
    const setup = options.setupFor(taskId);
    if(applicationRequired(store,taskId)&&setup.workflow.assignment.metadata.product!=='synthetic'&&
      (!options.humanPilot||!humanPilotCompatibility(options.humanPilot,store,taskId))&&!ordinaryAdmitted(taskId))throw new Error('application_source_unqualified');
    assertExternalPrepared(store, taskId, setup.workflow, setup.preparation, clock);
    const contract = externalContract(store, taskId);
    if (!contract) throw new Error('external_contract_required');
    const control = bindingCollectionControl(store,taskId);
    if(control?.revoked_at)throw new Error('binding_scope_revoked');
    if ((!control || options.qualificationLease) && contract.ends_at && Date.parse(clock()) >= Date.parse(contract.ends_at)) throw new Error('external_window_closed');
    if (options.qualificationLease) assertBindingQualification(options.qualificationLease, store, taskId);
    else if(options.humanPilot)assertHumanPilotScope(options.humanPilot,store,taskId,providerFor(parseTaskMetadata(JSON.parse(life.task(taskId).metadata) as unknown).product as BindingProduct,taskId));
    else if (!bindingSourceSupported(store,taskId) ||
      setup.workflow.assignment.metadata.product!=='synthetic'&&!ordinaryAdmitted(taskId)) throw new Error('binding_source_unqualified');
    const compatibility=compatibilityFor(taskId);
    if(compatibility)assertCompatibilityAllowed(store,compatibility);
    return task;
  };
  const authorizeConnection = (taskId:string,generation?:number) => {
    const task=authorize(taskId,false,generation);
    // A failed pause can leave lifecycle state active while its durable
    // collection fence is stopped. Recover the pause before reconnecting.
    if(task.state==='active'&&store.get("SELECT 1 FROM external_preparations WHERE task_id=? AND state='stopped'",[taskId]))throw new Error('binding_scope_revoked');
    return task;
  };
  const checkIdentity = (taskId: string, input: VerifiedSessionIdentity) => {
    const value = VerifiedSessionIdentitySchema.parse(input); const task = life.task(taskId);
    const root = {local_root:effectiveTaskWorkspace(store,taskId)};
    assertApplicationWorkingIdentity(store,taskId,value);
    const metadata = parseTaskMetadata(JSON.parse(task.metadata) as unknown);
    if (value.cwd !== root?.local_root || metadata.product !== 'synthetic' && value.productVersion !== options.setupFor(taskId).workflow.product_version) throw new Error('binding_identity_mismatch');
    if (store.get("SELECT 1 FROM tombstones WHERE kind='session' AND id=?", [value.sessionId])) throw new Error('deleted_identifier');
    const old = store.get<{ task_id: string; parent_id: string | null }>('SELECT task_id,parent_id FROM sessions WHERE id=?', [value.sessionId]);
    if(!options.qualificationLease&&!options.humanPilot&&ordinaryAdmitted(taskId)) {
      const family = rows(taskId).map(identityFor);
      const root = family.find(member => member.parentSessionId === null);
      if(value.productVersion!==codexBindingAdmission.productVersion ||
        value.parentSessionId===null&&(root&&root.sessionId!==value.sessionId||!old&&Date.parse(value.createdAt)<Date.parse(task.registered_at)) ||
        value.parentSessionId!==null&&(!root||value.parentSessionId!==root.sessionId||Date.parse(value.createdAt)<Date.parse(root.createdAt)) ||
        !old&&family.length>=codexBindingAdmission.maxFamilyMembers)throw new Error('binding_admission_family_scope');
      if(value.parentSessionId===null&&!old) {
        let bornAt: number;
        try { const stat=lstatSync(value.sourceRef);if(!stat.isFile()||stat.isSymbolicLink())throw new Error();bornAt=stat.birthtimeMs; }
        catch { throw new Error('binding_admission_family_scope'); }
        if(!Number.isFinite(bornAt)||bornAt<Date.parse(task.registered_at))throw new Error('binding_admission_family_scope');
      }
      if(value.parentSessionId!==null&&!old&&root) {
        let childBirth: number; let rootBirth: number;
        try { childBirth=lstatSync(value.sourceRef).birthtimeMs;rootBirth=lstatSync(root.sourceRef).birthtimeMs; }
        catch { throw new Error('binding_admission_family_scope'); }
        if(!Number.isFinite(childBirth)||!Number.isFinite(rootBirth)||childBirth<rootBirth)throw new Error('binding_admission_family_scope');
      }
    }
    if (old && (old.task_id !== taskId || old.parent_id !== value.parentSessionId)) throw new Error('binding_session_conflict');
    const bound = store.get<BindingRow>('SELECT * FROM session_bindings WHERE session_id=?', [value.sessionId]);
    if (bound && bindingIdentityKey(identityFor(bound)) !== bindingIdentityKey(value)) throw new Error('binding_identity_mismatch');
    if (old && !bound) throw new Error('binding_session_conflict');
    checkBindingQualificationIdentity(options.qualificationLease, store, taskId, value, false);
    if(options.humanPilot)checkHumanPilotIdentity(options.humanPilot,store,taskId,value);
    return value;
  };
  const bind = (taskId: string, value: VerifiedSessionIdentity, rootId: string, relation: string | null, generation: number) => {
    const old = store.get<BindingRow>('SELECT * FROM session_bindings WHERE session_id=?', [value.sessionId]);
    if (old) {
      if (old.root_id !== rootId || old.relation_evidence_id !== relation) throw new Error('binding_relation_invalid'); return;
    }
    const task = life.task(taskId); const confirmation = store.get<{ id: string }>('SELECT id FROM comparison_confirmations WHERE task_id=? ORDER BY rowid DESC LIMIT 1', [taskId]);
    if (!confirmation) throw new Error('configuration_confirmation_required');
    store.execute('INSERT INTO sessions(id,project_id,task_id,parent_id,source_path,product,product_version) VALUES (?,?,?,?,?,?,?)',
      [value.sessionId, task.project_id, taskId, value.parentSessionId, null, parseTaskMetadata(JSON.parse(task.metadata) as unknown).product === 'synthetic' ? 'synthetic' : value.product, value.productVersion]);
    const compatibility=compatibilityFor(taskId);
    if(compatibility)pinSessionCompatibility(store,value.sessionId,compatibility);
    bindConfigurationToSession(store, confirmation.id, value.sessionId);
    bindApplicationEpoch(store,taskId,value.sessionId);
    store.execute("INSERT INTO session_bindings(session_id,task_id,root_id,identity,relation_evidence_id,observed_since,generation,state) VALUES (?,?,?,?,?,?,?,'observing')",
      [value.sessionId, taskId, rootId, JSON.stringify(value), relation, clock(), generation]);
  };
  const scopeFor = (taskId: string, rootId: string): CandidateScope => ({
    taskId, projectId: life.task(taskId).project_id, allowedRootTurnIds: ['binding-observation'],
    sessions: rows(taskId).filter(r => r.root_id === rootId).map(row => {
      const value = identityFor(row);
      return { sessionId: value.sessionId, rootSessionId: rootId, parentSessionId: value.parentSessionId,
        sourceId: value.sessionId, product: value.product, nativeSessionId: value.nativeMapping?.nativeSessionId ?? value.sessionId,
        processId: value.nativeMapping?.processId ?? null, agentId: value.nativeMapping?.agentId ?? null };
    }),
  });
  const authorizeObservation = (taskId: string, row: BindingRow) => {
    const task=authorize(taskId,true,row.generation);
    const current=store.get<BindingRow>('SELECT * FROM session_bindings WHERE session_id=?',[row.session_id]);
    if(!current||current.state!=='observing'||current.generation!==row.generation||current.identity!==row.identity||current.cursor!==row.cursor)throw new Error('binding_scope_revoked');
    return task;
  };
  const familyAttempt = (taskId: string, row: BindingRow) => {
    const task = authorizeObservation(taskId, row);
    return { taskId, projectId: task.project_id, projectRoot: identityFor(row).cwd, rootId: row.root_id, sessionId: row.session_id, generation: row.generation, identity: row.identity };
  };
  const noteFamilyError = (taskId: string,row: BindingRow,error: unknown,at: FamilyPhase,discovery?: Awaited<ReturnType<SessionBindingProvider['discoverChildren']>>,extra: string[] = []) => {
    if(!options.humanPilot || !options.onFamilyRejection)return error;
    try { return familyRejection(error,at,familyAttempt(taskId,row),discovery,extra); } catch { return error; }
  };
  const signalReadiness = (taskId: string, phase: ChildReadinessObservation['phase'], boundary: string | null = null) => {
    const context = readiness.get(taskId); const observation = context?.observation;
    if (!context || !observation || !options.onChildReadiness || !options.humanPilot || !isClaudeHumanPilotScope(options.humanPilot)) return;
    let deliveredRow: BindingRow | undefined;
    try {
      const now = process.hrtime.bigint();
      // Diagnostic preparation must not alter the normal collection outcome.
      if (Date.parse(clock()) >= context.deadline || context.monotonicDeadline === null || now >= context.monotonicDeadline) return;
      const row = store.get<BindingRow>('SELECT * FROM session_bindings WHERE session_id=? AND task_id=?', [observation.root.session_id, taskId]);
      if (!row || row.identity !== observation.root.identity || row.generation !== observation.root.generation || row.root_id !== observation.root.root_id) return;
      authorizeObservation(taskId, row);
      const event = Object.freeze({ phase, attemptId: observation.attemptId, taskId, rootSessionId: row.root_id, generation: row.generation,
        starts: Object.freeze([...observation.starts.values()].map(start => Object.freeze({ ...start }))),
        elapsedMs: Number(now - observation.enteredAt) / 1000000, deadline: new Date(context.deadline).toISOString(), boundary });
      deliveredRow = row;
      options.onChildReadiness(event);
    } catch { /* No acknowledgment on preparation/delivery failure; normal fences remain. */ }
    // A callback may deliberately pause; this is a normal fence, not diagnostics.
    if (deliveredRow) authorizeObservation(taskId, deliveredRow);
  };
  const invalidateSourceContract = (taskId: string, error: unknown) => {
    const compatibility=compatibilityFor(taskId);
    const contractErrors=compatibility?.source==='codex_binding'
      ? ['candidate_invalid_metadata','candidate_scope_mismatch','candidate_conflict']
      : ['candidate_invalid_metadata','candidate_scope_mismatch','candidate_conflict','binding_metadata_unavailable','binding_source_changed','binding_scope_mismatch'];
    if(compatibility&&error instanceof Error&&contractErrors.includes(error.message))invalidateCompatibility(store,compatibility,'contract_failed');
  };
  const discoverFamily = async (taskId: string, row: BindingRow, value: VerifiedSessionIdentity, at: FamilyPhase) => {
    try {
      const context = readiness.get(taskId);
      for (;;) {
        authorizeObservation(taskId, row);
        const result = await providerFor(value.product, taskId).discoverChildren(value);
        for(const reason of result.gaps)invalidateSourceContract(taskId,new Error(reason));
        authorizeObservation(taskId, row);
        const deadline = childReadinessDeadline(result);
        if (value.product !== 'claude_code' || !context) return result;
        if (deadline === undefined) {
          // Terminal evidence keeps its original reason. A clean late result
          // cannot release the previously latched, non-renewable family hold.
          if (!result.gaps.length && context.waited && (Date.parse(clock()) >= context.deadline || context.monotonicDeadline !== null && process.hrtime.bigint() >= context.monotonicDeadline)) rejectFamily(taskId, row, at, result, ['child_readiness_timeout']);
          return result;
        }
        context.waited = true;
        context.deadline = Math.min(context.deadline, deadline);
        const remaining = context.deadline - Date.parse(clock());
        const cap = process.hrtime.bigint() + BigInt(Math.max(0, Math.min(2000, Math.floor(remaining)))) * 1000000n;
        if (context.monotonicDeadline === null || cap < context.monotonicDeadline) context.monotonicDeadline = cap;
        if (remaining <= 0 || process.hrtime.bigint() >= context.monotonicDeadline) rejectFamily(taskId, row, at, result, ['child_readiness_timeout']);
        if (options.onChildReadiness && options.humanPilot && isClaudeHumanPilotScope(options.humanPilot) && value.parentSessionId === null) {
          const starts = childReadinessStarts(result);
          if (starts.length) {
            const first = context.observation === null;
            context.observation ??= { attemptId: randomUUID(), enteredAt: process.hrtime.bigint(), root: { ...row }, starts: new Map() };
            for (const start of starts) context.observation.starts.set(start.receiptId, start);
            if (first) signalReadiness(taskId, 'hold_entered');
          }
        }
        await delay(Math.min(20, remaining));
      }
    } catch (error) { invalidateSourceContract(taskId,error);throw noteFamilyError(taskId,row,error,at); }
  };
  const rejectFamily = (taskId: string, row: BindingRow, at: FamilyPhase, discovery?: Awaited<ReturnType<SessionBindingProvider['discoverChildren']>>, extra: string[] = []): never => {
    throw noteFamilyError(taskId,row,new Error('binding_pilot_family_scope'),at,discovery,extra);
  };
  const read = async (taskId: string, row: BindingRow, baseline: boolean) => {
    authorizeObservation(taskId,row); const value = identityFor(row); assertApplicationWorkingIdentity(store,taskId,value); const provider = providerFor(value.product, taskId);
    if(options.humanPilot)checkHumanPilotIdentity(options.humanPilot,store,taskId,value);
    if((options.humanPilot || value.product === 'claude_code' || ordinaryAdmitted(taskId)) && baseline) {
      // Baselines also need a metadata-only family preflight. Initial connect
      // and resume must not read a root body before noticing rejected members.
      const discovered=await discoverFamily(taskId,row,value,'baseline_discovery');
      if(discovered.gaps.length)rejectFamily(taskId,row,'baseline_discovery',discovered);
      for(const child of discovered.children) {
        let identity: VerifiedSessionIdentity;
        try { identity=checkIdentity(taskId,child.identity); } catch(error) { throw noteFamilyError(taskId,row,error,'baseline_relation'); }
        if(child.parentSessionId!==value.sessionId||identity.parentSessionId!==value.sessionId||!child.relationEvidenceId)rejectFamily(taskId,row,'baseline_relation',undefined,['relation_mismatch']);
        const descendants=await discoverFamily(taskId,row,identity,'baseline_descendants');
        if(descendants.children.length||descendants.gaps.length)rejectFamily(taskId,row,'baseline_descendants',descendants,descendants.children.length ? ['descendants_present'] : []);
      }
    }
    let batch: Awaited<ReturnType<SessionBindingProvider['readUsage']>>;
    try { batch = await provider.readUsage(value, baseline ? null : row.cursor, scopeFor(taskId, row.root_id), { baseline }); }
    catch(error) {
      invalidateSourceContract(taskId,error);
      throw error;
    }
    authorizeObservation(taskId,row);
    if (typeof batch.cursor !== 'string' || batch.cursor.length > 6 * 1024 * 1024 || batch.records.length > 65536 || (batch.excludedRecords?.length ?? 0) > 65536) throw new Error('binding_usage_invalid');
    const records = batch.records.map(record => BindingUsageRecordSchema.parse(record));
    const excluded = (batch.excludedRecords ?? []).map(record => BindingUsageRecordSchema.parse(record));
    for (const record of [...records,...excluded]) if (record.sessionId !== value.sessionId || record.payload.product !== value.product || record.payload.product_version !== value.productVersion || Date.parse(record.occurredAt) > Date.parse(clock())) throw new Error('binding_usage_invalid');
    for (const record of excluded) options.bindingObservation?.record(taskId,record,true);
    for (const record of records) options.bindingObservation?.record(taskId,record,baseline);
    store.immediateTransaction(() => {
      const task = authorizeObservation(taskId,row);
      for (const record of excluded) checkBindingQualificationRecord(options.qualificationLease, store, taskId, record, true);
      if (baseline) for (const record of records) checkBindingQualificationRecord(options.qualificationLease, store, taskId, record, true);
      if (!baseline) for (const record of records) {
        if (record.sessionId !== value.sessionId || record.payload.product !== value.product || record.payload.product_version !== value.productVersion || Date.parse(record.occurredAt) > Date.parse(clock())) throw new Error('binding_usage_invalid');
        if (Date.parse(record.occurredAt) < Date.parse(row.observed_since)) continue;
        const key = hash(['binding-request-v1', value.product, record.requestId]);
        const fingerprint = hash(record);
        const old = store.get<{ fingerprint: string }>('SELECT fingerprint FROM binding_requests WHERE request_key=?', [key]);
        if (old) { if (old.fingerprint !== fingerprint) throw new Error('binding_request_conflict'); continue; }
        // Check requests seen in other collector lanes and versions as well.
        if (store.get("SELECT 1 FROM runtime_evidence r LEFT JOIN session_bindings b ON b.session_id=r.session_id WHERE json_extract(r.payload,'$.request_id')=? AND (json_extract(r.payload,'$.product')=? OR (json_extract(r.payload,'$.product')='synthetic' AND (b.identity IS NULL OR json_extract(b.identity,'$.product')=?)))", [record.requestId, value.product, value.product])) throw new Error('binding_request_conflict');
        checkBindingQualificationRecord(options.qualificationLease, store, taskId, record);
        const measuredProduct = parseTaskMetadata(JSON.parse(task.metadata) as unknown).product === 'synthetic' ? 'synthetic' as const : value.product;
        const runtimeId = hash(['binding-runtime', key]);
        const runtime = { id: runtimeId, task_id: taskId, session_id: value.sessionId, turn_id: record.turnId, request_id: record.requestId,
          model: record.payload.model, effort: record.effort, product: measuredProduct, product_version: value.productVersion,
          source: 'product_log' as const, occurred_at: record.occurredAt, recorded_at: clock(), boundary: 'request' as const };
        putUsageWithEvidence(store, { id: key, source_key: key, task_id: taskId, project_id: task.project_id, session_id: value.sessionId,
          occurred_at: record.occurredAt, payload: { ...record.payload, product: measuredProduct, runtime_evidence_id: runtimeId } }, runtime);
        store.execute('INSERT INTO binding_requests(request_key,event_id,fingerprint) VALUES (?,?,?)', [key, key, fingerprint]);
      }
      const gaps = cleanGaps([...z.array(z.string()).parse(JSON.parse(row.gaps) as unknown), ...batch.gaps]);
      if (gaps.length) recordObservationGap(store, taskId, value.sessionId, row.observed_since, clock(), 'incomplete', clock());
      store.execute('UPDATE session_bindings SET cursor=?,gaps=? WHERE session_id=?', [batch.cursor, JSON.stringify(gaps), value.sessionId]);
    });
  };
  const status = (taskId: string) => {
    const task = life.task(taskId); const all = rows(taskId);
    const gaps = cleanGaps(all.flatMap(row => z.array(z.string()).parse(JSON.parse(row.gaps) as unknown)));
    const assignment=store.get<{protocol_id:string}>('SELECT protocol_id FROM comparison_assignments WHERE task_id=?',[taskId]);
    const protocol=assignment?parseProtocol(JSON.parse(protocolRow(store,assignment.protocol_id).settings) as unknown):null;
    const tableId=protocol?.schema_version===2?protocol.price_table_id:null;
    const capture=tableId?captureObservedCostInput(store,taskId,tableId,clock(),'output-only-v1'):null;
    const keys=new Set(store.all<{event_id:string}>('SELECT r.event_id FROM binding_requests r JOIN events e ON e.id=r.event_id WHERE e.task_id=?',[taskId]).map(r=>r.event_id));
    const eligible=(capture?.events??[]).filter(e=>keys.has(e.id));
    const total=(events:UsageEvent[],field:'input_total'|'output_total')=>{
      const readings=events.map(e=>e.payload[field]);const observed=readings.filter(r=>r.status==='observed');
      const statuses=[...new Set(readings.map(r=>r.status))].sort();
      return {status:readings.length&&observed.length===readings.length?'observed':observed.length?'partial':'missing',
        value:observed.length?addTokens(observed.map(r=>r.value)):null,statuses,
        reasons:[...new Set(readings.flatMap(r=>r.reason?[r.reason]:[]))].sort()};
    };
    const summarize=(events:UsageEvent[])=>{
      const priced=capture?(tableId&&store.get('SELECT price_table_id FROM price_catalog_bases WHERE price_table_id=?',[tableId])?
        projectCatalogCost(events,readPriceBasis(store,tableId),taskId,clock(),'output-only-v1',{referenceBinding:true,runtimeEvidence:capture.runtimeEvidence}):
        projectObservedCost(events,capture.report.price_table,taskId,clock(),'output-only-v1',capture.runtimeEvidence)):null;
      return {requests:events.length||null,input_total:total(events,'input_total'),output_total:total(events,'output_total'),
        partial_amount:priced?.partial_amount??null,
        compatibility_unverified_partial_amount:priced?.compatibility_unverified_partial_amount??null,
        legacy_unverified_partial_amount:priced?.legacy_unverified_partial_amount??null,
        compatibility:priced?.compatibility??null,unpriced_events:priced?.unpriced_events??0,
        currency:priced?.currency??null,price_table_id:tableId,cost_coverage:'partial' as const,complete_cost:null};
    };
    return { state: all.some(row => row.state === 'observing' && row.generation === task.generation) && task.state === 'active' ? 'observing' : all.length ? 'stopped' : 'unconnected',
      roots: all.filter(row => identityFor(row).parentSessionId === null).length, children: all.filter(row => identityFor(row).parentSessionId !== null).length,
      sessions: all.map(row => {
        const identity = identityFor(row); const metadata = identity.agentMetadata;
        const events = eligible.filter(e => e.session_id === row.session_id);
        return { session_id: row.session_id, parent_session_id: identity.parentSessionId, identity_basis: 'native_metadata_receipt',
          agent_metadata: metadata?.source === 'claude_hook' ? { source: metadata.source, agent_type: metadata.agentType } : metadata ?? null,
          models: [...new Set(events.flatMap(e => e.payload.model === null ? [] : [e.payload.model]))].sort(), ...summarize(events) };
      }),
      summary:summarize(eligible),
      requests: store.get<{ count: number }>('SELECT count(*) AS count FROM binding_requests r JOIN events e ON e.id=r.event_id WHERE e.task_id=?', [taskId])?.count ?? 0,
      gaps, cost_coverage: 'partial' as const, complete_cost: null, inference: false };
  };
  const resumeAvailable = (taskId: string) => {
    const roots = rows(taskId).filter(r => identityFor(r).parentSessionId === null);
    return roots.length === 1 && CurrentIdentityRequestSchema.safeParse({receipt:roots[0]!.connect_receipt}).success;
  };
  const pause = (taskId: string) => {
    const all = rows(taskId);
    // Collection fences do not depend on a successful timestamp/gap write.
    // A clock error remains an error; never invent an interval endpoint.
    store.immediateTransaction(()=>{
      store.execute("UPDATE session_bindings SET state='stopped',cursor=NULL WHERE task_id=?",[taskId]);
      store.execute("UPDATE external_preparations SET state='stopped' WHERE task_id=?", [taskId]);
    });
    for(const row of all)store.execute('UPDATE session_bindings SET gaps=? WHERE session_id=?',[JSON.stringify(cleanGaps([...z.array(z.string()).parse(JSON.parse(row.gaps) as unknown),'unobserved_interval'])),row.session_id]);
    if (life.state(taskId) === 'active') {
      for (const row of all.filter(row => row.state === 'observing')) recordObservationGap(store, taskId, row.session_id, row.observed_since, clock(), 'incomplete', clock());
      life.pause(taskId);
      noteBindingQualificationTransition(options.qualificationLease, store, taskId);
      options.bindingObservation?.transition(taskId);
    }
  };
  const discoverBindings = async (taskId: string) => {
    const task = authorize(taskId, true);
    const pending = rows(taskId).filter(row => row.state === 'observing' && row.generation === task.generation);
    for (let index = 0; index < pending.length; index++) {
      const row = pending[index]!; const value = identityFor(row); const provider = providerFor(value.product, taskId);
      authorizeObservation(taskId,row);
      const discovered = await discoverFamily(taskId,row,value,'tick_discovery');
      // Candidate providers may report a rejected ancestry/family as a gap
      // instead of returning its identity. Claude families and pilots fail closed
      // even when mixed terminal evidence prevents readiness from latching.
      if((options.humanPilot || value.product === 'claude_code' || ordinaryAdmitted(taskId)) && discovered.gaps.length)rejectFamily(taskId,row,'tick_discovery',discovered);
      let depth = 0; let ancestor = row;
      while (identityFor(ancestor).parentSessionId !== null) { depth++; ancestor = pending.find(p => p.session_id === identityFor(ancestor).parentSessionId)!; if (!ancestor || depth > 32) throw new Error('binding_relation_invalid'); }
      for (const child of discovered.children) {
        let identity: VerifiedSessionIdentity;
        try { identity=checkIdentity(taskId,child.identity); } catch(error) { throw noteFamilyError(taskId,row,error,'tick_relation'); }
        if (child.parentSessionId !== value.sessionId || identity.parentSessionId !== value.sessionId || identity.sessionId === value.sessionId || !child.relationEvidenceId) throw noteFamilyError(taskId,row,new Error('binding_relation_invalid'),'tick_relation',undefined,['relation_mismatch']);
        if (depth >= provider.capabilities().maxDepth || rows(taskId).filter(r => r.root_id === row.root_id).length >= 32) {
          discovered.gaps.push(depth >= provider.capabilities().maxDepth ? 'binding_depth_limit' : 'binding_family_limit'); continue;
        }
        const existing = pending.find(p => p.session_id === identity.sessionId);
        if (existing) { if (existing.root_id !== row.root_id) throw new Error('binding_relation_invalid'); continue; }
        store.immediateTransaction(() => { authorize(taskId, true, task.generation); bind(taskId, identity, row.root_id, child.relationEvidenceId, task.generation); });
        checkBindingQualificationIdentity(options.qualificationLease,store,taskId,identity);
        options.bindingObservation?.identity(taskId,identity);
        const linked = store.get<BindingRow>('SELECT * FROM session_bindings WHERE session_id=?', [identity.sessionId])!;
        linked.observed_since = row.observed_since;
        store.execute('UPDATE session_bindings SET observed_since=? WHERE session_id=?', [linked.observed_since, identity.sessionId]);
        if (!readiness.get(taskId)?.waited && Date.parse(identity.createdAt) < Date.parse(row.observed_since)) {
          linked.gaps = JSON.stringify(['late_linked_member']);
          store.execute('UPDATE session_bindings SET gaps=? WHERE session_id=?', [linked.gaps, identity.sessionId]);
          recordObservationGap(store, taskId, identity.sessionId, row.observed_since, clock(), 'incomplete', clock());
          await read(taskId, linked, true);
        }
        // Baseline reads commit a new cursor. Discovery must use that current
        // snapshot rather than treating our own cursor update as revocation.
        pending.push(store.get<BindingRow>('SELECT * FROM session_bindings WHERE session_id=?',[identity.sessionId])!);
      }
      if (discovered.gaps.length) store.execute('UPDATE session_bindings SET gaps=? WHERE session_id=?', [JSON.stringify(cleanGaps([...z.array(z.string()).parse(JSON.parse(row.gaps) as unknown), ...discovered.gaps])), row.session_id]);
    }
  };
  const rebaselineFamily = async (taskId: string) => {
    await discoverBindings(taskId);
    const family = rows(taskId).filter(row => row.state === 'observing');
    for (const row of family) await read(taskId, row, true);
    for (const row of rows(taskId).filter(member => member.state === 'observing')) {
      const found = await discoverFamily(taskId, row, identityFor(row), 'baseline_discovery');
      if (found.gaps.length) rejectFamily(taskId, row, 'baseline_discovery', found);
      for (const child of found.children) {
        const identity = checkIdentity(taskId, child.identity);
        const bound = family.find(member => member.session_id === identity.sessionId);
        if (!bound || child.parentSessionId !== row.session_id || identity.parentSessionId !== row.session_id || bound.relation_evidence_id !== child.relationEvidenceId) rejectFamily(taskId, row, 'baseline_relation', undefined, ['relation_mismatch']);
      }
    }
    const boundary = clock();
    store.immediateTransaction(() => {
      for (const old of family) {
        const row = store.get<BindingRow>('SELECT * FROM session_bindings WHERE session_id=?', [old.session_id])!;
        authorizeObservation(taskId, row);
        // Conservatively cover the excluded snapshot, including requests whose
        // rows straddle the hold. Previously measured rows remain retained.
        const from = new Date(Math.max(Date.parse(old.observed_since), Date.parse(identityFor(old).createdAt))).toISOString();
        recordObservationGap(store, taskId, row.session_id, from, boundary, 'incomplete', boundary);
        store.execute('UPDATE session_bindings SET observed_since=?,gaps=? WHERE session_id=?', [boundary, JSON.stringify(cleanGaps([...z.array(z.string()).parse(JSON.parse(row.gaps) as unknown), 'unobserved_interval'])), row.session_id]);
      }
    });
    signalReadiness(taskId, 'rebaseline_complete', boundary);
  };
  const connect = async (taskId: string, product: BindingProduct, request: CurrentIdentityRequest, expectedRoot?: VerifiedSessionIdentity): Promise<ReturnType<typeof status> & {status:string;session_id:string;automatic_children:boolean;role?:'child'}> => {
      await flushForgotten();
      if (options.qualificationLease && !bindingQualificationOwnerLive(options.qualificationLease)) throw new Error('binding_qualification_live_root_required');
      const before = authorizeConnection(taskId); const provider = providerFor(product, taskId); const input = CurrentIdentityRequestSchema.parse(request);
      if (options.qualificationLease || (options.humanPilot || ordinaryAdmitted(taskId)) && provider instanceof CodexSessionBindingProvider) {
        if (!(provider instanceof CodexSessionBindingProvider)) throw new Error('binding_qualification_scope_invalid');
        const root=rows(taskId).find(r=>identityFor(r).parentSessionId===null);
        provider.assertRootReceipt(input,root?.session_id??null);
      }
      // An injected dependency is used only inside an explicitly synthetic
      // protocol. Native manifest providers remain gated even in that workspace.
      if (!options.qualificationLease && !options.humanPilot && !sourceSupported(taskId, product)) throw new Error('binding_source_unqualified');
      const pinned = rows(taskId).find(row => row.connect_receipt === input.receipt && identityFor(row).parentSessionId === null && identityFor(row).product === product);
      const boundRoot = expectedRoot ?? (pinned ? identityFor(pinned) : undefined);
      const resolved = boundRoot && pinned && 'revalidateBound' in provider && provider.revalidateBound ? await provider.revalidateBound(input, boundRoot) : await provider.resolveCurrent(input);
      authorizeConnection(taskId, before.generation);
      const value = checkIdentity(taskId, resolved);
      if (expectedRoot && bindingIdentityKey(value) !== bindingIdentityKey(expectedRoot)) throw new Error('binding_identity_mismatch');
      if (value.product !== product) throw new Error('binding_identity_mismatch');
      if (value.parentSessionId !== null) {
        if (before.state !== 'active') throw new Error('binding_reconnect_required');
        if (!rows(taskId).some(r => identityFor(r).product === product && identityFor(r).parentSessionId === null)) throw new Error('binding_child_requires_root');
        // Receipt identity alone does not establish family membership. Discovery
        // must independently verify the relation, including before its next poll.
        await tick(taskId); authorize(taskId, true, before.generation);
        checkIdentity(taskId, value);
        const member = store.get<BindingRow>('SELECT * FROM session_bindings WHERE session_id=?', [value.sessionId]);
        if (!member || member.state !== 'observing' || member.generation !== before.generation) throw new Error('binding_child_requires_root');
        return { status: 'already_connected', role: 'child' as const, ...status(taskId), session_id: value.sessionId,
          automatic_children: provider.capabilities().ancestry === 'verified_relations' };
      }
      const old = store.get<BindingRow>('SELECT * FROM session_bindings WHERE session_id=?', [value.sessionId]);
      if (old?.state === 'observing' && old.generation === before.generation && before.state === 'active') {
        store.execute('UPDATE session_bindings SET connect_receipt=? WHERE session_id=?',[input.receipt,value.sessionId]);
        return { status: 'already_connected', ...status(taskId), session_id: value.sessionId, automatic_children: provider.capabilities().ancestry === 'verified_relations' };
      }
      const restart = before.state !== 'active';
      store.immediateTransaction(() => {
        authorizeConnection(taskId, before.generation);
        if (before.state === 'registered') life.start(taskId); else if (before.state === 'paused') life.resume(taskId);
        const task = life.task(taskId); selectTaskPriceTable(store, taskId, clock());
        bind(taskId, value, value.sessionId, null, task.generation);
        store.execute('UPDATE session_bindings SET connect_receipt=? WHERE session_id=?',[input.receipt,value.sessionId]);
        if (restart) store.execute("UPDATE session_bindings SET generation=?,observed_since=?,state='observing',cursor=NULL WHERE task_id=?", [task.generation, clock(), taskId]);
        const contract = externalContract(store, taskId)!;
        if (contract.started_at === null) {
          const connectedAt = task.started_at!;
          store.execute('UPDATE external_task_contracts SET started_at=?,ends_at=? WHERE task_id=?', [connectedAt, new Date(Date.parse(connectedAt) + contract.followup_seconds * 1000).toISOString(), taskId]);
        }
        store.execute("UPDATE external_preparations SET first_connected_at=COALESCE(first_connected_at,?),state='connected',reason_code=NULL WHERE task_id=?", [clock(), taskId]);
      });
      if (restart) noteBindingQualificationTransition(options.qualificationLease, store, taskId);
      if (restart) options.bindingObservation?.transition(taskId);
      checkBindingQualificationIdentity(options.qualificationLease,store,taskId,value);
      options.bindingObservation?.identity(taskId,value);
      try {
        for (const row of rows(taskId).filter(row => restart || row.session_id === value.sessionId)) await read(taskId, row, true);
        if (readiness.get(taskId)?.waited) await rebaselineFamily(taskId);
      } catch (error) {
        const diagnostic = options.humanPilot && options.onFamilyRejection ? takeFamilyDiagnostic(error,taskId,store) : null;
        if (store.get('SELECT id FROM tasks WHERE id=?', [taskId])) try{pause(taskId);}catch{ /* Binding fences are durable; preserve the original read failure. */ }
        if(diagnostic)try{options.onFamilyRejection?.(diagnostic);}catch{ /* A diagnostic never replaces the rejection. */ }
        throw error;
      }
      return { status: old ? 'reconnected' : 'connected', ...status(taskId), session_id: value.sessionId, automatic_children: provider.capabilities().ancestry === 'verified_relations' };
  };
  const tick = async (taskId: string) => {
      await flushForgotten();
      const task = life.task(taskId); if (task.state !== 'active') return status(taskId);
      if(!rows(taskId).some(row=>row.state==='observing'&&row.generation===task.generation))return status(taskId);
      authorize(taskId, true, task.generation);
      await discoverBindings(taskId);
      if (readiness.get(taskId)?.waited) { await rebaselineFamily(taskId); return status(taskId); }
      for (const row of rows(taskId).filter(r => r.state === 'observing' && r.generation === task.generation)) await read(taskId, row, false);
      // An awaited read may finish just before pause fences the task. Do not
      // clear that fence when this tick's continuation finally runs.
      store.execute("UPDATE external_preparations SET state='measuring' WHERE task_id=? AND state!='stopped'", [taskId]);
      return status(taskId);
  };
  const service = {
    status, pause, flushForgotten, resumeAvailable,
    sourceSupported: (taskId: string, product: BindingProduct) => {
      const supported=sourceSupported(taskId,product);
      const compatibility=supported?compatibilityFor(taskId):null;
      if(compatibility)assertCompatibilityAllowed(store,compatibility);
      return supported;
    },
    resume: (taskId: string) => serialized(taskId, rows(taskId).some(row => identityFor(row).product === 'claude_code') ? 'claude_code' : 'codex', async () => {
      if (options.qualificationLease && !bindingQualificationOwnerLive(options.qualificationLease)) throw new Error('binding_qualification_live_root_required');
      if (life.state(taskId) !== 'paused') throw new Error('binding_reconnect_required');
      authorizeConnection(taskId);
      const roots = rows(taskId).filter(r => identityFor(r).parentSessionId === null);
      if (!resumeAvailable(taskId)) throw new Error('binding_reconnect_required');
      const root=roots[0]!; const identity = identityFor(root); return await connect(taskId, identity.product, {receipt:root.connect_receipt!}, identity);
    }),
    capabilities: (taskId: string, product: BindingProduct) => providerFor(product, taskId).capabilities(),
    connect: (taskId: string, product: BindingProduct, request: CurrentIdentityRequest) => serialized(taskId, product, () => connect(taskId, product, request)),
    tick: (taskId: string) => serialized(taskId, rows(taskId).some(row => identityFor(row).product === 'claude_code') ? 'claude_code' : 'codex', () => tick(taskId)),
  };
  return service;
}
export type SessionBindingService = ReturnType<typeof createSessionBindingService>;
