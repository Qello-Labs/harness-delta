import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { claudeBindingAdmission, claudeBindingRuntimeSupported } from './claude-binding-admission.js';

export interface ClaudeProcessBinary {
  readonly productVersion: string;
  readonly sha256: string;
}
const images = new Map<string, ClaudeProcessBinary>();

/** Kernel image metadata only. No process arguments, environment or transcript reads. */
export function readClaudeProcessBinary(pid: number): ClaudeProcessBinary {
  if (!claudeBindingRuntimeSupported()) throw new Error('binding_runtime_unsupported');
  const fields = execFileSync('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'txt', '-Fn'], {
    encoding: 'utf8', timeout: 2000, maxBuffer: 65536,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).split('\n');
  const image = fields.find(field => field.startsWith('n'));
  const path = image?.slice(1);
  if (!path || !isAbsolute(path) || realpathSync(path) !== path)
    throw new Error('claude_binary_unqualified');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size < 1 || before.size > 256 * 1048576 || (before.mode & 0o111) === 0)
      throw new Error('claude_binary_unqualified');
    const key = JSON.stringify([pid, path, before.dev, before.ino, before.size, before.mtimeMs, before.ctimeMs]);
    const cached = images.get(key);
    if (cached) return cached;
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(65536);
    for (let offset = 0; offset < before.size;) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (!count) throw new Error('claude_binary_unqualified');
      hash.update(buffer.subarray(0, count)); offset += count;
    }
    const after = fstatSync(fd);
    const digest = hash.digest('hex');
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
      digest !== claudeBindingAdmission.binarySha256) throw new Error('claude_binary_unqualified');
    const binary = { productVersion: claudeBindingAdmission.productVersion, sha256: digest };
    images.set(key, binary);
    if (images.size > 64) {
      const oldest = images.keys().next().value;
      if (oldest !== undefined) images.delete(oldest);
    }
    return binary;
  } finally { closeSync(fd); }
}
