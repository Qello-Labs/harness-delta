import { createHash } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { constants, closeSync, fstatSync, lstatSync, mkdtempSync, openSync, readSync, realpathSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { IdSchema, ModelSchema } from './contracts.js';
import { toolVersionIdentity, toolVersionRecipe } from './core/tool-version-profiles.js';
import { readSource, type SourceBytes } from './sources/collection.js';
import { parseCodexCandidateRollout } from './codex-candidate-rollout.js';
import { verifyExternalContext } from './workflow/external-session-context.js';
import {
  codexWorkflowProfileId,
  codexWorkflowChildProfileId,
  codexWorkflowRun,
  stopCodexWorkflow,
  type CodexWorkflowRun
} from './workflow/codex-workflow-journal.js';
import { resolveSourceCompatibility, assertCompatibilityAllowed, pinSessionCompatibility, invalidateCompatibility } from './source-compatibility.js';
import { putUsageWithEvidence, recordObservationGap, requireActiveScope } from './core/runtime-history.js';
import { bindConfigurationToSession } from './core/configuration-evidence.js';
import { checkCandidatePermissions } from './workflow/codex-candidate-permissions.js';
import { SourceFailure, sourceCategory } from './core/source-errors.js';
import { RuntimeEvidenceSchema } from './flexible-contracts.js';
import type { Store } from './store.js';
import type { WorkflowAdapter, WorkflowAdapterResult, WorkflowExecutionContext, WorkflowRuntime } from './workflow/task-workflow.js';

const pathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(p => isAbsolute(p) && resolve(p) === p && !/[\0\r\n]/.test(p));
const workflowRecipe = toolVersionRecipe('codex-workflow-01600');
if (workflowRecipe.kind !== 'codex_workflow') throw new Error('codex_qualification_scope_invalid');
const workflowImage = toolVersionIdentity(workflowRecipe.imageIdentity);
const workflowMaxImageBytes = z.number().parse(workflowImage.maxBytes);
export const CodexWorkflowExecutionSchema = z
  .strictObject({
    product_version: z
      .string()
      .refine(v => resolveSourceCompatibility('codex', v, 'codex_workflow', codexWorkflowProfileId) !== null)
      .default(workflowRecipe.version),
    run_id: IdSchema,
    operation: z.enum(['launch', 'resume', 'link', 'collect']),
    binary: z.strictObject({ path: pathSchema, sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
    codex_home: pathSchema,
    hook_recorder: pathSchema,
    prompt_file: pathSchema.optional(),
    sandbox: z.enum(['read-only', 'workspace-write']),
    timeout_ms: z.number().int().min(1000).max(3600000),
    project_trust: z.literal('untrusted').optional(),
    poll_ms: z.number().int().min(10).max(1000).default(250),
    session_id: z.uuid().optional(),
    source_path: pathSchema.optional(),
    direct_child: z.strictObject({ session_id: z.uuid(), source_path: pathSchema }).optional(),
    child_runtime: z.strictObject({ model: ModelSchema, effort: IdSchema }).optional()
  })
  .superRefine((v, c) => {
    if (v.operation !== 'launch' && !v.session_id) c.addIssue({ code: 'custom', message: 'explicit_session_required' });
    if (v.operation === 'link' && !v.source_path) c.addIssue({ code: 'custom', message: 'explicit_source_required' });
    if (['launch', 'resume'].includes(v.operation) && !v.prompt_file) c.addIssue({ code: 'custom', message: 'prompt_required' });
    if (v.operation === 'launch' && (v.session_id || v.source_path)) c.addIssue({ code: 'custom', message: 'launch_identity_is_hook_owned' });
    if (v.project_trust !== undefined && (v.operation !== 'launch' || v.child_runtime || v.direct_child))
      c.addIssue({ code: 'custom', message: 'untrusted_verification_requires_fresh_root_launch' });
    if (v.child_runtime && (!['launch', 'resume'].includes(v.operation) || v.direct_child || v.sandbox !== 'read-only'))
      c.addIssue({ code: 'custom', message: 'native_direct_child_launch_or_resume_read_only_required' });
    if (
      v.direct_child &&
      (!['link', 'collect'].includes(v.operation) || v.direct_child.session_id === v.session_id || v.direct_child.source_path === v.source_path)
    )
      c.addIssue({ code: 'custom', message: 'explicit_direct_child_link_or_collect_required' });
  });
type Execution = z.infer<typeof CodexWorkflowExecutionSchema>;
export const CodexWorkflowDiagnosticSchema = z.strictObject({
  stage: z.enum([
    'scope',
    'binding',
    'source_read',
    'source_continuity',
    'envelope',
    'root_header',
    'turn_context',
    'projection',
    'usage_insert',
    'hook',
    'process',
    'stdout'
  ]),
  code: z.enum([
    'unsupported_root_history',
    'invalid_root_identity',
    'invalid_root_ordinal',
    'invalid_json',
    'invalid_envelope',
    'source_changed',
    'unsupported_session',
    'runtime_mismatch',
    'scope_revoked',
    'candidate_invalid_metadata',
    'candidate_scope_mismatch',
    'candidate_unsupported_history',
    'candidate_conflict',
    'runtime_conflict',
    'scope_mismatch',
    'short_read',
    'unstable_read',
    'unsupported_source',
    'read_failed',
    'initial_source_incomplete',
    'deadline',
    'stop_requested',
    'hook_schema_invalid',
    'marker_mismatch',
    'unexpected_qualification_item',
    'qualification_output_invalid',
    'qualification_sender_mismatch',
    'qualification_receiver_mismatch',
    'qualification_receiver_missing',
    'qualification_child_unbound',
    'qualification_spawn_changed',
    'process_failed',
    'hook_missing',
    'binary_mismatch',
    'unknown'
  ]),
  event_kind: z.enum(['agent_message', 'collab_spawn', 'collab_wait', 'collab_close', 'reasoning', 'other_item', 'invalid_item']).optional()
});
export type CodexWorkflowDiagnostic = z.infer<typeof CodexWorkflowDiagnosticSchema>;
function safeDiagnostic(stage: CodexWorkflowDiagnostic['stage'], error: unknown): CodexWorkflowDiagnostic {
  let code: CodexWorkflowDiagnostic['code'] = 'unknown';
  try {
    if (error instanceof SyntaxError) code = 'invalid_json';
    else if (error instanceof SourceFailure) {
      const category = sourceCategory(error, 'read_failed');
      code = (['short_read', 'unstable_read', 'unsupported_source'] as const).find(x => x === category) ?? 'read_failed';
    } else if (error instanceof z.ZodError) code = stage === 'hook' ? 'hook_schema_invalid' : 'invalid_envelope';
    else if (error instanceof Error) code = CodexWorkflowDiagnosticSchema.shape.code.options.find(x => x === error.message) ?? 'unknown';
  } catch {
    /* Unknown getters/messages/causes are never retained. */
  }
  return CodexWorkflowDiagnosticSchema.parse({ stage, code });
}
function safeReason(error: unknown) {
  try {
    if (error instanceof Error && ['workflow_scope_revoked', 'inactive_scope', 'real_experiment_disabled'].includes(error.message)) return 'scope_revoked';
    return error instanceof Error
      ? ([
          'source_changed',
          'runtime_mismatch',
          'unsupported_session',
          'scope_revoked',
          'hook_missing',
          'process_failed',
          'binary_mismatch',
          'session_not_linked',
          'explicit_source_required',
          'stop_requested',
          'deadline',
          'initial_source_incomplete',
          'qualification_output_invalid',
          'qualification_marker_failed'
        ].find(x => x === error.message) ?? 'collection_failed')
      : 'collection_failed';
  } catch {
    return 'collection_failed';
  }
}
export const pinnedCodexWorkflowBinarySha = z.literal('112fae7a5a1223e673c8a1791d32338f37df8b527ff1159bb8adac6c4dbf1b4b').parse(workflowImage.sha256);
const maxUnstableReads = 20;
const hookRecorderSha = toolVersionIdentity(workflowRecipe.recorderIdentity).sha256;
export interface CodexQualificationPhase {
  intent_sha256: string;
  deadline: number;
  expectedMarker: string | null;
  fixtureScript?: string;
  onNativeSpawn?(): void;
}
/** Explicit internal qualification entry; never an admission flag or a native
 * synthetic factory. Requires the intent-bound, reserved, isolated lease created
 * by executeCodexWorkflowQualification. The shared engine owns all native I/O. */
export async function runCodexQualificationPhase(store: Store, input: unknown, c: WorkflowExecutionContext, q: CodexQualificationPhase) {
  const e = CodexWorkflowExecutionSchema.parse(input);
  const familyRequested = !!(e.direct_child || e.child_runtime);
  if (familyRequested && !store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='codex_workflow_qualification'"))
    throw new Error('codex_qualification_child_unqualified');
  const lease = store.get<{
    intent_sha256: string;
    reserved: number;
    deadline: number;
    project_id: string;
    task_id: string;
    cwd: string;
    codex_home: string;
    binary_path: string;
    binary_sha: string;
    hook_recorder: string;
    manifest_hash: string;
    validation_kind: string;
    fixture_script: string | null;
    phase: string;
    session_id: string | null;
    topology?: string;
    child_session_id?: string;
    child_source_path?: string;
  }>('SELECT * FROM codex_workflow_qualification WHERE singleton=1');
  const family = lease?.topology === 'root_direct_child';
  if (familyRequested && !family) throw new Error('codex_qualification_child_unqualified');
  if (family && (!familyRequested || e.operation === 'resume' || e.operation === 'link')) throw new Error('codex_qualification_scope_invalid');
  const phase = e.operation === 'launch' ? 'launch' : e.operation === 'resume' ? 'resume' : 'replay';
  const instructionHash = hash(
    JSON.stringify(
      c.instructions.map(i => ({ artifact_id: i.artifact_id, sha256: hash(i.content) })).sort((a, b) => a.artifact_id.localeCompare(b.artifact_id))
    )
  );
  const validate = () => {
    const live = store.get<{ reserved: number; deadline: number; phase: string; topology?: string }>(
      'SELECT * FROM codex_workflow_qualification WHERE singleton=1'
    );
    if (
      e.product_version !== workflowRecipe.version ||
      !lease ||
      lease.intent_sha256 !== q.intent_sha256 ||
      lease.reserved !== 1 ||
      live?.reserved !== 1 ||
      lease.deadline !== q.deadline ||
      live.deadline !== q.deadline ||
      lease.phase !== phase ||
      live.phase !== phase ||
      live.topology !== lease.topology ||
      lease.project_id !== c.projectId ||
      lease.task_id !== c.taskId ||
      lease.cwd !== c.projectRoot ||
      lease.codex_home !== e.codex_home ||
      lease.binary_path !== e.binary.path ||
      lease.binary_sha !== e.binary.sha256 ||
      lease.manifest_hash !== c.instructionManifestHash ||
      instructionHash !== lease.manifest_hash ||
      lease.hook_recorder !== e.hook_recorder ||
      e.sandbox !== 'read-only' ||
      e.run_id !== `qualification-${phase}` ||
      (phase === 'replay' && e.operation !== 'collect') ||
      (phase !== 'launch' && e.session_id !== lease.session_id) ||
      store.get(
        'SELECT 1 FROM comparison_assignments UNION ALL SELECT 1 FROM comparison_protocols UNION ALL SELECT 1 FROM observation_runs UNION ALL SELECT 1 FROM otel_processes LIMIT 1'
      )
    )
      throw new Error('codex_qualification_scope_invalid');
    if (Date.now() >= q.deadline) throw new Error('deadline');
    if (lease.validation_kind === 'synthetic') {
      if (!q.fixtureScript || q.fixtureScript !== lease.fixture_script || realpathSync(e.binary.path) !== realpathSync(process.execPath))
        throw new Error('codex_qualification_scope_invalid');
    } else if (lease.validation_kind !== 'real_operations' || q.fixtureScript || e.binary.sha256 !== pinnedCodexWorkflowBinarySha)
      throw new Error('codex_qualification_scope_invalid');
    if (
      phase !== 'replay' &&
      (c.runtime.model !== (phase === 'launch' ? 'gpt-6-astra' : 'gpt-6.1-sol') ||
        c.runtime.effort !== 'high' ||
        q.expectedMarker !== c.instructions[0]?.content.match(new RegExp(`QUALIFICATION_${phase.toUpperCase()}=([a-f0-9]{32})`))?.[1])
    )
      throw new Error('codex_qualification_scope_invalid');
    if (
      family &&
      (phase === 'launch'
        ? e.child_runtime?.model !== 'gpt-6.1-sol' || e.child_runtime.effort !== 'high' || e.direct_child !== undefined
        : e.child_runtime !== undefined || e.direct_child?.session_id !== lease.child_session_id || e.direct_child?.source_path !== lease.child_source_path)
    )
      throw new Error('codex_qualification_scope_invalid');
    c.assertActive();
  };
  validate();
  let markerVerified = false;
  const result = await execute(store, e, c, false, q.fixtureScript, {
    validate,
    expectedMarker: q.expectedMarker,
    replay: phase === 'replay',
    onMarker: () => {
      markerVerified = true;
    },
    onSpawn: () => {
      q.onNativeSpawn?.();
    },
    maxOwnResponses: family ? 4 : 1
  });
  return { ...result, marker_verified: markerVerified && result.state === 'completed' };
}
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function file(path: string, max: number): Buffer {
  if (realpathSync(path) !== path) throw new Error('unsafe_file');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > max) throw new Error('unsafe_file');
    const b = Buffer.alloc(before.size);
    let n = 0;
    while (n < b.length) {
      const got = readSync(fd, b, n, b.length - n, n);
      if (!got) throw new Error('short_read');
      n += got;
    }
    const after = fstatSync(fd);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error('unstable_file');
    return b;
  } finally {
    closeSync(fd);
  }
}
/** Open-file identity; any content write changes ctime, so an equal identity
 * means the bytes hashed by preflight are the bytes about to be executed. */
function fileIdentity(path: string): string {
  if (realpathSync(path) !== path) throw new Error('unsafe_file');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd, { bigint: true });
    if (!st.isFile()) throw new Error('unsafe_file');
    return [st.dev, st.ino, st.size, st.mtimeNs, st.ctimeNs].join(':');
  } finally {
    closeSync(fd);
  }
}
function verifyCodexVersion(e: Execution): void {
  const result = spawnSync(e.binary.path, ['--version'], {
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 4096,
    env: { PATH: process.env.PATH ?? '', HOME: e.codex_home, CODEX_HOME: e.codex_home },
    stdio: ['ignore', 'pipe', 'ignore']
  });
  if (result.error || result.status !== 0 || result.stdout.trim() !== `codex-cli ${e.product_version}`) throw new Error('binary_mismatch');
}
interface VerifiedBinary {
  path: string;
  sha256: string;
  identity: string;
}
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
function exactSource(path: string, home: string) {
  const base = realpathSync(join(home, 'sessions'));
  const rel = relative(base, path);
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || realpathSync(path) !== path || !lstatSync(path).isFile()) throw new Error('source_scope_mismatch');
}
/** Production entry always consults the code-owned registry before reading any
 * caller file. Qualification cannot be supplied through CLI configuration. */
