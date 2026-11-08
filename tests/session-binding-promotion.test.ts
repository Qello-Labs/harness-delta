import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi, type Mock } from 'vitest';
import type { PromotionDecision } from '../scripts/tool-update/promotion-records.mjs';
import { appendPromotionDecision, type PromotionFixture } from './helpers/tool-version-promotion.js';
import { projectToolVersionPromotions, promotionProjectionDigest, promotionRegistryDigest } from '../src/core/tool-version-promotion.js';
import { promotionRegistryFixture } from './helpers/tool-version-promotion-registry.js';

const registry: {
  fixture:
    | (PromotionFixture & {
        registry: {
          profiles: readonly unknown[];
          recipes: readonly unknown[];
          identities: readonly unknown[];
        };
      })
    | undefined;
  image: string;
  imageSha: string;
  hostSha: string;
  native: Mock<(...args: unknown[]) => void>;
} = vi.hoisted(() => ({
  fixture: undefined,
  image: '',
  imageSha: '',
  hostSha: '',
  native: vi.fn()
}));

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: (...args: unknown[]) => {
      registry.native(...args);
      return `p${process.pid}\nn${registry.image}\n`;
    }
  };
});
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    openSync: vi.fn(actual.openSync),
    fstatSync: vi.fn(actual.fstatSync),
    realpathSync: vi.fn(actual.realpathSync)
  };
});

vi.mock('../src/core/tool-version-profiles.json', async importOriginal => {
  const actual = await importOriginal<{ default: unknown }>();
  return {
    get default() {
      return registry.fixture?.registry.profiles ?? actual.default;
    }
  };
});
vi.mock('../src/core/tool-version-recipes.json', async importOriginal => {
  const actual = await importOriginal<{ default: unknown }>();
  return {
    get default() {
      return registry.fixture?.registry.recipes ?? actual.default;
    }
  };
});
vi.mock('../src/core/tool-version-identities.json', async importOriginal => {
  const actual = await importOriginal<{ default: typeof import('../src/core/tool-version-identities.json') }>();
  return {
    get default() {
      return registry.fixture
        ? {
            ...actual.default,
            entries: registry.fixture.registry.identities
          }
        : actual.default;
    }
  };
});
vi.mock('../src/core/tool-version-promotions.json', () => ({
  get default() {
    return registry.fixture?.ledger ?? { schema_version: 1, records: [] };
  }
}));
vi.mock('../src/core/tool-version-promotion-result.json', async importOriginal => {
  const actual = await importOriginal<{ default: unknown }>();
  return {
    get default() {
      return registry.fixture
        ? {
            schema_version: 1,
            implementation_scheme: 'promotion-implementation-v1',
            implementation_digest: registry.fixture.implementationDigest,
            effective_projection_digest: promotionProjectionDigest(projectToolVersionPromotions(registry.fixture))
          }
        : actual.default;
    }
  };
});

let ClaudeSessionBindingProvider: typeof import('../src/session-binding-claude.js').ClaudeSessionBindingProvider;
let claudeProjectDirName: typeof import('../src/session-binding-claude.js').claudeProjectDirName;
let CodexSessionBindingProvider: typeof import('../src/session-binding-codex.js').CodexSessionBindingProvider;
let proposeCodexSessionBindingHooks: typeof import('../src/session-binding-codex.js').proposeCodexSessionBindingHooks;
let readClaudeProcessBinary: typeof import('../src/claude-process-binary.js').readClaudeProcessBinary;
let getEffectiveCodexBindingQualification: typeof import('../src/qualification/codex-binding-qualification-versions.js').getEffectiveCodexBindingQualification;
let codexBindingQualificationCodeModeHost: typeof import('../src/qualification/codex-binding-qualification-versions.js').codexBindingQualificationCodeModeHost;
let root: string;
const now = '2026-11-08T12:00:00.000Z';
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  vi.resetModules();
  root = realpathSync(mkdtempSync(join(tmpdir(), 'binding-promotion-')));
  registry.fixture = undefined;
  registry.image = join(root, 'synthetic-image');
  writeFileSync(registry.image, 'synthetic image', { mode: 0o700 });
  registry.imageSha = createHash('sha256').update('synthetic image').digest('hex');
  registry.hostSha = createHash('sha256').update('host').digest('hex');
  registry.native.mockClear();
  await selectProduct('claude_code');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});
