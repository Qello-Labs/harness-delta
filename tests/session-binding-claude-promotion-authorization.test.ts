import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { PromotionBindingAuthority, PromotionPendingReceipt, VerifiedSessionIdentity } from '../src/session-binding-contract.js';
import type { ToolVersionPromotionAuthority } from '../src/core/tool-version-promotion-store.js';
import type { ToolVersionPromotionFacet } from '../src/core/tool-version-promotion.js';
import type { ClaudeBindingOptions } from '../src/session-binding-claude.js';
import { projectToolVersionPromotions } from '../src/core/tool-version-promotion.js';
import { appendPromotionDecision, promotionFixture } from './helpers/tool-version-promotion.js';
import { Store } from '../src/store.js';
import { Lifecycle } from '../src/core/lifecycle.js';
import { createOrdinaryTask, saveOrdinaryProjectSettings } from '../src/ordinary-observation.js';
import { createOrdinarySessionBindingService } from '../src/ordinary-session-binding.js';
import { issuePromotionBindingAuthority } from '../src/binding/session-binding-promotion.js';

const synthetic = vi.hoisted(() => ({
  facets: [] as readonly ToolVersionPromotionFacet[],
  projection: undefined as ReturnType<typeof projectToolVersionPromotions> | undefined,
  image: '',
  hash: '',
  imageReads: vi.fn()
}));
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    openSync: vi.fn(actual.openSync),
    readSync: vi.fn(actual.readSync)
  };
});
vi.mock('../src/core/tool-version-profiles.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/core/tool-version-profiles.js')>();
  return {
    ...actual,
    get promotedToolVersionDescriptors() {
      return synthetic.facets.map(facet => facet.descriptor);
    },
    toolVersionPromotionProjection: new Proxy(actual.toolVersionPromotionProjection, {
      get(target, property) {
        if (property === 'facets') return synthetic.facets;
        const value: unknown = Reflect.get(synthetic.projection ?? target, property);
        return value;
      }
    }),
    lookupEffectiveToolVersionFacet: (product: string, version: string, operation: string, topology: string, platform: string, runtime: string) =>
      synthetic.facets.find(
        facet =>
          facet.descriptor.product === product &&
          facet.descriptor.version === version &&
          facet.decision.scope.lane.operation === operation &&
          facet.decision.scope.lane.topology === topology &&
          facet.decision.scope.platform === platform &&
          facet.decision.scope.runtime === runtime
      ),
    toolVersionIdentity: (id: string) => (id === 'synthetic-claude_code-image' ? { sha256: synthetic.hash } : actual.toolVersionIdentity(id))
  };
});
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: () => {
      synthetic.imageReads();
      return `p${process.pid}\nn${synthetic.image}\n`;
    }
  };
});

const { ClaudeSessionBindingProvider, claudeProjectDirName } = await import('../src/session-binding-claude.js');
let root: string, projects: string, receipts: string, source: string;
let pending: PromotionPendingReceipt;
let generation: number, projectionDigest: string, denied: boolean;
let authority: PromotionBindingAuthority;
const now = Date.parse('2026-11-09T12:00:00.000Z');
const processReads = vi.fn(() => 'synthetic-process-start');