const CodexWorkflowHookSchema = z.object({
  session_id: z.uuid(),
  transcript_path: pathSchema,
  cwd: pathSchema,
  hook_event_name: z.enum(['SessionStart', 'SubagentStart']),
  source: z.enum(['startup', 'resume']).optional(),
  model: ModelSchema.optional(),
  turn_id: IdSchema.optional(),
  agent_id: z.uuid().nullish(),
  permission_mode: z.literal('default')
});
function assertRootHookRuntime(value: { model?: string | undefined }, family: boolean, requestedModel: string | null): void {
  if (family && requestedModel !== null && value.model !== requestedModel) throw new Error('runtime_mismatch');
}
/** Preparation-only check of the pinned SessionStart wire contract against the
 * SAME runtime validator used by the callback. No process, source or auth access.
 * Root turn identity is source-owned; SubagentStart carries the child turn ID.
 */
export function verifyCodexWorkflowStartupContract(): void {
  const nativeStart = {
    session_id: '00000000-0000-4000-8000-000000000001',
    transcript_path: '/synthetic/session.jsonl',
    cwd: '/synthetic',
    hook_event_name: 'SessionStart',
    source: 'startup',
    model: 'gpt-6-astra',
    permission_mode: 'default'
  };
  assertRootHookRuntime(CodexWorkflowHookSchema.parse(nativeStart), true, 'gpt-6-astra');
}
export function createCodexWorkflowAdapter(store: Store, input: unknown): WorkflowAdapter {
  return adapter(store, input, false);
}
/** Trusted test dependency only. Synthetic stores, product identities and a
 * fixed Node fixture remain distinct from the production registry. */