function fixture() {
  if (!registry.fixture) throw new Error('synthetic_registry_required');
  return registry.fixture;
}
async function selectProduct(product: 'codex' | 'claude_code') {
  vi.resetModules();
  registry.fixture = undefined;
  const synthetic = promotionRegistryFixture(product);
  const row = synthetic.descriptors[0];
  if (!row) throw new Error('synthetic_descriptor_required');
  const identities = synthetic.registry.identities.map(image => (image.id === row.nativeIdentity ? { ...image, sha256: registry.imageSha } : image));
  if (product === 'codex') {
    identities.push({
      id: 'synthetic-host',
      product,
      version: row.version,
      kind: 'component',
      sha256: registry.hostSha,
      maxBytes: 134217728,
      exactBytes: 4,
      exactSizeMode: 'always'
    });
  }
  const recipes = synthetic.registry.recipes.map(recipe =>
    product === 'codex' && recipe.id !== undefined && row.recipeReferences.includes(recipe.id) ? { ...recipe, hostIdentity: 'synthetic-host' } : recipe
  );
  const sourceRegistry = { ...synthetic.registry, identities, recipes };
  registry.fixture = {
    ...synthetic,
    registry: sourceRegistry,
    registryDigest: promotionRegistryDigest(sourceRegistry)
  };
  const facade = await import('../src/core/tool-version-profiles.js');
  Object.defineProperty(facade.toolVersionPromotionProjection, 'facets', {
    get: () => projectToolVersionPromotions(fixture()).facets
  });
  Object.defineProperty(facade.toolVersionPromotionProjection, 'denials', {
    get: () => projectToolVersionPromotions(fixture()).denials
  });
  ({ ClaudeSessionBindingProvider, claudeProjectDirName } = await import('../src/session-binding-claude.js'));
  ({ CodexSessionBindingProvider, proposeCodexSessionBindingHooks } = await import('../src/session-binding-codex.js'));
  ({ readClaudeProcessBinary } = await import('../src/claude-process-binary.js'));
  ({ getEffectiveCodexBindingQualification, codexBindingQualificationCodeModeHost } =
    await import('../src/qualification/codex-binding-qualification-versions.js'));
}
function descriptor() {
  const row = fixture().descriptors[0];
  if (!row) throw new Error('synthetic_descriptor_required');
  return row;
}
function decision(operation: 'collect' | 'link' | 'restart' = 'collect', topology: 'root' | 'bounded_family' = 'root', deny = false) {
  const row = descriptor();
  const scope: PromotionDecision['scope'] = {
    target: { version: row.version, commit: row.sourceRef },
    lane: {
      product: row.product,
      route: row.route,
      profile_id: row.profileId,
      operation,
      topology
    },
    platform: 'darwin_arm64',
    runtime: Number(process.versions.node.split('.')[0]) === 24 ? 'node24' : 'node26'
  };
  return appendPromotionDecision(fixture(), {
    scope,
    proposed_scope: scope,
    ...(topology === 'bounded_family'
      ? {
          requested_grants: ['admission', 'children', 'qualification'],
          grants: ['admission', 'children', 'qualification']
        }
      : {}),
    ...(deny ? { decision: 'revoke', reason: 'authority_withdrawn', grants: [] } : {})
  });
}
function claude() {
  return new ClaudeSessionBindingProvider({
    receiptDir: join(root, 'receipts'),
    claudeProjectsDir: join(root, 'projects'),
    projectRoot: root,
    productVersion: descriptor().version,
    ordinaryAdmission: true,
    maxFamilyMembers: 1,
    readProcessIdentity: () => 'synthetic-process',
    now: () => Date.parse(now)
  });
}
function claudeReceipt(version = descriptor().version) {
  const native = randomUUID(),
    receipt = randomUUID();
  const source = join(root, 'projects', claudeProjectDirName(root), `${native}.jsonl`);
  mkdirSync(dirname(source), { recursive: true, mode: 0o700 });
  writeFileSync(
    source,
    JSON.stringify({
      type: 'user',
      sessionId: native,
      version,
      cwd: root,
      timestamp: now
    }) + '\n',
    { mode: 0o600 }
  );
  mkdirSync(join(root, 'receipts', 'connect'), {
    recursive: true,
    mode: 0o700
  });
  writeFileSync(
    join(root, 'receipts', 'connect', `${receipt}.json`),
    JSON.stringify({
      schema_version: 1,
      kind: 'connect',
      receipt_id: receipt,
      session_id: native,
      agent_id: null,
      agent_type: null,
      transcript_path: source,
      agent_transcript_path: null,
      cwd: root,
      claude_pid: process.pid,
      recorded_at: now,
      uid: process.getuid?.() ?? null
    }),
    { mode: 0o600 }
  );
  return { receipt, native, source };
}

