import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, test } from 'vitest';
import { implementationExtension, implementationPath, packagePath, packagedSkillPath } from '../src/package-paths.js';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));

test('source package assets stay relative to the complete source tree', () => {
  expect({
    root: packagePath(),
    script: packagePath('scripts', 'owned-cli-pty.py'),
    skill: packagedSkillPath('harness-connect'),
    migration: implementationPath('migrations', '001_initial.sql'),
    catalog: packagePath('config', 'prices', 'catalogs'),
    ui: implementationPath('local-ui'),
    qualificationUi: packagePath('dist', 'local-ui'),
    extension: implementationExtension
  }).toEqual({
    root,
    script: join(root, 'scripts', 'owned-cli-pty.py'),
    skill: join(root, 'skills', 'harness-connect'),
    migration: join(root, 'src', 'migrations', '001_initial.sql'),
    catalog: join(root, 'config', 'prices', 'catalogs'),
    ui: join(root, 'src', 'local-ui'),
    qualificationUi: join(root, 'dist', 'local-ui'),
    extension: '.ts'
  });
});

test.each(['dist', 'compiled'])('emitted assets resolve from %s with a relocated caller and no manifest', directory => {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'package-paths-')));
  try {
    const implementation = join(temporary, directory);
    const nested = join(implementation, 'nested');
    mkdirSync(nested, { recursive: true });
    const source = readFileSync(join(root, 'src', 'package-paths.ts'), 'utf8');
    const emitted = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext }
    }).outputText;
    writeFileSync(join(implementation, 'package-paths.mjs'), emitted);
    const caller = join(nested, 'caller.mjs');
    writeFileSync(
      caller,
      `
import { implementationExtension, implementationPath, packagePath, packagedSkillPath } from '../package-paths.mjs';
process.stdout.write(JSON.stringify({
  root: packagePath(), tree: implementationPath(), extension: implementationExtension,
  script: packagePath('scripts', 'owned-cli-pty.py'),
  skill: packagedSkillPath('harness-connect'),
  migrations: implementationPath('migrations'), catalogs: implementationPath('catalogs'),
  ui: implementationPath('local-ui')
}));
`
    );
    const actual: unknown = JSON.parse(execFileSync(process.execPath, [caller], { encoding: 'utf8' }));
    expect(actual).toEqual({
      root: temporary,
      tree: implementation,
      extension: '.js',
      script: join(temporary, 'scripts', 'owned-cli-pty.py'),
      skill: join(implementation, 'skills', 'harness-connect'),
      migrations: join(implementation, 'migrations'),
      catalogs: join(implementation, 'catalogs'),
      ui: join(implementation, 'local-ui')
    });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
