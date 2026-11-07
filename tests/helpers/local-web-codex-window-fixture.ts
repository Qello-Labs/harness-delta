import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/store.js';
import { Lifecycle } from '../../src/core/lifecycle.js';
import { createLocalWebDomain } from '../../src/web/local-web-domain.js';
import { createLocalWebServer } from '../../src/web/local-web-server.js';
import { ordinaryWindowRuntimeRevision, ordinaryWindowSelection } from '../../src/core/ordinary-window-store.js';
import { activateOrdinaryWindowDecision } from '../../src/core/ordinary-window-activation.js';
import { CodexWindowPendingReceiptSchema } from '../../src/session-binding-codex.js';
import type { CodexWindowTaskDto } from '../../src/web/local-web-codex-window-control.js';

function seedSyntheticReceipt(projectRoot: string, sourcePath: string, receiptDirectory: string, receipt: string) {
  mkdirSync(receiptDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(
    sourcePath,
    JSON.stringify({
      type: 'session_meta',
      payload: {
        id: 'synthetic-root',
        session_id: 'synthetic-root',
        cli_version: '0.167.0',
        cwd: projectRoot,
        source: 'cli'
      }
    }) + '\n',
    { mode: 0o600 }
  );
  writeFileSync(
    join(receiptDirectory, `${receipt}.json`),
    JSON.stringify(
      CodexWindowPendingReceiptSchema.parse({
        schemaVersion: 2,
        kind: 'codex_window_pending',
        receipt,
        product: 'codex',
        event: 'SessionStart',
        lifecycle: 'startup',
        nativeSessionId: 'synthetic-root',
        nativeRootSessionId: 'synthetic-root',
        agentId: null,
        turnId: null,
        cwd: projectRoot,
        sourceRef: sourcePath,
        recordedAt: new Date().toISOString()
      })
    ),
    { mode: 0o600 }
  );
}

export async function localWebCodexWindowFixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'web-codex-window-')));
  const projectRoot = join(directory, 'project');
  const sourceRoot = join(directory, 'synthetic-source');
  const receiptDirectory = join(projectRoot, '.harness-delta/window-receipts');
  mkdirSync(projectRoot, { mode: 0o700 });
  mkdirSync(sourceRoot, { mode: 0o700 });
  const store = new Store(':memory:');
  const life = new Lifecycle(store);
  life.registerProject('project', projectRoot);
  const domain = createLocalWebDomain({
    store,
    metadataFile: join(directory, 'metadata.sqlite')
  });
  if (!domain.codexProjectAction || !domain.codexWindow) {
    throw new Error('fixture_window_contract_missing');
  }
  await domain.codexProjectAction('project', {
    operation: 'configure',
    mode: 'ordinary_window',
    product_version: '0.167.0',
    source_roots: [sourceRoot]
  });
  const control = domain.codexWindow;
  const task = control.prepare('project', {
    name: 'Synthetic window',
    criterion_ids: ['accepted']
  });
  const taskId = task.task_id;
  const origin = 'http://127.0.0.1:4327';
  const app = createLocalWebServer({
    domain,
    origin,
    metadataFile: join(directory, 'transport.sqlite')
  });
  const get = (url: string) => app.inject({ url, headers: { host: '127.0.0.1:4327' } });
  const view = async () => (await get(`/api/tasks/${taskId}/codex-window-v1`)).json<{ csrf: string; task: CodexWindowTaskDto }>();
  const csrf = (await view()).csrf;
  const post = (url: string, body: unknown, version?: string, key = randomUUID()) =>
    app.inject({
      method: 'POST',
      url,
      payload: JSON.stringify(body),
      headers: {
        host: '127.0.0.1:4327',
        origin,
        'content-type': 'application/json',
        'x-harness-csrf': csrf,
        'idempotency-key': key,
        ...(version === undefined ? {} : { 'if-match': version })
      }
    });
  const action = async (operation: 'start' | 'pause' | 'resume' | 'revoke-collection' | 'collect') =>
    post(
      `/api/tasks/${taskId}/codex-window-action-v1`,
      {
        project_id: 'project',
        operation
      },
      (await view()).task.version
    );
  const activate = () => {
    const selection = ordinaryWindowSelection(store, taskId);
    if (!selection) throw new Error('fixture_selection_missing');
    return activateOrdinaryWindowDecision(
      store,
      {
        schema_version: 1,
        kind: 'ordinary_window_activation',
        decision_kind: 'product',
        decision_ref: 'synthetic-decision',
        project_id: 'project',
        product: 'codex',
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
      new Date().toISOString()
    );
  };
  const sourcePath = join(sourceRoot, 'root.jsonl');
  const receipt = randomUUID();
  const seedReceipt = () => seedSyntheticReceipt(projectRoot, sourcePath, receiptDirectory, receipt);
  const connect = async (key = randomUUID(), version?: string, projectId = 'project') =>
    post(`/api/tasks/${taskId}/codex-window-connect-v1`, { project_id: projectId, product: 'codex', receipt }, version ?? (await view()).task.version, key);
  return {
    directory,
    projectRoot,
    sourceRoot,
    receiptDirectory,
    sourcePath,
    store,
    life,
    domain,
    control,
    taskId,
    app,
    origin,
    csrf,
    get,
    post,
    view,
    action,
    activate,
    seedReceipt,
    connect,
    receipt,
    async close() {
      await app.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  };
}
