import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, readdirSync, statSync } from 'node:fs';
import { ClaudeProbeCoordinator } from './claude-probe-coordinator.js';
import { prepareClaudeNativeProbe, reserveClaudeProbeAction } from './claude-native-probe.js';
import type { ClaudeNativeProbeOptions, ClaudeWorkflowInvocation } from './claude-native-probe.js';
import { prepareClaudeProbeHookMediator } from './claude-probe-hook-mediator.js';
import { startClaudeProbeGateway, type ClaudeProbeStopDiagnostic } from './claude-probe-gateway.js';
import type { CandidateScope } from './nested-candidate.js';
import { claudeProbeProductVersion, isClaudeWorkflowProductVersion } from './claude-workflow-versions.js';
import { utcNow } from './lifecycle.js';
import type { Store } from './store.js';

export interface ClaudeProbeSupervisorOptions {
  store: Store; rootScope: CandidateScope;
  child: { sessionId: string; sourceId: string; agentType: string }; generation: number;
  workspace: string; cwd: string; binary: ClaudeNativeProbeOptions['binary']; mediatorPath: string;
  /** A test/caller may shorten the window, never extend the maximum: 120 s for the
   * internal probe, one hour for an assigned workflow invocation. */
  durationMs?: number;
  workflow?: ClaudeWorkflowInvocation & {synthetic:boolean;prompt:string;assertActive:()=>void;onChildBound:(sessionId:string)=>void;stopRequested:()=>boolean};
}
/** The default keeps the internal probe on its pinned version; workflow callers pass the workflow list. */
export function verifyClaudeProbeBinary(binary: ClaudeNativeProbeOptions['binary'], versions: readonly string[] = [claudeProbeProductVersion]): void {
  let descriptor: number | undefined;
  try {
    if (!versions.includes(binary.version) || !/^[a-f0-9]{64}$/.test(binary.sha256) || realpathSync(binary.path) !== binary.path) throw new Error('invalid');
    descriptor = openSync(binary.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size < 1 || before.size > 512 * 1024 * 1024) throw new Error('invalid');
    const bytes = Buffer.alloc(before.size); let offset = 0;
    while (offset < bytes.length) { const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset); if (!count) throw new Error('invalid'); offset += count; }
    const after = fstatSync(descriptor);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
        createHash('sha256').update(bytes).digest('hex') !== binary.sha256) throw new Error('invalid');
  } catch { throw new Error('claude_probe_executable_mismatch'); }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}
/** Preparation starts only a local authenticated gateway and creates transient
 * probe files. run() is a separate actual product/model boundary: never call it
 * without specific user approval for the run and per-invocation tracing settings.
 * No authentication lookup, login, update or transcript read exists here.
 */
