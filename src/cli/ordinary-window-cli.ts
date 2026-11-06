import type { Command } from 'commander';
import { aggregateOrdinaryWindowReport } from '../comparison/reports/ordinary-window.js';
import { renderReport } from '../comparison/reports/render.js';
import type { Store } from '../store.js';

export function registerOrdinaryWindowReportCommand(program: Command, db: () => Store): Command {
  const report = program.command('report');
  report
    .command('ordinary-window <id>')
    .requiredOption('--cutoff <UTC>')
    .option('--format <json|markdown>', 'output format', 'json')
    .action((id: string, options: { cutoff: string; format: string }) => {
      process.stdout.write(renderReport(aggregateOrdinaryWindowReport(db(), id, options.cutoff), options.format));
    });
  return report;
}