function snapshot(): ToolVersionPromotionAuthority {
  if (denied) throw new Error('promotion_denied');
  return { state: 'allowed', generation, projectionDigest, denialIds: [] };
}
function grant(topology: 'root' | 'bounded_family' = 'root') {
  const fixture = promotionFixture('claude_code');
  const descriptor = fixture.descriptors[0];
  if (!descriptor) throw new Error('synthetic_descriptor_required');
  for (const operation of ['collect', 'link', 'restart'] as const) {
    const scope = {
      target: {
        version: descriptor.version,
        commit: descriptor.sourceRef
      },
      lane: {
        product: descriptor.product,
        route: descriptor.route,
        profile_id: descriptor.profileId,
        operation,
        topology: operation === 'collect' ? topology : ('root' as const)
      },
      platform: 'darwin_arm64' as const,
      runtime: Number(process.versions.node.split('.')[0]) === 24 ? ('node24' as const) : ('node26' as const)
    };
    const grants = topology === 'bounded_family' && operation === 'collect' ? (['admission', 'children'] as const) : (['admission', 'qualification'] as const);
    appendPromotionDecision(fixture, {
      scope,
      proposed_scope: scope,
      requested_grants: [...grants],
      grants: [...grants]
    });
  }
  synthetic.projection = projectToolVersionPromotions(fixture);
  synthetic.facets = synthetic.projection.facets;
  authority = {
    key: {
      product: 'claude_code',
      productVersion: descriptor.version,
      source: 'claude_binding',
      profileId: descriptor.profileId,
      operation: 'collect',
      topology,
      descriptorLineage: descriptor.sourceRef,
      platform: 'darwin_arm64',
      runtime: Number(process.versions.node.split('.')[0]) === 24 ? 'node24' : 'node26'
    },
    producerContract: 'promoted-payload-v1',
    grants: topology === 'root' ? ['admission'] : ['admission', 'children'],
    assertAuthorized: snapshot
  };
}
function provider(options: Partial<ClaudeBindingOptions> = {}) {
  return new ClaudeSessionBindingProvider({
    receiptDir: receipts,
    claudeProjectsDir: projects,
    projectRoot: root,
    productVersion: '2.1.318',
    ordinaryAdmission: true,
    maxFamilyMembers: 1,
    promotionAuthority: authority,
    now: () => now,
    readProcessIdentity: processReads,
    ...options
  });
}
function savePending(value: unknown = pending) {
  writeFileSync(join(receipts, `${pending.receipt}.json`), JSON.stringify(value), { mode: 0o600 });
}
function scopeFor(identity: VerifiedSessionIdentity) {
  return {
    projectId: 'synthetic-project',
    taskId: 'synthetic-task',
    allowedRootTurnIds: ['binding-observation'],
    sessions: [
      {
        sessionId: identity.sessionId,
        rootSessionId: identity.sessionId,
        parentSessionId: null,
        sourceId: identity.sessionId,
        product: identity.product,
        nativeSessionId: identity.sessionId,
        processId: identity.nativeMapping?.processId ?? null,
        agentId: null
      }
    ]
  };
}
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'claude-pending-')));
  projects = join(root, 'projects');
  receipts = join(root, 'receipts');
  for (const path of [projects, receipts]) mkdirSync(path, { mode: 0o700 });
  generation = 0;
  projectionDigest = 'a'.repeat(64);
  denied = false;
  processReads.mockClear();
  vi.mocked(fs.openSync).mockReset();
  vi.mocked(fs.readSync).mockReset();
  const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
  vi.mocked(fs.openSync).mockImplementation(actualFs.openSync);
  vi.mocked(fs.readSync).mockImplementation(actualFs.readSync);
  synthetic.imageReads.mockClear();
  synthetic.image = join(root, 'synthetic-image');
  synthetic.hash = createHash('sha256').update('synthetic image').digest('hex');
  writeFileSync(synthetic.image, 'synthetic image', { mode: 0o700 });
  grant();
  const native = randomUUID();
  source = join(projects, claudeProjectDirName(root), `${native}.jsonl`);
  mkdirSync(dirname(source), { mode: 0o700 });
  writeFileSync(
    source,
    JSON.stringify({
      type: 'user',
      sessionId: native,
      version: '2.1.318',
      timestamp: new Date(now - 1000).toISOString()
    }) + '\n',
    { mode: 0o600 }
  );
  pending = {
    schemaVersion: 3,
    kind: 'promotion_pending',
    producerContract: 'promoted-payload-v1',
    receipt: randomUUID(),
    product: 'claude_code',
    productVersion: '2.1.318',
    event: 'connect',
    nativeSessionId: native,
    nativeRootSessionId: native,
    agentId: null,
    sourceRef: source,
    cwd: root,
    processIdHint: process.pid,
    recordedAt: new Date(now).toISOString()
  };
  savePending();
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

test('verifies a pending receipt with the default exact image reader and native source metadata', async () => {
  const p = provider();
  expect(p.promotionAuthority).toBe(authority);
  expect(p.pendingPromotionReceipt({ receipt: pending.receipt })).toEqual(pending);
  const result = await p.receivePending(pending);
  expect(result.identity).toMatchObject({
    sessionId: pending.nativeSessionId,
    productVersion: '2.1.318',
    sourceRef: source,
    createdAt: new Date(now - 1000).toISOString(),
    nativeMapping: {
      nativeSessionId: pending.nativeSessionId,
      agentId: null
    }
  });
  expect(result.proof).toMatchObject({
    receipt: pending.receipt,
    nativeSessionId: pending.nativeSessionId,
    sourceRef: source,
    sourceIdentity: result.identity.sourceIdentity,
    processId: result.identity.nativeMapping?.processId
  });
  expect(synthetic.imageReads).toHaveBeenCalled();
  expect(await p.resolveCurrent({ receipt: pending.receipt })).toEqual(result.identity);
  expect(await p.inspectCurrent({ receipt: pending.receipt })).toEqual(result.proof);
  expect(await p.revalidateBound({ receipt: pending.receipt }, result.identity)).toEqual(result.identity);
  expect((await p.readUsage(result.identity, null, scopeFor(result.identity))).records).toEqual([]);
});

