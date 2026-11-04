import type { Command } from 'commander';
import { readObservedCostReport } from '../observed-cost-report.js';
import type { LegacyInputBasis } from '../pricing.js';
import type { Store } from '../store.js';
import { readReferenceTaskCostReport } from '../pricing/price-catalog-task-report.js';

export function registerObservedCostCommand(prices: Command, store: () => Store, print: (value: unknown) => void): void {
  prices
    .command('estimate-task <task-id>')
    .description('Partial standardized estimate from recorded task usage; no complete cost or billing claim')
    .option('--price-table <id>', 'Advanced explicit reference; default retains comparison pin or uses current catalog')
    .requiredOption('--cutoff <UTC>', 'Exclusive observation cutoff')
    .option('--input-basis <basis>', 'output-only-v1 or explicit cache-read-remainder-ordinary-v1 assumption', 'output-only-v1')
    .action((taskId: string, options: { priceTable?: string; cutoff: string; inputBasis: LegacyInputBasis }) => {
      const db = store();
      if (options.priceTable) {
        print(readObservedCostReport(db, taskId, options.priceTable, options.cutoff, options.inputBasis));
        return;
      }
      print(readReferenceTaskCostReport(db, taskId, options.cutoff, options.inputBasis));
    });
}
