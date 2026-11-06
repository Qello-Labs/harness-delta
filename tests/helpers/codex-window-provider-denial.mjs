import { Store } from '../../dist/store.js';
import { createLocalWebBindingProviders } from '../../dist/web/local-web-binding-providers.js';
import { Lifecycle } from '../../dist/lifecycle.js';
import { createOrdinaryWindowTask } from '../../dist/ordinary-observation.js';
import { connectOrdinaryCodexWindow, createOrdinarySessionBindingService } from '../../dist/ordinary-session-binding.js';
import { createSessionBindingService } from '../../dist/session-binding-service.js';
import { CodexWindowSessionBindingProvider } from '../../dist/session-binding-codex.js';
import { issueCodexWindowSourceAuthorization, ordinaryWindowRuntimeRevision, ordinaryWindowSelection } from '../../dist/core/ordinary-window-store.js';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString());
const clock = () => input.recordedAt;
const store = new Store(':memory:', clock);
const providerCalls = {
  factory: 0,
  pending: 0,
  inspect: 0,
  revalidate: 0,
  read: 0
};
for (const [method, key] of [
  ['pendingReceipt', 'pending'],
  ['inspectWindowCurrent', 'inspect'],
  ['revalidateBound', 'revalidate'],
  ['readWindowUsage', 'read']
]) {
  const original = CodexWindowSessionBindingProvider.prototype[method];
  CodexWindowSessionBindingProvider.prototype[method] = function (...args) {
    providerCalls[key] += 1;
    return Reflect.apply(original, this, args);
  };
}
let binding;
try {
  store.execute('INSERT INTO projects(id,local_root) VALUES (?,?)', ['project', input.projectRoot]);
  const taskId = createOrdinaryWindowTask(
    store,
    {
      schema_version: 2,
      mode: 'ordinary_window',
      project_id: 'project',
      product: 'codex',
      declared_version: '0.167.0',
      policy_id: 'codex-binding-root-window-v1',
      criterion_ids: ['accepted']
    },
    clock
  );
  const selection = ordinaryWindowSelection(store, taskId);
  if (!selection) throw new Error('denial_fixture_selection_missing');
  const life = new Lifecycle(store, clock);
  if (input.authority !== 'inactive_task') life.start(taskId);
  if (input.authority !== 'absent') {
    if (input.authority === 'wrong_project') {
      store.execute('INSERT INTO projects(id,local_root) VALUES (?,?)', ['other', `${input.projectRoot}/other`]);
    }
    store.execute(
      `INSERT INTO ordinary_window_activations(project_id,product,source,policy_id,policy_revision,policy_digest,evidence_mode,
      accepted_risks,implementation_revision,evidence_ref,review_ref,decided_at,revoked_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        input.authority === 'wrong_project' ? 'other' : selection.projectId,
        input.authority === 'wrong_product' ? 'claude_code' : 'codex',
        input.authority === 'wrong_product' ? 'claude_binding' : selection.policy.source,
        input.authority === 'wrong_policy' ? 'other-policy' : selection.policy.policyId,
        input.authority === 'wrong_revision' ? 'other-revision' : selection.policy.ruleRevision,
        input.authority === 'wrong_digest' ? 'b'.repeat(64) : selection.policyDigest,
        input.authority === 'wrong_mode' ? 'publisher_verified_local_pin' : selection.policy.evidenceMode,
        JSON.stringify(['source_identity_limits', 'root_ownership_unverified']),
        input.authority === 'stale_implementation' ? 'ordinary-window-runtime-v1' : ordinaryWindowRuntimeRevision,
        'synthetic-evidence',
        'synthetic-review',
        clock(),
        input.authority === 'revoked' ? clock() : null
      ]
    );
  }
  if (input.authority === 'native_deleted' || input.authority === 'other_product_deleted') {
    store.execute('INSERT INTO tombstones(kind,id,deleted_at) VALUES (?,?,?)', ['session', 'native-root', clock()]);
    if (input.authority === 'other_product_deleted') {
      store.execute('INSERT INTO binding_native_tombstones(product,native_session_id) VALUES (?,?)', ['claude_code', 'native-root']);
    }
  }
  if (input.authority === 'selection_deleted' || input.authority === 'scope_rows_deleted') {
    if (input.authority === 'scope_rows_deleted') {
      store.execute('INSERT INTO ordinary_window_forget_fences(product,native_session_id,task_id) VALUES (?,?,?)', ['codex', 'native-root', taskId]);
      store.execute('DELETE FROM ordinary_tasks WHERE task_id=?', [taskId]);
    }
    store.execute('DELETE FROM ordinary_window_selections WHERE task_id=?', [taskId]);
  }
  const options = {
    store,
    taskId: input.authority === 'wrong_task' ? 'other-task' : taskId,
    receiptDirectory: input.receiptDirectory,
    sourceRoots: [input.sourceRoot],
    clock
  };
  let outcome;
  try {
    if (input.entry.startsWith('web_')) {
      const providers = createLocalWebBindingProviders({
        options: {
          store,
          bindingProviderFactory: () => {
            providerCalls.factory += 1;
            return [];
          },
          ...(input.entry === 'web_static' ? { bindingProviders: [] } : {})
        },
        recordFor: () => undefined,
        setupFor: () => {
          throw new Error('denial_setup_forbidden');
        },
        profileFor: () => {
          throw new Error('denial_profile_forbidden');
        },
        codexProjects: {},
        ordinaryBindings: () => {
          throw new Error('denial_bindings_forbidden');
        },
        humanPilot: () => undefined
      });
      if (input.entry === 'web_cached') providers.providers.set(taskId, []);
      providers.providersForTask(taskId);
    } else if (input.entry === 'ordinary_public') {
      binding = createOrdinarySessionBindingService({
        store,
        clock,
        providersForTask: () => {
          providerCalls.factory += 1;
          return [];
        }
      });
      await binding.connect(taskId, 'codex', { receipt: input.receipt });
    } else if (input.entry === 'assigned_public') {
      binding = createSessionBindingService({
        store,
        clock,
        providers: [],
        providersForTask: () => {
          providerCalls.factory += 1;
          return [];
        },
        setupFor: () => {
          throw new Error('denial_setup_forbidden');
        }
      });
      await binding.connect(taskId, 'codex', { receipt: input.receipt });
    } else if (input.entry === 'forged_authorization') {
      const issued = issueCodexWindowSourceAuthorization(
        store,
        {
          taskId,
          generation: life.task(taskId).generation
        },
        'metadata'
      );
      new CodexWindowSessionBindingProvider({
        authorization: () => issued(),
        receiptDirectory: input.receiptDirectory,
        projectRoot: input.projectRoot,
        sourceRoots: [input.sourceRoot],
        clock
      });
    } else {
      await connectOrdinaryCodexWindow(options, {
        receipt: input.receipt
      });
    }
    outcome = 'connected';
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    outcome = error.message;
  }
  process.stdout.write(
    JSON.stringify({
      outcome,
      providerCalls,
      events: store.eventCount(),
      proofs: store.all('SELECT * FROM ordinary_window_segments').length,
      bindings: store.all('SELECT * FROM session_bindings').length,
      replay: store.all('SELECT * FROM binding_requests').length,
      exclusions: store.all('SELECT * FROM binding_baseline_exclusions').length,
      pins: store.all('SELECT * FROM session_source_compatibility').length
    })
  );
} finally {
  if (binding && typeof binding.close === 'function') await binding.close();
  store.close();
}
