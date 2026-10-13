import { applicationRequired, assertAppliedHarness } from './harness-application.js';
import { resolveSourceCompatibility, effectiveSourceCompatibility } from './source-compatibility.js';
import { z } from 'zod';
import { assignTask } from './allocation.js';
import type { AssignmentRow } from './allocation.js';
import { IdSchema, ModelSchema, ProductVersionSchema } from './contracts.js';
import { ConfigurationRecordSchema, parseComparison } from './comparison-contracts.js';
import { FlexibleAssignmentInputSchema } from './flexible-contracts.js';
import { comparisonProtocol, comparisonVariant, protocolRow } from './comparison.js';
import { confirmConfiguration, requireConfigurationConfirmation, selectedArtifactSnapshot } from './config-confirmation.js';
import { Lifecycle, utcNow } from './lifecycle.js';
import type { Clock, Outcome } from './lifecycle.js';
import { comparisonReadiness, functionalWorkflowEligible } from './readiness-store.js';
import { productionSourceEvidence, syntheticSourceEvidence } from './readiness.js';
import type { Store } from './store.js';
import { claudeWorkflowProfileId, isClaudeWorkflowProductVersion } from './claude-workflow-versions.js';
import { externalContract } from './external-session-contract.js';
import { isHumanPilotProtocol } from './session-binding-human-pilot.js';
import { isAdmittedCodexBindingProtocol } from './codex-binding-admission.js';

const artifactSchema = z.strictObject({ artifact_id: IdSchema, path: z.string().min(1).max(4096) });
export const AssignedWorkflowInputSchema = z.strictObject({ schema_version: z.literal(1),
  application: z.strictObject({schema_version:z.literal(2),mode:z.literal('agent_applied'),origin:z.string(),bundles:z.array(z.strictObject({variant_id:IdSchema,path:z.string(),bundle_hash:z.string().regex(/^[a-f0-9]{64}$/)})).length(2)}).optional(),
  assignment: FlexibleAssignmentInputSchema, product_version: ProductVersionSchema, confirmation_id: IdSchema,
  artifacts: z.array(z.strictObject({ variant_id: IdSchema, selected_artifacts: z.array(artifactSchema).min(1).max(256) })).length(2)
    .refine(rows => new Set(rows.map(row => row.variant_id)).size === rows.length) });
export const WorkflowRuntimeSchema = z.strictObject({ model: ModelSchema.nullable(), effort: IdSchema.nullable() });
export type WorkflowRuntime = z.infer<typeof WorkflowRuntimeSchema>;
export interface WorkflowExecutionContext {
  projectId: string; projectRoot: string; taskId: string; generation: number;
  assignedVariantId: string; confirmationId: string;
  instructionManifestHash: string;
  runtime: WorkflowRuntime; instructions: { artifact_id: string; content: string }[];
  /** Recheck before every source read, launch and observation boundary. */
  assertActive(): void;
  /** Trusted external coordinator only; receives hashes after native scope gates. */
  externalStartup?: {
    expectation: import('./external-session-context.js').ExternalStartupExpectation;
    verify(evidence: import('./external-session-context.js').ExternalContextEvidence & {sessionId: string; sourceIdentity: string}): void;
  };
}
/** Trusted code adapter, not a user-configured script or admission flag.
 * Owns per-invocation application, pre-access linkage, collection and teardown.
 * Native execution remains gated by the code-owned qualification registry.
 */
export interface WorkflowAdapter {
  /** Trusted new external coordinator; never an input-schema admission flag. */
  externalContractCoordinator?: true;
  product: 'synthetic' | 'codex' | 'claude_code'; productVersion: string; profileId: string;
  /** Local file and qualification checks before assignment or task activation.
   * Never launches a product, reads session sources or writes measurement data. */
  preflight?(runtime: WorkflowRuntime, scope?: { projectRoot: string | null }): void | Promise<void>;
  /** Throwing means no native process was started; return a result otherwise. */
  run(context: WorkflowExecutionContext): Promise<void | WorkflowAdapterResult>;
}
export interface WorkflowAdapterResult {
  diagnostic?:import('./codex-workflow-adapter.js').CodexWorkflowDiagnostic|null;
  run_id:string;session_id:string|null;state:'completed'|'failed'|'stopped';reason:string|null;
  observed_requests:number;harness_application:'invocation_settings_verified'|'external_unverified'|'unapplied';
  /** False only when the adapter is certain no native process ran for this invocation;
   * omitted when one may exist outside the adapter (link/collect). */
  process_started?:boolean;
}
/** Fixed adapter failure codes that are safe to surface. Anything else is
 * replaced by the generic fallback so producer text never escapes. */
