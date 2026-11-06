import type { EvidenceIdentity } from './admission.js';
import { toolVersionRecipe } from '../../src/core/tool-version-profiles.js';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { codex01580Candidate, compareCandidate, type ConformanceCandidate } from './candidate.js';
import type { CounterVector } from './checks.js';
import { confirmationPlan, readConfirmation, renderConfirmation, type ConfirmationPlan } from './confirm.js';
import { reduceExecStream, type ExecStreamSummary } from './exec-stream.js';
import { matchExactSessionFilename } from './filename.js';
import { hookTrustArguments, rejectBypass, sessionStartTrustedHash } from './hook.js';
import { startHookListener, type HookListener, type HookMessage, type HookSource } from './hook-listener.js';
import { createInvestigation, runInvestigation } from './investigate.js';
import { parseCandidate, type CandidateInspection } from './parse-candidate.js';
import { writeRestrictedJson, type ConformanceReport } from './report.js';

export const livePrompts = {
  initial: 'Reply with exactly one word: ready',
  resume: 'Reply with exactly one word: again',
} as const;
const expectedVersion = toolVersionRecipe('codex-file-conformance-01580').version;
const runLimitMs = 180_000;
const versionLimitMs = 30_000;
const hookGraceMs = 1_000;
const safeRunPath = /^\/[A-Za-z0-9._+/-]+$/;

export interface ProcessResult {
  readonly code: number | null;
  readonly timedOut: boolean;
  readonly spawnError: boolean;
  /** Held in memory only; never written or printed. */
  readonly stdout: string;
  readonly startedAt: number;
  readonly exitedAt: number;
}

export interface LiveDeps {
  spawnProduct(args: readonly string[], options: { cwd: string; timeoutMs: number }): Promise<ProcessResult>;
  readConfirmationLine(): Promise<string | null>;
  print(text: string): void;
  now(): number;
  /** Product-defined session directory; only names in the current/previous local day are listed. */
  readonly sessionsRoot: string;
  /** Absolute interpreter path written into the per-run hook wrapper. */
  readonly nodePath: string;
  /** Absolute path of `session-start-recorder.mjs` in the repository checkout. */
  readonly recorderPath: string;
  /** Parent of the private run directory; must be short enough for a Unix socket path. */
  readonly runRoot: string;
  /** Opaque metadata of product configuration (sizes, mtimes, counts), never contents. */
  configMetadata(): string;
  readonly productLabel: string;
}

export type StopReason =
  | 'not_confirmed' | 'unsafe_run_path' | 'version_mismatch' | 'spawn_error' | 'timeout' | 'nonzero_exit'
  | 'no_thread_id' | 'thread_changed' | 'rollout_not_unique' | 'rollout_changed' | 'hook_conflict'
  | 'parse_error' | 'version_changed' | 'config_changed' | 'internal_error';

export interface HookObservation {
  readonly received: number;
  readonly rejected: number;
  readonly source: HookSource | null;
  readonly eventName: 'SessionStart' | 'other' | null;
  readonly sessionMatchesThread: boolean | null;
  readonly transcriptMatchesRollout: boolean | null;
  readonly cwdMatches: boolean | null;
  readonly transcriptExistedAtReceipt: boolean | null;
  readonly receivedBeforeExit: boolean | null;
  readonly keyNames: readonly string[];
  readonly unknownKeyCount: number;
}

export interface StageReport {
  readonly stage: 'initial' | 'resume';
  readonly exit: 'ok' | 'nonzero' | 'timeout' | 'spawn_error';
  readonly exec: ExecStreamSummary;
  readonly rolloutMatch: 'none' | 'match' | 'ambiguous' | 'not_checked';
  readonly sameRolloutAsInitial: boolean | null;
  readonly hook: HookObservation;
  readonly parseError: string | null;
  readonly conformance: ConformanceReport | null;
}

