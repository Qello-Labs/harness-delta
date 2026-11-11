import { EventEmitter, once } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { expect, test } from 'vitest';
import { createWindowWatch } from '../scripts/tool-update/codex-window-watch.mjs';

class NativePeer extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  commands: string[] = [];
  stdin = new Writable({
    write: (chunk, _encoding, callback) => {
      this.commands.push(String(chunk).trim());
      this.emit('command', String(chunk).trim());
      callback();
    }
  });
  seq = 0;
  packet(packet: Record<string, unknown>) {
    this.stdout.write(JSON.stringify({ ...packet, seq: ++this.seq }) + '\n');
  }
}

const identity = {
  pid: 800,
  parent: 700,
  pgid: 800,
  uid: 501,
  start_sec: 123,
  start_usec: 456
};
const final = {
  kind: 'final',
  execs: 15,
  live: 0,
  receipts: 0,
  lower_bound: true,
  unaccounted: 0,
  failed: false,
  stop_batch: false,
  cleanup_verified: true,
  term_ms: 1,
  kill_ms: null,
  disappearance_ms: 2
};

function barrier() {
  const events = new EventEmitter();
  return {
    promise: once(events, 'ready').then(() => undefined),
    resolve: () => events.emit('ready')
  };
}

function fixture(onResource: (value: typeof identity) => void | Promise<void> = () => {}, onOwnerResource?: (value: typeof identity) => Promise<void>) {
  const peer = new NativePeer();
  const watch = createWindowWatch({
    nativePath: '/owned/guard',
    receiptDirectory: '/owned/receipts',
    executable: '/owned/synthetic',
    args: [],
    priorExecs: 14,
    deadlineNs: '100000000000',
    transport: () => peer,
    onResource,
    ...(onOwnerResource ? { onOwnerResource } : {})
  });
  return { peer, watch };
}

test('does not release suspended root before registry acknowledgement', async () => {
  const ack = barrier();
  const registered = barrier();
  const { peer, watch } = fixture(async () => {
    registered.resolve();
    await ack.promise;
  });
  peer.packet({ kind: 'ready', mode: 'watch', now_ns: '100' });
  await watch.ready;
  const sent = once(peer, 'command');
  const launched = watch.launch();
  await sent;
  peer.packet({ kind: 'identity', identity });
  peer.packet({ kind: 'phase', phase: 'root-suspended' });
  await registered.promise;
  expect(peer.commands).toEqual(['LAUNCH']);
  ack.resolve();
  await launched;
  expect(peer.commands).toEqual(['LAUNCH', 'RESUME']);
  peer.packet(final);
  peer.emit('exit', 0, null);
  expect((await watch.result).cleanup_verified).toBe(true);
});

test('watcher owner is registered before launch readiness', async () => {
  const registered = barrier();
  const ack = barrier();
  const { peer, watch } = fixture(
    async () => {},
    async () => {
      registered.resolve();
      await ack.promise;
    }
  );
  peer.packet({
    kind: 'ready',
    mode: 'watch',
    now_ns: '100',
    owner: identity
  });
  const launched = watch.launch();
  void launched.catch(() => {});
  await registered.promise;
  expect(peer.commands).toEqual([]);
  ack.resolve();
  await watch.ready;
  peer.packet({ kind: 'loss', code: 'guard_loss' });
  peer.packet(final);
  peer.emit('exit', 2, null);
  expect((await watch.result).failed).toBe(true);
});

test.each([
  '{"kind":"ready","mode":"watch","now_ns":"1","seq":2}\n',
  '{"kind":"ready","mode":"watch","now_ns":"1","seq":1,"body":"secret"}\n',
  'x'.repeat(4097)
])('protocol corruption stops and never reports positive cleanup', async raw => {
  const { peer, watch } = fixture();
  peer.stdout.write(raw);
  peer.emit('exit', 2, null);
  const result = await watch.result;
  expect(result.failed).toBe(true);
  expect(result.stop_batch).toBe(true);
  expect(result.cleanup_verified).toBe(false);
  expect(peer.commands).toEqual(['STOP']);
});

test('native exit without final is guard loss even after readiness', async () => {
  const { peer, watch } = fixture();
  peer.packet({ kind: 'ready', mode: 'watch', now_ns: '10' });
  await watch.ready;
  peer.emit('exit', 0, null);
  expect(await watch.result).toMatchObject({
    failed: true,
    stop_batch: true,
    cleanup_verified: false
  });
});