const workflowAdapterCodes = new Set(['binary_mismatch', 'binary_unreadable', 'invalid_hook_recorder', 'invalid_prompt', 'unsafe_home',
  'compatibility_invalidated', 'invalid_execution', 'codex_workflow_source_unqualified', 'codex_workflow_child_operation_unsupported', 'codex_workflow_child_binding_invalid',
  'synthetic_store_required', 'workflow_run_active', 'claude_probe_executable_mismatch', 'claude_workflow_prompt_failed',
  'claude_workflow_effort_unsupported', 'claude_workflow_already_reserved', 'claude_workflow_child_unadmitted', 'claude_workflow_harness_inside_project', 'claude_workflow_private_workspace_required', 'claude_workflow_source_conflict', 'candidate_mixed_sources']);
function workflowAdapterCode(error: unknown, fallback: string): string {
  try { return error instanceof Error && workflowAdapterCodes.has(error.message) ? error.message : fallback; }
  catch { return fallback; }
}

function workflowProtocol(store: Store, protocolId: string) {
  const protocol = comparisonProtocol(store, protocolRow(store, protocolId));
  if (protocol.schema_version !== 2) throw new Error('unsupported_workflow_mode');
  return protocol;
}
function checkReadiness(store: Store, protocolId: string, at: string, preparationOnly = false) {
  const protocol = workflowProtocol(store, protocolId);
  if (!preparationOnly && isAdmittedCodexBindingProtocol(protocol)) throw new Error('native_source_unqualified');
  if (protocol.purpose !== 'synthetic_validation' && !comparisonReadiness(store, protocolId, at).real_allocation && !functionalWorkflowEligible(store,protocol) && !(preparationOnly&&isHumanPilotProtocol(protocol))) throw new Error('real_experiment_disabled');
  return protocol;
}

/** Persist original assignment before revealing/reading selected instruction bytes.
 * Returns private transient application data separately from the printable receipt.
 */
export function beginAssignedWorkflow(store: Store, input: unknown, runtimeInput: unknown, clock: Clock = utcNow, externalCoordinator = false) {
  const config=AssignedWorkflowInputSchema.parse(input);
  const taskId=store.get<{task_id:string}>('SELECT task_id FROM comparison_identity_keys WHERE project_id=? AND key_id=?',[config.assignment.project_id,config.assignment.logical_task_id])?.task_id??config.assignment.task_id;
  if(externalContract(store,taskId)&&!externalCoordinator)throw new Error('timing_contract_mismatch');
  return prepareWorkflow(store, input, runtimeInput, clock, true);
}

/** Assign and confirm selected input bytes without starting an active interval. */
export function prepareAssignedWorkflow(store: Store, input: unknown, runtimeInput: unknown, clock: Clock = utcNow) {
  return prepareWorkflow(store, input, runtimeInput, clock, false);
}