export interface LiveReport extends Partial<EvidenceIdentity> {
  readonly version: string;
  readonly scenario: 'exec_initial_resume';
  readonly confirmed: boolean;
  readonly productVersionBefore: 'match' | 'mismatch' | 'not_run';
  readonly productVersionAfter: 'match' | 'mismatch' | 'not_run';
  readonly configMetadataUnchanged: boolean | null;
  readonly stop: StopReason | null;
  readonly stages: readonly StageReport[];
}

export function execArguments(stage: 'initial' | 'resume', hookArgs: readonly string[], threadId?: string): readonly string[] {
  const common = ['exec', '--json', '--skip-git-repo-check'];
  const args = stage === 'initial'
    ? [...common, '--sandbox', 'read-only', '-c', 'model_reasoning_effort="low"', ...hookArgs, livePrompts.initial]
    : [...common, '-c', 'sandbox_mode="read-only"', '-c', 'model_reasoning_effort="low"', ...hookArgs,
      'resume', threadId ?? '', livePrompts.resume];
  rejectBypass(args);
  return args;
}

export function livePlanLines(productLabel: string, version = expectedVersion): readonly string[] {
  return [
    `product: ${productLabel}; expected version ${version}; version probe before and after`,
    'working directory: new empty private directory under the system temporary directory, outside Git',
    'run 1: exec --json --skip-git-repo-check --sandbox read-only -c model_reasoning_effort="low" <hook overrides> <prompt 1>',
    'run 2: exec --json --skip-git-repo-check -c sandbox_mode="read-only" -c model_reasoning_effort="low" <hook overrides> resume <run 1 thread id> <prompt 2>',
    `synthetic prompt 1: ${livePrompts.initial}`,
    `synthetic prompt 2: ${livePrompts.resume}`,
    'model: product default from existing configuration (not overridden); reasoning effort low',
    'hook overrides: -c hooks.SessionStart (conformance recorder) and -c hooks.state trusted_hash for that hook only; no trust bypass',
    'requests: one generation per run is requested; warmup or other internal requests may add more and are not bounded',
    `limits: no retries; ${runLimitMs / 1000} s per run; stop on any mismatch, prompt, conflict or error`,
    'source selection: exact thread id from the exec stream; file names only in the previous, current and next day directories',
    'hook: a missing hook is recorded, not a stop (user configuration such as features.hooks can disable it); a conflicting hook stops',
    'environment: CLAUDE*, OTEL_*, CODEX_* (including CODEX_HOME), BETA_TRACING* and ENABLE_* are removed; ~/.codex is used',
    'exec usage is the thread cumulative total; Codex reports zeros when it observed no usage, so an exec mismatch can mean either',
    'product-created files: one rollout file with prompts, replies and instructions is left in place; product logs may change',
    'report stores: implementation/policy identity, version flags, event/record counts, catalog paths, allowlisted mode/hook enums and check outcomes; no token/content/identity values',
  ];
}

/** Previous, current and next day in local time and UTC, so either directory clock is covered. */
function dayDirectories(root: string, now: number): string[] {
  const days = [-1, 0, 1].flatMap(offset => {
    const date = new Date(now + offset * 86_400_000);
    return [
      [date.getFullYear(), date.getMonth() + 1, date.getDate()],
      [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()],
    ].map(([year, month, day]) => join(root, String(year), String(month).padStart(2, '0'), String(day).padStart(2, '0')));
  });
  return [...new Set(days)];
}

function locateRollout(root: string, threadId: string, now: number): { match: 'none' | 'match' | 'ambiguous'; path: string | null } {
  const found: string[] = [];
  for (const directory of dayDirectories(root, now)) {
    if (!existsSync(directory)) continue;
    const names = readdirSync(directory);
    const result = matchExactSessionFilename(names, threadId, 'codex');
    if (result === 'ambiguous') return { match: 'ambiguous', path: null };
    if (result === 'match') found.push(...names.filter(name => name.endsWith(`-${threadId}.jsonl`) && name.startsWith('rollout-')).map(name => join(directory, name)));
  }
  if (found.length === 0) return { match: 'none', path: null };
  if (found.length > 1) return { match: 'ambiguous', path: null };
  return { match: 'match', path: found[0] ?? null };
}

