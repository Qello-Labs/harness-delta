import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { CodexSessionBindingProvider } from '../src/session-binding-codex.js';
import type { PromotionBindingAuthority, PromotionPendingReceipt } from '../src/session-binding-contract.js';
import { toolVersionPromotionProjection } from '../src/core/tool-version-profiles.js';
import { projectToolVersionPromotions } from '../src/core/tool-version-promotion.js';
import { appendPromotionDecision, promotionFixture } from './helpers/tool-version-promotion.js';
import type { CandidateScope } from '../src/nested-candidate.js';

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    openSync: vi.fn(actual.openSync),
    realpathSync: vi.fn(actual.realpathSync),
    readSync: vi.fn(actual.readSync)
  };
});

const at = '2026-11-09T12:00:00.000Z';
const shipped = toolVersionPromotionProjection.facets;
let root: string;
let synthetic: ReturnType<typeof promotionFixture>;
beforeEach(() => {
  synthetic = promotionFixture('codex');
  for (const operation of ['collect', 'link', 'restart'] as const) {
    appendPromotionDecision(synthetic, {
      scope: {
        target: { version: '0.169.0', commit: 'a'.repeat(40) },
        lane: {
          product: 'codex',
          route: 'codex_binding',
          profile_id: 'codex-binding-01690-direct-family-v1',
          operation,
          topology: 'root'
        },
        platform: 'darwin_arm64',
        runtime: Number(process.versions.node.split('.')[0]) === 24 ? 'node24' : 'node26'
      }
    });
  }
  Object.defineProperty(toolVersionPromotionProjection, 'facets', {
    configurable: true,
    get: () => projectToolVersionPromotions(synthetic).facets
  });
  root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'codex-pending-synthetic-')));
  fs.mkdirSync(join(root, 'receipts'), { mode: 0o700 });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(fs.openSync).mockClear();
  vi.mocked(fs.realpathSync).mockClear();
  vi.mocked(fs.readSync).mockReset();
  Object.defineProperty(toolVersionPromotionProjection, 'facets', {
    configurable: true,
    value: shipped
  });
  fs.rmSync(root, { recursive: true, force: true });
});

function fixture(family = false) {
  if (family) {
    const rootGrant = synthetic.ledger.records.find(record => record.decision.scope.lane.operation === 'collect');
    if (!rootGrant) throw new Error('synthetic_grant_required');
    appendPromotionDecision(synthetic, {
      scope: {
        ...rootGrant.decision.scope,
        lane: {
          ...rootGrant.decision.scope.lane,
          topology: 'bounded_family'
        }
      },
      requested_grants: ['admission', 'children'],
      grants: ['admission', 'children']
    });
  }
  let denied = false;
  let generation = 0;
  let projectionDigest = 'b'.repeat(64);
  const authority: PromotionBindingAuthority = {
    key: {
      product: 'codex',
      productVersion: '0.169.0',
      source: 'codex_binding',
      profileId: 'codex-binding-01690-direct-family-v1',
      operation: 'collect',
      topology: family ? 'bounded_family' : 'root',
      descriptorLineage: 'a'.repeat(40),
      platform: 'darwin_arm64',
      runtime: Number(process.versions.node.split('.')[0]) === 24 ? 'node24' : 'node26'
    },
    producerContract: 'promoted-payload-v1',
    grants: family ? ['admission', 'children'] : ['admission'],
    assertAuthorized: () => {
      if (denied) throw new Error('binding_scope_revoked');
      return {
        state: 'allowed',
        generation,
        projectionDigest,
        denialIds: []
      };
    }
  };
  const options = {
    receiptDirectory: join(root, 'receipts'),
    sourceRoots: [root],
    projectRoot: root,
    productVersion: '0.169.0',
    ordinaryFamilyAdmission: true,
    maxDepth: family ? 1 : 0,
    maxFamilyMembers: family ? 3 : 1,
    clock: () => at,
    promotionAuthority: authority
  };
  const sourceRef = join(root, 'root.jsonl');
  const header = {
    type: 'session_meta',
    payload: {
      id: 'root',
      session_id: 'root',
      cli_version: '0.169.0',
      cwd: root,
      source: 'cli'
    }
  };
  fs.writeFileSync(sourceRef, `${JSON.stringify(header)}\n`);
  const pending: PromotionPendingReceipt = {
    schemaVersion: 3,
    kind: 'promotion_pending',
    producerContract: 'promoted-payload-v1',
    receipt: randomUUID(),
    product: 'codex',
    productVersion: '0.169.0',
    event: 'connect',
    nativeSessionId: 'root',
    nativeRootSessionId: 'root',
    agentId: null,
    sourceRef,
    cwd: root,
    processIdHint: 4242,
    recordedAt: at
  };
  fs.writeFileSync(join(options.receiptDirectory, `${pending.receipt}.json`), JSON.stringify(pending), { mode: 0o600 });
  return {
    options,
    pending,
    header,
    sourceRef,
    provider: () => new CodexSessionBindingProvider(options),
    deny: () => {
      denied = true;
    },
    changeGeneration: () => {
      generation++;
    },
    changeProjection: () => {
      projectionDigest = 'c'.repeat(64);
    }
  };
}
const scope: CandidateScope = {
  projectId: 'synthetic-project',
  taskId: 'synthetic-task',
  allowedRootTurnIds: ['turn'],
  sessions: [
    {
      sessionId: 'root',
      sourceId: 'root',
      nativeSessionId: 'root',
      rootSessionId: 'root',
      parentSessionId: null,
      product: 'codex',
      processId: null,
      agentId: null
    }
  ]
};

