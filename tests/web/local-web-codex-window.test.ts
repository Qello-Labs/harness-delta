import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import filesystem from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { Store } from '../../src/store.js';
import { Lifecycle } from '../../src/core/lifecycle.js';
import { ApplicationCoordinator } from '../../src/harness/harness-application.js';
import { createOrdinaryTask, createOrdinaryWindowTask, ordinaryTask, saveOrdinaryProjectSettings } from '../../src/ordinary-observation.js';
import { assertOrdinaryWindowAuthority, ordinaryWindowRuntimeRevision, ordinaryWindowSelection } from '../../src/core/ordinary-window-store.js';
import { resolveOrdinaryWindow } from '../../src/core/ordinary-window-policy.js';
import { createLocalWebBindingSelection } from '../../src/web/local-web-binding-selection.js';
import { createLocalWebMetadata } from '../../src/web/local-web-metadata-store.js';
import { createCodexProjectSetupManager } from '../../src/web/local-web-codex.js';
import { createLocalWebDomain } from '../../src/web/local-web-domain.js';
import { type LocalWebTaskReadContext, readOrdinaryTask } from '../../src/web/local-web-task-read.js';
import { projectOrdinaryTask } from '../../src/web/local-web-task-projection-ordinary.js';
import { createLocalWebServer } from '../../src/web/local-web-server.js';
import * as readiness from '../../src/connect/claude-connect-readiness.js';
import * as native from '../../src/web/local-web-native.js';
import type { SessionBindingProvider } from '../../src/session-binding-contract.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function fixture(authority: 'absent' | 'revoked' | 'wrong_product' | 'valid' = 'valid') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'web-window-')));
  const filename = join(root, 'measurement.sqlite');
  const clock = () => '2026-11-06T01:00:00.000Z';
  const store = new Store(filename, clock);
  const life = new Lifecycle(store, clock);
  store.execute('INSERT INTO projects(id,local_root) VALUES (?,?)', ['project', root]);
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
  life.start(taskId);
  const selection = ordinaryWindowSelection(store, taskId);
  if (!selection) throw new Error('fixture_selection_missing');
  if (authority !== 'absent') {
    const activation = authority === 'wrong_product' ? resolveOrdinaryWindow('claude_code', '2.1.318', 'claude-binding-root-window-v1') : selection;
    if (!activation) throw new Error('fixture_activation_missing');
    store.execute(
      `INSERT INTO ordinary_window_activations(project_id,product,source,policy_id,policy_revision,policy_digest,evidence_mode,
      accepted_risks,implementation_revision,evidence_ref,review_ref,decided_at,revoked_at,decision_ref,decision_kind) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        selection.projectId,
        activation.policy.product,
        activation.policy.source,
        activation.policy.policyId,
        activation.policy.ruleRevision,
        activation.policyDigest,
        activation.policy.evidenceMode,
        JSON.stringify(['source_identity_limits', 'root_ownership_unverified']),
        ordinaryWindowRuntimeRevision,
        'synthetic-evidence',
        'synthetic-review',
        clock(),
        authority === 'revoked' ? clock() : null,
        'synthetic-decision',
        'product'
      ]
    );
  }
  const metadataFile = join(root, 'private.sqlite');
  const metadata = createLocalWebMetadata(store, metadataFile);
  metadata.initialize();
  metadata.insertTask({
    id: taskId,
    name: 'Synthetic window',
    profileId: 'ordinary-claude',
    projectId: 'project',
    setup: selection
  });
  const record = metadata.task(taskId);
  if (!record) throw new Error('fixture_record_missing');
  const forbidden = vi.fn((): never => {
    throw new Error('unexpected_native_or_metadata_access');
  });
  const provider = {
    product: 'codex',
    capabilities: forbidden,
    resolveCurrent: forbidden,
    inspectCurrent: forbidden,
    revalidateBound: forbidden,
    discoverChildren: forbidden,
    readUsage: forbidden,
    readWindowUsage: forbidden,
    forgetSession: forbidden
  } satisfies SessionBindingProvider;
  const factory = vi.fn(() => [provider]);
  const options = { store, metadataFile, bindingProviderFactory: factory };
  const dependencies = {
    options,
    recordFor: vi.fn(metadata.task),
    row: vi.fn(() => record),
    setupFor: forbidden,
    profileFor: forbidden,
    codexProjects: createCodexProjectSetupManager(store, metadata.database)
  };
  const bindings = createLocalWebBindingSelection(dependencies);
  const applications = new ApplicationCoordinator(store);
  const context: LocalWebTaskReadContext = {
    options,
    store,
    life,
    applications,
    row: dependencies.row,
    setupFor: forbidden,
    profileFor: forbidden,
    sourceFor: forbidden,
    running: forbidden,
    jobs: new Map(),
    ...bindings
  };
  const skill = vi.spyOn(readiness, 'inspectOrdinaryClaudeProjectSkill');
  const picker = vi.spyOn(native, 'nativeLocalPicker');
  const nativeReads = [
    vi.spyOn(filesystem, 'realpathSync'),
    vi.spyOn(filesystem, 'statSync'),
    vi.spyOn(filesystem, 'lstatSync'),
    vi.spyOn(filesystem, 'openSync'),
    vi.spyOn(filesystem, 'readFileSync'),
    vi.spyOn(filesystem, 'readdirSync')
  ];
  syncBuiltinESMExports();
  let closed = false;
  const closeStore = async () => {
    if (closed) return;
    await bindings.ordinaryBindings.close();
    applications.close();
    metadata.close();
    store.close();
    closed = true;
  };
  cleanups.push(async () => {
    await closeStore();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    filename,
    clock,
    store,
    life,
    taskId,
    selection,
    record,
    metadataFile,
    metadata,
    provider,
    factory,
    forbidden,
    dependencies,
    bindings,
    context,
    skill,
    picker,
    nativeReads,
    closeStore,
    reason: authority === 'valid' ? 'binding_window_unavailable' : 'binding_window_activation_required'
  };
}

function expectNoIo(f: ReturnType<typeof fixture>, store = f.store) {
  expect(f.factory).not.toHaveBeenCalled();
  expect(f.forbidden).not.toHaveBeenCalled();
  expect(f.dependencies.recordFor).not.toHaveBeenCalled();
  expect(f.skill).not.toHaveBeenCalled();
  expect(f.picker).not.toHaveBeenCalled();
  for (const read of f.nativeReads) expect(read).not.toHaveBeenCalled();
  expect(store.eventCount()).toBe(0);
  expect(store.all('SELECT * FROM session_source_compatibility')).toEqual([]);
}

test.each(['absent', 'revoked', 'wrong_product', 'valid'] as const)(
  'refuses public window reads before task metadata and skill inspection with %s authority',
  authority => {
    const f = fixture(authority);
    if (authority === 'valid') {
      expect(assertOrdinaryWindowAuthority(f.store, { taskId: f.taskId })).toEqual(f.selection);
    }
    const taskRead = vi.spyOn(f.life, 'task');
    expect(() => readOrdinaryTask(f.context, f.taskId, f.record)).toThrow(f.reason);
    expect(taskRead).not.toHaveBeenCalled();
    expectNoIo(f);
  }
);

test.each(['factory', 'static', 'cached'] as const)('refuses %s provider returns before metadata or native access', route => {
  const f = fixture();
  const selected =
    route === 'static'
      ? createLocalWebBindingSelection({
          ...f.dependencies,
          options: {
            ...f.context.options,
            bindingProviders: [f.provider]
          }
        })
      : f.bindings;
  if (route === 'cached') selected.providers.set(f.taskId, [f.provider]);
  expect(() => selected.providersForTask(f.taskId)).toThrow(f.reason);
  expectNoIo(f);
});

test('refuses window pause selection with an injected fallback and pending cleanup', () => {
  const f = fixture();
  const selected = createLocalWebBindingSelection({
    ...f.dependencies,
    options: { ...f.context.options, bindingProviders: [f.provider] }
  });
  f.store.execute('INSERT INTO session_binding_forgets(product,native_session_id,task_id,project_root) VALUES (?,?,?,?)', [
    'codex',
    'unrelated-exact-root',
    'deleted-exact-task',
    f.root
  ]);
  const before = f.store.all('SELECT * FROM session_binding_forgets');
  expect(() => selected.bindings.pause(f.taskId)).toThrow(f.reason);
  expect(f.store.all('SELECT * FROM session_binding_forgets')).toEqual(before);
  expectNoIo(f);
});

test('refuses direct window projection instead of emitting Claude-only legacy aggregates', () => {
  const f = fixture();
  saveOrdinaryProjectSettings(
    f.store,
    'project',
    {
      schema_version: 1,
      product: 'claude_code',
      product_version: '2.1.296',
      receipt_directory: join(f.root, 'receipts'),
      claude_projects_directory: join(f.root, 'projects')
    },
    f.clock
  );
  const exactId = createOrdinaryTask(
    f.store,
    {
      project_id: 'project',
      criterion_ids: ['accepted']
    },
    f.clock
  );
  f.skill.mockReturnValue({
    state: 'missing',
    reason: 'ordinary_skill_missing',
    install_command: null
  });
  const data = readOrdinaryTask(f.context, exactId, {
    ...f.record,
    id: exactId
  });
  expect(projectOrdinaryTask(data)).toMatchObject({
    mode: 'ordinary',
    binding: { product: 'claude_code', product_version: '2.1.296' }
  });
  const preparation = ordinaryTask(f.store, f.taskId);
  if (!preparation) throw new Error('fixture_preparation_missing');
  expect(() =>
    projectOrdinaryTask({
      ...data,
      id: f.taskId,
      task: f.life.task(f.taskId),
      record: f.record,
      preparation
    })
  ).toThrow('binding_window_unavailable');
});

test('HTTP task reads remain closed after a Store and domain restart without a DTO escape', async () => {
  const f = fixture();
  const options = {
    store: f.store,
    metadataFile: f.metadataFile,
    bindingProviderFactory: f.factory
  };
  const domain = createLocalWebDomain(options);
  const origin = 'http://127.0.0.1:4339';
  const app = createLocalWebServer({
    origin,
    domain,
    metadataFile: f.metadataFile
  });
  try {
    await app.inject({
      url: '/transport-ready',
      headers: { host: '127.0.0.1:4339' }
    });
    for (const read of f.nativeReads) read.mockClear();
    const response = await app.inject({
      url: `/api/tasks/${f.taskId}`,
      headers: { host: '127.0.0.1:4339' }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: f.reason });
    expect(response.headers.etag).toBeUndefined();
    expectNoIo(f);
  } finally {
    await app.close();
    await domain.close?.();
  }
  await f.closeStore();
  const reopened = new Store(f.filename, f.clock);
  const restarted = createLocalWebDomain({
    ...options,
    store: reopened,
    bindingProviders: [f.provider]
  });
  try {
    for (const read of f.nativeReads) read.mockClear();
    expect(() => restarted.task(f.taskId)).toThrow(f.reason);
    expectNoIo(f, reopened);
  } finally {
    await restarted.close?.();
    reopened.close();
  }
});
