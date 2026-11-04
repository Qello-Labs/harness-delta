import { z } from 'zod';
import { IdSchema } from '../contracts.js';
import type { Store } from '../store.js';
import { canonicalJson } from '../canonical-json.js';
import { uuid, parseExchange } from './contracts.js';
export const MappingSchema = z
  .strictObject({
    schema_version: z.literal(1),
    shared_project_id: uuid,
    local_project_id: IdSchema,
    protocol_id: IdSchema,
    protocol_digest: z.string().regex(/^[a-f0-9]{64}$/),
    writers: z
      .array(z.strictObject({ namespace_id: uuid, stratum_id: IdSchema, allocator_id: IdSchema }))
      .min(1)
      .max(256)
  })
  .refine(m => new Set(m.writers.map(w => w.stratum_id)).size === m.writers.length);
export type Mapping = z.infer<typeof MappingSchema>;
export function registeredDestination(store: Store, localProjectId: string): void {
  if (store.get("SELECT id FROM tombstones WHERE kind='project' AND id=?", [localProjectId])) throw new Error('deleted_identifier');
  if (!store.get('SELECT id FROM projects WHERE id=?', [localProjectId])) throw new Error('unknown_mapping');
}
export function readMapping(store: Store, sharedProjectId: string, protocolId: string, localProjectId: string): Mapping {
  const row = store.get<{ config_json: string; local_project_id: string }>(
    'SELECT config_json,local_project_id FROM exchange_mappings WHERE shared_project_id=? AND protocol_id=?',
    [sharedProjectId, protocolId]
  );
  if (!row || row.local_project_id !== localProjectId) throw new Error('unknown_mapping');
  return parseExchange(MappingSchema, JSON.parse(row.config_json) as unknown);
}
export function registerExchangeMapping(store: Store, input: unknown): void {
  const m = parseExchange(MappingSchema, input);
  m.writers.sort((a, b) => (a.stratum_id < b.stratum_id ? -1 : a.stratum_id > b.stratum_id ? 1 : 0));
  store.immediateTransaction(() => {
    registeredDestination(store, m.local_project_id);
    if (store.get('SELECT shared_project_id FROM exchange_project_denials WHERE shared_project_id=?', [m.shared_project_id]))
      throw new Error('deleted_identifier');
    const old = store.get<{ config_json: string }>('SELECT config_json FROM exchange_mappings WHERE shared_project_id=? AND protocol_id=?', [
      m.shared_project_id,
      m.protocol_id
    ]);
    if (old) {
      if (old.config_json !== canonicalJson(m)) throw new Error('mapping_conflict');
      return;
    }
    if (
      store.get('SELECT shared_project_id FROM exchange_mappings WHERE shared_project_id=? AND local_project_id!=?', [m.shared_project_id, m.local_project_id])
    )
      throw new Error('mapping_conflict');
    for (const w of m.writers)
      if (
        store.get('SELECT namespace_id FROM exchange_writers WHERE namespace_id=? AND (shared_project_id!=? OR protocol_id!=?)', [
          w.namespace_id,
          m.shared_project_id,
          m.protocol_id
        ])
      )
        throw new Error('mapping_conflict');
    store.execute('INSERT INTO exchange_mappings VALUES (?,?,?,?)', [m.shared_project_id, m.protocol_id, m.local_project_id, canonicalJson(m)]);
    for (const w of m.writers)
      store.execute('INSERT INTO exchange_writers VALUES (?,?,?,?,?)', [w.namespace_id, m.shared_project_id, m.protocol_id, w.stratum_id, w.allocator_id]);
    store.execute('INSERT OR IGNORE INTO exchange_merge_state VALUES (?,0)', [m.shared_project_id]);
  });
}
