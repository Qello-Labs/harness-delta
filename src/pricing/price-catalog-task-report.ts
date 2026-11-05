import { projectCatalogCost } from '../catalog-cost-report.js';
import { captureObservedCostInput } from '../observed-cost-report.js';
import { selectTaskPriceTable } from '../price-catalog-selection.js';
import { readPriceBasis } from '../price-catalog-store.js';
import type { LegacyInputBasis } from '../pricing.js';
import type { Store } from '../store.js';

/** Descriptive task cost for the existing admitted task window; callers own any external clock contract. */
export function readReferenceTaskCostReport(
  store: Store,
  taskId: string,
  cutoff: string,
  inputBasis: LegacyInputBasis = 'output-only-v1',
  now = new Date().toISOString()
) {
  return store.transaction(() => {
    const selected = selectTaskPriceTable(store, taskId, now);
    const { report, events, runtimeEvidence } = captureObservedCostInput(store, taskId, selected.tableId, cutoff, inputBasis);
    if (!store.get('SELECT price_table_id FROM price_catalog_bases WHERE price_table_id=?', [selected.tableId])) {
      return { ...report, price_selection: selected.selection };
    }
    const priced = projectCatalogCost(events, readPriceBasis(store, selected.tableId), taskId, cutoff, inputBasis, { referenceBinding: true, runtimeEvidence });
    return { ...report, ...priced, reasons: [...new Set([...report.reasons, ...priced.reasons])].sort(), price_selection: selected.selection };
  });
}

export type ReferenceTaskCostReport = ReturnType<typeof readReferenceTaskCostReport>;
