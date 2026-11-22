import * as filesystem from 'node:fs';
import * as filesystemAsync from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { expect, vi } from 'vitest';
import { z } from 'zod';

type Product = 'codex' | 'claude_code';
type IoCall = {
  readonly name: string;
  readonly args: readonly unknown[];
  readonly order: number;
  readonly result: unknown;
  readonly resultType: string;
};
const metadataSchema = z.object({ mode: z.number(), uid: z.number(), nlink: z.number(), size: z.number() });

function calls(): IoCall[] {
  const result: IoCall[] = [];
  for (const [prefix, module] of [
    ['sync', filesystem],
    ['async', filesystemAsync]
  ] as const) {
    for (const [name, operation] of Object.entries(module)) {
      if (typeof operation !== 'function') continue;
      if (!vi.isMockFunction(operation)) throw new Error(`fixture_unobserved_io:${prefix}.${name}`);
      for (const [index, args] of operation.mock.calls.entries()) {
        const order = operation.mock.invocationCallOrder[index];
        const returned = operation.mock.results[index];
        if (order === undefined || returned === undefined) throw new Error('fixture_io_result_missing');
        result.push({ name: `${prefix}.${name}`, args, order, result: returned.value, resultType: returned.type });
      }
    }
  }
  return result.sort((left, right) => left.order - right.order);
}

function expectReads(projectRoot: string, product: Product, observed: readonly IoCall[]): void {
  expect(resolve(projectRoot)).toBe(projectRoot);
  const directory = join(projectRoot, '.harness-delta', product === 'codex' ? 'window-receipts' : 'claude-window-receipts');
  const target = join(directory, 'ordinary-window-control.json');
  const ancestors: string[] = [];
  for (let current = directory; ; current = dirname(current)) {
    ancestors.unshift(current);
    if (current === dirname(current)) break;
  }
  let index = 0;
  function take(name: string, args: readonly unknown[]): IoCall {
    const call = observed[index++];
    expect(call, `only guarded control reads for ${target}`).toBeDefined();
    if (!call) throw new Error('fixture_control_io_missing');
    expect(call.name).toBe(`sync.${name}`);
    expect(call.args).toEqual(args);
    expect(call.resultType).toBe('return');
    return call;
  }
  while (index < observed.length) {
    let missing = false;
    for (const ancestor of ancestors) {
      const call = take('lstatSync', [ancestor, { throwIfNoEntry: false }]);
      if (call.result === undefined) {
        missing = true;
        break;
      }
      const stat = metadataSchema.parse(call.result);
      expect(stat.mode & 0o170000).toBe(0o040000);
      if (ancestor === directory) {
        expect(stat.uid).toBe(process.getuid?.());
        expect(stat.mode & 0o077).toBe(0);
      }
    }
    if (missing) continue;
    const leaf = take('lstatSync', [target, { throwIfNoEntry: false }]);
    if (leaf.result === undefined) continue;
    const opened = take('openSync', [target, filesystem.constants.O_RDONLY | filesystem.constants.O_NOFOLLOW | filesystem.constants.O_NONBLOCK]);
    const fd = z.number().int().nonnegative().parse(opened.result);
    const stat = metadataSchema.parse(take('fstatSync', [fd]).result);
    expect(stat.mode & 0o170000).toBe(0o100000);
    expect(stat.nlink).toBe(1);
    expect(stat.uid).toBe(process.getuid?.());
    expect(stat.mode & 0o077).toBe(0);
    expect(stat.size).toBeLessThanOrEqual(4096);
    const read = observed[index];
    const buffer = read?.args[1];
    expect(Buffer.isBuffer(buffer)).toBe(true);
    if (!Buffer.isBuffer(buffer)) throw new Error('fixture_control_buffer_missing');
    expect(buffer.length).toBe(4097);
    const size = z
      .number()
      .int()
      .nonnegative()
      .max(4096)
      .parse(take('readSync', [fd, buffer, 0, 4097, 0]).result);
    expect(size).toBe(stat.size);
    const control: unknown = JSON.parse(buffer.subarray(0, size).toString('utf8'));
    expect(control).toMatchObject({ projectRoot, product });
    expect(take('closeSync', [fd]).result).toBeUndefined();
  }
  expect(index).toBe(observed.length);
}

export function expectOnlyGuardedControlReads(projectRoot: string, product: Product): void {
  expectReads(projectRoot, product, calls());
}

export function captureGuardedControlIo(projectRoot: string, product: Product) {
  const boundary = calls().at(-1)?.order ?? 0;
  return {
    expectOnlyReads: () =>
      expectReads(
        projectRoot,
        product,
        calls().filter(call => call.order > boundary)
      )
  };
}