function prepareWorkflow(store: Store, input: unknown, runtimeInput: unknown, clock: Clock, activate: boolean) {
  const config = parseComparison(AssignedWorkflowInputSchema, input, 'invalid_workflow_input');
  if(activate && (config.application || applicationRequired(store,config.assignment.task_id)))assertAppliedHarness(store,config.assignment.task_id);
  const runtime = parseComparison(WorkflowRuntimeSchema, runtimeInput, 'invalid_workflow_runtime');
  const now = clock(); const requested = checkReadiness(store, config.assignment.protocol_id, now, !activate);
  if (config.artifacts.some(row => !requested.variant_ids.includes(row.variant_id)) ||
      !requested.source_profiles.some(row => row.product === config.assignment.metadata.product && row.product_version === config.product_version)) throw new Error('workflow_configuration_mismatch');
  const assignment = assignTask(store, config.assignment, { clock: () => now, pilotPreparation: !activate&&isHumanPilotProtocol(requested) });
  const protocol = checkReadiness(store, assignment.protocol_id, now, !activate);
  if (protocol.id !== requested.id) throw new Error('workflow_protocol_mismatch');
  const life = new Lifecycle(store, () => now); const task = life.task(assignment.task_id);
  if (task.state === 'finalized') throw new Error('invalid_transition');
  if(store.get("SELECT 1 FROM codex_workflow_runs WHERE task_id=? AND state='running' UNION ALL SELECT 1 FROM claude_workflow_runs WHERE task_id=? AND state='running'",[assignment.task_id,assignment.task_id]))throw new Error('workflow_run_active');
  const selected = config.artifacts.find(row => row.variant_id === assignment.assigned_variant_id);
  if (!selected) throw new Error('workflow_configuration_mismatch');
  const artifacts = selected.selected_artifacts.map(row => ({ artifactId: row.artifact_id, path: row.path }));
  const snapshot = selectedArtifactSnapshot(artifacts);
  const variant = comparisonVariant(store, assignment.assigned_variant_id);
  if (snapshot.hash !== variant.instruction_manifest_hash) throw new Error('workflow_manifest_mismatch');
  let activated = false;
  store.immediateTransaction(() => {
    confirmConfiguration(store, { schema_version: 1, id: config.confirmation_id, task_id: assignment.task_id,
      evidence_method: 'selected_artifact_hash', actual_variant_id: assignment.assigned_variant_id,
      product: config.assignment.metadata.product, product_version: config.product_version,
      model: runtime.model, reasoning_setting: runtime.effort, environment_id: config.assignment.environment_id }, now, artifacts);
    const confirmation = store.get<{ payload: string }>('SELECT payload FROM comparison_confirmations WHERE id=?', [config.confirmation_id]);
    const record = parseComparison(ConfigurationRecordSchema, JSON.parse(confirmation?.payload ?? 'null') as unknown, 'workflow_manifest_mismatch');
    if (record.verification_status !== 'confirmed' || record.observed_config_hash !== snapshot.hash) throw new Error('workflow_manifest_mismatch');
    const state = life.state(assignment.task_id);
    if (activate) {
      if (state === 'registered') life.start(assignment.task_id);
      else if (state === 'paused') life.resume(assignment.task_id);
      else if (state !== 'active') throw new Error('invalid_transition');
      activated = state !== 'active';
    }
    requireConfigurationConfirmation(store, assignment.task_id, now);
  });
  const current = life.task(assignment.task_id);
  return { receipt: { ...assignment, confirmation_id: config.confirmation_id, generation: current.generation,
    state: current.state, instruction_manifest_hash: snapshot.hash, harness_application: 'prepared_only' as const,
    complete_cost: null, inference: false }, instructions: config.application ? [] : snapshot.instructions, activated };
}

/** No native calls occur unless a matching code-owned real source qualifies.
 * Adapter return is not human success or proof of complete usage collection.
 */
