import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ClaudeWindowBinaryReader, createClaudeWindowBinaryAdapters } from '../src/claude-process-binary.js';

const native = vi.hoisted(() => ({
  source: '',
  scratch: '',
  active: true,
  uid: 501,
  partialRead: 65536,
  partialWrite: 65536,
  fakeSize: 0,
  badOwner: false,
  fail: '',
  after: (...args: [string, string]): void => {
    void args;
  },
  events: new Array<{ readonly name: string; readonly path: string }>(),
  unauthorized: new Array<string>(),
  fds: new Map<number, { readonly path: string; readonly writable: boolean }>(),
  exec: vi.fn<(file: string, args: readonly string[]) => string>(() => {
    throw new Error('native_execution_forbidden');
  }),
  spawn: vi.fn<
    (
      file: string,
      args: readonly string[]
    ) => {
      readonly pid: number;
      readonly output: readonly (string | null)[];
      readonly stdout: string;
      readonly stderr: string;
      readonly status: number | null;
      readonly signal: NodeJS.Signals | null;
      readonly error?: Error;
    }
  >(() => {
    throw new Error('native_execution_forbidden');
  }),
  effect<T>(name: string, path: string, operation: () => T): T {
    this.events.push({ name, path });
    if (
      !this.active &&
      (name.startsWith('read_') ||
        name === 'fstat_source' ||
        name === 'realpath' ||
        name === 'open_source' ||
        name === 'open_snapshot_read' ||
        name === 'open_snapshot_write' ||
        name === 'write_snapshot' ||
        name === 'chmod' ||
        name === 'mkdtemp' ||
        name === 'ps' ||
        name === 'lsof' ||
        name === 'codesign')
    )
      this.unauthorized.push(name);
    if (this.fail === name) {
      this.fail = '';
      throw new Error('SYNTHETIC_PRIVATE_DIAGNOSTIC');
    }
    const value = operation();
    this.after(name, path);
    return value;
  }
}));

vi.mock('node:child_process', () => ({
  execFileSync: (file: string, args: readonly string[]) => native.effect(file === '/bin/ps' ? 'ps' : 'lsof', file, () => native.exec(file, args)),
  spawnSync: (file: string, args: readonly string[]) => native.effect('codesign', args.at(-1) ?? '', () => native.spawn(file, args))
}));

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const fdInfo = (fd: number) => {
    const info = native.fds.get(fd);
    if (!info) throw new Error('unowned_fixture_descriptor');
    return info;
  };
  return {
    ...actual,
    openSync: (path: fs.PathLike, flags: number, mode?: fs.Mode) => {
      const name = String(path),
        writable = (flags & actual.constants.O_WRONLY) !== 0;
      const operation = name === native.source ? 'open_source' : writable ? 'open_snapshot_write' : 'open_snapshot_read';
      return native.effect(operation, name, () => {
        const fd = actual.openSync(path, flags, mode);
        native.fds.set(fd, { path: name, writable });
        return fd;
      });
    },
    closeSync: (fd: number) => {
      const info = fdInfo(fd);
      const name = info.path === native.source ? 'close_source' : info.writable ? 'close_snapshot_write' : 'close_snapshot_read';
      return native.effect(name, info.path, () => {
        actual.closeSync(fd);
        native.fds.delete(fd);
      });
    },
    fstatSync: (fd: number) => {
      const info = fdInfo(fd);
      return native.effect(info.path === native.source ? 'fstat_source' : 'fstat_snapshot', info.path, () => {
        const stat = actual.fstatSync(fd);
        if (info.path === native.source && native.fakeSize) {
          stat.size = native.fakeSize;
        }
        return stat;
      });
    },
    lstatSync: (path: fs.PathLike) =>
      native.effect('lstat', String(path), () => {
        const stat = actual.lstatSync(path);
        if (String(path) === native.source && native.fakeSize) {
          stat.size = native.fakeSize;
        }
        if (String(path) === native.scratch && native.badOwner) {
          stat.uid++;
        }
        return stat;
      }),
    realpathSync: (path: fs.PathLike) => native.effect('realpath', String(path), () => actual.realpathSync(path)),
    mkdtempSync: (prefix: string) => native.effect('mkdtemp', prefix, () => actual.mkdtempSync(prefix)),
    fchmodSync: (fd: number, mode: fs.Mode) => native.effect('chmod', fdInfo(fd).path, () => actual.fchmodSync(fd, mode)),
    readSync: (fd: number, buffer: Buffer, offset: number, length: number, position: number) => {
      const info = fdInfo(fd);
      return native.effect(info.path === native.source ? 'read_source' : 'read_snapshot', info.path, () =>
        native.partialRead === 0 ? 0 : actual.readSync(fd, buffer, offset, Math.min(length, native.partialRead), position)
      );
    },
    writeSync: (fd: number, buffer: Buffer, offset: number, length: number, position: number) =>
      native.effect('write_snapshot', fdInfo(fd).path, () =>
        native.partialWrite === 0 ? 0 : actual.writeSync(fd, buffer, offset, Math.min(length, native.partialWrite), position)
      ),
    unlinkSync: (path: fs.PathLike) => native.effect('unlink', String(path), () => actual.unlinkSync(path)),
    rmdirSync: (path: fs.PathLike) => native.effect('rmdir', String(path), () => actual.rmdirSync(path))
  };
});

