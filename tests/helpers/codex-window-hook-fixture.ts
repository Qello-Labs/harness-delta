import { spawn } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';

export const CodexWindowHookEffectsSchema = z.object({
  nativeCalls: z.number().int().nonnegative(),
  processCalls: z.number().int().nonnegative(),
  operations: z.array(z.string()).max(128)
});
export type CodexWindowHookEffects = z.infer<typeof CodexWindowHookEffectsSchema>;
export const codexWindowControl = (projectRoot: string) => ({
  schemaVersion: 1,
  projectRoot,
  product: 'codex',
  policyId: 'codex-binding-root-window-v1',
  policyRevision: 'codex-ordinary-root-window-v1',
  evidenceMode: 'source_only',
  state: 'active'
});

export async function runCodexWindowHook(options: {
  readonly receiptDirectory: string;
  readonly projectRoot: string;
  readonly input?: unknown;
  readonly stdin?: string;
  readonly nativePrefixes?: readonly string[];
  readonly nativeAliases?: readonly { readonly path: string; readonly target: string }[];
  readonly nativeEntryNames?: readonly string[];
  readonly scriptPath?: string;
  readonly args?: readonly string[];
}) {
  const child = spawn(
    process.execPath,
    [
      resolve('tests/helpers/codex-window-hook-tripwire.mjs'),
      ...(options.args ?? ['--receipt-directory', options.receiptDirectory, '--project-root', options.projectRoot])
    ],
    {
      env: {
        ...process.env,
        CODEX_WINDOW_SCRIPT: options.scriptPath ?? resolve('scripts/session-binding-codex-window-hook.mjs'),
        CODEX_WINDOW_NATIVE_PREFIXES: JSON.stringify(options.nativePrefixes ?? []),
        CODEX_WINDOW_NATIVE_ALIASES: JSON.stringify(options.nativeAliases ?? []),
        CODEX_WINDOW_NATIVE_ENTRY_NAMES: JSON.stringify(options.nativeEntryNames ?? [])
      },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc']
    }
  );
  const { stdin, stdout: output, stderr: errors } = child;
  if (stdin === null || output === null || errors === null) {
    child.kill('SIGKILL');
    throw new Error('codex_window_hook_missing_pipes');
  }
  let stdout = '';
  let stderr = '';
  let effects: CodexWindowHookEffects | undefined;
  let ready = false;
  const code = await new Promise<number | null>((resolveCode, reject) => {
    const deadline = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('codex_window_hook_completion_deadline'));
    }, 10000);
    child.once('error', error => {
      clearTimeout(deadline);
      reject(error);
    });
    output.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    errors.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    stdin.on('error', error => {
      if (!('code' in error) || error.code !== 'EPIPE') reject(error);
    });
    child.on('message', (message: unknown) => {
      const parsed = z.object({ kind: z.literal('ready') }).safeParse(message);
      if (parsed.success) {
        ready = true;
        stdin.end(options.stdin ?? JSON.stringify(options.input));
        return;
      }
      const ledger = z
        .object({
          kind: z.literal('effects'),
          effects: CodexWindowHookEffectsSchema
        })
        .safeParse(message);
      if (ledger.success) effects = ledger.data.effects;
    });
    child.once('close', exitCode => {
      clearTimeout(deadline);
      resolveCode(exitCode);
    });
  });
  if (!ready || effects === undefined) {
    throw new Error('codex_window_hook_missing_ready_or_effects');
  }
  const receiptDirectory = resolve(options.receiptDirectory);
  const receipts = readdirSync(receiptDirectory)
    .filter(name => /^[0-9a-f-]{36}\.json$/.test(name))
    .filter(name => lstatSync(join(receiptDirectory, name)).isFile())
    .map(name => JSON.parse(readFileSync(join(receiptDirectory, name), 'utf8')) as unknown);
  return { code, stdout, stderr, effects, receipts };
}
