import { applicationRequired, requireApplication, assertAppliedHarness, applicationEvidence } from './harness-application.js';
import { relative } from 'node:path';
import { readRepositoryFile, hashBytes, readHarness } from './harness-config.js';
import { assertSharedTask, configurationIntegrityFailed } from './local-web-shared-guard.js';
import { randomUUID } from 'node:crypto';
import { AssignedWorkflowInputSchema, prepareAssignedWorkflow, runAssignedWorkflow, workflowTaskStatus, type WorkflowAdapter } from './task-workflow.js';
import { CodexWorkflowExecutionSchema, createCodexWorkflowAdapter } from './codex-workflow-adapter.js';
import { codexWorkflowProfileId } from './codex-workflow-journal.js';
import { comparisonProtocol, protocolRow } from './comparison.js';
import { selectedArtifactSnapshot } from './config-confirmation.js';
import { Lifecycle, utcNow, type Clock } from './lifecycle.js';
import { IdSchema } from './contracts.js';
import { recordAbandonedRunGap } from './runtime-history.js';
import { ExternalPreparationSpecSchema, applyManagedHarness, managedHarnessDigest, sha256, verifyCommonArtifacts, type ExternalPreparationSpec } from './harness-managed-file.js';
import type { Store } from './store.js';
import { externalContract } from './external-session-contract.js';
import { codexHumanPilotProfileId, isHumanPilotProtocol } from './session-binding-human-pilot.js';
import { codexBindingQualificationVersions } from './codex-binding-qualification-versions.js';
import { isAdmittedCodexBindingProtocol } from './codex-binding-admission.js';

interface PreparationRow {
  task_id: string; project_id: string; revision: string; configuration_digest: string;
  active_digest: string; state: string; prepared_at: string; first_connected_at: string | null; reason_code: string | null;
}

function rowFor(store: Store, taskId: string): PreparationRow {
  const row = store.get<PreparationRow>('SELECT * FROM external_preparations WHERE task_id=?', [IdSchema.parse(taskId)]);
  if (!row) throw new Error('external_preparation_required');
  return row;
}
function rootFor(store: Store, projectId: string): string {
  const root = store.get<{local_root: string | null}>('SELECT local_root FROM projects WHERE id=?', [projectId])?.local_root;
  if (!root) throw new Error('unknown_project');
  return root;
}
function surfaceKey(root: string): string { return sha256(root); }
function configurationDigest(input: ReturnType<typeof AssignedWorkflowInputSchema.parse>, spec: ExternalPreparationSpec): string {
  return sha256(JSON.stringify({ artifacts: input.artifacts, product_version: input.product_version, spec }));
}
function assertExternalProfile(store: Store, input: ReturnType<typeof AssignedWorkflowInputSchema.parse>, preparationOnly = false): void {
  const protocol = comparisonProtocol(store, protocolRow(store, input.assignment.protocol_id));
  if (protocol.purpose === 'synthetic_validation') return;
  if (preparationOnly && protocol.schema_version === 2 && isAdmittedCodexBindingProtocol(protocol) &&
      input.assignment.metadata.product === 'codex' &&
      input.product_version === protocol.source_profiles[0]?.product_version) return;
  if (preparationOnly && protocol.schema_version === 2 && isHumanPilotProtocol(protocol) && input.assignment.metadata.product === protocol.source_profiles[0]!.product && input.product_version === protocol.source_profiles[0]!.product_version) return;
  if (preparationOnly && protocol.schema_version === 2 && protocol.purpose === 'functional_pilot' &&
      input.assignment.metadata.product === 'codex' && codexBindingQualificationVersions.some(version => version === input.product_version) &&
      protocol.source_profiles.length === 1 && protocol.source_profiles.every(p => p.product === 'codex' &&
        p.product_version === input.product_version && p.profile_id === codexWorkflowProfileId)) return;
  if (protocol.schema_version !== 2 || input.assignment.metadata.product !== 'codex' || input.product_version !== '0.160.0' ||
      protocol.source_profiles.some(p => p.product !== 'codex' || p.product_version !== '0.160.0' ||
        (p.profile_id !== codexWorkflowProfileId && !(preparationOnly && protocol.purpose === 'functional_pilot' && p.profile_id === codexHumanPilotProfileId)))) throw new Error('external_source_unsupported');
}

