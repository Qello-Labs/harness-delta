import { readFileSync } from 'node:fs';
import type { Command } from 'commander';
import { beginAssignedWorkflow, finishAssignedWorkflow, workflowStatus, workflowTaskStatus, runAssignedWorkflow, type WorkflowAdapter } from './task-workflow.js';
import { createCodexWorkflowAdapter, CodexWorkflowExecutionSchema } from './codex-workflow-adapter.js';
import { createClaudeWorkflowAdapter, ClaudeWorkflowExecutionSchema, recoverClaudeWorkflow, stopClaudeWorkflow } from './claude-workflow-adapter.js';
import { recoverCodexWorkflow, stopCodexWorkflow } from './codex-workflow-journal.js';
import type { Outcome } from './lifecycle.js';
import type { Store } from './store.js';
import { createComparisonSnapshot } from './reports/comparison-snapshot.js';
import type { ComparisonSnapshotRequest } from './reports/comparison-contracts.js';
import { registerExternalSessionCommands } from './external-session-cli.js';

/** Fixed codes only: read and parse errors may contain paths or file content. */
function readConfig(path: string, label: 'config' | 'runtime' | 'execution'): unknown {
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch { throw new Error(`${label}_file_unreadable`); }
  try { return JSON.parse(text) as unknown; } catch { throw new Error(`${label}_file_invalid_json`); }
}
function parseExecution<T>(schema: { parse(value: unknown): T }, path: string): T {
  const value = readConfig(path, 'execution');
  try { return schema.parse(value); } catch { throw new Error('invalid_execution'); }
}
/** The config file stays reusable across operations; --confirmation supplies the
 * per-operation ID. Schema validation still happens in the workflow itself. */
