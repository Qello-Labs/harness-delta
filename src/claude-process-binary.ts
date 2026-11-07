import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
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
