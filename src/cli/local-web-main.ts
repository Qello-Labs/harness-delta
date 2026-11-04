#!/usr/bin/env node
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSharedStartup } from '../web/local-web-shared.js';
import { Command } from 'commander';
import { Store } from '../store.js';
import { createLocalWebDomain, readLocalWebManifest, readLocalWebSetupDocument } from '../local-web-domain.js';
import { createLocalWebServer, localWebError } from '../local-web-server.js';
import { implementationPath } from '../package-paths.js';

interface WebCommandOptions {
  port: string;
  metadata?: string;
  setup?: string;
  setupBindingRevision?: string;
  pilotTask?: string;
  pilotObserve?: boolean;
  pilotUntilStop?: boolean;
}
export async function startLocalWeb(store: Store, options: WebCommandOptions) {
  if ((options.pilotObserve || options.pilotUntilStop) && !options.pilotTask) throw new Error('binding_pilot_scope_invalid');
  const port = Number(options.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || store.filename === ':memory:') throw new Error('invalid_ui_request');
  const metadataFile = resolve(options.metadata ?? store.filename + '.ui.sqlite');
  if (metadataFile === resolve(store.filename)) throw new Error('invalid_ui_request');
  mkdirSync(dirname(metadataFile), { recursive: true, mode: 0o700 });
  if (!existsSync(metadataFile)) writeFileSync(metadataFile, '', { flag: 'wx', mode: 0o600 });
  chmodSync(metadataFile, 0o600);
  const selected = options.setup ? resolve(options.setup) : null;
  const kind = selected ? (readLocalWebSetupDocument(selected) as { kind?: unknown }).kind : null;
  if (options.setupBindingRevision && kind !== 'harness-delta.comparison') throw new Error('invalid_ui_setup');
  const profiles = selected
    ? kind === 'harness-delta.comparison'
      ? loadSharedStartup(store, selected, options.setupBindingRevision)
      : readLocalWebManifest(selected).profiles
    : [];
  const domain = createLocalWebDomain({
    store,
    metadataFile,
    profiles,
    ...(options.pilotTask
      ? { nativePilot: { taskId: options.pilotTask, observe: options.pilotObserve === true, untilExplicitStop: options.pilotUntilStop === true } }
      : {})
  });
  const origin = `http://127.0.0.1:${port}`;
  const app = createLocalWebServer({ origin, domain, metadataFile, uiRoot: implementationPath('local-ui') });
  try {
    await app.listen({ host: '127.0.0.1', port });
  } catch (error) {
    await app.close();
    throw error;
  }
  return { app, origin };
}
async function serve(store: Store, options: WebCommandOptions, print: (value: unknown) => void) {
  const { app, origin } = await startLocalWeb(store, options);
  print({ local_ui: origin, access: 'loopback_only', native_launch: false });
  await new Promise<void>((done, reject) => {
    const stop = () => {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
      void app.close().then(done, reject);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}
/** Integration adds only this import/registration to the existing hm CLI. */
export function registerLocalWebCommand(program: Command, store: () => Store, print: (value: unknown) => void): void {
  program
    .command('ui')
    .description('Open the local browser workflow; no native agent launcher')
    .option('--port <number>', '127.0.0.1 listen port', '4318')
    .option('--metadata <file>', 'private UI metadata database (separate from measurement data)')
    .option('--setup <file>', 'reviewed local manifest or portable comparison file')
    .option('--setup-binding-revision <id>', 'explicit private shared setup revision when ambiguous')
    .option('--pilot-task <id>', 'prepare UI for one unverified native Codex or Claude pilot; no source reads')
    .option('--pilot-until-stop', 'collect until explicit pause, completion or revocation; comparison deadline is retained')
    .option('--pilot-observe', 'authorize the exact pilot task receipt sources after installation/source scope review')
    .action(async (options: WebCommandOptions) => {
      await serve(store(), options, print);
    });
}
export async function localWebMain(argv: string[]): Promise<number> {
  const program = new Command()
    .name('hm-ui')
    .requiredOption('--db <file>', 'measurement Store')
    .option('--port <number>', '127.0.0.1 listen port', '4318')
    .option('--metadata <file>')
    .option('--setup <file>')
    .option('--setup-binding-revision <id>')
    .option('--pilot-task <id>')
    .option('--pilot-observe')
    .option('--pilot-until-stop');
  program.exitOverride().configureOutput({ writeErr: () => undefined });
  let store: Store | undefined;
  try {
    program.parse(argv, { from: 'user' });
    const options = program.opts<WebCommandOptions & { db: string }>();
    store = new Store(options.db);
    await serve(store, options, value => {
      process.stdout.write(JSON.stringify(value) + '\n');
    });
    return 0;
  } catch (error) {
    process.stderr.write(localWebError(error) + '\n');
    return 1;
  } finally {
    store?.close();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void localWebMain(process.argv.slice(2)).then(code => {
    process.exitCode = code;
  });
}
