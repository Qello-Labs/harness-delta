/** Diagnostic utility only: no production adapter registration, executable, or native-log admission. */
import { closeSync, constants, existsSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs';
import { toolVersionRecipe } from '../../src/core/tool-version-profiles.js';
import { reduceExecStream } from './exec-stream.js';

export const diagnosticVersion = toolVersionRecipe('codex-historical-one-child-01600').version;
export const isolationArguments: readonly string[] = [
  '-c','mcp_servers.node_repl.enabled=false', '-c','mcp_servers.computer-use.enabled=false',
  '-c','plugins.unified-computer-use@openai-bundled.mcp_servers.cua_repl.enabled=false',
];
export interface Preflight {
  /** The caller must check the pinned executable reports exactly codex-cli 0.160.0. */
  versionMatches: boolean;
  configurationStable: boolean;
  globalInstructionBytes: number;
  mcpServerCount: number;
  otherInstructionOverrides: boolean;
  hooksConfigured: boolean;
  codexHomeSet: boolean;
}
// Diagnostic vocabulary from Codex rust-v0.160.0 exec/src/exec_events.rs.
// Recognition here does not grant permission to the stream guard.
const guardEventTypes = ['thread.started','turn.started','turn.completed','turn.failed','item.started','item.updated','item.completed','error'] as const;
const guardItemTypes = ['agent_message','reasoning','command_execution','file_change','mcp_tool_call','collab_tool_call','web_search','todo_list','error'] as const;
const guardReasons = {event_type:'unexpected_event',item_type:'unexpected_item',boundary_count:'repeated_boundary',json_parse:'invalid_json',stdout_bytes:'stdout_limit'} as const;
type GuardBranch = keyof typeof guardReasons;
type GuardEventType = typeof guardEventTypes[number] | 'unknown';
type GuardItemType = typeof guardItemTypes[number] | 'unknown';
export interface GuardDiagnostic {
  branch: GuardBranch;
  reason: typeof guardReasons[GuardBranch];
  eventType: GuardEventType;
  itemType: GuardItemType;
  errorDiagnostic?: ErrorDiagnostic;
}
const guardEventType = (value:unknown):GuardEventType => typeof value === 'string' && guardEventTypes.includes(value as typeof guardEventTypes[number]) ? value as GuardEventType : 'unknown';
const guardItemType = (value:unknown):GuardItemType => typeof value === 'string' && guardItemTypes.includes(value as typeof guardItemTypes[number]) ? value as GuardItemType : 'unknown';
type ErrorCause = 'model_unsupported' | 'authentication' | 'authorization' | 'rate_limit' | 'invalid_request' | 'transport' | 'unknown';
type ErrorSource = 'item_message' | 'event_message' | 'turn_error_message';
const fieldStates = ['absent','present','invalid','oversized'] as const;
const limitations = ['none','missing_message','invalid_message','oversized_message','unrecognized_message','invalid_structure','ambiguous_evidence'] as const;
// Exact fixed renderings from pinned rust-v0.160.0 protocol/src/error.rs and
// login/src/auth/manager.rs. Dynamic body/details/suffixes are never accepted.
const errorTemplates = {
  refresh_token: {cause:'authentication',messages:[
    'Your access token could not be refreshed. Please log out and sign in again.',
    'Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.',
    'Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.',
    'Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.',
    'Your access token could not be refreshed because you have since logged out or signed in to another account. Please sign in again.',
  ]},
  context_window: {cause:'invalid_request',messages:["Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying."]},
  request_timeout: {cause:'transport',messages:['request timed out']},
  rate_limit_empty: {cause:'rate_limit',messages:['rate limit exceeded: ']},
} as const;
// Wrapped-message codes are separately labelled, never claimed as native exec fields.
// model_not_supported preserves the existing exec-stream.ts local recognition contract;
// the other codes are pinned codex-api/src/sse/responses_error.rs mappings.
const errorCodes = {model_not_supported:'model_unsupported',rate_limit_exceeded:'rate_limit',slow_down:'rate_limit',context_length_exceeded:'invalid_request',invalid_prompt:'invalid_request'} as const;
const errorStatuses = {400:'invalid_request',401:'authentication',403:'authorization',408:'transport',429:'rate_limit'} as const;
interface ErrorDiagnostic {
  source: ErrorSource; cause: ErrorCause;
  evidenceKind: 'trusted_message' | 'structured_message' | 'none';
  messageState: typeof fieldStates[number]; codeState: typeof fieldStates[number]; statusState: typeof fieldStates[number];
  limitation: typeof limitations[number]; template?: keyof typeof errorTemplates;
  code?: keyof typeof errorCodes; status?: keyof typeof errorStatuses;
}
function errorSource(eventType:GuardEventType,itemType:GuardItemType):ErrorDiagnostic['source'] | null {
  if (eventType === 'error') return 'event_message';
  if (eventType === 'turn.failed') return 'turn_error_message';
  return eventType.startsWith('item.') && itemType === 'error' ? 'item_message' : null;
}
function structuredCause(code:unknown,status:unknown):ErrorCause | null {
  const c = typeof code === 'string' && Object.hasOwn(errorCodes,code) ? errorCodes[code as keyof typeof errorCodes] : null;
  const h = typeof status === 'number' && Object.hasOwn(errorStatuses,status) ? errorStatuses[status as keyof typeof errorStatuses] : null;
  if ((code !== undefined && c === null) || (status !== undefined && h === null)) return null;
  return c !== null && h !== null && c !== h && !(status === 400 && c === 'model_unsupported') ? 'unknown' : c ?? h;
}
function classifyErrorMessage(source:ErrorDiagnostic['source'],message:unknown):ErrorDiagnostic {
  const unknown = (limitation:ErrorDiagnostic['limitation'],messageState:ErrorDiagnostic['messageState'],codeState:ErrorDiagnostic['codeState'] = 'absent',statusState:ErrorDiagnostic['statusState'] = 'absent'):ErrorDiagnostic =>
    ({source,cause:'unknown',evidenceKind:'none',messageState,codeState,statusState,limitation});
  if (message === undefined) return unknown('missing_message','absent');
  if (typeof message !== 'string') return unknown('invalid_message','invalid');
  if (message.length > 2048 || Buffer.byteLength(message,'utf8') > 2048) return unknown('oversized_message','oversized');
  for (const template of Object.keys(errorTemplates) as (keyof typeof errorTemplates)[]) {
    const entry = errorTemplates[template];
    if ((entry.messages as readonly string[]).includes(message)) return {source,cause:entry.cause,evidenceKind:'trusted_message',template,messageState:'present',codeState:'absent',statusState:'absent',limitation:'none'};
  }
  if (!message.startsWith('{')) return unknown('unrecognized_message','present');
  try {
    const outer = object(JSON.parse(message) as unknown); const fields = object(outer.error);
    // Only these one-layer code/status locations are evidence. Other fields never
    // leave memory and are not searched recursively. Native exec has message only.
    if (!Object.hasOwn(outer,'error') || (Object.keys(fields).length === 0)) return unknown('invalid_structure','present');
    const codeState = Object.hasOwn(fields,'code') ? 'present' : 'absent';
    const statusState = Object.hasOwn(fields,'status') || Object.hasOwn(outer,'status') ? 'present' : 'absent';
    if (Object.hasOwn(fields,'status') && Object.hasOwn(outer,'status') && fields.status !== outer.status) return unknown('ambiguous_evidence','present',codeState,statusState);
    const status = Object.hasOwn(fields,'status') ? fields.status : outer.status;
    const cause = structuredCause(fields.code,status);
    if (cause === null) return unknown('invalid_structure','present',codeState === 'present' ? 'invalid' : 'absent',statusState === 'present' ? 'invalid' : 'absent');
    if (cause === 'unknown') return unknown('ambiguous_evidence','present',codeState,statusState);
    return {source,cause,evidenceKind:'structured_message',messageState:'present',codeState,statusState,limitation:'none',
      ...(codeState === 'present' ? {code:fields.code as keyof typeof errorCodes} : {}),...(statusState === 'present' ? {status:status as keyof typeof errorStatuses} : {})};
  } catch {return unknown('invalid_structure','present');}
}
export function makeGuardDiagnostic(branch:GuardBranch,eventType:unknown = undefined,itemType:unknown = undefined,message:unknown = undefined):GuardDiagnostic {
  const event = guardEventType(eventType); const item = guardItemType(itemType); const source = errorSource(event,item);
  return {branch,reason:guardReasons[branch],eventType:event,itemType:item,...(source === null ? {} : {errorDiagnostic:classifyErrorMessage(source,message)})};
}
function projectErrorDiagnostic(value:unknown,source:ErrorDiagnostic['source']) {
  const raw = object(value);
  if (raw.source !== source || !fieldStates.includes(raw.messageState as typeof fieldStates[number]) ||
    !fieldStates.includes(raw.codeState as typeof fieldStates[number]) || !fieldStates.includes(raw.statusState as typeof fieldStates[number]) ||
    !limitations.includes(raw.limitation as typeof limitations[number])) return null;
  if (raw.evidenceKind === 'trusted_message') {
    if (typeof raw.template !== 'string' || !Object.hasOwn(errorTemplates,raw.template) || raw.cause !== errorTemplates[raw.template as keyof typeof errorTemplates].cause ||
      raw.messageState !== 'present' || raw.codeState !== 'absent' || raw.statusState !== 'absent' || raw.limitation !== 'none' || Object.hasOwn(raw,'code') || Object.hasOwn(raw,'status')) return null;
  } else if (raw.evidenceKind === 'structured_message') {
    if (raw.messageState !== 'present' || raw.limitation !== 'none' || Object.hasOwn(raw,'template') ||
      !['present','absent'].includes(String(raw.codeState)) || !['present','absent'].includes(String(raw.statusState)) ||
      (raw.codeState === 'present') !== Object.hasOwn(raw,'code') || (raw.statusState === 'present') !== Object.hasOwn(raw,'status') ||
      (raw.codeState === 'present' && typeof raw.code !== 'string') || (raw.statusState === 'present' && typeof raw.status !== 'number')) return null;
    const cause = structuredCause(raw.code,raw.status);
    if (cause === null || cause === 'unknown' || cause !== raw.cause) return null;
  } else if (raw.evidenceKind === 'none') {
    const expectedState = {missing_message:'absent',invalid_message:'invalid',oversized_message:'oversized',unrecognized_message:'present',invalid_structure:'present',ambiguous_evidence:'present'} as const;
    if (raw.cause !== 'unknown' || raw.limitation === 'none' || raw.messageState !== expectedState[raw.limitation as keyof typeof expectedState] ||
      Object.hasOwn(raw,'template') || Object.hasOwn(raw,'code') || Object.hasOwn(raw,'status')) return null;
    if (!['invalid_structure','ambiguous_evidence'].includes(String(raw.limitation)) && (raw.codeState !== 'absent' || raw.statusState !== 'absent')) return null;
  } else return null;
  return {source,cause:raw.cause,evidence_kind:raw.evidenceKind,message_state:raw.messageState,code_state:raw.codeState,status_state:raw.statusState,limitation:raw.limitation,
    ...(raw.evidenceKind === 'trusted_message' ? {template:raw.template} : {}),
    ...(raw.evidenceKind === 'structured_message' && raw.codeState === 'present' ? {code:raw.code} : {}),
    ...(raw.evidenceKind === 'structured_message' && raw.statusState === 'present' ? {status:raw.status} : {})};
}
/** Validate evidence relationships and explicitly project enum fields; never serialize a supplied object. */
function projectGuardDiagnostic(value:unknown) {
  const raw = object(value);
  if (typeof raw.branch !== 'string' || !Object.hasOwn(guardReasons,raw.branch)) return null;
  const branch = raw.branch as GuardBranch;
  if (raw.reason !== guardReasons[branch]) return null;
  const event = guardEventType(raw.eventType); const item = guardItemType(raw.itemType); const source = errorSource(event,item);
  return {branch,reason:guardReasons[branch],event_type:event,item_type:item,
    ...(source === null ? {} : {error_diagnostic:projectErrorDiagnostic(raw.errorDiagnostic,source)})};
}
export interface DiagnosticDeps {
  preflight(): Preflight | Promise<Preflight>;
  /** Caller owns a new empty private directory outside the repository and its cleanup. */
  createFixture(): string;
  /** Caller must pin the binary, preserve conformance env filtering, enforce 180s, and never retry. */
  spawn: (args: readonly string[], cwd: string, resumeWarningContext?: ResumeWarningContext) => Promise<{code:number|null;timedOut:boolean;spawnError:boolean;stdout:string;streamStopped?:boolean;guardDiagnostic?:unknown}>;
}
const stages = [
  ['gpt-6-luna','low','ready',false], ['gpt-5.6-luna','low','again',true],
  ['gpt-6-luna','medium','done',true], ['gpt-6-luna','low','ready',false],
  ['gpt-6-luna','low','again',true],
] as const;
export function diagnosticArguments(index: number, sessionId: string | null): string[] {
  const stage = stages[index];
  if (!Number.isInteger(index) || stage === undefined) throw new Error('attempt_cap');
  const [model,effort,word,resume] = stage;
  if (resume && (sessionId === null || !/^[0-9a-f-]{36}$/.test(sessionId))) throw new Error('scope_required');
  return ['exec','--json','--skip-git-repo-check',
    ...(resume ? ['-c','sandbox_mode="read-only"'] : ['--sandbox','read-only']),
    '--model',model,'-c',`model_reasoning_effort="${effort}"`,
    ...(resume ? ['resume',sessionId!] : []), `Reply with exactly one word: ${word}`];
}
/** Explicit previous-model evidence for this one approved resume invocation. */
export interface ResumeWarningContext {
  sessionId: string;
  previousModel: 'gpt-6-luna' | 'gpt-5.6-luna';
  currentModel: 'gpt-6-luna' | 'gpt-5.6-luna';
}
/** Pinned core/session/mod.rs Warning -> exec JSONL item.completed(ErrorItem).
 * Both the streaming guard and final inspection use the same exact recognition.
 * This permits no generic warning or error exemption and retains no message body.
 */
export function createResumeWarningGuard(args:readonly string[],context?:ResumeWarningContext) {
  const c = object(context);
  const stage = c.previousModel === 'gpt-6-luna' && c.currentModel === 'gpt-5.6-luna' ? 1 :
    c.previousModel === 'gpt-5.6-luna' && c.currentModel === 'gpt-6-luna' ? 2 : null;
  const execAt = args.indexOf('exec');
  const expected = stage !== null && typeof c.sessionId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(c.sessionId)
    ? diagnosticArguments(stage,c.sessionId) : null;
  const prefixMatches = execAt === 0 || (execAt === isolationArguments.length &&
    isolationArguments.every((value,index) => args[index] === value));
  const invocationMatches = expected !== null && prefixMatches && args.length - execAt === expected.length &&
    expected.every((value,index) => args[execAt+index] === value);
  const message = invocationMatches ? `This session was recorded with model \`${String(c.previousModel)}\` but is resuming with \`${String(c.currentModel)}\`. Consider switching back to \`${String(c.previousModel)}\` as it may affect Codex performance.` : null;
  let threadStarts = 0; let threadMatches = false; let turnSeen = false; let count = 0;
  return {
    get count() {return count;},
    accept(event:Record<string,unknown>):boolean {
      if (event.type === 'thread.started') {threadStarts++; threadMatches = event.thread_id === c.sessionId;}
      if (event.type === 'turn.started' || event.type === 'turn.completed' || event.type === 'turn.failed') turnSeen = true;
      const item = object(event.item);
      if (message === null || threadStarts !== 1 || !threadMatches || turnSeen || count !== 0 ||
        event.type !== 'item.completed' || Object.keys(event).length !== 2 ||
        item.type !== 'error' || item.message !== message || Object.keys(item).length !== 3 ||
        typeof item.id !== 'string' || !/^item_[0-9]+$/.test(item.id)) return false;
      count++;
      return true;
    },
  };
}
const object = (x: unknown): Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x) ? x as Record<string,unknown> : {};
function safePreflight(p: Preflight): boolean {
  return p.versionMatches === true && p.configurationStable === true && p.globalInstructionBytes === 0 &&
    p.mcpServerCount === 0 && p.otherInstructionOverrides === false && p.hooksConfigured === false && p.codexHomeSet === false;
}
function inspectActivity(stdout:string,args:readonly string[],context?:ResumeWarningContext) {
  const warning = createResumeWarningGuard(args,context);
  let unexpected = false;
  for (const line of stdout.split('\n').filter(x => x.trim())) {
    let e:Record<string,unknown>;
    try {e = object(JSON.parse(line) as unknown);} catch {unexpected = true; break;}
    if (warning.accept(e)) continue;
    if (!['thread.started','turn.started','turn.completed','turn.failed','error','item.started','item.updated','item.completed'].includes(String(e.type)) ||
      (String(e.type).startsWith('item.') && !['agent_message','reasoning'].includes(String(object(e.item).type)))) {unexpected = true; break;}
  }
  return {unexpected,warningCounts:{resume_model_changed:warning.count}};
}
/**
 * One append-only ledger is the execution identity. A completed, failed, or interrupted
 * ledger can never resume. Exclusive creation also rejects concurrent starts. Increment
 * and fsync happen before every requested generation, including failed attempts.
 * Do not create another ledger to bypass a terminal result. No raw stdout is saved.
 */
