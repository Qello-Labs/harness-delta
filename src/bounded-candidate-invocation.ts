import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { IdSchema, ModelSchema } from './contracts.js';
import { CodexFailureClassifier, type CodexFailureSummary } from './qualification/codex-failure-diagnostics.js';

export const MAX_CANDIDATE_DURATION_MS = 180_000;
export interface CandidateInvocationExpectation {
  rootSessionId: string;
  childModel: string;
  childEffort: string;
}
export interface CandidateChildReservation {
  callerSessionId: string;
  parentSessionId: string;
  depth: number;
  model: string;
  effort: string;
}
export interface CandidateInvocationResult {
  status: 'completed' | 'failed' | 'timed_out' | 'launch_failed' | 'stopped';
  exitCode: number | null;
  failureDiagnostics?: CodexFailureSummary;
}
/** Offline preparation only; deliberately absent from the CLI/index. Reservation
 * files belong in a caller-created temporary invocation directory and are never
 * reset or retried. Reservations describe intended topology. Native hook errors
 * may fail open; the qualification observer stops only after detection. A
 * process-group cutoff cannot bound API requests/tokens.
 */
export class BoundedCandidateInvocation {
  private readonly expected: CandidateInvocationExpectation;
  constructor(
    private readonly directory: string,
    expected: CandidateInvocationExpectation
  ) {
    if (
      !isAbsolute(directory) ||
      !IdSchema.safeParse(expected.rootSessionId).success ||
      !ModelSchema.safeParse(expected.childModel).success ||
      !IdSchema.safeParse(expected.childEffort).success
    )
      throw new Error('candidate_invalid_invocation');
    this.expected = { ...expected };
  }
  reserveDirectChild(request: CandidateChildReservation): void {
    if (
      request.callerSessionId !== this.expected.rootSessionId ||
      request.parentSessionId !== this.expected.rootSessionId ||
      request.depth !== 1 ||
      request.model !== this.expected.childModel ||
      request.effort !== this.expected.childEffort
    )
      throw new Error('candidate_child_scope_mismatch');
    this.claim('child', 'candidate_child_already_reserved');
  }
  private claim(kind: 'root' | 'child', duplicateCode: string): void {
    let failure: string;
    try {
      closeSync(openSync(join(this.directory, `${kind}.reserved`), 'wx', 0o600));
      return;
    } catch (error) {
      failure = error instanceof Error && 'code' in error && error.code === 'EEXIST' ? duplicateCode : 'candidate_reservation_failed';
    }
    throw new Error(failure);
  }
  async run(
    command: string,
    args: readonly string[],
    durationMs = MAX_CANDIDATE_DURATION_MS,
    options: { cwd?: string; signal?: AbortSignal; env?: NodeJS.ProcessEnv; codexFailureDiagnostics?: boolean } = {}
  ): Promise<CandidateInvocationResult> {
    if (
      process.platform === 'win32' ||
      !isAbsolute(command) ||
      command.includes('\0') ||
      args.some(arg => arg.includes('\0')) ||
      !Number.isSafeInteger(durationMs) ||
      durationMs <= 0 ||
      durationMs > MAX_CANDIDATE_DURATION_MS
    )
      throw new Error('candidate_invalid_invocation');
    this.claim('root', 'candidate_root_already_started');
    if (options.signal?.aborted) return { status: 'stopped', exitCode: null };
    return new Promise(resolve => {
      // Native model invocations are not made by this module or its tests. A
      // future authorized caller must pin a qualified executable, not PATH.
      const classifier = options.codexFailureDiagnostics ? new CodexFailureClassifier() : null;
      const child = spawn(command, [...args], {
        detached: true,
        stdio: classifier ? ['ignore', 'ignore', 'pipe'] : 'ignore',
        shell: false,
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.env === undefined ? {} : { env: options.env })
      });
      // Drain stderr in bounded transient chunks; never await inherited pipe EOF.
      child.stderr?.on('data', (chunk: Buffer) => {
        classifier?.push(chunk);
      });
      child.stderr?.on('error', () => {
        /* No raw stream error escapes. */
      });
      let finishing = false;
      const signalGroup = (signal: NodeJS.Signals) => {
        if (child.pid === undefined) return;
        try {
          process.kill(-child.pid, signal);
        } catch {
          /* Group already gone. */
        }
      };
      const finish = (status: CandidateInvocationResult['status'], exitCode: number | null) => {
        if (finishing) return;
        finishing = true;
        clearTimeout(deadline);
        options.signal?.removeEventListener('abort', abort);
        signalGroup('SIGTERM');
        // Always retain forced group teardown after root exits: descendants may
        // still run with ignored stdio and may ignore SIGTERM. No pipe wait.
        setTimeout(() => {
          signalGroup('SIGKILL');
          child.stderr?.destroy();
          resolve({ status, exitCode, ...(classifier ? { failureDiagnostics: classifier.finish() } : {}) });
        }, 50);
      };
      const abort = () => {
        signalGroup('SIGKILL');
        finish('stopped', null);
      };
      const deadline = setTimeout(() => {
        signalGroup('SIGKILL');
        finish('timed_out', null);
      }, durationMs);
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
      child.once('error', () => finish('launch_failed', null));
      child.once('exit', code => finish(code === 0 ? 'completed' : 'failed', code));
    });
  }
}
