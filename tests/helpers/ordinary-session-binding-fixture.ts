import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lifecycle } from '../../src/lifecycle.js';
import { Store } from '../../src/store.js';
import { createOrdinaryTask, saveOrdinaryProjectSettings } from '../../src/ordinary-observation.js';
import { createOrdinarySessionBindingService, type OrdinarySessionBindingService, type OrdinarySourceMetadata } from '../../src/ordinary-session-binding.js';
import type { BindingReadBoundary, BindingUsageRecord, NativeConnectionProof, SessionBindingProvider, VerifiedSessionIdentity } from '../../src/session-binding-contract.js';
import type { CandidateScope } from '../../src/nested-candidate.js';

export function ordinaryBindingFixture(productVersion = '2.1.296') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ordinary-binding-')));
  let timestamp = Date.parse('2026-10-13T09:00:00.000Z');
  const clock = () => new Date(timestamp).toISOString();
  const advance = (milliseconds = 100) => { timestamp += milliseconds; };
  const store = new Store(':memory:', clock);
  const life = new Lifecycle(store, clock);
  life.registerProject('project', root);
  saveOrdinaryProjectSettings(store, 'project', {
    schema_version: 1, product: 'claude_code', product_version: productVersion,
    receipt_directory: '/synthetic/receipts', claude_projects_directory: '/synthetic/projects',
  }, clock);
  const task = () => createOrdinaryTask(store, { project_id: 'project', criterion_ids: ['accepted'] }, clock);
  const taskId = task();
  const records = new Map<string, BindingUsageRecord[]>();
  const children = new Map<string, VerifiedSessionIdentity[]>();
  const metadata = new Map<string, OrdinarySourceMetadata>();
  const proofs = new Map<string, NativeConnectionProof>();
  const scopes: CandidateScope[] = [];
  const bodyReads: string[] = []; const inspections: string[] = []; const forgotten: string[] = [];
  const services: OrdinarySessionBindingService[] = [];
  let selectedService: OrdinarySessionBindingService;
  let selectedTask = taskId;
  let onRead: ((boundary: BindingReadBoundary | undefined) => Promise<void>) | undefined;
  let onResolve: (() => Promise<void>) | undefined;
  let onInspect: (() => Promise<void>) | undefined;
  const identity = (parent: VerifiedSessionIdentity | null = null): VerifiedSessionIdentity => {
    const native = parent?.nativeMapping?.nativeSessionId ?? randomUUID();
    const agent = parent ? randomUUID() : null;
    const sessionId = agent ? `${native}:${agent}` : native;
    const value: VerifiedSessionIdentity = {
      product: 'claude_code', productVersion: parent?.productVersion ?? productVersion, sessionId,
      parentSessionId: parent?.sessionId ?? null, sourceRef: `/synthetic/${sessionId}.jsonl`,
      sourceIdentity: randomUUID(), cwd: root, identityEvidenceId: randomUUID(), createdAt: clock(),
      nativeMapping: { nativeSessionId: native, agentId: agent, processId: parent ? null : `process:${randomUUID()}` },
    };
    records.set(sessionId, []);
    metadata.set(sessionId, { nativeSessionId: native, agentId: agent, sourceRef: value.sourceRef,
      sourceIdentity: value.sourceIdentity, birthtimeMs: timestamp, recordedAt: clock(),
      processId: parent?.nativeMapping?.processId ?? value.nativeMapping?.processId ?? '' });
    if (parent) children.set(parent.sessionId, [...(children.get(parent.sessionId) ?? []), value]);
    return value;
  };
  let current = identity();
  const metadataFor = (value: VerifiedSessionIdentity) => {
    const found = metadata.get(value.sessionId);
    if (!found) throw new Error('fixture_metadata_missing');
    return found;
  };
  const body = (value: VerifiedSessionIdentity) => {
    selectedService.assertSource(selectedTask, metadataFor(value));
    bodyReads.push(value.sessionId);
  };
  const provider: SessionBindingProvider = {
    product: 'claude_code',
    capabilities: () => ({ currentIdentity: 'native_hook', ancestry: 'verified_relations', usage: 'own_requests',
      productionSupported: false, maxDepth: 1, reasons: [] }),
    inspectCurrent: async request => {
      inspections.push(request.receipt);
      if (onInspect) await onInspect();
      const proof = proofs.get(request.receipt);
      if (!proof) throw new Error('fixture_proof_missing');
      return proof;
    },
    resolveCurrent: async () => { body(current); if (onResolve) await onResolve(); return current; },
    revalidateBound: expectedRequest => {
      const proof = proofs.get(expectedRequest.receipt);
      if (!proof || current.sourceIdentity !== proof.sourceIdentity || current.nativeMapping?.processId !== proof.processId)
        return Promise.reject(new Error('binding_identity_mismatch'));
      body(current); return Promise.resolve(current);
    },
    discoverChildren: parent => {
      const admitted: VerifiedSessionIdentity[] = []; const gaps: string[] = [];
      for (const child of children.get(parent.sessionId) ?? []) {
        if (!selectedService.memberEligible(selectedTask, metadataFor(child))) { gaps.push('binding_unobserved_context'); continue; }
        // The production provider asks twice, including immediately before its
        // first own-row body read.
        selectedService.memberEligible(selectedTask, metadataFor(child));
        body(child); admitted.push(child);
      }
      return Promise.resolve({ children: admitted.map(value => ({ identity: value,
        parentSessionId: parent.sessionId, relationEvidenceId: value.identityEvidenceId })), gaps: [...new Set(gaps)] });
    },
    readUsage: async (value, cursor, scope, boundary) => {
      body(value); scopes.push(scope);
      if (onRead) await onRead(boundary);
      const all = records.get(value.sessionId) ?? [];
      const candidates = all.slice(cursor === null ? 0 : Number(cursor));
      if (boundary?.baseline) for (const record of candidates) boundary.baselineLedger?.add(record.requestId);
      return { records: candidates.filter(record => boundary?.baseline || !boundary?.baselineLedger?.has(record.requestId)),
        cursor: String(all.length), gaps: [] };
    },
    forgetSession: native => { forgotten.push(native); return Promise.resolve(); },
  };
  const service = () => {
    const value = createOrdinarySessionBindingService({ store, providersForTask: () => [provider], clock,
      syntheticProviderForTask: () => true });
    services.push(value); selectedService = value; return value;
  };
  const binding = service();
  const receipt = (value = current, recordedAt = clock()) => {
    const receiptId = randomUUID();
    proofs.set(receiptId, { receipt: receiptId, recordedAt, nativeSessionId: value.nativeMapping?.nativeSessionId ?? value.sessionId,
      agentId: value.nativeMapping?.agentId ?? null, sourceRef: value.sourceRef, sourceIdentity: value.sourceIdentity,
      cwd: value.cwd, processId: value.nativeMapping?.processId ?? '', productVersion: value.productVersion });
    return { receipt: receiptId };
  };
  const usage = (value = current, requestId = randomUUID()) => {
    advance();
    const observed = (amount: number) => ({ status: 'observed' as const, value: amount, reason: null });
    const record: BindingUsageRecord = { requestId, sessionId: value.sessionId, occurredAt: clock(), turnId: null, effort: null,
      payload: { schema_version: 2, kind: 'usage', product: 'claude_code', product_version: value.productVersion,
        model: 'claude-opus-5-5', epoch: 'epoch', attribution: 'verified', input_total: observed(10),
        cached_input: observed(2), output_total: observed(3), reasoning_output: { status: 'missing', value: null, reason: 'not_available' },
        billing_components: [{ kind: 'output', reading: observed(3) }] } };
    records.set(value.sessionId, [...(records.get(value.sessionId) ?? []), record]); return record;
  };
  const cleanup = async () => {
    for (const value of services) await value.close();
    store.close(); rmSync(root, { recursive: true, force: true });
  };
  return { store, life, taskId, task, binding, provider, service, clock, advance, identity, metadata, proofs, records,
    children, bodyReads, inspections, scopes, forgotten, receipt, usage, cleanup, current: () => current,
    setCurrent: (value: VerifiedSessionIdentity) => { current = value; },
    use: (value: OrdinarySessionBindingService, id = taskId) => { selectedService = value; selectedTask = id; },
    onRead: (value: typeof onRead) => { onRead = value; }, onResolve: (value: typeof onResolve) => { onResolve = value; },
    onInspect: (value: typeof onInspect) => { onInspect = value; },
    setTime: (value: string) => { timestamp = Date.parse(value); },
    connect: () => binding.connect(taskId, 'claude_code', receipt()) };
}
