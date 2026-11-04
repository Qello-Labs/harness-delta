import { applicationRequired, assertAppliedHarness } from './harness-application.js';
import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { z } from 'zod';
import { AssignedWorkflowInputSchema, WorkflowRuntimeSchema, type WorkflowAdapter } from './task-workflow.js';
import { CodexWorkflowExecutionSchema, createCodexWorkflowAdapter, pinnedCodexWorkflowBinarySha } from './codex-workflow-adapter.js';
import { createHash } from 'node:crypto';
import { stopCodexWorkflow } from './codex-workflow-journal.js';
import { IdSchema, TimestampSchema } from './contracts.js';
import { Lifecycle, utcNow, type Clock } from './lifecycle.js';
import { ExternalPreparationSpecSchema, managedHarnessContent, sha256 } from './harness/harness-managed-file.js';
import { assertExternalPrepared, prepareExternalWorkflow, runExternalWorkflow, externalWorkflowState } from './external-session-workflow.js';
import { externalContract, registerExternalContract, bindingCollectionControl } from './external-session-contract.js';
import { externalInstructionFragment, type ExternalContextEvidence } from './external-session-context.js';
import { readReferenceTaskCostReport } from './price-catalog-task-report.js';
import type { Store } from './store.js';
import { comparisonProtocol, protocolRow } from './protocol-store.js';

export const ExternalTaskSetupSchema = z.strictObject({
  workflow: AssignedWorkflowInputSchema,
  runtime: WorkflowRuntimeSchema,
  preparation: ExternalPreparationSpecSchema,
  native_binary: z
    .strictObject({ path: CodexWorkflowExecutionSchema.shape.binary.shape.path, version: z.literal('0.160.0'), sha256: z.string().regex(/^[a-f0-9]{64}$/) })
    .optional()
});
export type ExternalTaskSetup = z.infer<typeof ExternalTaskSetupSchema>;
export const ExternalTaskTemplateSchema = z.strictObject({ id: IdSchema, setup: ExternalTaskSetupSchema });
export type ExternalTaskTemplate = z.infer<typeof ExternalTaskTemplateSchema>;

/** Select only a previously reviewed template and its criterion IDs. No protocol,
 * variants, prices, defaults or source admission are invented here. */
export function buildExternalTaskSetup(
  store: Store,
  input: ExternalTaskTemplate,
  selection: { projectId: string; criterionIds?: string[] }
): ExternalTaskSetup {
  const template = ExternalTaskTemplateSchema.parse(input);
  const chosen = z.strictObject({ projectId: IdSchema, criterionIds: z.array(IdSchema).min(1).optional() }).parse(selection);
  const setup = template.setup;
  if (chosen.projectId !== setup.workflow.assignment.project_id || !store.get('SELECT id FROM projects WHERE id=?', [chosen.projectId]))
    throw new Error('workflow_configuration_mismatch');
  const row = protocolRow(store, setup.workflow.assignment.protocol_id);
  const protocol = comparisonProtocol(store, row);
  if (
    row.status !== 'frozen' ||
    protocol.project_id !== chosen.projectId ||
    protocol.schema_version !== 2 ||
    !protocol.source_profiles.some(p => p.product === setup.workflow.assignment.metadata.product && p.product_version === setup.workflow.product_version) ||
    setup.workflow.artifacts.some(a => !protocol.variant_ids.includes(a.variant_id))
  )
    throw new Error('workflow_configuration_mismatch');
  const criteria = chosen.criterionIds ?? setup.workflow.assignment.metadata.criterion_ids;
  if (new Set(criteria).size !== criteria.length || criteria.some(id => !setup.workflow.assignment.metadata.criterion_ids.includes(id)))
    throw new Error('invalid_criteria');
  return {
    ...setup,
    workflow: {
      ...setup.workflow,
      assignment: { ...setup.workflow.assignment, metadata: { ...setup.workflow.assignment.metadata, criterion_ids: [...criteria] } }
    }
  };
}
interface TicketRow {
  id: string;
  task_id: string;
  revision: string;
  fragment_hash: string;
  issued_at: string;
  session_id: string | null;
  source_identity: string | null;
  native_created_at: string | null;
  verified_at: string | null;
}
const nowAt = (clock: Clock) => new Date(TimestampSchema.parse(clock())).toISOString();
const taskIdFor = (store: Store, setup: ExternalTaskSetup) =>
  store.get<{ task_id: string }>('SELECT task_id FROM comparison_identity_keys WHERE project_id=? AND key_id=?', [
    setup.workflow.assignment.project_id,
    setup.workflow.assignment.logical_task_id
  ])?.task_id ?? setup.workflow.assignment.task_id;