const start = 'Sat Nov  7 01:02:03 2026';
const parentStart = 'Sat Nov  7 01:00:00 2026';
const requirement = '=anchor apple generic and certificate leaf[subject.OU] = "Q6L2SF6YDW" and identifier "com.anthropic.claude-code"';
const metadata = `Identifier=com.anthropic.claude-code\nTeamIdentifier=Q6L2SF6YDW\nCDHash=${'a'.repeat(40)}\nIgnored=PRIVATE\n`;
let root = '';
let bytes = Buffer.alloc(0);
let displayed = metadata;
let verifyStatus = 0;
let displayStatus = 0;
let ps = new Map<number, string>();
let lsof = '';
let beforeCodesign: (path: string, verify: boolean) => void = () => undefined;
const signedBytes: Buffer[] = [];
const signedInodes: number[] = [];

function authorize(): void {
  if (!native.active) throw new Error('binding_window_activation_required');
}

function adapters(scratchDirectory = native.scratch) {
  return createClaudeWindowBinaryAdapters({
    assertAuthorized: authorize,
    scratchDirectory
  });
}

function reader() {
  return new ClaudeWindowBinaryReader({
    adapters: adapters(),
    assertAuthorized: authorize
  });
}

function result(status: number, stderr = '') {
  return {
    pid: 9001,
    output: [null, '', stderr],
    stdout: '',
    stderr,
    status,
    signal: null
  };
}

function runtime(platform = 'darwin', arch = 'arm64', getuid: () => number | undefined = () => native.uid): void {
  vi.stubGlobal(
    'process',
    new Proxy(process, {
      get(target, key): unknown {
        if (key === 'platform') return platform;
        if (key === 'arch') return arch;
        if (key === 'getuid') return getuid;
        const value: unknown = Reflect.get(target, key);
        return value;
      }
    })
  );
}

beforeEach(() => {
  native.active = true;
  native.after = () => undefined;
  native.fail = '';
  native.partialRead = 65536;
  native.partialWrite = 65536;
  native.fakeSize = 0;
  native.badOwner = false;
  root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'claude-window-adapters-')));
  native.source = join(root, 'claude');
  native.scratch = join(root, 'scratch');
  fs.mkdirSync(native.scratch, { mode: 0o700 });
  native.uid = fs.statSync(root).uid;
  runtime();
  bytes = Buffer.alloc(64, 17);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(0x0100000c, 4);
  bytes.writeUInt32LE(2, 12);
  fs.writeFileSync(native.source, bytes, { mode: 0o700 });
  ps = new Map([
    [4402, `4402 ${native.uid} 4401 ${start}\n`],
    [4401, `4401 ${native.uid} 4400 ${parentStart}\n`]
  ]);
  lsof = `p4402\nftxt\nn${native.source}\n`;
  displayed = metadata;
  verifyStatus = 0;
  displayStatus = 0;
  beforeCodesign = () => undefined;
  signedBytes.length = 0;
  signedInodes.length = 0;
  native.exec.mockReset().mockImplementation((file, args) => {
    if (file === '/bin/ps') return ps.get(Number(args[1])) ?? '';
    if (file === '/usr/sbin/lsof') return lsof;
    throw new Error('unexpected_native_command');
  });
  native.spawn.mockReset().mockImplementation((file, args) => {
    const path = args.at(-1);
    if (file !== '/usr/bin/codesign' || path === undefined || dirname(dirname(path)) !== native.scratch) throw new Error('unsafe_codesign_target');
    const verify = args[0] === '--verify';
    beforeCodesign(path, verify);
    const stat = fs.statSync(path);
    const writable = [...native.fds.values()].some(info => info.path === path && info.writable);
    if ((stat.mode & 0o777) !== 0o500 || (fs.statSync(dirname(path)).mode & 0o777) !== 0o700 || writable) {
      throw new Error('unsealed_signature_snapshot');
    }
    signedBytes.push(fs.readFileSync(path));
    signedInodes.push(stat.ino);
    if (verify) {
      return result(args.includes('--strict') && args[args.indexOf('-R') + 1] === requirement ? verifyStatus : 1, 'PRIVATE_VERIFY');
    }
    if (args[0] !== '--display') {
      throw new Error('unexpected_codesign_operation');
    }
    return result(displayStatus, displayed);
  });
  native.events.length = 0;
  native.unauthorized.length = 0;
});