export async function runAssignedWorkflow(store: Store, input: unknown, adapter: WorkflowAdapter,
  runtimeInput: unknown, clock: Clock = utcNow) {
  const config = parseComparison(AssignedWorkflowInputSchema, input, 'invalid_workflow_input');
  const existingTaskId=store.get<{task_id:string}>('SELECT task_id FROM comparison_identity_keys WHERE project_id=? AND key_id=?',[config.assignment.project_id,config.assignment.logical_task_id])?.task_id??config.assignment.task_id;
  if (externalContract(store,existingTaskId) && adapter.externalContractCoordinator !== true) throw new Error('timing_contract_mismatch');
  if(config.application || applicationRequired(store,existingTaskId))throw new Error('application_source_unqualified');
  const runtime = parseComparison(WorkflowRuntimeSchema, runtimeInput, 'invalid_workflow_runtime');
  const protocol = checkReadiness(store, config.assignment.protocol_id, clock());
  const registry = protocol.purpose !== 'synthetic_validation' ? productionSourceEvidence : syntheticSourceEvidence;
  const adapterProfileId=adapter.profileId;
  if (adapter.product !== config.assignment.metadata.product || adapter.productVersion !== config.product_version ||
      (!registry.some(row => row.product === adapter.product && row.product_version === adapter.productVersion && row.profile_id === adapterProfileId) && !functionalWorkflowEligible(store,protocol)) ||
      !protocol.source_profiles.some(row => row.product === adapter.product && row.product_version === adapter.productVersion && row.profile_id === adapterProfileId) ||
      (protocol.purpose === 'synthetic_validation' && adapter.product !== 'synthetic')) throw new Error('workflow_adapter_mismatch');
  // Environment checks precede assignment so a broken binary, recorder or prompt
  // never enrolls the task, starts its first attempt or opens an active interval.
  const registeredRoot = store.get<{ local_root: string | null }>('SELECT local_root FROM projects WHERE id=?', [config.assignment.project_id])?.local_root ?? null;
  try { await adapter.preflight?.(runtime, { projectRoot: registeredRoot }); }
  // Only allowlisted fixed codes survive; producer text and paths are dropped.
  // eslint-disable-next-line preserve-caught-error
  catch (error) { throw new Error(workflowAdapterCode(error, 'workflow_preflight_failed')); }
  const prepared = beginAssignedWorkflow(store, config, runtime, clock,adapter.externalContractCoordinator===true);
  const taskId = prepared.receipt.task_id; const generation = prepared.receipt.generation;
  const projectId = config.assignment.project_id;
  const projectRoot = store.get<{ local_root: string | null }>('SELECT local_root FROM projects WHERE id=?', [projectId])?.local_root;
  if (!projectRoot) throw new Error('workflow_scope_revoked');
  const assertScope = () => {
    workflowProtocol(store,prepared.receipt.protocol_id);
    if(adapter.profileId!==adapterProfileId)throw new Error('workflow_scope_revoked');
    const task = store.get<{ state: string; generation: number; project_id: string }>('SELECT state,generation,project_id FROM tasks WHERE id=?', [taskId]);
    const project = store.get<{ local_root: string | null }>('SELECT local_root FROM projects WHERE id=?', [projectId]);
    if (task?.state !== 'active' || task.generation !== generation || task.project_id !== projectId || project?.local_root !== projectRoot ||
        store.get("SELECT 1 FROM tombstones WHERE (kind='task' AND id=?) OR (kind='project' AND id=?)", [taskId, projectId])) throw new Error('workflow_scope_revoked');
    requireConfigurationConfirmation(store, taskId, clock());
    const latest=store.get<{id:string;payload:string}>('SELECT id,payload FROM comparison_confirmations WHERE task_id=? ORDER BY rowid DESC LIMIT 1',[taskId]);
    const confirmation=latest&&ConfigurationRecordSchema.parse(JSON.parse(latest.payload));
    if(latest?.id!==config.confirmation_id||confirmation?.verification_status!=='confirmed'||confirmation.observed_config_hash!==prepared.receipt.instruction_manifest_hash)throw new Error('workflow_scope_revoked');
  };
  const assertActive=()=>{checkReadiness(store,prepared.receipt.protocol_id,clock());assertScope();};
  // Pause only an activation made by this invocation, atomically, while the same
  // generation is active, this invocation's confirmation is the latest and no
  // other run is in progress; nothing native ran, so no active time accrues.
  const revertActivation = () => prepared.activated && store.immediateTransaction(() => {
    const task = store.get<{ state: string; generation: number }>('SELECT state,generation FROM tasks WHERE id=?', [taskId]);
    const latest = store.get<{ id: string }>('SELECT id FROM comparison_confirmations WHERE task_id=? ORDER BY rowid DESC LIMIT 1', [taskId]);
    if (task?.state !== 'active' || task.generation !== generation || latest?.id !== config.confirmation_id ||
        store.get("SELECT 1 FROM codex_workflow_runs WHERE task_id=? AND state='running' UNION ALL SELECT 1 FROM claude_workflow_runs WHERE task_id=? AND state='running'", [taskId, taskId])) return false;
    new Lifecycle(store, clock).pause(taskId); return true;
  });
  assertActive();
  let adapterResult: void | WorkflowAdapterResult;
  try { adapterResult = await adapter.run({ taskId, projectId, projectRoot, generation, assignedVariantId: prepared.receipt.assigned_variant_id,
    confirmationId: config.confirmation_id, instructionManifestHash:prepared.receipt.instruction_manifest_hash, runtime, instructions: prepared.instructions, assertActive }); }
  catch (error) {
    try { revertActivation(); } catch { /* the adapter failure remains the reported error */ }
    // eslint-disable-next-line preserve-caught-error
    throw new Error(workflowAdapterCode(error, 'workflow_adapter_failed'));
  }
  // process_started is false only when the adapter knows no native process ran.
  const reverted = !!adapterResult && adapterResult.state === 'failed' && adapterResult.process_started === false && revertActivation();
  // A failed contract may have blocked its source cohort; retain the terminal receipt
  // while still enforcing lifecycle, protocol, confirmation and project scope.
  if (!reverted) {if(adapterResult&&adapterResult.state!=='completed')assertScope();else assertActive();}
  const current = reverted ? new Lifecycle(store, clock).task(taskId) : undefined;
  return { ...prepared.receipt, ...(current ? { state: current.state, generation: current.generation } : {}),
    activation_reverted: reverted, execution: 'adapter_returned' as const, outcome: null,
    ...(adapterResult ? {adapter_result:adapterResult} : {}),
    limitations: ['adapter_return_does_not_prove_native_collection', 'human_finalization_required', 'whole_task_cost_unconfirmed'] };
}

