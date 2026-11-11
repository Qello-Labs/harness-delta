import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { z } from 'zod';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createWindowBudget } from '../scripts/tool-update/codex-window-conformance.mjs';
import { reserveWindowConsent } from '../scripts/tool-update/codex-window-consent.mjs';
import { createSyntheticWindowCaseGuards } from '../scripts/tool-update/codex-window-case-guards.mjs';
import type { WindowOwnedPid, WindowWatchOptions } from '../scripts/tool-update/codex-window-watch.mjs';

// Cases that reach synthetic collection build a real Store with migrations; a loaded runner
// needs headroom beyond the 5 s default. Cases that stop before collection keep the default.
const collectionTimeoutMs = 20_000;

const state = vi.hoisted(() => ({
  nowNs: 1000000000n,
  fault: '',
  ownerRegistered: false,
  createdRegistered: false,
  mountedRegistered: false,
  targetRegistered: false,
  collectorCalls: 0,
  collectedRows: 0,
  closeCalls: 0,
  watchStops: 0,
  clockStops: 0,
  shortened: '',
  stopOrigins: [] as bigint[],
  signalled: [] as number[],
  watchOptions: undefined as WindowWatchOptions | undefined,
  loss: undefined as ((code: string) => void) | undefined,
  compiler: undefined as EventEmitter | undefined,
  consentFile: '',
  imagePath: '',
  caseRoot: '',
  registryPath: '',
  observedRoots: [] as string[],
  collectionBarrier: undefined as ReturnType<typeof deferred<void>> | undefined,
  collectionEntered: undefined as ReturnType<typeof deferred<void>> | undefined
}));

function identity(pid: number): WindowOwnedPid {
  return {
    pid,
    parent: 1,
    pgid: pid,
    uid: process.getuid?.() ?? 0,
    start_sec: 10,
    start_usec: pid
  };
}

function deferred<T>() {
  let settle: ((value: T) => void) | undefined;
  const promise = new Promise<T>(resolve => {
    settle = resolve;
  });
  return {
    promise,
    resolve(value: T) {
      if (!settle) throw new Error('deferred_not_initialized');
      settle(value);
    }
  };
}

function registryEntries() {
  const record = z.object({
    entry: z.object({
      kind: z.string(),
      started: z.string().optional(),
      pid: z.number().optional(),
      path: z.string().optional(),
      devices: z.array(z.string()).optional()
    })
  });
  return readFileSync(state.registryPath, 'utf8')
    .trim()
    .split('\n')
    .map(line => record.parse(JSON.parse(line)).entry);
}

vi.mock('node:child_process', async importOriginal => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: () => {
    const peer = Object.assign(new EventEmitter(), {
      pid: 800001,
      kill: vi.fn()
    });
    state.compiler = peer;
    queueMicrotask(() => peer.emit('spawn'));
    return peer;
  }
}));

vi.mock('../scripts/tool-update/codex-window-clock.mjs', () => ({
  createWindowClock: (options: { onOwnerResource: (value: WindowOwnedPid) => Promise<void> }) => {
    const completed = deferred<object>();
    return {
      ready: Promise.resolve().then(async () => {
        await options.onOwnerResource(identity(800002));
        return { kind: 'ready', now_ns: String(state.nowNs) };
      }),
      result: completed.promise,
      clock: () => Promise.resolve(state.nowNs),
      inspect: (pid: number) => {
        if (pid === 800001) {
          queueMicrotask(() => {
            writeFileSync(join(state.observedRoots[0] ?? '', 'watch-fixture'), 'synthetic-compiled-fixture', { mode: 0o700 });
            state.compiler?.emit('close', 0);
          });
        }
        return Promise.resolve(state.fault === 'owner_absent' && pid === 800003 ? null : identity(pid));
      },
      signal: (value: WindowOwnedPid) => {
        state.signalled.push(value.pid);
        return Promise.resolve({
          kind: 'signal',
          id: 1,
          seq: 1,
          outcome: 'absent',
          now_ns: String(state.nowNs)
        });
      },
      stop: () => {
        state.clockStops++;
        if (state.fault === 'late_cleanup') state.nowNs += 5001000000n;
        if (state.fault === 'registry_tamper') {
          appendFileSync(state.registryPath, 'tampered\n');
        }
        const result = { failed: false, cleanup_verified: true };
        completed.resolve(result);
        return completed.promise;
      }
    };
  }
}));