const samePath = (left: string | null, right: string | null): boolean | null => {
  if (left === null || right === null) return null;
  try { return realpathSync(left) === realpathSync(right); } catch { return false; }
};

function observeHook(messages: readonly HookMessage[], rejected: number, context: {
  threadId: string | null; rolloutPath: string | null; cwd: string; exitedAt: number;
}): HookObservation {
  const [first] = messages;
  if (messages.length !== 1 || first === undefined) {
    return {
      received: messages.length, rejected, source: null, eventName: null, sessionMatchesThread: null,
      transcriptMatchesRollout: null, cwdMatches: null, transcriptExistedAtReceipt: null,
      receivedBeforeExit: null, keyNames: [], unknownKeyCount: 0,
    };
  }
  return {
    received: 1, rejected, source: first.source, eventName: first.eventName,
    sessionMatchesThread: context.threadId === null ? null : first.sessionId === context.threadId,
    transcriptMatchesRollout: samePath(first.transcriptPath, context.rolloutPath),
    cwdMatches: samePath(first.cwd, context.cwd),
    transcriptExistedAtReceipt: first.transcriptExistedAtReceipt,
    receivedBeforeExit: first.receivedAt <= context.exitedAt,
    keyNames: first.keyNames, unknownKeyCount: first.unknownKeyCount,
  };
}

function parseErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return ['unsupported', 'scope_mismatch', 'invalid_json', 'record_conflict'].includes(message) ? message : 'other';
}

/** Any rejected delivery, several messages, or a received message that does not fully match stops the stage. */
const hookConflict = (hook: HookObservation, expected: HookSource): boolean =>
  hook.rejected > 0 || hook.received > 1 || (hook.received === 1 && (
    hook.sessionMatchesThread !== true || hook.transcriptMatchesRollout !== true || hook.cwdMatches !== true ||
    hook.source !== expected || hook.eventName !== 'SessionStart'));

interface StageOutcome { report: StageReport; stop: StopReason | null; threadId: string | null; rolloutPath: string | null; total: CounterVector | null }

