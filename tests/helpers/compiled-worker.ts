import { cpSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ModuleKind, ScriptTarget, transpileModule, version, type CompilerOptions } from 'typescript';

/** Test-only seam for synthetic source trees and compiler freshness checks. */
export function createCompiledWorker(sourceRoot: URL, compiler: {
  version: string;
  options: CompilerOptions;
  transpile: typeof transpileModule;
} = {
  version,
  options: { module: ModuleKind.ESNext, target: ScriptTarget.ES2023 },
  transpile: transpileModule,
}): (root: string) => string {
  const sourceDirectory = fileURLToPath(sourceRoot);
  // Cache immutable emitted text, never a fixture directory or its mutable files.
  const sources = new Map<string, {
    source: Buffer;
    compilerKey: string;
    transpile: typeof transpileModule;
    output: string;
  }>();
  return (root: string): string => {
    const compilerKey = JSON.stringify([compiler.version, compiler.options]);
    const transpile = compiler.transpile;
    const compiled = join(root, 'compiled');
    mkdirSync(compiled);
    writeFileSync(join(compiled, 'package.json'), '{"type":"module"}');
    symlinkSync(join(process.cwd(), 'node_modules'), join(compiled, 'node_modules'), 'dir');
    for (const name of readdirSync(sourceDirectory, { recursive: true, encoding: 'utf8' })) {
      if (!name.endsWith('.ts')) continue;
      const source = readFileSync(join(sourceDirectory, name));
      const cached = sources.get(name);
      let output: string;
      if (cached?.compilerKey === compilerKey && cached.transpile === transpile && cached.source.equals(source)) {
        output = cached.output;
      } else {
        output = transpile(source.toString('utf8'), { compilerOptions: compiler.options }).outputText;
        sources.set(name, { source, compilerKey, transpile, output });
      }
      mkdirSync(dirname(join(compiled, name)), { recursive: true });
      writeFileSync(join(compiled, name.replace(/\.ts$/, '.js')), output);
    }
    // Assets remain fresh per fixture, independently of unchanged TypeScript input.
    cpSync(join(sourceDirectory, 'codex-admissions.json'), join(compiled, 'codex-admissions.json'));
    cpSync(join(sourceDirectory, 'migrations'), join(compiled, 'migrations'), { recursive: true });
    return compiled;
  };
}

const compileLocalWorker = createCompiledWorker(new URL('../../src/', import.meta.url));

/** Compile only current local source for real SQLite worker races; never use stale dist. */
export function compiledWorker(root: string): string { return compileLocalWorker(root); }
