import { execFileSync, spawnSync } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import {
  createReadStream,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  statSync,
  type ReadOptions
} from 'node:fs';
import { open as openAsync, readFile as readFileAsync } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  issueClaudeWindowSourceAuthorization,
  issueCodexWindowSourceAuthorization,
  revokeOrdinaryWindowActivation
} from '../src/core/ordinary-window-store.js';
import { OrdinaryWindowConnectionProofSchema, OrdinaryWindowCoverageSchema } from '../src/core/ordinary-window-policy.js';
import { Deletion } from '../src/deletion.js';
import { ClaudeWindowSessionBindingProvider } from '../src/session-binding-claude.js';
import { type OrdinaryWindowReadBoundary, VerifiedSessionIdentitySchema } from '../src/session-binding-contract.js';
import { createClaudeWindowFixture } from './helpers/claude-window-fixture.js';

vi.mock('node:fs', { spy: true });
vi.mock('node:fs/promises', { spy: true });
vi.mock('node:child_process', { spy: true });

type Fixture = ReturnType<typeof createClaudeWindowFixture>;
type Assistant = ReturnType<Fixture['assistant']>;
const fixtures: Fixture[] = [];

beforeEach(() => {
  vi.mocked(execFileSync).mockImplementation(() => {
    throw new Error('real_process_access_forbidden');
  });
  vi.mocked(spawnSync).mockImplementation(() => {
    throw new Error('real_process_access_forbidden');
  });
  vi.spyOn(process, 'kill').mockImplementation(() => {
    throw new Error('real_process_access_forbidden');
  });
});

afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function fixture(product: 'codex' | 'claude_code' = 'claude_code') {
  const f = createClaudeWindowFixture(product);
  fixtures.push(f);
  return f;
}

async function connected() {
  const f = fixture();
  f.activate();
  f.life.start(f.taskId);
  await f.connect();
  f.advance();
  return f;
}

const ioCalls = () => [
  ...[lstatSync, statSync, realpathSync, readdirSync, readlinkSync, openSync, readSync, fstatSync, readFileSync, createReadStream].map(
    operation => vi.mocked(operation).mock.calls.length
  ),
  vi.mocked(openAsync).mock.calls.length,
  vi.mocked(readFileAsync).mock.calls.length,
  vi.mocked(execFileSync).mock.calls.length,
  vi.mocked(spawnSync).mock.calls.length,
  vi.spyOn(process, 'kill').mock.calls.length
];

function metadataAuthorization(f: Fixture) {
  return issueClaudeWindowSourceAuthorization(
    f.store,
    {
      taskId: f.taskId,
      generation: f.life.task(f.taskId).generation,
      clock: f.clock
    },
    'metadata'
  );
}

function providerOptions(f: Fixture) {
  return {
    receiptDirectory: f.receiptDirectory,
    claudeProjectsDirectory: f.claudeProjectsDirectory,
    projectRoot: f.projectRoot,
    clock: f.clock,
    binaryAdapters: f.binary.adapters
  };
}

function reader(
  f: Fixture,
  limits: {
    readonly maxReadBytes?: number;
    readonly maxSourceBytes?: number;
  } = {}
) {
  const row = f.store.get<{
    session_id: string;
    identity: string;
    generation: number;
    revision: number;
    cursor: string | null;
  }>('SELECT b.*,s.revision FROM session_bindings b JOIN binding_root_segments s ON s.root_session_id=b.root_id');
  if (!row) throw new Error('fixture_binding_missing');
  const identity = VerifiedSessionIdentitySchema.parse(JSON.parse(row.identity));
  const authorization = issueClaudeWindowSourceAuthorization(
    f.store,
    {
      taskId: f.taskId,
      rootSessionId: row.session_id,
      generation: row.generation,
      segmentRevision: row.revision,
      cursor: row.cursor,
      clock: f.clock
    },
    'observing'
  );
  const provider = new ClaudeWindowSessionBindingProvider({
    ...providerOptions(f),
    authorization,
    ...limits
  });
  const scope = {
    taskId: f.taskId,
    projectId: f.selection.projectId,
    allowedRootTurnIds: ['binding-observation'],
    sessions: [
      {
        sessionId: row.session_id,
        rootSessionId: row.session_id,
        parentSessionId: null,
        sourceId: identity.sessionId,
        product: 'claude_code' as const,
        nativeSessionId: f.nativeSessionId,
        agentId: null,
        processId: identity.nativeMapping?.processId ?? null
      }
    ]
  };
  return {
    provider,
    identity,
    read: (
      boundary: OrdinaryWindowReadBoundary = {
        baseline: false,
        authorizeSource: () => {
          authorization();
        }
      }
    ) => provider.readWindowUsage(identity, row.cursor, scope, boundary),
    authorization
  };
}