async function runStage(input: {
  candidate: ConformanceCandidate;
  stage: 'initial' | 'resume'; deps: LiveDeps; hooks: HookListener; hookArgs: readonly string[]; cwd: string;
  plan: ConfirmationPlan; threadId: string | null; initialRollout: string | null; priorTotal: CounterVector | null; priorCheckpointCount: number;
}): Promise<StageOutcome> {
  const { deps, hooks, stage } = input;
  const rejectedBefore = hooks.rejected();
  const result = await deps.spawnProduct(execArguments(stage, input.hookArgs, input.threadId ?? undefined), { cwd: input.cwd, timeoutMs: runLimitMs });
  await new Promise(resolve => setTimeout(resolve, hookGraceMs));
  const reduced = reduceExecStream(result.stdout);
  const exit = result.spawnError ? 'spawn_error' : result.timedOut ? 'timeout' : result.code === 0 ? 'ok' : 'nonzero';
  const messages = hooks.drain();
  const rejected = hooks.rejected() - rejectedBefore;
  const base = { stage, exit, exec: reduced.summary, sameRolloutAsInitial: null, parseError: null, conformance: null } as const;
  const empty = (stop: StopReason, rolloutMatch: StageReport['rolloutMatch'] = 'not_checked', rolloutPath: string | null = null): StageOutcome => ({
    report: { ...base, rolloutMatch, hook: observeHook(messages, rejected, { threadId: reduced.threadId, rolloutPath, cwd: input.cwd, exitedAt: result.exitedAt }) },
    stop, threadId: reduced.threadId, rolloutPath, total: null,
  });
  if (exit !== 'ok') return empty(exit === 'nonzero' ? 'nonzero_exit' : exit);
  if (reduced.threadId === null) return empty('no_thread_id');
  if (input.threadId !== null && reduced.threadId !== input.threadId) return empty('thread_changed');
  const located = locateRollout(deps.sessionsRoot, reduced.threadId, deps.now());
  if (located.match !== 'match' || located.path === null) return empty('rollout_not_unique', located.match);
  const rolloutPath = located.path;
  const hook = observeHook(messages, rejected, { threadId: reduced.threadId, rolloutPath, cwd: input.cwd, exitedAt: result.exitedAt });
  const sameRolloutAsInitial = input.initialRollout === null ? null : samePath(rolloutPath, input.initialRollout);
  const partial = { ...base, rolloutMatch: 'match' as const, sameRolloutAsInitial, hook };
  if (hookConflict(hook, stage === 'initial' ? 'startup' : 'resume')) {
    return { report: partial, stop: 'hook_conflict', threadId: reduced.threadId, rolloutPath, total: null };
  }
  if (sameRolloutAsInitial === false) return { report: partial, stop: 'rollout_changed', threadId: reduced.threadId, rolloutPath, total: null };
  const mapping = createInvestigation({
    projectId: 'conformance', taskId: 'conformance', processId: stage, sessionId: reduced.threadId,
    sourcePath: rolloutPath, product: 'codex',
  });
  let inspection: CandidateInspection;
  try {
    inspection = parseCandidate(readFileSync(rolloutPath, 'utf8'), {
      sessionId: reduced.threadId, projectRoot: input.cwd, product: 'codex', version: input.candidate.version,
    }, input.candidate);
  } catch (error) {
    return { report: { ...partial, parseError: parseErrorCode(error) }, stop: 'parse_error', threadId: reduced.threadId, rolloutPath, total: null };
  }
  // Resume inspections replay the whole file. An earlier checkpoint is not
  // evidence that the resumed invocation wrote a same-thread settings checkpoint.
  const checkpointCount = inspection.traversal.eventCounts.thread_settings_applied ?? 0;
  const stageInspection: CandidateInspection = stage === 'resume' && checkpointCount <= input.priorCheckpointCount
    ? { ...inspection, topology: { ...inspection.topology, threadSettingsApplied: 'absent' } }
    : inspection;
  const investigated = runInvestigation({
    version: input.candidate.version, mapping, plan: input.plan, names: [basename(rolloutPath)],
    channel: { start: () => ({ ...stageInspection, vectors: { ...inspection.vectors, exec: reduced.usage, priorTotal: input.priorTotal } }) },
  });
  return {
    report: { ...partial, conformance: investigated.status === 'report' ? investigated.report : null },
    stop: investigated.status === 'report' ? null : 'internal_error',
    threadId: reduced.threadId, rolloutPath, total: inspection.vectors.total,
  };
}

async function probeVersion(deps: LiveDeps, cwd: string, version: string): Promise<'match' | 'mismatch'> {
  const result = await deps.spawnProduct(['--version'], { cwd, timeoutMs: versionLimitMs });
  const lines = result.stdout.split('\n').map(line => line.trim()).filter(Boolean);
  const exact = lines.length === 1 && lines[0] === `codex-cli ${version}`;
  return result.code === 0 && exact ? 'match' : 'mismatch';
}

/**
 * Manual Codex 0.158.0 exec conformance run. Prints the plan and requires a typed
 * `confirm` before any product command, including the version probe.
 */
