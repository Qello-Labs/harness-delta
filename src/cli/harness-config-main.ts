#!/usr/bin/env node
import { Command } from 'commander';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, basename } from 'node:path';
import { readStrictJson, readRepositoryFile, registerHarness, generateComparison } from '../harness/harness-config.js';
/** Standalone authoring has no measurement DB or native-product dependency. */
export function harnessConfigMain(argv: string[]): number {
  const program = new Command().name('hm-harness-config');
  program.exitOverride().configureOutput({ writeErr: () => undefined });
  for (const command of ['register', 'compare'])
    program
      .command(command)
      .requiredOption('--root <directory>')
      .requiredOption('--input <file>')
      .action((options: { root: string; input: string }) => {
        const inputPath = resolve(options.input);
        const input = readStrictJson(readRepositoryFile(dirname(inputPath), basename(inputPath)));
        const result = command === 'register' ? registerHarness(options.root, input) : generateComparison(options.root, input);
        process.stdout.write(JSON.stringify(result) + '\n');
      });
  try {
    program.parse(argv, { from: 'user' });
    return 0;
  } catch (error) {
    const code =
      error instanceof Error && /^(?:invalid_shared_config|shared_[a-z_]+|harness_version_conflict)$/.test(error.message)
        ? error.message
        : 'invalid_shared_config';
    process.stderr.write(code + '\n');
    return 1;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = harnessConfigMain(process.argv.slice(2));
