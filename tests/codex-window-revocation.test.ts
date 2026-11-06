import { EventEmitter, once } from 'node:events';
import { fstatSync, lstatSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, renameSync, realpathSync, writeFileSync } from 'node:fs';
import { open as openAsync } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { pauseOrdinaryWindowSegment, revokeOrdinaryWindowActivation } from '../src/core/ordinary-window-store.js';
import { Deletion } from '../src/deletion.js';
import { CodexWindowSessionBindingProvider } from '../src/session-binding-codex.js';
import { OrdinaryWindowConnectionProofSchema } from '../src/core/ordinary-window-policy.js';
import { runCodexWindowHook } from './helpers/codex-window-hook-fixture.js';
import { codexWindowJsonl, createCodexWindowProviderFixture } from './helpers/codex-window-provider-fixture.js';
import { activateOrdinaryWindowDecision } from '../src/core/ordinary-window-activation.js';
import { windowTrialPacket } from './helpers/ordinary-window-decision-fixture.js';

vi.mock('node:fs', { spy: true });
vi.mock('node:fs/promises', { spy: true });
const fixtures: Awaited<ReturnType<typeof createCodexWindowProviderFixture>>[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) f.cleanup();
});
async function fixture(trial = false) {
  const f = await createCodexWindowProviderFixture({ activate: !trial });
  fixtures.push(f);
  if (trial) activateOrdinaryWindowDecision(f.store, windowTrialPacket(f.selection), f.clock());
  f.lifecycle.start(f.taskId);
  return f;
}
const fsCalls = () => [
  vi.mocked(lstatSync).mock.calls.length,
  vi.mocked(realpathSync).mock.calls.length,
  vi.mocked(openSync).mock.calls.length,
  vi.mocked(readSync).mock.calls.length,
  vi.mocked(fstatSync).mock.calls.length,
  vi.mocked(readdirSync).mock.calls.length,
  vi.mocked(readlinkSync).mock.calls.length,
  vi.mocked(readFileSync).mock.calls.length,
  vi.mocked(openAsync).mock.calls.length
];
function snapshot(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    ...f.snapshot(),
    tasks: f.store.all('SELECT * FROM tasks'),
    preparation: f.store.all('SELECT * FROM ordinary_tasks'),
    intervals: f.store.all('SELECT * FROM active_intervals'),
    blocks: f.store.all('SELECT * FROM source_compatibility_blocks')
  };
}
async function holdOpenedSource(completion: 'resolved' | 'rejected' = 'resolved') {
  const native = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const gates = new EventEmitter();
  const entered = once(gates, 'entered');
  const released = once(gates, 'release');
  let assertNoNextRead: () => void = () => {
    throw new Error('fixture_source_not_opened');
  };
  vi.mocked(openAsync).mockImplementationOnce(async (...args) => {
    const file = await native.open(...args);
    const stat = vi.spyOn(file, 'stat');
    const read = vi.spyOn(file, 'read');
    assertNoNextRead = () => {
      expect(stat).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
    };
    gates.emit('entered');
    await released;
    if (completion === 'rejected') {
      await file.close();
      throw new Error('binding_contract_failed');
    }
    return file;
  });
  return {
    entered,
    release: () => gates.emit('release'),
    assertNoNextRead: () => assertNoNextRead()
  };
}

test.each(['revoke', 'pause', 'generation'] as const)(
  'does not perform the next native stat/read or write rejection state after %s while an authorized open is pending',
  async transition => {
    const f = await fixture();
    await f.connect();
    const gate = await holdOpenedSource();
    const running = f.collect();
    const rejected = expect(running).rejects.toThrow(/binding_scope_revoked|binding_window_activation_required/);
    try {
      await Promise.race([
        gate.entered,
        running.then(() => {
          throw new Error('fixture_read_open_not_observed');
        })
      ]);
      if (transition === 'revoke') {
        revokeOrdinaryWindowActivation(f.store, f.taskId, f.clock());
      } else if (transition === 'pause') {
        pauseOrdinaryWindowSegment(f.store, f.taskId, f.clock(), 'paused');
      } else {
        f.lifecycle.pause(f.taskId);
        f.lifecycle.resume(f.taskId);
      }
      const before = snapshot(f);
      const io = fsCalls();
      gate.release();
      await rejected;
      gate.assertNoNextRead();
      expect(fsCalls()).toEqual(io);
      expect(snapshot(f)).toEqual(before);
    } finally {
      gate.release();
      await running.catch(() => undefined);
    }
  }
);

