import type { CodexFailureSummary } from './codex-failure-diagnostics.js';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { Collector, readSource } from '../collection.js';
import { BoundedCandidateInvocation, MAX_CANDIDATE_DURATION_MS } from '../workflow/bounded-candidate-invocation.js';
import { Lifecycle, utcNow } from '../lifecycle.js';
import { authorizeCandidateScope, type CandidateScope } from '../nested-candidate.js';
import { parseTaskMetadata } from '../flexible-contracts.js';
import {
  checkCandidatePermissions,
  CandidatePermissionFailure,
  type CandidateWireMode,
  type CandidatePermissionField
} from '../codex-candidate-permissions.js';
import type { Store } from '../store.js';

/** Internal source-qualified 0.160 lane; absent from public exports/CLI/admission.
 * prepare() does no product execution. run() is the explicit paid-run boundary.
 * Pinned source a956835d: hook_runtime.rs, session/turn.rs, hooks/schema.rs,
 * hooks/engine/discovery.rs, agent/child_config.rs and rollout/recorder.rs.
 * Native hook errors may fail open. Observation/termination is delayed and does
 * not bound internal requests, token usage, escaped groups or in-flight billing.
 */
export interface CodexQualificationOptions {
  store: Store;
  projectId: string;
  taskId: string;
  cwd: string;
  ledgerDirectory: string;
  codexHome: string;
  sessionsRoot: string;
  executable: string;
  executableSha256: string;
  nodeExecutable: string;
  hookRecorder: string;
  rootModel: 'gpt-6-astra';
  childModel: 'gpt-6.1-sol';
  rootEffort: 'high';
  childEffort: 'high';
  durationMs?: number;
  handshakeTimeoutMs?: number;
  pollMs?: number;
  /** Reuse login through the native process only; never inspect/delete prior
   * transcripts or copy credentials. Fresh callback/birthtime guards still apply.
   * New fixture/task/ledger and new specific actual-call approval are required. */
  reuseExistingHome?: boolean;
}
export interface CodexQualificationDiagnostic {
  phase:
    | 'handshake_json'
    | 'handshake_schema'
    | 'permissions'
    | 'source_metadata'
    | 'registration'
    | 'baseline'
    | 'listener_io'
    | 'observation'
    | 'capability'
    | 'progress';
  field: CandidatePermissionField | 'metadata' | 'hook_schema' | 'transport' | 'multi_agent_version' | 'spawn_progress';
  code: string;
  wireMode: CandidateWireMode | 'unknown' | 'missing';
  stage?: 'initial_root_handoff' | 'root_waiting' | 'child_handoff_wait' | 'child_linked';
  capability?: 'v1' | 'v2' | 'disabled' | 'unknown';
  progress?: 'v2_item_completed' | 'v2_legacy_activity';
  observedAfterMs?: number;
  declaration?: 'managed_read_only_restricted';
  approvalPolicy?: 'never' | 'on-request';
  reviewer?: 'user' | 'auto_review';
}
export interface CodexQualificationResult {
  status: 'completed' | 'stopped' | 'failed' | 'timed_out' | 'launch_failed';
  reason: string | null;
  observedRequests: number;
  registeredSessions: number;
  elapsedMs: number;
  pollMs: number;
  internalRequestLimit: null;
  cost: null;
  diagnostics: CodexQualificationDiagnostic[];
  nativeFailureDiagnostics?: CodexFailureSummary;
}
class CandidateFlowFailure extends Error {
  constructor(
    code: 'candidate_multi_agent_disabled' | 'candidate_unapproved_spawn' | 'candidate_scope_mismatch' | 'candidate_missing_child_handshake',
    readonly field: 'multi_agent_version' | 'spawn_progress'
  ) {
    super(code);
  }
}
const id = z.string().regex(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
const handshakeSchema = z.object({
  session_id: id,
  transcript_path: z.string(),
  cwd: z.string(),
  hook_event_name: z.enum(['SessionStart', 'SubagentStart']),
  model: z.string(),
  permission_mode: z.enum(['default', 'bypassPermissions']),
  source: z.literal('startup').optional(),
  turn_id: z.string().min(1).optional(),
  agent_id: id.optional(),
  agent_type: z.string().optional()
});
const envelope = z.object({ type: z.string(), payload: z.unknown() });
const headerSchema = z.object({
  id,
  session_id: id,
  cli_version: z.literal('0.160.0'),
  cwd: z.string(),
  parent_thread_id: id.nullish(),
  source: z.unknown(),
  forked_from_id: z.unknown().optional(),
  history_base: z.unknown().optional(),
  forked_from_ordinal_exclusive: z.unknown().optional(),
  subagent_history_start_ordinal: z.unknown().optional()
});
const contextSchema = z
  .object({ turn_id: z.string().min(1), root_turn_id: z.string().nullish(), cwd: z.string(), model: z.string(), effort: z.string() })
  .passthrough();
const candidateErrors = new Set([
  'candidate_handshake_error',
  'candidate_unapproved_handshake',
  'candidate_source_scope_mismatch',
  'candidate_scope_mismatch',
  'candidate_inactive_scope',
  'candidate_mixed_sources',
  'candidate_source_error',
  'candidate_source_changed',
  'candidate_clock_regressed',
  'candidate_invalid_mapping',
  'candidate_invalid_metadata',
  'candidate_unsupported_history',
  'candidate_conflict',
  'candidate_storage_error',
  'candidate_late_handshake',
  'candidate_incomplete_initial_source',
  'candidate_missing_initial_context',
  'candidate_unapproved_turn_or_settings',
  'candidate_timed_out',
  'candidate_missing_child_handshake',
  'candidate_native_error',
  'candidate_child_scope_mismatch',
  'candidate_child_already_reserved',
  'candidate_reservation_failed',
  'candidate_multi_agent_disabled',
  'candidate_unapproved_spawn',
  'candidate_permissions_invalid',
  'candidate_permission_mode_mismatch',
  'candidate_permissions_changed',
  'candidate_source_metadata_invalid'
]);
const safeCandidateError = (error: unknown, fallback: string) => (error instanceof Error && candidateErrors.has(error.message) ? error.message : fallback);
function wireModeOf(value: unknown): CandidateWireMode | 'unknown' | 'missing' {
  if (value === null || typeof value !== 'object' || !('permission_mode' in value)) return 'missing';
  return value.permission_mode === 'default' || value.permission_mode === 'bypassPermissions' ? value.permission_mode : 'unknown';
}
function checkedPath(path: string): string {
  if (!isAbsolute(path) || resolve(path) !== path || path.includes('\0')) throw new Error('candidate_invalid_invocation');
  return path;
}
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
/** Exact 0.160 normalized identity, with an explicit 5s timeout on both events. */
function hookArguments(command: string): string[] {
  if (!/^\/(?:[A-Za-z0-9._+-]+\/)*[A-Za-z0-9._+-]+$/.test(command)) throw new Error('candidate_invalid_hook_command');
  const states: string[] = [];
  const args: string[] = [];
  for (const [event, label] of [
    ['SessionStart', 'session_start'],
    ['SubagentStart', 'subagent_start']
  ] as const) {
    const identity = JSON.stringify({ event_name: label, hooks: [{ async: false, command, timeout: 5, type: 'command' }] });
    const hash = `sha256:${createHash('sha256').update(identity).digest('hex')}`;
    args.push('-c', `hooks.${event}=[{hooks=[{type="command",command="${command}",timeout=5}]}]`);
    states.push(`"/<session-flags>/config.toml:${label}:0:0"={trusted_hash="${hash}"}`);
  }
  args.push('-c', `hooks.state={${states.join(',')}}`);
  return args;
}
export function prepareCodexQualification(input: CodexQualificationOptions) {
  const options = { ...input };
  for (const path of [
    options.cwd,
    options.ledgerDirectory,
    options.codexHome,
    options.sessionsRoot,
    options.executable,
    options.nodeExecutable,
    options.hookRecorder
  ])
    checkedPath(path);
  const cwd = realpathSync(options.cwd);
  const sessionsRoot = realpathSync(options.sessionsRoot);
  const codexHome = realpathSync(options.codexHome);
  if (options.reuseExistingHome !== undefined && typeof options.reuseExistingHome !== 'boolean') throw new Error('candidate_invalid_invocation');
  const homeFresh = () => options.reuseExistingHome === true || readdirSync(sessionsRoot).length === 0;
  if (
    cwd !== options.cwd ||
    sessionsRoot !== options.sessionsRoot ||
    codexHome !== options.codexHome ||
    sessionsRoot !== join(codexHome, 'sessions') ||
    readdirSync(cwd).length !== 0 ||
    !homeFresh() ||
    options.rootModel !== 'gpt-6-astra' ||
    options.childModel !== 'gpt-6.1-sol' ||
    options.rootEffort !== 'high' ||
    options.childEffort !== 'high'
  )
    throw new Error('candidate_invalid_invocation');
  const digest = createHash('sha256').update(readFileSync(options.executable)).digest('hex');
  if (!/^[0-9a-f]{64}$/.test(options.executableSha256) || digest !== options.executableSha256) throw new Error('candidate_executable_mismatch');
  const durationMs = options.durationMs ?? MAX_CANDIDATE_DURATION_MS;
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? 10_000;
  const pollMs = options.pollMs ?? 25;
  if (
    !Number.isSafeInteger(durationMs) ||
    durationMs <= 0 ||
    durationMs > MAX_CANDIDATE_DURATION_MS ||
    !Number.isSafeInteger(handshakeTimeoutMs) ||
    handshakeTimeoutMs <= 0 ||
    handshakeTimeoutMs > durationMs ||
    !Number.isSafeInteger(pollMs) ||
    pollMs <= 0 ||
    pollMs > 1000
  )
    throw new Error('candidate_invalid_invocation');
  const lifecycle = new Lifecycle(options.store);
  const task = lifecycle.task(options.taskId);
  if (
    task.state !== 'active' ||
    task.project_id !== options.projectId ||
    options.store.get<{ local_root: string }>('SELECT local_root FROM projects WHERE id=?', [options.projectId])?.local_root !== cwd ||
    options.store.get('SELECT 1 FROM sessions WHERE task_id=?', [options.taskId])
  )
    throw new Error('candidate_inactive_scope');
  const validateLaunch = () => {
    const current = lifecycle.task(options.taskId);
    const metadata = parseTaskMetadata(JSON.parse(current.metadata) as unknown);
    if (
      current.state !== 'active' ||
      current.generation !== task.generation ||
      current.project_id !== options.projectId ||
      metadata.product !== 'codex' ||
      ('schema_version' in metadata && metadata.schema_version === 2) ||
      options.store.get<{ local_root: string }>('SELECT local_root FROM projects WHERE id=?', [options.projectId])?.local_root !== cwd ||
      options.store.get("SELECT 1 FROM tombstones WHERE (kind='task' AND id=?) OR (kind='project' AND id=?)", [options.taskId, options.projectId]) ||
      options.store.get('SELECT 1 FROM sessions WHERE task_id=?', [options.taskId])
    )
      throw new Error('candidate_inactive_scope');
    if (
      options.store.get(
        'SELECT 1 FROM comparison_assignments WHERE task_id=? UNION ALL SELECT 1 FROM otel_processes WHERE task_id=? UNION ALL SELECT 1 FROM observation_runs WHERE task_id=? UNION ALL SELECT 1 FROM events WHERE task_id=? LIMIT 1',
        [options.taskId, options.taskId, options.taskId, options.taskId]
      )
    )
      throw new Error('candidate_mixed_sources');
    if (
      realpathSync(options.cwd) !== cwd ||
      realpathSync(options.codexHome) !== codexHome ||
      realpathSync(options.sessionsRoot) !== sessionsRoot ||
      readdirSync(cwd).length !== 0 ||
      !homeFresh()
    )
      throw new Error('candidate_invalid_invocation');
    if (createHash('sha256').update(readFileSync(options.executable)).digest('hex') !== digest) throw new Error('candidate_executable_mismatch');
  };
  validateLaunch();
  const directory = join(options.ledgerDirectory, 'codex-candidate');
  mkdirSync(directory, { mode: 0o700 });
  const socketPath = join(directory, 'start.sock');
  if (Buffer.byteLength(socketPath) > 100) throw new Error('candidate_socket_path_too_long');
  const command = join(directory, 'start-hook');
  writeFileSync(command, `#!/bin/sh\nexec ${shellQuote(options.nodeExecutable)} ${shellQuote(options.hookRecorder)} ${shellQuote(socketPath)}\n`, {
    mode: 0o700,
    flag: 'wx'
  });
  const argv = [
    'exec',
    '--skip-git-repo-check',
    '--cd',
    cwd,
    '--sandbox',
    'read-only',
    '-c',
    'approval_policy="on-request"',
    '--model',
    options.rootModel,
    '-c',
    `model_reasoning_effort="${options.rootEffort}"`,
    '-c',
    'agents.enabled=true',
    '-c',
    `agents.default_subagent_model="${options.childModel}"`,
    '-c',
    `agents.default_subagent_reasoning_effort="${options.childEffort}"`,
    '-c',
    'agents.max_depth=1',
    ...hookArguments(command),
    'Synthetic qualification only. Spawn exactly one fresh direct child (V2: fork_turns="none", omit fork_context; V1: fork_context=false), model gpt-6.1-sol, reasoning_effort high. Ask it to return exactly READY. Wait for that child and return exactly READY. Do not use files, shell, external tools or further children.'
  ];
  const invocation = new BoundedCandidateInvocation(directory, {
    rootSessionId: 'pending-root',
    childModel: options.childModel,
    childEffort: options.childEffort
  });
  let used = false;
  return Promise.resolve({
    executable: options.executable,
    executableSha256: digest,
    argv: Object.freeze(argv),
    environment: { CODEX_HOME: codexHome },
    async run(runOptions: { signal?: AbortSignal } = {}): Promise<CodexQualificationResult> {
      if (used) throw new Error('candidate_root_already_started');
      used = true;
      validateLaunch();
      if (runOptions.signal?.aborted)
        return {
          status: 'stopped',
          reason: 'candidate_cancelled',
          observedRequests: 0,
          registeredSessions: 0,
          elapsedMs: 0,
          pollMs,
          internalRequestLimit: null,
          cost: null,
          diagnostics: []
        };
      const started = Date.now();
      const absoluteDeadline = started + durationMs;
      const controller = new AbortController();
      const sockets = new Set<Socket>();
      const scope: CandidateScope = { projectId: options.projectId, taskId: options.taskId, allowedRootTurnIds: [], sessions: [] };
      const sources = { projectRoot: cwd, paths: {} as Record<string, string> };
      const diagnostics: CodexQualificationDiagnostic[] = [];
      const permissions = new Map<string, { wireMode: CandidateWireMode; signature: string | null }>();
      let guardedCandidateFailure: { error: CandidatePermissionFailure | CandidateFlowFailure; wireMode: CandidateWireMode } | null = null;
      let rootReady = false;
      let childReady = false;
      let childDeadline: number | null = null;
      let capability: CodexQualificationDiagnostic['capability'] | null = null;
      const spawnCalls = new Map<string, string>();
      const stage = (): NonNullable<CodexQualificationDiagnostic['stage']> =>
        !rootReady
          ? 'initial_root_handoff'
          : childReady
            ? 'child_linked'
            : scope.sessions.length === 2 || childDeadline !== null
              ? 'child_handoff_wait'
              : 'root_waiting';
      const guardHandoffTime = (root: boolean) => {
        if (Date.now() >= absoluteDeadline) throw new Error('candidate_timed_out');
        if (!root && childDeadline !== null && Date.now() >= childDeadline)
          throw new CandidateFlowFailure('candidate_missing_child_handshake', 'spawn_progress');
      };
      let reason: string | null = null;
      let rootNative: string | null = null;
      let childTurn: string | null = null;
      let childReservation: BoundedCandidateInvocation | null = null;
      const stop = (code: string) => {
        reason ??= code;
        controller.abort();
      };
      const diagnose = (
        error: unknown,
        phase: CodexQualificationDiagnostic['phase'],
        wireMode: CodexQualificationDiagnostic['wireMode'],
        field: CodexQualificationDiagnostic['field'],
        fallback: string
      ) => {
        const code = safeCandidateError(error, fallback);
        diagnostics.push({
          phase:
            error instanceof CandidatePermissionFailure
              ? 'permissions'
              : error instanceof CandidateFlowFailure
                ? error.field === 'multi_agent_version'
                  ? 'capability'
                  : 'progress'
                : phase,
          field: error instanceof CandidatePermissionFailure || error instanceof CandidateFlowFailure ? error.field : field,
          wireMode,
          code,
          stage: stage(),
          ...(error instanceof CandidateFlowFailure && error.field === 'multi_agent_version' ? { capability: capability ?? 'unknown' } : {})
        });
        stop(code);
      };
      const authorizeReads = () => {
        authorizeCandidateScope(options.store, scope);
        if (lifecycle.task(options.taskId).generation !== task.generation) throw new Error('candidate_inactive_scope');
        const links = options.store.all<{ id: string; project_id: string; source_path: string; local_root: string }>(
          'SELECT s.id,s.project_id,s.source_path,p.local_root FROM sessions s JOIN projects p ON p.id=s.project_id WHERE s.task_id=?',
          [options.taskId]
        );
        if (links.length !== scope.sessions.length || Object.keys(sources.paths).length !== scope.sessions.length) throw new Error('candidate_scope_mismatch');
        for (const mapping of scope.sessions) {
          const link = links.find(row => row.id === mapping.sessionId);
          if (!link || link.project_id !== scope.projectId || link.local_root !== cwd || link.source_path !== sources.paths[mapping.sourceId])
            throw new Error('candidate_scope_mismatch');
        }
      };
      const sourceRows = (sourceId: string, verifiedText?: string, initial = false) =>
        options.store.immediateTransaction(() => {
          // Exact full manifest path/root, active state and generation authorization
          // bracket every read. The writer lock prevents concurrent relinking.
          authorizeReads();
          const text = verifiedText ?? readSource(sources.paths[sourceId]!).text;
          authorizeReads();
          if (initial && text !== '' && !text.endsWith('\n')) throw new Error('candidate_incomplete_initial_source');
          return text
            .split('\n')
            .slice(0, -1)
            .map(line => envelope.parse(JSON.parse(line) as unknown));
        });
      const validateRows = (sourceId: string, initial: boolean, verifiedText?: string) => {
        const mapping = scope.sessions.find(s => s.sourceId === sourceId)!;
        const rows = sourceRows(sourceId, verifiedText, initial);
        const header = headerSchema.parse(rows[0]?.payload);
        if (
          rows[0]?.type !== 'session_meta' ||
          header.id !== mapping.nativeSessionId ||
          header.session_id !== rootNative ||
          header.cwd !== cwd ||
          (header.parent_thread_id ?? null) !== (mapping.parentSessionId === null ? null : rootNative) ||
          [header.forked_from_id, header.history_base, header.forked_from_ordinal_exclusive, header.subagent_history_start_ordinal].some(v => v != null)
        )
          throw new Error('candidate_scope_mismatch');
        if (initial && rows.some(row => row.type === 'token_usage_record')) throw new Error('candidate_late_handshake');
        const contexts = rows.filter(row => row.type === 'turn_context').map(row => contextSchema.parse(row.payload));
        if (!contexts.length) throw new Error('candidate_missing_initial_context');
        const first = contexts[0]!;
        if (mapping.parentSessionId === null) {
          if (scope.allowedRootTurnIds.length === 0) scope.allowedRootTurnIds.push(first.turn_id);
        } else if (first.turn_id !== childTurn) throw new Error('candidate_scope_mismatch');
        const turn = mapping.parentSessionId === null ? scope.allowedRootTurnIds[0] : childTurn;
        for (const context of contexts) {
          const permission = permissions.get(sourceId)!;
          const proof = checkCandidatePermissions(context, permission.wireMode);
          if (permission.signature !== null && permission.signature !== proof.signature)
            throw new CandidatePermissionFailure('permission_profile', 'candidate_permissions_changed');
          if (permission.signature === null) {
            permission.signature = proof.signature;
            diagnostics.push({
              phase: 'permissions',
              field: 'permission_profile',
              code: 'candidate_permissions_verified',
              wireMode: proof.wireMode,
              declaration: proof.declaration,
              approvalPolicy: proof.approvalPolicy,
              reviewer: proof.reviewer
            });
          }
          if (
            context.turn_id !== turn ||
            context.cwd !== cwd ||
            context.model !== (mapping.parentSessionId === null ? options.rootModel : options.childModel) ||
            context.effort !== 'high' ||
            (mapping.parentSessionId === null
              ? context.root_turn_id != null && context.root_turn_id !== turn
              : context.root_turn_id !== scope.allowedRootTurnIds[0])
          )
            throw new Error('candidate_unapproved_turn_or_settings');
        }
        if (rows.some(row => row.type === 'event_msg' && z.object({ type: z.string() }).parse(row.payload).type === 'error'))
          throw new Error('candidate_native_error');
        // Resolved capability is a declaration, never tool/backend/auth attestation.
        if (mapping.parentSessionId === null) {
          for (const context of contexts) {
            const declared =
              context.multi_agent_version === 'v1' || context.multi_agent_version === 'v2' || context.multi_agent_version === 'disabled'
                ? context.multi_agent_version
                : 'unknown';
            if (declared === 'disabled') {
              capability = declared;
              throw new CandidateFlowFailure('candidate_multi_agent_disabled', 'multi_agent_version');
            }
            if (capability !== null && capability !== 'unknown' && declared !== 'unknown' && capability !== declared)
              throw new CandidateFlowFailure('candidate_scope_mismatch', 'multi_agent_version');
            if (capability === null || (capability === 'unknown' && declared !== 'unknown')) {
              capability = declared;
              diagnostics.push({
                phase: 'capability',
                field: 'multi_agent_version',
                code: declared === 'unknown' ? 'candidate_multi_agent_unknown' : 'candidate_multi_agent_declared',
                wireMode: permissions.get(sourceId)!.wireMode,
                capability: declared,
                stage: stage()
              });
            }
          }
        }
        // Pinned V2 emits Started activity AFTER spawn. ItemStarted is transient;
        // observe persisted ItemCompleted or its legacy fanout, never raw wall time.
        for (const row of rows) {
          if (row.type !== 'event_msg') continue;
          const event = z.object({ type: z.string() }).parse(row.payload);
          let call: string;
          let child: string;
          let progress: NonNullable<CodexQualificationDiagnostic['progress']>;
          if (event.type === 'item_completed') {
            const item = z.object({ item: z.object({ type: z.string(), kind: z.string().optional() }) }).safeParse(row.payload);
            if (!item.success || item.data.item.type !== 'SubAgentActivity' || item.data.item.kind !== 'started') continue;
            const metadata = z
              .object({ thread_id: id, turn_id: z.string(), item: z.object({ id: z.string().min(1), agent_thread_id: id }) })
              .safeParse(row.payload);
            if (!metadata.success || metadata.data.thread_id !== mapping.nativeSessionId || metadata.data.turn_id !== turn)
              throw new CandidateFlowFailure('candidate_scope_mismatch', 'spawn_progress');
            call = metadata.data.item.id;
            child = metadata.data.item.agent_thread_id;
            progress = 'v2_item_completed';
          } else if (event.type === 'sub_agent_activity') {
            const kind = z.object({ kind: z.string() }).safeParse(row.payload);
            if (!kind.success || kind.data.kind !== 'started') continue;
            const metadata = z.object({ event_id: z.string().min(1), agent_thread_id: id }).safeParse(row.payload);
            if (!metadata.success) throw new CandidateFlowFailure('candidate_scope_mismatch', 'spawn_progress');
            call = metadata.data.event_id;
            child = metadata.data.agent_thread_id;
            progress = 'v2_legacy_activity';
          } else continue;
          if (
            mapping.parentSessionId !== null ||
            child === rootNative ||
            (scope.sessions[1] !== undefined && scope.sessions[1].nativeSessionId !== child) ||
            (spawnCalls.has(call) && spawnCalls.get(call) !== child) ||
            (!spawnCalls.has(call) && spawnCalls.size !== 0)
          )
            throw new CandidateFlowFailure('candidate_unapproved_spawn', 'spawn_progress');
          if (spawnCalls.has(call)) continue;
          spawnCalls.set(call, child);
          const observedAt = Date.now();
          if (scope.sessions.length < 2 && childDeadline === null) childDeadline = Math.min(absoluteDeadline, observedAt + handshakeTimeoutMs);
          diagnostics.push({
            phase: 'progress',
            field: 'spawn_progress',
            code: 'candidate_spawn_progress_observed',
            wireMode: permissions.get(sourceId)!.wireMode,
            progress,
            observedAfterMs: observedAt - started,
            stage: stage()
          });
        }

        return first.turn_id;
      };
      // Validate the SAME bounded bytes Collector projects. A later native append
      // cannot smuggle relaxed permissions between observer and collection reads.
      const collector = new Collector(options.store, utcNow, path => {
        authorizeReads();
        const bytes = readSource(path);
        authorizeReads();
        const mapping = scope.sessions.find(session => sources.paths[session.sourceId] === path);
        if (!mapping) throw new Error('candidate_scope_mismatch');
        try {
          validateRows(mapping.sourceId, false, bytes.text);
        } catch (error) {
          if (error instanceof CandidatePermissionFailure || error instanceof CandidateFlowFailure)
            guardedCandidateFailure = { error, wireMode: permissions.get(mapping.sourceId)!.wireMode };
          throw error;
        }
        return bytes;
      });
      const server = createServer(socket => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.on('error', () => diagnose(null, 'listener_io', 'missing', 'transport', 'candidate_listener_io_error'));
        socket.setTimeout(handshakeTimeoutMs, () => {
          stop('candidate_missing_handshake');
          socket.destroy();
        });
        let text = '';
        let handled = false;
        socket.on('data', (chunk: Buffer) => {
          if (handled) return stop('candidate_conflicting_handshake');
          text += chunk.toString('utf8');
          if (Buffer.byteLength(text) > 16384) {
            diagnose(null, 'listener_io', 'missing', 'transport', 'candidate_handshake_too_large');
            socket.destroy();
            return;
          }
          if (!text.includes('\n')) return;
          handled = true;
          let phase: CodexQualificationDiagnostic['phase'] = 'handshake_json';
          let field: CodexQualificationDiagnostic['field'] = 'metadata';
          let wireMode: CodexQualificationDiagnostic['wireMode'] = 'missing';
          try {
            const decoded: unknown = JSON.parse(text.trim());
            phase = 'handshake_schema';
            wireMode = wireModeOf(decoded);
            field = wireMode === 'unknown' || wireMode === 'missing' ? 'permission_mode' : 'hook_schema';
            if (Date.now() >= absoluteDeadline) throw new Error('candidate_timed_out');
            const message = handshakeSchema.parse(decoded);
            const root = message.hook_event_name === 'SessionStart';
            guardHandoffTime(root);
            if (
              message.cwd !== cwd ||
              message.model !== (root ? options.rootModel : options.childModel) ||
              (root
                ? rootNative !== null || message.source !== 'startup' || message.agent_id !== undefined
                : rootNative === null ||
                  message.agent_id === undefined ||
                  scope.sessions.length !== 1 ||
                  message.session_id !== rootNative ||
                  message.agent_id === rootNative ||
                  !message.turn_id ||
                  (spawnCalls.size !== 0 && ![...spawnCalls.values()].includes(message.agent_id)))
            )
              throw new Error('candidate_unapproved_handshake');
            phase = 'source_metadata';
            field = 'metadata';
            const path = checkedPath(message.transcript_path);
            const rel = relative(sessionsRoot, path);
            const stat = statSync(path);
            // Declared run-scoped sessions root + held native callback authorize this
            // exact fresh path. Header contents validate identity; they grant no permission.
            // Date.now truncates fractional filesystem milliseconds. Exclude
            // the entire launch millisecond so a prior file cannot look fresh.
            if (rel.startsWith('..') || isAbsolute(rel) || realpathSync(path) !== path || !stat.isFile() || stat.birthtimeMs < started + 1)
              throw new Error('candidate_source_scope_mismatch');
            const native = root ? message.session_id : message.agent_id!;
            const sessionId = randomUUID();
            const sourceId = randomUUID();
            if (root) {
              rootNative = native;
              childReservation = new BoundedCandidateInvocation(directory, {
                rootSessionId: native,
                childModel: options.childModel,
                childEffort: options.childEffort
              });
            } else {
              childReservation!.reserveDirectChild({
                callerSessionId: rootNative!,
                parentSessionId: rootNative!,
                depth: 1,
                model: options.childModel,
                effort: options.childEffort
              });
              childTurn = message.turn_id!;
            }
            const localRoot = root ? sessionId : scope.sessions[0]!.sessionId;
            phase = 'registration';
            lifecycle.linkCodexCandidateSession(options.taskId, options.projectId, sessionId, path, '0.160.0', root ? null : localRoot);
            scope.sessions.push({
              sessionId,
              rootSessionId: localRoot,
              parentSessionId: root ? null : localRoot,
              sourceId,
              product: 'codex',
              nativeSessionId: native,
              processId: null,
              agentId: null
            });
            sources.paths[sourceId] = path;
            permissions.set(sourceId, { wireMode: message.permission_mode, signature: null });
            phase = 'source_metadata';
            const turn = validateRows(sourceId, true);
            // Native first context is already durable BEFORE its awaited hook. Only
            // future responses in this validated initial turn cross this baseline.
            phase = 'baseline';
            collector.tickCodexCandidate(scope, sources, { [sourceId]: turn });
            guardHandoffTime(root);
            if (root) rootReady = true;
            else {
              childReady = true;
              childDeadline = null;
            }
            socket.end('ok\n');
          } catch (error) {
            diagnose(
              guardedCandidateFailure?.error ?? error,
              phase,
              guardedCandidateFailure?.wireMode ?? wireMode,
              field,
              phase === 'handshake_json'
                ? 'candidate_handshake_json_invalid'
                : phase === 'handshake_schema'
                  ? 'candidate_handshake_schema_invalid'
                  : phase === 'source_metadata'
                    ? 'candidate_source_metadata_invalid'
                    : phase === 'registration'
                      ? 'candidate_registration_failed'
                      : 'candidate_baseline_failed'
            );
            socket.end('stop\n');
          }
        });
      });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, () => {
          server.off('error', reject);
          resolve();
        });
      });
      chmodSync(socketPath, 0o600);
      const observe = () => {
        if (reason) return;
        let observedWireMode: CodexQualificationDiagnostic['wireMode'] = 'missing';
        try {
          if (Date.now() >= absoluteDeadline) {
            stop('candidate_timed_out');
            return;
          }
          if (!rootReady) {
            if (Date.now() - started > handshakeTimeoutMs) stop('candidate_missing_handshake');
            return;
          }
          for (const mapping of scope.sessions) {
            observedWireMode = permissions.get(mapping.sourceId)?.wireMode ?? 'missing';
            validateRows(mapping.sourceId, false);
          }
          collector.tickCodexCandidate(scope, sources);
          if (Date.now() >= absoluteDeadline) stop('candidate_timed_out');
          else if (scope.sessions.length < 2 && childDeadline !== null && Date.now() >= childDeadline)
            diagnose(null, 'progress', permissions.get(scope.sessions[0]!.sourceId)!.wireMode, 'spawn_progress', 'candidate_missing_child_handshake');
        } catch (error) {
          diagnose(
            guardedCandidateFailure?.error ?? error,
            'observation',
            guardedCandidateFailure?.wireMode ?? observedWireMode,
            'metadata',
            'candidate_source_error'
          );
        }
      };
      const onAbort = () => stop('candidate_cancelled');
      runOptions.signal?.addEventListener('abort', onAbort, { once: true });
      if (runOptions.signal?.aborted) onAbort();
      const timer = setInterval(observe, pollMs);
      let processResult;
      try {
        // EXACT approval boundary: first and only model-generating root spawn.
        const remaining = absoluteDeadline - Date.now();
        if (remaining <= 0) {
          stop('candidate_timed_out');
          processResult = { status: 'timed_out' as const, exitCode: null };
        } else
          processResult = await invocation.run(options.executable, argv, remaining, {
            cwd,
            signal: controller.signal,
            env: { ...process.env, CODEX_HOME: codexHome },
            codexFailureDiagnostics: true
          });
        observe();
        if (!reason && processResult.status !== 'completed') reason = `candidate_${processResult.status}`;
        const count = (sessionId: string | undefined) =>
          sessionId === undefined
            ? 0
            : options.store.all('SELECT id FROM runtime_evidence WHERE task_id=? AND session_id=?', [options.taskId, sessionId]).length;
        if (!reason && (scope.sessions.length !== 2 || count(scope.sessions[0]?.sessionId) < 2 || count(scope.sessions[1]?.sessionId) < 1))
          reason = 'candidate_incomplete_observation';
      } finally {
        clearInterval(timer);
        runOptions.signal?.removeEventListener('abort', onAbort);
        for (const socket of sockets) socket.destroy();
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
      if (reason === 'candidate_timed_out')
        diagnostics.push({
          phase: 'observation',
          field: 'metadata',
          wireMode: scope.sessions[0] ? permissions.get(scope.sessions[0].sourceId)!.wireMode : 'missing',
          code: reason,
          stage: stage()
        });
      return {
        status: reason ? (processResult.status === 'completed' ? 'stopped' : processResult.status) : 'completed',
        reason,
        observedRequests: options.store.all('SELECT id FROM runtime_evidence WHERE task_id=?', [options.taskId]).length,
        registeredSessions: scope.sessions.length,
        elapsedMs: Date.now() - started,
        pollMs,
        internalRequestLimit: null,
        cost: null,
        diagnostics,
        ...(processResult.failureDiagnostics ? { nativeFailureDiagnostics: processResult.failureDiagnostics } : {})
      };
    }
  });
}