test('promoted Codex requires live authority before constructor native paths', () => {
  const f = fixture();
  const { promotionAuthority: _authority, ...options } = f.options;
  void _authority;
  vi.mocked(fs.realpathSync).mockClear();
  expect(() => new CodexSessionBindingProvider(options)).toThrow('promoted_provider_unavailable');
  expect(fs.realpathSync).not.toHaveBeenCalled();
  f.deny();
  expect(() => f.provider()).toThrow('binding_scope_revoked');
  expect(fs.realpathSync).not.toHaveBeenCalled();
});

test.each(['generation', 'projection'] as const)('%s drift during constructor path resolution prevents the next native path', async change => {
  const f = fixture();
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  vi.mocked(fs.realpathSync).mockClear();
  vi.mocked(fs.realpathSync).mockImplementation(path => {
    const resolved = actual.realpathSync(path);
    if (path === f.options.receiptDirectory) {
      if (change === 'generation') f.changeGeneration();
      else f.changeProjection();
    }
    return resolved;
  });
  expect(() => f.provider()).toThrow('binding_scope_revoked');
  expect(vi.mocked(fs.realpathSync).mock.calls.map(args => args[0])).toEqual([f.options.receiptDirectory]);
});

test.each(['generation', 'projection'] as const)('%s drift during the final constructor directory stat refuses construction', async change => {
  const f = fixture();
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  let changed = false;
  vi.spyOn(fs, 'lstatSync').mockImplementation(path => {
    const stat = actual.lstatSync(path);
    if (!changed && path === f.options.receiptDirectory) {
      changed = true;
      if (change === 'generation') f.changeGeneration();
      else f.changeProjection();
    }
    return stat;
  });
  expect(() => f.provider()).toThrow('binding_scope_revoked');
  expect(changed).toBe(true);
});

test('schema-3 native root proof supports resolution revalidation and usage without a legacy receipt', async () => {
  const f = fixture();
  const provider = f.provider();
  const receipt = provider.pendingPromotionReceipt({
    receipt: f.pending.receipt
  });
  const result = await provider.receivePending(receipt);
  const stat = fs.statSync(f.sourceRef);
  expect(result.identity).toMatchObject({
    sessionId: 'root',
    parentSessionId: null,
    sourceIdentity: `${stat.dev}:${stat.ino}`,
    identityEvidenceId: receipt.receipt
  });
  expect(result.proof).toMatchObject({
    receipt: receipt.receipt,
    nativeSessionId: 'root',
    sourceRef: f.sourceRef,
    sourceIdentity: `${stat.dev}:${stat.ino}`,
    productVersion: '0.169.0',
    processId: ''
  });
  expect(await provider.resolveCurrent({ receipt: receipt.receipt })).toEqual(result.identity);
  if (!provider.inspectCurrent) {
    throw new Error('promoted_inspection_required');
  }
  expect(await provider.inspectCurrent({ receipt: receipt.receipt })).toEqual(result.proof);
  const revalidate = provider.revalidateBound;
  if (!revalidate) throw new Error('promoted_restart_required');
  expect(await revalidate({ receipt: receipt.receipt }, result.identity)).toEqual(result.identity);
  const batch = await provider.readUsage(result.identity, null, scope);
  expect(batch.records).toEqual([]);
  expect(fs.readdirSync(f.options.receiptDirectory).filter(name => name.endsWith('.json'))).toEqual([receipt.receipt + '.json']);
});

