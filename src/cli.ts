#!/usr/bin/env node
import { registerExchangeCommands, ExchangeCliError } from './exchange/cli.js';
import { registerCompatibilityCommands } from './source-compatibility-cli.js';
import { sessionCompatibility } from './source-compatibility.js';
import { Command, CommanderError } from 'commander';
import { describeCliError } from './cli-errors.js';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { registerComparisonCommands } from './comparison-cli.js';
import { registerLocalWebCommand } from './local-web-main.js';
import { registerApplicationCommands } from './harness-application-cli.js';
import { registerTaskWorkflowCommands, type WorkflowCommandDependencies } from './task-workflow-cli.js';
import { registerInstrumentedCodexCommands } from './instrumented-codex-cli.js';
import { Store } from './store.js';
import { Lifecycle, type Outcome } from './lifecycle.js';
import { Deletion } from './deletion.js';
import { Collector } from './collection.js';
import { aggregateFlexibleTaskReport } from './reports/flexible-comparison.js';
import { aggregateOrdinaryTaskReport } from './reports/ordinary-task.js';
import { ordinaryTask } from './ordinary-observation.js';
import { parseTaskMetadata } from './flexible-contracts.js';
import { aggregateTask } from './metrics.js';
import { freezePeriod,periodReport } from './reports/period.js';
import { renderReport } from './reports/render.js';
import { setTimeout as delay } from 'node:timers/promises';

