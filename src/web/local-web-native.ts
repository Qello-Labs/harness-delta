import { execFile, execFileSync } from 'node:child_process';
import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { LocalWebManifestSchema } from './local-web-profile.js';
const runFile = promisify(execFile);
/** Constant AppleScript only; no browser-provided command or script is executed. */
export async function nativeLocalPicker(kind: 'project' | 'session' | 'setup'): Promise<string | null> {
  if (process.platform !== 'darwin') throw new Error('picker_unavailable');
  const script =
    kind === 'project'
      ? 'POSIX path of (choose folder with prompt "Choose the measurement project")'
      : kind === 'session'
        ? 'POSIX path of (choose file with prompt "Choose the exact new Codex session JSONL")'
        : 'POSIX path of (choose file with prompt "Choose an existing reviewed Harness Delta UI setup")';
  try {
    const result = await runFile('/usr/bin/osascript', ['-e', script], { timeout: 120000, maxBuffer: 8192 });
    return result.stdout.trim() || null;
  } catch (error) {
    if (error instanceof Error && 'stderr' in error && String(error.stderr).includes('(-128)')) return null;
    throw new Error('picker_unavailable', { cause: error });
  }
}

export function readLocalWebSetupDocument(path: string): unknown {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 1048576) throw new Error('invalid_ui_setup');
    return JSON.parse(readFileSync(fd, 'utf8')) as unknown;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function readLocalWebManifest(path: string) {
  return LocalWebManifestSchema.parse(readLocalWebSetupDocument(path));
}

/** Reads the current commit; it never creates a commit or changes the checkout. */
export function projectBaseline(directory: string): string {
  try {
    const value = execFileSync('git', ['-C', directory, 'rev-parse', '--verify', 'HEAD'], {
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 4096,
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) throw new Error();
    return value;
  } catch {
    throw new Error('git_baseline_unavailable');
  }
}