test.each([
  { schemaVersion: 1 },
  { producerContract: 'wrong-contract' },
  { product: 'claude_code' },
  { productVersion: '0.168.0' },
  { sourceRef: null },
  { nativeRootSessionId: 'different-root' },
  { event: 'subagent_start', nativeSessionId: 'child', agentId: 'child' },
  { event: 'subagent_stop', nativeSessionId: 'child', agentId: 'child' },
  { extra: 'unknown' }
])('pending receipt %j refuses before native header access', async invalid => {
  const f = fixture();
  const provider = f.provider();
  vi.mocked(fs.openSync).mockClear();
  await expect(
    Reflect.apply(provider.receivePending.bind(provider), provider, [
      {
        ...f.pending,
        ...invalid
      }
    ])
  ).rejects.toThrow();
  expect(fs.openSync).not.toHaveBeenCalled();
});

test('pending hints do not authenticate a mismatched native header', async () => {
  const f = fixture();
  fs.writeFileSync(
    f.sourceRef,
    JSON.stringify({
      ...f.header,
      payload: { ...f.header.payload, id: 'other' }
    }) + '\n'
  );
  await expect(f.provider().receivePending(f.pending)).rejects.toThrow('binding_scope_mismatch');
});

test.each(['receive', 'resolve', 'inspect', 'pending', 'usage', 'children', 'restart'] as const)(
  'denied %s entry refuses native access even after prior success',
  async entry => {
    const f = fixture();
    const provider = f.provider();
    const { identity } = await provider.receivePending(f.pending);
    f.deny();
    vi.mocked(fs.openSync).mockClear();
    const input = { receipt: f.pending.receipt };
    const action = (): unknown => {
      switch (entry) {
        case 'receive':
          return provider.receivePending(f.pending);
        case 'resolve':
          return provider.resolveCurrent(input);
        case 'inspect':
          if (!provider.inspectCurrent) {
            throw new Error('promoted_inspection_required');
          }
          return provider.inspectCurrent(input);
        case 'pending':
          return provider.pendingPromotionReceipt(input);
        case 'usage':
          return provider.readUsage(identity, null, scope);
        case 'children':
          return provider.discoverChildren(identity);
        case 'restart': {
          if (!provider.revalidateBound) {
            throw new Error('promoted_restart_required');
          }
          return provider.revalidateBound(input, identity);
        }
      }
    };
    await expect(Promise.resolve().then(action)).rejects.toThrow('binding_scope_revoked');
    expect(fs.openSync).not.toHaveBeenCalled();
  }
);

test.each(['deny', 'generation', 'projection'] as const)('authorization %s change across native await refuses proof', async change => {
  const f = fixture();
  const provider = f.provider();
  const pending = provider.receivePending(f.pending);
  if (change === 'deny') f.deny();
  if (change === 'generation') f.changeGeneration();
  if (change === 'projection') f.changeProjection();
  await expect(pending).rejects.toThrow('binding_scope_revoked');
});

test.each(['source', 'receipt'] as const)('revocation during %s open prevents native bytes', async nativeFile => {
  const f = fixture();
  const provider = f.provider();
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  vi.mocked(fs.openSync).mockImplementation((path, flags, mode) => {
    const fd = actual.openSync(path, flags, mode);
    if (path === (nativeFile === 'source' ? f.sourceRef : join(f.options.receiptDirectory, f.pending.receipt + '.json'))) f.deny();
    return fd;
  });
  vi.mocked(fs.readSync).mockClear();
  await expect(provider.receivePending(f.pending)).rejects.toThrow('binding_scope_revoked');
  expect(vi.mocked(fs.readSync).mock.calls.filter(args => nativeFile === 'receipt' || args[1].byteLength === 1)).toEqual([]);
});

test.each(['generation', 'projection'] as const)('%s drift at source open prevents every subsequent native header byte', async change => {
  const f = fixture();
  const provider = f.provider();
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  let changed = false;
  vi.mocked(fs.openSync).mockImplementation((path, flags, mode) => {
    const fd = actual.openSync(path, flags, mode);
    if (!changed && path === f.sourceRef) {
      changed = true;
      if (change === 'generation') f.changeGeneration();
      else f.changeProjection();
    }
    return fd;
  });
  vi.mocked(fs.readSync).mockClear();
  await expect(provider.receivePending(f.pending)).rejects.toThrow('binding_scope_revoked');
  expect(changed).toBe(true);
  expect(vi.mocked(fs.readSync).mock.calls.filter(args => args[1].byteLength === 1)).toEqual([]);
});

