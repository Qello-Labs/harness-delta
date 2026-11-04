import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, test } from 'vitest';
import { z } from 'zod';

const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));

test('relocated binding qualification still freezes implementation siblings outside its folder', () => {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'qualification-scope-')));
  try {
    const dist = join(temporary, 'dist');
    cpSync(join(root, 'dist'), dist, { recursive: true });
    copyFileSync(join(root, 'package.json'), join(temporary, 'package.json'));
    symlinkSync(join(root, 'node_modules'), join(temporary, 'node_modules'), 'dir');
    mkdirSync(join(temporary, 'skills'));
    cpSync(join(root, 'skills', 'harness-connect'), join(temporary, 'skills', 'harness-connect'), { recursive: true });
    mkdirSync(join(temporary, 'scripts'));
    for (const name of ['owned-cli-pty.py', 'session-binding-codex-hook.mjs']) {
      copyFileSync(join(root, 'scripts', name), join(temporary, 'scripts', name));
    }
    // Both UI layouts isolate scope coverage from asset-path failures.
    mkdirSync(join(dist, 'dist'));
    cpSync(join(dist, 'local-ui'), join(dist, 'dist', 'local-ui'), { recursive: true });

    const filename = 'codex-session-binding-qualification.js';
    const source = ts.createSourceFile(filename, readFileSync(join(dist, 'qualification', filename), 'utf8'), ts.ScriptTarget.ES2023, true, ts.ScriptKind.JS);
    const relocated = ts.factory.updateSourceFile(
      source,
      source.statements.map(statement => {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !statement.moduleSpecifier.text.startsWith('.'))
          return statement;
        return ts.factory.updateImportDeclaration(
          statement,
          statement.modifiers,
          statement.importClause,
          ts.factory.createStringLiteral('../' + statement.moduleSpecifier.text),
          statement.attributes
        );
      })
    );
    const moved = join(dist, 'qualification', 'relocated', filename);
    mkdirSync(dirname(moved));
    renameSync(join(dist, 'qualification', filename), moved);
    writeFileSync(moved, ts.createPrinter().printFile(relocated));
    mkdirSync(join(temporary, 'home'));
    mkdirSync(join(temporary, 'home', 'sessions'));
    writeFileSync(join(temporary, 'fixture.mjs'), 'process.exit(0);\n');

    const driver = join(temporary, 'probe.mjs');
    writeFileSync(
      driver,
      `
import { appendFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { prepareCodexSessionBindingQualification } from './dist/qualification/relocated/${filename}';
const root = ${JSON.stringify(temporary)};
const input = { binary: realpathSync(process.execPath), codexHome: join(root, 'home') };
const fixture = { script: join(root, 'fixture.mjs'), durationMs: 5000 };
const before = await prepareCodexSessionBindingQualification(join(root, 'before'), input, fixture);
appendFileSync(join(root, 'dist', 'store.js'), '\\n');
const after = await prepareCodexSessionBindingQualification(join(root, 'after'), input, fixture);
process.stdout.write(JSON.stringify({ before: before.intent.implementation_digest, after: after.intent.implementation_digest }));
`
    );
    const output: unknown = JSON.parse(
      execFileSync(realpathSync(process.execPath), [driver], {
        encoding: 'utf8',
        timeout: 30000
      })
    );
    const digests = z.object({ before: z.string().regex(/^[a-f0-9]{64}$/), after: z.string().regex(/^[a-f0-9]{64}$/) }).parse(output);
    expect(digests.after).not.toBe(digests.before);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}, 30000);

test.each(['core/configuration-evidence', 'comparison/config-confirmation-write'])(
  'workflow qualification freezes extracted %s implementation bytes',
  name => {
    const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-scope-')));
    try {
      cpSync(join(root, 'dist'), join(temporary, 'dist'), { recursive: true });
      copyFileSync(join(root, 'package.json'), join(temporary, 'package.json'));
      symlinkSync(join(root, 'node_modules'), join(temporary, 'node_modules'), 'dir');
      mkdirSync(join(temporary, 'home'));
      mkdirSync(join(temporary, 'home', 'sessions'));
      writeFileSync(join(temporary, 'fixture.mjs'), 'process.exit(0);\n');
      const driver = join(temporary, 'probe.mjs');
      writeFileSync(
        driver,
        `
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { prepareCodexWorkflowQualification } from './dist/qualification/codex-workflow-qualification.js';
const root = ${JSON.stringify(temporary)};
const input = {
  binary: { path: realpathSync(process.execPath), sha256: createHash('sha256').update(readFileSync(process.execPath)).digest('hex') },
  codex_home: join(root, 'home'),
  hook_recorder: ${JSON.stringify(join(root, 'scripts', 'conformance', 'candidate-start-recorder.mjs'))}
};
const fixture = { fixtureScript: join(root, 'fixture.mjs'), durationMs: 5000 };
const before = prepareCodexWorkflowQualification(join(root, 'before'), input, fixture);
appendFileSync(join(root, 'dist', ${JSON.stringify(name + '.js')}), '\\n');
const after = prepareCodexWorkflowQualification(join(root, 'after'), input, fixture);
process.stdout.write(JSON.stringify({ before: before.intent.implementation_digest, after: after.intent.implementation_digest }));
`
      );
      const output: unknown = JSON.parse(execFileSync(realpathSync(process.execPath), [driver], { encoding: 'utf8', timeout: 30000 }));
      const digests = z.object({ before: z.string().regex(/^[a-f0-9]{64}$/), after: z.string().regex(/^[a-f0-9]{64}$/) }).parse(output);
      expect(digests.after).not.toBe(digests.before);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  },
  30000
);