test('task deletion during pending open leaves no later native read, proof, usage or rejection mutation', async () => {
  const f = await fixture();
  await f.connect();
  const gate = await holdOpenedSource();
  const running = f.collect();
  const rejected = expect(running).rejects.toThrow(/ordinary_preparation_required|binding_scope_revoked/);
  try {
    await Promise.race([
      gate.entered,
      running.then(() => {
        throw new Error('fixture_read_open_not_observed');
      })
    ]);
    new Deletion(f.store, f.clock).deleteTask(f.taskId);
    const before = snapshot(f);
    const io = fsCalls();
    gate.release();
    await rejected;
    gate.assertNoNextRead();
    expect(fsCalls()).toEqual(io);
    expect(snapshot(f)).toEqual(before);
    expect(f.store.all('SELECT * FROM ordinary_window_segments')).toEqual([]);
    expect(f.store.all('SELECT product,native_session_id FROM ordinary_window_forget_fences')).toEqual([
      { product: 'codex', native_session_id: f.nativeSessionId }
    ]);
  } finally {
    gate.release();
    await running.catch(() => undefined);
  }
});

test.each(['resolved', 'rejected'] as const)('a stale real source %s cannot pause or rewrite a freshly baselined replacement root', async completion => {
  const f = await fixture();
  const old = await f.connect();
  const gate = await holdOpenedSource(completion);
  const running = f.collect();
  const rejected = expect(running).rejects.toThrow(completion === 'resolved' ? 'binding_scope_revoked' : 'binding_contract_failed');
  try {
    await Promise.race([
      gate.entered,
      running.then(() => {
        throw new Error('fixture_read_open_not_observed');
      })
    ]);
    pauseOrdinaryWindowSegment(f.store, f.taskId, f.clock(), 'paused');
    f.lifecycle.resume(f.taskId);
    const source = join(f.sourceRoot, 'replacement.jsonl');
    writeFileSync(source, codexWindowJsonl([f.header({}, 'replacement-root')]));
    const pending = await f.emitRoot('replacement-root', source);
    const replacement = await f.connect(pending.receipt);
    expect(replacement.rootSessionId).not.toBe(old.rootSessionId);
    const before = snapshot(f);
    const io = fsCalls();
    gate.release();
    await rejected;
    gate.assertNoNextRead();
    expect(fsCalls()).toEqual(io);
    expect(snapshot(f)).toEqual(before);
    expect(f.lifecycle.state(f.taskId)).toBe('active');
    expect(f.store.get<{ state: string }>('SELECT state FROM binding_root_segments WHERE root_session_id=?', [replacement.rootSessionId])?.state).toBe(
      'observing'
    );
  } finally {
    gate.release();
    await running.catch(() => undefined);
  }
});

