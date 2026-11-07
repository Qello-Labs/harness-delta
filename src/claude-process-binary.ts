import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmdirSync,
  type Stats,
  unlinkSync,
  writeSync
} from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { claudeBindingAdmissions, claudeBindingRuntimeSupported } from './claude-binding-admission.js';
import { toolVersionReadCeilings } from './core/tool-version-profiles.js';

export interface ClaudeProcessBinary {
  readonly productVersion: string;
  readonly sha256: string;
}
const images = new Map<string, ClaudeProcessBinary>();
// The exact 2.1.306 image exceeds the former 256 MiB read ceiling.
const maxImageBytes = toolVersionReadCeilings.claudeProcessImage;

/** Kernel image metadata only. No process arguments, environment or transcript reads. */
export function readClaudeProcessBinary(pid: number): ClaudeProcessBinary {
  if (!claudeBindingRuntimeSupported()) throw new Error('binding_runtime_unsupported');
  const fields = execFileSync('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'txt', '-Fn'], {
    encoding: 'utf8',
    timeout: 2000,
    maxBuffer: 65536,
    stdio: ['ignore', 'pipe', 'ignore']
  }).split('\n');
  const image = fields.find(field => field.startsWith('n'));
  const path = image?.slice(1);
  if (!path || !isAbsolute(path) || realpathSync(path) !== path) throw new Error('claude_binary_unqualified');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size < 1 || before.size > maxImageBytes || (before.mode & 0o111) === 0) throw new Error('claude_binary_unqualified');
    const key = JSON.stringify([pid, path, before.dev, before.ino, before.size, before.mtimeMs, before.ctimeMs]);
    const cached = images.get(key);
    if (cached) return cached;
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(65536);
    for (let offset = 0; offset < before.size;) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (!count) throw new Error('claude_binary_unqualified');
      hash.update(buffer.subarray(0, count));
      offset += count;
    }
    const after = fstatSync(fd);
    const digest = hash.digest('hex');
    const admission = claudeBindingAdmissions.find(row => row.admitted && row.binarySha256 === digest);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      !admission
    )
      throw new Error('claude_binary_unqualified');
    const binary = { productVersion: admission.productVersion, sha256: digest };
    images.set(key, binary);
    if (images.size > 64) {
      const oldest = images.keys().next().value;
      if (oldest !== undefined) images.delete(oldest);
    }
    return binary;
  } finally {
    closeSync(fd);
  }
}

export const claudeWindowImageLimits = Object.freeze({
  cli: 536870912,
  host: 134217728
});

export interface ClaudeWindowProcessMetadata {
  readonly pid: number;
  readonly uid: number;
  readonly start: string;
  readonly parentPid: number;
}
export interface ClaudeWindowImageStat {
  readonly device: number;
  readonly inode: number;
  readonly size: number;
  readonly mode: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly regularFile: boolean;
}
export interface ClaudeWindowSignature {
  readonly valid: boolean;
  readonly team: string;
  readonly identifier: string;
  readonly cdHash: string;
}
export interface ClaudeWindowImageHandle {
  stat(): ClaudeWindowImageStat;
  read(buffer: Buffer, offset: number, length: number, position: number): number;
  /** Verification must use this opened image, not a re-resolved pathname. */
  verifySignature(): { readonly signature: ClaudeWindowSignature; readonly sha256: string; readonly stat: ClaudeWindowImageStat };
  close(): void;
}
/** Native ports are supplied by the live provider, never by receipt payloads. */
export interface ClaudeWindowBinaryAdapters {
  currentUid(): number | null;
  readProcess(pid: number): ClaudeWindowProcessMetadata | null;
  readImage(pid: number): {
    readonly path: string;
    readonly layout: string;
    readonly requiredHost: string | null;
  } | null;
  realpath(path: string): string;
  stat(path: string): ClaudeWindowImageStat;
  open(path: string): ClaudeWindowImageHandle;
}
export interface ClaudeWindowBinaryPin {
  readonly mode: 'publisher_verified_local_pin';
  readonly process: ClaudeWindowProcessMetadata;
  readonly parent: ClaudeWindowProcessMetadata;
  readonly path: string;
  readonly stat: ClaudeWindowImageStat;
  readonly sha256: string;
  readonly signature: ClaudeWindowSignature;
  readonly mappedImageProof: 'unverified';
}
export class ClaudeWindowBinaryError extends Error {
  constructor(readonly code: 'binding_executable_identity_unverified' | 'binding_executable_changed') {
    super(code);
    this.name = 'ClaudeWindowBinaryError';
  }
}
const sameWindowFile = (left: ClaudeWindowImageStat, right: ClaudeWindowImageStat): boolean =>
  left.device === right.device &&
  left.inode === right.inode &&
  left.size === right.size &&
  left.mode === right.mode &&
  left.mtimeMs === right.mtimeMs &&
  left.ctimeMs === right.ctimeMs &&
  left.regularFile === right.regularFile;
