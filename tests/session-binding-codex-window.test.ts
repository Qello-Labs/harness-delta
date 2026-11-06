import { appendFileSync, chmodSync, createReadStream, linkSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { open as openAsync, readFile as readFileAsync } from 'node:fs/promises';
import { EventEmitter, once } from 'node:events';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { OrdinaryWindowConnectionProofSchema, OrdinaryWindowCoverageSchema } from '../src/core/ordinary-window-policy.js';
import { issueCodexWindowSourceAuthorization } from '../src/core/ordinary-window-store.js';
import { VerifiedSessionIdentitySchema } from '../src/session-binding-contract.js';
import { CodexWindowSessionBindingProvider } from '../src/session-binding-codex.js';
import { codexWindowJsonl, createCodexWindowProviderFixture } from './helpers/codex-window-provider-fixture.js';

vi.mock('node:fs', { spy: true });
vi.mock('node:fs/promises', { spy: true });

test('refuses concurrent ordinary collection until the actual initial baseline commits its cursor', async () => {
  const f = await fixture();
  f.appendResponse('pre-baseline-response');
  f.lifecycle.start(f.taskId);
  const native = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const gates = new EventEmitter();
  const entered = once(gates, 'entered');
  const release = once(gates, 'release');
  vi.mocked(openAsync).mockImplementationOnce(async (...args) => {
    gates.emit('entered');
    await release;
    return native.open(...args);
  });
  const connecting = f.connect();
  try {
    await Promise.race([
      entered,
      connecting.then(() => {
        throw new Error('fixture_baseline_open_not_observed');
      })
    ]);
    const row = f.store.get<{
      session_id: string;
      identity: string;
      generation: number;
      revision: number;
      cursor: string | null;
    }>('SELECT b.*,s.revision FROM session_bindings b JOIN binding_root_segments s ON s.root_session_id=b.root_id');
    if (!row) throw new Error('fixture_real_binding_missing');
    expect(row.cursor).toBeNull();
    const identity = VerifiedSessionIdentitySchema.parse(JSON.parse(row.identity));
    const scope = {
      taskId: f.taskId,
      rootSessionId: row.session_id,
      generation: row.generation,
      segmentRevision: row.revision,
      cursor: row.cursor
    };
    const authorization = issueCodexWindowSourceAuthorization(f.store, scope, 'observing');
    const provider = new CodexWindowSessionBindingProvider({
      authorization,
      receiptDirectory: f.receiptDirectory,
      sourceRoots: f.sourceRoots,
      projectRoot: f.projectRoot,
      clock: f.clock
    });
    const before = usageState(f);
    const opens = vi.mocked(openAsync).mock.calls.length;
    await expect(
      provider.readWindowUsage(
        identity,
        null,
        {
          taskId: f.taskId,
          projectId: f.selection.projectId,
          allowedRootTurnIds: ['binding-observation'],
          sessions: [
            {
              sessionId: row.session_id,
              rootSessionId: row.session_id,
              parentSessionId: null,
              sourceId: identity.sessionId,
              product: 'codex',
              nativeSessionId: identity.sessionId,
              agentId: null,
              processId: null
            }
          ]
        },
        {
          baseline: false,
          authorizeSource: () => {
            authorization();
          }
        }
      )
    ).rejects.toThrow('binding_fresh_root_required');
    expect(vi.mocked(openAsync).mock.calls).toHaveLength(opens);
    expect(usageState(f)).toEqual(before);
  } finally {
    gates.emit('release');
    await connecting;
  }
  expect(payloads(f)).toEqual([]);
  expect(usageState(f).exclusions).toHaveLength(1);
  f.advance();
  f.appendResponse('post-baseline-response');
  await f.collect();
  expect(payloads(f)).toHaveLength(1);
}, 10000);

type Fixture = Awaited<ReturnType<typeof createCodexWindowProviderFixture>>;
const fixtures: Fixture[] = [];
async function fixture(version = '0.167.0', activate = true) {
  const value = await createCodexWindowProviderFixture({ version, activate });
  fixtures.push(value);
  return value;
}
afterEach(() => {
  for (const value of fixtures.splice(0)) value.cleanup();
  vi.clearAllMocks();
});
async function connected() {
  const value = await fixture();
  value.lifecycle.start(value.taskId);
  await value.connect();
  value.advance();
  return value;
}
const usageState = (f: Fixture) => ({
  events: f.store.all('SELECT * FROM events'),
  requests: f.store.all('SELECT * FROM binding_requests'),
  exclusions: f.store.all('SELECT * FROM binding_baseline_exclusions'),
  pins: f.store.all('SELECT * FROM session_source_compatibility'),
  cursors: f.store.all('SELECT cursor FROM session_bindings')
});
const coverage = (f: Fixture) => {
  const row = f.store.get<{ coverage: string }>('SELECT coverage FROM ordinary_window_segments ORDER BY rowid DESC LIMIT 1');
  if (!row) throw new Error('fixture_coverage_missing');
  return OrdinaryWindowCoverageSchema.parse(JSON.parse(row.coverage));
};
const payloads = (f: Fixture) =>
  f.store.all<{ payload: string }>("SELECT payload FROM events WHERE json_extract(payload,'$.kind')='usage'").map(row => JSON.parse(row.payload) as unknown);

test.each(['0.164.0', '0.165.0', '0.167.0', '0.169.0'])('collects actual %s root usage with immutable source-only provenance', async version => {
  const f = await fixture(version);
  f.lifecycle.start(f.taskId);
  const result = await f.connect();
  expect(result.automatic_children).toBe(false);
  f.advance();
  f.appendResponse('own-response');
  await f.collect();
  const row = f.store.get<{ proof: string }>('SELECT proof FROM ordinary_window_segments WHERE root_session_id=?', [result.rootSessionId]);
  const proof = OrdinaryWindowConnectionProofSchema.parse(JSON.parse(row?.proof ?? 'null'));
  expect(proof).toMatchObject({
    mode: 'codex_source_only',
    productVersion: version,
    nativeSessionId: f.nativeSessionId,
    sourceVersionBasis: 'root_creation_header',
    processId: null,
    processStart: null,
    nativePinDigest: null,
    writerVersion: 'unverified',
    rootOwnership: 'unverified',
    publisherProof: 'unavailable',
    possibleChildContribution: 'unknown'
  });
  expect(payloads(f)).toEqual([
    expect.objectContaining({
      product_version: version,
      input_total: { status: 'observed', value: 100, reason: null },
      cached_input: { status: 'observed', value: 10, reason: null },
      output_total: { status: 'observed', value: 20, reason: null },
      reasoning_output: {
        status: 'observed',
        value: 5,
        reason: null
      }
    })
  ]);
  expect(f.store.all('SELECT * FROM session_bindings')).toHaveLength(1);
  expect(f.store.all('SELECT * FROM session_source_compatibility')).toHaveLength(1);
});

test.each(['0.170.0', '0.167.0-beta.1', '0.167', 'v0.167.0', 'invalid'])('refuses unsupported declaration %s before preparing a source', async version => {
  await expect(createCodexWindowProviderFixture({ version })).rejects.toThrow();
});

test('requires a pre-active task and matching Store activation even with an actual pending receipt', async () => {
  const f = await fixture('0.167.0', false);
  await expect(f.connect()).rejects.toThrow('binding_scope_revoked');
  f.lifecycle.start(f.taskId);
  await expect(f.connect()).rejects.toThrow('binding_window_activation_required');
  expect(f.store.all('SELECT * FROM sessions')).toEqual([]);
  expect(usageState(f).events).toEqual([]);
  f.activate();
  await expect(f.connect()).resolves.toMatchObject({
    automatic_children: false
  });
});

test.each([
  { id: 'other-root' },
  { session_id: 'other-root' },
  { cli_version: '0.165.0' },
  { cli_version: '0.167.0-beta.1' },
  { cwd: '/synthetic/other-project' },
  { parent_thread_id: 'parent-root' },
  { source: 'exec' },
  { forked_from_id: 'inherited-root' },
  { history_mode: 'paginated' }
])('refuses mismatched or inherited native creation header %j before usage', async mismatch => {
  const f = await fixture();
  writeFileSync(f.sourcePath, codexWindowJsonl([f.header(mismatch), f.context('turn'), f.usage('forbidden', 'turn')]));
  f.lifecycle.start(f.taskId);
  await expect(f.connect()).rejects.toThrow();
  expect(usageState(f)).toEqual({
    events: [],
    requests: [],
    exclusions: [],
    pins: [],
    cursors: []
  });
});

test('refuses receipt project mismatch without reserving a root', async () => {
  const f = await fixture();
  const receipt = await f.emit({ cwd: join(f.directory, 'other-project') });
  f.lifecycle.start(f.taskId);
  await expect(f.connect(receipt.receipt)).rejects.toThrow('binding_receipt_stale');
  expect(f.store.all('SELECT * FROM binding_root_segments')).toEqual([]);
});

test.each(['startup', 'resume', 'clear', 'compact', 'unsupported', null])('fences old startup durably after lifecycle %s', async source => {
  const f = await connected();
  await f.emitLifecycle(source);
  f.advance();
  f.appendResponse('after-fence');
  const before = usageState(f);
  await expect(f.collect()).rejects.toThrow('binding_fresh_root_required');
  expect(usageState(f)).toEqual(before);
  expect(f.lifecycle.state(f.taskId)).toBe('paused');
  expect(f.store.get<{ state: string }>('SELECT state FROM binding_root_segments')?.state).toBe('paused');
  f.lifecycle.resume(f.taskId);
  await expect(f.connect()).rejects.toThrow('binding_fresh_root_required');
  expect(f.store.all('SELECT * FROM binding_root_segments')).toHaveLength(1);
});

test.each(['startup', 'resume'])('null transcript path fences an already connected root for %s', async source => {
  const f = await connected();
  await f.emitLifecycle(source, null);
  f.advance();
  const before = usageState(f);
  await expect(f.collect()).rejects.toThrow('binding_fresh_root_required');
  expect(usageState(f)).toEqual(before);
  expect(f.lifecycle.state(f.taskId)).toBe('paused');
});

test.each(['compacted', 'retained_context'])('native %s metadata refuses the whole batch', async type => {
  const f = await connected();
  f.appendResponse('valid-before-fence');
  f.append([{ type, payload: {} }]);
  const before = usageState(f);
  await expect(f.collect()).rejects.toThrow('binding_fresh_root_required');
  expect(usageState(f)).toEqual(before);
});

test.each(['missing', 'unreadable'])('retains eventless metadata-only child coverage for a %s child source', async kind => {
  const f = await connected();
  const child = join(f.sourceRoot, `${kind}-child.jsonl`);
  if (kind === 'unreadable') {
    writeFileSync(child, 'not a native header or body');
    chmodSync(child, 0o000);
  }
  const receipt = await f.emitChild('native-child', child);
  f.advance();
  await f.collect();
  expect(vi.mocked(openSync).mock.calls.map(([path]) => path)).toContain(f.sourcePath);
  expect(vi.mocked(openAsync).mock.calls.map(([path]) => path)).toContain(f.sourcePath);
  expect(vi.mocked(openSync).mock.calls.filter(([path]) => path === child)).toEqual([]);
  expect(vi.mocked(openAsync).mock.calls.filter(([path]) => path === child)).toEqual([]);
  expect(vi.mocked(readFileSync).mock.calls.filter(([path]) => path === child)).toEqual([]);
  expect(vi.mocked(readFileAsync).mock.calls.filter(([path]) => path === child)).toEqual([]);
  expect(vi.mocked(createReadStream).mock.calls.filter(([path]) => path === child)).toEqual([]);
  expect(coverage(f).detectedChildren).toEqual([
    {
      identity: 'native-child',
      firstSeenAt: receipt.recordedAt,
      basis: 'root_linked_receipt',
      parentRelation: 'unverified',
      usage: null,
      cost: null
    }
  ]);
  expect(usageState(f).events).toEqual([]);
  expect(f.store.all('SELECT * FROM session_bindings')).toHaveLength(1);
  expect(coverage(f).status).toBe('partial');
});

test.each(['rotation', 'prefix'])('rejects native source %s without committing new usage or cursor', async kind => {
  const f = await connected();
  if (kind === 'prefix') {
    f.appendResponse('before-prefix');
    await f.collect();
    f.advance();
  }
  const original = readFileSync(f.sourcePath, 'utf8');
  if (kind === 'rotation') {
    renameSync(f.sourcePath, `${f.sourcePath}.old`);
  }
  writeFileSync(
    f.sourcePath,
    kind === 'prefix' ? original.replace('"input_tokens":100', '"input_tokens":101').replace('"total_tokens":120', '"total_tokens":121') : original
  );
  f.appendResponse('after-change');
  const before = usageState(f);
  await expect(f.collect()).rejects.toThrow();
  expect(usageState(f)).toEqual(before);
  expect(f.lifecycle.state(f.taskId)).toBe('paused');
});

test('keeps partial native tails missing until a complete response arrives', async () => {
  const f = await connected();
  f.append([f.context('tail-turn')]);
  const tail = JSON.stringify(f.usage('tail-response', 'tail-turn'));
  const current = readFileSync(f.sourcePath, 'utf8');
  writeFileSync(f.sourcePath, current + tail.slice(0, -1));
  await f.collect();
  expect(payloads(f)).toEqual([]);
  writeFileSync(f.sourcePath, current + tail + '\n');
  f.advance();
  await f.collect();
  expect(payloads(f)).toHaveLength(1);
});

test('excludes baseline responses and late pre-baseline contexts without backfill or replay', async () => {
  const f = await fixture();
  const beforeBaseline = f.clock();
  f.append([f.context('old-turn', beforeBaseline), f.usage('baseline-response', 'old-turn')]);
  f.lifecycle.start(f.taskId);
  await f.connect();
  expect(payloads(f)).toEqual([]);
  expect(usageState(f).exclusions).toHaveLength(1);
  f.advance();
  f.append([f.usage('late-response', 'old-turn')]);
  f.appendResponse('new-response');
  await f.collect();
  expect(payloads(f)).toHaveLength(1);
  expect(usageState(f).exclusions).toHaveLength(2);
  const beforeReplay = usageState(f);
  f.append([f.context('turn-new-response'), f.usage('new-response', 'turn-new-response')]);
  f.advance();
  await f.collect();
  expect(usageState(f).events).toEqual(beforeReplay.events);
  expect(usageState(f).requests).toEqual(beforeReplay.requests);
  expect(usageState(f).exclusions).toEqual(beforeReplay.exclusions);
});

test.each([
  { cached_input_tokens: 101 },
  { reasoning_output_tokens: 21 },
  { input_tokens: -1 },
  { total_tokens: 121 },
  { output_tokens: '20' },
  { cached_input_tokens: undefined },
  { reasoning_output_tokens: undefined },
  { cache_write_input_tokens: 91 }
])('rolls back mixed valid and invalid counters %j atomically', async counters => {
  const f = await connected();
  f.appendResponse('good-response');
  f.appendResponse('invalid-response', counters);
  const before = usageState(f);
  await expect(f.collect()).rejects.toThrow();
  expect(usageState(f)).toEqual(before);
  expect(f.lifecycle.state(f.taskId)).toBe('paused');
  expect(f.store.all('SELECT * FROM source_compatibility_blocks')).toHaveLength(1);
});

test('replay conflict rolls back a preceding new response in the same native batch', async () => {
  const f = await connected();
  f.appendResponse('existing-response');
  await f.collect();
  f.advance();
  f.appendResponse('new-response');
  f.append([
    f.context('turn-existing-response'),
    f.usage('existing-response', 'turn-existing-response', {
      input_tokens: 101,
      total_tokens: 121
    })
  ]);
  const before = usageState(f);
  await expect(f.collect()).rejects.toThrow();
  expect(usageState(f)).toEqual(before);
});

test('empty observed root does not synthesize zero usage', async () => {
  const f = await connected();
  await f.collect();
  expect(payloads(f)).toEqual([]);
  expect(coverage(f).detectedChildren).toEqual([]);
  expect(coverage(f).status).toBe('partial');
});

test('requires a fresh startup root after pause and refuses native source reuse', async () => {
  const f = await connected();
  await f.emitLifecycle('resume');
  await expect(f.collect()).rejects.toThrow('binding_fresh_root_required');
  f.lifecycle.resume(f.taskId);
  const alias = join(f.sourceRoot, 'alias.jsonl');
  linkSync(f.sourcePath, alias);
  const reused = await f.emitRoot('alias-root', alias);
  writeFileSync(alias, codexWindowJsonl([f.header({}, 'alias-root')]));
  await expect(f.connect(reused.receipt)).rejects.toThrow('binding_fresh_root_required');
  expect(f.lifecycle.state(f.taskId)).toBe('paused');
  f.lifecycle.resume(f.taskId);
  const freshPath = join(f.sourceRoot, 'fresh.jsonl');
  writeFileSync(freshPath, codexWindowJsonl([f.header({}, 'fresh-root')]));
  const fresh = await f.emitRoot('fresh-root', freshPath);
  await expect(f.connect(fresh.receipt)).resolves.toMatchObject({
    automatic_children: false
  });
  expect(f.store.all("SELECT * FROM binding_root_segments WHERE state='observing'")).toHaveLength(1);
  expect(payloads(f)).toEqual([]);
  f.advance();
  const response = f.usage('fresh-response', 'fresh-turn');
  appendFileSync(
    freshPath,
    codexWindowJsonl([
      f.context('fresh-turn'),
      {
        ...response,
        payload: {
          ...response.payload,
          session_id: 'fresh-root',
          thread_id: 'fresh-root'
        }
      }
    ])
  );
  await f.collect();
  expect(payloads(f)).toHaveLength(1);
});

test('stores actual version in compatibility provenance rather than parser-base identity', async () => {
  const f = await connected();
  const row = f.store.get<{ payload: string }>('SELECT payload FROM session_source_compatibility');
  const provenance = z.record(z.string(), z.unknown()).parse(JSON.parse(row?.payload ?? 'null'));
  expect(provenance).toMatchObject({
    product_version: '0.167.0',
    state: 'compatibility_unverified',
    parser_version: '0.163.0',
    source: 'codex_binding'
  });
});

test('invalid mixed baseline commits no exclusions, usage, replay ledger, cursor or pin', async () => {
  const f = await fixture();
  f.appendResponse('valid-baseline');
  f.appendResponse('invalid-baseline', { reasoning_output_tokens: 21 });
  f.lifecycle.start(f.taskId);
  await expect(f.connect()).rejects.toThrow('candidate_invalid_metadata');
  expect(usageState(f)).toEqual({
    events: [],
    requests: [],
    exclusions: [],
    pins: [],
    cursors: [{ cursor: null }]
  });
  expect(f.store.all('SELECT * FROM runtime_evidence')).toEqual([]);
  expect(f.lifecycle.state(f.taskId)).toBe('paused');
});
test('refuses a new native root that points at a previously enrolled source path', async () => {
  const f = await connected();
  await f.emitLifecycle('resume');
  await expect(f.collect()).rejects.toThrow('binding_fresh_root_required');
  f.lifecycle.resume(f.taskId);
  const receipt = await f.emitRoot('different-root', f.sourcePath);
  await expect(f.connect(receipt.receipt)).rejects.toThrow('binding_fresh_root_required');
  expect(f.store.all('SELECT * FROM binding_root_segments')).toHaveLength(1);
  expect(payloads(f)).toEqual([]);
});
test('refuses asset paths outside explicitly selected native rollout roots', async () => {
  const f = await fixture();
  const path = join(f.assetRoot, 'root.jsonl');
  writeFileSync(path, codexWindowJsonl([f.header({}, 'asset-root')]));
  const receipt = await f.emitRoot('asset-root', path);
  f.lifecycle.start(f.taskId);
  await expect(f.connect(receipt.receipt)).rejects.toThrow('binding_source_unapproved');
  expect(f.store.all('SELECT * FROM ordinary_window_segments')).toEqual([]);
  expect(payloads(f)).toEqual([]);
});
test.each(['session_id', 'thread_id'])('refuses native response %s mapping mismatch atomically', async field => {
  const f = await connected();
  f.appendResponse('good-response');
  const response = f.usage('wrong-mapping', 'wrong-turn');
  f.append([
    f.context('wrong-turn'),
    {
      ...response,
      payload: { ...response.payload, [field]: 'other-root' }
    }
  ]);
  const before = usageState(f);
  await expect(f.collect()).rejects.toThrow('candidate_scope_mismatch');
  expect(usageState(f)).toEqual(before);
});
