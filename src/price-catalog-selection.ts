import { protocolRow } from './core/protocol-store.js';
import { IdSchema } from './contracts.js';
import { parseProtocol } from './flexible-contracts.js';
import { preparePriceBasis } from './price-catalog-store.js';
import { ordinaryTask } from './ordinary-observation.js';
import type { Store } from './store.js';

export function selectTaskPriceTable(store: Store, taskId: string, now = new Date().toISOString()) {
  IdSchema.parse(taskId);
  if (!store.get('SELECT id FROM tasks WHERE id=?', [taskId])) throw new Error('unknown_task');
  const ordinary = ordinaryTask(store, taskId);
  if (ordinary) return { tableId: ordinary.price_table_id, selection: 'ordinary_task_pin' as const };
  const assignment = store.get<{ protocol_id: string }>('SELECT protocol_id FROM comparison_assignments WHERE task_id=?', [taskId]);
  if (assignment) {
    const row = protocolRow(store, assignment.protocol_id);
    // Deletion invalidates allocation/comparison, but a surviving task keeps its
    // assigned immutable price reference for descriptive reads.
    if (row.status !== 'frozen' && row.status !== 'invalidated_by_deletion') throw new Error('protocol_not_active');
    const protocol = parseProtocol(JSON.parse(row.settings) as unknown);
    if (protocol.schema_version === 2) return { tableId: protocol.price_table_id, selection: 'frozen_comparison' as const };
  }
  return { tableId: preparePriceBasis(store, now).table.id, selection: 'current_catalog' as const };
}
