import { randomUUID } from 'node:crypto';
import { Lifecycle } from '../../src/core/lifecycle.js';
import { Store } from '../../src/store.js';
import { createOrdinaryWindowTask } from '../../src/ordinary-observation.js';
import { emptyOrdinaryWindowCoverage } from '../../src/core/ordinary-window-policy.js';
import { activateOrdinaryWindowDecision } from '../../src/core/ordinary-window-activation.js';
import { ordinaryWindowRuntimeRevision, ordinaryWindowSelection, recordOrdinaryWindowSegment } from '../../src/core/ordinary-window-store.js';
import type {
  BindingUsageRecord,
  OrdinaryWindowReadBoundary,
  OrdinaryWindowUsageBatch,
  SessionBindingProvider,
  VerifiedSessionIdentity
} from '../../src/session-binding-contract.js';

export function ordinaryWindowFixture(product: 'codex' | 'claude_code' = 'codex') {
  const clock = () => '2026-11-06T01:00:00.000Z';
  const store = new Store(':memory:', clock);
  const life = new Lifecycle(store, clock);
  store.execute('INSERT INTO projects(id,local_root) VALUES (?,?)', ['project', '/synthetic/window-project']);
  const taskId = createOrdinaryWindowTask(
    store,
    {
      schema_version: 2,
      mode: 'ordinary_window',
      project_id: 'project',
      product,
      declared_version: product === 'codex' ? '0.167.0' : '2.1.318',
      policy_id: product === 'codex' ? 'codex-binding-root-window-v1' : 'claude-binding-root-window-v1',
      criterion_ids: ['accepted']
    },
    clock
  );
  const selection = ordinaryWindowSelection(store, taskId);
  if (!selection) throw new Error('fixture_selection_missing');
  const activate = () =>
    activateOrdinaryWindowDecision(
      store,
      {
        schema_version: 1,
        kind: 'ordinary_window_activation',
        decision_kind: 'product',
        decision_ref: 'synthetic-decision',
        project_id: selection.projectId,
        product,
        source: selection.policy.source,
        policy_id: selection.policy.policyId,
        policy_revision: selection.policy.ruleRevision,
        policy_digest: selection.policyDigest,
        evidence_mode: selection.policy.evidenceMode,
        accepted_risks: ['source_identity_limits', 'root_ownership_unverified'],
        implementation_revision: ordinaryWindowRuntimeRevision,
        evidence_ref: 'synthetic-evidence',
        review_ref: 'synthetic-review'
      },
      clock()
    );
  const identity: VerifiedSessionIdentity = {
    product,
    productVersion: selection.declaredVersion,
    sessionId: 'native-root',
    sourceRef: '/synthetic/root.jsonl',
    sourceIdentity: 'synthetic-source',
    cwd: '/synthetic/window-project',
    identityEvidenceId: 'synthetic-receipt',
    parentSessionId: null,
    createdAt: clock(),
    nativeMapping: {
      nativeSessionId: 'native-root',
      agentId: null,
      processId: product === 'codex' ? null : 'synthetic-process'
    }
  };
  const rootId = 'measurement-root';
  const receipt = randomUUID();
  const proof = {
    schemaVersion: 2,
    receipt,
    recordedAt: clock(),
    nativeSessionId: identity.sessionId,
    sourceRef: identity.sourceRef,
    sourceIdentity: identity.sourceIdentity,
    cwd: identity.cwd,
    productVersion: identity.productVersion,
    agentId: null,
    rootOwnership: 'unverified',
    possibleChildContribution: 'unknown',
    mappedImageProof: 'unverified',
    ...(product === 'codex'
      ? {
          mode: 'codex_source_only',
          product,
          processId: null,
          processStart: null,
          nativePinDigest: null,
          sourceVersionBasis: 'root_creation_header',
          lifecycle: 'startup',
          writerVersion: 'unverified',
          publisherProof: 'unavailable'
        }
      : {
          mode: 'claude_publisher_local_pin',
          product,
          processId: 'synthetic-process',
          processStart: 'synthetic-start',
          nativePinDigest: 'a'.repeat(64),
          sourceVersionBasis: 'scoped_source',
          publisherProof: 'verified_disk_assets'
        })
  };
  const connect = (bound = identity, connectReceipt = receipt) => {
    life.start(taskId);
    store.execute('INSERT INTO sessions(id,project_id,task_id,product,product_version) VALUES (?,?,?,?,?)', [
      rootId,
      selection.projectId,
      taskId,
      product,
      selection.declaredVersion
    ]);
    store.execute(
      `INSERT INTO binding_root_segments(root_session_id,task_id,product,native_root_id,project_root,state,opened_at)
      VALUES (?,?,?,?,?,'acquiring',?)`,
      [rootId, taskId, product, identity.sessionId, identity.cwd, clock()]
    );
    store.execute('UPDATE ordinary_tasks SET selected_root_id=? WHERE task_id=?', [rootId, taskId]);
    recordOrdinaryWindowSegment(store, { taskId, rootSessionId: rootId, clock }, proof);
    store.execute(
      `INSERT INTO session_bindings(session_id,task_id,root_id,identity,connect_receipt,observed_since,generation,state,cursor)
      VALUES (?,?,?,?,?,?,?,'observing','initial')`,
      [rootId, taskId, rootId, JSON.stringify(bound), connectReceipt, clock(), life.task(taskId).generation]
    );
    store.execute("UPDATE binding_root_segments SET state='observing',baseline_at=? WHERE root_session_id=?", [clock(), rootId]);
  };
  const record = (id = 'request-one') => windowRecord(identity, clock(), id);
  const calls: string[] = [];
  const batch = (records: BindingUsageRecord[] = [record()]): OrdinaryWindowUsageBatch => ({
    records,
    cursor: 'next',
    gaps: [],
    coverage: { ...emptyOrdinaryWindowCoverage(), status: 'partial' }
  });
  let read: (boundary: OrdinaryWindowReadBoundary) => Promise<OrdinaryWindowUsageBatch> = () => Promise.resolve(batch());
  const provider = windowProvider(identity, calls, boundary => read(boundary));
  return {
    store,
    life,
    taskId,
    rootId,
    identity,
    proof,
    selection,
    clock,
    activate,
    connect,
    record,
    calls,
    batch,
    provider,
    snapshot: () => windowSnapshot(store),
    onRead: (callback: typeof read) => {
      read = callback;
    }
  };
}

