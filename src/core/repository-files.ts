import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

const fail = (code = 'invalid_shared_config'): never => {
  throw new Error(code);
};
export const hashBytes = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export function safeRelativePath(value: string): boolean {
  return (
    value.length <= 2048 &&
    value
      .split('/')
      .every(
        part =>
          /^[A-Za-z0-9._-]+$/.test(part) && !['.', '..'].includes(part) && !part.endsWith('.') && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
      )
  );
}
/** Canonical metadata only. Artifact bytes are never normalized. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isSafeInteger(value) && !Object.is(value, -0) ? JSON.stringify(value) : fail();
  if (typeof value === 'string') {
    if (value.includes('\0') || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) fail();
    return JSON.stringify(value.normalize('NFC'));
  }
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (keys.some(key => !/^[a-zA-Z0-9_]+$/.test(key))) fail();
    return '{' + keys.map(key => JSON.stringify(key) + ':' + canonicalJson(record[key])).join(',') + '}';
  }
  return fail();
}
/** Strict bounded JSON parser: JSON.parse alone silently accepts duplicate keys. */
export function readStrictJson(bytes: Buffer): unknown {
  if (bytes.length > 1048576 || !Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)) fail();
  const text = bytes.toString('utf8');
  let offset = 0;
  const ws = () => {
    while (/[ \t\r\n]/.test(text[offset] ?? '') && offset < text.length) offset++;
  };
  const string = () => {
    const start = offset++;
    while (offset < text.length) {
      if (text[offset] === '\\') offset += 2;
      else if (text[offset++] === '"') return JSON.parse(text.slice(start, offset)) as string;
    }
    return fail();
  };
  const value = (depth: number): unknown => {
    if (depth > 64) fail();
    ws();
    const ch = text[offset];
    if (ch === '"') return string();
    if (ch === '{') {
      offset++;
      ws();
      const out: Record<string, unknown> = {};
      const keys = new Set<string>();
      if (text[offset] === '}') {
        offset++;
        return out;
      }
      for (;;) {
        ws();
        if (text[offset] !== '"') fail();
        const key = string();
        if (keys.has(key) || key === '__proto__') fail();
        keys.add(key);
        ws();
        if (text[offset++] !== ':') fail();
        out[key] = value(depth + 1);
        ws();
        const end = text[offset++];
        if (end === '}') return out;
        if (end !== ',') fail();
      }
    }
    if (ch === '[') {
      offset++;
      ws();
      const out: unknown[] = [];
      if (text[offset] === ']') {
        offset++;
        return out;
      }
      for (;;) {
        out.push(value(depth + 1));
        ws();
        const end = text[offset++];
        if (end === ']') return out;
        if (end !== ',') fail();
      }
    }
    const token = text.slice(offset).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/)?.[0];
    if (!token) return fail();
    offset += token.length;
    return JSON.parse(token) as unknown;
  };
  try {
    const result = value(0);
    ws();
    if (offset !== text.length) fail();
    canonicalJson(result);
    return result;
  } catch {
    return fail();
  }
}
/** Every path component must stay a stable no-follow entry under the explicit root. */
export function readRepositoryFile(root: string, relativePath: string, limit = 1048576): Buffer {
  if (!safeRelativePath(relativePath)) fail('shared_path_invalid');
  let fd: number | undefined;
  try {
    const anchor = realpathSync(root);
    const components = relativePath.split('/');
    const paths = [anchor];
    for (const component of components) paths.push(join(paths.at(-1)!, component));
    const before = paths.map(path => lstatSync(path, { bigint: true }));
    if (before.some((stat, i) => stat.isSymbolicLink() || (i < before.length - 1 ? !stat.isDirectory() : !stat.isFile()))) fail('shared_path_invalid');
    const target = paths.at(-1)!;
    fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd, { bigint: true });
    if (stat.size > BigInt(limit) || !stat.isFile()) fail();
    const buffer = Buffer.alloc(Number(stat.size) + 1);
    let length = 0;
    while (length < buffer.length) {
      const size = readSync(fd, buffer, length, buffer.length - length, null);
      if (!size) break;
      length += size;
    }
    if (length !== Number(stat.size)) fail('shared_content_mismatch');
    const bytes = buffer.subarray(0, length);
    const after = fstatSync(fd, { bigint: true });
    const equal = (a: typeof stat, b: typeof stat) =>
      a.ino === b.ino && a.dev === b.dev && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
    if (!equal(stat, after) || paths.some((path, i) => !equal(before[i]!, lstatSync(path, { bigint: true }))) || realpathSync(target) !== target)
      fail('shared_content_mismatch');
    const second = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!equal(stat, fstatSync(second, { bigint: true }))) fail('shared_content_mismatch');
    } finally {
      closeSync(second);
    }
    return bytes;
  } catch (error) {
    if (error instanceof Error && ['shared_path_invalid', 'shared_content_mismatch', 'invalid_shared_config'].includes(error.message)) throw error;
    return fail('shared_file_unavailable');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
export function ensureRepositoryDirectory(root: string, relativePath: string): string {
  if (!safeRelativePath(relativePath)) fail('shared_path_invalid');
  let current = realpathSync(root);
  for (const component of relativePath.split('/')) {
    current = join(current, component);
    try {
      mkdirSync(current, { mode: 0o700 });
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
    }
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory() || realpathSync(current) !== current) fail('shared_path_invalid');
  }
  return current;
}