vi.mock('../scripts/tool-update/codex-window-containment.mjs', async importOriginal => ({
  ...(await importOriginal<typeof import('../scripts/tool-update/codex-window-containment.mjs')>()),
  runWindowTool: (command: string) => {
    if (command !== '/usr/bin/hdiutil' && command !== '/usr/bin/plutil') throw new Error('unexpected_os_inspection');
    return Promise.resolve({
      code: 0,
      stdout: JSON.stringify({ images: [] })
    });
  }
}));

vi.mock('../scripts/tool-update/codex-window-quota-owner.mjs', () => ({
  createWindowQuotaGuardian: (
    root: string,
    options: {
      onOwner: (pid: number) => Promise<void>;
      onCreated: (path: string, identity: object) => Promise<void>;
      onMounted: (evidence: object) => Promise<void>;
      onLoss: (code: string) => void;
    }
  ) => {
    const closed = deferred<object>();
    state.loss = options.onLoss;
    const caseRoot = join(root, 'mounts', 'HarnessQuotaState', 'private');
    const evidenceRoot = join(root, 'mounts', 'HarnessQuotaEvidence', 'private');
    const imagePath = join(root, 'volume.sparseimage');
    const close = () => {
      state.closeCalls++;
      rmSync(join(root, 'mounts'), { recursive: true, force: true });
      rmSync(imagePath, { force: true });
      const result = {
        detached: true,
        ownedImageDeleted: true,
        identity: {}
      };
      closed.resolve({ cleanup: result, failure: null });
      if (state.fault === 'close_failure') {
        return Promise.reject(new Error('close_failure'));
      }
      return Promise.resolve(result);
    };
    return {
      owner: { pid: 800003 },
      closed: closed.promise,
      close,
      start: async () => {
        writeFileSync(join(root, 'quota-owner-openssl.cnf'), '', {
          mode: 0o600
        });
        await options.onOwner(800003);
        if (!registryEntries().some(entry => entry.kind === 'pid' && entry.pid === 800003)) throw new Error('owner_not_durable');
        state.ownerRegistered = true;
        mkdirSync(join(root, 'mounts'), { mode: 0o700 });
        writeFileSync(imagePath, '', { mode: 0o600 });
        state.imagePath = imagePath;
        await options.onCreated(imagePath, {});
        if (!registryEntries().some(entry => entry.kind === 'path' && entry.path === imagePath)) throw new Error('image_not_durable_before_attach');
        state.createdRegistered = true;
        mkdirSync(caseRoot, { recursive: true, mode: 0o700 });
        mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });
        state.caseRoot = caseRoot;
        const evidence = {
          entities: [
            {
              'dev-entry': '/dev/disk999999',
              'mount-point': caseRoot
            }
          ],
          writablePaths: [caseRoot, evidenceRoot]
        };
        await options.onMounted(evidence);
        state.mountedRegistered = true;
        return {
          imagePath,
          caseRoot,
          evidenceRoot,
          verifyWritablePaths: () => {
            if (state.fault === 'control_replacement') {
              const path = join(caseRoot, 'project', '.harness-delta', 'window-receipts', 'ordinary-window-control.json');
              const bytes = readFileSync(path);
              renameSync(path, join(caseRoot, 'old-control.json'));
              writeFileSync(path, bytes, { mode: 0o600 });
            }
            return Promise.resolve(evidence);
          },
          measureOverhead: (roots: readonly string[]) => {
            state.observedRoots = [...roots];
            if (state.fault === 'raw_evidence') {
              writeFileSync(join(evidenceRoot, 'raw.json'), 'prompt: do things', { mode: 0o600 });
            }
            if (!roots.some(path => state.registryPath.startsWith(path + '/'))) throw new Error('registry_root_not_charged');
            if (state.fault === 'overhead') {
              options.onLoss('quota_overhead_exceeded');
              return Promise.reject(new Error('quota_overhead_exceeded'));
            }
            return Promise.resolve({ chargedBytes: 1024 });
          },
          writeEvidence: (name: string, bytes: Buffer) => {
            writeFileSync(join(evidenceRoot, name), bytes, {
              flag: 'wx',
              mode: 0o600
            });
            return Promise.resolve({ bytes: bytes.length });
          },
          close
        };
      }
    };
  }
}));

