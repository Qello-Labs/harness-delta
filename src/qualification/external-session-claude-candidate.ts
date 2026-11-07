import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, mkdirSync, lstatSync } from 'node:fs';
import { join, sep } from 'node:path';
import { TimestampSchema } from '../contracts.js';
import { sha256 } from '../workflow/external-session-managed-file.js';
import { ClaudeProbeCoordinator } from './claude-probe-coordinator.js';
import { startClaudeProbeGateway, type ClaudeProbeGatewayCoordinator } from './claude-probe-gateway.js';
import { recordObservationGap } from '../core/runtime-history.js';
import type { CandidateScope } from '../nested-candidate.js';
import type { Clock } from '../core/lifecycle.js';
import type { Store } from '../store.js';
import { prepareClaudeNativeProbe } from './claude-native-probe.js';
import { prepareClaudeProbeHookMediator } from './claude-probe-hook-mediator.js';
import { verifyClaudeProbeBinary } from './claude-probe-supervisor.js';
import { toolVersionRecipe, toolVersionIdentity } from '../core/tool-version-profiles.js';

const manualRecipe = (() => {
  const recipe = toolVersionRecipe('claude-manual-candidate-02188');
  if (recipe.kind !== 'claude_manual_candidate') throw new Error('claude_manual_candidate_recipe_mismatch');
  return recipe;
})();
const manualVersion = z.literal('2.1.288').parse(manualRecipe.version);

const pathSchema = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^\//)
  .refine(p => !/[\r\n\0]/.test(p));
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const pinnedManualClaudeBinarySha = z
  .literal('bbe93063f7a0879a1021b2891e5c9354e5b3b98433e32efe6750f7710afed750')
  .parse(toolVersionIdentity(manualRecipe.imageIdentity).sha256);
export const ManualClaudeInvocationSchema = z.strictObject({
  ticket_id: z.uuid(),
  issued_at: TimestampSchema,
  native_session_id: z.uuid(),
  binary: z.strictObject({ path: pathSchema, version: z.literal(manualVersion), sha256: z.literal(pinnedManualClaudeBinarySha) }),
  settings_path: pathSchema,
  settings_hash: digest,
  instructions_path: pathSchema,
  instructions_hash: digest,
  empty_mcp_path: pathSchema,
  model: z.literal(manualRecipe.model),
  effort: z.literal(manualRecipe.effort)
});
export type ManualClaudeInvocation = z.infer<typeof ManualClaudeInvocationSchema>;
/** Pure private handoff. Settings/mediator/gateway preparation is a separate
 * authorized step; this builder writes/executes no file, hook or process. */
export function manualClaudeHandoff(input: ManualClaudeInvocation) {
  const invocation = ManualClaudeInvocationSchema.parse(input);
  const argv = [
    '-p',
    '--model',
    invocation.model,
    '--effort',
    invocation.effort,
    '--max-turns',
    '1',
    '--max-budget-usd',
    manualRecipe.estimatedUsd,
    '--restricted',
    '--permission-mode',
    'dontAsk',
    '--permission-prompts',
    'none',
    '--tools',
    '',
    '--allowedTools',
    '',
    '--strict-mcp-config',
    '--mcp-config',
    invocation.empty_mcp_path,
    '--setting-sources',
    '',
    '--settings',
    invocation.settings_path,
    '--append-system-prompt-file',
    invocation.instructions_path,
    '--session-id',
    invocation.native_session_id,
    '--no-session-persistence',
    '--no-chrome',
    '--disable-slash-commands',
    '--prompt-suggestions',
    'false',
    '--output-format',
    'stream-json',
    '--verbose'
  ];
  const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
  return {
    invocation,
    argv,
    argv_hash: sha256(JSON.stringify(argv)),
    start_command: [invocation.binary.path, ...argv].map(quote).join(' '),
    automatic_launch: false,
    profile_status: manualRecipe.status,
    native_loading: 'unverified',
    hard_billing_bound: null
  };
}