test('a promoted root connects through the real ordinary coordinator and its reserved source-read attempt', async () => {
  const clock = () => new Date(now).toISOString();
  const store = new Store(':memory:', clock);
  new Lifecycle(store, clock).registerProject('synthetic-project', root);
  saveOrdinaryProjectSettings(
    store,
    'synthetic-project',
    {
      schema_version: 1,
      product: 'claude_code',
      product_version: '2.1.318',
      receipt_directory: receipts,
      claude_projects_directory: projects
    },
    clock
  );
  const taskId = createOrdinaryTask(
    store,
    {
      project_id: 'synthetic-project',
      criterion_ids: ['accepted']
    },
    clock
  );
  const sourceReservations: string[] = [];
  const p = provider({
    promotionAuthority: issuePromotionBindingAuthority(store, {
      taskId,
      product: 'claude_code',
      productVersion: '2.1.318',
      topology: 'root',
      bundleContract: 'claude-promoted-bundle-v1'
    }),
    authorizeSource: metadata => {
      service.assertSource(taskId, metadata);
      const reservation = store.get<{ state: string }>('SELECT state FROM binding_root_segments WHERE task_id=?', [taskId]);
      if (!reservation) {
        throw new Error('source_read_without_reservation');
      }
      sourceReservations.push(reservation.state);
    },
    memberEligible: metadata => service.memberEligible(taskId, metadata)
  });
  const service = createOrdinarySessionBindingService({
    store,
    clock,
    providersForTask: () => [p]
  });
  try {
    const connected = await service.connect(taskId, 'claude_code', {
      receipt: pending.receipt
    });
    expect(connected).toMatchObject({
      status: 'connected',
      automatic_children: false
    });
    expect(store.get('SELECT state,native_root_id FROM binding_root_segments WHERE task_id=?', [taskId])).toEqual({
      state: 'observing',
      native_root_id: pending.nativeSessionId
    });
    expect(new Set(sourceReservations)).toEqual(new Set(['acquiring', 'observing']));
    expect(store.eventCount()).toBe(0);
  } finally {
    await service.close();
    store.close();
  }
});

test('a separately granted family verifies child identity from its native row and exact parent process', async () => {
  grant('bounded_family');
  const p = provider({ maxFamilyMembers: 3, memberEligible: () => true });
  const rootProof = await p.receivePending(pending);
  const childPath = join(dirname(source), pending.nativeSessionId, 'subagents', 'agent-child.jsonl');
  mkdirSync(dirname(childPath), { recursive: true, mode: 0o700 });
  writeFileSync(
    childPath,
    JSON.stringify({
      type: 'user',
      sessionId: pending.nativeSessionId,
      agentId: 'child',
      isSidechain: true,
      version: pending.productVersion,
      timestamp: new Date(now).toISOString()
    }) + '\n',
    { mode: 0o600 }
  );
  const child = {
    ...pending,
    receipt: randomUUID(),
    event: 'subagent_start' as const,
    agentId: 'child',
    sourceRef: childPath
  };
  writeFileSync(join(receipts, `${child.receipt}.json`), JSON.stringify(child), { mode: 0o600 });
  const discovered = await p.discoverChildren(rootProof.identity);
  expect(discovered.gaps).toEqual([]);
  expect(
    discovered.children.map(row => ({
      parent: row.parentSessionId,
      session: row.identity.sessionId,
      source: row.identity.sourceRef,
      process: row.identity.nativeMapping?.processId
    }))
  ).toEqual([
    {
      parent: pending.nativeSessionId,
      session: `${pending.nativeSessionId}:child`,
      source: childPath,
      process: rootProof.identity.nativeMapping?.processId
    }
  ]);
});

test.each([
  { schemaVersion: 1 },
  { producerContract: 'other' },
  { extra: true },
  { sourceRef: null },
  { processIdHint: null },
  { nativeRootSessionId: randomUUID() }
])('rejects malformed or hint-only pending payloads before native reads: %j', async change => {
  savePending({ ...pending, ...change });
  await expect(provider().resolveCurrent({ receipt: pending.receipt })).rejects.toThrow();
  expect(synthetic.imageReads).not.toHaveBeenCalled();
  expect(processReads).not.toHaveBeenCalled();
});

