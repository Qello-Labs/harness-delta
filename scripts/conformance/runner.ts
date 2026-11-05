import { lookupCandidate } from './candidate.js';
import { evidenceIdentity } from './evidence.js';
import { lookupFileProfile } from '../../src/adapter-profiles.js';
import { toolVersionRecipe } from '../../src/core/tool-version-profiles.js';
import { spawn } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { runLive, type LiveDeps, type ProcessResult } from './live.js';

const stdoutLimit = 8 * 1024 * 1024;
const confirmationLimitMs = 300_000;
const strippedEnvironment = /^(CLAUDE|OTEL_|CODEX_|BETA_TRACING|ENABLE_)/;

export interface RunnerEnvironment {
  readonly interactive: boolean;
  /** CODEX_HOME would be stripped from the product environment, so the run would read another home. */
  readonly codexHomeSet: boolean;
  readonly cwd: string;
  createDeps(): LiveDeps;
  write(text: string): void;
}

function spawnCodex(args: readonly string[], options: { cwd: string; timeoutMs: number }): Promise<ProcessResult> {
  return new Promise(resolve => {
    const startedAt = Date.now();
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !strippedEnvironment.test(key)));
    const child = spawn('codex', [...args], { cwd: options.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let size = 0;
    let timedOut = false;
    child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size <= stdoutLimit) chunks.push(chunk); });
    child.stderr.resume();
    let settled = false;
    const interrupt = setTimeout(() => { timedOut = true; child.kill('SIGINT'); }, options.timeoutMs);
    const terminate = setTimeout(() => child.kill('SIGTERM'), options.timeoutMs + 10_000);
    const kill = setTimeout(() => { child.kill('SIGKILL'); finish(null, false); }, options.timeoutMs + 20_000);
    const finish = (code: number | null, spawnError: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(interrupt);
      clearTimeout(terminate);
      clearTimeout(kill);
      resolve({ code, timedOut, spawnError, stdout: size <= stdoutLimit ? Buffer.concat(chunks).toString('utf8') : '', startedAt, exitedAt: Date.now() });
    };
    child.on('error', () => finish(null, true));
    child.on('close', code => finish(code, false));
  });
}

function readTerminalLine(): Promise<string | null> {
  return new Promise(resolve => {
    const reader = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let answered = false;
    const answer = (line: string | null) => {
      if (answered) return;
      answered = true;
      clearTimeout(timer);
      reader.close();
      resolve(line);
    };
    const timer = setTimeout(() => answer(null), confirmationLimitMs);
    reader.once('line', line => answer(line));
    reader.once('SIGINT', () => answer(null));
    reader.once('close', () => answer(null));
  });
}

function stamp(path: string): string {
  return existsSync(path) ? `${statSync(path).size}:${statSync(path).mtimeMs}` : 'absent';
}

function codexConfigMetadata(): string {
  const home = join(homedir(), '.codex');
  const current = join(home, 'packages/standalone/current');
  return JSON.stringify({
    config: stamp(join(home, 'config.toml')),
    hooks: stamp(join(home, 'hooks.json')),
    release: existsSync(current) ? realpathSync(current) : 'absent',
  });
}

export function realEnvironment(): RunnerEnvironment {
  const cwd = process.cwd();
  return {
    interactive: process.stdin.isTTY && process.stdout.isTTY,
    codexHomeSet: process.env.CODEX_HOME !== undefined,
    cwd,
    write: text => { process.stdout.write(text); },
    createDeps: () => ({
      spawnProduct: spawnCodex,
      readConfirmationLine: readTerminalLine,
      print: text => { process.stdout.write(`${text}\nType confirm to run, anything else to abort: `); },
      now: Date.now,
      sessionsRoot: join(homedir(), '.codex/sessions'),
      nodePath: process.execPath,
      recorderPath: join(cwd, 'scripts/conformance/session-start-recorder.mjs'),
      runRoot: realpathSync(tmpdir()),
      configMetadata: codexConfigMetadata,
      productLabel: 'codex on PATH',
    }),
  };
}

/** Resolves symlinks in the longest existing prefix so a linked directory cannot leave `.harness-delta/`. */
function realExisting(path: string): string {
  let prefix = path;
  const rest: string[] = [];
  while (!existsSync(prefix)) {
    const parent = dirname(prefix);
    if (parent === prefix) return path;
    rest.unshift(basename(prefix));
    prefix = parent;
  }
  return join(realpathSync(prefix), ...rest);
}

/**
 * Manual entry point: `node <compiled>/scripts/conformance/runner.js --out <absolute dir>`
 * from the repository root in an interactive terminal. No other options exist, including
 * any option that skips confirmation. Prints only the plan, the stop reason and the report location.
 */
export async function main(argv: readonly string[], environment: RunnerEnvironment): Promise<number> {
  const requested = argv.length === 4 && argv[0] === '--candidate' ? argv[1] : toolVersionRecipe('codex-file-conformance-01580').version;
  const candidate = lookupCandidate(requested ?? '');
  if (!candidate || lookupFileProfile('codex', candidate.previousVersion) === 'unsupported') {
    environment.write('unknown_candidate_or_previous_profile\n'); return 2;
  }
  if (argv[0] === '--candidate') argv = argv.slice(2);
  if (argv.length !== 2 || argv[0] !== '--out' || argv[1] === undefined || !isAbsolute(argv[1])) {
    environment.write('usage: runner [--candidate <exact version>] --out <absolute directory>\n');
    return 2;
  }
  const localRecords = realExisting(resolve(environment.cwd, '.harness-delta'));
  const out = realExisting(resolve(argv[1]));
  const inside = relative(localRecords, out);
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside) || inside.split(sep).includes('..')) {
    environment.write('out_must_be_under_harness_delta\n');
    return 2;
  }
  if (!environment.interactive) {
    environment.write('interactive_terminal_required\n');
    return 2;
  }
  if (environment.codexHomeSet) {
    environment.write('codex_home_unsupported\n');
    return 2;
  }
  if (!existsSync(join(environment.cwd, 'scripts/conformance/session-start-recorder.mjs'))) {
    environment.write('run_from_repository_root\n');
    return 2;
  }
  const report = await runLive(environment.createDeps(), out, candidate, evidenceIdentity(environment.cwd, candidate));
  environment.write(`stop: ${report.stop ?? 'none'}\n`);
  if (report.confirmed) environment.write(`report: ${join(out, 'conformance-live-report.json')}\n`);
  return report.stop === null ? 0 : 1;
}

const invoked = process.argv[1];
if (invoked !== undefined && import.meta.url === pathToFileURL(invoked).href) {
  main(process.argv.slice(2), realEnvironment()).then(
    code => { process.exitCode = code; },
    () => { process.stdout.write('stop: internal_error\n'); process.exitCode = 1; },
  );
}