vi.mock('../scripts/tool-update/codex-window-watch.mjs', () => ({
  createWindowWatch: (options: WindowWatchOptions) => {
    state.watchOptions = options;
    const completed = deferred<object>();
    const output = Object.assign(new PassThrough(), { isTTY: state.fault === 'tty_stdio' });
    const input = new PassThrough();
    const result = {
      execs: options.priorExecs,
      live: 0,
      receipts: 0,
      lower_bound: true,
      unaccounted: 0,
      failed: false,
      stop_batch: false,
      cleanup_verified: true,
      term_ms: 1,
      kill_ms: 2,
      disappearance_ms: 3
    };
    return {
      ready: Promise.resolve().then(async () => {
        const names = readdirSync(options.receiptDirectory);
        const control = options.receiptControl;
        if (names.length !== 1 || names[0] !== 'ordinary-window-control.json' || !control) throw new Error('watch_receipts_not_fresh');
        const stat = lstatSync(join(options.receiptDirectory, names[0]), { bigint: true });
        if (
          stat.dev !== BigInt(control.dev) ||
          stat.ino !== BigInt(control.ino) ||
          stat.uid !== BigInt(control.uid) ||
          stat.birthtimeNs !== BigInt(control.birthSec) * 1000000000n + BigInt(control.birthNsec)
        )
          throw new Error('watch_receipt_control_identity');
        await options.onOwnerResource?.(identity(800004));
      }),
      result: completed.promise,
      targetStdio: [input, output, new PassThrough()],
      launch: async () => {
        if (state.fault === 'watch_loss_before_root') {
          options.onRecord?.({
            kind: 'loss',
            code: 'guard_loss',
            seq: 1
          });
          completed.resolve({
            ...result,
            failed: true,
            cleanup_verified: false
          });
          return;
        }
        if (!state.ownerRegistered || !state.createdRegistered || !state.mountedRegistered) throw new Error('release_before_resource_ack');
        const entries = registryEntries();
        if (
          !entries.some(entry => entry.kind === 'image' && entry.devices?.includes('/dev/disk999999')) ||
          !entries.some(entry => entry.kind === 'path' && entry.path === state.caseRoot)
        )
          throw new Error('release_without_mounted_registry');
        await options.onResource(identity(800005));
        if (!registryEntries().some(entry => entry.kind === 'pid' && entry.pid === 800005)) throw new Error('root_resumed_before_durable_identity');
        state.targetRegistered = true;
        result.execs++;
        state.nowNs += 1000000n;
        vi.setSystemTime(Date.now() + 1);
        if (result.execs > 15) {
          options.onRecord?.({
            kind: 'count',
            seq: 1,
            execs: result.execs,
            live: 1,
            receipts: 0,
            lower_bound: true,
            exec_overshoot: result.execs - 15,
            live_overshoot: 0,
            receipt_overshoot: 0
          });
          completed.resolve({
            ...result,
            failed: true,
            stop_batch: true
          });
        } else if (state.fault === 'watch_loss') {
          options.onRecord?.({
            kind: 'loss',
            code: 'guard_loss',
            seq: 1
          });
          completed.resolve({
            ...result,
            failed: true,
            cleanup_verified: false
          });
        } else if (state.fault === 'eof') {
          output.end();
        } else if (state.fault === 'overrun') {
          options.onRecord?.({
            kind: 'count',
            seq: 1,
            execs: 16,
            live: 1,
            receipts: 1,
            lower_bound: true,
            exec_overshoot: 1,
            live_overshoot: 0,
            receipt_overshoot: 0
          });
        } else if (state.fault === 'consent_expired') {
          vi.setSystemTime(Date.now() + 120000);
          output.write('H');
        } else {
          output.write('H');
        }
      },
      shortenDeadline: (deadline: string) => {
        state.shortened = deadline;
        return Promise.resolve();
      },
      stop: async (origin: bigint) => {
        state.watchStops++;
        state.stopOrigins.push(origin);
        if (state.fault === 'late_registration') {
          await options.onResource(identity(800006));
        }
        completed.resolve(state.fault === 'unaccounted_cleanup' ? { ...result, unaccounted: 1 } : result);
        return completed.promise;
      }
    };
  }
}));