afterEach(() => {
  native.active = true;
  native.after = () => undefined;
  native.fail = '';
  for (const fd of native.fds.keys()) fs.closeSync(fd);
  fs.rmSync(root, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('bridges real synthetic bytes and sealed publisher verification to the L1a pin without a release claim', () => {
  const sourceStat = fs.statSync(native.source);

  const pin = reader().snapshot(4402);

  expect(pin).toMatchObject({
    mode: 'publisher_verified_local_pin',
    process: { pid: 4402, uid: native.uid, parentPid: 4401, start },
    parent: {
      pid: 4401,
      uid: native.uid,
      parentPid: 4400,
      start: parentStart
    },
    sha256: createHash('sha256').update(bytes).digest('hex'),
    stat: {
      device: sourceStat.dev,
      inode: sourceStat.ino,
      size: bytes.length
    },
    signature: {
      valid: true,
      team: 'Q6L2SF6YDW',
      identifier: 'com.anthropic.claude-code',
      cdHash: 'a'.repeat(40)
    },
    mappedImageProof: 'unverified'
  });
  expect(signedBytes).toEqual([bytes, bytes]);
  expect(signedInodes.every(inode => inode !== sourceStat.ino)).toBe(true);
  expect(Object.keys(pin)).not.toContain('productVersion');
  expect(fs.readdirSync(native.scratch)).toEqual([]);
  expect(native.fds.size).toBe(0);
});

test.each([1, 3, 11])('handles partial FD reads and writes of %i bytes without truncating the signed snapshot', count => {
  native.partialRead = count;
  native.partialWrite = count;
  const handle = adapters().open(native.source);
  try {
    const verified = handle.verifySignature();

    expect(verified.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(signedBytes).toEqual([bytes, bytes]);
    expect(fs.readdirSync(native.scratch)).toEqual([]);
  } finally {
    handle.close();
  }
});

test('does not reopen or resolve the original pathname after its initial FD hash when that pathname is substituted', () => {
  const port = adapters(),
    handle = port.open(native.source);
  const initial = Buffer.alloc(bytes.length);
  handle.read(initial, 0, initial.length, 0);
  fs.renameSync(native.source, join(root, 'original'));
  fs.writeFileSync(native.source, Buffer.alloc(64, 99), { mode: 0o700 });
  native.events.length = 0;
  try {
    const verified = handle.verifySignature();

    expect(verified.sha256).toBe(createHash('sha256').update(initial).digest('hex'));
    expect(signedBytes).toEqual([bytes, bytes]);
    expect(native.events.filter(event => event.path === native.source && ['open_source', 'realpath', 'lstat'].includes(event.name))).toEqual([]);
    expect(verified.stat.inode).toBe(fs.statSync(join(root, 'original')).ino);
  } finally {
    handle.close();
  }
});

test.each([
  [
    'wrong team',
    () => {
      displayed = metadata.replace('Q6L2SF6YDW', 'OTHERTEAM');
    }
  ],
  [
    'wrong role',
    () => {
      displayed = metadata.replace('com.anthropic.claude-code', 'com.anthropic.host');
    }
  ],
  [
    'unsigned',
    () => {
      verifyStatus = 1;
    }
  ],
  [
    'untrusted anchor',
    () => {
      verifyStatus = 3;
    }
  ],
  [
    'missing CDHash',
    () => {
      displayed = metadata.replace(/^CDHash=.*\n/m, '');
    }
  ],
  [
    'malformed CDHash',
    () => {
      displayed = metadata.replace('a'.repeat(40), 'not-a-hash');
    }
  ],
  [
    'duplicate identity',
    () => {
      displayed += 'Identifier=com.anthropic.claude-code\n';
    }
  ],
  [
    'display failure',
    () => {
      displayStatus = 1;
    }
  ],
  [
    'CLI over cap',
    () => {
      native.fakeSize = 536870913;
    }
  ],
  [
    'unsafe scratch permissions',
    () => {
      fs.chmodSync(native.scratch, 0o770);
    }
  ],
  [
    'foreign scratch owner',
    () => {
      native.badOwner = true;
    }
  ]
] as const)('refuses %s and removes only its own synthetic artifacts', (_label, change) => {
  change();

  expect(() => reader().snapshot(4402)).toThrow(/^binding_executable_identity_unverified$/);

  expect(fs.readdirSync(native.scratch)).toEqual([]);
  expect(fs.readFileSync(native.source)).toEqual(bytes);
  expect(native.fds.size).toBe(0);
});

test.each([
  ['wrapper bytes', 0, 0],
  ['non-arm64 image', 4, 7],
  ['non-executable Mach-O role', 12, 6]
] as const)('refuses %s before invoking signature tools', (_label, offset, value) => {
  bytes.writeUInt32LE(value, offset);
  fs.writeFileSync(native.source, bytes);

  expect(() => reader().snapshot(4402)).toThrow('binding_executable_identity_unverified');

  expect(native.spawn).not.toHaveBeenCalled();
  expect(fs.readdirSync(native.scratch)).toEqual([]);
});

test.each([
  ['empty image list', ''],
  ['wrong PID', 'p9999\nftxt\nn/synthetic/claude\n'],
  ['two images', 'p4402\nftxt\nn/synthetic/claude\nftxt\nn/synthetic/other\n'],
  ['duplicate path', 'p4402\nftxt\nn/synthetic/claude\nn/synthetic/claude\n'],
  ['wrong descriptor', 'p4402\nfcwd\nn/synthetic/claude\n'],
  ['missing descriptor', 'p4402\nn/synthetic/claude\n'],
  ['relative image', 'p4402\nftxt\nnclaude\n'],
  ['trailing path whitespace', 'p4402\nftxt\nn/synthetic/claude \n'],
  ['path traversal', 'p4402\nftxt\nn/synthetic/../claude\n'],
  ['NUL path', 'p4402\nftxt\nn/synthetic/\0/claude\n'],
  ['deleted image', 'p4402\nftxt\nn/synthetic/claude (deleted)\n'],
  ['unknown host', 'p4402\nftxt\nn/synthetic/node\n'],
  ['app host', 'p4402\nftxt\nn/synthetic/Claude.app/Contents/MacOS/claude\n'],
  ['script layout', 'p4402\nftxt\nn/synthetic/claude.js\n']
] as const)('refuses %s from PID-scoped synthetic image metadata', (_label, fields) => {
  lsof = fields;

  expect(adapters().readImage(4402)).toBeNull();

  expect(native.events.map(event => event.name)).toEqual(['lsof']);
});

test('recognizes the standalone version-directory layout without claiming that filename as a version attestation', () => {
  lsof = 'p4402\nftxt\nn/synthetic/claude/versions/2.1.999\n';

  expect(adapters().readImage(4402)).toEqual({
    path: '/synthetic/claude/versions/2.1.999',
    layout: 'standalone',
    requiredHost: null
  });
});

test.each([
  ['absent process', ''],
  ['wrong PID', `9999 501 4401 ${start}\n`],
  ['missing start', '4402 501 4401\n'],
  ['ambiguous processes', `4402 501 4401 ${start}\n4402 501 4401 ${start}\n`],
  ['split metadata row', `4402\n501\n4401\n${start}\n`],
  ['invalid UID', `4402 -1 4401 ${start}\n`],
  ['absent parent', `4402 501 0 ${start}\n`],
  ['self parent', `4402 501 4402 ${start}\n`]
] as const)('refuses %s in fixed synthetic process metadata', (_label, fields) => {
  ps.set(4402, fields);

  expect(adapters().readProcess(4402)).toBeNull();
});

test.each([0, -1, Number.NaN, Number.MAX_SAFE_INTEGER + 1])('rejects invalid PID %s without launching a metadata command', pid => {
  const port = adapters();

  expect([port.readProcess(pid), port.readImage(pid)]).toEqual([null, null]);

  expect(native.exec).not.toHaveBeenCalled();
});

test.each([
  ['foreign source user', 4402, () => `4402 ${native.uid + 1} 4401 ${start}\n`],
  ['foreign parent user', 4401, () => `4401 ${native.uid + 1} 4400 ${parentStart}\n`],
  ['cyclic parent', 4401, () => `4401 ${native.uid} 4402 ${parentStart}\n`]
] as const)('keeps L1a same-user and ancestry refusal for %s', (_label, pid, fields) => {
  ps.set(pid, fields());

  expect(() => reader().snapshot(4402)).toThrow('binding_executable_identity_unverified');

  expect(native.spawn).not.toHaveBeenCalled();
});

test.each([4402, 4401])('invalidates a pin when synthetic PID %i is reused with a different start', pid => {
  const owner = reader(),
    pin = owner.snapshot(4402);
  const row = ps.get(pid);
  if (row === undefined) throw new Error('missing_synthetic_metadata');
  ps.set(pid, row.replace('2026', '2027'));

  expect(() => owner.revalidate(pin)).toThrow('binding_executable_changed');
});

test.each([
  'ps',
  'lsof',
  'open_source',
  'fstat_source',
  'realpath',
  'lstat',
  'mkdtemp',
  'open_snapshot_write',
  'fstat_snapshot',
  'read_source',
  'write_snapshot',
  'chmod',
  'close_snapshot_write',
  'open_snapshot_read',
  'read_snapshot',
  'codesign'
])('stops inside compound operation %s after revocation with no subsequent native reads and cleans its artifacts', operation => {
  const handle = adapters().open(native.source);
  native.events.length = 0;
  native.after = name => {
    if (name === operation) native.active = false;
  };
  try {
    const invoke = () => {
      if (operation === 'ps') return adapters().readProcess(4402);
      if (operation === 'lsof') return adapters().readImage(4402);
      if (operation === 'open_source') {
        return adapters().open(native.source);
      }
      return handle.verifySignature();
    };

    expect(invoke).toThrow('binding_window_activation_required');

    expect(native.events.some(event => event.name === operation)).toBe(true);
    expect(native.unauthorized).toEqual([]);
    expect(fs.readdirSync(native.scratch)).toEqual([]);
  } finally {
    handle.close();
  }
  expect(native.fds.size).toBe(0);
});

test.each([
  'ps',
  'lsof',
  'open_source',
  'fstat_source',
  'mkdtemp',
  'open_snapshot_write',
  'read_source',
  'write_snapshot',
  'chmod',
  'open_snapshot_read',
  'read_snapshot',
  'codesign'
])('sanitizes %s failures and cleans partial snapshots', operation => {
  native.fail = operation;

  expect(() => reader().snapshot(4402)).toThrow(/^binding_executable_identity_unverified$/);

  expect(native.fds.size).toBe(0);
  expect(fs.readdirSync(native.scratch)).toEqual([]);
});

test('cleans an exclusively created snapshot when its initial descriptor stat fails', () => {
  native.fail = 'fstat_snapshot';
  const handle = adapters().open(native.source);
  try {
    expect(() => handle.verifySignature()).toThrow(/^binding_executable_identity_unverified$/);

    expect(fs.readdirSync(native.scratch)).toEqual([]);
  } finally {
    handle.close();
  }
  expect(native.fds.size).toBe(0);
});

test.each(['read', 'write'] as const)('rejects zero progress during snapshot %s and cleans the partial file', operation => {
  if (operation === 'read') native.partialRead = 0;
  else native.partialWrite = 0;
  const handle = adapters().open(native.source);
  try {
    expect(() => handle.verifySignature()).toThrow('binding_executable_identity_unverified');

    expect(native.spawn).not.toHaveBeenCalled();
    expect(fs.readdirSync(native.scratch)).toEqual([]);
  } finally {
    handle.close();
  }

  expect(native.fds.size).toBe(0);
});

test('enforces the CLI cap inside the opened-handle verifier before reading source bytes', () => {
  native.fakeSize = 536870913;
  const handle = adapters().open(native.source);
  try {
    expect(() => handle.verifySignature()).toThrow('binding_executable_identity_unverified');

    expect(native.events.filter(event => event.name === 'read_source')).toEqual([]);
    expect(fs.readdirSync(native.scratch)).toEqual([]);
    expect(native.spawn).not.toHaveBeenCalled();
  } finally {
    handle.close();
  }
});

test.each(['timeout', 'signal', 'no status'] as const)('does not leak codesign %s failures through the opened handle', failure => {
  native.spawn.mockImplementationOnce(() => ({
    ...result(0, 'PRIVATE_CODESIGN_DIAGNOSTIC'),
    ...(failure === 'timeout' ? { error: new Error('PRIVATE_TIMEOUT') } : {}),
    signal: failure === 'signal' ? 'SIGTERM' : null,
    status: failure === 'no status' ? null : 0
  }));
  const handle = adapters().open(native.source);
  try {
    expect(() => handle.verifySignature()).toThrow(/^binding_executable_identity_unverified$/);

    expect(fs.readdirSync(native.scratch)).toEqual([]);
  } finally {
    handle.close();
  }
});

test('stops immediately after revocation inside signature display without hashing any further bytes', () => {
  native.after = name => {
    if (name === 'codesign' && native.spawn.mock.calls.length === 2) native.active = false;
  };
  const handle = adapters().open(native.source);
  try {
    expect(() => handle.verifySignature()).toThrow('binding_window_activation_required');

    expect(native.spawn).toHaveBeenCalledTimes(2);
    expect(native.unauthorized).toEqual([]);
    expect(fs.readdirSync(native.scratch)).toEqual([]);
  } finally {
    handle.close();
  }
  expect(native.fds.size).toBe(0);
});

test('refuses an unavailable current UID without any process discovery', () => {
  runtime('darwin', 'arm64', () => undefined);

  expect(() => adapters().currentUid()).toThrow('binding_executable_identity_unverified');

  expect(native.exec).not.toHaveBeenCalled();
  expect(native.spawn).not.toHaveBeenCalled();
});

test('stops after revocation during the current UID read before process discovery', () => {
  runtime('darwin', 'arm64', () => {
    native.active = false;
    return native.uid;
  });

  expect(() => adapters().currentUid()).toThrow('binding_window_activation_required');

  expect(native.exec).not.toHaveBeenCalled();
  expect(native.spawn).not.toHaveBeenCalled();
});

test.each(['source', 'snapshot'] as const)('refuses %s bytes changed during cryptographic verification', target => {
  beforeCodesign = (path, verify) => {
    if (!verify) return;
    const changed = target === 'source' ? native.source : path;
    fs.chmodSync(changed, 0o700);
    fs.writeFileSync(changed, Buffer.alloc(64, 88));
    if (target === 'snapshot') fs.chmodSync(changed, 0o500);
  };

  expect(() => reader().snapshot(4402)).toThrow('binding_executable_identity_unverified');

  expect(signedBytes).toHaveLength(1);
  expect(native.fds.size).toBe(0);
  expect(fs.readdirSync(native.scratch)).toEqual([]);
});

test('does not delete a substituted snapshot path that is not the owned inode', () => {
  let substituted = '';
  beforeCodesign = (path, verify) => {
    if (!verify) return;
    fs.renameSync(path, join(root, 'moved-snapshot'));
    fs.writeFileSync(path, bytes, { mode: 0o500 });
    substituted = path;
  };

  expect(() => reader().snapshot(4402)).toThrow('binding_executable_identity_unverified');

  expect(fs.readFileSync(substituted)).toEqual(bytes);
  expect(fs.readFileSync(join(root, 'moved-snapshot'))).toEqual(bytes);
  expect(native.fds.size).toBe(0);
});

test('refuses a symlinked source without following it', () => {
  const link = join(root, 'alias');
  fs.symlinkSync(native.source, link);

  expect(() => adapters().open(link)).toThrow('binding_executable_identity_unverified');

  expect(native.fds.size).toBe(0);
});

test('refuses a scratch alias before creating any snapshot', () => {
  const link = join(root, 'scratch-alias');
  fs.symlinkSync(native.scratch, link);
  const handle = adapters(link).open(native.source);
  try {
    expect(() => handle.verifySignature()).toThrow('binding_executable_identity_unverified');

    expect(fs.readdirSync(native.scratch)).toEqual([]);
    expect(native.spawn).not.toHaveBeenCalled();
  } finally {
    handle.close();
  }
});

test.each([
  ['linux', 'arm64'],
  ['darwin', 'x64']
] as const)('refuses runtime %s/%s before any native operation', (platform, arch) => {
  runtime(platform, arch);

  expect(() => adapters().currentUid()).toThrow('binding_executable_identity_unverified');

  expect(native.events).toEqual([]);
  expect(native.exec).not.toHaveBeenCalled();
  expect(native.spawn).not.toHaveBeenCalled();
});

test('denies closed collection before touching any native or synthetic filesystem port', () => {
  native.active = false;

  expect(() => adapters().open(native.source)).toThrow('binding_window_activation_required');

  expect(native.events).toEqual([]);
  expect(native.fds.size).toBe(0);
});
