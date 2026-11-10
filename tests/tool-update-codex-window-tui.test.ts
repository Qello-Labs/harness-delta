import { once } from 'node:events';
import { appendFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex } from 'node:stream';
import { afterEach, expect, test, vi } from 'vitest';
import { createSyntheticWindowTui, startWindowTui, verifyWindowSignalIdentity } from '../scripts/tool-update/codex-window-tui-adapter.mjs';

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});
function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'window-tui-'));
  directories.push(root);
  return createSyntheticWindowTui(root);
}
const witness = (session: ReturnType<typeof fixture>, event: string) => once(session.events, event);

test('two fixed inputs cross separate event barriers once even when the writable reports backpressure', async () => {
  const session = fixture();
  const write: unknown = Object.getOwnPropertyDescriptor(Duplex.prototype, 'write')?.value;
  if (typeof write !== 'function') {
    throw new Error('fixture_write_missing');
  }
  let submittedWrites = 0;
  vi.spyOn(Duplex.prototype, 'write').mockImplementation(function (
    this: Duplex,
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void
  ) {
    const result: unknown = Reflect.apply(write, this, [chunk, encodingOrCallback, callback]);
    if (typeof result !== 'boolean') {
      throw new Error('fixture_write_result_invalid');
    }
    if (Buffer.isBuffer(chunk) && chunk.toString('utf8').startsWith('synthetic-window-input')) {
      submittedWrites += 1;
      return false;
    }
    return result;
  });
  const ready = witness(session, 'ready');
  session.start();
  try {
    await ready;
    await expect(session.submit()).rejects.toThrow('baseline_missing');
    session.releaseSyntheticBaseline();
    const first = witness(session, 'input');
    const submitted = session.submit();
    await expect(session.submit()).rejects.toThrow('input_reused');
    await submitted;
    await first;
    await expect(session.submit()).rejects.toThrow('input_reused');
    session.releaseSyntheticSecondInput();
    const second = witness(session, 'second_input');
    await session.submit();
    await second;
    await expect(session.submit()).rejects.toThrow('input_reused');
    await session.quit();
    expect(await session.completed).toMatchObject({
      normal_quit: true,
      identities_gone: true,
      actual_qualification: false
    });
    expect(await session.completed).toMatchObject({
      origin: 'synthetic',
      actual_qualification: false,
      normal_quit: true,
      signal_sent: false,
      ownership_verified: true,
      identities_gone: true
    });
    expect(submittedWrites).toBe(2);
  } finally {
    session.stop();
    await session.completed;
  }
}, 20_000);

for (const point of ['before_start', 'before_signal'] as const) {
  test(
    `owned fixture byte drift at ${point} refuses without sending a signal`,
    async () => {
      const root = mkdtempSync(join(realpathSync(tmpdir()), 'window-tui-drift-'));
      directories.push(root);
      const session = createSyntheticWindowTui(root);
      if (point === 'before_start') {
        appendFileSync(join(root, 'tui-fixture.mjs'), '\n// synthetic mutation\n');
        expect(() => session.start()).toThrow('pin_drift');
        return;
      }
      const ready = witness(session, 'ready');
      session.start();
      try {
        await ready;
        session.releaseSyntheticBaseline();
        const input = witness(session, 'input');
        await session.submit();
        await input;
        appendFileSync(join(root, 'tui-fixture.mjs'), '\n// synthetic mutation\n');
        expect(() => session.interrupt()).toThrow('pin_drift');
        session.stop();
        expect(await session.completed).toMatchObject({
          signal_sent: false,
          identities_gone: true
        });
      } finally {
        session.stop();
        await session.completed;
      }
    },
    point === 'before_signal' ? 20_000 : 5000
  );
}

test('exactly one real SIGINT reaches the owned foreground group and produces a separate handler acknowledgement', async () => {
  const session = fixture();
  const ready = witness(session, 'ready');
  const signalReady = witness(session, 'signal_ready');
  session.start();
  try {
    await ready;
    await signalReady;
    session.releaseSyntheticBaseline();
    const input = witness(session, 'input');
    await session.submit();
    await input;
    const interrupted = witness(session, 'interrupted');
    await session.interrupt();
    await interrupted;
    expect(() => session.interrupt()).toThrow('signal_reused');
    await session.quit();
    expect(await session.completed).toMatchObject({
      signal_sent: true,
      interruption_observed: true,
      ownership_verified: true,
      identities_gone: true,
      termination_cause: 'root_exit',
      actual_qualification: false
    });
  } finally {
    session.stop();
    await session.completed;
  }
}, 20_000);

test.each(['pid', 'parent', 'pgid', 'foreground', 'uid', 'session', 'started'])('identity mismatch in %s refuses before signal delivery', field => {
  const launch = {
    pid: 123,
    parent: 99,
    pgid: 123,
    foreground: 123,
    uid: 501,
    session: 123,
    started: 'synthetic-start'
  };
  const observed = {
    ...launch,
    [field]: field === 'started' ? 'replacement-start' : 124
  };
  expect(() => verifyWindowSignalIdentity(launch, observed)).toThrow('signal_identity_unproven');
});

test('the production adapter cannot launch a vendor from portable inputs', () => {
  expect(() => startWindowTui()).toThrow('b1_execution_disabled');
});

test('unproven SIGINT targeting refuses without relabeling control EOF as a signal', async () => {
  const session = fixture();
  const ready = witness(session, 'ready');
  session.start();
  try {
    await ready;
    expect(() => session.interrupt()).toThrow('signal_identity_unproven');
    session.stop();
    expect(await session.completed).toMatchObject({
      origin: 'synthetic',
      normal_quit: false,
      signal_sent: false,
      ownership_verified: true,
      identities_gone: true,
      termination_cause: 'control'
    });
  } finally {
    session.stop();
    await session.completed;
  }
}, 20_000);