/** Input confirmation is not native loading. No source read, activation or spawn. */
export function prepareExternalWorkflow(store: Store, input: unknown, runtime: unknown, specInput: unknown, apply = false, clock: Clock = utcNow) {
  const config = AssignedWorkflowInputSchema.parse(input); const spec = ExternalPreparationSpecSchema.parse(specInput);
  if (store.get("SELECT 1 FROM tombstones WHERE (kind='task' AND id=?) OR (kind='project' AND id=?)", [config.assignment.task_id, config.assignment.project_id])) throw new Error('deleted_identifier');
  assertExternalProfile(store, config, true);
  const root = rootFor(store, config.assignment.project_id); const key = surfaceKey(root);
  const oldTask = store.get<{task_id: string}>('SELECT task_id FROM comparison_identity_keys WHERE project_id=? AND key_id=?', [config.assignment.project_id, config.assignment.logical_task_id])?.task_id ?? config.assignment.task_id;
  const owner = store.get<{task_id: string}>('SELECT task_id FROM external_surface_leases WHERE surface_key=?', [key]);
  if (owner && owner.task_id !== oldTask) throw new Error('external_surface_busy');
  const previous = store.get<PreparationRow>('SELECT * FROM external_preparations WHERE task_id=?', [oldTask]);
  if (apply && previous?.first_connected_at && previous.state !== 'released') throw new Error('external_stop_acknowledgement_required');
  const prepared = prepareAssignedWorkflow(store, config, runtime, clock);
  const taskId = prepared.receipt.task_id;
  // Assignment must exist for selected-arm verification, which precedes every
  // managed-file write, including recovered reservations and direct CLI calls.
  assertSharedTask(store,taskId,clock,true);
  const activeDigest = sha256(prepared.instructions.map(a => a.content).join('\n\n'));
  const configDigest = configurationDigest(config, spec); const now = clock();
  store.immediateTransaction(() => {
    const currentOwner = store.get<{task_id: string}>('SELECT task_id FROM external_surface_leases WHERE surface_key=?', [key]);
    if (currentOwner && currentOwner.task_id !== taskId) throw new Error('external_surface_busy');
    const current = store.get<PreparationRow>('SELECT * FROM external_preparations WHERE task_id=?', [taskId]);
    if (current?.first_connected_at && current.state !== 'released' && current.configuration_digest !== configDigest) throw new Error('external_stop_acknowledgement_required');
    store.execute(`INSERT INTO external_preparations(task_id,project_id,revision,configuration_digest,active_digest,state,prepared_at)
      VALUES (?,?,?,?,?,'assigned',?) ON CONFLICT(task_id) DO UPDATE SET revision=excluded.revision,configuration_digest=excluded.configuration_digest,
      active_digest=excluded.active_digest,state='assigned',prepared_at=excluded.prepared_at,reason_code=NULL`,
    [taskId, config.assignment.project_id, randomUUID(), configDigest, activeDigest, now]);
    store.execute('INSERT OR IGNORE INTO external_surface_leases(surface_key,task_id) VALUES (?,?)', [key, taskId]);
  });
  try {
    // A task converted to agent application keeps that authority when re-prepared from its original setup.
    if(!config.application&&applicationRequired(store,taskId)){
      if(apply)throw new Error('application_required');
      store.execute("UPDATE external_preparations SET state='preparation_needed',reason_code=NULL WHERE task_id=?",[taskId]);
      return externalWorkflowState(store,taskId);
    }
    if(config.application){
      if(apply)throw new Error('application_required');
      const selected=config.application.bundles.find(b=>b.variant_id===prepared.receipt.assigned_variant_id);
      if(!selected||config.application.origin!==root||readHarness(root,selected.path).instruction_manifest_hash!==prepared.receipt.instruction_manifest_hash)throw new Error('application_input_changed');
      if(!applicationRequired(store,taskId))verifyCommonArtifacts(spec);
      if(!applicationRequired(store,taskId))requireApplication(store,taskId,{origin:root,bundlePath:selected.path,bundleHash:selected.bundle_hash,...(!applicationRequired(store,taskId)?{common:spec.common_artifacts.map(file=>{const path=relative(root,file.path);return {path,hash:hashBytes(readRepositoryFile(root,path))};})}:{})});
      store.execute("UPDATE external_preparations SET state='preparation_needed',reason_code=NULL WHERE task_id=?",[taskId]);
      return externalWorkflowState(store,taskId);
    }
    verifyCommonArtifacts(spec);
    if (apply) {
      store.execute("UPDATE external_preparations SET state='applying' WHERE task_id=?", [taskId]);
      applyManagedHarness(root, prepared.instructions.map(a => a.content).join('\n\n'), spec);
    }
    const state = managedHarnessDigest(root) === activeDigest ? 'configuration_verified' : 'preparation_needed';
    store.execute('UPDATE external_preparations SET state=?,reason_code=NULL WHERE task_id=?', [state, taskId]);
    return externalWorkflowState(store, taskId);
  } catch (error) {
    store.execute("UPDATE external_preparations SET state='recovery_needed',reason_code='preparation_failed' WHERE task_id=?", [taskId]);
    throw error;
  }
}

