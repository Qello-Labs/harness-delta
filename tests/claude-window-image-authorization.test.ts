import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ClaudeWindowBinaryReader, createClaudeWindowBinaryAdapters } from '../src/claude-process-binary.js';

const fixture = vi.hoisted(() => ({
  source: '',
  scratch: '',
  active: true,
  authorizations: 0,
  sourcePass: 0,
  snapshotPass: 0,
  signatures: 0,
  revokePhase: '',
  revokedPhase: '',
  mutatePhase: '',
  mutated: false,
  subsequentReads: 0,
  revokedBytes: 0,
  partialRead: 65536,
  partialWrite: 65536,
  paths: new Map<number, string>()
}));

vi.mock('node:child_process', () => ({
  execFileSync: (file: string, args: readonly string[]) => {
    const uid = process.getuid?.();
    if (file === '/bin/ps') return `${args[1]} ${uid} ${Number(args[1]) - 1} Sat Nov  7 01:02:03 2026\n`;
    if (file === '/usr/sbin/lsof') return `p4402\nftxt\nn${fixture.source}\n`;
    throw new Error('native_execution_forbidden');
  },
  spawnSync: (file: string, args: readonly string[]) => {
    const path = args.at(-1);
    if (file !== '/usr/bin/codesign' || path === undefined || dirname(dirname(path)) !== fixture.scratch) {
      throw new Error('native_execution_forbidden');
    }
    fixture.signatures++;
    return {
      status: 0,
      signal: null,
      stderr: `TeamIdentifier=Q6L2SF6YDW\nIdentifier=com.anthropic.claude-code\nCDHash=${'a'.repeat(40)}\n`
    };
  }
}));

vi.mock('node:fs', async load => {
  const actual = await load<typeof import('node:fs')>();
  return {
    ...actual,
    openSync: (path: fs.PathLike, flags: number, mode?: fs.Mode) => {
      const fd = actual.openSync(path, flags, mode);
      fixture.paths.set(fd, String(path));
      return fd;
    },
    closeSync: (fd: number) => {
      actual.closeSync(fd);
      fixture.paths.delete(fd);
    },
    readSync: (fd: number, buffer: Buffer, offset: number, length: number, position: number) => {
      const path = fixture.paths.get(fd);
      if (path === undefined) throw new Error('unowned_fixture_descriptor');
      if (fixture.mutated) fixture.subsequentReads++;
      const count = actual.readSync(fd, buffer, offset, Math.min(length, fixture.partialRead), position);
      if (position === 0) {
        if (path === fixture.source) fixture.sourcePass++;
        else fixture.snapshotPass++;
      }
      const phase =
        path === fixture.source
          ? fixture.sourcePass === 1
            ? 'source_hash'
            : 'copy'
          : ['snapshot_hash', 'signature_rehash', 'final_rehash'][fixture.snapshotPass - 1];
      if (!fixture.active) fixture.revokedBytes += count;
      if (position >= 1024 * 1024) {
        if (phase === fixture.revokePhase) {
          fixture.active = false;
          fixture.revokedPhase = phase;
        }
        if (!fixture.mutated && phase === fixture.mutatePhase) {
          actual.chmodSync(path, 0o600);
          fixture.mutated = true;
        }
      }
      return count;
    },
    writeSync: (fd: number, buffer: Buffer, offset: number, length: number, position: number) =>
      actual.writeSync(fd, buffer, offset, Math.min(length, fixture.partialWrite), position)
  };
});

let root = '';
let bytes = Buffer.alloc(0);
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'claude-image-authorization-')));
  fixture.source = join(root, 'claude');
  fixture.scratch = join(root, 'scratch');
  fs.mkdirSync(fixture.scratch, { mode: 0o700 });
  Object.assign(fixture, {
    active: true,
    authorizations: 0,
    sourcePass: 0,
    snapshotPass: 0,
    signatures: 0,
    revokePhase: '',
    revokedPhase: '',
    mutatePhase: '',
    mutated: false,
    subsequentReads: 0,
    revokedBytes: 0,
    partialRead: 65536,
    partialWrite: 65536
  });
  vi.stubGlobal(
    'process',
    new Proxy(process, {
      get(target, key): unknown {
        if (key === 'platform') return 'darwin';
        if (key === 'arch') return 'arm64';
        return Reflect.get(target, key);
      }
    })
  );
});