test('invalid receipt-control birth identity is refused before starting a helper', () => {
  const peer = new NativePeer();
  let started = false;
  try {
    expect(() =>
      createWindowWatch({
        nativePath: '/owned/guard',
        receiptDirectory: '/owned/receipts',
        executable: '/owned/synthetic',
        priorExecs: 0,
        deadlineNs: '100000000000',
        receiptControl: {
          dev: 1,
          ino: 2,
          uid: 501,
          birthSec: 1,
          birthNsec: 1000000000
        },
        onResource() {},
        transport() {
          started = true;
          return peer;
        }
      })
    ).toThrow('watch_options');
  } finally {
    peer.emit('exit', 2, null);
  }
  expect(started).toBe(false);
});

test('native process inspection returns a birth identity for registry admission', async () => {
  const { peer, watch } = fixture();
  peer.packet({ kind: 'ready', mode: 'watch', now_ns: '100' });
  await watch.ready;
  const sent = once(peer, 'command');
  try {
    const inspected = watch.inspect(identity.pid);
    await sent;
    peer.packet({ kind: 'process', id: 1, identity, now_ns: '101' });
    expect(await inspected).toEqual(identity);
  } finally {
    peer.emit('exit', 2, null);
  }
});

test('independent native cleanup signals only the supplied birth identity', async () => {
  const { peer, watch } = fixture();
  peer.packet({ kind: 'ready', mode: 'watch', now_ns: '100' });
  await watch.ready;
  const sent = once(peer, 'command');
  try {
    const delivered = watch.signal(identity, 'KILL');
    await sent;
    peer.packet({ kind: 'signal', id: 1, outcome: 'sent', now_ns: '102' });
    expect(await delivered).toMatchObject({
      outcome: 'sent',
      now_ns: '102'
    });
  } finally {
    peer.emit('exit', 2, null);
  }
});

test('trial expiry can shorten but never extend the native deadline', async () => {
  const { peer, watch } = fixture();
  peer.packet({ kind: 'ready', mode: 'watch', now_ns: '100' });
  await watch.ready;
  try {
    await watch.shortenDeadline('5000');
    await expect(watch.shortenDeadline('5001')).rejects.toThrow('watch_deadline_extension');
    expect(peer.commands).toEqual(['DEADLINE 5000']);
  } finally {
    peer.emit('exit', 2, null);
  }
});

test('a regressing native clock stops the batch instead of extending deadlines', async () => {
  const { peer, watch } = fixture();
  peer.packet({ kind: 'ready', mode: 'watch', now_ns: '100' });
  await watch.ready;
  const sent = once(peer, 'command');
  const reading = watch.clock();
  await sent;
  try {
    peer.packet({ kind: 'clock', id: 1, now_ns: '99' });
    await expect(reading).rejects.toThrow('watch_clock_regression');
  } finally {
    peer.emit('exit', 2, null);
  }
  expect((await watch.result).stop_batch).toBe(true);
});

test('root resume without a registered identity is refused', async () => {
  const { peer, watch } = fixture();
  peer.packet({ kind: 'ready', mode: 'watch', now_ns: '10' });
  await watch.ready;
  const sent = once(peer, 'command');
  const launched = watch.launch();
  await sent;
  peer.packet({ kind: 'phase', phase: 'root-suspended' });
  await expect(launched).rejects.toThrow('watch_protocol');
  peer.packet(final);
  peer.emit('exit', 0, null);
  expect((await watch.result).failed).toBe(true);
  expect(peer.commands).toEqual(['LAUNCH', 'STOP']);
});

test('native closure remains bounded when a registry callback never returns', async () => {
  const registered = barrier();
  const { peer, watch } = fixture(async () => {
    registered.resolve();
    await new Promise<void>(() => {});
  });
  peer.packet({ kind: 'ready', mode: 'watch', now_ns: '10' });
  await watch.ready;
  const sent = once(peer, 'command');
  const launched = watch.launch();
  void launched.catch(() => {});
  await sent;
  peer.packet({ kind: 'identity', identity });
  await registered.promise;
  peer.packet(final);
  peer.emit('exit', 0, null);
  expect((await watch.result).failed).toBe(true);
});