const validWindowProcess = (metadata: ClaudeWindowProcessMetadata | null, pid: number, uid: number): metadata is ClaudeWindowProcessMetadata =>
  metadata !== null &&
  metadata.pid === pid &&
  metadata.uid === uid &&
  metadata.start.length > 0 &&
  Number.isSafeInteger(metadata.parentPid) &&
  metadata.parentPid > 0 &&
  metadata.parentPid !== pid;

function windowNativeFailure(): never {
  throw new ClaudeWindowBinaryError('binding_executable_identity_unverified');
}

function windowNativeCleanup(operation: () => void): void {
  try {
    operation();
  } catch (error) {
    if (error instanceof Error) windowNativeFailure();
    windowNativeFailure();
  }
}

function windowNativeStat(stat: Stats): ClaudeWindowImageStat {
  return {
    device: stat.dev,
    inode: stat.ino,
    size: stat.size,
    mode: stat.mode,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    regularFile: stat.isFile()
  };
}

class ClaudeWindowNativeBoundary {
  constructor(readonly authorize: () => void) {}

  step<T>(operation: () => T): T {
    this.authorize();
    if (process.platform !== 'darwin' || process.arch !== 'arm64') {
      return windowNativeFailure();
    }
    try {
      return operation();
    } catch (error) {
      if (error instanceof Error) return windowNativeFailure();
      return windowNativeFailure();
    } finally {
      this.authorize();
    }
  }

  uid(): number {
    const uid = this.step(() => process.getuid?.());
    if (uid === undefined || !Number.isSafeInteger(uid) || uid < 0) {
      return windowNativeFailure();
    }
    return uid;
  }

  process(pid: number): ClaudeWindowProcessMetadata | null {
    this.authorize();
    if (!Number.isSafeInteger(pid) || pid < 1) return null;
    const text = this.step(() =>
      execFileSync('/bin/ps', ['-p', String(pid), '-o', 'pid=,uid=,ppid=,lstart='], {
        encoding: 'utf8',
        timeout: 2000,
        maxBuffer: 4096,
        env: { LC_ALL: 'C', LANG: 'C' },
        stdio: ['ignore', 'pipe', 'ignore']
      })
    );
    const rows = text.trim().split('\n');
    if (rows.length !== 1) return null;
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([A-Z][a-z]{2} [A-Z][a-z]{2}\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4})\s*$/.exec(rows[0] ?? '');
    if (!match) return null;
    const foundPid = Number(match[1]),
      uid = Number(match[2]),
      parentPid = Number(match[3]),
      start = match[4];
    if (foundPid !== pid || !Number.isSafeInteger(uid) || uid < 0 || !Number.isSafeInteger(parentPid) || parentPid < 1 || parentPid === pid || !start)
      return null;
    return { pid, uid, parentPid, start };
  }

  image(pid: number): ReturnType<ClaudeWindowBinaryAdapters['readImage']> {
    this.authorize();
    if (!Number.isSafeInteger(pid) || pid < 1) return null;
    const text = this.step(() =>
      execFileSync('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'txt', '-Fpfn'], {
        encoding: 'utf8',
        timeout: 2000,
        maxBuffer: 65536,
        stdio: ['ignore', 'pipe', 'ignore']
      })
    );
    const fields = text.split('\n');
    if (fields.at(-1) === '') fields.pop();
    if (fields.length !== 3 || fields[0] !== `p${pid}` || fields[1] !== 'ftxt') return null;
    const name = fields[2];
    if (!name?.startsWith('n')) return null;
    const path = name.slice(1);
    if (!isAbsolute(path) || path.includes('\0') || path.split('/').some(part => part === '.' || part === '..')) return null;
    if (path.includes('.app/') || (basename(path) !== 'claude' && !/\/claude\/versions\/\d+\.\d+\.\d+$/.test(path))) return null;
    return { path, layout: 'standalone', requiredHost: null };
  }

  stat(fd: number): ClaudeWindowImageStat {
    return windowNativeStat(this.step(() => fstatSync(fd)));
  }

  read(fd: number, buffer: Buffer, offset: number, length: number, position: number): number {
    this.authorize();
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(length) ||
      length < 1 ||
      length > 65536 ||
      offset + length > buffer.length ||
      !Number.isSafeInteger(position) ||
      position < 0 ||
      position + length > claudeWindowImageLimits.cli
    )
      return windowNativeFailure();
    return this.step(() => readSync(fd, buffer, offset, length, position));
  }
}