vi.mock('../scripts/tool-update/codex-window-collection.mjs', async importOriginal => {
  const actual = await importOriginal<typeof import('../scripts/tool-update/codex-window-collection.mjs')>();
  return {
    createSyntheticWindowCollection: (...args: Parameters<typeof actual.createSyntheticWindowCollection>) => {
      const collection = actual.createSyntheticWindowCollection(...args);
      if (state.fault === 'unexpected_initial_receipt') {
        writeFileSync(join(collection.receiptDirectory, 'unexpected.json'), '{}', { mode: 0o600 });
      }
      return {
        ...collection,
        collect: async () => {
          state.collectorCalls++;
          state.collectionEntered?.resolve();
          await state.collectionBarrier?.promise;
          if (state.fault === 'consent_drift') {
            appendFileSync(state.consentFile, '\n');
          }
          await collection.collect();
          state.collectedRows = collection.store.all('SELECT * FROM events').length;
        }
      };
    }
  };
});

const roots: string[] = [];
beforeEach(() => {
  Object.assign(state, {
    nowNs: 1000000000n,
    fault: '',
    ownerRegistered: false,
    createdRegistered: false,
    mountedRegistered: false,
    targetRegistered: false,
    collectorCalls: 0,
    collectedRows: 0,
    closeCalls: 0,
    watchStops: 0,
    clockStops: 0,
    shortened: '',
    stopOrigins: [],
    signalled: [],
    observedRoots: [],
    collectionBarrier: undefined,
    collectionEntered: undefined
  });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.parse('2026-11-11T01:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture(priorExecs = 0, evidenceExportRoot?: string) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'window-case-guards-'));
  roots.push(root);
  const guardsRoot = join(root, 'guards');
  state.observedRoots = [guardsRoot];
  state.registryPath = join(root, '.codex-window-resources.jsonl');
  const batchStartedMs = 1000;
  const budget = createWindowBudget(batchStartedMs);
  const guards = createSyntheticWindowCaseGuards({
    root,
    nativePath: '/synthetic/native-guard',
    batchStartedMs,
    priorExecs,
    budget,
    caseId: 'normal',
    ...(evidenceExportRoot ? { evidenceExportRoot } : {}),
    auditClock: {
      clock: () => Promise.resolve(state.nowNs),
      result: deferred<{ readonly failed: boolean }>().promise
    }
  });
  return { root, guards, budget, batchStartedMs };
}

function consent(caseRoot: string) {
  const pins = Object.fromEntries(
    ['native', 'host', 'source', 'build', 'instrument', 'runtime', 'lockfile', 'config', 'environment', 'egress', 'quota'].map((name, i) => [
      name,
      String(i % 10).repeat(64)
    ])
  );
  const intent = {
    schema_version: 1,
    kind: 'codex_window_disabled_intent',
    authority: 'none',
    execution_enabled: false,
    actual_qualification: false,
    case_id: 'normal',
    case_root: caseRoot,
    plan_digest: 'a'.repeat(64),
    plan: {
      schema_version: 1,
      product: 'codex',
      version: '0.167.0',
      commit: '086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a',
      route: 'codex_binding',
      policy_id: 'codex-binding-root-window-v1',
      operation: 'collect',
      topology: 'root',
      runtime: 'node24',
      platform: 'darwin_arm64',
      model: 'gpt-6.1-sol',
      effort: 'high',
      pins
    },
    owner_ms: 120000,
    cleanup_ms: 5000,
    audit_reserve_ms: 10000,
    containment_qualified: false
  };
  const intentBytes = JSON.stringify(intent);
  const intentFile = join(caseRoot, 'intent.json');
  const consentFile = join(caseRoot, 'consent.json');
  writeFileSync(intentFile, intentBytes, { mode: 0o600 });
  writeFileSync(
    consentFile,
    JSON.stringify({
      schema_version: 1,
      kind: 'codex_window_b1_consent',
      consent_id: randomUUID(),
      approval_reference: 'b'.repeat(64),
      issued_at: Date.now(),
      expires_at: Date.now() + 120000,
      intent_sha256: createHash('sha256').update(intentBytes).digest('hex'),
      case_id: 'normal',
      case_root: caseRoot,
      product: 'codex',
      version: '0.167.0',
      operation: 'collect',
      topology: 'root',
      pins
    }),
    { mode: 0o600 }
  );
  state.consentFile = consentFile;
  return {
    capability: reserveWindowConsent({
      intentFile,
      consentFile,
      observedPins: pins
    }),
    observedPins: pins,
    scenario: 'hold' as const
  };
}

test(
  'runs genuine baseline and collection then verifies retained registry against actual disappearance',
  async () => {
    const f = fixture();
    const prepared = await f.guards.prepare();
    const result = await f.guards.run(consent(prepared.caseRoot));
    expect(result.failed, JSON.stringify(result)).toBe(false);
    expect(result.cleanup_verified).toBe(true);
    expect(state.collectedRows).toBe(1);
    expect(result.collection).toEqual({
      event_count: 1,
      trial_tokens_consumed: 120
    });
    expect(state.shortened).toBe('61000000000');
    expect(existsSync(state.imagePath)).toBe(false);
    expect(existsSync(state.caseRoot)).toBe(false);
    expect(existsSync(state.registryPath)).toBe(true);
    const entries = registryEntries();
    expect(entries.filter(row => row.kind === 'pid').map(row => row.started)).toEqual(['10:800002', '10:800001', '10:800003', '10:800004', '10:800005']);
    expect(f.budget.auditDeadline(1000, 2000)).toBe(2000);
  },
  collectionTimeoutMs
);

test(
  'a carried exec budget stops before synthetic collection',
  async () => {
    const f = fixture(15);
    const prepared = await f.guards.prepare();
    const result = await f.guards.run(consent(prepared.caseRoot));
    expect(result.failed).toBe(true);
    expect(result.stop_batch).toBe(true);
    expect(state.collectedRows).toBe(0);
    expect(result.observed_overshoot).toMatchObject({
      execs: 16,
      exec_overshoot: 1,
      lower_bound: true
    });
    expect(() => f.budget.reserve('flush', 1000, 200000)).toThrow('batch_stopped');
  },
  collectionTimeoutMs
);

async function latchesEveryCleanupStage(fault: string) {
  const f = fixture();
  state.fault = fault;
  let result;
  if (fault === 'owner_absent' || fault === 'overhead') {
    await expect(f.guards.prepare()).rejects.toThrow();
    result = await f.guards.result;
  } else {
    const prepared = await f.guards.prepare();
    result = await f.guards.run(consent(prepared.caseRoot));
  }
  expect(result.failed).toBe(true);
  expect(state.collectedRows).toBe(['close_failure', 'late_cleanup', 'registry_tamper'].includes(fault) ? 1 : 0);
  if (fault === 'late_cleanup' || fault === 'registry_tamper') {
    expect(result.cleanup_verified).toBe(false);
  }
  expect(state.closeCalls).toBe(1);
  expect(state.clockStops).toBe(1);
  expect(() => f.budget.reserve('flush', 1000, 200000)).toThrow('batch_stopped');
  if (fault === 'watch_loss') expect(state.signalled).toContain(800005);
  if (fault === 'control_replacement') {
    expect(result.reason).toBe('watch_receipt_control_identity');
  }
  if (fault === 'watch_loss_before_root') {
    expect(state.signalled).toEqual([]);
  }
  if (fault === 'overrun') {
    expect(result.observed_overshoot).toMatchObject({
      exec_overshoot: 1,
      lower_bound: true
    });
  }
  if (fault === 'eof' || fault === 'watch_loss') {
    expect(state.collectorCalls).toBe(0);
  }
}

test.each(['watch_loss', 'eof', 'consent_drift', 'close_failure', 'late_cleanup', 'registry_tamper', 'overrun', 'consent_expired', 'watch_loss_before_root'])(
  'latches failed batch and attempts every cleanup stage on %s',
  latchesEveryCleanupStage,
  collectionTimeoutMs
);

test.each(['overhead', 'owner_absent', 'unexpected_initial_receipt', 'control_replacement'])(
  'latches failed batch and attempts every cleanup stage on %s',
  latchesEveryCleanupStage
);

test(
  'seals only after helper registrations during teardown have settled',
  async () => {
    const f = fixture();
    const prepared = await f.guards.prepare();
    state.fault = 'late_registration';
    const result = await f.guards.run(consent(prepared.caseRoot));
    expect(result.failed, JSON.stringify(result)).toBe(false);
    expect(
      registryEntries()
        .filter(entry => entry.kind === 'pid')
        .map(entry => entry.pid)
    ).toEqual([800002, 800001, 800003, 800004, 800005, 800006]);
    expect(result.cleanup_verified).toBe(true);
  },
  collectionTimeoutMs
);

test('rejects genuine synthetic consent belonging to a different quota scope', async () => {
  const f = fixture();
  await f.guards.prepare();
  const foreign = mkdtempSync(join(realpathSync(tmpdir()), 'window-foreign-consent-'));
  roots.push(foreign);
  const result = await f.guards.run(consent(foreign));
  expect(result.reason).toBe('synthetic_scope_mismatch');
  expect(state.targetRegistered).toBe(false);
  expect(state.collectorCalls).toBe(0);
});

test('refuses alternate scenarios before target release and preserves the original batch clock', async () => {
  const f = fixture();
  const prepared = await f.guards.prepare();
  const input = consent(prepared.caseRoot);
  const result = await f.guards.run({ ...input, scenario: 'exec' });
  expect(result.failed).toBe(true);
  expect(state.targetRegistered).toBe(false);
  expect(state.collectorCalls).toBe(0);
  expect(result.batch_started_continuous_ms).toBe(f.batchStartedMs);
});

test(
  'simultaneous loss notifications abort collection and share one native stop origin',
  async () => {
    const f = fixture();
    const prepared = await f.guards.prepare();
    state.collectionBarrier = deferred<void>();
    state.collectionEntered = deferred<void>();
    const run = f.guards.run(consent(prepared.caseRoot));
    await state.collectionEntered.promise;
    state.loss?.('quota_owner_lost');
    state.watchOptions?.onRecord?.({
      kind: 'loss',
      code: 'guard_loss',
      seq: 2
    });
    state.collectionBarrier.resolve();
    const result = await run;
    expect(result.failed).toBe(true);
    expect(state.watchStops).toBe(1);
    expect(new Set(state.stopOrigins).size).toBe(1);
    expect(state.closeCalls).toBe(1);
  },
  collectionTimeoutMs
);

test(
  'a native result that still counts an unaccounted process fails the case even when it reports cleanup',
  async () => {
    const f = fixture();
    state.fault = 'unaccounted_cleanup';
    const prepared = await f.guards.prepare();
    const result = await f.guards.run(consent(prepared.caseRoot));
    expect(result.failed).toBe(true);
    expect(result.stop_batch).toBe(true);
    expect(result.cleanup_verified).toBe(false);
    expect(result.reason).toBe('watch_cleanup_unverified');
  },
  collectionTimeoutMs
);

test(
  'terminal restoration is derived from the target stdio, not assumed',
  async () => {
    const f = fixture();
    state.fault = 'tty_stdio';
    const prepared = await f.guards.prepare();
    const result = await f.guards.run(consent(prepared.caseRoot));
    expect(result.cleanup_verified).toBe(false);
  },
  collectionTimeoutMs
);

function exportRoot() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'window-export-'));
  roots.push(root);
  return root;
}

