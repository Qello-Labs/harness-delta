import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Command } from 'commander';
import { z } from 'zod';
import { AssignedWorkflowInputSchema, type WorkflowAdapter } from '../task-workflow.js';
import { CodexWorkflowExecutionSchema } from '../codex-workflow-adapter.js';
import { prepareExternalWorkflow, runExternalWorkflow, externalWorkflowState, releaseExternalWorkflow } from '../external-session-workflow.js';
import type { Store } from '../store.js';
import { externalContract } from '../external-session-contract.js';
import {
  ExternalTaskSetupSchema,
  collectExternalTask,
  connectExternalTask,
  externalTaskResult,
  externalTaskState,
  issueExternalStartTicket,
  pauseExternalTask,
  prepareExternalTask,
  recordExternalTaskOutcome
} from '../external-session-service.js';

function readInput(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    throw new Error('external_input_unreadable');
  }
}
interface InputOptions {
  config: string;
  runtime: string;
  spec: string;
}
function inputs(options: InputOptions) {
  const config = AssignedWorkflowInputSchema.parse(readInput(options.config));
  return { config: { ...config, confirmation_id: randomUUID() }, runtime: readInput(options.runtime), spec: readInput(options.spec) };
}

export function registerExternalSessionCommands(
  workflow: Command,
  store: () => Store,
  print: (value: unknown) => void,
  adapterFactory?: (store: Store, input: unknown) => WorkflowAdapter
): void {
  const external = workflow.command('external').description('Prepare, then explicitly connect a user-opened Codex CLI root; no agent launcher or hooks');
  const prepare = external.command('prepare').description('assign and check the managed harness file without starting measurement');
  prepare
    .requiredOption('--config <file>', 'existing workflow setup')
    .requiredOption('--runtime <file>', 'runtime setup')
    .requiredOption('--spec <file>', 'reviewed common-file hashes and allowed managed-file preimages')
    .option('--apply-managed-file', 'permit only .harness-delta-managed/active-instructions.md replacement')
    .option('--first-connection-clock', 'new task only: require a verified startup ticket and use its first connection window')
    .action((options: InputOptions & { applyManagedFile?: boolean; firstConnectionClock?: boolean }) => {
      const input = inputs(options);
      const db = store();
      print(
        options.firstConnectionClock
          ? prepareExternalTask(
              db,
              ExternalTaskSetupSchema.parse({ workflow: input.config, runtime: input.runtime, preparation: input.spec }),
              options.applyManagedFile === true
            )
          : prepareExternalWorkflow(db, input.config, input.runtime, input.spec, options.applyManagedFile === true)
      );
      process.stderr.write(
        'hint: open a new agent session in your usual terminal, then explicitly connect it before starting work; file preparation does not verify native loading\n'
      );
    });
  for (const operation of ['connect', 'collect'] as const) {
    external
      .command(operation)
      .description(
        operation === 'connect'
          ? 'verify an exact user-selected session/source and exclude its prior usage'
          : 'observe future usage of the explicitly linked session'
      )
      .requiredOption('--config <file>', 'existing workflow setup')
      .requiredOption('--runtime <file>', 'runtime setup')
      .requiredOption('--spec <file>', 'same reviewed preparation spec')
      .requiredOption('--execution <file>', 'explicit session/source mapping; operation link or collect only')
      .option('--ticket <id>', 'one-use startup ticket for new first-connection tasks')
      .action(async (options: InputOptions & { execution: string; ticket?: string }) => {
        const input = inputs(options);
        const execution = CodexWorkflowExecutionSchema.parse(readInput(options.execution));
        if (execution.operation !== (operation === 'connect' ? 'link' : 'collect')) throw new Error('external_operation_unsupported');
        const db = store();
        const taskId =
          db.get<{ task_id: string }>('SELECT task_id FROM comparison_identity_keys WHERE project_id=? AND key_id=?', [
            input.config.assignment.project_id,
            input.config.assignment.logical_task_id
          ])?.task_id ?? input.config.assignment.task_id;
        const contract = externalContract(db, taskId);
        if (contract) {
          const setup = ExternalTaskSetupSchema.parse({ workflow: input.config, runtime: input.runtime, preparation: input.spec });
          if (operation === 'connect' && !options.ticket) throw new Error('external_ticket_required');
          print(
            operation === 'connect'
              ? await connectExternalTask(db, setup, execution, options.ticket!, adapterFactory?.(db, execution))
              : await collectExternalTask(db, setup, execution, adapterFactory?.(db, execution))
          );
        } else {
          if (options.ticket) throw new Error('external_contract_required');
          print(await runExternalWorkflow(db, input.config, execution, input.runtime, input.spec, adapterFactory?.(db, execution)));
        }
      });
  }
  external
    .command('state <task-id>')
    .description('show preparation, file/native evidence and the unchanged comparison deadline')
    .action((taskId: string) => {
      const db = store();
      print(externalContract(db, taskId) ? externalTaskState(db, taskId) : externalWorkflowState(db, taskId));
    });
  external
    .command('start')
    .description('print a private manual fresh-session command and one-use ticket; never execute it')
    .requiredOption('--config <file>', 'existing reviewed setup')
    .requiredOption('--runtime <file>', 'runtime setup')
    .requiredOption('--spec <file>', 'same preparation spec')
    .option('--native-binary <file>', 'reviewed canonical native binary path/version/hash; required for production handoff')
    .action((options: InputOptions & { nativeBinary?: string }) => {
      const input = inputs(options);
      print(
        issueExternalStartTicket(
          store(),
          ExternalTaskSetupSchema.parse({
            workflow: input.config,
            runtime: input.runtime,
            preparation: input.spec,
            ...(options.nativeBinary ? { native_binary: readInput(options.nativeBinary) } : {})
          })
        )
      );
    });
  external
    .command('pause <task-id>')
    .description('stop observation and pause active time; the external native session remains under your control')
    .action((taskId: string) => {
      print(pauseExternalTask(store(), taskId));
    });
  external
    .command('result <task-id>')
    .description('read the single first-connection descriptive time/partial-cost result')
    .option('--cutoff <timestamp>', 'explicit observation cutoff')
    .action((taskId: string, options: { cutoff?: string }) => {
      print(externalTaskResult(store(), taskId, options.cutoff));
    });
  external
    .command('outcome <task-id> <choice>')
    .description('explicit human success/rework/failed/aborted, after stopping the collector')
    .option('--criteria <ids...>', 'registered completion criterion IDs', [])
    .action((taskId: string, choice: string, options: { criteria: string[] }) => {
      print(recordExternalTaskOutcome(store(), taskId, z.enum(['success', 'rework', 'failed', 'aborted']).parse(choice), options.criteria));
    });
  external
    .command('release <task-id>')
    .description('release managed-file ownership after stopping observation and the external agent')
    .requiredOption('--external-session-stopped', 'explicitly acknowledge the externally opened agent has stopped')
    .action((taskId: string, options: { externalSessionStopped?: boolean }) => {
      print(releaseExternalWorkflow(store(), taskId, z.literal(true).parse(options.externalSessionStopped)));
    });
}