export function finishAssignedWorkflow(store: Store, taskId: string, outcome: Outcome, criteria: string[], clock: Clock = utcNow) {
  parseComparison(IdSchema, taskId);
  if (externalContract(store,taskId)) throw new Error('timing_contract_mismatch');
  return store.immediateTransaction(() => {
    const assignment = store.get<AssignmentRow>('SELECT * FROM comparison_assignments WHERE task_id=?', [taskId]);
    if (!assignment) throw new Error('task_not_assigned');
    new Lifecycle(store, clock).finalize(taskId, outcome, criteria);
    const assessedAt = store.get<{ assessed_at: string }>('SELECT assessed_at FROM outcomes WHERE task_id=?', [taskId])!.assessed_at;
    // ADR 008: the endpoint ends at the follow-up deadline. A later outcome is
    // stored but never repairs deadline status; say so at the moment it is made.
    const counted = Date.parse(assessedAt) < Date.parse(assignment.followup_ends_at);
    return { task_id: taskId, assigned_variant_id: assignment.variant_id, protocol_id: assignment.protocol_id,
      outcome, assessed_at: assessedAt, followup_ends_at: assignment.followup_ends_at, counted_in_deadline_status: counted,
      warnings: counted ? [] : ['assessment_after_followup_deadline' as const], comparison_snapshot: 'explicit_later_cutoff_required' as const };
  });
}

export function workflowStatus(store: Store, protocolId: string, at = utcNow()) {
  const protocol = workflowProtocol(store, protocolId); const readiness = comparisonReadiness(store, protocolId, at);
  const implemented=protocol.source_profiles.some(p=>p.product==='codex'&&resolveSourceCompatibility(p.product,p.product_version,'codex_workflow',p.profile_id)!==null||
    p.product==='claude_code'&&isClaudeWorkflowProductVersion(p.product_version)&&p.profile_id===claudeWorkflowProfileId);
  const sourceCompatibility=protocol.source_profiles.flatMap(p=>{
    const source=p.product==='codex'?'codex_workflow':p.product==='claude_code'?'claude_workflow':null;
    const compatibility=source&&resolveSourceCompatibility(p.product,p.product_version,source,p.profile_id);
    return compatibility?[effectiveSourceCompatibility(store,compatibility)]:[];
  });
  return { schema_version: 1, protocol_id: protocol.id, purpose: protocol.purpose, readiness, source_compatibility:sourceCompatibility,
    native_execution: implemented&&(readiness.real_allocation||functionalWorkflowEligible(store,protocol)), codex_adapter_implemented:true, claude_adapter_implemented:true, common_coordinator: true, selected_instructions: 'transient_per_invocation_boundary',
    blockers: [...(protocol.purpose !== 'synthetic_validation' && !readiness.real_allocation&&!functionalWorkflowEligible(store,protocol) ? ['native_source_unqualified'] : []),
      ...(!implemented?['native_adapter_not_wired']:[]), ...(!readiness.complete_cost ? ['whole_task_cost_unconfirmed'] : []), ...(!readiness.inference ? ['analysis_unverified'] : [])] };
}