test('pending descendants reuse native ancestry checks with an explicit children grant', async () => {
  const f = fixture(true);
  const sourceRef = join(root, 'child.jsonl');
  fs.writeFileSync(
    sourceRef,
    JSON.stringify({
      type: 'session_meta',
      payload: {
        id: 'child',
        session_id: 'root',
        cli_version: '0.169.0',
        cwd: root,
        parent_thread_id: 'root',
        source: {
          subagent: {
            thread_spawn: { parent_thread_id: 'root', depth: 1 }
          }
        }
      }
    }) + '\n'
  );
  const child: PromotionPendingReceipt = {
    ...f.pending,
    receipt: randomUUID(),
    event: 'subagent_start',
    nativeSessionId: 'child',
    agentId: 'child',
    sourceRef
  };
  fs.writeFileSync(join(f.options.receiptDirectory, child.receipt + '.json'), JSON.stringify(child), { mode: 0o600 });
  const provider = f.provider();
  const result = await provider.receivePending(child);
  expect(result.identity).toMatchObject({
    sessionId: 'child',
    parentSessionId: 'root',
    sourceRef
  });
  const parent = await provider.resolveCurrent({
    receipt: f.pending.receipt
  });
  const discovery = await provider.discoverChildren(parent);
  expect(discovery.children.map(row => [row.identity.sessionId, row.parentSessionId])).toEqual([['child', 'root']]);
});

test('promoted usage delivers native own-request counters from pending provenance', async () => {
  const f = fixture();
  const rows = [
    f.header,
    {
      type: 'turn_context',
      timestamp: at,
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
      timestamp: at,
      payload: {
        thread_id: 'root',
        session_id: 'root',
        turn_id: 'turn',
        root_turn_id: 'turn',
        response_id: 'request-1',
        usage: {
          input_tokens: 12,
          cached_input_tokens: 2,
          output_tokens: 3,
          reasoning_output_tokens: 1,
          total_tokens: 15
        }
      }
    }
  ];
  fs.writeFileSync(f.sourceRef, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const provider = f.provider();
  const identity = await provider.resolveCurrent({
    receipt: f.pending.receipt
  });
  const batch = await provider.readUsage(identity, null, scope, {
    baseline: false
  });
  expect(batch.records.map(row => [row.requestId, row.payload.output_total.value])).toEqual([['request-1', 3]]);
});

test.each(['usage', 'inspect', 'restart'] as const)('generation change across %s await refuses results', async entry => {
  const f = fixture();
  const provider = f.provider();
  const { identity } = await provider.receivePending(f.pending);
  let result: Promise<unknown>;
  if (entry === 'usage') {
    result = provider.readUsage(identity, null, scope);
  } else if (entry === 'inspect') {
    if (!provider.inspectCurrent) {
      throw new Error('promoted_inspection_required');
    }
    result = provider.inspectCurrent({ receipt: f.pending.receipt });
  } else {
    if (!provider.revalidateBound) {
      throw new Error('promoted_restart_required');
    }
    result = provider.revalidateBound({ receipt: f.pending.receipt }, identity);
  }
  f.changeGeneration();
  await expect(result).rejects.toThrow('binding_scope_revoked');
});

test('native-root denial rejects pending proof before source metadata', async () => {
  const f = fixture();
  const authority = f.options.promotionAuthority;
  const provider = new CodexSessionBindingProvider({
    ...f.options,
    promotionAuthority: {
      ...authority,
      assertAuthorized: (nativeRootId, operation) => {
        if (nativeRootId === 'root') {
          throw new Error('binding_scope_revoked');
        }
        return authority.assertAuthorized(nativeRootId, operation);
      }
    }
  });
  vi.mocked(fs.openSync).mockClear();
  vi.mocked(fs.realpathSync).mockClear();
  await expect(provider.receivePending(f.pending)).rejects.toThrow('binding_scope_revoked');
  expect(fs.openSync).not.toHaveBeenCalled();
  expect(fs.realpathSync).not.toHaveBeenCalled();
});

test('empty shipped promotion ledger does not admit the synthetic version', () => {
  const f = fixture();
  Object.defineProperty(toolVersionPromotionProjection, 'facets', {
    configurable: true,
    value: shipped
  });
  vi.mocked(fs.realpathSync).mockClear();
  expect(() => f.provider()).toThrow();
  expect(fs.realpathSync).not.toHaveBeenCalled();
});