test.each(['empty', 'lineage', 'product', 'source'] as const)('rejects mismatched %s authority before image work', async mismatch => {
  const key = { ...authority.key };
  if (mismatch === 'lineage') key.descriptorLineage = 'b'.repeat(40);
  if (mismatch === 'product') key.product = 'codex';
  if (mismatch === 'source') key.source = 'codex_binding';
  const invalid = {
    ...authority,
    key,
    grants: mismatch === 'empty' ? [] : authority.grants
  };
  await expect(async () => {
    const p = provider({ promotionAuthority: invalid });
    await p.resolveCurrent({ receipt: pending.receipt });
  }).rejects.toThrow();
  expect(synthetic.imageReads).not.toHaveBeenCalled();
});

test('rejects a different exact image before source authorization', async () => {
  const authorizeSource = vi.fn();
  const p = provider({
    authorizeSource,
    readProcessBinary: () => ({
      productVersion: '2.1.318',
      sha256: 'f'.repeat(64)
    })
  });
  await expect(p.receivePending(pending)).rejects.toThrow('claude_binary_unqualified');
  expect(authorizeSource).not.toHaveBeenCalled();
});

test('refuses denial before receipt, process and image access', async () => {
  const p = provider();
  denied = true;
  expect(() => p.pendingPromotionReceipt({ receipt: pending.receipt })).toThrow('promotion_denied');
  await expect(p.resolveCurrent({ receipt: pending.receipt })).rejects.toThrow('promotion_denied');
  expect(processReads).not.toHaveBeenCalled();
  expect(synthetic.imageReads).not.toHaveBeenCalled();
});

test.each(['resolve', 'inspect', 'revalidate', 'usage', 'children'] as const)(
  'refuses %s after cached image success without another image read',
  async operation => {
    const p = provider();
    const identity = await p.resolveCurrent({ receipt: pending.receipt });
    synthetic.imageReads.mockClear();
    processReads.mockClear();
    denied = true;
    const action = () => {
      switch (operation) {
        case 'resolve':
          return p.resolveCurrent({ receipt: pending.receipt });
        case 'inspect':
          return p.inspectCurrent({ receipt: pending.receipt });
        case 'revalidate':
          return p.revalidateBound({ receipt: pending.receipt }, identity);
        case 'usage':
          return p.readUsage(identity, null, scopeFor(identity));
        case 'children':
          return p.discoverChildren(identity);
      }
    };
    await expect(action()).rejects.toThrow('promotion_denied');
    expect(processReads).not.toHaveBeenCalled();
    expect(synthetic.imageReads).not.toHaveBeenCalled();
  }
);

test('refuses root-only subagent receipt before any process or source work', async () => {
  savePending({ ...pending, event: 'subagent_start', agentId: 'child' });
  await expect(provider().resolveCurrent({ receipt: pending.receipt })).rejects.toThrow();
  expect(processReads).not.toHaveBeenCalled();
  expect(synthetic.imageReads).not.toHaveBeenCalled();
});

test.each(['denial', 'generation', 'projection'] as const)('rechecks %s after an awaited pending receiver', async change => {
  const p = provider();
  const receive = p.receivePending.bind(p);
  vi.spyOn(p, 'receivePending').mockImplementation(async input => {
    const result = await receive(input);
    if (change === 'denial') denied = true;
    if (change === 'generation') generation++;
    if (change === 'projection') projectionDigest = 'b'.repeat(64);
    return result;
  });
  await expect(p.resolveCurrent({ receipt: pending.receipt })).rejects.toThrow(/promotion_/);
});

test('does not allow pending payload hints to substitute for native transcript ownership', async () => {
  writeFileSync(
    source,
    JSON.stringify({
      type: 'user',
      sessionId: randomUUID(),
      version: '2.1.318',
      timestamp: pending.recordedAt
    }) + '\n'
  );
  await expect(provider().receivePending(pending)).rejects.toThrow('claude_source_version_unobserved');
});

test.each(['generation', 'projection'] as const)('%s drift at source open prevents every subsequent native transcript byte', async change => {
  const p = provider();
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  const sourceDescriptors = new Set<number>();
  vi.mocked(fs.openSync).mockImplementation((path, flags, mode) => {
    const fd = actual.openSync(path, flags, mode);
    if (path === source) {
      sourceDescriptors.add(fd);
      vi.mocked(fs.readSync).mockClear();
      if (change === 'generation') generation++;
      else projectionDigest = 'b'.repeat(64);
    }
    return fd;
  });
  vi.mocked(fs.readSync).mockClear();
  await expect(p.receivePending(pending)).rejects.toThrow(/promotion_/);
  expect(sourceDescriptors.size).toBe(1);
  expect(vi.mocked(fs.readSync).mock.calls.filter(args => sourceDescriptors.has(args[0]))).toEqual([]);
});