export function createSyntheticCodexWorkflowAdapter(store: Store, input: unknown, script: string): WorkflowAdapter {
  return adapter(store, input, true, script);
}
function adapter(store: Store, input: unknown, synthetic: boolean, script?: string): WorkflowAdapter {
  const hasFamily = () =>
    typeof input === 'object' &&
    input !== null &&
    (('direct_child' in input && input.direct_child !== undefined) || ('child_runtime' in input && input.child_runtime !== undefined));
  // Only durable host metadata is consulted here, before the coordinator picks
  // the source profile. Source content never discovers or authorizes a child.
  const storedFamily = () =>
    !synthetic &&
    typeof input === 'object' &&
    input !== null &&
    'session_id' in input &&
    typeof input.session_id === 'string' &&
    !!store.get(
      'SELECT 1 FROM codex_workflow_children c JOIN codex_workflow_runs r ON r.id=c.run_id WHERE r.session_id=? UNION ALL SELECT 1 FROM sessions WHERE parent_id=? LIMIT 1',
      [input.session_id, input.session_id]
    );
  let verifiedBinary: VerifiedBinary | undefined;
  const admitted = () => {
    const execution = CodexWorkflowExecutionSchema.parse(input);
    const family = !synthetic && (hasFamily() || storedFamily());
    const profile = family ? codexWorkflowChildProfileId : codexWorkflowProfileId;
    const compatibility = resolveSourceCompatibility('codex', execution.product_version, 'codex_workflow', profile);
    if (!synthetic) {
      if (!compatibility) throw new Error('codex_workflow_source_unqualified');
      assertCompatibilityAllowed(store, compatibility);
    }
    if (!synthetic && execution.product_version === workflowRecipe.version && execution.binary.sha256 !== pinnedCodexWorkflowBinarySha)
      throw new Error('binary_mismatch');
    if (synthetic && (realpathSync(execution.binary.path) !== realpathSync(process.execPath) || !script)) throw new Error('synthetic_store_required');
    return { execution, family };
  };
  return {
    product: synthetic ? 'synthetic' : 'codex',
    get productVersion() {
      return synthetic ? '1.0.0' : CodexWorkflowExecutionSchema.parse(input).product_version;
    },
    get profileId() {
      return synthetic ? 'synthetic-flexible-v1' : hasFamily() || storedFamily() ? codexWorkflowChildProfileId : codexWorkflowProfileId;
    },
    preflight() {
      let checked: ReturnType<typeof admitted>;
      try {
        checked = admitted();
      } catch (error) {
        throw error instanceof z.ZodError ? new Error('invalid_execution') : error;
      }
      const { execution: e, family } = checked;
      if (family) nativeChildSupported(e);
      try {
        if (realpathSync(e.codex_home) !== e.codex_home || !lstatSync(e.codex_home).isDirectory()) throw new Error('unsafe_home');
      } catch {
        throw new Error('unsafe_home');
      }
      // launch/resume spawn the binary; execute() repeats these checks right before spawn.
      if (e.operation === 'launch' || e.operation === 'resume') {
        let binary: string;
        let identity: string;
        try {
          identity = fileIdentity(e.binary.path);
          binary = hash(file(e.binary.path, workflowMaxImageBytes));
          if (fileIdentity(e.binary.path) !== identity) throw new Error('unstable_file');
        } catch {
          throw new Error('binary_unreadable');
        }
        if (binary !== e.binary.sha256) throw new Error('binary_mismatch');
        if (!synthetic) verifyCodexVersion(e);
        if (fileIdentity(e.binary.path) !== identity) throw new Error('binary_mismatch');
        verifiedBinary = { path: e.binary.path, sha256: binary, identity };
        let recorder: string;
        try {
          recorder = hash(file(e.hook_recorder, 65536));
        } catch {
          throw new Error('invalid_hook_recorder');
        }
        if (recorder !== hookRecorderSha) throw new Error('invalid_hook_recorder');
        try {
          const prompt = file(e.prompt_file!, 1024 * 1024);
          const text = prompt.toString('utf8');
          if (!Buffer.from(text).equals(prompt) || text.includes('\0')) throw new Error('invalid_prompt');
        } catch {
          throw new Error('invalid_prompt');
        }
      }
    },
    async run(context) {
      const { execution, family } = admitted();
      // The synthetic workspace scope exists only after assignment.
      if (synthetic && !store.get('SELECT 1 FROM comparison_workspace_scope')) throw new Error('synthetic_store_required');
      const nativeFamily = family ? nativeChildExecution(store, execution, context) : undefined;
      return execute(store, execution, context, synthetic, script, undefined, nativeFamily, verifiedBinary);
    }
  };
}
interface NativeFamily {
  rootTurn: string | null;
  childTurn: string | null;
  rootRuntime: WorkflowRuntime | null;
  childRuntime: WorkflowRuntime | null;
}
function nativeChildSupported(e: Execution): void {
  if (
    e.sandbox !== 'read-only' ||
    (e.operation === 'launch' && (process.platform !== 'darwin' || process.arch !== 'arm64')) ||
    Number(process.versions.node.split('.')[0]) !== 24 ||
    (e.operation !== 'launch' && e.operation !== 'collect') ||
    (e.operation === 'launch' && !e.child_runtime)
  )
    throw new Error('codex_workflow_child_operation_unsupported');
}
function nativeChildExecution(store: Store, e: Execution, c: WorkflowExecutionContext): NativeFamily {
  nativeChildSupported(e);
  if (e.operation === 'launch') return { rootTurn: null, childTurn: null, rootRuntime: null, childRuntime: null };
  const bound = store.get<{ session_id: string; source_path: string; root_path: string; task_id: string; project_id: string; generation: number }>(
    "SELECT c.session_id,c.source_path,r.source_path AS root_path,r.task_id,r.project_id,r.generation FROM codex_workflow_children c JOIN codex_workflow_runs r ON r.id=c.run_id WHERE r.session_id=? AND r.operation='launch' AND r.purpose='development' AND r.state='completed' AND r.scope_verified=1 AND r.identity_verified=1 AND c.source_identity IS NOT NULL ORDER BY r.started_at DESC,r.rowid DESC LIMIT 1",
    [e.session_id]
  );
  if (
    !bound ||
    bound.task_id !== c.taskId ||
    bound.project_id !== c.projectId ||
    bound.generation !== c.generation ||
    (e.source_path !== undefined && e.source_path !== bound.root_path) ||
    (e.direct_child && (e.direct_child.session_id !== bound.session_id || e.direct_child.source_path !== bound.source_path))
  )
    throw new Error('codex_workflow_child_binding_invalid');
  const recorded = (id: string) => {
    const rows = store
      .all<{ payload: string }>('SELECT payload FROM runtime_evidence WHERE task_id=? AND session_id=?', [c.taskId, id])
      .map(r => RuntimeEvidenceSchema.parse(JSON.parse(r.payload)));
    const first = rows[0];
    if (
      !first ||
      first.turn_id === null ||
      rows.some(
        r =>
          r.product !== 'codex' ||
          r.product_version !== e.product_version ||
          r.turn_id !== first.turn_id ||
          r.model !== first.model ||
          r.effort !== first.effort
      )
    )
      throw new Error('codex_workflow_child_binding_invalid');
    return { turn: first.turn_id, runtime: { model: first.model, effort: first.effort } };
  };
  const root = recorded(e.session_id!);
  const child = recorded(bound.session_id);
  e.direct_child = { session_id: bound.session_id, source_path: bound.source_path };
  return { rootTurn: root.turn, childTurn: child.turn, rootRuntime: root.runtime, childRuntime: child.runtime };
}
async function execute(
  store: Store,
  execution: Execution,
  c: WorkflowExecutionContext,
  synthetic: boolean,
  script?: string,
  qualification?: { validate(): void; expectedMarker: string | null; replay: boolean; onMarker(): void; onSpawn(): void; maxOwnResponses: number },
  nativeFamily?: NativeFamily,
  verifiedBinary?: VerifiedBinary
): Promise<WorkflowAdapterResult> {
  const e = structuredClone(execution);
  const started = new Date().toISOString();
  const product = synthetic ? 'synthetic' : 'codex';
  const version = synthetic ? '1.0.0' : e.product_version;
  const compatibility = synthetic
    ? null
    : resolveSourceCompatibility(
        'codex',
        version,
        'codex_workflow',
        nativeFamily || e.direct_child || e.child_runtime ? codexWorkflowChildProfileId : codexWorkflowProfileId
      );
  if (compatibility) assertCompatibilityAllowed(store, compatibility);
  let session: string | null = null;
  let source: string | null = null;
  let previous: SourceBytes | undefined;
  let initialTurn: string | undefined = nativeFamily?.rootTurn ?? undefined;
  let childPrevious: SourceBytes | undefined;
  let childInitialTurn: string | undefined = nativeFamily?.childTurn ?? undefined;
  const permissionSignatures = new Map<string, string>();
  const spawnCalls = new Map<string, string>();
  let pendingChildId: string | undefined;
  let childDurable: { source_identity: string; source_size: number; source_prefix_hash: string } | undefined;
  const settled = new Set<string>();
  let baselineAt = started;
  let child: ChildProcess | undefined;
  let server: Server | undefined;
  let dir: string | undefined;
  const connections = new Set<Socket>();
  let durable: CodexWorkflowRun | undefined;
  let exited = false;
  let exitCode: number | null = null;
  let hookSeen = false;
  let failure: string | null = null;
  let stage: CodexWorkflowDiagnostic['stage'] = 'scope';
  let diagnostic: CodexWorkflowDiagnostic | null = null;
  let hookWork: Promise<void> | undefined;
  const hookJobs = new Set<Promise<void>>();
  let childHookSeen = false;
  let closing = false;
  let metadataReady = false;
  let lastVerifiedAt = started;
  let activeBinaryIdentity: string | undefined;
  const capture = (at: CodexWorkflowDiagnostic['stage'], error: unknown, eventKind?: CodexWorkflowDiagnostic['event_kind']) => {
    diagnostic ??= { ...safeDiagnostic(at, error), ...(eventKind !== undefined ? { event_kind: eventKind } : {}) };
  };
  const rejectHeader = (code: CodexWorkflowDiagnostic['code']) => {
    capture('root_header', new Error(code));
    throw new Error('unsupported_session');
  };
  const application = e.operation === 'link' || e.operation === 'collect' ? 'external_unverified' : 'invocation_settings_verified';
  store.immediateTransaction(() => {
    c.assertActive();
    qualification?.validate();
    store.execute(
      "INSERT INTO codex_workflow_runs(id,task_id,project_id,confirmation_id,purpose,generation,operation,state,instruction_manifest_hash,application,started_at) VALUES (?,?,?,?,?,?,?,'running',?,?,?)",
      [
        e.run_id,
        c.taskId,
        c.projectId,
        qualification ? null : c.confirmationId,
        qualification ? 'qualification' : 'development',
        c.generation,
        e.operation,
        c.instructionManifestHash,
        'pending',
        started
      ]
    );
  });
  const interrupt = () => {
    try {
      stopCodexWorkflow(store, e.run_id);
    } catch {
      /* deleted or revoked */
    }
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  function guard() {
    stage = 'scope';
    if (activeBinaryIdentity !== undefined) {
      try {
        if (fileIdentity(e.binary.path) !== activeBinaryIdentity) throw new Error('changed');
      } catch {
        throw new Error('binary_mismatch');
      }
    }
    if (compatibility) assertCompatibilityAllowed(store, compatibility);
    c.assertActive();
    qualification?.validate();
    const run = codexWorkflowRun(store, e.run_id);
    if (!run || run.state !== 'running') throw new Error('scope_revoked');
    if (run.stop_requested) throw new Error('stop_requested');
    if (session) {
      const row = requireActiveScope(store, c.taskId, session);
      if (row.project_id !== c.projectId || row.product !== product) throw new Error('scope_revoked');
      const linked = store.get<{ source_path: string | null }>('SELECT source_path FROM sessions WHERE id=?', [session]);
      const bound = store.get<{ source_path: string | null }>('SELECT source_path FROM codex_workflow_runs WHERE id=?', [e.run_id]);
      if (bound?.source_path !== source || (!synthetic && linked?.source_path !== source)) throw new Error('scope_revoked');
    }
  }
  function bind(id: string, path: string, existing: boolean) {
    store.immediateTransaction(() => {
      stage = 'binding';
      c.assertActive();
      exactSource(path, e.codex_home);
      if (e.operation === 'launch' && lstatSync(path).birthtimeMs < Date.parse(started) + 1) throw new Error('stale_launch_source');
      const old = store.get<{
        task_id: string;
        project_id: string;
        source_path: string | null;
        product: string;
        product_version: string;
        parent_id: string | null;
      }>('SELECT * FROM sessions WHERE id=?', [id]);
      if (old) {
        const oldPath = synthetic
          ? store.get<{ source_path: string }>(
              'SELECT source_path FROM codex_workflow_runs WHERE session_id=? AND source_path IS NOT NULL ORDER BY started_at LIMIT 1',
              [id]
            )?.source_path
          : old.source_path;
        if (
          old.task_id !== c.taskId ||
          old.project_id !== c.projectId ||
          old.product !== product ||
          old.product_version !== version ||
          old.parent_id !== null ||
          oldPath !== path
        )
          throw new Error('session_scope_mismatch');
        durable = store.get<CodexWorkflowRun>(
          'SELECT * FROM codex_workflow_runs WHERE session_id=? AND id!=? AND source_identity IS NOT NULL ORDER BY started_at DESC,rowid DESC LIMIT 1',
          [id, e.run_id]
        );
        const stat = lstatSync(path);
        if (durable && durable.source_identity !== `${stat.dev}:${stat.ino}`) throw new Error('source_changed');
      } else {
        if (existing) throw new Error('session_not_linked');
        store.execute('INSERT INTO sessions(id,project_id,task_id,source_path,product,product_version) VALUES (?,?,?,?,?,?)', [
          id,
          c.projectId,
          c.taskId,
          synthetic ? null : path,
          product,
          version
        ]);
      }
      if (store.get("SELECT 1 FROM tombstones WHERE kind='session' AND id=?", [id])) throw new Error('scope_revoked');
      session = id;
      source = path;
      store.execute('UPDATE codex_workflow_runs SET session_id=?,source_path=? WHERE id=?', [id, path, e.run_id]);
      if (compatibility) pinSessionCompatibility(store, id, compatibility);
      if (!qualification) bindConfigurationToSession(store, c.confirmationId, id);
    });
  }
  function guardChild() {
    guard();
    if (!e.direct_child || !session) throw new Error('scope_revoked');
    const linked = store.get<{ parent_id: string; source_path: string | null; product_version: string }>(
      'SELECT parent_id,source_path,product_version FROM sessions WHERE id=?',
      [e.direct_child.session_id]
    );
    const active = requireActiveScope(store, c.taskId, e.direct_child.session_id);
    const bound = store.get<{ source_path: string }>('SELECT source_path FROM codex_workflow_children WHERE run_id=?', [e.run_id]);
    if (
      active.project_id !== c.projectId ||
      active.product !== product ||
      linked?.parent_id !== session ||
      linked.product_version !== version ||
      (!synthetic && linked.source_path !== e.direct_child.source_path) ||
      bound?.source_path !== e.direct_child.source_path
    )
      throw new Error('scope_revoked');
    exactSource(e.direct_child.source_path, e.codex_home);
  }
  function bindChild() {
    store.immediateTransaction(() => {
      guard();
      if (!e.direct_child || !session || e.direct_child.source_path === source) throw new Error('unsupported_session');
      const id = e.direct_child.session_id;
      const path = e.direct_child.source_path;
      exactSource(path, e.codex_home);
      if (e.child_runtime && lstatSync(path).birthtimeMs < Date.parse(started) + 1) throw new Error('unsupported_session');
      if (store.get("SELECT 1 FROM tombstones WHERE kind='session' AND id=?", [id])) throw new Error('scope_revoked');
      const old = store.get<{ task_id: string; project_id: string; source_path: string | null; product: string; product_version: string; parent_id: string }>(
        'SELECT * FROM sessions WHERE id=?',
        [id]
      );
      if (old) {
        const oldPath = synthetic
          ? store.get<{ source_path: string }>('SELECT source_path FROM codex_workflow_children WHERE session_id=? ORDER BY rowid LIMIT 1', [id])?.source_path
          : old.source_path;
        if (
          old.task_id !== c.taskId ||
          old.project_id !== c.projectId ||
          old.product !== product ||
          old.product_version !== version ||
          old.parent_id !== session ||
          oldPath !== path
        )
          throw new Error('scope_revoked');
        childDurable = store.get(
          'SELECT source_identity,source_size,source_prefix_hash FROM codex_workflow_children WHERE session_id=? AND source_identity IS NOT NULL ORDER BY rowid DESC LIMIT 1',
          [id]
        );
      } else {
        if (e.operation === 'collect') throw new Error('session_not_linked');
        store.execute('INSERT INTO sessions(id,project_id,task_id,parent_id,source_path,product,product_version) VALUES (?,?,?,?,?,?,?)', [
          id,
          c.projectId,
          c.taskId,
          session,
          synthetic ? null : path,
          product,
          version
        ]);
      }
      store.execute('INSERT INTO codex_workflow_children(run_id,session_id,task_id,project_id,source_path) VALUES (?,?,?,?,?)', [
        e.run_id,
        id,
        c.taskId,
        c.projectId,
        path
      ]);
      if (compatibility) pinSessionCompatibility(store, id, compatibility);
      if (!qualification) bindConfigurationToSession(store, c.confirmationId, id);
      guardChild();
    });
  }
  function verifyPermissions(id: string, p: Record<string, unknown>) {
    const signature = checkCandidatePermissions(p, 'default').signature;
    if (permissionSignatures.has(id) && permissionSignatures.get(id) !== signature) throw new Error('runtime_mismatch');
    permissionSignatures.set(id, signature);
  }
  // A read racing a native append sees the file change underneath it and yields no
  // snapshot. The transaction ingests nothing, so the next poll rereads; identity,
  // truncation and prefix checks still fail closed. Bounded so a source that never
  // settles keeps failing with unstable_read.
  let unstableReads = 0;
  function attempt<T>(read: () => T): { value: T } | undefined {
    try {
      const value = read();
      unstableReads = 0;
      return { value };
    } catch (error) {
      if (!(error instanceof SourceFailure) || sourceCategory(error, 'read_failed') !== 'unstable_read' || ++unstableReads > maxUnstableReads) throw error;
      return undefined;
    }
  }
  function tick(baseline = false, baselineChild = false) {
    return store.immediateTransaction(() => {
      guard();
      if (!source || !session) throw new Error('session_not_linked');
      exactSource(source, e.codex_home);
      if (e.direct_child) guardChild();
      stage = 'source_read';
      const bytes = readSource(source);
      guard();
      if (e.direct_child) guardChild();
      stage = 'source_continuity';
      if (
        !previous &&
        durable &&
        (bytes.identity !== durable.source_identity ||
          bytes.size < durable.source_size! ||
          hash(Buffer.from(bytes.text).subarray(0, durable.source_size!)) !== durable.source_prefix_hash)
      )
        throw new Error('source_changed');
      if (previous && (bytes.identity !== previous.identity || bytes.size < previous.size || !bytes.text.startsWith(previous.text)))
        throw new Error('source_changed');
      const lines = bytes.text.split('\n');
      lines.pop();
      // A newly bound source can precede its first complete header. Keep the same
      // inode/prefix guard, but do not acknowledge the hook or claim verified scope.
      if (lines.length === 0) {
        previous = bytes;
        stage = 'root_header';
        return false;
      }
      stage = 'envelope';
      const rowSchema = z.object({
        type: z.string(),
        timestamp: z.string().optional(),
        ordinal: z.number().int().nonnegative().optional(),
        payload: z.record(z.string(), z.unknown())
      });
      const rows = lines.map(line => rowSchema.parse(JSON.parse(line)));
      const meta = rows[0]?.payload;
      stage = 'root_header';
      if (
        rows[0]?.type !== 'session_meta' ||
        meta?.id !== session ||
        meta.session_id !== session ||
        meta.cli_version !== e.product_version ||
        meta.cwd !== c.projectRoot ||
        typeof meta.source !== 'string'
      )
        rejectHeader('invalid_root_identity');
      if (meta!.source !== 'cli' && meta!.source !== 'exec') rejectHeader('unsupported_session');
      if (
        meta!.parent_thread_id != null ||
        meta!.forked_from_id != null ||
        meta!.forked_from_ordinal_exclusive != null ||
        meta!.history_base != null ||
        meta!.subagent_history_start_ordinal != null
      )
        rejectHeader('unsupported_root_history');
      // Root pagination is native 0.160 syntax, independent of fork/child history.
      // The existing parser still enforces every subsequent contiguous ordinal.
      if (meta!.history_mode === 'paginated' && rows[0]!.ordinal !== 0) rejectHeader('invalid_root_ordinal');
      const turns: string[] = [];
      for (const row of rows) {
        if (row.type === 'compacted' || row.type === 'retained_context' || ['subagent_start', 'collab_agent_spawn_begin'].includes(String(row.payload.type)))
          throw new Error('unsupported_session');
        const activity =
          row.payload.type === 'sub_agent_activity' ||
          (row.type === 'event_msg' && z.object({ item: z.object({ type: z.literal('SubAgentActivity') }) }).safeParse(row.payload).success);
        if (activity) {
          const target =
            row.payload.agent_thread_id ?? z.object({ item: z.object({ agent_thread_id: z.string() }) }).safeParse(row.payload).data?.item.agent_thread_id;
          if (e.child_runtime) {
            // Prior turns are baseline history, never new bindings. Current started
            // activity corroborates the hook; it cannot authorize source reads.
            if (row.timestamp && Date.parse(row.timestamp) < Date.parse(started)) continue;
            const activity = z
              .object({
                thread_id: z.uuid(),
                turn_id: IdSchema,
                item: z.object({
                  type: z.literal('SubAgentActivity'),
                  kind: z.enum(['started', 'interacted', 'interrupted', 'completed']),
                  id: IdSchema,
                  agent_thread_id: z.uuid()
                })
              })
              .safeParse(row.payload);
            const legacy = z
              .object({
                type: z.literal('sub_agent_activity'),
                kind: z.enum(['started', 'interacted', 'interrupted', 'completed']),
                event_id: IdSchema,
                agent_thread_id: z.uuid()
              })
              .safeParse(row.payload);
            if (!activity.success && !legacy.success) throw new Error('unsupported_session');
            if (activity.success && (activity.data.thread_id !== session || activity.data.turn_id !== initialTurn)) throw new Error('unsupported_session');
            const call = activity.success ? activity.data.item.id : legacy.data!.event_id;
            const native = activity.success ? activity.data.item.agent_thread_id : legacy.data!.agent_thread_id;
            const kind = activity.success ? activity.data.item.kind : legacy.data!.kind;
            if (kind !== 'started') {
              if (native !== (e.direct_child?.session_id ?? pendingChildId)) throw new Error('unsupported_session');
              if (qualification && kind !== 'completed') throw new Error('unexpected_qualification_item');
              continue;
            }
            if (
              native === session ||
              (pendingChildId && pendingChildId !== native) ||
              (e.direct_child && e.direct_child.session_id !== native) ||
              (spawnCalls.has(call) && spawnCalls.get(call) !== native) ||
              (!spawnCalls.has(call) && spawnCalls.size !== 0)
            )
              throw new Error('unsupported_session');
            spawnCalls.set(call, native);
            pendingChildId = native;
          } else if (!e.direct_child || target !== e.direct_child.session_id) throw new Error('unsupported_session');
        }
        if (row.type === 'turn_context') {
          stage = 'turn_context';
          const p = row.payload;
          if (
            p.cwd !== c.projectRoot ||
            typeof p.turn_id !== 'string' ||
            (p.root_turn_id && p.root_turn_id !== p.turn_id) ||
            (p.multi_agent_version &&
              (typeof p.multi_agent_version !== 'string' ||
                !(e.direct_child || e.child_runtime ? ['disabled', 'v1', 'v2'] : ['disabled']).includes(p.multi_agent_version)))
          )
            throw new Error('unsupported_session');
          if (row.timestamp && Date.parse(row.timestamp) >= Date.parse(started) && application === 'invocation_settings_verified') {
            if ((c.runtime.model !== null && p.model !== c.runtime.model) || (c.runtime.effort !== null && p.effort !== c.runtime.effort))
              throw new Error('runtime_mismatch');
            const policy = z.object({ type: z.literal(e.sandbox) }).safeParse(p.sandbox_policy);
            if (!policy.success || p.approval_policy !== 'on-request' || p.approvals_reviewer !== 'auto_review') throw new Error('runtime_mismatch');
          }
          // Pinned SessionStart wire input omits turn_id. A fresh family root
          // resolves its first turn from validated source metadata after startup;
          // the hook cannot create or guess a turn. Old resume contexts stay baseline.
          if (e.child_runtime && initialTurn === undefined && row.timestamp && Date.parse(row.timestamp) >= Date.parse(started)) {
            if (
              !rows
                .slice(0, rows.indexOf(row))
                .some(
                  prior =>
                    prior.type === 'event_msg' &&
                    prior.payload.type === 'task_started' &&
                    prior.payload.turn_id === p.turn_id &&
                    prior.timestamp &&
                    Date.parse(prior.timestamp) >= Date.parse(started)
                )
            )
              throw new Error('initial_source_incomplete');
            initialTurn = p.turn_id;
          }
          if (e.child_runtime && p.turn_id === initialTurn) {
            if (p.multi_agent_version !== 'v1' && p.multi_agent_version !== 'v2') throw new Error('unsupported_session');
            verifyPermissions(session, p);
          }
          if (nativeFamily) {
            if (
              p.turn_id !== initialTurn ||
              (nativeFamily.rootRuntime && (p.model !== nativeFamily.rootRuntime.model || (p.effort ?? null) !== nativeFamily.rootRuntime.effort))
            )
              throw new Error('runtime_mismatch');
            verifyPermissions(session, p);
          }
          if (!turns.includes(p.turn_id)) turns.push(p.turn_id);
        }
      }
      if (turns.length > 64) throw new Error('unsupported_session');
      const scope = {
        projectId: c.projectId,
        taskId: c.taskId,
        allowedRootTurnIds: turns.length ? turns : ['unused'],
        sessions: [
          {
            sessionId: session,
            rootSessionId: session,
            parentSessionId: null as string | null,
            sourceId: session,
            product: 'codex' as const,
            nativeSessionId: session,
            processId: null,
            agentId: null
          }
        ]
      };
      let childBytes: SourceBytes | undefined;
      if (e.direct_child) {
        guardChild();
        stage = 'source_read';
        childBytes = readSource(e.direct_child.source_path);
        guardChild();
        stage = 'source_continuity';
        if (
          !childPrevious &&
          childDurable &&
          (childBytes.identity !== childDurable.source_identity ||
            childBytes.size < childDurable.source_size ||
            hash(Buffer.from(childBytes.text).subarray(0, childDurable.source_size)) !== childDurable.source_prefix_hash)
        )
          throw new Error('source_changed');
        if (
          childPrevious &&
          (childBytes.identity !== childPrevious.identity || childBytes.size < childPrevious.size || !childBytes.text.startsWith(childPrevious.text))
        )
          throw new Error('source_changed');
        stage = 'envelope';
        const childLines = childBytes.text.split('\n');
        childLines.pop();
        const childRows = childLines.map(line => rowSchema.parse(JSON.parse(line)));
        const childMeta = childRows[0]?.payload;
        if (baselineChild && (childRows.length === 0 || !childRows.some(row => row.type === 'turn_context'))) {
          childPrevious = childBytes;
          return false;
        }
        if (baselineChild && childRows.some(row => row.type === 'token_usage_record')) throw new Error('unsupported_session');
        if (
          childRows[0]?.type !== 'session_meta' ||
          childMeta?.id !== e.direct_child.session_id ||
          childMeta.session_id !== session ||
          childMeta.cwd !== c.projectRoot ||
          childMeta.cli_version !== e.product_version ||
          childMeta.parent_thread_id !== session
        )
          throw new Error('unsupported_session');
        if (
          childMeta.forked_from_id != null ||
          childMeta.forked_from_ordinal_exclusive != null ||
          childMeta.history_base != null ||
          childMeta.subagent_history_start_ordinal != null ||
          (childMeta.history_mode === 'paginated' && childRows[0].ordinal !== 0)
        )
          throw new Error('unsupported_session');
        if (
          childRows.some(
            row =>
              row.type === 'compacted' ||
              row.type === 'retained_context' ||
              ['subagent_start', 'collab_agent_spawn_begin', 'sub_agent_activity'].includes(String(row.payload.type)) ||
              (row.type === 'event_msg' && z.object({ item: z.object({ type: z.literal('SubAgentActivity') }) }).safeParse(row.payload).success)
          )
        )
          throw new Error('unsupported_session');
        if (e.child_runtime || nativeFamily) {
          const expected = e.child_runtime ?? nativeFamily!.childRuntime!;
          for (const row of childRows.filter(row => row.type === 'turn_context')) {
            const p = row.payload;
            if (
              p.cwd !== c.projectRoot ||
              p.turn_id !== childInitialTurn ||
              p.root_turn_id !== initialTurn ||
              p.model !== expected.model ||
              (p.effort ?? null) !== expected.effort ||
              (p.multi_agent_version !== 'v1' && p.multi_agent_version !== 'v2')
            )
              throw new Error('runtime_mismatch');
            verifyPermissions(e.direct_child.session_id, p);
          }
        }
        scope.sessions.push({
          sessionId: e.direct_child.session_id,
          rootSessionId: session,
          parentSessionId: session,
          sourceId: e.direct_child.session_id,
          product: 'codex',
          nativeSessionId: e.direct_child.session_id,
          processId: null,
          agentId: null
        });
      }
      // Both bounded snapshots may advance while the other is being read. Sample
      // recorded_at after all reads, so a newly read child response cannot be
      // rejected solely because its timestamp follows an earlier root read.
      const now = new Date().toISOString();
      stage = 'projection';
      const snapshots = [{ id: session, snapshot: parseCodexCandidateRollout(bytes.text, scope, session, c.projectRoot, now, compatibility ?? undefined) }];
      if (e.direct_child && childBytes)
        snapshots.push({
          id: e.direct_child.session_id,
          snapshot: parseCodexCandidateRollout(childBytes.text, scope, e.direct_child.session_id, c.projectRoot, now, compatibility ?? undefined)
        });
      // Validate both sources before any usage insertion; conflicts roll back the
      // family tick, including runtime evidence, counts and source checkpoints.
      const pendingSettled = new Set(settled);
      const requests = new Map<string, string>();
      for (const part of snapshots)
        for (const record of part.snapshot.records) {
          const projection = record.projection;
          const fingerprint = JSON.stringify({ ...projection, runtime: { ...projection.runtime, recorded_at: null } });
          if (requests.has(projection.event.id) && requests.get(projection.event.id) !== fingerprint) throw new Error('candidate_conflict');
          requests.set(projection.event.id, fingerprint);
        }
      if (c.externalStartup) {
        if (e.direct_child || !['link', 'collect'].includes(e.operation)) throw new Error('unsupported_session');
        c.externalStartup.verify({ ...verifyExternalContext(rows, c.externalStartup.expectation, now), sessionId: session, sourceIdentity: bytes.identity });
      }
      for (const part of snapshots) {
        if (part.snapshot.hasGap) recordObservationGap(store, c.taskId, part.id, baselineAt, now, 'incomplete', now);
        for (const record of part.snapshot.records) {
          let { event, runtime } = record.projection;
          if (pendingSettled.has(event.id)) continue;
          // Recollection keeps the bound family's turn identity, but old/offline
          // responses stay excluded even if appended after the initial baseline.
          const boundChildTurn = nativeFamily && part.id === e.direct_child?.session_id && runtime.turn_id === childInitialTurn;
          if (
            baseline ||
            (baselineChild && part.id === e.direct_child?.session_id) ||
            (nativeFamily && Date.parse(event.occurred_at) < Date.parse(baselineAt)) ||
            (Date.parse(record.contextAt) < Date.parse(baselineAt) && runtime.turn_id !== initialTurn && !boundChildTurn)
          ) {
            pendingSettled.add(event.id);
            continue;
          }
          if (Date.parse(event.occurred_at) > Date.parse(now)) continue;
          const original = event.id;
          if (synthetic) {
            const key = hash('synthetic-workflow:' + runtime.request_id);
            const runtimeId = hash('runtime:' + key);
            runtime = { ...runtime, id: runtimeId, product: 'synthetic', product_version: version };
            event = {
              ...event,
              id: key,
              source_key: key,
              payload: { ...event.payload, product: 'synthetic', product_version: version, runtime_evidence_id: runtimeId }
            };
          }
          stage = 'usage_insert';
          if (putUsageWithEvidence(store, event, runtime))
            store.execute('UPDATE codex_workflow_runs SET observed_requests=observed_requests+1 WHERE id=?', [e.run_id]);
          if (qualification && codexWorkflowRun(store, e.run_id)!.observed_requests > qualification.maxOwnResponses)
            throw new Error('qualification_output_invalid');
          pendingSettled.add(original);
        }
      }
      if (e.direct_child && childBytes)
        store.execute('UPDATE codex_workflow_children SET source_identity=?,source_size=?,source_prefix_hash=? WHERE run_id=?', [
          childBytes.identity,
          childBytes.size,
          hash(childBytes.text),
          e.run_id
        ]);
      previous = bytes;
      store.execute('UPDATE codex_workflow_runs SET scope_verified=1,identity_verified=1,source_identity=?,source_size=?,source_prefix_hash=? WHERE id=?', [
        bytes.identity,
        bytes.size,
        hash(bytes.text),
        e.run_id
      ]);
      childPrevious = childBytes;
      for (const id of pendingSettled) settled.add(id);
      lastVerifiedAt = now;
      metadataReady = true;
      return true;
    });
  }
  try {
    guard();
    if (realpathSync(e.codex_home) !== e.codex_home || !lstatSync(e.codex_home).isDirectory()) throw new Error('unsafe_home');
    if (e.operation !== 'launch') {
      const linked = store.get<{ source_path: string | null }>('SELECT source_path FROM sessions WHERE id=?', [e.session_id!]);
      const path =
        e.source_path ??
        (synthetic
          ? store.get<{ source_path: string }>(
              'SELECT source_path FROM codex_workflow_runs WHERE session_id=? AND source_path IS NOT NULL ORDER BY started_at LIMIT 1',
              [e.session_id!]
            )?.source_path
          : linked?.source_path);
      if (!path) throw new Error('explicit_source_required');
      bind(e.session_id!, path, e.operation !== 'link');
      if (e.direct_child) bindChild();
      while (!attempt(() => tick(true))) {
        // tick() runs guard() first, so stop, pause and revocation end this loop too.
        if (Date.now() - Date.parse(started) >= e.timeout_ms) {
          stage = 'process';
          throw new Error('deadline');
        }
        await delay(e.poll_ms);
      }
      baselineAt = new Date().toISOString();
    }
    if (e.operation === 'link') {
      store.execute('UPDATE codex_workflow_runs SET application=? WHERE id=?', [application, e.run_id]);
    } else if (e.operation === 'launch' || e.operation === 'resume') {
      // Re-hash unless this exact file identity was hashed by preflight.
      guard();
      const unchanged =
        verifiedBinary !== undefined &&
        verifiedBinary.path === e.binary.path &&
        verifiedBinary.sha256 === e.binary.sha256 &&
        verifiedBinary.identity === fileIdentity(e.binary.path);
      if (!unchanged && hash(file(e.binary.path, workflowMaxImageBytes)) !== e.binary.sha256) throw new Error('binary_mismatch');
      if (!synthetic && !qualification) verifyCodexVersion(e);
      if (hash(file(e.hook_recorder, 65536)) !== hookRecorderSha) throw new Error('invalid_hook_recorder');
      const prompt = file(e.prompt_file!, 1024 * 1024);
      const text = prompt.toString('utf8');
      if (!Buffer.from(text).equals(prompt) || text.includes('\0')) throw new Error('invalid_prompt');
      const instructions = c.instructions.length === 1 ? c.instructions[0]!.content : c.instructions.map(i => `[${i.artifact_id}]\n${i.content}`).join('\n\n');
      if (Buffer.byteLength(instructions) > 32768) throw new Error('instruction_size');
      dir = mkdtempSync('/tmp/hdw-');
      chmodSync(dir, 0o700);
      const socket = join(dir, 'hook.sock');
      const hook = join(dir, 'hook');
      writeFileSync(hook, `#!/bin/sh\nexec ${quote(realpathSync(process.execPath))} ${quote(e.hook_recorder)} ${quote(socket)}\n`, { mode: 0o700 });
      server = createServer(connection => {
        connections.add(connection);
        connection.on('close', () => connections.delete(connection));
        let data = '';
        let handled = false;
        connection.setTimeout(5000, () => connection.destroy());
        connection.on('error', () => {});
        connection.on('data', chunk => {
          if (handled) {
            failure = 'hook_rejected';
            connection.destroy();
            return;
          }
          data += chunk.toString('utf8');
          if (Buffer.byteLength(data) > 65536) {
            failure = 'invalid_hook';
            connection.destroy();
            return;
          }
          if (!data.endsWith('\n')) return;
          handled = true;
          if (data.indexOf('\n') !== data.length - 1) {
            failure = 'hook_rejected';
            connection.end('error\n');
            return;
          }
          const job = (async () => {
            try {
              stage = 'hook';
              const value = CodexWorkflowHookSchema.parse(JSON.parse(data));
              const isChild = value.hook_event_name === 'SubagentStart';
              if (isChild) {
                // A second/deeper child never acquires source-read permission.
                if (
                  !e.child_runtime ||
                  !hookSeen ||
                  childHookSeen ||
                  e.direct_child ||
                  !value.agent_id ||
                  value.agent_id === session ||
                  value.session_id !== session ||
                  !value.turn_id ||
                  value.cwd !== c.projectRoot ||
                  value.model !== e.child_runtime.model ||
                  (pendingChildId && pendingChildId !== value.agent_id)
                )
                  throw new Error('unsupported_session');
                childHookSeen = true;
                childInitialTurn = value.turn_id;
                e.direct_child = { session_id: value.agent_id, source_path: value.transcript_path };
                bindChild();
              } else {
                if (
                  hookSeen ||
                  hookWork ||
                  value.agent_id != null ||
                  value.cwd !== c.projectRoot ||
                  value.source !== (e.operation === 'resume' ? 'resume' : 'startup') ||
                  (e.session_id && value.session_id !== e.session_id) ||
                  (e.operation === 'resume' && value.transcript_path !== source)
                )
                  throw new Error('unsupported_session');
                assertRootHookRuntime(value, e.child_runtime !== undefined, c.runtime.model);
                bind(value.session_id, value.transcript_path, e.operation === 'resume');
                initialTurn = value.turn_id;
              }
              const headerDeadline = Math.min(Date.now() + 5000, Date.parse(started) + e.timeout_ms);
              while (true) {
                stage = 'root_header';
                if (closing) throw new Error('stop_requested');
                if (Date.now() >= headerDeadline) throw new Error('initial_source_incomplete');
                if (attempt(() => tick(!isChild, isChild))?.value) break;
                await delay(e.poll_ms);
              }
              if (!isChild) {
                baselineAt = started;
                hookSeen = true;
              }
              connection.end('ok\n');
            } catch (error) {
              capture(stage, error);
              failure ??= safeReason(error);
              connection.end('error\n');
            }
          })();
          hookWork = job;
          hookJobs.add(job);
          void job.finally(() => {
            hookJobs.delete(job);
            hookWork = undefined;
          });
        });
      });
      await new Promise<void>((ok, no) => {
        server!.once('error', no);
        server!.listen(socket, ok);
      });
      chmodSync(socket, 0o600);
      // Pinned exec otherwise applies the headless Never override. Explicit
      // AutoReview preserves on-request without bypassing sandbox or trust.
      const args = [
        'exec',
        '-c',
        `developer_instructions=${JSON.stringify(instructions)}`,
        '-c',
        'approval_policy="on-request"',
        '-c',
        'approvals_reviewer="auto_review"',
        '-c',
        `agents.enabled=${e.child_runtime ? 'true' : 'false'}`,
        '--sandbox',
        e.sandbox
      ];
      // Explicit verification opt-in only. A specified effective trust value
      // avoids 0.160.0's implicit persistent-trust branch at thread/start.
      // This also disables project-local config/hooks/rules for this invocation.
      // The pinned override parser splits the left-hand key on every dot and
      // does not decode quoted keys. Put the path in the parsed TOML value.
      if (e.project_trust) args.push('-c', `projects={${JSON.stringify(c.projectRoot)}={trust_level="untrusted"}}`);
      if (qualification) args.push('--skip-git-repo-check', '--json');
      const trustedStates: string[] = [];
      for (const [event, label] of [['SessionStart', 'session_start'], ...(e.child_runtime ? [['SubagentStart', 'subagent_start']] : [])] as [
        string,
        string
      ][]) {
        args.push('-c', `hooks.${event}=[{hooks=[{type="command",command="${hook}",timeout=5}]}]`);
        const trusted = hash(JSON.stringify({ event_name: label, hooks: [{ async: false, command: hook, timeout: 5, type: 'command' }] }));
        trustedStates.push(`"/<session-flags>/config.toml:${label}:0:0"={trusted_hash="sha256:${trusted}"}`);
      }
      args.push('-c', `hooks.state={${trustedStates.join(',')}}`);
      if (e.child_runtime)
        args.push(
          '-c',
          `agents.default_subagent_model=${JSON.stringify(e.child_runtime.model)}`,
          '-c',
          `agents.default_subagent_reasoning_effort=${JSON.stringify(e.child_runtime.effort)}`,
          '-c',
          'agents.max_depth=1'
        );
      if (c.runtime.model !== null) args.push('--model', c.runtime.model);
      if (c.runtime.effort !== null) args.push('-c', `model_reasoning_effort=${JSON.stringify(c.runtime.effort)}`);
      if (e.operation === 'resume') args.push('resume', e.session_id!);
      args.push('-');
      if (JSON.parse(args.find(a => a.startsWith('developer_instructions='))!.slice('developer_instructions='.length)) !== instructions)
        throw new Error('instruction_mismatch');
      guard();
      activeBinaryIdentity = fileIdentity(e.binary.path);
      stage = 'process';
      child = spawn(e.binary.path, synthetic || (qualification && script) ? [script!, ...args] : args, {
        cwd: c.projectRoot,
        env: { ...process.env, CODEX_HOME: e.codex_home },
        detached: true,
        stdio: ['pipe', qualification ? 'pipe' : 'ignore', 'ignore']
      });
      if (child.pid !== undefined) qualification?.onSpawn();
      if (qualification) {
        let pending = '';
        let total = 0;
        let markers = 0;
        let spawnItem: string | undefined;
        child.stdout!.on('data', (chunk: Buffer) => {
          try {
            guard();
          } catch (error) {
            capture('scope', error);
            failure = 'qualification_scope_lost';
            return;
          }
          total += chunk.length;
          if (total > 65536) {
            capture('stdout', new Error('qualification_output_invalid'));
            failure = 'qualification_output_invalid';
            return;
          }
          // No decode or backfill of stdout delivered before native root binding.
          if (!hookSeen) return;
          pending += chunk.toString('utf8');
          let index: number;
          while ((index = pending.indexOf('\n')) >= 0) {
            const line = pending.slice(0, index);
            pending = pending.slice(index + 1);
            if (!line) continue;
            let eventKind: CodexWorkflowDiagnostic['event_kind'] = 'invalid_item';
            try {
              const row = z
                .object({ type: z.string(), item: z.object({ type: z.string(), text: z.string().optional() }).passthrough().optional() })
                .parse(JSON.parse(line));
              // Fixed enums only: no item body, producer name, IDs or arguments
              // survive this callback. Unknown producer values become other_item.
              eventKind =
                row.item?.type === 'agent_message'
                  ? 'agent_message'
                  : row.item?.type === 'reasoning'
                    ? 'reasoning'
                    : row.item?.type === 'collab_tool_call' && row.item.tool === 'spawn_agent'
                      ? 'collab_spawn'
                      : row.item?.type === 'collab_tool_call' && row.item.tool === 'wait'
                        ? 'collab_wait'
                        : row.item?.type === 'collab_tool_call' && row.item.tool === 'close_agent'
                          ? 'collab_close'
                          : 'other_item';
              if (['item.started', 'item.updated', 'item.completed'].includes(row.type) && row.item) {
                if (row.item.type === 'agent_message' && row.type === 'item.completed') {
                  if (++markers !== 1 || row.item.text?.trim() !== qualification.expectedMarker) throw new Error('marker_mismatch');
                  qualification.onMarker();
                } else if (row.item.type === 'agent_message') continue;
                else if (e.child_runtime && row.item.type === 'collab_tool_call') {
                  const activity = z
                    .object({
                      id: IdSchema,
                      type: z.literal('collab_tool_call'),
                      tool: z.enum(['spawn_agent', 'wait', 'close_agent']),
                      sender_thread_id: z.uuid(),
                      receiver_thread_ids: z.array(z.uuid()).max(1),
                      status: z.enum(['in_progress', 'completed'])
                    })
                    .parse(row.item);
                  if (activity.sender_thread_id !== session) throw new Error('qualification_sender_mismatch');
                  if (activity.receiver_thread_ids.some(id => id === session || (e.direct_child && id !== e.direct_child.session_id)))
                    throw new Error('qualification_receiver_mismatch');
                  if (activity.tool === 'spawn_agent') {
                    if (spawnItem && spawnItem !== activity.id) throw new Error('qualification_spawn_changed');
                    spawnItem = activity.id;
                  }
                  if (activity.status === 'completed') {
                    if (!e.direct_child) throw new Error('qualification_child_unbound');
                    // Native V2 wait omits receivers. Only an already verified
                    // hook/source binding supplies identity; final source activity
                    // and child own usage checks remain mandatory.
                    const boundWait =
                      activity.tool === 'wait' &&
                      activity.receiver_thread_ids.length === 0 &&
                      childHookSeen &&
                      !!store.get('SELECT 1 FROM codex_workflow_children WHERE run_id=? AND session_id=? AND source_identity IS NOT NULL', [
                        e.run_id,
                        e.direct_child.session_id
                      ]);
                    if (activity.receiver_thread_ids.length !== 1 && !boundWait) throw new Error('qualification_receiver_missing');
                    if (activity.receiver_thread_ids.length === 1 && activity.receiver_thread_ids[0] !== e.direct_child.session_id)
                      throw new Error('qualification_receiver_mismatch');
                  }
                } else if (row.item.type !== 'reasoning') throw new Error('unexpected_qualification_item');
              }
            } catch (error) {
              capture('stdout', error, eventKind);
              failure = 'qualification_marker_failed';
            }
          }
        });
        child.stdout!.on('end', () => {
          if (pending.length) {
            capture('stdout', new Error('qualification_output_invalid'));
            failure = 'qualification_output_invalid';
          }
        });
      }
      child.on('error', error => {
        capture('process', error);
        failure = 'process_error';
        exited = true;
      });
      child.on('exit', code => {
        exitCode = code;
        exited = true;
      });
      child.stdin!.on('error', () => {});
      child.stdin!.end(prompt);
      store.execute('UPDATE codex_workflow_runs SET application=? WHERE id=?', [application, e.run_id]);
    }
    if (e.operation !== 'link')
      while (true) {
        guard();
        if (failure) throw new Error(failure);
        if (codexWorkflowRun(store, e.run_id)?.stop_requested) {
          failure = 'stop_requested';
          break;
        }
        if (Date.now() - Date.parse(started) >= e.timeout_ms) {
          capture('process', new Error('deadline'));
          failure = 'deadline';
          break;
        }
        const read = hookSeen || e.operation === 'collect' ? attempt(() => tick()) : { value: true };
        if (qualification?.replay) {
          stopCodexWorkflow(store, e.run_id);
          continue;
        }
        // Completion needs a stable read taken after the exit was observed, so the
        // final appended usage is never skipped by an unstable last poll.
        if (exited && !read) {
          await delay(e.poll_ms);
          continue;
        }
        if (exited) {
          stage = 'process';
          if (!hookSeen) throw new Error('hook_missing');
          if (!metadataReady) throw new Error('initial_source_incomplete');
          if (exitCode !== 0) throw new Error('process_failed');
          if (
            e.child_runtime &&
            (!childHookSeen ||
              !e.direct_child ||
              pendingChildId !== e.direct_child.session_id ||
              !store.get('SELECT 1 FROM events WHERE task_id=? AND session_id=?', [c.taskId, e.direct_child.session_id]))
          )
            throw new Error('hook_missing');
          break;
        }
        await delay(e.poll_ms);
      }
  } catch (error) {
    capture(stage, error);
    failure = safeReason(error);
  } finally {
    closing = true;
    if (child?.pid) {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        /* already exited */
      }
      await delay(50);
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* already exited */
      }
    }
    for (const connection of connections) connection.destroy();
    await Promise.all([...hookJobs]);
    if (server) await new Promise<void>(ok => server!.close(() => ok()));
    if (dir) rmSync(dir, { recursive: true, force: true });
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
  if (
    compatibility?.state === 'compatibility_unverified' &&
    failure &&
    ['source_changed', 'runtime_mismatch', 'unsupported_session', 'hook_missing', 'binary_mismatch', 'initial_source_incomplete', 'collection_failed'].includes(
      failure
    )
  )
    invalidateCompatibility(store, compatibility, 'contract_failed');
  const state = failure === 'stop_requested' ? 'stopped' : failure ? 'failed' : 'completed';
  if (failure && failure !== 'stop_requested' && session) {
    try {
      // A successful snapshot includes records at its millisecond boundary.
      // Later loss starts at the next representable time, preserving those rows.
      const lostFrom = metadataReady ? new Date(Date.parse(lastVerifiedAt) + 1).toISOString() : baselineAt;
      const lostUntil = new Date(Math.max(Date.now(), Date.parse(lostFrom))).toISOString();
      recordObservationGap(store, c.taskId, session, lostFrom, lostUntil, 'source_error');
    } catch {
      /* Scope loss forbids further measurement writes. */
    }
  }
  const finalDiagnostic = CodexWorkflowDiagnosticSchema.nullable().parse(diagnostic);
  store.execute("UPDATE codex_workflow_runs SET state=?,reason=?,diagnostic_stage=?,diagnostic_code=?,ended_at=? WHERE id=? AND state='running'", [
    state,
    failure,
    finalDiagnostic?.stage ?? null,
    finalDiagnostic?.code ?? null,
    new Date().toISOString(),
    e.run_id
  ]);
  const run = codexWorkflowRun(store, e.run_id);
  return {
    run_id: e.run_id,
    session_id: session,
    state,
    reason: failure,
    diagnostic: finalDiagnostic,
    observed_requests: run?.observed_requests ?? 0,
    harness_application: run?.application === 'pending' ? 'unapplied' : application,
    // link/collect observe a process the adapter did not start; it may still be running.
    ...(e.operation === 'launch' || e.operation === 'resume' ? { process_started: child?.pid !== undefined } : {})
  };
}