test('default Claude provider resolves a granted exact image without a binary reader override', async () => {
  decision();
  decision('link');
  const receipt = claudeReceipt();
  const identity = await claude().resolveCurrent({
    receipt: receipt.receipt
  });
  expect(identity.productVersion).toBe('2.1.318');
  expect(identity.sessionId).toBe(receipt.native);
  expect(readClaudeProcessBinary(process.pid)).toEqual({
    productVersion: '2.1.318',
    sha256: registry.imageSha
  });
});

test.each(['pending', 'denied'] as const)('Claude %s descriptors refuse before process image access', state => {
  if (state === 'denied') {
    decision();
    decision('collect', 'root', true);
  }
  expect(() => claude()).toThrow('claude_source_version_unsupported');
  expect(registry.native).not.toHaveBeenCalled();
});

test('cached exact Claude image becomes ineligible immediately after denial', () => {
  decision();
  expect(readClaudeProcessBinary(process.pid).productVersion).toBe('2.1.318');
  decision('collect', 'root', true);
  expect(() => readClaudeProcessBinary(process.pid)).toThrow('claude_binary_unqualified');
});

test('default Claude provider refuses an unregistered image digest', async () => {
  decision();
  decision('link');
  writeFileSync(registry.image, 'different synthetic image', { mode: 0o700 });
  const receipt = claudeReceipt();
  await expect(claude().resolveCurrent({ receipt: receipt.receipt })).rejects.toThrow('claude_binary_unqualified');
});

test('default Claude provider refuses a transcript version different from the granted image', async () => {
  decision();
  decision('link');
  const receipt = claudeReceipt('2.1.317');
  await expect(claude().resolveCurrent({ receipt: receipt.receipt })).rejects.toThrow('claude_source_version_unsupported');
});

test('Claude collect grant cannot supply link or restart authority', async () => {
  decision();
  const receipt = claudeReceipt();
  await expect(claude().resolveCurrent({ receipt: receipt.receipt })).rejects.toThrow('claude_source_version_unsupported');
  expect(registry.native).not.toHaveBeenCalled();
});

test('root-only Claude grant never inspects a child source or exposes family ancestry', async () => {
  decision();
  decision('link');
  const receipt = claudeReceipt();
  const provider = claude();
  const identity = await provider.resolveCurrent({
    receipt: receipt.receipt
  });
  const opened = vi.mocked(fs.openSync).mockClear();
  expect(await provider.discoverChildren(identity)).toEqual({
    children: [],
    gaps: []
  });
  expect(provider.capabilities().maxDepth).toBe(0);
  expect(provider.capabilities().ancestry).toBe('unavailable');
  expect(opened).not.toHaveBeenCalled();
});

