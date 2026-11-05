import { registerPriceTable, readPriceTable } from '../pricing.js';
import { registerObservedCostCommand } from './pricing-cli.js';
import { PriceTableSchema, parseTaskMetadata } from '../flexible-contracts.js';
import { parseComparison } from '../comparison-contracts.js';
import { readRuntimeHistory } from '../runtime-history.js';
import { comparisonReadiness } from '../readiness-store.js';
import { readFileSync } from 'node:fs';
import { createComparisonSnapshot, readComparisonSnapshot } from '../comparison/reports/comparison-snapshot.js';
import { renderComparisonReport } from '../comparison/reports/comparison-render.js';
import type { ComparisonSnapshotRequest } from '../comparison/reports/comparison-contracts.js';
import type { Command } from 'commander';
import { assignTask } from '../comparison/allocation.js';
import { freezeProtocol, registerVariant, showProtocol, showVariant } from '../comparison.js';
import { registerProtocolWithCatalogDefaults } from '../price-catalog-selection.js';
import { registerPriceCatalogCommands } from './price-catalog-cli.js';
import { configurationHistory } from '../core/configuration-evidence.js';
import { confirmConfiguration } from '../comparison/config-confirmation-write.js';
import type { SelectedArtifact } from '../core/configuration-evidence.js';
import type { Store } from '../store.js';

const readConfig = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8')) as unknown;

export function registerComparisonCommands(program: Command, store: () => Store, print: (value: unknown) => void): void {
  const prices = program.command('price-table').description('Immutable explicit standardized cost prices; not actual billing');
  prices
    .command('register')
    .requiredOption('--config <file>')
    .action((o: { config: string }) => {
      registerPriceTable(store(), parseComparison(PriceTableSchema, readConfig(o.config), 'invalid_price_table'));
    });
  prices.command('show <id>').action((id: string) => {
    print(readPriceTable(store(), id));
  });
  registerObservedCostCommand(prices, store, print);
  registerPriceCatalogCommands(prices, store, print);
  const variant = program.command('variant').description('Register immutable harness configurations');
  variant
    .command('register')
    .requiredOption('--config <file>')
    .action((options: { config: string }) => {
      registerVariant(store(), readConfig(options.config));
    });
  variant.command('show <id>').action((id: string) => {
    print(showVariant(store(), id));
  });
  const comparison = program
    .command('comparison')
    .description('Assignment and readiness: synthetic validation or separately gated native functional pilots; complete cost and inference unavailable');
  comparison
    .command('register')
    .requiredOption('--config <file>')
    .action((options: { config: string }) => {
      registerProtocolWithCatalogDefaults(store(), readConfig(options.config));
    });
  comparison.command('freeze <id>').action((id: string) => {
    freezeProtocol(store(), id, new Date().toISOString());
  });
  comparison.command('show <id>').action((id: string) => {
    print(showProtocol(store(), id));
  });
  comparison
    .command('readiness <id>')
    .description('Independent real allocation, whole-cost and inference evidence gates')
    .action((id: string) => {
      print(comparisonReadiness(store(), id));
    });
  comparison
    .command('assign')
    .requiredOption('--config <file>')
    .action((options: { config: string }) => {
      print(
        assignTask(store(), readConfig(options.config), {
          discloseReports: ids => {
            print({ invalidating_reports: ids });
          }
        })
      );
    });
  comparison
    .command('snapshot')
    .command('create <protocol-id>')
    .requiredOption('--id <report-id>')
    .requiredOption('--cutoff <UTC>')
    .requiredOption('--reason <reason>')
    .option('--supersedes <report-id>')
    .action((protocolId: string, options: { id: string; cutoff: string; reason: ComparisonSnapshotRequest['revisionReason']; supersedes?: string }) => {
      print(
        createComparisonSnapshot(store(), {
          reportId: options.id,
          protocolId,
          cutoff: options.cutoff,
          revisionReason: options.reason,
          ...(options.supersedes ? { supersedesReportId: options.supersedes } : {})
        })
      );
    });
  comparison
    .command('report <report-id>')
    .option('--format <json|markdown|markdown-readable>', 'output format', 'json')
    .action((reportId: string, options: { format: string }) => {
      process.stdout.write(renderComparisonReport(readComparisonSnapshot(store(), reportId), options.format));
    });
  const task = program.commands.find(command => command.name() === 'task');
  if (!task) throw new Error('task_commands_missing');
  task
    .command('confirm-config')
    .requiredOption('--config <file>')
    .option('--artifact <id=path...>', 'Explicitly selected instruction artifacts, read locally and never retained')
    .action((options: { config: string; artifact?: string[] }) => {
      const artifacts: SelectedArtifact[] | undefined = options.artifact?.map(value => {
        const separator = value.indexOf('=');
        if (separator < 1 || separator === value.length - 1) throw new Error('invalid_selected_artifact');
        return { artifactId: value.slice(0, separator), path: value.slice(separator + 1) };
      });
      confirmConfiguration(store(), readConfig(options.config), new Date().toISOString(), artifacts);
    });
  task.command('config-history <id>').action((id: string) => {
    const db = store();
    const row = db.get<{ metadata: string | null }>('SELECT metadata FROM tasks WHERE id=?', [id]);
    if (!row) throw new Error('unknown_task');
    const metadata = parseTaskMetadata(JSON.parse(row.metadata ?? 'null') as unknown);
    const history = configurationHistory(db, id);
    print('schema_version' in metadata ? { ...history, runtime: readRuntimeHistory(db, id, new Date().toISOString()) } : history);
  });
}
