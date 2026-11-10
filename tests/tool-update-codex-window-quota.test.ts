import * as fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { createOwnedWindowQuota } from '../scripts/tool-update/codex-window-quota.mjs';
import type { WindowTool } from '../scripts/tool-update/codex-window-containment.mjs';
import { createWindowQuotaGuardian, ownWindowQuota } from '../scripts/tool-update/codex-window-quota-owner.mjs';

function deferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  let reject: ((reason: unknown) => void) | undefined;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  if (!resolve || !reject) throw new Error('fixture_resolver_missing');
  return { promise, resolve, reject };
}

class QuotaPort extends EventEmitter {
  connected = true;
  peer?: QuotaPort;
  send(input: unknown, callback?: (error: Error | null) => void) {
    const peer = this.peer;
    if (!peer || !this.connected) throw new Error('disconnected_fixture');
    queueMicrotask(() => {
      peer.emit('message', input);
      callback?.(null);
    });
    return true;
  }
  disconnect() {
    this.connected = false;
    this.emit('disconnect');
    if (this.peer?.connected) {
      this.peer.connected = false;
      this.peer.emit('disconnect');
    }
  }
}

function ownedPeer(f: ReturnType<typeof fixture>) {
  const coordinator = new QuotaPort(),
    owner = new QuotaPort();
  coordinator.peer = owner;
  owner.peer = coordinator;
  const completed = deferred<Awaited<ReturnType<typeof ownWindowQuota>>>();
  const guardian = createWindowQuotaGuardian(f.root, {
    launch: () => {
      queueMicrotask(() => {
        void ownWindowQuota(f.root, owner, f).then(
          result => {
            completed.resolve(result);
            coordinator.emit('exit', result.failure ? 2 : 0, null);
          },
          error => {
            completed.reject(error);
            coordinator.emit('exit', 2, null);
          }
        );
      });
      return coordinator;
    }
  });
  return { guardian, coordinator, owner, completed: completed.promise };
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const names = ['HarnessQuotaBase', 'HarnessQuotaState'];

function containerList(
  fault: string,
  state: {
    readonly mounted: boolean;
    readonly quota: number;
    readonly capacity: number;
  }
) {
  return {
    Containers: [
      {
        ContainerReference: 'disk72',
        APFSContainerUUID: fault === 'uuid' && state.mounted ? 'changed' : 'container-uuid',
        CapacityCeiling: fault === 'capacity' ? 4294967297 : state.capacity,
        PhysicalStores: [
          {
            DeviceIdentifier: fault === 'store' ? 'disk99s1' : 'disk71s1'
          }
        ],
        Volumes: names.slice(0, state.quota ? 2 : 1).map((Name, i) => ({
          Name,
          DeviceIdentifier: `disk72s${i + 1}`,
          APFSVolumeUUID: `volume-${i}`,
          CapacityQuota: i ? (fault === 'quota' ? state.quota + 1 : state.quota) : 0
        }))
      }
    ]
  };
}

function attachmentEntities(state: { readonly mounted: boolean; readonly quota: number; readonly fault: string; readonly mounts: string }) {
  return [
    { 'dev-entry': '/dev/disk71', 'content-hint': 'GUID_partition_scheme' },
    { 'dev-entry': '/dev/disk71s1', 'content-hint': 'different_info_hint' },
    { 'dev-entry': '/dev/disk72', 'content-hint': 'container' },
    ...names.slice(0, state.quota ? 2 : 1).map((name, i) => ({
      'dev-entry': `/dev/disk72s${i + 1}`,
      ...(state.mounted
        ? {
            'mount-point': state.fault === 'global' && i === 1 ? `/Volumes/${name}` : join(state.mounts, name)
          }
        : {})
    }))
  ];
}

function fixture(fault = '') {
  const root = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'window-quota-'));
  roots.push(root);
  const image = join(root, 'volume.sparseimage');
  const mounts = join(root, 'mounts');
  let attached = false,
    mounted = false,
    quota = 0,
    capacity = 0,
    ownersOff = false;
  let detachments = 0,
    deleted = false;
  const entities = () => attachmentEntities({ mounted, quota, fault, mounts });
  const run: WindowTool = (command, args, options) => {
    expect(options?.timeoutMs).toBeGreaterThan(0);
    expect(options?.timeoutMs).toBeLessThanOrEqual(45000);
    let output: unknown = {};
    if (command === '/usr/bin/plutil') {
      return Promise.resolve({ code: 0, stdout: options?.input ?? '' });
    }
    if (command === '/usr/bin/hdiutil') {
      switch (args[0]) {
        case 'create':
          capacity = args[args.indexOf('-size') + 1] === '4g' ? 4294967296 : 0;
          fs.writeFileSync(image, '', { mode: 0o600, flag: 'wx' });
          break;
        case 'attach':
          attached = true;
          mounted = !args.includes('-nomount');
          ownersOff = args[args.indexOf('-owners') + 1] === 'off';
          if (mounted) {
            for (const name of names) {
              fs.mkdirSync(join(mounts, name), { mode: 0o755 });
            }
          }
          output = {
            'system-entities': entities().map(row => (row['dev-entry'] === '/dev/disk71s1' ? { ...row, 'content-hint': 'Apple_APFS' } : row))
          };
          if (fault === 'attach') {
            return Promise.resolve({
              code: 1,
              stdout: JSON.stringify(output)
            });
          }
          break;
        case 'info':
          output = {
            images: attached
              ? [
                  {
                    'image-path': image,
                    'system-entities': entities()
                  }
                ]
              : []
          };
          if (fault === 'foreign' && attached) {
            output = {
              images: [
                {
                  'image-path': image,
                  'system-entities': entities()
                },
                {
                  'image-path': '/foreign.sparseimage',
                  'system-entities': [
                    {
                      'dev-entry': '/dev/disk71s1'
                    }
                  ]
                }
              ]
            };
          }
          break;
        case 'detach':
          expect(args[1]).toBe('/dev/disk71');
          if (fault === 'detach') {
            return Promise.resolve({ code: 1, stdout: '' });
          }
          if (fault !== 'sticky') attached = mounted = false;
          detachments++;
          break;
        default:
          throw new Error('unexpected_hdiutil_operation');
      }
    } else if (command === '/usr/sbin/diskutil') {
      if (args[0] === 'info') {
        output = { APFSContainerReference: 'disk72' };
      } else if (args[1] === 'addVolume') {
        if (!args.includes('-nomount')) {
          throw new Error('global_mount_attempt');
        }
        quota = Number(args[args.indexOf('-quota') + 1]);
        if (fault === 'add') {
          return Promise.resolve({ code: 1, stdout: '' });
        }
      } else if (args[1] === 'list') {
        output = containerList(fault, { mounted, quota, capacity });
      } else throw new Error('unexpected_diskutil_operation');
    } else throw new Error('unexpected_tool');
    return Promise.resolve({ code: 0, stdout: JSON.stringify(output) });
  };
  const storage = {
    ...fs,
    lstatSync(path: string) {
      const stat = fs.lstatSync(path);
      if (mounted && path.startsWith(`${mounts}/`)) {
        stat.dev += fault === 'same_device' ? 0 : 100;
        if (fault === 'private_device' && path.endsWith('/private')) {
          stat.dev += 1;
        }
        if (!ownersOff && path.endsWith('/private')) stat.uid = 0;
        if (fault === 'private_mode' && path.endsWith('/private')) {
          stat.mode = 0o40755;
        }
      }
      return stat;
    },
    unlinkSync(path: string) {
      expect(attached).toBe(false);
      fs.unlinkSync(path);
      deleted = true;
    }
  };
  return {
    root,
    run,
    fs: storage,
    image,
    mounts,
    state: () => ({
      attached,
      mounted,
      quota,
      capacity,
      ownersOff,
      detachments,
      deleted
    })
  };
}