function configurationChanged(store: Store, taskId: string, clock: Clock): never {
  const now = clock();
  store.immediateTransaction(() => {
    store.execute("UPDATE external_preparations SET state='configuration_changed',reason_code='external_configuration_drift' WHERE task_id=?", [taskId]);
    const life = new Lifecycle(store, clock);
    if (life.state(taskId) === 'active') {
      // Start uncertainty at the latest observation boundary, never at an old
      // completed run's start (which would reclassify already observed usage).
      for (const run of store.all<{session_id: string; started_at: string}>(`SELECT session_id,
        max(CASE WHEN state='running' THEN started_at ELSE coalesce(ended_at,started_at) END) AS started_at
        FROM codex_workflow_runs WHERE task_id=? AND session_id IS NOT NULL GROUP BY session_id`, [taskId])) {
        recordAbandonedRunGap(store, taskId, run.session_id, run.started_at, now);
      }
      life.pause(taskId);
    }
  });
  throw new Error('external_configuration_drift');
}

export function assertExternalPrepared(store: Store, taskId: string, config: ReturnType<typeof AssignedWorkflowInputSchema.parse>, spec: ExternalPreparationSpec, clock: Clock): void {
  assertSharedTask(store, taskId, clock);
  if(config.application || applicationRequired(store,taskId)){try{assertAppliedHarness(store,taskId);}catch(error){configurationIntegrityFailed(store,taskId,clock,error);}return;}
  const row = rowFor(store, taskId); const root = rootFor(store, row.project_id);
  if (store.get<{task_id: string}>('SELECT task_id FROM external_surface_leases WHERE surface_key=?', [surfaceKey(root)])?.task_id !== taskId ||
      ['released', 'assigned', 'preparation_needed', 'applying', 'recovery_needed'].includes(row.state)) throw new Error('external_preparation_required');
  try {
    if (row.configuration_digest !== configurationDigest(config, spec)) throw new Error('external_configuration_drift');
    verifyCommonArtifacts(spec);
    const variant = store.get<{variant_id: string}>('SELECT variant_id FROM comparison_assignments WHERE task_id=?', [taskId])?.variant_id;
    const selected = config.artifacts.find(a => a.variant_id === variant);
    if (!selected || sha256(selectedArtifactSnapshot(selected.selected_artifacts.map(a => ({artifactId: a.artifact_id, path: a.path}))).instructions.map(a => a.content).join('\n\n')) !== row.active_digest ||
        managedHarnessDigest(root) !== row.active_digest) throw new Error('external_configuration_drift');
  } catch { configurationChanged(store, taskId, clock); }
}