test.each(['resolved', 'rejected'] as const)('a stale real header-proof %s cannot enroll its root or pause the replacement attempt', async completion => {
  const f = await fixture();
  const gates = new EventEmitter();
  const entered = once(gates, 'entered');
  const release = once(gates, 'release');
  const original: unknown = Object.getOwnPropertyDescriptor(CodexWindowSessionBindingProvider.prototype, 'inspectWindowCurrent')?.value;
  if (typeof original !== 'function') throw new Error('fixture_header_method_missing');
  vi.spyOn(CodexWindowSessionBindingProvider.prototype, 'inspectWindowCurrent').mockImplementationOnce(async function (
    this: CodexWindowSessionBindingProvider,
    input
  ) {
    const proof = OrdinaryWindowConnectionProofSchema.parse(await Reflect.apply(original, this, [input]));
    gates.emit('entered');
    await release;
    if (completion === 'rejected') throw new Error('binding_contract_failed');
    return proof;
  });
  const connecting = f.connect();
  const rejected = expect(connecting).rejects.toThrow(completion === 'resolved' ? 'binding_scope_revoked' : 'binding_contract_failed');
  try {
    await Promise.race([
      entered,
      connecting.then(() => {
        throw new Error('fixture_header_proof_not_observed');
      })
    ]);
    pauseOrdinaryWindowSegment(f.store, f.taskId, f.clock(), 'paused');
    f.lifecycle.resume(f.taskId);
    const source = join(f.sourceRoot, 'replacement-proof.jsonl');
    writeFileSync(source, codexWindowJsonl([f.header({}, 'replacement-proof-root')]));
    const pending = await f.emitRoot('replacement-proof-root', source);
    const replacement = await f.connect(pending.receipt);
    const before = snapshot(f);
    const io = fsCalls();
    gates.emit('release');
    await rejected;
    expect(fsCalls()).toEqual(io);
    expect(snapshot(f)).toEqual(before);
    expect(f.lifecycle.state(f.taskId)).toBe('active');
    expect(f.store.all<{ root_session_id: string }>('SELECT root_session_id FROM ordinary_window_segments')).toEqual([
      { root_session_id: replacement.rootSessionId }
    ]);
  } finally {
    gates.emit('release');
    await connecting.catch(() => undefined);
  }
});

test.each([
  { label: 'numeric lifecycle', fields: { source: 7 } },
  { label: 'object lifecycle', fields: { source: { kind: 'resume' } } },
  { label: 'numeric path', fields: { source: 'resume', transcript_path: 7 } },
  { label: 'relative path', fields: { source: 'resume', transcript_path: 'relative' } }
])('keeps $label as stopping metadata instead of continuing an old startup root', async ({ fields }) => {
  const f = await fixture();
  await f.connect();
  f.advance();
  f.appendResponse('response-after-untrusted-start');
  const helper = await runCodexWindowHook({
    projectRoot: f.projectRoot,
    receiptDirectory: f.receiptDirectory,
    nativePrefixes: [f.sourceRoot, f.assetRoot],
    input: { hook_event_name: 'SessionStart', session_id: f.nativeSessionId, cwd: f.projectRoot, transcript_path: f.sourcePath, ...fields }
  });
  expect(helper.effects).toEqual({ nativeCalls: 0, processCalls: 0, operations: [] });
  const opens = vi.mocked(openAsync).mock.calls.length;
  await expect(f.collect()).rejects.toThrow('binding_fresh_root_required');
  expect(vi.mocked(openAsync).mock.calls.length).toBe(opens);
  expect(f.lifecycle.state(f.taskId)).toBe('paused');
  expect(f.store.eventCount()).toBe(0);
  expect(f.store.all('SELECT * FROM source_compatibility_blocks')).toEqual([]);
  expect(helper.code).toBe(0);
});

test.each(['resume', 'null-path'] as const)('fences %s lifecycle metadata that arrives after source open starts', async lifecycle => {
  const f = await fixture();
  await f.connect();
  f.advance();
  f.appendResponse('response-during-lifecycle');
  const baseline = f.store.all('SELECT cursor FROM session_bindings');
  const gate = await holdOpenedSource();
  const running = f.collect();
  const rejected = expect(running).rejects.toThrow('binding_fresh_root_required');
  try {
    await Promise.race([
      gate.entered,
      running.then(() => {
        throw new Error('fixture_read_open_not_observed');
      })
    ]);
    await f.emitLifecycle(lifecycle === 'resume' ? 'resume' : 'startup', lifecycle === 'resume' ? f.sourcePath : null);
    gate.release();
    await rejected;
    gate.assertNoNextRead();
    expect(f.store.eventCount()).toBe(0);
    expect(f.store.all('SELECT * FROM binding_requests')).toEqual([]);
    expect(f.store.all('SELECT cursor FROM session_bindings')).toEqual(baseline);
    expect(f.lifecycle.state(f.taskId)).toBe('paused');
    expect(f.store.all('SELECT * FROM source_compatibility_blocks')).toEqual([]);
  } finally {
    gate.release();
    await running.catch(() => undefined);
  }
});

