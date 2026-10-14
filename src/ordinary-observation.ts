import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { IdSchema, ProductVersionSchema, TimestampSchema } from './contracts.js';
import { FlexibleTaskMetadataSchema } from './flexible-contracts.js';
import { Lifecycle, utcNow, type Clock } from './lifecycle.js';
import { preparePriceBasis } from './price-catalog-store.js';
import type { Store } from './store.js';

const absolutePath = z.string().min(1).max(4096)
  .refine(value => isAbsolute(value) && !value.includes('\0'));
export const OrdinaryProjectSettingsSchema = z.strictObject({
  schema_version: z.literal(1),
  product: z.literal('claude_code'),
  product_version: ProductVersionSchema,
  receipt_directory: absolutePath,
  claude_projects_directory: absolutePath,
});
export type OrdinaryProjectSettings = z.infer<typeof OrdinaryProjectSettingsSchema>;
export const OrdinaryTaskInputSchema = z.strictObject({
  project_id: IdSchema,
  type: IdSchema.default('feature'),
  expected_size: IdSchema.default('medium'),
  assignee: IdSchema.default('local-user'),
  criterion_ids: z.array(IdSchema).min(1).max(256)
    .refine(ids => new Set(ids).size === ids.length),
});
export type OrdinaryTaskInput = z.input<typeof OrdinaryTaskInputSchema>;
interface OrdinaryTaskRow {
  readonly task_id: string;
  readonly settings: string;
  readonly settings_hash: string;
  readonly price_table_id: string;
  readonly prepared_at: string;
  readonly selected_root_id: string | null;
  readonly revoked_at: string | null;
}
const settingsHash = (settings: OrdinaryProjectSettings) =>
  createHash('sha256').update(JSON.stringify(settings)).digest('hex');

export function ordinaryProjectSettings(store: Store, projectId: string): OrdinaryProjectSettings | undefined {
  const row = store.get<{ settings: string }>(
    'SELECT settings FROM ordinary_project_settings WHERE project_id=?', [IdSchema.parse(projectId)]);
  return row ? OrdinaryProjectSettingsSchema.parse(JSON.parse(row.settings)) : undefined;
}

export function saveOrdinaryProjectSettings(
  store: Store, projectId: string, input: unknown, clock: Clock = utcNow,
): OrdinaryProjectSettings {
  const settings = OrdinaryProjectSettingsSchema.parse(input);
  const at = new Date(TimestampSchema.parse(clock())).toISOString();
  store.immediateTransaction(() => {
    const project = store.get<{ local_root: string | null }>(
      'SELECT local_root FROM projects WHERE id=?', [IdSchema.parse(projectId)]);
    if (!project?.local_root) throw new Error('unknown_project');
    if (store.get("SELECT 1 FROM tombstones WHERE kind='project' AND id=?", [projectId]))
      throw new Error('deleted_identifier');
    store.execute(`INSERT INTO ordinary_project_settings(project_id,settings,settings_hash,updated_at)
      VALUES (?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET
      settings=excluded.settings,settings_hash=excluded.settings_hash,updated_at=excluded.updated_at`,
    [projectId, JSON.stringify(settings), settingsHash(settings), at]);
  });
  return settings;
}

export function ordinaryTask(store: Store, taskId: string): OrdinaryTaskRow | undefined {
  return store.get<OrdinaryTaskRow>('SELECT * FROM ordinary_tasks WHERE task_id=?', [IdSchema.parse(taskId)]);
}

export function ordinaryTaskSettings(store: Store, taskId: string): OrdinaryProjectSettings {
  const row = ordinaryTask(store, taskId);
  if (!row) throw new Error('ordinary_preparation_required');
  const settings = OrdinaryProjectSettingsSchema.parse(JSON.parse(row.settings));
  if (settingsHash(settings) !== row.settings_hash) throw new Error('ordinary_configuration_changed');
  return settings;
}

export function createOrdinaryTask(store: Store, input: OrdinaryTaskInput, clock: Clock = utcNow): string {
  const spec = OrdinaryTaskInputSchema.parse(input);
  const taskId = randomUUID();
  const life = new Lifecycle(store, clock);
  store.immediateTransaction(() => {
    const settings = ordinaryProjectSettings(store, spec.project_id);
    if (!settings) throw new Error('ordinary_project_setup_required');
    const at = new Date(TimestampSchema.parse(clock())).toISOString();
    const basis = preparePriceBasis(store, at);
    const metadata = FlexibleTaskMetadataSchema.parse({
      schema_version: 2, type: spec.type, expected_size: spec.expected_size,
      assignee: spec.assignee, product: settings.product, initial_model: null,
      criterion_ids: spec.criterion_ids,
    });
    life.createTask(spec.project_id, taskId, metadata);
    store.execute(`INSERT INTO ordinary_tasks(task_id,settings,settings_hash,price_table_id,prepared_at)
      VALUES (?,?,?,?,?)`,
    [taskId, JSON.stringify(settings), settingsHash(settings), basis.table.id, at]);
  });
  return taskId;
}

export function assertOrdinaryTaskPrepared(store: Store, taskId: string): OrdinaryProjectSettings {
  const task = new Lifecycle(store).task(taskId);
  const prepared = ordinaryTask(store, taskId);
  if (!prepared) throw new Error('ordinary_preparation_required');
  if (prepared.revoked_at !== null || task.state === 'finalized' ||
    store.get("SELECT 1 FROM tombstones WHERE (kind='task' AND id=?) OR (kind='project' AND id=?)",
      [taskId, task.project_id])) throw new Error('binding_scope_revoked');
  const project = store.get<{ local_root: string | null }>(
    'SELECT local_root FROM projects WHERE id=?', [task.project_id]);
  if (!project?.local_root) throw new Error('binding_scope_mismatch');
  const settings = ordinaryTaskSettings(store, taskId);
  const metadata = FlexibleTaskMetadataSchema.parse(JSON.parse(task.metadata));
  if (metadata.product !== settings.product ||
    store.get('SELECT 1 FROM comparison_assignments WHERE task_id=?', [taskId]))
    throw new Error('ordinary_configuration_changed');
  return settings;
}

export function revokeOrdinaryObservation(store: Store, taskId: string, clock: Clock = utcNow): void {
  const prepared = ordinaryTask(store, taskId);
  if (!prepared) throw new Error('ordinary_preparation_required');
  if (prepared.revoked_at === null) store.execute('UPDATE ordinary_tasks SET revoked_at=? WHERE task_id=?',
    [new Date(TimestampSchema.parse(clock())).toISOString(), taskId]);
}