function windowSnapshot(store: Store) {
  return {
    events: store.all('SELECT * FROM events'),
    requests: store.all('SELECT * FROM binding_requests'),
    exclusions: store.all('SELECT * FROM binding_baseline_exclusions'),
    cursors: store.all('SELECT session_id,cursor FROM session_bindings'),
    pins: store.all('SELECT * FROM session_source_compatibility')
  };
}

function windowRecord(identity: VerifiedSessionIdentity, at: string, id: string): BindingUsageRecord {
  return {
    requestId: id,
    sessionId: identity.sessionId,
    occurredAt: at,
    turnId: null,
    effort: 'high',
    payload: {
      kind: 'usage',
      schema_version: 2,
      product: identity.product,
      product_version: identity.productVersion,
      model: identity.product === 'codex' ? 'gpt-6.1-sol' : 'claude-sonnet-4-5',
      epoch: 'window-epoch',
      attribution: 'verified',
      input_total: { status: 'observed', value: 10, reason: null },
      cached_input: { status: 'observed', value: 2, reason: null },
      output_total: { status: 'observed', value: 5, reason: null },
      reasoning_output: { status: 'observed', value: 1, reason: null },
      billing_components: []
    }
  };
}
function windowProvider(
  identity: VerifiedSessionIdentity,
  calls: string[],
  read: (boundary: OrdinaryWindowReadBoundary) => Promise<OrdinaryWindowUsageBatch>
): SessionBindingProvider {
  return {
    product: identity.product,
    capabilities: () => ({
      currentIdentity: 'native_hook',
      ancestry: 'unavailable',
      usage: 'root_source_reference',
      productionSupported: false,
      maxDepth: 0,
      reasons: []
    }),
    resolveCurrent: () => {
      calls.push('resolve');
      return Promise.resolve(identity);
    },
    inspectCurrent: () => {
      calls.push('inspect');
      return Promise.reject(new Error('window_fixture_no_exact_proof'));
    },
    revalidateBound: () => {
      calls.push('revalidate');
      return Promise.resolve(identity);
    },
    discoverChildren: () => {
      calls.push('discover');
      return Promise.reject(new Error('window_fixture_no_child_reads'));
    },
    readUsage: () => {
      calls.push('exact-read');
      return Promise.reject(new Error('window_fixture_no_exact_reads'));
    },
    readWindowUsage: (_value, _cursor, _scope, boundary) => {
      boundary.authorizeSource(identity);
      calls.push('read');
      return read(boundary);
    }
  };
}