const freshConfirmation = (setup: ExternalTaskSetup) => ({ ...setup.workflow, confirmation_id: randomUUID() });

/** Display labels stay in the UI's private records. The returned setup is private
 * server data, never measurement/export data or a basic-form JSON requirement. */
export function createExternalTask(store: Store, input: ExternalTaskSetup, apply = false, clock: Clock = utcNow) {
  const base = ExternalTaskSetupSchema.parse(input);
  const setup: ExternalTaskSetup = {
    ...base,
    workflow: {
      ...base.workflow,
      confirmation_id: randomUUID(),
      assignment: { ...base.workflow.assignment, task_id: randomUUID(), logical_task_id: randomUUID(), alias_ids: [randomUUID()] }
    }
  };
  return { setup, state: prepareExternalTask(store, setup, apply, clock) };
}
export function prepareExternalTask(store: Store, input: ExternalTaskSetup, apply = false, clock: Clock = utcNow) {
  const setup = ExternalTaskSetupSchema.parse(input);
  const candidate = taskIdFor(store, setup);
  if (
    !externalContract(store, candidate) &&
    store.get(
      `SELECT 1 FROM sessions WHERE task_id=? UNION ALL SELECT 1 FROM events WHERE task_id=? UNION ALL SELECT 1 FROM active_intervals WHERE task_id=?`,
      [candidate, candidate, candidate]
    )
  )
    throw new Error('external_contract_requires_new_task');
  const prepared = prepareExternalWorkflow(store, freshConfirmation(setup), setup.runtime, setup.preparation, apply, clock);
  registerExternalContract(store, prepared.task_id, clock);
  return externalTaskState(store, prepared.task_id, clock());
}
export function externalTaskState(store: Store, taskId: string, at = utcNow()) {
  TimestampSchema.parse(at);
  const contract = externalContract(store, taskId);
  if (!contract) throw new Error('external_contract_required');
  const preparation = externalWorkflowState(store, taskId);
  const proof = store.get<TicketRow>(
    'SELECT * FROM external_start_tickets WHERE task_id=? AND verified_at IS NOT NULL ORDER BY verified_at DESC,rowid DESC LIMIT 1',
    [taskId]
  );
  const control = bindingCollectionControl(store, taskId);
  const expired = control
    ? control.revoked_at !== null || preparation.task_state === 'finalized' || preparation.state === 'released'
    : contract.ends_at !== null && Date.parse(at) >= Date.parse(contract.ends_at);
  const result = new Lifecycle(store).summary(taskId);
  return {
    schema_version: 1,
    task_id: taskId,
    assigned_variant_id: preparation.assigned_variant_id,
    revision: preparation.revision,
    state: preparation.state,
    task_state: preparation.task_state,
    timing_contract: contract.timing_contract,
    report_contract: contract.report_contract,
    collection_end_condition: control ? ('explicit_stop' as const) : ('followup_deadline' as const),
    comparison_window: { started_at: contract.started_at, ends_at: contract.ends_at },
    window: { started_at: contract.started_at, ends_at: control ? null : contract.ends_at },
    window_status: expired ? 'closed' : contract.started_at === null ? 'waiting_connection' : 'open',
    configuration_evidence: preparation.files_evidence,
    native_context_evidence: proof
      ? proof.revision === preparation.revision
        ? 'native_developer_context_observed'
        : 'observed_for_previous_revision'
      : 'unverified',
    freshness_evidence: proof ? 'fresh_root_after_ticket' : 'unverified',
    tool_use_evidence: 'unavailable' as const,
    support: {
      external_collection: 'codex_0_160_root_only',
      claude_external: 'unadmitted',
      ide_external: 'unsupported',
      native_startup_before_work: 'unverified'
    },
    reason_code: preparation.reason_code,
    next_action: expired ? 'assess_task_outcome' : preparation.next_action,
    outcome: result.outcome,
    rework_count: result.rework_count,
    first_success: result.first_success,
    post_success_action: result.outcome === 'success' ? 'success_is_final_for_this_task_create_followup_task_for_additional_work' : null,
    cost_coverage: 'partial' as const,
    complete_cost: null,
    inference: false
  };
}
export type ExternalTaskState = ReturnType<typeof externalTaskState>;