export async function runDiagnostic(ledger: string, deps: DiagnosticDeps): Promise<string> {
  if (existsSync(ledger)) {
    try {
      const rows = readFileSync(ledger,'utf8').split('\n').filter(Boolean).map(x => object(JSON.parse(x) as unknown));
      return rows.some(x => x.kind === 'terminal') ? 'terminal_ledger' : 'interrupted_ledger';
    } catch { return 'invalid_ledger'; }
  }
  let fd: number;
  try {fd = openSync(ledger,constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,0o600);}
  catch {return 'ledger_unavailable';}
  const append = (record: unknown) => {writeSync(fd,JSON.stringify(record)+'\n'); fsyncSync(fd);};
  const terminal = (reason: string) => {append({kind:'terminal',reason}); return reason;};
  let sessionId: string | null = null;
  try {
    if (!safePreflight(await deps.preflight())) return terminal('isolation_blocked');
    let cwd = deps.createFixture();
    for (let index = 0; index < stages.length; index++) {
      if (!safePreflight(await deps.preflight())) return terminal('isolation_blocked');
      if (index === 3) {sessionId = null; cwd = deps.createFixture();}
      const args = diagnosticArguments(index,sessionId);
      const [model,effort,,resume] = stages[index]!;
      append({kind:'attempt',ordinal:index+1,model,effort,stage:resume ? 'resume' : 'initial',scope:index < 3 ? 'switch' : 'restart',fixture_cwd:cwd,started_at:new Date().toISOString()});
      // Previous model comes only from the preceding successful approved stage.
      const resumeWarningContext:ResumeWarningContext | undefined = resume && index > 0 && stages[index-1]![0] !== model
        ? {sessionId:sessionId!,previousModel:stages[index-1]![0],currentModel:model} : undefined;
      const result = await deps.spawn(args,cwd,resumeWarningContext);
      const activity = inspectActivity(result.stdout,args,resumeWarningContext);
      const parsed = reduceExecStream(result.stdout);
      append({kind:'process_outcome',ordinal:index+1,exit_code:result.code,timed_out:result.timedOut,spawn_error:result.spawnError,stream_stopped:result.streamStopped === true,guard_diagnostic:result.streamStopped === true ? projectGuardDiagnostic(result.guardDiagnostic) : null,failure_reasons:parsed.summary.failureReasons,event_counts:parsed.summary.types,unparsed:parsed.summary.unparsed,warning_counts:activity.warningCounts});
      if (result.streamStopped) return terminal('unexpected_activity');
      if (result.spawnError) return terminal('spawn_error');
      if (result.timedOut) return terminal('timeout');
      if (result.code !== 0) return terminal('nonzero_exit');

      if (parsed.summary.failureReasons.length) return terminal('product_error');
      if (parsed.summary.unparsed || activity.unexpected) return terminal('unexpected_activity');
      if (parsed.threadId === null || parsed.summary.turnCompleted !== 1 || parsed.summary.types['turn.started'] !== 1) return terminal('boundary_unknown');
      if (sessionId !== null && parsed.threadId !== sessionId) return terminal('thread_changed');
      sessionId ??= parsed.threadId;
      if (!safePreflight(await deps.preflight())) return terminal('isolation_blocked');
      // Exec counters are observed snapshots. Never difference/sum/deduplicate them
      // as cumulative usage without independent 0.160.0 semantic qualification.
      const u = parsed.usage;
      const counter = (n: number | null | undefined) => n !== undefined && n !== null && n >= 0 ? n : null;
      append({kind:'observation',ordinal:index+1,exited_at:new Date().toISOString(),session_id:sessionId,requested_model:model,requested_effort:effort,
        observed_model:null,observed_effort:null,semantics:'semantics_unknown',usage:u === null ? null : {
          input:counter(u.input),cached:counter(u.cached),output:counter(u.output),reasoning:counter(u.reasoning),cache_write:counter(u.cacheWrite),total:counter(u.totalTokens)},
        native_format:'BLOCKED',cost:'BLOCKED'});
    }
    return terminal('observed_semantics_unknown');
  } catch { return terminal('internal_error'); }
  finally {closeSync(fd);}
}