test('requires an explicitly active prepared task and activation before receipt or native operations', async () => {
  const f = fixture();
  const before = ioCalls();

  await expect(f.connect()).rejects.toThrow();
  expect(f.life.state(f.taskId)).toBe('registered');
  f.life.start(f.taskId);
  await expect(f.connect()).rejects.toThrow('binding_window_activation_required');

  expect(ioCalls()).toEqual(before);
  expect(f.binary.operations).toEqual([]);
  expect(f.store.all('SELECT * FROM sessions')).toEqual([]);
  f.activate();
  await expect(f.connect()).resolves.toMatchObject({
    automatic_children: false
  });
});

test.each(['missing', 'forged', 'revoked', 'wrong-product'] as const)('rejects %s source authority before any receipt, source or native operation', kind => {
  const f = fixture(kind === 'wrong-product' ? 'codex' : 'claude_code');
  f.activate();
  f.life.start(f.taskId);
  const scope = {
    taskId: f.taskId,
    generation: f.life.task(f.taskId).generation,
    clock: f.clock
  };
  const authorization = kind === 'wrong-product' ? issueCodexWindowSourceAuthorization(f.store, scope, 'metadata') : metadataAuthorization(f);
  const context = authorization();
  if (kind === 'revoked') {
    revokeOrdinaryWindowActivation(f.store, f.taskId, f.clock());
  }
  const supplied = kind === 'missing' ? undefined : kind === 'forged' ? () => context : authorization;
  const before = ioCalls();

  expect(() => {
    Reflect.construct(ClaudeWindowSessionBindingProvider, [
      {
        ...providerOptions(f),
        authorization: supplied
      }
    ]);
  }).toThrow();

  expect(ioCalls()).toEqual(before);
  expect(f.binary.operations).toEqual([]);
});