interface ClaudeWindowOwnedSnapshot {
  directory: string | null;
  directoryStat: Stats | null;
  path: string | null;
  fileStat: Stats | null;
  writable: number | null;
  readonlyFd: number | null;
}

function sameWindowIdentity(left: Stats, right: Stats): boolean {
  return sameWindowInode(left, right) && left.mode === right.mode;
}

function sameWindowInode(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid;
}

class ClaudeWindowSnapshotVerifier {
  readonly #native: ClaudeWindowNativeBoundary;
  readonly #fd: number;
  readonly #scratch: string;
  readonly #source: ClaudeWindowImageStat;
  readonly #owned: ClaudeWindowOwnedSnapshot = {
    directory: null,
    directoryStat: null,
    path: null,
    fileStat: null,
    writable: null,
    readonlyFd: null
  };
  #parent: Stats | null = null;
  #sealed: ClaudeWindowImageStat | null = null;

  constructor(native: ClaudeWindowNativeBoundary, fd: number, scratch: string) {
    this.#native = native;
    this.#fd = fd;
    this.#scratch = scratch;
    this.#source = native.stat(fd);
  }

  verify(): ReturnType<ClaudeWindowImageHandle['verifySignature']> {
    try {
      this.#prepare();
      const sha256 = this.#copy();
      const writable = this.#owned.writable;
      const path = this.#owned.path;
      if (writable === null || path === null) {
        return windowNativeFailure();
      }
      this.#native.step(() => fchmodSync(writable, 0o500));
      const previous = this.#owned.fileStat;
      const sealed = this.#native.step(() => fstatSync(writable));
      if (previous === null || !sameWindowInode(previous, sealed) || (sealed.mode & 0o777) !== 0o500 || sealed.size !== this.#source.size)
        return windowNativeFailure();
      this.#owned.fileStat = sealed;
      this.#sealed = windowNativeStat(sealed);
      this.#native.step(() => {
        closeSync(writable);
        this.#owned.writable = null;
      });
      this.#native.step(() => {
        this.#owned.readonlyFd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      });
      this.#check();
      if (this.#hash() !== sha256) return windowNativeFailure();
      const signature = this.#signature(path, sha256);
      if (this.#hash() !== sha256) return windowNativeFailure();
      this.#check();
      return { signature, sha256, stat: this.#source };
    } finally {
      windowNativeCleanup(() => this.#cleanup());
    }
  }

  #prepare(): void {
    const native = this.#native,
      source = this.#source;
    if (
      !source.regularFile ||
      !Number.isSafeInteger(source.size) ||
      source.size < 32 ||
      source.size > claudeWindowImageLimits.cli ||
      (source.mode & 0o111) === 0
    )
      return windowNativeFailure();
    if (!isAbsolute(this.#scratch) || native.step(() => realpathSync(this.#scratch)) !== this.#scratch) return windowNativeFailure();
    const uid = native.uid(),
      parent = native.step(() => lstatSync(this.#scratch));
    if (!parent.isDirectory() || parent.uid !== uid || (parent.mode & 0o077) !== 0) return windowNativeFailure();
    this.#parent = parent;
    native.step(() => {
      this.#owned.directory = mkdtempSync(join(this.#scratch, 'claude-image-'));
    });
    const directory = this.#owned.directory;
    if (directory === null) return windowNativeFailure();
    const directoryStat = native.step(() => {
      const stat = lstatSync(directory);
      this.#owned.directoryStat = stat;
      return stat;
    });
    if (!directoryStat.isDirectory() || directoryStat.uid !== uid || (directoryStat.mode & 0o777) !== 0o700) return windowNativeFailure();
    this.#owned.path = join(directory, 'image');
    const path = this.#owned.path;
    native.step(() => {
      this.#owned.writable = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    });
    const writable = this.#owned.writable;
    if (writable === null) return windowNativeFailure();
    const fileStat = native.step(() => {
      const stat = fstatSync(writable);
      this.#owned.fileStat = stat;
      return stat;
    });
    if (!fileStat.isFile() || fileStat.uid !== uid || fileStat.nlink !== 1 || (fileStat.mode & 0o777) !== 0o600) return windowNativeFailure();
    this.#check();
  }

  #check(): void {
    const native = this.#native,
      owned = this.#owned;
    if (!sameWindowFile(this.#source, native.stat(this.#fd))) {
      return windowNativeFailure();
    }
    if (
      this.#parent === null ||
      !sameWindowIdentity(
        this.#parent,
        native.step(() => lstatSync(this.#scratch))
      )
    )
      return windowNativeFailure();
    if (
      owned.directory === null ||
      owned.directoryStat === null ||
      !sameWindowIdentity(
        owned.directoryStat,
        native.step(() => lstatSync(owned.directory ?? windowNativeFailure()))
      )
    )
      return windowNativeFailure();
    const fd = owned.readonlyFd ?? owned.writable;
    if (fd === null || owned.path === null || owned.fileStat === null) {
      return windowNativeFailure();
    }
    const opened = native.step(() => fstatSync(fd)),
      named = native.step(() => lstatSync(owned.path ?? windowNativeFailure()));
    if (!sameWindowIdentity(owned.fileStat, opened) || !sameWindowIdentity(opened, named) || !opened.isFile() || opened.nlink !== 1)
      return windowNativeFailure();
    if (owned.readonlyFd !== null && (opened.size !== this.#source.size || !sameWindowFile(windowNativeStat(opened), windowNativeStat(named))))
      return windowNativeFailure();
    if (this.#sealed !== null && !sameWindowFile(this.#sealed, windowNativeStat(opened))) return windowNativeFailure();
  }

  #copy(): string {
    const writable = this.#owned.writable;
    if (writable === null) return windowNativeFailure();
    const buffer = Buffer.alloc(65536),
      hash = createHash('sha256');
    const header = Buffer.alloc(16);
    for (let offset = 0; offset < this.#source.size;) {
      this.#check();
      const length = Math.min(buffer.length, this.#source.size - offset);
      const count = this.#native.read(this.#fd, buffer, 0, length, offset);
      if (!Number.isSafeInteger(count) || count < 1 || count > length) {
        return windowNativeFailure();
      }
      if (offset < header.length) {
        buffer.copy(header, offset, 0, Math.min(count, header.length - offset));
      }
      hash.update(buffer.subarray(0, count));
      for (let written = 0; written < count;) {
        const position = written;
        const amount = this.#native.step(() => writeSync(writable, buffer, position, count - position, offset + position));
        if (!Number.isSafeInteger(amount) || amount < 1 || amount > count - written) return windowNativeFailure();
        written += amount;
      }
      offset += count;
    }
    if (header.readUInt32LE(0) !== 0xfeedfacf || header.readUInt32LE(4) !== 0x0100000c || header.readUInt32LE(12) !== 2) return windowNativeFailure();
    this.#check();
    return hash.digest('hex');
  }

  #hash(): string {
    const fd = this.#owned.readonlyFd;
    if (fd === null) return windowNativeFailure();
    const hash = createHash('sha256'),
      buffer = Buffer.alloc(65536);
    for (let offset = 0; offset < this.#source.size;) {
      this.#check();
      const length = Math.min(buffer.length, this.#source.size - offset);
      const count = this.#native.read(fd, buffer, 0, length, offset);
      if (!Number.isSafeInteger(count) || count < 1 || count > length) {
        return windowNativeFailure();
      }
      hash.update(buffer.subarray(0, count));
      offset += count;
    }
    this.#check();
    return hash.digest('hex');
  }

  #signature(path: string, sha256: string): ClaudeWindowSignature {
    this.#check();
    const requirement = '=anchor apple generic and certificate leaf[subject.OU] = "Q6L2SF6YDW" and identifier "com.anthropic.claude-code"';
    const verified = this.#native.step(() =>
      spawnSync('/usr/bin/codesign', ['--verify', '--strict', '-R', requirement, path], {
        encoding: 'utf8',
        timeout: 2000,
        maxBuffer: 65536,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    );
    this.#check();
    if (verified.error || verified.signal !== null || verified.status !== 0) return windowNativeFailure();
    if (this.#hash() !== sha256) return windowNativeFailure();
    const display = this.#native.step(() =>
      spawnSync('/usr/bin/codesign', ['--display', '--verbose=4', path], {
        encoding: 'utf8',
        timeout: 2000,
        maxBuffer: 65536,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    );
    this.#check();
    if (display.error || display.signal !== null || display.status !== 0 || typeof display.stderr !== 'string') return windowNativeFailure();
    const values = new Map<string, string>();
    for (const line of display.stderr.split('\n')) {
      const field = /^(TeamIdentifier|Identifier|CDHash)=(.*)$/.exec(line);
      if (!field) continue;
      const key = field[1],
        value = field[2];
      if (key === undefined || value === undefined || values.has(key)) {
        return windowNativeFailure();
      }
      values.set(key, value);
    }
    const team = values.get('TeamIdentifier'),
      identifier = values.get('Identifier'),
      cdHash = values.get('CDHash');
    if (team !== 'Q6L2SF6YDW' || identifier !== 'com.anthropic.claude-code' || cdHash === undefined || !/^[a-f0-9]{40,64}$/.test(cdHash))
      return windowNativeFailure();
    return { valid: true, team, identifier, cdHash };
  }

  #cleanup(): void {
    // Cleanup of owned artifacts is permitted after revocation; never follow a replacement.
    const owned = this.#owned;
    try {
      if (owned.directory !== null && owned.directoryStat === null) owned.directoryStat = lstatSync(owned.directory);
      if (owned.writable !== null && owned.fileStat === null) owned.fileStat = fstatSync(owned.writable);
    } catch (error) {
      if (!(error instanceof Error)) return windowNativeFailure();
      return windowNativeFailure();
    } finally {
      try {
        try {
          if (owned.writable !== null) closeSync(owned.writable);
        } finally {
          if (owned.readonlyFd !== null) closeSync(owned.readonlyFd);
        }
      } finally {
        try {
          if (owned.directory !== null && owned.directoryStat !== null && sameWindowIdentity(owned.directoryStat, lstatSync(owned.directory))) {
            try {
              if (owned.path !== null && owned.fileStat !== null && sameWindowInode(owned.fileStat, lstatSync(owned.path))) unlinkSync(owned.path);
            } finally {
              rmdirSync(owned.directory);
            }
          }
        } catch (error) {
          if (error instanceof Error) windowNativeFailure();
          windowNativeFailure();
        }
      }
    }
  }
}

export function createClaudeWindowBinaryAdapters(options: {
  readonly assertAuthorized: () => void;
  readonly scratchDirectory: string;
}): ClaudeWindowBinaryAdapters {
  const native = new ClaudeWindowNativeBoundary(options.assertAuthorized);
  return {
    currentUid: () => native.uid(),
    readProcess: pid => native.process(pid),
    readImage: pid => native.image(pid),
    realpath: path => native.step(() => realpathSync(path)),
    stat: path => windowNativeStat(native.step(() => lstatSync(path))),
    open: path => {
      let fd: number | null = null;
      try {
        native.step(() => {
          fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        });
      } catch (error) {
        if (fd !== null) {
          const acquired = fd;
          windowNativeCleanup(() => closeSync(acquired));
        }
        throw error;
      }
      if (fd === null) return windowNativeFailure();
      const opened = fd;
      let closed = false;
      const requireOpen = () => {
        native.authorize();
        if (closed) return windowNativeFailure();
      };
      return {
        stat: () => {
          requireOpen();
          return native.stat(opened);
        },
        read: (buffer, offset, length, position) => {
          requireOpen();
          return native.read(opened, buffer, offset, length, position);
        },
        verifySignature: () => {
          requireOpen();
          return new ClaudeWindowSnapshotVerifier(native, opened, options.scratchDirectory).verify();
        },
        close: () => {
          if (!closed) {
            closed = true;
            windowNativeCleanup(() => closeSync(opened));
          }
        }
      };
    }
  };
}

/** One reader belongs to one segment; failed identity checks cannot establish a new pin. */
export class ClaudeWindowBinaryReader {
  readonly #adapters: ClaudeWindowBinaryAdapters;
  readonly #authorize: () => void;
  #pin: ClaudeWindowBinaryPin | null = null;
  #stopped = false;

  constructor(options: { readonly adapters: ClaudeWindowBinaryAdapters; readonly assertAuthorized: () => void }) {
    this.#adapters = options.adapters;
    this.#authorize = options.assertAuthorized;
    this.#authorize();
  }

  snapshot(pid: number): ClaudeWindowBinaryPin {
    this.#authorize();
    if (this.#stopped) {
      throw new ClaudeWindowBinaryError('binding_executable_changed');
    }
    try {
      const current = this.#inspect(pid);
      if (this.#pin && JSON.stringify(current) !== JSON.stringify(this.#pin)) throw new ClaudeWindowBinaryError('binding_executable_changed');
      this.#pin ??= current;
      return this.#pin;
    } catch (error) {
      this.#stopped = true;
      throw error;
    }
  }

  revalidate(pin: ClaudeWindowBinaryPin): void {
    this.#authorize();
    if (this.#pin && JSON.stringify(pin) !== JSON.stringify(this.#pin)) {
      this.#stopped = true;
      throw new ClaudeWindowBinaryError('binding_executable_changed');
    }
    this.#pin ??= pin;
    this.snapshot(pin.process.pid);
  }

  #fail(): never {
    throw new ClaudeWindowBinaryError(this.#pin ? 'binding_executable_changed' : 'binding_executable_identity_unverified');
  }

  #call<T>(operation: () => T): T {
    this.#authorize();
    let value: T;
    try {
      value = operation();
    } catch {
      this.#authorize();
      return this.#fail();
    }
    this.#authorize();
    return value;
  }

  #process(pid: number): {
    readonly process: ClaudeWindowProcessMetadata;
    readonly parent: ClaudeWindowProcessMetadata;
  } {
    const uid = this.#call(() => this.#adapters.currentUid());
    if (!Number.isSafeInteger(pid) || pid < 1 || uid === null || !Number.isSafeInteger(uid) || uid < 0) return this.#fail();
    const process = this.#call(() => this.#adapters.readProcess(pid));
    if (!validWindowProcess(process, pid, uid)) return this.#fail();
    const parent = this.#call(() => this.#adapters.readProcess(process.parentPid));
    if (!validWindowProcess(parent, process.parentPid, uid) || parent.parentPid === pid) {
      return this.#fail();
    }
    return {
      process: Object.freeze({ ...process }),
      parent: Object.freeze({ ...parent })
    };
  }

  #inspect(pid: number): ClaudeWindowBinaryPin {
    const process = this.#process(pid);
    const image = this.#call(() => this.#adapters.readImage(pid));
    // No other Claude component role or native layout has an approved signing policy.
    if (!image || image.layout !== 'standalone' || image.requiredHost !== null) return this.#fail();
    const path = image.path;
    if (!isAbsolute(path) || path.includes('\0') || path.split('/').some(part => part === '.' || part === '..')) return this.#fail();
    if (this.#call(() => this.#adapters.realpath(path)) !== path) {
      return this.#fail();
    }
    const before = this.#call(() => this.#adapters.stat(path));
    this.#checkStat(before);
    this.#authorize();
    let handle: ClaudeWindowImageHandle;
    try {
      handle = this.#adapters.open(path);
    } catch {
      return this.#fail();
    }
    let sha256: string;
    let signature: ClaudeWindowSignature;
    try {
      this.#authorize();
      if (
        !sameWindowFile(
          before,
          this.#call(() => handle.stat())
        )
      ) {
        return this.#fail();
      }
      sha256 = this.#hash(handle, before.size);
      const verified = this.#call(() => handle.verifySignature());
      if (verified.sha256 !== sha256 || !sameWindowFile(before, verified.stat)) return this.#fail();
      signature = verified.signature;
      if (
        !signature.valid ||
        signature.team !== 'Q6L2SF6YDW' ||
        signature.identifier !== 'com.anthropic.claude-code' ||
        !/^[a-f0-9]{40,64}$/.test(signature.cdHash)
      ) {
        return this.#fail();
      }
      if (
        !sameWindowFile(
          before,
          this.#call(() => handle.stat())
        )
      ) {
        return this.#fail();
      }
      if (
        !sameWindowFile(
          before,
          this.#call(() => this.#adapters.stat(path))
        )
      ) {
        return this.#fail();
      }
    } finally {
      // Closing an already-open handle is cleanup, including after revocation.
      try {
        handle.close();
      } catch {
        this.#fail();
      }
    }
    if (this.#call(() => this.#adapters.realpath(path)) !== path) {
      return this.#fail();
    }
    if (JSON.stringify(this.#process(pid)) !== JSON.stringify(process)) {
      return this.#fail();
    }
    const after = this.#call(() => this.#adapters.readImage(pid));
    if (!after || after.path !== path || after.layout !== image.layout || after.requiredHost !== null) return this.#fail();
    this.#authorize();
    return Object.freeze({
      mode: 'publisher_verified_local_pin',
      ...process,
      path,
      stat: Object.freeze({ ...before }),
      sha256,
      signature: Object.freeze({ ...signature }),
      mappedImageProof: 'unverified'
    });
  }

  #checkStat(stat: ClaudeWindowImageStat): void {
    if (
      !stat.regularFile ||
      !Number.isSafeInteger(stat.device) ||
      !Number.isSafeInteger(stat.inode) ||
      !Number.isSafeInteger(stat.size) ||
      stat.size < 8 ||
      stat.size > claudeWindowImageLimits.cli ||
      (stat.mode & 0o111) === 0 ||
      !Number.isFinite(stat.mtimeMs) ||
      !Number.isFinite(stat.ctimeMs)
    ) {
      this.#fail();
    }
  }

  #hash(handle: ClaudeWindowImageHandle, size: number): string {
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(65536);
    for (let offset = 0; offset < size;) {
      const length = Math.min(buffer.length, size - offset);
      const count = this.#call(() => handle.read(buffer, 0, length, offset));
      if (!Number.isSafeInteger(count) || count < 1 || count > length) {
        return this.#fail();
      }
      // MH_MAGIC_64 and CPU_TYPE_ARM64; no wrapper or alternate image format.
      if (offset === 0 && (count < 8 || buffer.readUInt32LE(0) !== 0xfeedfacf || buffer.readUInt32LE(4) !== 0x0100000c)) return this.#fail();
      hash.update(buffer.subarray(0, count));
      offset += count;
    }
    return hash.digest('hex');
  }
}