function codex(maxDepth = 0, maxFamilyMembers = 1) {
  return new CodexSessionBindingProvider({
    receiptDirectory: join(root, 'receipts'),
    sourceRoots: [root],
    projectRoot: root,
    productVersion: descriptor().version,
    ordinaryFamilyAdmission: true,
    maxDepth,
    maxFamilyMembers
  });
}
function codexReceipt(parent: string | null = null) {
  mkdirSync(join(root, 'receipts'), { recursive: true, mode: 0o700 });
  const receipt = randomUUID(),
    source = join(root, `${parent ? 'child' : 'root'}.jsonl`);
  writeFileSync(
    source,
    JSON.stringify({
      type: 'session_meta',
      payload: {
        id: parent ? 'child' : 'root',
        session_id: 'root',
        cli_version: descriptor().version,
        cwd: root,
        parent_thread_id: parent,
        source: parent
          ? {
              subagent: {
                thread_spawn: {
                  parent_thread_id: parent,
                  depth: 1
                }
              }
            }
          : 'cli'
      }
    }) + '\n'
  );
  const stat = statSync(source);
  writeFileSync(
    join(root, 'receipts', `${receipt}.json`),
    JSON.stringify({
      schemaVersion: 1,
      receipt,
      productVersion: descriptor().version,
      event: parent ? 'SubagentStart' : 'SessionStart',
      sessionId: parent ? 'child' : 'root',
      parentSessionId: parent,
      turnId: parent ? 'child-turn' : null,
      sourceRef: source,
      sourceIdentity: `${stat.dev}:${stat.ino}`,
      cwd: root,
      createdAt: now
    }),
    { mode: 0o600 }
  );
  return receipt;
}
test('Codex root promotion resolves separately typed receipts without widening the legacy hook helper', async () => {
  await selectProduct('codex');
  decision();
  decision('link');
  const receipt = codexReceipt();
  const provider = codex();
  expect((await provider.resolveCurrent({ receipt })).productVersion).toBe('0.169.0');
  expect(provider.admissionProfile()).toBe('codex-binding-01690-direct-family-v1');
  expect(() =>
    proposeCodexSessionBindingHooks({
      receiptDirectory: join(root, 'receipts'),
      sourceRoots: [root],
      projectRoot: root,
      productVersion: '0.169.0',
      nodeExecutable: '/synthetic/node',
      scriptPath: '/synthetic/hook'
    })
  ).toThrow('binding_configuration_invalid');
});

test('Codex root promotion cannot authorize child discovery or child identity reads', async () => {
  await selectProduct('codex');
  decision();
  decision('link');
  const receipt = codexReceipt(),
    child = codexReceipt('root');
  const provider = codex();
  const identity = await provider.resolveCurrent({ receipt });
  const opened = vi.mocked(fs.openSync).mockClear();
  expect(await provider.discoverChildren(identity)).toEqual({
    children: [],
    gaps: []
  });
  expect(provider.capabilities().maxDepth).toBe(0);
  expect(provider.capabilities().ancestry).toBe('unavailable');
  expect(opened).not.toHaveBeenCalled();
  await expect(provider.resolveCurrent({ receipt: child })).rejects.toThrow('binding_source_unqualified');
});

test.each(['pending', 'denied'] as const)('Codex %s descriptor refuses before native path work', async state => {
  await selectProduct('codex');
  if (state === 'denied') {
    decision();
    decision('collect', 'root', true);
  }
  const canonical = vi.mocked(fs.realpathSync).mockClear();
  expect(() => codex()).toThrow('binding_configuration_invalid');
  expect(canonical).not.toHaveBeenCalled();
});

test('Codex qualification requires its exact qualification facet and validates the pinned host', async () => {
  await selectProduct('codex');
  decision();
  expect(getEffectiveCodexBindingQualification('0.169.0')).toBeUndefined();
  decision('collect', 'bounded_family');
  writeFileSync(join(root, 'codex-code-mode-host'), 'host', { mode: 0o700 });
  expect(getEffectiveCodexBindingQualification('0.169.0', 'collect', 'bounded_family')?.policy.rootRequestStop).toBe(4);
  expect(codexBindingQualificationCodeModeHost(join(root, 'codex'), '0.169.0', 'collect', 'bounded_family')).toEqual({
    path: join(root, 'codex-code-mode-host'),
    sha256: registry.hostSha
  });
  decision('collect', 'bounded_family', true);
  expect(getEffectiveCodexBindingQualification('0.169.0', 'collect', 'bounded_family')).toBeUndefined();
});

test('Codex family collection requires a family grant independently of root link authority', async () => {
  await selectProduct('codex');
  decision('collect', 'bounded_family');
  decision('link');
  const receipt = codexReceipt();
  codexReceipt('root');
  const provider = codex(1, 3);
  const identity = await provider.resolveCurrent({ receipt });
  expect((await provider.discoverChildren(identity)).children.map(child => child.identity.sessionId)).toEqual(['child']);
});