test.each(['term_ms', 'kill_ms', 'disappearance_ms'] as const)('late %s fails despite a successful native result', async field => {
  const { peer, watch } = fixture();
  peer.packet({ kind: 'ready', mode: 'watch', now_ns: '10' });
  await watch.ready;
  peer.packet({
    ...final,
    [field]: { term_ms: 251, kill_ms: 2251, disappearance_ms: 5001 }[field]
  });
  peer.emit('exit', 0, null);
  expect(await watch.result).toMatchObject({
    failed: true,
    stop_batch: true
  });
});

test.each([
  {
    execs: 17,
    live: 1,
    receipts: 0,
    exec_overshoot: 2,
    live_overshoot: 0,
    receipt_overshoot: 0
  },
  {
    execs: 15,
    live: 17,
    receipts: 0,
    exec_overshoot: 0,
    live_overshoot: 1,
    receipt_overshoot: 0
  },
  {
    execs: 15,
    live: 1,
    receipts: 18,
    exec_overshoot: 0,
    live_overshoot: 0,
    receipt_overshoot: 2
  }
])('first count overrun fails even if native final claims success', async count => {
  const { peer, watch } = fixture();
  peer.packet({ kind: 'ready', mode: 'watch', now_ns: '10' });
  await watch.ready;
  peer.packet({
    kind: 'count',
    ...count,
    lower_bound: true
  });
  peer.packet(final);
  peer.emit('exit', 0, null);
  expect(await watch.result).toMatchObject({
    failed: true,
    stop_batch: true
  });
  expect(peer.commands).toEqual(['STOP']);
});

test('rejected registry acknowledgement stops without resume', async () => {
  const registered = barrier();
  const { peer, watch } = fixture(() => {
    registered.resolve();
    return Promise.reject(new Error('registry_refused'));
  });
  peer.packet({ kind: 'ready', mode: 'watch', now_ns: '10' });
  await watch.ready;
  const sent = once(peer, 'command');
  const launched = watch.launch();
  await sent;
  peer.packet({ kind: 'identity', identity });
  peer.packet({ kind: 'phase', phase: 'root-suspended' });
  await registered.promise;
  await expect(launched).rejects.toThrow('registry');
  peer.packet(final);
  peer.emit('exit', 0, null);
  expect((await watch.result).failed).toBe(true);
  expect(peer.commands).toEqual(['LAUNCH', 'STOP']);
});

test('a live process outside the discovered tree fails the case and denies positive cleanup', async () => {
  const losses: string[] = [];
  const peer = new NativePeer();
  const watch = createWindowWatch({
    nativePath: '/owned/guard',
    receiptDirectory: '/owned/receipts',
    executable: '/owned/synthetic',
    priorExecs: 0,
    deadlineNs: '100000000000',
    transport: () => peer,
    onResource: () => {},
    onRecord: event => {
      if (event.kind === 'loss') losses.push(event.code);
    }
  });
  peer.packet({ kind: 'ready', mode: 'watch', now_ns: '10' });
  await watch.ready;
  peer.packet({ kind: 'loss', code: 'unaccounted' });
  peer.packet({ ...final, unaccounted: 1 });
  peer.emit('exit', 2, null);
  expect(await watch.result).toMatchObject({
    unaccounted: 1,
    failed: true,
    stop_batch: true,
    cleanup_verified: false
  });
  expect(losses).toEqual(['unaccounted']);
});

test('a native success that still reports an unaccounted process is not a clean result', async () => {
  const { peer, watch } = fixture();
  peer.packet({ kind: 'ready', mode: 'watch', now_ns: '10' });
  await watch.ready;
  peer.packet({ ...final, unaccounted: 3 });
  peer.emit('exit', 0, null);
  expect(await watch.result).toMatchObject({
    failed: true,
    stop_batch: true,
    cleanup_verified: false
  });
});

test('a final record without the unaccounted count is protocol corruption', async () => {
  const { peer, watch } = fixture();
  peer.packet({ kind: 'ready', mode: 'watch', now_ns: '10' });
  await watch.ready;
  const legacy = Object.fromEntries(Object.entries(final).filter(([key]) => key !== 'unaccounted'));
  peer.packet(legacy);
  peer.emit('exit', 0, null);
  expect(await watch.result).toMatchObject({
    failed: true,
    stop_batch: true,
    cleanup_verified: false
  });
});