test('creates an exact quota on owned mounts and deletes only after verified detach', async () => {
  const f = fixture();
  const quota = await createOwnedWindowQuota(f.root, f);
  expect(f.state()).toMatchObject({
    mounted: true,
    quota: 67108864,
    capacity: 4294967296,
    ownersOff: true
  });
  expect(quota.caseRoot).toBe(join(f.mounts, 'HarnessQuotaState/private'));
  fs.mkdirSync(join(quota.caseRoot, 'descendant'), { mode: 0o700 });
  const evidence = await quota.verifyWritablePaths([quota.caseRoot, join(quota.caseRoot, 'descendant')]);
  expect(evidence).toMatchObject({
    quotaBytes: 67108864,
    capacityBytes: 4294967296
  });
  expect(f.fs.lstatSync(quota.caseRoot).uid).toBe(process.getuid?.());
  expect(f.fs.lstatSync(quota.caseRoot).mode & 0o777).toBe(0o700);
  await quota.close();
  await quota.close();
  expect(f.state()).toMatchObject({
    attached: false,
    deleted: true,
    detachments: 2
  });
});

test.each(['capacity', 'store', 'quota', 'uuid', 'same_device', 'private_mode', 'private_device', 'add', 'attach'])(
  'refuses %s drift and reclaims the positively owned attachment',
  async fault => {
    const f = fixture(fault);
    await expect(createOwnedWindowQuota(f.root, f)).rejects.toThrow();
    expect(f.state()).toMatchObject({ attached: false, deleted: true });
  }
);

