import { readFileSync } from 'node:fs';
import type { Command } from 'commander';
import { launchInstrumentedCodex } from './instrumented-codex-launcher.js';
import type { Store } from './store.js';
import { qualifyInstrumentedCodexBuild } from './instrumented-codex-qualification.js';
import { z } from 'zod';

export function registerInstrumentedCodexCommands(
  program: Command, store: () => Store, print: (value: unknown) => void,
) {
  const commands = program.command('instrumented-codex')
    .description('Separate qualified metadata source; fresh tasks or bounded work windows');
  commands.command('qualify').description('Own the exact offline native build and localhost-only conformance')
    .requiredOption('--locations <file>', 'local checkout, Rust toolchain, Cargo cache and build-directory JSON')
    .action(async (options: { locations: string }) => {
      const locations = z.strictObject({
        checkout_path: z.string().min(1), toolchain_path: z.string().min(1),
        cargo_home_path: z.string().min(1), build_root_path: z.string().min(1),
      }).parse(JSON.parse(readFileSync(options.locations, 'utf8')) as unknown);
      const controller = new AbortController();
      const stop = () => { controller.abort(); };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      try {
        const result = await qualifyInstrumentedCodexBuild(store(), {
          checkoutPath: locations.checkout_path, toolchainPath: locations.toolchain_path,
          cargoHomePath: locations.cargo_home_path, buildRootPath: locations.build_root_path,
        }, controller.signal);
        print({
          schema_version: 1, kind: 'instrumented_codex_build_qualification',
          build_identity_id: result.identity.id, binary_path: result.binaryPath,
          qualification_hash: result.identity.qualification_hash,
          profile: result.identity.profile, conformance: result.conformance,
        });
      } finally {
        process.removeListener('SIGINT', stop);
        process.removeListener('SIGTERM', stop);
      }
    });
  commands.command('launch').description('Own a fresh Codex root with fixed gpt-6.1-sol/high and fd3 accounting')
    .requiredOption('--execution <file>', 'metadata JSON: run/project/task/generation, build identity, binary, price table and runtime budgets')
    .option('--prompt <text>', 'transient native input; omitted means inherited stdin')
    .action(async (options: { execution: string; prompt?: string }) => {
      const input: unknown = JSON.parse(readFileSync(options.execution, 'utf8'));
      const controller = new AbortController();
      const stop = () => { controller.abort(); };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      try {
        const result = await launchInstrumentedCodex(store(), input, {
          signal: controller.signal, ...(options.prompt === undefined ? {} : { prompt: options.prompt }),
        });
        print(result);
        if (result.state === 'failed') throw new Error('instrumented_launch_failed');
      } finally {
        process.removeListener('SIGINT', stop);
        process.removeListener('SIGTERM', stop);
      }
    });
}
