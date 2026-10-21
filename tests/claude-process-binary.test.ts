import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, realpathSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { readClaudeProcessBinary } from '../src/claude-process-binary.js';

const native = vi.hoisted(() => ({ path: '', sha256: '', version: '2.1.306' }));
vi.mock('node:child_process', () => ({
  execFileSync: () => `p${process.pid}\nn${native.path}\n`,
}));
vi.mock('../src/claude-binding-admission.js', () => ({
  claudeBindingRuntimeSupported: () => true,
  claudeBindingAdmissions: [{
    admitted: true,
    get productVersion() { return native.version; },
    get binarySha256() { return native.sha256; },
  }],
}));

const targetBytes = 272984176;
let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'claude-image-')));
  native.path = join(root, 'synthetic-image');
  native.version = '2.1.306';
  writeFileSync(native.path, '', { mode: 0o700 });
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function image(bytes: number) {
  truncateSync(native.path, bytes);
  const hash = createHash('sha256'), zeros = Buffer.alloc(65536);
  for (let offset = 0; offset < bytes; offset += zeros.length)
    hash.update(zeros.subarray(0, Math.min(zeros.length, bytes - offset)));
  native.sha256 = hash.digest('hex');
}

test('accepts a pinned image at the actual 2.1.306 size beyond the old ceiling', () => {
  image(targetBytes);
  expect(readClaudeProcessBinary(process.pid)).toEqual({
    productVersion: '2.1.306', sha256: native.sha256,
  });
});

test('rejects an image above the finite ceiling even with an admitted digest', () => {
  image(targetBytes + 1);
  expect(() => readClaudeProcessBinary(process.pid)).toThrow('claude_binary_unqualified');
});

test('rejects an unadmitted digest at an otherwise permitted image size', () => {
  image(1024);
  native.sha256 = 'f'.repeat(64);
  expect(() => readClaudeProcessBinary(process.pid)).toThrow('claude_binary_unqualified');
});

test('keeps a historical pinned image valid below the ceiling', () => {
  image(1024);
  native.version = '2.1.301';
  expect(readClaudeProcessBinary(process.pid)).toEqual({
    productVersion: '2.1.301', sha256: native.sha256,
  });
});

test('rejects a nonexecutable image even when its digest is admitted', () => {
  image(1024);
  chmodSync(native.path, 0o600);
  expect(() => readClaudeProcessBinary(process.pid)).toThrow('claude_binary_unqualified');
});
