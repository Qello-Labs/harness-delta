import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, test, vi } from 'vitest';
import { ModuleKind, ScriptTarget, transpileModule, version, type CompilerOptions } from 'typescript';
import { createCompiledWorker } from './helpers/compiled-worker.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'compiled-worker-cache-'));
  roots.push(root);
  const sourceRoot = join(root, 'src');
  mkdirSync(join(sourceRoot, 'nested'), { recursive: true });
  mkdirSync(join(sourceRoot, 'migrations'));
  writeFileSync(join(sourceRoot, 'entry.ts'), 'export const value: number = 11; export const get = () => value;');
  writeFileSync(join(sourceRoot, 'nested', 'other.ts'), 'export const value: number = 33;');
  writeFileSync(join(sourceRoot, 'codex-admissions.json'), '{"revision":1}');
  writeFileSync(join(sourceRoot, 'migrations', '001.sql'), 'SELECT 1;');
  const compiler = {
    version,
    options: { module: ModuleKind.ESNext, target: ScriptTarget.ES2023 } as CompilerOptions,
    transpile: vi.fn(transpileModule)
  };
  const compile = createCompiledWorker(pathToFileURL(sourceRoot), compiler);
  let sequence = 0;
  const emit = () => {
    const outputRoot = join(root, `fixture-${sequence++}`);
    mkdirSync(outputRoot);
    return compile(outputRoot);
  };
  return { root, sourceRoot, compiler, emit };
}

function valueAt(compiled: string, file = 'entry.js'): number {
  return Number(
    execFileSync(
      process.execPath,
      ['--input-type=module', '--eval', 'const module = await import(process.argv[1]); console.log(module.value);', pathToFileURL(join(compiled, file)).href],
      { encoding: 'utf8' }
    ).trim()
  );
}

test('unchanged sources compile once and produce separate runnable fixture outputs', () => {
  const f = fixture();
  const first = f.emit();
  const second = f.emit();
  expect(first).not.toBe(second);
  expect(valueAt(first)).toBe(11);
  expect(valueAt(second, 'nested/other.js')).toBe(33);
  expect(f.compiler.transpile).toHaveBeenCalledTimes(2);
});

test('same-size source edits with restored timestamps refresh only the changed source', () => {
  const f = fixture();
  const source = join(f.sourceRoot, 'entry.ts');
  const fixedTime = new Date('2000-01-01T00:00:00.000Z');
  utimesSync(source, fixedTime, fixedTime);
  const before = statSync(source);
  const first = f.emit();
  writeFileSync(source, 'export const value: number = 22; export const get = () => value;');
  utimesSync(source, fixedTime, fixedTime);
  const after = statSync(source);
  expect(after.size).toBe(before.size);
  expect(after.mtimeMs).toBe(before.mtimeMs);
  const second = f.emit();
  expect(valueAt(second)).toBe(22);
  expect(valueAt(first)).toBe(11);
  expect(f.compiler.transpile).toHaveBeenCalledTimes(3);
});

test('exact source bytes invalidate reuse even when UTF-8 decoding is unchanged', () => {
  const f = fixture();
  const source = join(f.sourceRoot, 'entry.ts');
  const prefix = Buffer.from('export const value: number = 11; // ');
  writeFileSync(source, Buffer.concat([prefix, Buffer.from([0x80])]));
  const first = f.emit();
  writeFileSync(source, Buffer.concat([prefix, Buffer.from([0x81])]));
  const second = f.emit();
  expect(valueAt(first)).toBe(11);
  expect(valueAt(second)).toBe(11);
  expect(f.compiler.transpile).toHaveBeenCalledTimes(3);
});

test('compiler options, version and implementation changes invalidate emitted text', () => {
  const f = fixture();
  const first = f.emit();
  f.compiler.options.target = ScriptTarget.ES5;
  const second = f.emit();
  expect(valueAt(second)).toBe(11);
  expect(readFileSync(join(second, 'entry.js'), 'utf8')).not.toBe(readFileSync(join(first, 'entry.js'), 'utf8'));
  expect(f.compiler.transpile).toHaveBeenCalledTimes(4);
  f.compiler.version = 'synthetic-next-compiler';
  expect(valueAt(f.emit())).toBe(11);
  expect(f.compiler.transpile).toHaveBeenCalledTimes(6);
  f.compiler.transpile = vi.fn(transpileModule);
  expect(valueAt(f.emit())).toBe(11);
  expect(f.compiler.transpile).toHaveBeenCalledTimes(2);
});

test('fresh source discovery includes additions and omits deletions from new fixtures', () => {
  const f = fixture();
  const first = f.emit();
  writeFileSync(join(f.sourceRoot, 'nested', 'added.ts'), 'export const value: number = 44;');
  const second = f.emit();
  expect(valueAt(second, 'nested/added.js')).toBe(44);
  expect(existsSync(join(first, 'nested', 'added.js'))).toBe(false);
  rmSync(join(f.sourceRoot, 'nested', 'other.ts'));
  const third = f.emit();
  expect(existsSync(join(third, 'nested', 'other.js'))).toBe(false);
  expect(valueAt(first, 'nested/other.js')).toBe(33);
  expect(valueAt(third, 'nested/added.js')).toBe(44);
  expect(f.compiler.transpile).toHaveBeenCalledTimes(3);
});

test('each fixture copies current admissions and migrations without changing older assets', () => {
  const f = fixture();
  const first = f.emit();
  writeFileSync(join(f.sourceRoot, 'codex-admissions.json'), '{"revision":2}');
  writeFileSync(join(f.sourceRoot, 'migrations', '002.sql'), 'SELECT 2;');
  rmSync(join(f.sourceRoot, 'migrations', '001.sql'));
  const second = f.emit();
  expect(readFileSync(join(first, 'codex-admissions.json'), 'utf8')).toBe('{"revision":1}');
  expect(readFileSync(join(second, 'codex-admissions.json'), 'utf8')).toBe('{"revision":2}');
  expect(readFileSync(join(second, 'migrations', '002.sql'), 'utf8')).toBe('SELECT 2;');
  expect(existsSync(join(second, 'migrations', '001.sql'))).toBe(false);
  expect(readFileSync(join(first, 'migrations', '001.sql'), 'utf8')).toBe('SELECT 1;');
  writeFileSync(join(f.sourceRoot, 'migrations', '002.sql'), 'SELECT 3;');
  const third = f.emit();
  expect(readFileSync(join(third, 'migrations', '002.sql'), 'utf8')).toBe('SELECT 3;');
  expect(readFileSync(join(second, 'migrations', '002.sql'), 'utf8')).toBe('SELECT 2;');
  expect(f.compiler.transpile).toHaveBeenCalledTimes(2);
});

test('output mutation and fixture cleanup cannot alter another fixture or cached output', () => {
  const f = fixture();
  const first = f.emit();
  const second = f.emit();
  writeFileSync(join(first, 'entry.js'), 'export const value = 99;');
  expect(valueAt(first)).toBe(99);
  expect(valueAt(second)).toBe(11);
  rmSync(first, { recursive: true });
  expect(valueAt(second, 'nested/other.js')).toBe(33);
  expect(valueAt(f.emit())).toBe(11);
  expect(f.compiler.transpile).toHaveBeenCalledTimes(2);
});