/** Only explicit root link/collect. Existing adapter owns linkage/baseline/dedup. */
export async function runExternalWorkflow(store: Store, input: unknown, executionInput: unknown, runtime: unknown, specInput: unknown, suppliedAdapter?: WorkflowAdapter, clock: Clock = utcNow) {
  const config = AssignedWorkflowInputSchema.parse(input); const spec = ExternalPreparationSpecSchema.parse(specInput);
  const execution = CodexWorkflowExecutionSchema.parse(executionInput);
  if (!['link', 'collect'].includes(execution.operation) || execution.direct_child || execution.child_runtime) throw new Error('external_operation_unsupported');
  assertExternalProfile(store, config);
  const taskId = store.get<{task_id: string}>('SELECT task_id FROM comparison_identity_keys WHERE project_id=? AND key_id=?', [config.assignment.project_id, config.assignment.logical_task_id])?.task_id ?? config.assignment.task_id;
  if (externalContract(store,taskId) && suppliedAdapter?.externalContractCoordinator !== true) throw new Error('timing_contract_mismatch');
  assertExternalPrepared(store, taskId, config, spec, clock);
  const adapter = suppliedAdapter ?? createCodexWorkflowAdapter(store, execution);
  const wrapped: WorkflowAdapter = {
    ...(adapter.externalContractCoordinator ? {externalContractCoordinator: true as const} : {}),
    product: adapter.product, productVersion: adapter.productVersion, profileId: adapter.profileId,
    async preflight(requested) { await adapter.preflight?.(requested); assertExternalPrepared(store, taskId, config, spec, clock); },
    async run(context) {
      const result = await adapter.run({ ...context, assertActive() {
        context.assertActive(); assertExternalPrepared(store, taskId, config, spec, clock);
        if (execution.operation === 'collect') {
          const verified = store.get<{source_identity: string | null}>('SELECT source_identity FROM codex_workflow_runs WHERE id=?', [execution.run_id]);
          if (verified?.source_identity) store.execute("UPDATE external_preparations SET state='measuring' WHERE task_id=?", [taskId]);
        }
      }});
      // Adapter read transactions may roll back the in-read pause; persist the
      // shared fence again outside them before accepting a terminal receipt.
      assertSharedTask(store,taskId,clock);
      return result;
    },
  };
  try {
    if (execution.operation === 'link') store.execute("UPDATE external_preparations SET state='waiting_connection' WHERE task_id=?", [taskId]);
    const result = await runAssignedWorkflow(store, config, wrapped, runtime, clock);
    const journal = store.get<{scope_verified: number; identity_verified: number; ended_at: string | null}>('SELECT scope_verified,identity_verified,ended_at FROM codex_workflow_runs WHERE id=?', [execution.run_id]);
    if (result.adapter_result?.state === 'completed' && journal?.scope_verified === 1 && journal.identity_verified === 1) {
      if (!externalContract(store,taskId)) store.execute('UPDATE external_preparations SET first_connected_at=COALESCE(first_connected_at,?),state=? WHERE task_id=?',
        [journal.ended_at, 'connected', taskId]);
    } else store.execute("UPDATE external_preparations SET state='stopped' WHERE task_id=?", [taskId]);
    if (result.adapter_result?.state === 'failed' && new Lifecycle(store, clock).state(taskId) === 'active') new Lifecycle(store, clock).pause(taskId);
    return { ...result, preparation: externalWorkflowState(store, taskId) };
  } catch (error) {
    assertSharedTask(store,taskId,clock);
    if (rowFor(store, taskId).state === 'configuration_changed') {
      // Producer details may contain source text or paths; retain only a fixed code.
      // eslint-disable-next-line preserve-caught-error
      throw new Error('external_configuration_drift');
    }
    store.execute("UPDATE external_preparations SET state='stopped',reason_code='external_observation_failed' WHERE task_id=?", [taskId]);
    throw error;
  }
}

export function externalWorkflowState(store: Store, taskId: string) {
  const row = rowFor(store, taskId); const task = workflowTaskStatus(store, taskId);
  return { schema_version: 1, task_id: taskId, assigned_variant_id: task.assigned_variant_id, revision: row.revision,
    ...(applicationRequired(store,taskId)?{application_evidence:applicationEvidence(store,taskId)}:{}),
    state: row.state, task_state: task.state, first_connected_at: row.first_connected_at,
    files_evidence: ['configuration_verified', 'waiting_connection', 'connected', 'measuring', 'stopped'].includes(row.state) ? 'verified_at_preparation' : 'unverified',
    loading_evidence: 'unverified' as const, freshness_evidence: 'unverified' as const, tool_use_evidence: 'unavailable' as const,
    comparison_followup_ends_at: task.followup_ends_at, comparison_clock: 'assignment' as const,
    cost_coverage: 'partial' as const, complete_cost: null, reason_code: row.reason_code,
    next_action: row.state === 'configuration_verified' || (row.state === 'stopped' && !row.first_connected_at) ? 'open_new_agent_session_then_connect' : row.state === 'connected' || (row.state === 'stopped' && row.first_connected_at) ? 'collect_linked_session' : row.state === 'preparation_needed' ? 'prepare_managed_file' : null,
  };
}

/** Operator acknowledgement; collector stop does not prove external AI exit. */
export function releaseExternalWorkflow(store: Store, taskId: string, externalSessionStopped: boolean, clock: Clock = utcNow) {
  if (!externalSessionStopped) throw new Error('external_stop_acknowledgement_required');
  rowFor(store, taskId);
  return store.immediateTransaction(() => {
    if (store.get("SELECT 1 FROM codex_workflow_runs WHERE task_id=? AND state='running' UNION ALL SELECT 1 FROM claude_workflow_runs WHERE task_id=? AND state='running'", [taskId, taskId])) throw new Error('workflow_run_active');
    const life = new Lifecycle(store, clock); if (life.state(taskId) === 'active') life.pause(taskId);
    store.execute('DELETE FROM external_surface_leases WHERE task_id=?', [taskId]);
    store.execute("UPDATE external_preparations SET state='released' WHERE task_id=?", [taskId]);
    return externalWorkflowState(store, taskId);
  });
}
