import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
export type ApplicationProduct = 'codex' | 'claude_code';
export interface ApplicationLaunchContext {
  workspace: string;
  product: ApplicationProduct;
  prompt: string;
}
export interface LaunchEnvironment {
  platform?: string;
  executable?: string;
  directory?: string;
  open?: (path: string) => Promise<void>;
}
const runFile = promisify(execFile);
const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
function executableFor(product: ApplicationProduct): string | null {
  const name = product === 'codex' ? 'codex' : 'claude';
  for (const folder of (process.env.PATH ?? '').split(':')) {
    if (!folder) continue;
    const path = join(folder, name);
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      /* Try the next PATH entry. */
    }
  }
  return null;
}
/** CLI grammar verified with local --help; Terminal opening is separately unverified. */
export function getApplicationLaunchCapability(product: ApplicationProduct, environment: LaunchEnvironment = {}) {
  const executable = environment.executable ?? executableFor(product);
  const available =
    (environment.platform ?? process.platform) === 'darwin' &&
    !!executable &&
    (environment.open !== undefined || existsSync('/System/Applications/Utilities/Terminal.app'));
  return {
    id: product,
    product,
    available,
    reason: available ? null : 'application_launch_unavailable',
    mechanism: 'macos_terminal_cli',
    nativeAcceptance: 'unverified' as const
  };
}
export function buildApplicationLaunch(context: ApplicationLaunchContext, executable: string) {
  if ([context.workspace, context.prompt, executable].some(value => value.includes('\0') || !value)) throw new Error('application_launch_invalid');
  // The shell receives only individually POSIX-quoted literals. No permissions,
  // model, auth, trust, resume, or background execution overrides are supplied.
  return {
    cwd: context.workspace,
    executable,
    args: [context.prompt],
    script: `#!/bin/sh\ncd ${quote(context.workspace)} || exit 1\nexec ${quote(executable)} ${quote(context.prompt)}\n`
  };
}
const requests = new Map<string, Promise<{ state: 'open_requested' | 'open_failed'; nativeAcceptance: 'unverified' }>>();
/** One OS opening request. Never retain the native PID or control its execution. */
export function openApplicationSession(
  context: ApplicationLaunchContext & { attemptId: string },
  environment: LaunchEnvironment = {}
): Promise<{ state: 'open_requested' | 'open_failed'; nativeAcceptance: 'unverified' }> {
  const previous = requests.get(context.attemptId);
  if (previous) return previous;
  if (!getApplicationLaunchCapability(context.product, environment).available) return Promise.reject(new Error('application_launch_unavailable'));
  const opening = (async () => {
    try {
      const executable = environment.executable ?? executableFor(context.product);
      if (!executable) throw new Error('application_launch_unavailable');
      const directory = mkdtempSync(join(environment.directory ?? tmpdir(), 'hm-native-'));
      const path = join(directory, 'apply.command');
      writeFileSync(path, buildApplicationLaunch(context, executable).script, { flag: 'wx', mode: 0o700 });
      await (
        environment.open ??
        (async (file: string) => {
          await runFile('/usr/bin/open', ['-a', 'Terminal', file], { timeout: 5000, maxBuffer: 8192 });
        })
      )(path);
      return { state: 'open_requested' as const, nativeAcceptance: 'unverified' as const };
    } catch {
      return { state: 'open_failed' as const, nativeAcceptance: 'unverified' as const };
    }
  })();
  requests.set(context.attemptId, opening);
  return opening;
}