test('promoted Claude terminal finality delivers usage without candidate quiescence', async () => {
  decision();
  decision('link');
  const receipt = claudeReceipt();
  appendFileSync(
    receipt.source,
    JSON.stringify({
      type: 'assistant',
      sessionId: receipt.native,
      version: descriptor().version,
      timestamp: now,
      requestId: 'request-1',
      message: {
        id: 'message-1',
        model: 'claude-sonnet-5-5',
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 10,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 2
        }
      }
    }) + '\n'
  );
  const provider = claude();
  const identity = await provider.resolveCurrent({
    receipt: receipt.receipt
  });
  const batch = await provider.readUsage(identity, null, {
    projectId: 'project-1',
    taskId: 'task-1',
    allowedRootTurnIds: ['binding-observation'],
    sessions: [
      {
        sessionId: identity.sessionId,
        rootSessionId: identity.sessionId,
        parentSessionId: null,
        sourceId: identity.sessionId,
        nativeSessionId: receipt.native,
        product: 'claude_code',
        agentId: null,
        processId: identity.nativeMapping?.processId ?? null
      }
    ]
  });
  expect(batch.records.map(record => [record.requestId, record.payload.output_total.value])).toEqual([['request-1', 2]]);
});

async function qualificationStore() {
  const { Store } = await import('../src/store.js');
  const { Lifecycle } = await import('../src/core/lifecycle.js');
  const { OwnedCliInvocation } = await import('../src/connect/owned-cli-invocation.js');
  const { makeFlexibleFixture } = await import('./helpers/flexible-fixture.js');
  const f = makeFlexibleFixture();
  const store = new Store(':memory:');
  const lifecycle = new Lifecycle(store);
  lifecycle.registerProject('project-1', root);
  lifecycle.createTask('project-1', 'task-1', {
    ...f.metadata,
    product: 'codex'
  });
  store.execute('INSERT INTO comparison_variants(id,configuration) VALUES (?,?)', ['variant-a', JSON.stringify(f.variants[0])]);
  store.execute('INSERT INTO comparison_protocols(id,project_id,settings,status) VALUES (?,?,?,?)', [
    'protocol-1',
    'project-1',
    JSON.stringify({
      ...f.protocol,
      id: 'protocol-1',
      purpose: 'functional_pilot',
      minimum_effect: undefined,
      quality_margin: undefined,
      confidence_level: undefined,
      source_profiles: [
        {
          product: 'codex',
          product_version: descriptor().version,
          profile_id: descriptor().profileId
        }
      ]
    }),
    'frozen'
  ]);
  store.execute(
    `INSERT INTO comparison_assignments(
		id,task_id,project_id,protocol_id,variant_id,assigned_at,recorded_at,followup_ends_at,stratum_id,block_id,allocation_index,allocator_id
	) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ['assignment-1', 'task-1', 'project-1', 'protocol-1', 'variant-a', now, now, now, 'stratum-1', 'block-1', 0, 'allocator-1']
  );
  const deadline = Date.now() + 60000;
  store.execute('CREATE TABLE binding_qualification(singleton INTEGER PRIMARY KEY,task_id TEXT,deadline INTEGER,reserved INTEGER)', []);
  store.execute('INSERT INTO binding_qualification VALUES(1,?,?,1)', ['task-1', deadline]);
  const owner = new OwnedCliInvocation({
    command: '/synthetic/node',
    args: [],
    cwd: root,
    durationMs: 60000,
    stdio: 'ignore'
  });
  vi.spyOn(owner, 'hasSpawned').mockReturnValue(true);
  return {
    store,
    deadline,
    owner,
    leaseApi: await import('../src/binding/session-binding-qualification-lease.js')
  };
}

test('promoted qualification lease rechecks the current grant before native path validation', async () => {
  await selectProduct('codex');
  appendPromotionDecision(fixture(), {
    grants: ['admission', 'qualification']
  });
  const { store, owner, deadline, leaseApi } = await qualificationStore();
  try {
    const lease = leaseApi.issueCodexBindingLease(store, 'task-1', owner, deadline, 0);
    expect(leaseApi.assertBindingQualification(lease, store, 'task-1')).toBe(true);
    decision('collect', 'root', true);
    const canonical = vi.mocked(fs.realpathSync).mockClear();
    expect(() => leaseApi.assertBindingQualification(lease, store, 'task-1')).toThrow('binding_qualification_revoked');
    expect(canonical).not.toHaveBeenCalled();
  } finally {
    store.close();
  }
});

test('root qualification cannot issue a family lease or inspect a child identity source', async () => {
  await selectProduct('codex');
  appendPromotionDecision(fixture(), {
    grants: ['admission', 'qualification']
  });
  const { store, owner, deadline, leaseApi } = await qualificationStore();
  try {
    expect(() => leaseApi.issueCodexBindingLease(store, 'task-1', owner, deadline, 2)).toThrow('binding_qualification_scope_invalid');
    const lease = leaseApi.issueCodexBindingLease(store, 'task-1', owner, deadline, 0);
    const source = join(root, 'must-not-read-child');
    expect(() =>
      leaseApi.checkBindingQualificationIdentity(lease, store, 'task-1', {
        product: 'codex',
        productVersion: descriptor().version,
        sessionId: 'child',
        parentSessionId: 'root',
        sourceRef: source,
        sourceIdentity: 'synthetic-source',
        cwd: root,
        identityEvidenceId: randomUUID(),
        createdAt: new Date().toISOString()
      })
    ).toThrow('binding_qualification_family_limit');
  } finally {
    store.close();
  }
});

test.each(['codex', 'claude_code'] as const)('an existing %s provider refuses collection denial before native work', async product => {
  await selectProduct(product);
  decision();
  decision('link');
  const receipt = product === 'codex' ? codexReceipt() : claudeReceipt().receipt;
  const provider = product === 'codex' ? codex() : claude();
  decision('collect', 'root', true);
  const opened = vi.mocked(fs.openSync).mockClear();
  registry.native.mockClear();
  await expect(provider.resolveCurrent({ receipt })).rejects.toThrow(product === 'codex' ? 'binding_source_unqualified' : 'claude_source_version_unsupported');
  expect(opened).not.toHaveBeenCalled();
  expect(registry.native).not.toHaveBeenCalled();
});

test('Claude bound revalidation requires restart authority independently of link', async () => {
  decision();
  decision('link');
  const receipt = claudeReceipt();
  const provider = claude();
  const identity = await provider.resolveCurrent({
    receipt: receipt.receipt
  });
  await expect(provider.revalidateBound({ receipt: receipt.receipt }, identity)).rejects.toThrow('claude_source_version_unsupported');
  decision('restart');
  expect(await provider.revalidateBound({ receipt: receipt.receipt }, identity)).toEqual(identity);
});

test('Codex bound revalidation requires restart authority independently of link', async () => {
  await selectProduct('codex');
  decision();
  decision('link');
  const receipt = codexReceipt();
  const provider = codex();
  const identity = await provider.resolveCurrent({ receipt });
  const revalidate = provider.revalidateBound;
  if (!revalidate) throw new Error('promoted_restart_capability_required');
  await expect(revalidate({ receipt }, identity)).rejects.toThrow('binding_source_unqualified');
  decision('restart');
  expect(await revalidate({ receipt }, identity)).toEqual(identity);
});

test('legacy Codex construction does not acquire a restart capability', () => {
  mkdirSync(join(root, 'receipts'), { mode: 0o700 });
  const provider = new CodexSessionBindingProvider({
    receiptDirectory: join(root, 'receipts'),
    sourceRoots: [root],
    projectRoot: root
  });
  expect('revalidateBound' in provider).toBe(false);
});

test('promoted exact image refuses opened-file drift during hashing', () => {
  decision();
  const before = statSync(registry.image),
    after = statSync(registry.image);
  Object.defineProperty(after, 'mtimeMs', { value: before.mtimeMs + 1 });
  vi.mocked(fs.fstatSync).mockReturnValueOnce(before).mockReturnValueOnce(after);
  expect(() => readClaudeProcessBinary(process.pid)).toThrow('claude_binary_unqualified');
});

test('promoted Codex root collection delivers only its scoped own request', async () => {
  await selectProduct('codex');
  decision();
  decision('link');
  const receipt = codexReceipt();
  const rows = [
    {
      type: 'turn_context',
      timestamp: now,
      payload: {
        cwd: root,
        turn_id: 'turn',
        root_turn_id: 'turn',
        model: 'gpt-6.1-sol',
        effort: 'high'
      }
    },
    {
      type: 'token_usage_record',
      timestamp: now,
      payload: {
        thread_id: 'root',
        session_id: 'root',
        turn_id: 'turn',
        root_turn_id: 'turn',
        response_id: 'response-1',
        usage: {
          input_tokens: 100,
          cached_input_tokens: 10,
          output_tokens: 20,
          reasoning_output_tokens: 5,
          total_tokens: 120
        }
      }
    }
  ];
  appendFileSync(join(root, 'root.jsonl'), rows.map(row => JSON.stringify(row) + '\n').join(''));
  const provider = codex();
  const identity = await provider.resolveCurrent({ receipt });
  const batch = await provider.readUsage(identity, null, {
    projectId: 'project-1',
    taskId: 'task-1',
    allowedRootTurnIds: ['turn'],
    sessions: [
      {
        sessionId: 'root',
        rootSessionId: 'root',
        parentSessionId: null,
        sourceId: 'root',
        nativeSessionId: 'root',
        product: 'codex',
        agentId: null,
        processId: null
      }
    ]
  });
  expect(batch.records.map(record => [record.requestId, record.payload.input_total.value, record.payload.output_total.value])).toEqual([
    ['response-1', 100, 20]
  ]);
});

test.each([false, true])('promoted Claude production capability requires its own collection qualification: %s', qualified => {
  appendPromotionDecision(fixture(), { grants: qualified ? ['admission', 'qualification'] : ['admission'] });
  mkdirSync(join(root, 'receipts'), { mode: 0o700 });
  mkdirSync(join(root, 'projects'), { mode: 0o700 });
  expect(claude().capabilities().productionSupported).toBe(qualified);
});

test.each(['link', 'foreign-runtime'] as const)('qualification lease cannot borrow qualification from %s', async other => {
  await selectProduct('codex');
  const collect = appendPromotionDecision(fixture());
  const scope =
    other === 'link'
      ? { ...collect.decision.scope, lane: { ...collect.decision.scope.lane, operation: 'link' as const } }
      : { ...collect.decision.scope, runtime: collect.decision.scope.runtime === 'node26' ? ('node24' as const) : ('node26' as const) };
  appendPromotionDecision(fixture(), { scope, grants: ['admission', 'qualification'] });
  const { store, owner, deadline, leaseApi } = await qualificationStore();
  try {
    expect(getEffectiveCodexBindingQualification(descriptor().version)).toBeUndefined();
    expect(() => leaseApi.issueCodexBindingLease(store, 'task-1', owner, deadline, 0)).toThrow('binding_qualification_scope_invalid');
  } finally {
    store.close();
  }
});

test('Codex child usage cannot borrow root qualification for an unqualified family facet', async () => {
  await selectProduct('codex');
  appendPromotionDecision(fixture(), { grants: ['admission', 'qualification'] });
  decision('link');
  const family = decision('collect', 'bounded_family');
  appendPromotionDecision(fixture(), {
    scope: family.decision.scope,
    requested_grants: ['admission', 'children', 'qualification'],
    grants: ['admission', 'children']
  });
  const receipt = codexReceipt();
  codexReceipt('root');
  appendFileSync(
    join(root, 'child.jsonl'),
    [
      { type: 'turn_context', timestamp: now, payload: { cwd: root, turn_id: 'child-turn', root_turn_id: 'turn', model: 'gpt-6.1-sol', effort: 'high' } },
      {
        type: 'token_usage_record',
        timestamp: now,
        payload: {
          thread_id: 'child',
          session_id: 'root',
          turn_id: 'child-turn',
          root_turn_id: 'turn',
          response_id: 'child-response',
          usage: { input_tokens: 100, cached_input_tokens: 10, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 120 }
        }
      }
    ]
      .map(row => JSON.stringify(row) + '\n')
      .join('')
  );
  const provider = codex(1, 3);
  const identity = await provider.resolveCurrent({ receipt });
  const child = (await provider.discoverChildren(identity)).children[0]?.identity;
  if (!child) throw new Error('synthetic_child_required');
  const batch = await provider.readUsage(child, null, {
    projectId: 'project-1',
    taskId: 'task-1',
    allowedRootTurnIds: ['turn'],
    sessions: [identity, child].map(member => ({
      sessionId: member.sessionId,
      rootSessionId: 'root',
      parentSessionId: member.parentSessionId,
      sourceId: member.sessionId,
      nativeSessionId: member.sessionId,
      product: 'codex',
      agentId: null,
      processId: null
    }))
  });
  expect(batch.records.map(record => [record.requestId, record.payload.input_total.value])).toEqual([['child-response', 100]]);
});