test('records scoped source version and publisher local pin without upgrading ownership or child evidence', async () => {
  const f = await connected();
  const row = f.store.get<{ proof: string }>('SELECT proof FROM ordinary_window_segments');
  const proof = OrdinaryWindowConnectionProofSchema.parse(JSON.parse(row?.proof ?? 'null'));

  expect(proof).toMatchObject({
    mode: 'claude_publisher_local_pin',
    product: 'claude_code',
    productVersion: '2.1.318',
    sourceVersionBasis: 'scoped_source',
    publisherProof: 'verified_disk_assets',
    mappedImageProof: 'unverified',
    rootOwnership: 'unverified',
    possibleChildContribution: 'unknown'
  });
  expect(proof.nativePinDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(f.store.all<{ payload: string }>('SELECT payload FROM session_source_compatibility').map((value): unknown => JSON.parse(value.payload))).toEqual([
    expect.objectContaining({
      product: 'claude_code',
      product_version: '2.1.318',
      state: 'compatibility_unverified',
      source: 'claude_binding'
    })
  ]);
  expect(vi.mocked(execFileSync).mock.calls).toEqual([]);
  expect(vi.mocked(spawnSync).mock.calls).toEqual([]);
  expect(vi.spyOn(process, 'kill').mock.calls).toEqual([]);
});

test('holds null stop_reason across quiet, user and tool rows until the same message and request explicitly terminate', async () => {
  const f = await connected();
  const terminal = f.assistant('independent-request', {
    input_tokens: 19,
    cache_creation_input_tokens: 4,
    cache_read_input_tokens: 6,
    output_tokens: 9
  });
  f.append([
    {
      ...terminal,
      message: { ...terminal.message, stop_reason: null }
    }
  ]);
  await f.collect();
  f.advance(86400000);
  f.append([
    f.user(),
    {
      type: 'tool_result',
      sessionId: f.nativeSessionId,
      timestamp: f.clock()
    }
  ]);
  await f.collect();
  expect(f.payloads()).toEqual([]);
  expect(f.store.all('SELECT * FROM binding_requests')).toEqual([]);

  f.append([terminal]);
  await f.collect();

  expect(f.payloads()).toEqual([
    expect.objectContaining({
      product_version: '2.1.318',
      input_total: { status: 'observed', value: 29, reason: null },
      cached_input: { status: 'observed', value: 6, reason: null },
      output_total: { status: 'observed', value: 9, reason: null }
    })
  ]);
  expect(f.store.all('SELECT * FROM binding_requests')).toHaveLength(1);
});

test('an empty root and eventless user or tool activity never manufacture observed zero usage', async () => {
  const f = await connected();
  f.advance(86400000);
  f.append([
    f.user(),
    {
      type: 'tool_result',
      sessionId: f.nativeSessionId,
      timestamp: f.clock()
    }
  ]);

  await f.collect();

  expect(f.payloads()).toEqual([]);
  expect(f.store.all('SELECT * FROM binding_requests')).toEqual([]);
  expect(f.coverage()).toMatchObject({
    status: 'missing',
    detectionCompleteness: 'unknown'
  });
});

const invalidRows: readonly {
  readonly label: string;
  readonly change: (row: Assistant) => unknown;
}[] = [
  {
    label: 'missing request ID',
    change: row => ({ ...row, requestId: undefined })
  },
  {
    label: 'missing message ID',
    change: row => ({
      ...row,
      message: { ...row.message, id: undefined }
    })
  },
  {
    label: 'missing terminal marker',
    change: row => ({
      ...row,
      message: { ...row.message, stop_reason: undefined }
    })
  },
  {
    label: 'unknown terminal marker',
    change: row => ({
      ...row,
      message: { ...row.message, stop_reason: 'synthetic_unknown' }
    })
  },
  {
    label: 'missing input counter',
    change: row => ({
      ...row,
      message: {
        ...row.message,
        usage: { ...row.message.usage, input_tokens: undefined }
      }
    })
  },
  {
    label: 'missing cache creation counter',
    change: row => ({
      ...row,
      message: {
        ...row.message,
        usage: {
          ...row.message.usage,
          cache_creation_input_tokens: undefined
        }
      }
    })
  },
  {
    label: 'missing cache read counter',
    change: row => ({
      ...row,
      message: {
        ...row.message,
        usage: {
          ...row.message.usage,
          cache_read_input_tokens: undefined
        }
      }
    })
  },
  {
    label: 'missing output counter',
    change: row => ({
      ...row,
      message: {
        ...row.message,
        usage: { ...row.message.usage, output_tokens: undefined }
      }
    })
  },
  {
    label: 'negative counter',
    change: row => ({
      ...row,
      message: {
        ...row.message,
        usage: { ...row.message.usage, output_tokens: -1 }
      }
    })
  },
  {
    label: 'unsafe counter',
    change: row => ({
      ...row,
      message: {
        ...row.message,
        usage: {
          ...row.message.usage,
          input_tokens: Number.MAX_SAFE_INTEGER + 1
        }
      }
    })
  },
  {
    label: 'missing native session',
    change: row => ({ ...row, sessionId: undefined })
  },
  {
    label: 'foreign native session',
    change: row => ({
      ...row,
      sessionId: '11111111-1111-4111-8111-111111111111'
    })
  },
  {
    label: 'source version mismatch',
    change: row => ({ ...row, version: '2.1.317' })
  },
  {
    label: 'root ownership contradiction',
    change: row => ({ ...row, isSidechain: true })
  },
  {
    label: 'child ownership contradiction',
    change: row => ({ ...row, agentId: 'unexpected-child' })
  },
  {
    label: 'compact history',
    change: row => ({
      ...row,
      type: 'system',
      subtype: 'compact_boundary'
    })
  },
  {
    label: 'retained history',
    change: row => ({ ...row, type: 'summary', isCompactSummary: true })
  }
];

function expectRejectedWithoutUsage(
  f: Fixture,
  before: ReturnType<Fixture['usageState']>,
  reason: 'compatibility_invalidated' | 'binding_scope_revoked' = 'compatibility_invalidated'
) {
  expect(f.usageState()).toEqual({
    ...before,
    coverage: before.coverage.map(row => ({
      ...row,
      coverage: JSON.stringify({
        ...OrdinaryWindowCoverageSchema.parse(JSON.parse(String(row.coverage))),
        status: reason === 'compatibility_invalidated' ? 'invalidated' : 'partial',
        reason
      })
    }))
  });
}

test.each(invalidRows)('rejects a whole mixed read containing $label without committing usage state', async ({ change }) => {
  const f = await connected();
  f.append([f.assistant('valid-before-invalid'), change(f.assistant('invalid'))]);
  const before = f.usageState();

  await expect(f.collect()).rejects.toThrow();

  expectRejectedWithoutUsage(f, before);
});

test('invalid mixed baseline commits no events, replay IDs, exclusions, compatibility provenance, evidence or cursor', async () => {
  const f = fixture();
  f.activate();
  f.life.start(f.taskId);
  f.append([f.assistant('valid-baseline'), f.assistant('invalid-baseline', { output_tokens: -1 })]);

  await expect(f.connect()).rejects.toThrow();

  const state = f.usageState();
  expect({
    events: state.events,
    requests: state.requests,
    exclusions: state.exclusions,
    provenance: state.provenance,
    evidence: state.evidence,
    cursors: state.cursors
  }).toEqual({
    events: [],
    requests: [],
    exclusions: [],
    provenance: [],
    evidence: [],
    cursors: [{ cursor: null }]
  });
});

test.each(['request-to-message', 'message-to-request'] as const)('rejects changed %s correlation across separate reads', async mapping => {
  const f = await connected();
  const pending = f.assistant('correlated-request');
  f.append([
    {
      ...pending,
      message: { ...pending.message, stop_reason: null }
    }
  ]);
  await f.collect();
  const conflicting =
    mapping === 'request-to-message'
      ? {
          ...pending,
          message: { ...pending.message, id: 'different-message' }
        }
      : { ...pending, requestId: 'different-request' };
  f.append([f.assistant('valid-before-conflict'), conflicting]);
  const before = f.usageState();

  await expect(f.collect()).rejects.toThrow();

  expectRejectedWithoutUsage(f, before);
});

test('rejects conflicting terminal counters across reads without committing preceding valid usage', async () => {
  const f = await connected();
  f.append([f.assistant('existing-request')]);
  await f.collect();
  f.advance();
  f.append([f.assistant('new-request'), f.assistant('existing-request', { output_tokens: 6 })]);
  const before = f.usageState();

  await expect(f.collect()).rejects.toThrow();

  expectRejectedWithoutUsage(f, before);
});

test('excludes baseline and late terminal requests durably while deduplicating live replay', async () => {
  const f = fixture();
  f.activate();
  f.life.start(f.taskId);
  const old = f.assistant('baseline-pending');
  f.append([{ ...old, message: { ...old.message, stop_reason: null } }]);
  await f.connect();
  expect(f.store.all('SELECT * FROM binding_baseline_exclusions')).toHaveLength(1);
  f.advance();
  const live = f.assistant('live-request');
  f.append([old, live]);
  await f.collect();
  const before = f.usageState();

  f.append([live]);
  await f.collect();

  expect(f.payloads()).toEqual([
    expect.objectContaining({
      input_total: { status: 'observed', value: 21, reason: null },
      cached_input: { status: 'observed', value: 7, reason: null },
      output_total: { status: 'observed', value: 5, reason: null }
    })
  ]);
  expect(f.usageState().events).toEqual(before.events);
  expect(f.usageState().requests).toEqual(before.requests);
  expect(f.usageState().exclusions).toEqual(before.exclusions);
});

test('stages no caller baseline ledger additions until the entire bounded snapshot validates', async () => {
  const f = await connected();
  f.append([f.assistant('valid-ledger-request'), f.assistant('invalid-ledger-request', { input_tokens: -1 })]);
  const source = reader(f, { maxReadBytes: 128, maxSourceBytes: 65536 });
  const additions: string[] = [];

  await expect(
    source.read({
      baseline: true,
      authorizeSource: () => {
        source.authorization();
      },
      baselineLedger: {
        has: id => additions.includes(id),
        add: id => {
          additions.push(id);
        },
        addMany: ids => {
          additions.push(...ids);
        }
      }
    })
  ).rejects.toThrow();

  expect(additions).toEqual([]);
});

test('rejects correlation conflicts spanning bounded read chunks rather than returning a valid prefix', async () => {
  const f = await connected();
  const row = f.assistant('chunk-request');
  f.append([
    row,
    ...Array.from({ length: 20 }, () => f.user()),
    {
      ...row,
      message: { ...row.message, id: 'conflicting-chunk-message' }
    }
  ]);
  const source = reader(f, { maxReadBytes: 128, maxSourceBytes: 65536 });
  const before = f.usageState();

  await expect(source.read()).rejects.toThrow();

  expect(f.usageState()).toEqual(before);
});

test('refuses source byte overflow without reporting the valid prefix or advancing durable state', async () => {
  const f = await connected();
  f.append([f.assistant('prefix-request'), ...Array.from({ length: 20 }, () => f.user())]);
  const source = reader(f, { maxReadBytes: 128, maxSourceBytes: 1024 });
  const before = f.usageState();

  await expect(source.read()).rejects.toThrow();

  expect(f.usageState()).toEqual(before);
});

test('records child presence as metadata only and never opens a child body or enrolls child usage', async () => {
  const f = await connected();
  const childPath = join(f.projectDirectory, f.nativeSessionId, 'subagents', 'agent-child-one.jsonl');
  const firstSeenAt = f.clock();
  f.emit({
    event: 'subagent_start',
    agentId: 'child-one',
    sourceRef: childPath
  });
  f.advance();
  f.emit({
    event: 'subagent_stop',
    agentId: 'child-one',
    sourceRef: childPath
  });
  const nativeSync = await vi.importActual<typeof import('node:fs')>('node:fs');
  const nativeAsync = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  let childOpens = 0;
  vi.mocked(openSync).mockImplementation((path, flags, mode) => {
    if (path === childPath) {
      childOpens++;
      throw new Error('child_body_access_forbidden');
    }
    return nativeSync.openSync(path, flags, mode);
  });
  vi.mocked(openAsync).mockImplementation((path, flags, mode) => {
    if (path === childPath) {
      childOpens++;
      throw new Error('child_body_access_forbidden');
    }
    return nativeAsync.open(path, flags, mode);
  });
  const root = reader(f);

  await f.collect();

  expect(childOpens).toBe(0);
  for (const operation of [readFileSync, createReadStream]) {
    expect(vi.mocked(operation).mock.calls.filter(([path]) => path === childPath)).toEqual([]);
  }
  expect(vi.mocked(readFileAsync).mock.calls.filter(([path]) => path === childPath)).toEqual([]);
  expect(f.coverage()).toMatchObject({
    rootOwnership: 'unverified',
    possibleChildContribution: 'unknown',
    detectionCompleteness: 'unknown',
    childrenStatus: 'unobserved'
  });
  expect(f.coverage().detectedChildren).toEqual([
    expect.objectContaining({
      firstSeenAt,
      basis: 'root_linked_receipt',
      parentRelation: 'unverified',
      usage: null,
      cost: null
    })
  ]);
  expect(f.store.all('SELECT * FROM session_bindings')).toHaveLength(1);
  expect(f.payloads()).toEqual([]);
  const refreshed = reader(f);
  await expect(refreshed.provider.discoverChildren(root.identity)).resolves.toMatchObject({ children: [] });
});

test('rejects a substituted discovery source before any filesystem or native operation', async () => {
  const f = await connected();
  const source = reader(f);
  const before = ioCalls();
  const native = [...f.binary.operations];

  await expect(source.provider.discoverChildren({ ...source.identity, sourceRef: '/outside/unauthorized/root.jsonl' })).rejects.toThrow(
    'binding_scope_mismatch'
  );

  expect(ioCalls()).toEqual(before);
  expect(f.binary.operations).toEqual(native);
});

test.each(
  (['same-batch', 'child-first', 'later-read'] as const).flatMap(timing => (['request', 'message', 'owner'] as const).map(conflict => ({ timing, conflict })))
)('rejects child-marked $conflict correlation and owner conflicts in $timing atomically', async ({ timing, conflict }) => {
  const f = await connected();
  const root = f.assistant('root-request');
  const child = {
    ...root,
    requestId: conflict === 'message' ? 'child-request' : root.requestId,
    message: conflict === 'request' ? { ...root.message, id: 'child-message' } : root.message,
    agentId: 'child-one',
    isSidechain: true
  };
  if (timing === 'later-read') {
    f.append([root]);
    await f.collect();
    f.append([f.assistant('valid-before-child-conflict'), child]);
  } else {
    f.append([f.assistant('valid-before-child-conflict'), ...(timing === 'child-first' ? [child, root] : [root, child])]);
  }
  const before = f.usageState();

  await expect(f.collect()).rejects.toThrow('binding_request_conflict');

  expectRejectedWithoutUsage(f, before);
});

test('accepts nonconflicting child metadata rows without counting their usage', async () => {
  const f = await connected();
  f.append([{ ...f.assistant('child-only'), agentId: 'child-one', isSidechain: true }, f.assistant('root-only')]);

  await f.collect();

  expect(f.payloads()).toHaveLength(1);
  expect(f.store.all('SELECT * FROM binding_requests')).toHaveLength(1);
});

test('ignores well-formed earlier-task receipts for unrelated roots during baseline and collection', async () => {
  const f = fixture();
  f.emit({
    nativeSessionId: '11111111-1111-4111-8111-111111111111',
    nativeRootSessionId: '11111111-1111-4111-8111-111111111111',
    event: 'subagent_start',
    agentId: 'earlier-child',
    recordedAt: new Date(Date.parse(f.selection.preparedAt) - 1000).toISOString()
  });
  f.activate();
  f.life.start(f.taskId);
  await expect(f.connect()).resolves.toMatchObject({ automatic_children: false });
  f.advance();
  f.append([f.assistant('current-root')]);

  await f.collect();

  expect(f.payloads()).toHaveLength(1);
  expect(f.coverage().detectedChildren).toEqual([]);
});

test('still rejects an earlier-task receipt when it is selected for connection', async () => {
  const f = fixture();
  const stale = f.emit({ recordedAt: new Date(Date.parse(f.selection.preparedAt) - 1000).toISOString() });
  f.activate();
  f.life.start(f.taskId);

  await expect(f.connect(stale.receipt)).rejects.toThrow('binding_receipt_stale');

  expect(f.binary.operations).toEqual([]);
  expect(f.store.all('SELECT * FROM sessions')).toEqual([]);
});

async function holdSource(f: Fixture) {
  const native = await vi.importActual<typeof import('node:fs')>('node:fs');
  const gates = new EventEmitter();
  const entered = once(gates, 'entered', {
    signal: AbortSignal.timeout(2000)
  });
  const released = once(gates, 'release', {
    signal: AbortSignal.timeout(5000)
  });
  const sourceDescriptors = new Set<number>();
  vi.mocked(openSync).mockImplementation((path, flags, mode) => {
    const fd = native.openSync(path, flags, mode);
    if (path === f.sourcePath) sourceDescriptors.add(fd);
    return fd;
  });
  const reads = vi.fn();
  vi.mocked(readSync).mockImplementation(
    (fd: number, buffer: NodeJS.ArrayBufferView, offset?: number | ReadOptions, length?: number, position?: number | null) => {
      if (sourceDescriptors.has(fd)) reads();
      if (typeof offset === 'number') {
        if (length === undefined) throw new Error('fixture_read_length_missing');
        return native.readSync(fd, buffer, offset, length, position ?? null);
      }
      return native.readSync(fd, buffer, offset);
    }
  );
  const provider = reader(f).provider;
  const original = provider.revalidateBound.bind(provider);
  vi.spyOn(ClaudeWindowSessionBindingProvider.prototype, 'revalidateBound').mockImplementationOnce(async (input, expected) => {
    expect(expected.sourceRef).toBe(f.sourcePath);
    gates.emit('entered');
    await released;
    return original(input, expected);
  });
  return { entered, reads, release: () => gates.emit('release') };
}

test.each(['pause', 'generation', 'delete', 'revoke'] as const)(
  'rejects commit and every further read after %s while provider revalidation is pending',
  async transition => {
    const f = await connected();
    f.append([f.assistant('must-not-commit')]);
    const gate = await holdSource(f);
    const running = f.collect();
    const rejection = expect(running).rejects.toThrow();
    try {
      await Promise.race([
        gate.entered,
        running.then(() => {
          throw new Error('fixture_source_open_not_observed');
        })
      ]);
      switch (transition) {
        case 'pause':
          f.life.pause(f.taskId);
          break;
        case 'generation':
          f.life.pause(f.taskId);
          f.life.resume(f.taskId);
          break;
        case 'delete':
          new Deletion(f.store, f.clock).deleteTask(f.taskId);
          break;
        case 'revoke':
          revokeOrdinaryWindowActivation(f.store, f.taskId, f.clock());
          break;
      }
      const state = f.usageState();
      const io = ioCalls();
      const native = [...f.binary.operations];
      gate.release();
      await rejection;

      expect(gate.reads).not.toHaveBeenCalled();
      expect(ioCalls()).toEqual(io);
      expect(f.binary.operations).toEqual(native);
      expect(f.usageState()).toEqual(state);
      await expect(f.collect()).rejects.toThrow();
      expect(ioCalls()).toEqual(io);
      expect(f.binary.operations).toEqual(native);
    } finally {
      gate.release();
      await running.then(
        () => undefined,
        () => undefined
      );
    }
  }
);

test.each(['pid', 'start', 'pin'] as const)('rejects %s drift while provider revalidation is pending without committing usage', async drift => {
  const f = await connected();
  f.append([f.assistant('must-not-survive-drift')]);
  const gate = await holdSource(f);
  const running = f.collect();
  const rejection = expect(running).rejects.toThrow();
  try {
    await Promise.race([
      gate.entered,
      running.then(() => {
        throw new Error('fixture_source_open_not_observed');
      })
    ]);
    switch (drift) {
      case 'pid':
        f.binary.state.pid++;
        break;
      case 'start':
        f.binary.state.start = 'reused-pid-start';
        break;
      case 'pin':
        f.binary.state.inode++;
        break;
    }
    const before = f.usageState();
    gate.release();
    await rejection;

    expect(gate.reads).not.toHaveBeenCalled();
    expectRejectedWithoutUsage(f, before, 'binding_scope_revoked');
    const io = ioCalls();
    const native = [...f.binary.operations];
    await expect(f.collect()).rejects.toThrow();
    expect(ioCalls()).toEqual(io);
    expect(f.binary.operations).toEqual(native);
  } finally {
    gate.release();
    await running.then(
      () => undefined,
      () => undefined
    );
  }
});
