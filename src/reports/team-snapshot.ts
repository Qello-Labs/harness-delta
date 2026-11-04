import { z } from 'zod';
import { FlexibleTeamInputSchema, FlexibleTeamRequestSchema, projectFlexibleTeam, type FlexibleTeamReport } from './flexible-team.js';
import { IdSchema } from '../contracts.js';
import { parseComparison } from '../comparison-contracts.js';
import { type Clock, utcNow } from '../lifecycle.js';
import type { Store } from '../store.js';
import { parseExchangePackage, digest, time } from '../exchange/contracts.js';
import { readMapping, registeredDestination } from '../exchange/mapping.js';
import { assertNotRetired } from '../exchange/invalidation.js';
import { validateDataPackage } from '../exchange/identity.js';
import { canonicalJson } from '../canonical-json.js';
import { codePointOrder } from './comparison-task.js';
import { summarizeComparisonTasks } from './comparison-summary.js';
import { TeamInputSchema, TeamRequestSchema, type TeamInput } from './team-contracts.js';
const ms = Date.parse;
function projectTeam(input: TeamInput) {
  const { request, mapping } = input;
  const expected = [...new Set(mapping.writers.map(w => w.namespace_id))].sort(codePointOrder);
  const contributions = [...input.contributions].sort((a, b) => codePointOrder(a.package.namespace_id, b.package.namespace_id));
  if (
    canonicalJson(expected) !== canonicalJson(request.required_namespaces) ||
    mapping.local_project_id !== request.local_project_id ||
    mapping.shared_project_id !== request.shared_project_id ||
    mapping.protocol_id !== request.protocol_id ||
    ms(request.as_of) > ms(input.created_at) ||
    ms(request.cutoff) > ms(request.as_of)
  )
    throw new Error('invalid_snapshot_request');
  if (new Set(contributions.map(c => c.package.namespace_id)).size !== contributions.length) throw new Error('invalid_snapshot');
  for (const c of contributions) {
    validateDataPackage(c.package, mapping, request.as_of);
    if (
      c.package.shared_project_id !== request.shared_project_id ||
      c.package.protocol_id !== request.protocol_id ||
      !expected.includes(c.package.namespace_id) ||
      c.package.tombstones.length
    )
      throw new Error('invalid_snapshot');
    if (c.package.cutoff !== request.cutoff) throw new Error('cutoff_mismatch');
    if (ms(c.received_at) > ms(request.as_of) || ms(c.package.produced_at) > ms(c.received_at)) throw new Error('snapshot_as_of_unavailable');
  }
  const first = contributions[0]!.package;
  const protocol = first.protocol.settings;
  const keys = new Set<string>();
  const slots = new Set<string>();
  const assignments = new Set<string>();
  const tasks = contributions
    .flatMap(c =>
      c.package.assignments.map(a => {
        for (const key of new Set([a.task_id, a.logical_task_id, ...a.alias_ids])) {
          if (keys.has(key)) throw new Error('identity_conflict');
          keys.add(key);
        }
        const slot = canonicalJson([a.stratum_id, a.allocation_index]);
        if (slots.has(slot) || assignments.has(a.assignment_id)) throw new Error('assignment_conflict');
        slots.add(slot);
        assignments.add(a.assignment_id);
        const { evidence, ...identity } = a;
        const deadlineStatus =
          ms(request.cutoff) < ms(a.followup_ends_at)
            ? ('pending_followup' as const)
            : (evidence.current_outcome ?? (evidence.started ? ('outcome_missing' as const) : ('not_started' as const)));
        return {
          ...identity,
          ...evidence,
          namespace_id: c.package.namespace_id,
          endpoint_end: new Date(Math.min(ms(request.cutoff), ms(a.followup_ends_at))).toISOString(),
          deadline_status: deadlineStatus
        };
      })
    )
    .sort((a, b) => codePointOrder(a.task_id, b.task_id));
  const missing = expected.filter(id => !contributions.some(c => c.package.namespace_id === id));
  const summary = summarizeComparisonTasks(tasks, protocol, true);
  return {
    schema_version: 1 as const,
    descriptive_version: input.descriptive_version,
    snapshot_id: request.snapshot_id,
    validity_status: 'valid' as const,
    mode: 'randomized_task' as const,
    purpose: 'synthetic_validation' as const,
    shared_project_id: request.shared_project_id,
    protocol_id: request.protocol_id,
    settings: protocol,
    variants: first.variants,
    cutoff: request.cutoff,
    as_of: request.as_of,
    created_at: input.created_at,
    merged_revision: input.merged_revision,
    snapshot_sequence: input.snapshot_sequence,
    source_vector: contributions.map(c => ({
      namespace_id: c.package.namespace_id,
      export_revision: c.package.export_revision,
      source_snapshot_sequence: c.package.source_snapshot_sequence,
      source_evaluated_at: c.package.source_evaluated_at,
      identity_captured_at: c.package.identity_captured_at,
      produced_at: c.package.produced_at,
      received_at: c.received_at
    })),
    required_namespaces: expected,
    missing_namespaces: missing,
    declared_writer_coverage: missing.length ? ('partial' as const) : ('complete' as const),
    team_completeness: 'unverified' as const,
    team_assignment_denominator: null,
    recruitment_context: { status: 'unavailable' as const, reason: 'registration_activity_not_shared' as const },
    provisional: ms(request.cutoff) < ms(protocol.recruitment_end) || tasks.some(t => t.deadline_status === 'pending_followup'),
    ...summary,
    tasks,
    adoption: { status: 'inconclusive' as const, reason: 'analysis_not_validated' as const },
    confidence_interval: null,
    p_value: null,
    limitations: [
      'partial_usage_is_not_a_task_total',
      'no_complete_cost_or_savings',
      'no_causal_or_adoption_conclusion',
      'current_source_evaluation_not_historical_knowledge',
      'as_of_is_coordinator_receipt_boundary',
      'elapsed_is_not_human_labor',
      'declared_configuration_does_not_prove_isolation',
      'namespace_is_not_authenticated',
      'team_completeness_unverified'
    ]
  };
}
export type AnyTeamReport = TeamReport | FlexibleTeamReport;
export type TeamReport = ReturnType<typeof projectTeam> & { snapshot_hash: string };
type Reason = 'deletion' | 'identity_conflict';
function invalidated(id: string, reason: Reason) {
  return {
    schema_version: 1 as const,
    snapshot_id: id,
    validity_status: 'invalidated' as const,
    reason,
    original_cohort: reason === 'deletion' ? ('unavailable_due_to_deletion' as const) : ('unavailable_due_to_identity_conflict' as const),
    adoption: { status: 'inconclusive' as const, reason }
  };
}
export type InvalidatedTeamReport = ReturnType<typeof invalidated>;
interface SnapshotRow {
  snapshot_id: string;
  shared_project_id: string;
  protocol_id: string;
  request_json: string;
  input_json: string;
  report_json: string;
  snapshot_hash: string;
}
function stored(row: SnapshotRow): AnyTeamReport {
  try {
    const raw: unknown = JSON.parse(row.input_json);
    const input = parseComparison(z.union([TeamInputSchema, FlexibleTeamInputSchema]), raw, 'invalid_snapshot');
    const hash = digest(input);
    const report = input.schema_version === 2 ? projectFlexibleTeam(input) : { ...projectTeam(input), snapshot_hash: hash };
    if (
      hash !== row.snapshot_hash ||
      canonicalJson(report) !== row.report_json ||
      canonicalJson(input.request) !== row.request_json ||
      input.request.snapshot_id !== row.snapshot_id ||
      input.request.protocol_id !== row.protocol_id ||
      input.request.shared_project_id !== row.shared_project_id
    )
      throw new Error('invalid_snapshot');
    return report;
  } catch {
    throw new Error('invalid_snapshot');
  }
}
export function readTeamSnapshot(store: Store, snapshotId: string): AnyTeamReport | InvalidatedTeamReport {
  parseComparison(IdSchema, snapshotId, 'invalid_report_id');
  return store.transaction(() => {
    const tombstone = store.get<{ reason: Reason }>('SELECT reason FROM exchange_team_report_tombstones WHERE snapshot_id=?', [snapshotId]);
    if (tombstone) return invalidated(snapshotId, tombstone.reason);
    const row = store.get<SnapshotRow>('SELECT * FROM exchange_team_snapshots WHERE snapshot_id=?', [snapshotId]);
    if (!row) throw new Error('unknown_report');
    const denial = store.get<{ reason: Reason }>('SELECT reason FROM exchange_protocol_invalidations WHERE shared_project_id=? AND protocol_id=?', [
      row.shared_project_id,
      row.protocol_id
    ]);
    if (denial) return invalidated(snapshotId, denial.reason);
    return stored(row);
  });
}
export function createTeamSnapshot(store: Store, input: unknown, clock: Clock = utcNow): AnyTeamReport {
  const request = parseComparison(z.union([TeamRequestSchema, FlexibleTeamRequestSchema]), input, 'invalid_snapshot_request');
  request.required_namespaces.sort(codePointOrder);
  return store.immediateTransaction(() => {
    if (store.get('SELECT snapshot_id FROM exchange_team_report_tombstones WHERE snapshot_id=?', [request.snapshot_id])) throw new Error('invalidated_report');
    const mapping = readMapping(store, request.shared_project_id, request.protocol_id, request.local_project_id);
    registeredDestination(store, request.local_project_id);
    assertNotRetired(store, request.shared_project_id, request.protocol_id);
    const existing = store.get<SnapshotRow>('SELECT * FROM exchange_team_snapshots WHERE snapshot_id=?', [request.snapshot_id]);
    if (existing) {
      if (existing.request_json !== canonicalJson(request)) throw new Error('report_conflict');
      return stored(existing);
    }
    const now = parseComparison(time, clock(), 'invalid_snapshot_request');
    if (ms(request.as_of) > ms(now) || ms(request.cutoff) > ms(request.as_of)) throw new Error('invalid_snapshot_request');
    const revisions = store.all<{ namespace_id: string; received_at: string; header_json: string }>(
      'SELECT namespace_id,received_at,header_json FROM exchange_import_revisions WHERE shared_project_id=? AND protocol_id=? ORDER BY namespace_id',
      [request.shared_project_id, request.protocol_id]
    );
    if (!revisions.length) throw new Error('missing_exchange_data');
    if (revisions.some(r => ms(r.received_at) > ms(request.as_of))) throw new Error('snapshot_as_of_unavailable');
    const contributions = revisions.map(r => {
      const header = JSON.parse(r.header_json) as Record<string, unknown>;
      const assignments = store
        .all<{ assignment_json: string }>('SELECT assignment_json FROM exchange_tasks WHERE namespace_id=? ORDER BY task_id', [r.namespace_id])
        .map(a => JSON.parse(a.assignment_json) as unknown);
      const pkg = parseExchangePackage({ ...header, assignments });
      if (pkg.kind !== 'assignment_metadata') throw new Error('invalid_snapshot');
      return { received_at: r.received_at, package: pkg };
    });
    const sequence =
      (store.get<{ last_sequence: number }>('SELECT last_sequence FROM exchange_team_sequences WHERE shared_project_id=? AND protocol_id=?', [
        request.shared_project_id,
        request.protocol_id
      ])?.last_sequence ?? 0) + 1;
    if (!Number.isSafeInteger(sequence)) throw new Error('revision_overflow');
    const captured = parseComparison(
      z.union([TeamInputSchema, FlexibleTeamInputSchema]),
      {
        schema_version: request.schema_version,
        descriptive_version: request.schema_version === 2 ? 'flexible-team-descriptive-1' : 'team-descriptive-1',
        request,
        mapping,
        created_at: now,
        merged_revision:
          store.get<{ revision: number }>('SELECT revision FROM exchange_merge_state WHERE shared_project_id=?', [request.shared_project_id])?.revision ?? 0,
        snapshot_sequence: sequence,
        contributions
      },
      'invalid_snapshot'
    );
    const hash = digest(captured);
    const report = captured.schema_version === 2 ? projectFlexibleTeam(captured) : { ...projectTeam(captured), snapshot_hash: hash };
    store.execute('INSERT INTO exchange_team_snapshots VALUES (?,?,?,?,?,?,?)', [
      request.snapshot_id,
      request.shared_project_id,
      request.protocol_id,
      canonicalJson(request),
      canonicalJson(captured),
      canonicalJson(report),
      hash
    ]);
    for (const namespace of request.required_namespaces) store.execute('INSERT INTO exchange_team_dependencies VALUES (?,?)', [request.snapshot_id, namespace]);
    store.execute(
      'INSERT INTO exchange_team_sequences VALUES (?,?,?) ON CONFLICT(shared_project_id,protocol_id) DO UPDATE SET last_sequence=excluded.last_sequence',
      [request.shared_project_id, request.protocol_id, sequence]
    );
    return report;
  });
}