function withConfirmation(config: unknown, confirmation?: string): unknown {
  return confirmation !== undefined && typeof config === 'object' && config !== null && !Array.isArray(config) ? { ...config, confirmation_id: confirmation } : config;
}
const confirmationHelp = 'new confirmation ID for this operation (overrides confirmation_id in --config)';
interface RunOptions { config: string; runtime: string; execution: string; confirmation?: string }
export interface WorkflowCommandDependencies { codexAdapter?: (store:Store,execution:unknown)=>WorkflowAdapter; claudeAdapter?: (store:Store,execution:unknown)=>WorkflowAdapter }
export function registerTaskWorkflowCommands(program: Command, store: () => Store, print: (value: unknown) => void, dependencies:WorkflowCommandDependencies={}) {
  const workflow = program.command('workflow').description('Assigned A/B task lifecycle: launch, observe, finish and report (see docs/runbooks/workflow-quickstart.md)');
  registerExternalSessionCommands(workflow, store, print, dependencies.codexAdapter);
  const codex=workflow.command('codex').description('Codex task execution and own-response collection');
  const codexHelp = { launch: 'start a fresh Codex session with the assigned harness', resume: 'resume a linked session with the assigned harness',
    link: 'bind an existing session started outside the CLI; earlier usage is excluded', collect: 'observe future usage of a linked session until stopped' };
  for(const operation of ['launch','resume','link','collect'] as const){
    codex.command(operation).description(codexHelp[operation])
      .requiredOption('--config <file>','workflow JSON: assignment, product version, confirmation ID and A/B artifacts')
      .requiredOption('--runtime <file>','runtime JSON: {"model": ..., "effort": ...}; null means unspecified')
      .requiredOption('--execution <file>',`execution JSON with "operation": "${operation}" and a fresh run_id`)
      .option('--confirmation <id>',confirmationHelp)
      .action(async(options:RunOptions)=>{
        const execution=parseExecution(CodexWorkflowExecutionSchema,options.execution);if(execution.operation!==operation)throw new Error('workflow_operation_mismatch');
        const db=store();const result=await runAssignedWorkflow(db,withConfirmation(readConfig(options.config,'config'),options.confirmation),(dependencies.codexAdapter??createCodexWorkflowAdapter)(db,execution),readConfig(options.runtime,'runtime'));print(result);
        if(result.adapter_result?.state==='failed')throw new Error('codex_workflow_failed');
      });
  }
  const claude=workflow.command('claude').description('Claude assigned task execution with request trace collection');
  for(const [operation,description,executionHelp] of [
    ['launch','start a fresh Claude Code session with the assigned harness','execution JSON with "operation": "launch" and a fresh run_id'],
    ['resume','continue the native session kept by an earlier resumable run of the same task','execution JSON with "operation": "resume", a fresh run_id and resume_run_id'],
  ] as const)claude.command(operation).description(description)
    .requiredOption('--config <file>','workflow JSON: assignment, product version, confirmation ID and A/B artifacts')
    .requiredOption('--runtime <file>','runtime JSON: {"model": ..., "effort": ...}; null means unspecified')
    .requiredOption('--execution <file>',executionHelp)
    .option('--confirmation <id>',confirmationHelp)
    .action(async(options:RunOptions)=>{
      const execution=parseExecution(ClaudeWorkflowExecutionSchema,options.execution);if(execution.operation!==operation)throw new Error('workflow_operation_mismatch');
      const db=store();const result=await runAssignedWorkflow(db,withConfirmation(readConfig(options.config,'config'),options.confirmation),(dependencies.claudeAdapter??createClaudeWorkflowAdapter)(db,execution),readConfig(options.runtime,'runtime'));print(result);
      if(result.adapter_result?.state==='failed')throw new Error('claude_workflow_failed');
    });
  claude.command('stop <run-id>').description('ask a running launch to stop').action((runId:string)=>{print(stopClaudeWorkflow(store(),runId));});
  claude.command('recover <run-id>').description('mark a run whose process is gone as failed; records an observation gap, never backfills')
    .action((runId:string)=>{print(recoverClaudeWorkflow(store(),runId));});
  codex.command('stop <run-id>').description('ask a running operation to stop').action((runId:string)=>{print(stopCodexWorkflow(store(),runId));});
  codex.command('recover <run-id>').description('mark a run whose process is gone as failed; records an observation gap, never backfills')
    .action((runId:string)=>{print(recoverCodexWorkflow(store(),runId));});
  workflow.command('status <protocol-id>').description('protocol readiness and blockers').action((protocolId: string) => { print(workflowStatus(store(), protocolId)); });
  workflow.command('task <task-id>').description('task state, follow-up deadline, runs and next actions')
    .action((taskId: string) => { print(workflowTaskStatus(store(), taskId)); });
  workflow.command('begin').description('assign and start a task without launching a product')
    .requiredOption('--config <file>','workflow JSON').requiredOption('--runtime <file>','runtime JSON').option('--confirmation <id>',confirmationHelp)
    .action((options: { config: string; runtime: string; confirmation?: string }) => {
      // Measurement output contains hashes/IDs only, never instruction text.
      print(beginAssignedWorkflow(store(), withConfirmation(readConfig(options.config,'config'),options.confirmation), readConfig(options.runtime,'runtime')).receipt);
    });
  workflow.command('finish <task-id>').description('record the human outcome; only outcomes before the follow-up deadline count')
    .requiredOption('--outcome <success|failed|aborted>').option('--met <ids...>', 'fulfilled criterion IDs', [])
    .action((taskId: string, options: { outcome: Outcome; met: string[] }) => {
      const result = finishAssignedWorkflow(store(), taskId, options.outcome, options.met); print(result);
      if (!result.counted_in_deadline_status) process.stderr.write('warning: assessment_after_followup_deadline\nhint: this outcome is stored but excluded from deadline status; see late_outcome in new reports\n');
    });
  workflow.command('report <protocol-id>').description('create a fixed-cutoff report snapshot; use a cutoff after every follow-up deadline for final outcomes')
    .requiredOption('--id <report-id>').requiredOption('--cutoff <UTC>').requiredOption('--reason <reason>').option('--supersedes <report-id>')
    .action((protocolId: string, options: { id: string; cutoff: string; reason: ComparisonSnapshotRequest['revisionReason']; supersedes?: string }) => {
      print(createComparisonSnapshot(store(), { protocolId, reportId: options.id, cutoff: options.cutoff, revisionReason: options.reason,
        ...(options.supersedes ? { supersedesReportId: options.supersedes } : {}) }));
    });
}
