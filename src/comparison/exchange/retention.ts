import { z } from 'zod';
import type { Store } from '../../store.js';
import { IdSchema } from '../../contracts.js';
import { type Clock, utcNow } from '../../lifecycle.js';
import { parseExchange, uuid, time } from './contracts.js';
import { registeredDestination } from './mapping.js';
import { invalidateExchangeProtocol } from './invalidation.js';
const scope = z.strictObject({ local_project_id: IdSchema, shared_project_id: uuid });
function requireScope(store: Store, request: z.infer<typeof scope>): void {
  registeredDestination(store, request.local_project_id);
  if (
    !store.get('SELECT shared_project_id FROM exchange_mappings WHERE shared_project_id=? AND local_project_id=?', [
      request.shared_project_id,
      request.local_project_id
    ])
  )
    throw new Error('unknown_mapping');
}
export function deleteImportedTask(store: Store, input: unknown, clock: Clock = utcNow) {
  const request = parseExchange(scope.extend({ task_id: IdSchema }), input);
  const now = parseExchange(time, clock());
  return store.immediateTransaction(() => {
    requireScope(store, request);
    if (store.get('SELECT key_id FROM exchange_tombstones WHERE shared_project_id=? AND key_id=?', [request.shared_project_id, request.task_id]))
      return { status: 'replayed' as const, affected_protocol_ids: [] as string[] };
    const row = store.get<{ protocol_id: string }>('SELECT protocol_id FROM exchange_tasks WHERE shared_project_id=? AND task_id=?', [
      request.shared_project_id,
      request.task_id
    ]);
    if (!row) throw new Error('unknown_imported_task');
    invalidateExchangeProtocol(store, request.shared_project_id, row.protocol_id, 'deletion', now);
    return { status: 'deleted' as const, affected_protocol_ids: [row.protocol_id] };
  });
}
export function configureImportedRetention(store: Store, input: unknown): void {
  const request = parseExchange(scope.extend({ days: z.number().int().min(1).max(365000) }), input);
  store.immediateTransaction(() => {
    requireScope(store, request);
    if (store.get('SELECT shared_project_id FROM exchange_project_denials WHERE shared_project_id=?', [request.shared_project_id]))
      throw new Error('deleted_identifier');
    store.execute('INSERT INTO exchange_retention_policy VALUES (?,?) ON CONFLICT(shared_project_id) DO UPDATE SET days=excluded.days', [
      request.shared_project_id,
      request.days
    ]);
  });
}
export function applyImportedRetention(store: Store, input: unknown, clock: Clock = utcNow) {
  const request = parseExchange(scope, input);
  const now = parseExchange(time, clock());
  return store.immediateTransaction(() => {
    requireScope(store, request);
    const policy = store.get<{ days: number }>('SELECT days FROM exchange_retention_policy WHERE shared_project_id=?', [request.shared_project_id]);
    if (!policy) throw new Error('retention_not_configured');
    const cutoff = Date.parse(now) - policy.days * 86400000;
    const expired = store
      .all<{ protocol_id: string; finalized_at: string }>(
        'SELECT protocol_id,finalized_at FROM exchange_tasks WHERE shared_project_id=? AND finalized_at IS NOT NULL',
        [request.shared_project_id]
      )
      .filter(t => Date.parse(t.finalized_at) <= cutoff);
    const protocols = [...new Set(expired.map(t => t.protocol_id))].sort();
    for (const p of protocols) invalidateExchangeProtocol(store, request.shared_project_id, p, 'deletion', now);
    return { status: expired.length ? ('protocol_retired' as const) : ('unchanged' as const), expired_tasks: expired.length, affected_protocol_ids: protocols };
  });
}
