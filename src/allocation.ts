import { comparisonReadiness, functionalWorkflowEligible } from './readiness-store.js';
import { FlexibleAssignmentInputSchema, type FlexibleAssignmentInput, type FlexibleProtocol } from './flexible-contracts.js';
import { retireSource, assertUnsealedIdentity } from './exchange/deletion.js';
import { z } from 'zod';
import { affectedComparisonProtocols, invalidateComparisonSnapshots } from './reports/comparison-invalidation.js';
import { IdSchema } from './contracts.js';
import { randomInt, randomUUID } from 'node:crypto';
import { AssignmentInputSchema, comparisonTimestamp, parseComparison } from './comparison-contracts.js';
import type { AssignmentInput, Protocol } from './comparison-contracts.js';
import { comparisonProtocol, comparisonVariant, protocolRow } from './comparison.js';
import { Lifecycle } from './lifecycle.js';
import type { TaskRow } from './lifecycle.js';
import type { Store } from './store.js';
import { isHumanPilotProtocol } from './session-binding-human-pilot.js';
import { isAdmittedCodexBindingProtocol } from './codex-binding-admission.js';

export interface AllocationDependencies { clock?: () => string; shuffle?: (values: readonly string[]) => readonly string[]; discloseReports?: (ids: readonly string[]) => void; pilotPreparation?: boolean; }
export interface AssignmentRow {
  id: string; task_id: string; project_id: string; protocol_id: string; variant_id: string;
  assigned_at: string; recorded_at: string; followup_ends_at: string; stratum_id: string;
  block_id: string; allocation_index: number; allocator_id: string;
}
export interface AssignmentReceipt {
  schema_version: 1; assignment_id: string; task_id: string; protocol_id: string; assigned_variant_id: string;
  assigned_at: string; followup_ends_at: string; stratum_id: string; block_id: string; allocation_index: number; allocator_id: string; reused: boolean;
}
interface IdentityRow { task_id: string; key_id: string; }
interface PreregistrationRow { metadata: string; environment_id: string; code_base_commit: string; }
interface AllocationState { allocator_id: string; next_index: number; block_id: string | null; pending_variants: string; }

function shuffled(values: readonly string[]): string[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index--) {
    const position = randomInt(index + 1);
    [result[index], result[position]] = [result[position]!, result[index]!];
  }
  return result;
}
function receipt(row: AssignmentRow, reused: boolean): AssignmentReceipt {
  return { schema_version: 1, assignment_id: row.id, task_id: row.task_id, protocol_id: row.protocol_id,
    assigned_variant_id: row.variant_id, assigned_at: row.assigned_at, followup_ends_at: row.followup_ends_at,
    stratum_id: row.stratum_id, block_id: row.block_id, allocation_index: row.allocation_index, allocator_id: row.allocator_id, reused };
}
function rejectTombstones(store: Store, input: AssignmentInput | FlexibleAssignmentInput, keys: readonly string[]): void {
  if (store.get('SELECT id FROM tombstones WHERE (kind = ? AND id = ?) OR (kind = ? AND id = ?)', ['project', input.project_id, 'task', input.task_id])) throw new Error('deleted_identifier');
  for (const key of keys) {
    if (store.get('SELECT key_id FROM comparison_identity_tombstones WHERE project_id = ? AND key_id = ?', [input.project_id, key])) throw new Error('deleted_identifier');
  }
}
function invalidateIdentityConflict(store: Store, taskIds: readonly string[], now: string, discloseReports?: (ids: readonly string[]) => void): void {
  const protocolIds = new Set(taskIds.flatMap(taskId => affectedComparisonProtocols(store, taskId)));
  for (const id of protocolIds) {
    retireSource(store, id, 'identity_conflict', now);
    store.execute("UPDATE comparison_protocols SET status = 'identity_conflict', invalidated_reason = 'identity_conflict', data_revision = data_revision + 1 WHERE id = ? AND status != 'invalidated_by_deletion'", [id]);
    const reports = store.all<{ report_id: string }>('SELECT report_id FROM comparison_report_snapshots WHERE protocol_id=? ORDER BY report_id', [id]).map(row => row.report_id);
    if (reports.length) discloseReports?.(reports);
    invalidateComparisonSnapshots(store, id, 'identity_conflict', now);
    store.execute('DELETE FROM comparison_allocation_state WHERE protocol_id = ?', [id]);
  }
}
function bindIdentityKeys(store: Store, input: AssignmentInput | FlexibleAssignmentInput, taskId: string): void {
  for (const key of [input.logical_task_id, ...(input.alias_ids ?? [])]) {
    store.execute('INSERT OR IGNORE INTO comparison_identity_keys(project_id,key_id,task_id,kind) VALUES (?,?,?,?)',
      [input.project_id, key, taskId, key === input.logical_task_id ? 'logical' : 'alias']);
  }
}
function assertPreregistration(store: Store, taskId: string, input: AssignmentInput | FlexibleAssignmentInput): void {
  const row = store.get<PreregistrationRow>('SELECT metadata,environment_id,code_base_commit FROM comparison_preregistrations WHERE task_id = ?', [taskId]);
  if (!row || row.metadata !== JSON.stringify(input.metadata) || row.environment_id !== input.environment_id || row.code_base_commit !== input.code_base_commit) throw new Error('preregistration_conflict');
}
function assertSyntheticStore(store: Store): void {
  if (store.get("SELECT id FROM tasks WHERE metadata IS NULL OR COALESCE(json_extract(metadata,'$.product'),'') != 'synthetic'") ||
      store.get("SELECT id FROM sessions WHERE source_path IS NOT NULL OR (product IS NOT NULL AND product != 'synthetic')") ||
      store.get("SELECT id FROM events WHERE json_extract(payload,'$.kind') = 'usage' AND COALESCE(json_extract(payload,'$.product'),'') != 'synthetic'") ||
      store.get('SELECT id FROM otel_processes')) throw new Error('synthetic_store_required');
}
function stratumFor(config: Protocol | FlexibleProtocol, input: AssignmentInput | FlexibleAssignmentInput) {
  if (!config.participants.includes(input.metadata.assignee) || !config.environment_ids.includes(input.environment_id)) throw new Error('ineligible_task');
  const strata = config.strata.filter(stratum => stratum.assignees.includes(input.metadata.assignee) && stratum.types.includes(input.metadata.type) && stratum.sizes.includes(input.metadata.expected_size));
  if (strata.length !== 1) throw new Error('ineligible_task');
  return strata[0]!;
}