/** Trusted identified-process reader output, never a UI/HTTP payload. argv and
 * file paths are transient; only their expected digests survive projection. */
export interface ManualClaudeProcessObservation {
  pid: number;
  started_at: string;
  binary_path: string;
  binary_hash: string;
  argv: readonly string[];
  settings_hash: string;
  instructions_hash: string;
}

function boundedFileHash(path: string, limit: number): string {
  let fd: number | undefined;
  try {
    if (realpathSync(path) !== path) throw new Error('invalid');
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd);
    if (!before.isFile() || before.size < 1 || before.size > limit) throw new Error('invalid');
    const hash = createHash('sha256'),
      buffer = Buffer.alloc(65536);
    let offset = 0;
    while (offset < before.size) {
      const size = readSync(fd, buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (!size) throw new Error('invalid');
      hash.update(buffer.subarray(0, size));
      offset += size;
    }
    const after = fstatSync(fd);
    if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
      throw new Error('invalid');
    return hash.digest('hex');
  } catch {
    throw new Error('manual_claude_provenance_mismatch');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
export interface ManualClaudeOsSnapshot {
  started_at: string;
  command: string;
  mapped_executable_paths: readonly string[];
}
/** Qualification-only macOS reader for one explicitly selected process. It
 * invokes fixed OS metadata tools, never Claude or a user-configured command.
 * No transcript, process environment, prompt or credentials are read/exported.
 * Current ps second precision requires launching after the ticket's next second. */
export function readManualClaudeProcess(
  pid: number,
  input: ManualClaudeInvocation,
  trustedInspect?: (pid: number) => ManualClaudeOsSnapshot,
  trustedHash?: (path: string, limit: number) => string
): ManualClaudeProcessObservation {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('manual_claude_provenance_mismatch');
  const handoff = manualClaudeHandoff(input);
  // Flattened ps arguments cannot unambiguously represent paths with whitespace.
  if ([input.binary.path, input.settings_path, input.instructions_path, input.empty_mcp_path].some(path => /\s/.test(path)))
    throw new Error('manual_claude_process_reader_unsupported');
  const inspect =
    trustedInspect ??
    ((selectedPid: number) => {
      if (process.platform !== 'darwin') throw new Error('manual_claude_process_reader_unsupported');
      const command = (args: string[]) =>
        execFileSync('/bin/ps', ['-p', String(selectedPid), ...args], {
          encoding: 'utf8',
          timeout: 1000,
          maxBuffer: 8192,
          env: { ...process.env, LC_ALL: 'C' }
        }).trim();
      const started = command(['-o', 'lstart=']);
      const argv = command(['-ww', '-o', 'command=']);
      const mapped = execFileSync('/usr/sbin/lsof', ['-a', '-p', String(selectedPid), '-d', 'txt', '-Fn'], {
        encoding: 'utf8',
        timeout: 1000,
        maxBuffer: 65536
      });
      return {
        started_at: new Date(started).toISOString(),
        command: argv,
        mapped_executable_paths: mapped
          .split('\n')
          .filter(line => line.startsWith('n'))
          .map(line => line.slice(1))
      };
    });
  try {
    const before = inspect(pid);
    if (before.command !== [input.binary.path, ...handoff.argv].join(' ') || !before.mapped_executable_paths.includes(input.binary.path))
      throw new Error('manual_claude_provenance_mismatch');
    const hash = trustedHash ?? boundedFileHash;
    const result = {
      pid,
      started_at: before.started_at,
      binary_path: input.binary.path,
      binary_hash: hash(input.binary.path, 512 * 1048576),
      argv: handoff.argv,
      settings_hash: hash(input.settings_path, 65536),
      instructions_hash: hash(input.instructions_path, 32768)
    };
    const after = inspect(pid);
    if (after.command !== before.command || after.started_at !== before.started_at || !after.mapped_executable_paths.includes(input.binary.path))
      throw new Error('manual_claude_provenance_mismatch');
    return result;
  } catch {
    throw new Error('manual_claude_provenance_mismatch');
  }
}
export function verifyManualClaudeProcess(input: ManualClaudeInvocation, observed: ManualClaudeProcessObservation, at: string) {
  const handoff = manualClaudeHandoff(input);
  const stamp = TimestampSchema.safeParse(observed.started_at);
  TimestampSchema.parse(at);
  if (
    !Number.isSafeInteger(observed.pid) ||
    observed.pid < 1 ||
    !stamp.success ||
    Date.parse(stamp.data) < Date.parse(handoff.invocation.issued_at) ||
    Date.parse(stamp.data) > Date.parse(at) ||
    observed.binary_path !== handoff.invocation.binary.path ||
    observed.binary_hash !== handoff.invocation.binary.sha256 ||
    observed.settings_hash !== handoff.invocation.settings_hash ||
    observed.instructions_hash !== handoff.invocation.instructions_hash ||
    sha256(JSON.stringify(observed.argv)) !== handoff.argv_hash
  )
    throw new Error('manual_claude_provenance_mismatch');
  return {
    ticket_id: handoff.invocation.ticket_id,
    native_session_id: handoff.invocation.native_session_id,
    process_identity: sha256(JSON.stringify([observed.pid, stamp.data, observed.binary_hash])),
    argv_hash: handoff.argv_hash,
    invocation_evidence: 'native_process_flags_and_files_observed',
    native_context_evidence: 'unverified',
    actual_use_evidence: 'unavailable'
  };
}
export interface ManualClaudeReceiverOptions {
  scope: CandidateScope;
  generation: number;
  invocation: ManualClaudeInvocation;
  clock: Clock;
  durationMs: number;
  /** Only a trusted native metadata reader may supply process proof. Its actual
   * implementation/permissions require separate native qualification. */
  readProcess: (expected: ManualClaudeInvocation) => ManualClaudeProcessObservation | null;
  onVerifiedConnection?: (evidence: ReturnType<typeof verifyManualClaudeProcess> & { verified_at: string }) => void;
}

/** Test/qualification candidate only, not a production adapter or public flag.
 * Reuse the exact parent-only hook/log/trace receiver; never spawn a native CLI.
 * Synthetic workspace/sessions are mandatory until actual manual qualification. */
export function createManualClaudeReceiver(store: Store, options: ManualClaudeReceiverOptions) {
  let invocation = ManualClaudeInvocationSchema.parse(options.invocation);
  if (!store.get('SELECT 1 FROM comparison_workspace_scope') || options.scope.sessions.length !== 1) throw new Error('manual_claude_candidate_only');
  const root = options.scope.sessions[0]!;
  if (
    root.parentSessionId !== null ||
    root.nativeSessionId !== invocation.native_session_id ||
    root.processId === null ||
    store.get<{ product: string; product_version: string }>('SELECT product,product_version FROM sessions WHERE id=?', [root.sessionId])?.product !==
      'synthetic'
  )
    throw new Error('manual_claude_candidate_only');
  let verified: (ReturnType<typeof verifyManualClaudeProcess> & { verified_at: string }) | null = null;
  const coordinator = new ClaudeProbeCoordinator(store, {
    rootScope: options.scope,
    generation: options.generation,
    startedAt: invocation.issued_at,
    model: invocation.model,
    effort: invocation.effort,
    clock: options.clock,
    child: { sessionId: randomUUID(), sourceId: randomUUID(), agentType: 'manual-child-forbidden' },
    reserveChild() {
      throw new Error('manual_claude_child_forbidden');
    },
    workflow: {
      synthetic: true,
      childEnabled: false,
      requestLimit: manualRecipe.plannedRequests,
      durationMs: options.durationMs,
      assertActive() {},
      onChildBound() {
        throw new Error('manual_claude_child_forbidden');
      },
      observationStartedAt: () => verified?.verified_at ?? null
    }
  });
  let reason: string | null = null;
  const verify = () => {
    const state = coordinator.state();
    if (!state.rootStarted || state.lastSequence < 0) throw new Error('claude_probe_not_ready');
    try {
      const observed = options.readProcess(invocation);
      if (observed === null) return false;
      const at = options.clock();
      const proof = verifyManualClaudeProcess(invocation, observed, at);
      if (verified && verified.process_identity !== proof.process_identity) throw new Error('manual_claude_provenance_mismatch');
      if (!verified) {
        const evidence = { ...proof, verified_at: at };
        options.onVerifiedConnection?.(evidence);
        verified = evidence;
      }
      return true;
    } catch {
      reason = 'manual_claude_provenance_mismatch';
      try {
        recordObservationGap(
          store,
          options.scope.taskId,
          root.sessionId,
          verified?.verified_at ?? invocation.issued_at,
          options.clock(),
          'source_error',
          options.clock()
        );
      } catch {
        /* Revocation/deletion must not restore data. */
      }
      coordinator.revoke();
      throw new Error('manual_claude_provenance_mismatch');
    }
  };
  const receiver: ClaudeProbeGatewayCoordinator = {
    exporterHeaders: () => coordinator.exporterHeaders(),
    authorizeRequest: token => coordinator.authorizeRequest(token),
    authorizeTraceRequest(token) {
      coordinator.authorizeRequest(token);
      if (!verify()) throw new Error('claude_probe_not_ready');
      coordinator.authorizeTraceRequest(token);
    },
    acceptHook(token, read) {
      coordinator.acceptHook(token, read);
      if (coordinator.state().rootStarted && coordinator.state().lastSequence >= 0) verify();
    },
    ingestLogs(token, read) {
      const result = coordinator.ingestLogs(token, read);
      if (coordinator.state().rootStarted && coordinator.state().lastSequence >= 0) verify();
      return result;
    },
    ingestTraces(token, read) {
      coordinator.authorizeRequest(token);
      if (!verify()) throw new Error('claude_probe_not_ready');
      coordinator.authorizeTraceRequest(token);
      return coordinator.ingestTraces(token, read);
    },
    revoke: () => coordinator.revoke()
  };
  let rebound = false;
  return {
    receiver,
    /** One private preparation bind, before any source starts. Resolve the
     * gateway/credential/settings dependency without mutating native identity. */
    bindPreparedInvocation(input: ManualClaudeInvocation) {
      const next = ManualClaudeInvocationSchema.parse(input);
      const state = coordinator.state();
      if (
        rebound ||
        state.rootStarted ||
        state.lastSequence >= 0 ||
        verified ||
        JSON.stringify([next.ticket_id, next.issued_at, next.native_session_id, next.binary, next.model, next.effort]) !==
          JSON.stringify([invocation.ticket_id, invocation.issued_at, invocation.native_session_id, invocation.binary, invocation.model, invocation.effort])
      )
        throw new Error('manual_claude_preparation_locked');
      invocation = next;
      rebound = true;
      return manualClaudeHandoff(next);
    },
    state: () => ({
      profile_status: manualRecipe.status,
      first_verified_at: verified?.verified_at ?? null,
      invocation_evidence: verified?.invocation_evidence ?? 'unverified',
      native_context_evidence: 'unverified',
      tool_use_evidence: 'unavailable',
      complete_cost: null,
      reason_code: reason,
      ...coordinator.state()
    }),
    /** Transport only. No native launch, transcript discovery or hook activation. */
    openGateway: () => startClaudeProbeGateway(receiver, { durationMs: options.durationMs })
  };
}

/** Non-launching preparation for the one bounded manual print-CLI candidate.
 * Calling this for native qualification needs separately approved ephemeral
 * hook/settings/loopback permission. No native run()/spawn handle is returned. */
export async function prepareManualClaudeCandidate(
  store: Store,
  options: Omit<ManualClaudeReceiverOptions, 'invocation' | 'readProcess'> & {
    ticket: Pick<ManualClaudeInvocation, 'ticket_id' | 'issued_at' | 'native_session_id' | 'binary' | 'model' | 'effort'>;
    workspace: string;
    cwd: string;
    mediatorPath: string;
    instructions: string;
    trustedReadProcess?: (expected: ManualClaudeInvocation) => ManualClaudeProcessObservation;
  }
) {
  verifyClaudeProbeBinary(options.ticket.binary);
  const project = store.get<{ local_root: string | null }>('SELECT local_root FROM projects WHERE id=?', [options.scope.projectId])?.local_root;
  if (
    project !== options.cwd ||
    realpathSync(options.cwd) !== options.cwd ||
    options.workspace === options.cwd ||
    options.workspace.startsWith(options.cwd + sep) ||
    Buffer.byteLength(options.instructions) > 32768
  )
    throw new Error('manual_claude_candidate_scope');
  mkdirSync(options.workspace, { recursive: true, mode: 0o700 });
  if (realpathSync(options.workspace) !== options.workspace || !lstatSync(options.workspace).isDirectory() || (lstatSync(options.workspace).mode & 0o077) !== 0)
    throw new Error('manual_claude_candidate_scope');
  const placeholder = {
    ...options.ticket,
    settings_path: join(options.workspace, 'pending-settings.json'),
    settings_hash: '0'.repeat(64),
    instructions_path: join(options.workspace, 'pending-instructions.md'),
    instructions_hash: sha256(options.instructions),
    empty_mcp_path: join(options.workspace, 'pending-mcp.json')
  };
  let selectedPid: number | null = null;
  const candidate = createManualClaudeReceiver(store, {
    ...options,
    invocation: placeholder,
    readProcess: options.trustedReadProcess ?? (expected => (selectedPid === null ? null : readManualClaudeProcess(selectedPid, expected)))
  });
  const gateway = await candidate.openGateway();
  let mediator: Awaited<ReturnType<typeof prepareClaudeProbeHookMediator>> | undefined;
  let files: Awaited<ReturnType<typeof prepareClaudeNativeProbe>> | undefined;
  const dispose = async () => {
    candidate.receiver.revoke();
    await gateway.close();
    await files?.dispose();
    await mediator?.dispose();
  };
  try {
    mediator = await prepareClaudeProbeHookMediator(options.workspace, gateway.endpoint, candidate.receiver.exporterHeaders(), options.mediatorPath);
    files = await prepareClaudeNativeProbe(
      {
        workspace: options.workspace,
        binary: options.ticket.binary,
        destination: { endpoint: gateway.endpoint, headers: candidate.receiver.exporterHeaders(), processId: options.scope.sessions[0]!.processId! },
        nativeSessionId: options.ticket.native_session_id,
        model: options.ticket.model,
        effort: options.ticket.effort,
        hookCommand: mediator.hookCommand
      },
      {
        model: options.ticket.model,
        effort: options.ticket.effort,
        permissions: 'read-only',
        instructions: options.instructions,
        maxTurns: 1,
        requestLimit: manualRecipe.plannedRequests,
        durationMs: options.durationMs,
        maxBudgetUsd: Number(manualRecipe.estimatedUsd),
        pinnedProbeCandidate: true
      }
    );
    const instructionPath = files.argv[files.argv.indexOf('--append-system-prompt-file') + 1]!;
    const mcpPath = files.argv[files.argv.indexOf('--mcp-config') + 1]!;
    const handoff = candidate.bindPreparedInvocation({
      ...options.ticket,
      settings_path: files.settingsPath,
      settings_hash: boundedFileHash(files.settingsPath, 65536),
      instructions_path: instructionPath,
      instructions_hash: boundedFileHash(instructionPath, 32768),
      empty_mcp_path: mcpPath
    });
    return {
      handoff,
      state: candidate.state,
      selectProcess(pid: number) {
        if (!Number.isSafeInteger(pid) || pid < 1 || selectedPid !== null) throw new Error('manual_claude_process_selection_invalid');
        selectedPid = pid;
      },
      dispose
    };
  } catch {
    await dispose();
    throw new Error('manual_claude_candidate_prepare_failed');
  }
}