function preparedSetup(store: Store, input: ExternalTaskSetup, clock: Clock) {
  const setup = ExternalTaskSetupSchema.parse(input);
  const taskId = taskIdFor(store, setup);
  if (!externalContract(store, taskId)) throw new Error('external_contract_required');
  assertExternalPrepared(store, taskId, setup.workflow, setup.preparation, clock);
  if (new Lifecycle(store).state(taskId) === 'finalized') throw new Error('invalid_transition');
  return { setup, taskId };
}
function assertWindowOpen(store: Store, taskId: string, clock: Clock) {
  const contract = externalContract(store, taskId)!;
  if (contract.ends_at && Date.parse(clock()) >= Date.parse(contract.ends_at)) throw new Error('external_window_closed');
}
function shellQuote(text: string): string {
  return "'" + text.replaceAll("'", "'\\''") + "'";
}

/** File identity only. Never invokes a native binary, auth command or updater. */
export function verifyExternalNativeBinary(input: NonNullable<ExternalTaskSetup['native_binary']>): void {
  const binary = ExternalTaskSetupSchema.shape.native_binary.unwrap().parse(input);
  if (binary.sha256 !== pinnedCodexWorkflowBinarySha) throw new Error('binary_mismatch');
  let fd: number | undefined;
  try {
    if (realpathSync(binary.path) !== binary.path) throw new Error('binary_mismatch');
    fd = openSync(binary.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd);
    if (!before.isFile() || before.size < 1 || before.size > 256 * 1048576 || (before.mode & 0o111) === 0) throw new Error('binary_mismatch');
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(65536);
    let offset = 0;
    while (offset < before.size) {
      const length = readSync(fd, buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (!length) throw new Error('binary_mismatch');
      hash.update(buffer.subarray(0, length));
      offset += length;
    }
    const after = fstatSync(fd);
    if (
      hash.digest('hex') !== binary.sha256 ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error('binary_mismatch');
  } catch {
    throw new Error('binary_mismatch');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Private handoff string; it is never executed by the tool or recorded as usage. */
export function issueExternalStartTicket(store: Store, input: ExternalTaskSetup, clock: Clock = utcNow) {
  const { setup, taskId } = preparedSetup(store, input, clock);
  assertWindowOpen(store, taskId, clock);
  if (applicationRequired(store, taskId)) {
    assertAppliedHarness(store, taskId);
    throw new Error('application_native_loading_unqualified');
  }
  if (setup.workflow.assignment.metadata.product !== 'synthetic') {
    if (!setup.native_binary) throw new Error('external_native_binary_required');
    verifyExternalNativeBinary(setup.native_binary);
  }
  const state = externalTaskState(store, taskId, clock());
  const root = store.get<{ local_root: string }>('SELECT local_root FROM projects WHERE id=?', [setup.workflow.assignment.project_id])!.local_root;
  const id = randomUUID();
  const active = store.get<{ active_digest: string }>('SELECT active_digest FROM external_preparations WHERE task_id=?', [taskId])!.active_digest;
  const fragment = externalInstructionFragment(id, managedHarnessContent(root, active));
  // A second verification detects a managed-file change during the private read.
  assertExternalPrepared(store, taskId, setup.workflow, setup.preparation, clock);
  store.execute('INSERT INTO external_start_tickets(id,task_id,revision,fragment_hash,issued_at) VALUES (?,?,?,?,?)', [
    id,
    taskId,
    state.revision,
    sha256(fragment),
    nowAt(clock)
  ]);
  const args = [setup.native_binary?.path ?? 'codex', '-C', root, '-c', 'developer_instructions=' + JSON.stringify(fragment)];
  if (setup.runtime.model !== null) args.push('--model', setup.runtime.model);
  if (setup.runtime.effort !== null) args.push('-c', 'model_reasoning_effort=' + JSON.stringify(setup.runtime.effort));
  return {
    ticket_id: id,
    state,
    start_command: args.map(shellQuote).join(' '),
    instructions: 'Open a new Codex 0.160.0 CLI session with this command, select its exact source and connect before starting work.',
    automatic_launch: false,
    native_loading: 'unverified',
    actual_use: 'unavailable'
  };
}

export async function connectExternalTask(
  store: Store,
  input: ExternalTaskSetup,
  executionInput: unknown,
  ticketId: string,
  suppliedAdapter?: WorkflowAdapter,
  clock: Clock = utcNow
) {
  const { setup, taskId } = preparedSetup(store, input, clock);
  assertWindowOpen(store, taskId, clock);
  const execution = CodexWorkflowExecutionSchema.parse(executionInput);
  if (execution.operation !== 'link' || execution.direct_child || execution.child_runtime) throw new Error('external_operation_unsupported');
  const ticket = store.get<TicketRow>('SELECT * FROM external_start_tickets WHERE id=? AND task_id=?', [z.uuid().parse(ticketId), taskId]);
  if (!ticket || ticket.revision !== externalTaskState(store, taskId, clock()).revision) throw new Error('external_ticket_invalid');
  if (ticket.verified_at !== null) throw new Error('external_ticket_used');
  if (store.get('SELECT 1 FROM external_start_tickets WHERE session_id=?', [execution.session_id!])) throw new Error('external_freshness_unverified');
  let evidence: (ExternalContextEvidence & { sessionId: string; sourceIdentity: string }) | undefined;
  const adapter = suppliedAdapter ?? createCodexWorkflowAdapter(store, execution);
  const wrapped: WorkflowAdapter = {
    ...adapter,
    externalContractCoordinator: true,
    async run(context) {
      return adapter.run({
        ...context,
        externalStartup: {
          expectation: { ticketId: ticket.id, fragmentHash: ticket.fragment_hash, issuedAt: ticket.issued_at },
          verify(value) {
            evidence = value;
          }
        }
      });
    }
  };
  // The adapter calls the verifier only inside a validated baseline tick. A
  // failed tick rolls back source checkpoints; no result may substitute for it.
  const result = await runExternalWorkflow(store, freshConfirmation(setup), execution, setup.runtime, setup.preparation, wrapped, clock);
  const journal = store.get<{ scope_verified: number; identity_verified: number; source_identity: string | null }>(
    'SELECT scope_verified,identity_verified,source_identity FROM codex_workflow_runs WHERE id=?',
    [execution.run_id]
  );
  if (
    result.adapter_result?.state !== 'completed' ||
    !evidence ||
    journal?.scope_verified !== 1 ||
    journal.identity_verified !== 1 ||
    journal.source_identity !== evidence.sourceIdentity
  ) {
    const proofFailure = 'external_connection_unverified';
    const life = new Lifecycle(store, clock);
    if (life.state(taskId) === 'active') life.pause(taskId);
    store.execute("UPDATE external_preparations SET state='stopped',reason_code=? WHERE task_id=?", [proofFailure, taskId]);
    throw new Error(proofFailure);
  }
  try {
    store.immediateTransaction(() => {
      assertExternalPrepared(store, taskId, setup.workflow, setup.preparation, clock);
      assertWindowOpen(store, taskId, clock);
      const current = store.get<TicketRow>('SELECT * FROM external_start_tickets WHERE id=?', [ticket.id]);
      if (current?.verified_at !== null || current.revision !== externalTaskState(store, taskId, clock()).revision) throw new Error('external_ticket_invalid');
      const verified = nowAt(clock);
      const contract = externalContract(store, taskId)!;
      if (Date.parse(verified) < Date.parse(evidence!.nativeCreatedAt) || Date.parse(verified) < Date.parse(ticket.issued_at))
        throw new Error('clock_regression');
      store.execute("UPDATE external_preparations SET first_connected_at=COALESCE(first_connected_at,?),state='connected',reason_code=NULL WHERE task_id=?", [
        verified,
        taskId
      ]);
      store.execute('UPDATE external_start_tickets SET session_id=?,source_identity=?,native_created_at=?,verified_at=? WHERE id=?', [
        evidence!.sessionId,
        evidence!.sourceIdentity,
        evidence!.nativeCreatedAt,
        verified,
        ticket.id
      ]);
      if (contract.started_at === null) {
        const end = new Date(Date.parse(verified) + contract.followup_seconds * 1000).toISOString();
        store.execute('UPDATE external_task_contracts SET started_at=?,ends_at=? WHERE task_id=?', [verified, end, taskId]);
        // New-task-only speculative linkage activation is not measured time.
        store.execute('UPDATE active_intervals SET started_at=?,ended_at=CASE WHEN ended_at IS NULL THEN NULL ELSE ? END WHERE task_id=?', [
          verified,
          verified,
          taskId
        ]);
        store.execute('UPDATE attempts SET started_at=? WHERE task_id=?', [verified, taskId]);
        store.execute('UPDATE tasks SET started_at=?,last_transition_at=? WHERE id=?', [verified, verified, taskId]);
      }
    });
  } catch (error) {
    // A failed commit must not retain speculative linkage activation. A drift
    // transition inside the rolled-back transaction is rechecked durably.
    try {
      assertExternalPrepared(store, taskId, setup.workflow, setup.preparation, clock);
    } finally {
      const life = new Lifecycle(store, clock);
      if (life.state(taskId) === 'active') life.pause(taskId);
    }
    throw error;
  }
  return { state: externalTaskState(store, taskId, clock()), receipt: result.adapter_result };
}

export async function collectExternalTask(
  store: Store,
  input: ExternalTaskSetup,
  executionInput: unknown,
  suppliedAdapter?: WorkflowAdapter,
  clock: Clock = utcNow
) {
  const { setup, taskId } = preparedSetup(store, input, clock);
  assertWindowOpen(store, taskId, clock);
  const execution = CodexWorkflowExecutionSchema.parse(executionInput);
  if (execution.operation !== 'collect' || execution.direct_child || execution.child_runtime) throw new Error('external_operation_unsupported');
  const ticket = store.get<TicketRow>('SELECT * FROM external_start_tickets WHERE task_id=? AND session_id=? AND verified_at IS NOT NULL', [
    taskId,
    execution.session_id!
  ]);
  if (!ticket || ticket.revision !== externalTaskState(store, taskId, clock()).revision) throw new Error('external_connection_required');
  const adapter = suppliedAdapter ?? createCodexWorkflowAdapter(store, execution);
  const wrapped: WorkflowAdapter = {
    ...adapter,
    externalContractCoordinator: true,
    async run(context) {
      return adapter.run({
        ...context,
        assertActive() {
          context.assertActive();
          assertWindowOpen(store, taskId, clock);
        },
        externalStartup: {
          expectation: { ticketId: ticket.id, fragmentHash: ticket.fragment_hash, issuedAt: ticket.issued_at },
          verify(value) {
            if (value.sessionId !== ticket.session_id || value.sourceIdentity !== ticket.source_identity || value.nativeCreatedAt !== ticket.native_created_at)
              throw new Error('external_context_mismatch');
          }
        }
      });
    }
  };
  let receipt: Awaited<ReturnType<typeof runExternalWorkflow>>['adapter_result'];
  try {
    const result = await runExternalWorkflow(store, freshConfirmation(setup), execution, setup.runtime, setup.preparation, wrapped, clock);
    receipt = result.adapter_result!;
  } finally {
    // A stopped foreground collector closes active time but leaves the native
    // process under the user's control. Recollection always baselines again.
    const life = new Lifecycle(store, clock);
    if (life.state(taskId) === 'active') life.pause(taskId);
  }
  return { state: externalTaskState(store, taskId, clock()), receipt };
}
export function pauseExternalTask(store: Store, taskId: string, clock: Clock = utcNow) {
  if (!externalContract(store, taskId)) throw new Error('external_contract_required');
  for (const run of store.all<{ id: string }>("SELECT id FROM codex_workflow_runs WHERE task_id=? AND state='running'", [taskId]))
    stopCodexWorkflow(store, run.id);
  const life = new Lifecycle(store, clock);
  if (life.state(taskId) === 'active') life.pause(taskId);
  return externalTaskState(store, taskId, clock());
}

export function recordExternalTaskOutcome(
  store: Store,
  taskId: string,
  choice: 'success' | 'rework' | 'failed' | 'aborted',
  criterionIds: string[],
  clock: Clock = utcNow
) {
  z.enum(['success', 'rework', 'failed', 'aborted']).parse(choice);
  z.array(IdSchema).parse(criterionIds);
  if (!externalContract(store, taskId)?.started_at) throw new Error('external_connection_required');
  if (store.get("SELECT 1 FROM codex_workflow_runs WHERE task_id=? AND state='running'", [taskId])) throw new Error('workflow_run_active');
  store.immediateTransaction(() => {
    const life = new Lifecycle(store, clock);
    const task = life.task(taskId);
    if (task.state === 'finalized') throw new Error('invalid_transition');
    if (choice === 'rework') {
      const control = bindingCollectionControl(store, taskId);
      if (control?.revoked_at) throw new Error('binding_scope_revoked');
      if (!control) assertWindowOpen(store, taskId, clock);
      if (task.state === 'paused') life.resume(taskId);
      if (!task.first_completed_at) life.declareFirst(taskId);
      if (life.task(taskId).first_success === null) life.assessFirst(taskId, false);
      life.rework(taskId);
      life.pause(taskId);
    } else {
      if (!task.first_completed_at) {
        // Human assessment while paused is a zero-duration lifecycle boundary,
        // not a new observation session or a changed measurement window.
        if (task.state === 'paused') life.resume(taskId);
        life.declareFirst(taskId);
        if (task.state === 'paused') life.pause(taskId);
      }
      if (life.task(taskId).first_completed_at && life.task(taskId).first_success === null) life.assessFirst(taskId, choice === 'success');
      life.finalize(taskId, choice, criterionIds);
    }
  });
  return { state: externalTaskState(store, taskId, clock()), result: externalTaskResult(store, taskId, clock()) };
}

/** Partial descriptive collection cost; comparison eligibility retains its frozen deadline. */
export function externalTaskResult(store: Store, taskId: string, cutoff = utcNow()) {
  const end = nowAt(() => cutoff);
  const contract = externalContract(store, taskId);
  if (!contract) throw new Error('external_contract_required');
  const task = new Lifecycle(store).task(taskId);
  if (Date.parse(end) > Date.now() || (contract.started_at !== null && Date.parse(end) < Date.parse(contract.started_at))) throw new Error('invalid_cutoff');
  const control = bindingCollectionControl(store, taskId);
  const collectionEnd = control ? control.revoked_at : contract.ends_at;
  const effective = new Date(
    Math.min(Date.parse(end), collectionEnd ? Date.parse(collectionEnd) : Date.parse(end), task.finalized_at ? Date.parse(task.finalized_at) : Date.parse(end))
  ).toISOString();
  const state = externalTaskState(store, taskId, end);
  const active = store.all<{ started_at: string; ended_at: string | null }>('SELECT started_at,ended_at FROM active_intervals WHERE task_id=?', [taskId]);
  const start = contract.started_at ? Date.parse(contract.started_at) : null;
  const activeMs =
    start === null
      ? null
      : active.reduce(
          (sum, row) => sum + Math.max(0, Math.min(Date.parse(row.ended_at ?? effective), Date.parse(effective)) - Math.max(Date.parse(row.started_at), start)),
          0
        );
  if (start !== null && task.started_at !== contract.started_at) throw new Error('external_window_mismatch');
  const cost = start === null ? null : readReferenceTaskCostReport(store, taskId, effective, 'output-only-v1', end);
  if (cost !== null && (cost.window_start !== contract.started_at || cost.window_end !== effective)) throw new Error('external_window_mismatch');
  return {
    schema_version: 1,
    report_contract: contract.report_contract,
    timing_contract: contract.timing_contract,
    task_id: taskId,
    assigned_variant_id: state.assigned_variant_id,
    window: state.window,
    comparison_window: state.comparison_window,
    collection_end_condition: state.collection_end_condition,
    cutoff: end,
    effective_cutoff: effective,
    outcome: state.outcome,
    outcome_at: task.finalized_at,
    outcome_counted_in_window: task.finalized_at === null ? null : contract.ends_at !== null && Date.parse(task.finalized_at) < Date.parse(contract.ends_at),
    time: {
      elapsed_ms: start === null ? null : Math.max(0, Date.parse(effective) - start),
      active_ms: activeMs,
      rework_count: state.rework_count,
      elapsed_is_labor: false
    },
    coverage: 'partial' as const,
    cost,
    complete_cost: null,
    inference: false,
    limitations: ['future_only_no_backfill', 'native_context_does_not_prove_compliance', 'whole_task_cost_unconfirmed', 'no_inferential_adoption']
  };
}