/** Returns only committed current assignments. No real-experiment admission path. */
export function assignTask(store: Store, input: unknown, dependencies: AllocationDependencies = {}): AssignmentReceipt {
  const config = parseComparison(z.union([AssignmentInputSchema, FlexibleAssignmentInputSchema]), input);
  const now = comparisonTimestamp((dependencies.clock ?? (() => new Date().toISOString()))());
  const outcome = store.immediateTransaction(() => {
    const keys = [...new Set([config.logical_task_id, ...(config.alias_ids ?? [])])];
    rejectTombstones(store, config, keys);
    const requestedProtocol = protocolRow(store, config.protocol_id);
    if (requestedProtocol.project_id !== config.project_id) throw new Error('project_mismatch');
    const requestedTask = store.get<TaskRow>('SELECT * FROM tasks WHERE id = ?', [config.task_id]);
    if (requestedTask && requestedTask.project_id !== config.project_id) throw new Error('project_mismatch');
    const identities = keys.flatMap(key => store.all<IdentityRow>('SELECT task_id,key_id FROM comparison_identity_keys WHERE project_id = ? AND key_id = ?', [config.project_id, key]));
    const mappedTaskIds = [...new Set(identities.map(row => row.task_id))];
    // A requested existing canonical ID can expose a late duplicate even without a known alias.
    if (store.get('SELECT task_id FROM comparison_preregistrations WHERE task_id = ?', [config.task_id]) && !mappedTaskIds.includes(config.task_id)) mappedTaskIds.push(config.task_id);
    if (mappedTaskIds.length > 1) {
      invalidateIdentityConflict(store, mappedTaskIds, now, dependencies.discloseReports);
      return { error: 'identity_conflict' } as const;
    }
    const canonicalId = mappedTaskIds[0] ?? config.task_id;
    const original = store.get<AssignmentRow>('SELECT * FROM comparison_assignments WHERE task_id = ?', [canonicalId]);
    if (original) {
      if (original.project_id !== config.project_id) throw new Error('project_mismatch');
      assertPreregistration(store, canonicalId, config);
      if (original.allocator_id !== config.allocator_id) throw new Error('allocator_conflict');
      assertUnsealedIdentity(store, canonicalId, keys);
      bindIdentityKeys(store, config, canonicalId);
      if (original.protocol_id !== config.protocol_id || canonicalId !== config.task_id) {
        if (Date.parse(now) < Date.parse(original.assigned_at)) throw new Error('clock_regression');
        store.execute('INSERT INTO comparison_deviations(id,task_id,occurred_at,recorded_at,reason_code) VALUES (?,?,?,?,?)', [randomUUID(), canonicalId, now, now, 'reassignment_attempt']);
      }
      return { receipt: receipt(original, true) };
    }
    const protocol = comparisonProtocol(store, requestedProtocol);
    if(protocol.purpose!=='synthetic_validation' && (protocol.schema_version!==2 || !comparisonReadiness(store,protocol.id,now).real_allocation) &&
      !(protocol.schema_version===2&&functionalWorkflowEligible(store,protocol))&&
      !(dependencies.pilotPreparation && protocol.schema_version===2 && (isHumanPilotProtocol(protocol)||isAdmittedCodexBindingProtocol(protocol))))throw new Error('real_experiment_disabled');
    if (Date.parse(now) < Date.parse(protocol.recruitment_start) || Date.parse(now) >= Date.parse(protocol.recruitment_end)) throw new Error('outside_recruitment');
    const variant = comparisonVariant(store, protocol.variant_ids[0]);
    if (protocol.schema_version !== config.schema_version || variant.schema_version !== config.schema_version) throw new Error('configuration_mismatch');
    if (config.schema_version === 1 && variant.schema_version === 1) {
      if (config.metadata.product !== 'synthetic' || config.metadata.product !== variant.product || config.metadata.model !== variant.model) throw new Error('configuration_mismatch');
    } else if(protocol.purpose==='synthetic_validation' && config.metadata.product!=='synthetic')throw new Error('synthetic_only');
    else if(protocol.schema_version===2 && !protocol.source_profiles.some(p=>p.product===config.metadata.product))throw new Error('configuration_mismatch');
    const stratum = stratumFor(protocol, config);
    const state = store.get<AllocationState>('SELECT * FROM comparison_allocation_state WHERE protocol_id = ? AND stratum_id = ?', [protocol.id, stratum.id]);
    if (!state || state.allocator_id !== config.allocator_id || stratum.allocator_id !== config.allocator_id) throw new Error('allocator_conflict');
    const task = store.get<TaskRow>('SELECT * FROM tasks WHERE id = ?', [canonicalId]);
    if (task) {
      if (task.project_id !== config.project_id) throw new Error('project_mismatch');
      if (task.state !== 'registered' || task.started_at) throw new Error('task_already_started');
      if (task.metadata !== JSON.stringify(config.metadata)) throw new Error('preregistration_conflict');
      if (task.last_transition_at && Date.parse(now) < Date.parse(task.last_transition_at)) throw new Error('clock_regression');
    }
    if(protocol.purpose==='synthetic_validation')assertSyntheticStore(store);
    else if(!store.get('SELECT singleton FROM flexible_workspace_scope')){
      if(store.get('SELECT id FROM tasks LIMIT 1') || store.get('SELECT id FROM sessions LIMIT 1') || store.get('SELECT id FROM events LIMIT 1') || store.get('SELECT id FROM otel_processes LIMIT 1'))throw new Error('separate_store_required');
      store.execute("INSERT INTO flexible_workspace_scope VALUES (1,'real_experiment')",[]);
    }
    let pending = parseComparison(ProtocolSchemaVariants, JSON.parse(state.pending_variants) as unknown);
    let blockId = state.block_id;
    if (pending.length === 0) {
      const balanced = Array.from({ length: protocol.block_size }, (_, index) => protocol.variant_ids[index < protocol.block_size / 2 ? 0 : 1]);
      const proposed = (dependencies.shuffle ?? shuffled)(balanced);
      pending = parseComparison(ProtocolSchemaVariants, proposed, 'invalid_shuffle');
      if (pending.length !== protocol.block_size || protocol.variant_ids.some(id => pending.filter(value => value === id).length !== protocol.block_size / 2)) throw new Error('invalid_shuffle');
      blockId = randomUUID();
    }
    const variantId = pending.shift();
    if (!variantId || !blockId || !protocol.variant_ids.includes(variantId) || !Number.isSafeInteger(state.next_index + 1)) throw new Error('invalid_allocation_state');
    const deadline = comparisonTimestamp(new Date(Date.parse(now) + protocol.followup_seconds * 1000).toISOString());
    if(protocol.purpose==='synthetic_validation')store.execute("INSERT OR IGNORE INTO comparison_workspace_scope(singleton,purpose) VALUES (1,'synthetic_validation')", []);
    if (!task) new Lifecycle(store, () => now).createTask(config.project_id, canonicalId, config.metadata);
    bindIdentityKeys(store, config, canonicalId);
    store.execute('INSERT INTO comparison_preregistrations(task_id,metadata,environment_id,code_base_commit,registered_at) VALUES (?,?,?,?,?)', [canonicalId, JSON.stringify(config.metadata), config.environment_id, config.code_base_commit, now]);
    const assignment: AssignmentRow = { id: randomUUID(), task_id: canonicalId, project_id: config.project_id, protocol_id: protocol.id,
      variant_id: variantId, assigned_at: now, recorded_at: now, followup_ends_at: deadline, stratum_id: stratum.id,
      block_id: blockId, allocation_index: state.next_index, allocator_id: config.allocator_id };
    store.execute('INSERT INTO comparison_assignments(id,task_id,project_id,protocol_id,variant_id,assigned_at,recorded_at,followup_ends_at,stratum_id,block_id,allocation_index,allocator_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [assignment.id, canonicalId, config.project_id, protocol.id, variantId, now, now, deadline, stratum.id, blockId, state.next_index, config.allocator_id]);
    store.execute('UPDATE comparison_allocation_state SET next_index = ?, block_id = ?, pending_variants = ? WHERE protocol_id = ? AND stratum_id = ?', [state.next_index + 1, blockId, JSON.stringify(pending), protocol.id, stratum.id]);
    return { receipt: receipt(assignment, false) };
  });
  if ('error' in outcome) throw new Error(outcome.error);
  return outcome.receipt;
}

// Private state is validated on read and never included in public receipts.
const ProtocolSchemaVariants = z.array(IdSchema).max(256);