export async function runLive(deps: LiveDeps, outDir: string, candidate = codex01580Candidate as ConformanceCandidate, identity?: EvidenceIdentity): Promise<LiveReport> {
  const plan = confirmationPlan([...livePlanLines(deps.productLabel, candidate.version),
    `declared differences: ${JSON.stringify(compareCandidate(candidate))}`,
    `policy: ${identity?.policyRevision ?? 'synthetic'}; source: ${candidate.sourceRef}; previous profile: ${candidate.previousVersion}`,
    `application implementation digest: ${identity?.implementationDigest ?? 'synthetic'}`,
  ]);
  deps.print(renderConfirmation(plan));
  const answer = await deps.readConfirmationLine();
  const notRun = {
    ...identity, version: candidate.version, scenario: 'exec_initial_resume', productVersionBefore: 'not_run',
    productVersionAfter: 'not_run', configMetadataUnchanged: null, stages: [],
  } as const;
  if (readConfirmation(plan, { readLine: () => answer }, null) !== 'confirmed') {
    return { ...notRun, confirmed: false, stop: 'not_confirmed' };
  }
  const runDir = mkdtempSync(join(deps.runRoot, 'hd-conf-'));
  chmodSync(runDir, 0o700);
  let hooks: HookListener | null = null;
  const stages: StageReport[] = [];
  let stop: StopReason | null = null;
  let before: 'match' | 'mismatch' | 'not_run' = 'not_run';
  let after: 'match' | 'mismatch' | 'not_run' = 'not_run';
  let configUnchanged: boolean | null = null;
  try {
    const cwd = join(runDir, 'cwd');
    mkdirSync(cwd, { mode: 0o700 });
    const realCwd = realpathSync(cwd);
    const wrapper = join(realpathSync(runDir), 'session-start-hook');
    const socketPath = join(realpathSync(runDir), 'h.sock');
    const recorder = deps.recorderPath;
    if (![realCwd, wrapper, socketPath, deps.nodePath, recorder].every(path => safeRunPath.test(path))) {
      stop = 'unsafe_run_path';
    } else {
      writeFileSync(wrapper, `#!/bin/sh\nHD_CONFORMANCE_HOOK_SOCKET='${socketPath}' exec '${deps.nodePath}' '${recorder}'\n`, { mode: 0o700 });
      hooks = await startHookListener(socketPath, { now: () => deps.now(), exists: existsSync });
      const hookArgs = hookTrustArguments({ command: wrapper, trustedHash: sessionStartTrustedHash(wrapper) });
      const configBefore = deps.configMetadata();
      before = await probeVersion(deps, realCwd, candidate.version);
      if (before !== 'match') stop = 'version_mismatch';
      let threadId: string | null = null;
      let initialRollout: string | null = null;
      let priorTotal: CounterVector | null = null;
      let priorCheckpointCount = 0;
      for (const stage of ['initial', 'resume'] as const) {
        if (stop !== null) break;
        const outcome = await runStage({ candidate, stage, deps, hooks, hookArgs, cwd: realCwd, plan, threadId, initialRollout, priorTotal, priorCheckpointCount });
        stages.push(outcome.report);
        stop = outcome.stop;
        threadId = outcome.threadId;
        initialRollout ??= outcome.rolloutPath;
        priorTotal = outcome.total;
        priorCheckpointCount = outcome.report.conformance?.eventCounts.thread_settings_applied ?? 0;
      }
      if (before === 'match') {
        after = await probeVersion(deps, realCwd, candidate.version);
        if (after !== 'match') stop ??= 'version_changed';
      }
      configUnchanged = deps.configMetadata() === configBefore;
      if (!configUnchanged) stop ??= 'config_changed';
    }
  } catch {
    stop ??= 'internal_error';
  } finally {
    if (hooks !== null) await hooks.close();
    rmSync(runDir, { recursive: true, force: true });
  }
  const report: LiveReport = {
    ...notRun, confirmed: true, productVersionBefore: before, productVersionAfter: after,
    configMetadataUnchanged: configUnchanged, stop, stages,
  };
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  writeRestrictedJson(outDir, 'conformance-live-report.json', report);
  return report;
}
