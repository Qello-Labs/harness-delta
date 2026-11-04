import { closeSync, lstatSync, readFileSync, openSync, readSync, fstatSync, writeFileSync, fsyncSync, linkSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalJson } from '../reports/comparison-snapshot.js';
import { MAX_BYTES, parseExchangePackage } from './contracts.js';
import type { ExchangePackage } from './contracts.js';

/** Parse JSON without accepting duplicate (including escape-equivalent) object keys. */
export function parseUniqueJson(text: string): unknown {
  let pos = 0;
  const fail = (): never => {
    throw new Error('invalid_exchange_package');
  };
  const whitespace = () => {
    while (pos < text.length && /[\x20\t\r\n]/.test(text[pos]!)) pos++;
  };
  const string = (): string => {
    const start = pos++;
    let escaped = false;
    while (pos < text.length) {
      const ch = text[pos++]!;
      if (!escaped && ch === '"') return JSON.parse(text.slice(start, pos)) as string;
      if (!escaped && ch === '\\') escaped = true;
      else escaped = false;
    }
    return fail();
  };
  const value = (depth: number): unknown => {
    if (depth > 128) return fail();
    whitespace();
    const ch = text[pos];
    if (ch === '"') return string();
    if (ch === '{') {
      pos++;
      whitespace();
      const result: Record<string, unknown> = {};
      const keys = new Set<string>();
      if (text[pos] === '}') {
        pos++;
        return result;
      }
      while (true) {
        whitespace();
        if (text[pos] !== '"') return fail();
        const key = string();
        if (keys.has(key)) return fail();
        keys.add(key);
        whitespace();
        if (text[pos++] !== ':') return fail();
        Object.defineProperty(result, key, { value: value(depth + 1), enumerable: true, configurable: true, writable: true });
        whitespace();
        const end = text[pos++];
        if (end === '}') return result;
        if (end !== ',') return fail();
      }
    }
    if (ch === '[') {
      pos++;
      whitespace();
      const result: unknown[] = [];
      if (text[pos] === ']') {
        pos++;
        return result;
      }
      while (true) {
        result.push(value(depth + 1));
        whitespace();
        const end = text[pos++];
        if (end === ']') return result;
        if (end !== ',') return fail();
      }
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(pos))?.[0];
    if (!token) return fail();
    pos += token.length;
    return JSON.parse(token) as unknown;
  };
  try {
    const result = value(0);
    whitespace();
    if (pos !== text.length) return fail();
    return result;
  } catch {
    return fail();
  }
}
export function readExchangeFile(path: string): unknown {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error('exchange_io_error');
    if (stat.size > MAX_BYTES) throw new Error('exchange_limit_exceeded');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let bytes = 0;
    let read: number;
    do {
      read = readSync(fd, buffer, bytes, buffer.length - bytes, null);
      bytes += read;
    } while (read && bytes < buffer.length);
    if (bytes > MAX_BYTES) throw new Error('exchange_limit_exceeded');
    return parseUniqueJson(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytes)));
  } catch (error) {
    if (error instanceof Error && ['invalid_exchange_package', 'exchange_limit_exceeded'].includes(error.message)) throw error;
    // Raw filesystem errors may contain private paths; deliberately discard their cause.
    // eslint-disable-next-line preserve-caught-error
    throw new Error('exchange_io_error');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
export function publishExchangeFile(path: string, input: ExchangePackage): void {
  const pkg = parseExchangePackage(input);
  const bytes = canonicalJson(pkg);
  const temp = join(dirname(path), `.exchange-${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temp, 'wx', 0o600);
    writeFileSync(fd, bytes, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    try {
      linkSync(temp, path);
    } catch {
      // An identical existing artifact is safe to replay; all other targets fail closed.
      const existing = lstatSync(path);
      if (!existing.isFile() || (existing.mode & 0o077) !== 0 || existing.size !== Buffer.byteLength(bytes) || !readFileSync(path).equals(Buffer.from(bytes)))
        throw new Error('exchange_io_error');
    }
  } catch {
    throw new Error('exchange_io_error');
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temp);
    } catch {
      /* No artifact was published at the temporary path. */
    }
  }
}