test(
  'bounded sanitized evidence leaves the image before its deletion and the export survives it',
  async () => {
    const destination = exportRoot();
    const f = fixture(0, destination);
    const prepared = await f.guards.prepare();
    const result = await f.guards.run(consent(prepared.caseRoot));
    expect(result.failed, JSON.stringify(result)).toBe(false);
    expect(existsSync(state.imagePath)).toBe(false);
    expect(result.evidence_export).toMatchObject({
      total_bytes: expect.any(Number) as number,
      files: [{ name: 'synthetic-case.json', bytes: expect.any(Number) as number, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) as string }]
    });
    expect(readFileSync(join(destination, 'synthetic-case.json'), 'utf8')).toContain('"trial_tokens_consumed":120');
    expect(existsSync(join(destination, 'manifest.json'))).toBe(true);
  },
  collectionTimeoutMs
);

test(
  'evidence that is not bounded JSON fails the case and exports nothing',
  async () => {
    const destination = exportRoot();
    const f = fixture(0, destination);
    state.fault = 'raw_evidence';
    const prepared = await f.guards.prepare();
    const result = await f.guards.run(consent(prepared.caseRoot));
    expect(result.failed).toBe(true);
    expect(result.reason).toBe('evidence_export_unsafe');
    expect(result.evidence_export).toBeNull();
    expect(existsSync(join(destination, 'raw.json'))).toBe(false);
  },
  collectionTimeoutMs
);

test(
  'no export is made unless a destination was authorized',
  async () => {
    const f = fixture();
    const prepared = await f.guards.prepare();
    const result = await f.guards.run(consent(prepared.caseRoot));
    expect(result.evidence_export).toBeNull();
  },
  collectionTimeoutMs
);