/** Task-level view for a person running the workflow: IDs, times, run states and
 * fixed next-action codes. Never includes paths, prompts or instruction text. */
export function workflowTaskStatus(store: Store, taskId: string, at = utcNow()) {
  parseComparison(IdSchema, taskId);
  const task = new Lifecycle(store).task(taskId);
  const assignment = store.get<AssignmentRow>('SELECT * FROM comparison_assignments WHERE task_id=?', [taskId]);
  if (!assignment) throw new Error('task_not_assigned');
  const outcome = store.get<{ status: Outcome; assessed_at: string }>('SELECT status,assessed_at FROM outcomes WHERE task_id=?', [taskId]);
  const contract=externalContract(store,taskId);
  const deadline=contract?contract.ends_at:assignment.followup_ends_at;
  const open = deadline!==null && Date.parse(at) < Date.parse(deadline);
  const runs = [
    ...store.all<{ run_id: string; operation: string; state: string; reason: string | null; diagnostic_code: string | null; stop_requested: number; started_at: string; ended_at: string | null }>(
      'SELECT id AS run_id,operation,state,reason,diagnostic_code,stop_requested,started_at,ended_at FROM codex_workflow_runs WHERE task_id=?', [taskId]).map(r => ({ product: 'codex' as const, ...r })),
    ...store.all<{ run_id: string; state: string; reason: string | null; stop_requested: number; started_at: string; ended_at: string | null }>(
      'SELECT id AS run_id,state,reason,stop_requested,started_at,ended_at FROM claude_workflow_runs WHERE task_id=?', [taskId]).map(r => ({ product: 'claude_code' as const, operation: 'launch', diagnostic_code: null, ...r })),
  ].sort((a, b) => a.started_at < b.started_at ? -1 : a.started_at > b.started_at ? 1 : a.run_id < b.run_id ? -1 : 1)
    .map(r => ({ ...r, stop_requested: r.stop_requested === 1 }));
  const next: string[] = [];
  if (runs.some(r => r.state === 'running')) next.push('stop_or_recover_running_run');
  if (task.state === 'registered') next.push(contract?'external_start_then_connect':'launch');
  else if (task.state !== 'finalized') {
    if (task.state === 'paused') next.push(contract?'external_collect_or_connect_fresh_session':'continue_with_launch_or_resume');
    next.push(deadline===null?'wait_for_verified_connection':open ? 'finish_before_followup_deadline' : 'finish_now_outcome_excluded_after_deadline');
  }
  else next.push(open ? 'report_after_followup_deadline' : 'create_report');
  return { schema_version: 1, task_id: taskId, state: task.state, generation: task.generation, protocol_id: assignment.protocol_id,
    assigned_variant_id: assignment.variant_id, assigned_at: assignment.assigned_at, followup_ends_at: deadline,
    ...(contract?{timing_contract:contract.timing_contract,report_contract:contract.report_contract}:{}),
    followup: deadline===null?'pending' as const:open ? 'open' as const : 'closed' as const,
    outcome: outcome ? { status: outcome.status, assessed_at: outcome.assessed_at,
      counted_in_deadline_status: deadline!==null&&Date.parse(outcome.assessed_at) < Date.parse(deadline) } : null,
    runs, next_actions: next };
}
