import { execFileSync, spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ClaudeWindowImageStat, ClaudeWindowProcessMetadata } from '../src/claude-process-binary.js';
import { activateOrdinaryWindowDecision } from '../src/core/ordinary-window-activation.js';
import { revokeOrdinaryWindowActivation } from '../src/core/ordinary-window-store.js';
import { createClaudeWindowFixture } from './helpers/claude-window-fixture.js';
import { windowTrialPacket } from './helpers/ordinary-window-decision-fixture.js';

vi.mock('node:child_process', { spy: true });
const pinCalls = vi.hoisted(() => ({ count: 0, at: 0, effect: (): void => undefined }));
vi.mock('../src/claude-process-binary.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/claude-process-binary.js')>();
  return {
    ...actual,
    ClaudeWindowBinaryReader: class extends actual.ClaudeWindowBinaryReader {
      override snapshot(pid: number) {
        if (++pinCalls.count === pinCalls.at) pinCalls.effect();
        return super.snapshot(pid);
      }
    }
  };
});

type Fixture = ReturnType<typeof createClaudeWindowFixture>;
type Operation = 'connect' | 'collect';
interface Drift {
  readonly label: string;
  readonly apply: (fixture: Fixture) => void;
}
const fixtures: Fixture[] = [];

beforeEach(() => {
  pinCalls.count = 0;
  pinCalls.at = 0;
  pinCalls.effect = () => undefined;
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

async function fixture(operation: Operation, trial = false) {
  const f = createClaudeWindowFixture();
  fixtures.push(f);
  if (trial) {
    activateOrdinaryWindowDecision(f.store, windowTrialPacket(f.selection, { nativeRootId: f.nativeSessionId }), f.clock());
  } else f.activate();
  f.life.start(f.taskId);
  await { connect: () => Promise.resolve(), collect: () => f.connect() }[operation]();
  f.advance();
  f.append([f.assistant('candidate-request')]);
  return f;
}

const statChanges: readonly { readonly label: string; readonly value: Partial<ClaudeWindowImageStat> }[] = [
  { label: 'device', value: { device: 4 } },
  { label: 'inode', value: { inode: 8 } },
  { label: 'size', value: { size: 65 } },
  { label: 'mode', value: { mode: 0o744 } },
  { label: 'mtime', value: { mtimeMs: 12 } },
  { label: 'ctime', value: { ctimeMs: 13 } },
  { label: 'regular file', value: { regularFile: false } }
];
const processChanges: readonly { readonly label: string; readonly pid: number; readonly value: Partial<ClaudeWindowProcessMetadata> }[] = [
  { label: 'process pid', pid: 3107, value: { pid: 3108 } },
  { label: 'process uid', pid: 3107, value: { uid: 502 } },
  { label: 'process start', pid: 3107, value: { start: 'replacement-start' } },
  { label: 'process parent', pid: 3107, value: { parentPid: 3199 } },
  { label: 'parent pid', pid: 3106, value: { pid: 3199 } },
  { label: 'parent uid', pid: 3106, value: { uid: 502 } },
  { label: 'parent start', pid: 3106, value: { start: 'replacement-parent-start' } },
  { label: 'parent ancestor', pid: 3106, value: { parentPid: 3199 } }
];
const drifts: readonly Drift[] = [
  ...statChanges.map(({ label, value }) => ({
    label,
    apply: (f: Fixture) => {
      const stat = f.binary.adapters.stat.bind(f.binary.adapters);
      vi.spyOn(f.binary.adapters, 'stat').mockImplementation(path => ({ ...stat(path), ...value }));
    }
  })),
  ...processChanges.map(({ label, pid, value }) => ({
    label,
    apply: (f: Fixture) => {
      const read = f.binary.adapters.readProcess.bind(f.binary.adapters);
      vi.spyOn(f.binary.adapters, 'readProcess').mockImplementation(input => {
        const process = read(input);
        return process && input === pid ? { ...process, ...value } : process;
      });
    }
  })),
  { label: 'realpath', apply: f => vi.spyOn(f.binary.adapters, 'realpath').mockReturnValue('/synthetic/replacement') },
  {
    label: 'image path',
    apply: f => vi.spyOn(f.binary.adapters, 'readImage').mockReturnValue({ path: '/synthetic/replacement', layout: 'standalone', requiredHost: null })
  },
  {
    label: 'image layout',
    apply: f => vi.spyOn(f.binary.adapters, 'readImage').mockReturnValue({ path: '/synthetic/claude/standalone/claude', layout: 'wrapper', requiredHost: null })
  },
  {
    label: 'image host',
    apply: f =>
      vi
        .spyOn(f.binary.adapters, 'readImage')
        .mockReturnValue({ path: '/synthetic/claude/standalone/claude', layout: 'standalone', requiredHost: '/synthetic/host' })
  },
  { label: 'missing image', apply: f => vi.spyOn(f.binary.adapters, 'readImage').mockReturnValue(null) },
  { label: 'missing current uid', apply: f => vi.spyOn(f.binary.adapters, 'currentUid').mockReturnValue(null) },
  ...[3107, 3106].map(pid => ({
    label: `missing process ${pid}`,
    apply: (f: Fixture) => {
      const read = f.binary.adapters.readProcess.bind(f.binary.adapters);
      vi.spyOn(f.binary.adapters, 'readProcess').mockImplementation(input => (input === pid ? null : read(input)));
    }
  })),
  ...(['currentUid', 'readProcess', 'readImage', 'realpath', 'stat'] as const).map(method => ({
    label: `failed ${method}`,
    apply: (f: Fixture) => {
      vi.spyOn(f.binary.adapters, method).mockImplementation(() => {
        throw new Error('synthetic_adapter_failure');
      });
    }
  }))
];
const operations = [
  { operation: 'connect', pins: [2, 3, 4, 5, 6] },
  { operation: 'collect', pins: [2, 3, 4] }
] as const;

function atPin(pin: number, effect: () => void) {
  pinCalls.count = 0;
  pinCalls.at = pin;
  pinCalls.effect = effect;
  return () => pinCalls.count;
}

function expectRejectedState(f: Fixture, before: ReturnType<Fixture['usageState']>, cursors: ReturnType<Fixture['usageState']>['cursors']) {
  const after = f.usageState();
  expect(after.events).toEqual(before.events);
  expect(after.requests).toEqual(before.requests);
  expect(after.exclusions).toEqual(before.exclusions);
  expect(after.cursors).toEqual(cursors);
  expect(f.store.all('SELECT state FROM binding_root_segments')).toEqual([{ state: 'paused' }]);
  expect(f.store.all('SELECT root_session_id FROM ordinary_window_segments')).toHaveLength(cursors.length);
  expect(f.store.all<{ state: string }>('SELECT state FROM session_bindings').map(row => row.state)).toEqual(cursors.map(() => 'stopped'));
}

describe.each(operations)('$operation retains every original revalidation boundary', ({ operation, pins }) => {
  test.each(drifts.flatMap(drift => pins.map(pin => ({ ...drift, pin }))))('rejects $label at pin $pin', async ({ apply, pin }) => {
    const f = await fixture(operation);
    const before = f.usageState();
    const calls = atPin(pin, () => apply(f));

    await expect({ connect: () => f.connect(), collect: () => f.collect() }[operation]()).rejects.toThrow('binding_executable_changed');

    expect(calls()).toBe(pin);
    expect(f.binary.operations.filter(name => name === 'signature')).toHaveLength(operation === 'connect' ? 1 : 2);
    expectRejectedState(f, before, operation === 'collect' ? before.cursors : pin === 2 ? [] : [{ cursor: null }]);
  });

  test.each(
    pins.flatMap(pin => [
      { pin, expiry: false },
      { pin, expiry: true }
    ])
  )('rejects authorization loss at pin $pin, expiry=$expiry', async ({ pin, expiry }) => {
    const f = await fixture(operation, expiry);
    const before = f.usageState();
    let nativeCalls = -1;
    const calls = atPin(pin, () => {
      if (expiry) f.advance(60000);
      else revokeOrdinaryWindowActivation(f.store, f.taskId, f.clock());
      nativeCalls = f.binary.operations.length;
    });

    await expect({ connect: () => f.connect(), collect: () => f.collect() }[operation]()).rejects.toThrow(
      expiry ? 'binding_window_trial_expired' : 'binding_scope_revoked'
    );

    expect(calls()).toBe(pin);
    expect(f.binary.operations).toHaveLength(nativeCalls);
    expectRejectedState(f, before, operation === 'collect' ? before.cursors : pin === 2 ? [] : [{ cursor: null }]);
  });
});