test.each(['foreign', 'global'])('never detaches foreign or globally mounted state: %s', async fault => {
  const f = fixture(fault);
  await expect(createOwnedWindowQuota(f.root, f)).rejects.toThrow('quota_ownership_unverified');
  expect(f.state()).toMatchObject({ attached: true, deleted: false });
});

test.each(['detach', 'sticky'])('cannot delete an image after failed positive detach: %s', async fault => {
  const f = fixture(fault);
  await expect(createOwnedWindowQuota(f.root, f)).rejects.toThrow('quota_cleanup_unverified');
  expect(f.state()).toMatchObject({ attached: true, deleted: false });
});

test.each(['outside', 'symlink', 'base_volume', 'file'])('refuses writable paths outside the private quota root: %s', async fault => {
  const f = fixture();
  const quota = await createOwnedWindowQuota(f.root, f);
  let path = f.root;
  if (fault === 'symlink') {
    path = join(quota.caseRoot, 'link');
    fs.symlinkSync(f.root, path);
  } else if (fault === 'base_volume') {
    path = join(f.mounts, 'HarnessQuotaBase');
  } else if (fault === 'file') {
    path = join(quota.caseRoot, 'file');
    fs.writeFileSync(path, '');
  }
  try {
    await expect(quota.verifyWritablePaths([path])).rejects.toThrow();
  } finally {
    await quota.close();
  }
});

test.each(['inode', 'mode', 'hardlink', 'root', 'mountroot'])('refuses cleanup after %s identity drift', async fault => {
  const f = fixture();
  const quota = await createOwnedWindowQuota(f.root, f);
  if (fault === 'inode') {
    fs.renameSync(f.image, `${f.image}.original`);
    fs.writeFileSync(f.image, '', { mode: 0o600 });
  } else if (fault === 'mode') fs.chmodSync(f.image, 0o644);
  else if (fault === 'hardlink') fs.linkSync(f.image, `${f.image}.link`);
  else if (fault === 'root') fs.chmodSync(f.root, 0o755);
  else fs.chmodSync(f.mounts, 0o755);
  await expect(quota.close()).rejects.toThrow();
  expect(f.state()).toMatchObject({ attached: true, deleted: false });
});

test('refuses pre-existing image bytes without modifying them', async () => {
  const f = fixture();
  fs.writeFileSync(f.image, 'preserved', { mode: 0o600 });
  await expect(createOwnedWindowQuota(f.root, f)).rejects.toThrow();
  expect(fs.readFileSync(f.image, 'utf8')).toBe('preserved');
  expect(f.state()).toMatchObject({ attached: false, deleted: false });
});