test('rejects pathname rotation after an authorized source handle opens but before its first stat', async () => {
  const f = await fixture();
  await f.connect();
  f.advance();
  f.appendResponse('response-during-rotation');
  const baseline = f.store.all('SELECT cursor FROM session_bindings');
  const gate = await holdOpenedSource();
  const running = f.collect();
  const rejected = expect(running).rejects.toThrow('binding_source_changed');
  try {
    await Promise.race([
      gate.entered,
      running.then(() => {
        throw new Error('fixture_read_open_not_observed');
      })
    ]);
    renameSync(f.sourcePath, `${f.sourcePath}.detached`);
    writeFileSync(f.sourcePath, codexWindowJsonl([f.header()]));
    gate.release();
    await rejected;
    gate.assertNoNextRead();
    expect(f.store.eventCount()).toBe(0);
    expect(f.store.all('SELECT * FROM binding_requests')).toEqual([]);
    expect(f.store.all('SELECT cursor FROM session_bindings')).toEqual(baseline);
    expect(f.lifecycle.state(f.taskId)).toBe('paused');
    expect(f.store.all('SELECT * FROM source_compatibility_blocks')).toEqual([]);
  } finally {
    gate.release();
    await running.catch(() => undefined);
  }
});

test('trial expiry during an authorized real-provider open durably closes the owned segment before any next read', async () => {
  const f = await fixture(true);
  const root = await f.connect();
  const cursor = f.store.get<{ cursor: string | null }>('SELECT cursor FROM session_bindings')?.cursor;
  const proof = f.store.all('SELECT proof FROM ordinary_window_segments');
  const gate = await holdOpenedSource();
  const running = f.collect();
  const rejected = expect(running).rejects.toThrow(/binding_metadata_untrusted|binding_source_unavailable|binding_window_trial_expired/);
  try {
    await Promise.race([
      gate.entered,
      running.then(() => {
        throw new Error('fixture_read_open_not_observed');
      })
    ]);
    f.advance(60_000);
    const io = fsCalls();
    gate.release();
    await rejected;
    gate.assertNoNextRead();
    expect(fsCalls()).toEqual(io);
    expect(f.store.get('SELECT revoked_at,revocation_reason FROM ordinary_window_activations')).toEqual({
      revoked_at: f.clock(),
      revocation_reason: 'trial_expired'
    });
    expect(f.lifecycle.state(f.taskId)).toBe('paused');
    expect(f.store.get<{ state: string }>('SELECT state FROM binding_root_segments WHERE root_session_id=?', [root.rootSessionId])?.state).toBe('paused');
    expect(f.store.get<{ cursor: string | null }>('SELECT cursor FROM session_bindings')?.cursor).toBe(cursor);
    expect(f.store.all('SELECT proof FROM ordinary_window_segments')).toEqual(proof);
    expect(f.store.eventCount()).toBe(0);
  } finally {
    gate.release();
    await running.catch(() => undefined);
  }
});

test('connect expiry cannot finalize with a pre-baseline cursor after the cursor advances', async () => {
  const f = await fixture(true);
  const execute = f.store.execute.bind(f.store);
  const update = vi.spyOn(f.store, 'execute').mockImplementation((sql, params) => {
    const result = execute(sql, params);
    if (sql === 'UPDATE session_bindings SET cursor=? WHERE session_id=?') f.advance(60_000);
    return result;
  });
  try {
    await expect(f.connect()).rejects.toThrow('binding_window_trial_expired');
    expect(f.store.get<{ cursor: string | null }>('SELECT cursor FROM session_bindings')?.cursor).not.toBeNull();
    expect(f.store.get<{ revoked_at: string | null }>('SELECT revoked_at FROM ordinary_window_activations')?.revoked_at).toBeNull();
    expect(f.lifecycle.state(f.taskId)).toBe('active');
    expect(f.store.get<{ state: string }>('SELECT state FROM binding_root_segments')?.state).toBe('observing');
    expect(f.store.eventCount()).toBe(0);
  } finally {
    update.mockRestore();
  }
});
