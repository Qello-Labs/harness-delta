import { EventEmitter } from 'node:events';
import { lstatSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { createWindowImageGuardian } from '../scripts/tool-update/codex-window-image-owner.mjs';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});
function fixture(foreign = false, deadline?: number) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'image-owner-'));
  roots.push(root);
  const model = { mounted: false, recovered: 0 };
  class Owner extends EventEmitter {
    readonly pid = 43210;
    connected = true;
    send(input: unknown) {
      const message = z.object({ kind: z.string() }).parse(input);
      if (message.kind === 'start') {
        writeFileSync(join(root, 'volume.sparseimage'), '', {
          mode: 0o600
        });
        const image = lstatSync(join(root, 'volume.sparseimage'));
        const directory = lstatSync(root);
        queueMicrotask(() =>
          this.emit('message', {
            kind: 'created',
            record: {
              root_dev: directory.dev,
              root_ino: directory.ino,
              image_dev: image.dev,
              image_ino: image.ino + (foreign ? 1 : 0)
            }
          })
        );
      } else if (message.kind === 'authorize-attach') {
        model.mounted = true;
        queueMicrotask(() => this.emit('message', { kind: 'mounted' }));
      } else if (message.kind === 'stop') {
        model.mounted = false;
        queueMicrotask(() => this.emit('exit', 0, null));
      } else throw new Error('unexpected_message');
      return true;
    }
    disconnect() {
      this.connected = false;
      model.mounted = false;
      queueMicrotask(() => this.emit('exit', 0, null));
    }
    kill() {
      this.connected = false;
      queueMicrotask(() => this.emit('exit', null, 'SIGKILL'));
      return true;
    }
  }
  const owner = new Owner();
  const guardian = createWindowImageGuardian(root, {
    ...(deadline === undefined ? {} : { deadline }),
    launch: () => {
      queueMicrotask(() => owner.emit('message', { kind: 'ready' }));
      return owner;
    },
    recover: (receivedRoot: string) => {
      if (receivedRoot !== root) throw new Error('foreign_root');
      model.recovered++;
      model.mounted = false;
      return Promise.resolve({ detached: true });
    }
  });
  return { guardian, owner, model };
}

test('the independent peer verifies detachment after normal owner completion', async () => {
  const f = fixture();
  await f.guardian.start();
  expect(f.model.mounted).toBe(true);
  await f.guardian.close();
  expect(f.model).toEqual({ mounted: false, recovered: 1 });
  expect(f.guardian.summary()).toMatchObject({ detached: true });
});

test('a verified mount retires its startup watchdog while its authorized lifetime remains live', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(1000);
  const f = fixture(false, 181000);
  const killed = vi.spyOn(f.owner, 'kill');
  try {
    await f.guardian.start();
    await vi.advanceTimersByTimeAsync(60000);
    expect(killed).not.toHaveBeenCalled();
    expect(f.model.mounted).toBe(true);
    expect(f.guardian.summary().code).toBeNull();
  } finally {
    await f.guardian.close();
  }
});

test('the lifetime watchdog uses the original authorized deadline without a fresh allowance after mounting', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(1000);
  const f = fixture(false, 1500);
  const killed = vi.spyOn(f.owner, 'kill');
  const closed = f.guardian.closed;
  try {
    await f.guardian.start();
    await vi.advanceTimersByTimeAsync(499);
    expect(killed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(killed).toHaveBeenCalledOnce();
    expect(await closed).toMatchObject({
      detached: true,
      code: 'image_owner_deadline'
    });
  } finally {
    await f.guardian.close();
  }
});

test.each(['disconnect', 'kill'] as const)('a prearmed owner %s loss reclaims only the recorded owned image', async mode => {
  const f = fixture();
  await f.guardian.start();
  const closed = f.guardian.closed;
  if (mode === 'disconnect') f.owner.disconnect();
  else f.owner.kill();
  expect(await closed).toMatchObject({ detached: true });
  expect(f.model).toEqual({ mounted: false, recovered: 1 });
});

test('an invalid image identity cannot authorize attachment or recovery of a foreign resource', async () => {
  const f = fixture(true);
  await expect(f.guardian.start()).rejects.toThrow('image_ownership_unverified');
  await f.guardian.closed;
  expect(f.model.mounted).toBe(false);
  expect(f.model.recovered).toBe(0);
});