test('hands off the exact image identity before any attachment can start', async () => {
  const f = fixture();
  const authorized = deferred<void>();
  const created = deferred<unknown>();
  const options = {
    ...f,
    onCreated(record: unknown) {
      created.resolve(record);
      return authorized.promise;
    }
  };
  const pending = createOwnedWindowQuota(f.root, options);
  const outcome = await Promise.race([created.promise.then(record => ({ kind: 'created', record })), pending.then(() => ({ kind: 'attached', record: null }))]);
  try {
    expect(outcome.kind).toBe('created');
    expect(f.state().attached).toBe(false);
    const root = fs.lstatSync(f.root);
    const image = fs.lstatSync(f.image);
    expect(outcome.record).toEqual({
      root_dev: root.dev,
      root_ino: root.ino,
      image_dev: image.dev,
      image_ino: image.ino
    });
  } finally {
    authorized.resolve();
    await (await pending).close();
  }
});

test('a rejected ownership handoff deletes the unattached image without mounting it', async () => {
  const f = fixture();
  const options = {
    ...f,
    onCreated() {
      return Promise.reject(new Error('coordinator_lost_before_authorization'));
    }
  };
  const pending = createOwnedWindowQuota(f.root, options);
  const result = await pending.then(
    quota => ({ quota, error: null }),
    (error: unknown) => ({ quota: null, error })
  );
  if (result.quota) await result.quota.close();
  expect(result.error).toBeInstanceOf(Error);
  expect(f.state()).toMatchObject({
    attached: false,
    deleted: true,
    detachments: 0
  });
});

test('the actual quota owner services verification and positively cleans normal shutdown', async () => {
  const f = fixture(),
    peer = ownedPeer(f);
  const quota = await peer.guardian.start();
  try {
    const evidence = await quota.verifyWritablePaths([quota.caseRoot]);
    expect(evidence.quotaBytes).toBe(67108864);
    expect(f.state().mounted).toBe(true);
  } finally {
    await peer.guardian.close();
  }
  expect(await peer.completed).toMatchObject({
    cleanup: { detached: true, ownedImageDeleted: true },
    failure: null
  });
  expect(f.state()).toMatchObject({
    attached: false,
    deleted: true,
    detachments: 2
  });
});

test.each(['disconnect', 'SIGTERM', 'SIGINT'] as const)('the surviving quota owner cleans after prearmed coordinator %s loss', async loss => {
  const f = fixture(),
    peer = ownedPeer(f);
  await peer.guardian.start();
  const witness = peer.completed;
  if (loss === 'disconnect') peer.coordinator.disconnect();
  else peer.owner.emit(loss);
  expect(await witness).toMatchObject({
    cleanup: { detached: true, ownedImageDeleted: true },
    failure: null
  });
  expect(f.state()).toMatchObject({
    attached: false,
    deleted: true,
    detachments: 2
  });
  const receipt: unknown = JSON.parse(fs.readFileSync(join(f.root, 'quota-owner-cleanup.json'), 'utf8'));
  expect(receipt).toMatchObject({
    cleanup: { detached: true, ownedImageDeleted: true },
    mounted: { quotaBytes: 67108864 }
  });
});

test('the owner cannot report cleanup or delete bytes after image identity drift', async () => {
  const f = fixture(),
    peer = ownedPeer(f);
  await peer.guardian.start();
  const image = fs.lstatSync(f.image);
  fs.renameSync(f.image, f.image + '.owned');
  fs.writeFileSync(f.image, '', { mode: 0o600 });
  expect(fs.lstatSync(f.image).ino).not.toBe(image.ino);
  await expect(peer.guardian.close()).rejects.toThrow('quota_cleanup_unverified');
  expect(await peer.completed).toMatchObject({
    cleanup: null,
    failure: 'quota_ownership_unverified'
  });
  expect(f.state()).toMatchObject({ attached: true, deleted: false });
});
