import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { expect, test } from 'vitest';
import { createWindowClock } from '../scripts/tool-update/codex-window-clock.mjs';

test('coordinator reads continuous native time through the production transport seam', async () => {
  const peer = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new Writable({
      write(chunk, _encoding, callback) {
        const [, id] = String(chunk).trim().split(' ');
        queueMicrotask(() =>
          peer.stdout.write(
            JSON.stringify({
              kind: 'clock',
              id: Number(id),
              now_ns: '12345678901234567',
              seq: 2
            }) + '\n'
          )
        );
        callback();
      }
    })
  });
  const clock = createWindowClock({
    nativePath: '/owned/guard',
    transport: () => peer
  });
  peer.stdout.write('{"kind":"ready","mode":"clock","now_ns":"100","seq":1}\n');
  await clock.ready;
  expect(await clock.clock()).toBe(12345678901234567n);
  peer.emit('exit', 0, null);
  expect((await clock.result).failed).toBe(true);
});