export async function main(argv: string[], workflowDependencies:WorkflowCommandDependencies={}): Promise<number> {
  let store: Store | undefined;
  const program = new Command().name('hm').description('Local metadata measurement').requiredOption('--db <file>', 'local SQLite database');
  // Usage errors are reported once from the catch below without echoing argv.
  program.exitOverride().configureOutput({ writeErr: () => undefined });
  const db = () => store ??= new Store(program.opts<{ db: string }>().db);
  const life = () => new Lifecycle(db());
  const deletion = () => new Deletion(db(), undefined, ids => { print({ invalidating_reports: ids }); });
  const print = (value: unknown) => { process.stdout.write(`${JSON.stringify(value)}\n`); };
  const project = program.command('project');
  project.command('add <id>').requiredOption('--root <directory>').action((id: string, options: { root: string }) => { life().registerProject(id, options.root); });
  const task = program.command('task');
  task.command('register <id>').requiredOption('--project <id>').requiredOption('--type <id>').requiredOption('--size <id>')
    .requiredOption('--assignee <id>').requiredOption('--product <product>').requiredOption('--model <id>')
    .requiredOption('--criteria <ids...>').option('--complexity <id>')
    .action((id: string, options: { project: string; type: string; size: string; assignee: string; product: string; model: string; criteria: string[]; complexity?: string }) => {
      life().createTask(options.project, id, { type: options.type, expected_size: options.size, assignee: options.assignee,
        product: options.product, model: options.model, criterion_ids: options.criteria,
        ...(options.complexity ? { expected_complexity: options.complexity } : {}) });
    });
  task.command('start <id>').action((id: string) => { life().start(id); });
  task.command('pause <id>').action((id: string) => { life().pause(id); });
  task.command('resume <id>').action((id: string) => { life().resume(id); });
  task.command('first-complete <id>').action((id: string) => { life().declareFirst(id); });
  task.command('assess-first <id>').requiredOption('--result <success|failed>').action((id: string, options: { result: string }) => {
    if (!['success', 'failed'].includes(options.result)) throw new Error('invalid_result');
    life().assessFirst(id, options.result === 'success');
  });
  task.command('rework <id>').action((id: string) => { life().rework(id); });
  task.command('finalize <id>').requiredOption('--outcome <success|failed|aborted>').option('--met <ids...>', 'fulfilled criterion IDs', [])
    .action((id: string, options: { outcome: Outcome; met: string[] }) => { life().finalize(id, options.outcome, options.met); });
  task.command('show <id>').action((id: string) => { print(life().summary(id)); });
  program.command('session').command('link <id>').requiredOption('--task <id>').requiredOption('--source <file>')
    .requiredOption('--product <codex|claude_code>').requiredOption('--version <version>').option('--confirmation <id>', 'Explicit task configuration confirmation')
    .action((id: string, options: { task: string; source: string; product: string; version: string; confirmation?: string }) => {
      life().linkSession(options.task, id, options.source, options.product, options.version, options.confirmation);
      print({ session_id:id, source_compatibility:sessionCompatibility(db(),id) });
    });
  const remove = program.command('delete');
  remove.command('task <id>').action((id: string) => { deletion().deleteTask(id); });
  remove.command('project <id>').action((id: string) => { deletion().deleteProject(id); });
  const retention = program.command('retention');
  retention.command('set <project>').requiredOption('--days <number>').action((id: string, options: { days: string }) => { deletion().configureRetention(id, Number(options.days)); });
  retention.command('apply <project>').action((id: string) => { print({ deleted: deletion().applyRetention(id, new Date().toISOString()) }); });
  program.command('collect').requiredOption('--task <id>').option('--once', 'establish a baseline and exit')
    .option('--interval <milliseconds>', 'poll interval', '1000').action(async(options:{task:string;once?:boolean;interval:string})=>{
      const interval=Number(options.interval);if(!Number.isInteger(interval)||interval<100||interval>60000)throw new Error('invalid_interval');
      life().task(options.task);
      const collector=new Collector(db());const controller=new AbortController();
      const stop=()=>{controller.abort();};process.once('SIGINT',stop);process.once('SIGTERM',stop);
      try{do{const diagnostics=collector.tick(options.task);if(diagnostics.length)print({collection_diagnostics:diagnostics});if(options.once)break;
        const state=db().get<{state:string}>('SELECT state FROM tasks WHERE id=?',[options.task]);if(!state||state.state==='finalized')break;
        try{await delay(interval,undefined,{signal:controller.signal});}catch{if(!controller.signal.aborted)throw new Error('collection_error');}
      }while(!controller.signal.aborted);}finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
    });
  program.command('period').command('register').requiredOption('--config <file>').action((options:{config:string})=>{
    freezePeriod(db(),JSON.parse(readFileSync(options.config,'utf8')) as unknown,new Date().toISOString());
  });
  const report=program.command('report');
  report.command('task <id>').requiredOption('--cutoff <UTC>').option('--format <json|markdown>','output format','json')
    .action((id:string,options:{cutoff:string;format:string})=>{const row=life().task(id);const metadata=parseTaskMetadata(JSON.parse(row.metadata??'null') as unknown);
      if(ordinaryTask(db(),id))process.stdout.write(renderReport(aggregateOrdinaryTaskReport(db(),id,options.cutoff),options.format));
      else if('schema_version' in metadata){const value=aggregateFlexibleTaskReport(db(),id,options.cutoff);if(options.format==='json')process.stdout.write(JSON.stringify(value,null,2)+'\n');else if(options.format==='markdown')process.stdout.write('# Standardized estimated cost\n\nWhole task cost unconfirmed. Elapsed time is not human labor.\n\n```json\n'+JSON.stringify(value,null,2)+'\n```\n');else throw new Error('invalid_format');}
      else process.stdout.write(renderReport(aggregateTask(db(),id,options.cutoff),options.format));});
  report.command('period <id>').requiredOption('--cutoff <UTC>').option('--format <json|markdown>','output format','json')
    .action((id:string,options:{cutoff:string;format:string})=>{process.stdout.write(renderReport(periodReport(db(),id,options.cutoff),options.format));});
  registerCompatibilityCommands(program, db, print);
  registerApplicationCommands(program, db, print);
  registerComparisonCommands(program, db, print);
  registerTaskWorkflowCommands(program, db, print, workflowDependencies);
  registerInstrumentedCodexCommands(program, db, print);
  registerExchangeCommands(program, db, print);
  registerLocalWebCommand(program, db, print);
  try {
    await program.parseAsync(argv, { from: 'user' });
    return 0;
  } catch (error) {
    if (error instanceof CommanderError && error.exitCode === 0) return 0;
    process.stderr.write(error instanceof ExchangeCliError ? error.message + '\n' : describeCliError(error).join('\n') + '\n');
    return 2;
  } finally { store?.close(); }
}

export function isEntrypoint(path: string | undefined): boolean {
  try { return path !== undefined && realpathSync(path) === fileURLToPath(import.meta.url); }
  catch { return false; }
}

if (isEntrypoint(process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2));
}