afterEach(() => {
  for (const fd of fixture.paths.keys()) fs.closeSync(fd);
  fs.rmSync(root, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

function image(size: number): ClaudeWindowBinaryReader {
  bytes = Buffer.alloc(size, 17);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(0x0100000c, 4);
  bytes.writeUInt32LE(2, 12);
  fs.writeFileSync(fixture.source, bytes, { mode: 0o700 });
  const assertAuthorized = () => {
    fixture.authorizations++;
    if (!fixture.active) throw new Error('binding_window_activation_required');
  };
  return new ClaudeWindowBinaryReader({
    adapters: createClaudeWindowBinaryAdapters({ assertAuthorized, scratchDirectory: fixture.scratch }),
    assertAuthorized
  });
}

test.each([
  [4 * 1024 * 1024 + 17, 65536, 65536],
  [12 * 1024 * 1024 + 17, 65536, 65536],
  [8 * 1024 * 1024 + 17, 32769, 16385]
])('bounds authorization cost for %i bytes with %i-byte reads and %i-byte writes', (size, read, write) => {
  fixture.partialRead = read;
  fixture.partialWrite = write;
  const reader = image(size);

  const pin = reader.snapshot(4402);

  expect(pin.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  expect(fixture.authorizations).toBeLessThanOrEqual(256 + 60 * Math.ceil(size / (4 * 1024 * 1024)));
  expect(fixture.signatures).toBe(2);
  expect(fs.readdirSync(fixture.scratch)).toEqual([]);
  expect(fixture.paths.size).toBe(0);
});

test.each([
  ['source_hash', 0],
  ['copy', 0],
  ['snapshot_hash', 0],
  ['signature_rehash', 1],
  ['final_rehash', 2]
] as const)('refuses revocation during %s before returning a pin or entering the next phase', (phase, signatures) => {
  const reader = image(8 * 1024 * 1024 + 17);
  fixture.revokePhase = phase;

  expect(() => reader.snapshot(4402)).toThrow(/^binding_window_activation_required$/);

  expect(fixture.revokedPhase).toBe(phase);
  expect(fixture.revokedBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
  expect(fixture.signatures).toBe(signatures);
  expect(fs.readdirSync(fixture.scratch)).toEqual([]);
  expect(fixture.paths.size).toBe(0);
});

test.each(['copy', 'snapshot_hash'])('retains per-chunk identity refusal inside the authorization interval during %s', phase => {
  const reader = image(8 * 1024 * 1024 + 17);
  fixture.mutatePhase = phase;

  expect(() => reader.snapshot(4402)).toThrow(/^binding_executable_identity_unverified$/);

  expect(fixture.mutated).toBe(true);
  expect(fixture.subsequentReads).toBe(0);
  expect(fixture.signatures).toBe(0);
  expect(fs.readdirSync(fixture.scratch)).toEqual([]);
  expect(fixture.paths.size).toBe(0);
});

test('keeps public handle reads eager after a preceding authorized read', () => {
  fs.writeFileSync(fixture.source, Buffer.alloc(131072, 17), { mode: 0o700 });
  const handle = createClaudeWindowBinaryAdapters({
    assertAuthorized: () => {
      if (!fixture.active) throw new Error('binding_window_activation_required');
    },
    scratchDirectory: fixture.scratch
  }).open(fixture.source);
  const buffer = Buffer.alloc(65536);
  try {
    handle.read(buffer, 0, buffer.length, 0);
    fixture.active = false;

    expect(() => handle.read(buffer, 0, buffer.length, buffer.length)).toThrow(/^binding_window_activation_required$/);
  } finally {
    handle.close();
  }
  expect(fixture.paths.size).toBe(0);
});
