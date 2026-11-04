import type { Store } from '../../store.js';
import { canonicalJson } from '../../canonical-json.js';
import type { AnyDataPackage, AnySharedAssignment } from './contracts.js';
import { protocolDigest } from './contracts.js';
import type { Mapping } from './mapping.js';
const ms = Date.parse;
function invalid(code = 'invalid_exchange_package'): never {
  throw new Error(code);
}
export function validateDataAuthority(pkg: AnyDataPackage, mapping: Mapping, now: string): void {
  const p = pkg.protocol.settings;
  if (protocolDigest(pkg) !== mapping.protocol_digest || pkg.protocol_id !== p.id || p.shared_project_id !== pkg.shared_project_id)
    invalid('protocol_conflict');
  if (p.purpose !== 'synthetic_validation') invalid('real_experiment_disabled');
  if (!(
    ms(pkg.cutoff) <= ms(pkg.source_evaluated_at) &&
    ms(pkg.source_evaluated_at) <= ms(pkg.identity_captured_at) &&
    ms(pkg.identity_captured_at) <= ms(pkg.produced_at) &&
    ms(pkg.produced_at) <= ms(now) &&
    ms(pkg.protocol.frozen_at) <= ms(pkg.cutoff)
  ))
    invalid();
  if (p.variant_ids.some((v, i) => v !== pkg.variants[i]!.id) || mapping.writers.length !== p.strata.length) invalid('protocol_conflict');
  for (const s of p.strata) if (!mapping.writers.some(w => w.stratum_id === s.id && w.allocator_id === s.allocator_id)) invalid('authority_conflict');
  const writers = mapping.writers.filter(w => w.namespace_id === pkg.namespace_id);
  if (
    writers.length !== pkg.authority.length ||
    writers.some(w => !pkg.authority.some(a => a.stratum_id === w.stratum_id && a.allocator_id === w.allocator_id))
  )
    invalid('authority_conflict');
}
export function validateDataPackage(pkg: AnyDataPackage, mapping: Mapping, now: string): void {
  validateDataAuthority(pkg, mapping, now);
  const p = pkg.protocol.settings;
  const [a, b] = pkg.variants;
  if (pkg.schema_version === 1 && (pkg.variants[0].product !== 'synthetic' || pkg.variants[1].product !== 'synthetic')) invalid('real_experiment_disabled');
  if (
    a.policy_status !== 'eligible' ||
    b.policy_status !== 'eligible' ||
    (pkg.schema_version === 1 &&
      (pkg.variants[0].product_version !== pkg.variants[1].product_version ||
        pkg.variants[0].model !== pkg.variants[1].model ||
        pkg.variants[0].reasoning_setting !== pkg.variants[1].reasoning_setting)) ||
    ms(pkg.protocol.frozen_at) >= ms(p.recruitment_start)
  )
    invalid('protocol_conflict');
  if (p.strata.some(s => s.assignees.some(id => !p.participants.includes(id))) || p.participants.some(id => !p.strata.some(s => s.assignees.includes(id))))
    invalid('protocol_conflict');
  for (let i = 0; i < p.strata.length; i++)
    for (const other of p.strata.slice(i + 1)) {
      const s = p.strata[i]!;
      if (s.assignees.some(v => other.assignees.includes(v)) && s.types.some(v => other.types.includes(v)) && s.sizes.some(v => other.sizes.includes(v)))
        invalid('protocol_conflict');
    }
  const writers = mapping.writers.filter(w => w.namespace_id === pkg.namespace_id);
  const slots = new Set<string>();
  const blocks = new Map<string, string>();
  const keys = new Map<string, string>();
  for (const a of pkg.assignments) {
    if (!writers.some(w => w.stratum_id === a.stratum_id && w.allocator_id === a.allocator_id)) invalid('authority_conflict');
    const strata = p.strata.filter(
      s => s.assignees.includes(a.metadata.assignee) && s.types.includes(a.metadata.type) && s.sizes.includes(a.metadata.expected_size)
    );
    if (strata.length !== 1 || strata[0]!.id !== a.stratum_id || !p.participants.includes(a.metadata.assignee) || !p.environment_ids.includes(a.environment_id))
      invalid('authority_conflict');
    if (
      a.protocol_id !== p.id ||
      !p.variant_ids.includes(a.original_variant_id) ||
      a.metadata.product !== 'synthetic' ||
      (pkg.schema_version === 1 && (!('model' in a.metadata) || a.metadata.model !== pkg.variants[0].model))
    )
      invalid('assignment_conflict');
    if (!(
      ms(a.registered_at) <= ms(a.assigned_at) &&
      ms(pkg.protocol.frozen_at) <= ms(a.assigned_at) &&
      ms(a.assigned_at) >= ms(p.recruitment_start) &&
      ms(a.assigned_at) < Math.min(ms(p.recruitment_end), ms(pkg.cutoff)) &&
      ms(a.assignment_recorded_at) >= ms(a.assigned_at) &&
      ms(a.assignment_recorded_at) <= ms(pkg.source_evaluated_at) &&
      ms(a.followup_ends_at) === ms(a.assigned_at) + p.followup_seconds * 1000
    ))
      invalid();
    const slot = JSON.stringify([a.stratum_id, a.allocation_index]);
    if (slots.has(slot)) invalid('assignment_conflict');
    slots.add(slot);
    const block = JSON.stringify([a.stratum_id, Math.floor(a.allocation_index / p.block_size)]);
    const blockIdentity = JSON.stringify([a.stratum_id, a.block_id]);
    if ((blocks.has(block) && blocks.get(block) !== blockIdentity) || [...blocks].some(([k, v]) => k !== block && v === blockIdentity))
      invalid('assignment_conflict');
    blocks.set(block, blockIdentity);
    for (const key of new Set([a.task_id, a.logical_task_id, ...a.alias_ids])) {
      if (keys.has(key) && keys.get(key) !== a.task_id) invalid('identity_conflict');
      keys.set(key, a.task_id);
    }
    const e = a.evidence;
    const end = Math.min(ms(pkg.cutoff), ms(a.followup_ends_at));
    const inWindow = (at: string) => ms(at) >= ms(a.assigned_at) && ms(at) < end;
    if ([e.first_completed_at, e.first_assessed_at, e.finalized_at, e.outcome_assessed_at].some(at => at !== null && !inWindow(at))) invalid();
    if (
      (e.current_outcome === null) !== (e.outcome_assessed_at === null) ||
      (e.current_outcome === null) !== (e.finalized_at === null) ||
      (e.first_success === null) !== (e.first_assessed_at === null) ||
      (e.first_assessed_at !== null && (e.first_completed_at === null || ms(e.first_assessed_at) < ms(e.first_completed_at))) ||
      (e.current_outcome !== null && (!e.started || e.finalized_at !== e.outcome_assessed_at)) ||
      e.criteria_met.some(c => !a.metadata.criterion_ids.includes(c)) ||
      (e.current_outcome === 'success' && e.criteria_met.length !== a.metadata.criterion_ids.length) ||
      (e.current_outcome === null && e.criteria_met.length)
    )
      invalid();
    if (e.deviations.some(d => !inWindow(d.occurred_at) || ms(d.recorded_at) < ms(d.occurred_at) || ms(d.recorded_at) > ms(pkg.source_evaluated_at))) invalid();
    if (e.observations.some(o => ms(o.started_at) < ms(a.assigned_at) || ms(o.ended_at) > end || ms(o.started_at) >= ms(o.ended_at))) invalid();
    if (
      e.started
        ? e.time.active_ms === null || e.time.elapsed_ms === null || e.time.active_ms > e.time.elapsed_ms || e.time.elapsed_ms > end - ms(a.assigned_at)
        : e.time.active_ms !== null || e.time.elapsed_ms !== null
    )
      invalid();
  }
}
export function assignmentIdentity(a: AnySharedAssignment): string {
  const { evidence, ...identity } = a;
  void evidence;
  return canonicalJson(identity);
}
export interface ExistingTask {
  shared_project_id: string;
  protocol_id: string;
  namespace_id: string;
  task_id: string;
  assignment_json: string;
}
export function existingConflict(store: Store, pkg: AnyDataPackage): { reason: 'identity_conflict' | 'assignment_conflict'; protocols: string[] } | undefined {
  for (const a of pkg.assignments) {
    if (
      [a.task_id, a.logical_task_id, ...a.alias_ids].some(k =>
        store.get('SELECT key_id FROM exchange_tombstones WHERE shared_project_id=? AND key_id=?', [pkg.shared_project_id, k])
      )
    )
      invalid('deleted_identifier');
    for (const key of new Set([a.task_id, a.logical_task_id, ...a.alias_ids])) {
      const old = store.get<ExistingTask>('SELECT task_id,protocol_id,namespace_id FROM exchange_identity_keys WHERE shared_project_id=? AND key_id=?', [
        pkg.shared_project_id,
        key
      ]);
      if (old && (old.task_id !== a.task_id || old.namespace_id !== pkg.namespace_id || old.protocol_id !== pkg.protocol_id))
        return { reason: 'identity_conflict', protocols: [...new Set([old.protocol_id, pkg.protocol_id])] };
    }
    const old = store.get<ExistingTask>(
      'SELECT * FROM exchange_tasks WHERE shared_project_id=? AND (task_id=? OR assignment_id=? OR (protocol_id=? AND stratum_id=? AND allocation_index=?))',
      [pkg.shared_project_id, a.task_id, a.assignment_id, pkg.protocol_id, a.stratum_id, a.allocation_index]
    );
    if (
      old &&
      (old.namespace_id !== pkg.namespace_id ||
        old.protocol_id !== pkg.protocol_id ||
        assignmentIdentity(JSON.parse(old.assignment_json) as AnySharedAssignment) !== assignmentIdentity(a))
    )
      return { reason: 'assignment_conflict', protocols: [...new Set([old.protocol_id, pkg.protocol_id])] };
    if (old) {
      const previous = (JSON.parse(old.assignment_json) as AnySharedAssignment).evidence;
      if (
        previous.current_outcome !== null &&
        canonicalJson([previous.current_outcome, previous.criteria_met, previous.outcome_assessed_at, previous.finalized_at]) !==
          canonicalJson([a.evidence.current_outcome, a.evidence.criteria_met, a.evidence.outcome_assessed_at, a.evidence.finalized_at])
      )
        invalid('evidence_conflict');
      if (
        previous.first_assessed_at !== null &&
        canonicalJson([previous.first_assessed_at, previous.first_success, previous.first_completed_at]) !==
          canonicalJson([a.evidence.first_assessed_at, a.evidence.first_success, a.evidence.first_completed_at])
      )
        invalid('evidence_conflict');
    }
  }
  const ids = new Set(pkg.assignments.map(a => a.task_id));
  if (store.all<{ task_id: string }>('SELECT task_id FROM exchange_tasks WHERE namespace_id=?', [pkg.namespace_id]).some(t => !ids.has(t.task_id)))
    invalid('evidence_conflict');
  return undefined;
}