export async function prepareClaudeProbeSupervisor(input: ClaudeProbeSupervisorOptions) {
  const options = { ...input, rootScope: structuredClone(input.rootScope), binary: { ...input.binary }, child: { ...input.child } };
  const durationMs = options.durationMs ?? 120000;
  if (process.platform === 'win32' || Number(process.versions.node.split('.')[0]) !== 24 ||
      !Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > (options.workflow ? 3600000 : 120000)) throw new Error('claude_probe_invalid_supervisor');
  if(options.workflow&&!isClaudeWorkflowProductVersion(options.binary.version))throw new Error('claude_probe_executable_mismatch');
  const versions = options.workflow ? [options.binary.version] : [claudeProbeProductVersion];
  verifyClaudeProbeBinary(options.binary, versions);
  if(options.workflow&&!options.workflow.synthetic)verifyClaudeWorkflowVersion(options.binary,options.workspace);
  const productVersion = options.binary.version;
  const cwd = realpathSync(options.cwd);
  const root = options.rootScope.sessions[0];
  if (cwd !== options.cwd || (!options.workflow && readdirSync(cwd).length !== 0) || !root || options.rootScope.sessions.length !== 1 ||
      root.processId === null || options.store.get<{ local_root: string }>('SELECT local_root FROM projects WHERE id=?', [options.rootScope.projectId])?.local_root !== cwd) throw new Error('claude_probe_supervisor_scope');
  const startedAt = utcNow(); const until = Date.now() + durationMs;
  const coordinator = new ClaudeProbeCoordinator(options.store, { rootScope: options.rootScope, child: options.child,
    generation: options.generation, startedAt, productVersion, model: options.workflow ? options.workflow.model : 'claude-sonnet-5-5', effort: options.workflow ? options.workflow.effort : 'high', clock: utcNow,
    ...(options.workflow ? {workflow:{synthetic:options.workflow.synthetic,childEnabled:options.workflow.childRuntime !== undefined,childRuntime:options.workflow.childRuntime,requestLimit:options.workflow.requestLimit,durationMs,assertActive:options.workflow.assertActive,onChildBound:options.workflow.onChildBound,
      ...(options.workflow.session === 'resume' ? {startSource:'resume' as const} : {})}} : {}),
    reserveChild: () => reserveClaudeProbeAction(options.workspace, 'child', root.processId!) });
  const token = coordinator.exporterHeaders()['x-harness-delta-token']!;
  const abort = new AbortController(); let stopReason: string | null = null;
  let stopDiagnostic: ClaudeProbeStopDiagnostic | null = null;
  const gateway = await startClaudeProbeGateway(coordinator, { durationMs,
    onStop: (reason, diagnostic) => { stopDiagnostic = diagnostic;
      stopReason = reason === 'deadline' ? 'claude_probe_deadline' : 'claude_probe_observation_stopped'; abort.abort(); } });
  let mediator: Awaited<ReturnType<typeof prepareClaudeProbeHookMediator>> | undefined;
  let probe: Awaited<ReturnType<typeof prepareClaudeNativeProbe>> | undefined;
  let disposed = false; let reserved = false;
  const dispose = async () => {
    if (disposed) return; disposed = true; abort.abort(); coordinator.revoke();
    await gateway.close(); await probe?.dispose(); await mediator?.dispose();
  };
  try {
    mediator = await prepareClaudeProbeHookMediator(options.workspace, gateway.endpoint, coordinator.exporterHeaders(), options.mediatorPath);
    probe = await prepareClaudeNativeProbe({ workspace: options.workspace, binary: options.binary,
      destination: { endpoint: gateway.endpoint, headers: coordinator.exporterHeaders(), processId: root.processId },
      nativeSessionId: root.nativeSessionId, model: 'claude-sonnet-5-5', effort: 'high', hookCommand: mediator.hookCommand }, options.workflow);
  } catch { await dispose(); throw new Error('claude_probe_supervisor_prepare_failed'); }
  const prepared = probe;
  const run = async () => {
    if (reserved) throw new Error('claude_probe_already_reserved');
    verifyClaudeProbeBinary(options.binary, versions);
  if(options.workflow&&!options.workflow.synthetic)verifyClaudeWorkflowVersion(options.binary,options.workspace);
    const binaryIdentity=claudeBinaryIdentity(options.binary.path);
    coordinator.authorizeRequest(token);
    if (disposed || realpathSync(options.cwd) !== cwd || (!options.workflow && readdirSync(cwd).length !== 0) || Date.now() >= until) throw new Error('claude_probe_deadline');
    reserveClaudeProbeAction(options.workspace, 'launch', root.processId!); reserved = true;
    type Status = 'completed' | 'failed' | 'launch_failed' | 'timed_out' | 'stopped';
    try {
      const native = await new Promise<{ status: Status; exitCode: number | null }>(resolve => {
        const child = spawn(options.binary.path, [...prepared.argv], { cwd, detached: true, shell: false, stdio: ['pipe', 'ignore', 'ignore'] });
        let finishing = false;
        const group = (signal: NodeJS.Signals) => { if (child.pid !== undefined) { try { process.kill(-child.pid, signal); } catch { /* Already gone. */ } } };
        const finish = (status: Status, exitCode: number | null) => {
          if (finishing) return; finishing = true; clearTimeout(timer); clearInterval(scopeTimer); abort.signal.removeEventListener('abort', stopped);
          group('SIGTERM');
          // Root exit does not imply descendants exited. Always force the group.
          setTimeout(() => { group('SIGKILL'); child.stdin?.destroy(); resolve({ status, exitCode }); }, 50);
        };
        const stopped = () => { group('SIGKILL'); finish(stopReason === 'claude_probe_deadline' ? 'timed_out' : 'stopped', null); };
        const scopeTimer = setInterval(() => {
          if (!options.workflow) return;
          try{if(claudeBinaryIdentity(options.binary.path)!==binaryIdentity)throw new Error('changed');}
          catch{stopReason='claude_probe_executable_mismatch';abort.abort();return;}
          try { options.workflow.assertActive(); if(options.workflow.stopRequested()){stopReason='stop_requested';abort.abort();} }
          catch {stopReason='workflow_scope_revoked';abort.abort();}
        },25);
        const timer = setTimeout(() => { stopReason = 'claude_probe_deadline'; group('SIGKILL'); finish('timed_out', null); }, Math.max(1, until - Date.now()));
        abort.signal.addEventListener('abort', stopped, { once: true });
        child.stdin?.on('error', () => { /* No prompt/pipe error is retained. */ });
        child.once('error', () => finish('launch_failed', null));
        child.once('exit', code => finish(code === 0 ? 'completed' : 'failed', code));
        if (abort.signal.aborted) stopped();
        else child.stdin?.end(options.workflow?.prompt ?? 'Synthetic qualification only. Use the qualification-child Agent exactly once; ask for a short acknowledgment, wait for it, then reply briefly. No other tools, agents, retries or content.\n');
      });
      const state = coordinator.state();
      const terminal = options.workflow
        ? state.rootStarted && state.sessionEnded && (!state.childBound || state.childStopped) && state.rootRequests > 0 && !state.revoked
        : state.rootStarted && state.childBound && state.childStopped && state.sessionEnded && state.requestsInserted === 3 && state.rootRequests === 2 && state.childRequests === 1 && !state.revoked;
      return { status: native.status === 'completed' && !terminal ? 'failed' as const : native.status,
        reason: stopReason ?? (native.status === 'completed' && !terminal ? 'claude_probe_terminal_missing' : native.status === 'completed' ? null : 'claude_probe_native_failed'),
        exitCode: native.exitCode, state, diagnostic: stopDiagnostic, nativeSchemaQualified: false, completeCost: null, hardBillingBound: null,
        limitations: ['subscription_usage_may_be_consumed', 'cli_usd_budget_is_an_estimate_not_a_subscription_cap', 'hooks_may_fail_open', 'in_flight_requests_and_delayed_exports_unbounded'] };
    } finally { await dispose(); }
  };
  return { manifest: prepared.manifest, manifestPath: prepared.manifestPath, run, dispose };
}

/** Verify the declaration against the hashed executable with isolated home state. */
export function verifyClaudeWorkflowVersion(binary:ClaudeNativeProbeOptions['binary'],home:string):void {
  verifyClaudeProbeBinary(binary,[binary.version]);
  const result=spawnSync(binary.path,['--version'],{encoding:'utf8',timeout:10000,maxBuffer:4096,env:{PATH:process.env.PATH??'',HOME:home,CLAUDE_CONFIG_DIR:home},stdio:['ignore','pipe','ignore']});
  if(result.error||result.status!==0||result.stdout.trim()!==`${binary.version} (Claude Code)`)throw new Error('claude_probe_executable_mismatch');
  verifyClaudeProbeBinary(binary,[binary.version]);
}

function claudeBinaryIdentity(path:string):string {
  if(realpathSync(path)!==path)throw new Error('claude_probe_executable_mismatch');
  const st=statSync(path,{bigint:true});return [st.dev,st.ino,st.size,st.mtimeNs,st.ctimeNs].join(':');
}
