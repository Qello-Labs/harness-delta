import { overlayEventCompatibility } from '../source-compatibility.js';
import { captureFlexibleInput, FlexibleSnapshotInputSchema, projectFlexibleComparison, type FlexibleComparisonReport } from './flexible-comparison.js';
import { parseProtocol } from '../flexible-contracts.js';
import { createHash } from 'node:crypto';
import { EventSchema, IdSchema, TaskMetadataSchema } from '../contracts.js';
import { comparisonTimestamp, ConfigurationRecordSchema, parseComparison } from '../comparison-contracts.js';
import { frozenProtocol, protocolRow, variantConfiguration } from '../comparison.js';
import type { AssignmentRow } from '../allocation.js';
import type { Clock, TaskRow } from '../lifecycle.js';
import { utcNow } from '../lifecycle.js';
import type { Store } from '../store.js';
import { ComparisonSnapshotInputSchema, SnapshotRequestSchema } from './comparison-contracts.js';
import type { ComparisonSnapshotInput, ComparisonSnapshotRequest, InvalidatedReport, SnapshotAssignment } from './comparison-contracts.js';
import { codePointOrder, projectComparison } from './comparison.js';
import type { ComparisonReport } from './comparison.js';

interface SnapshotRow {
  report_id: string;
  protocol_id: string;
  input_json: string;
  report_json: string;
  snapshot_hash: string;
}
interface Tombstone {
  reason_code: 'deletion' | 'identity_conflict';
}
/** Object keys use code-point order; input arrays are sorted by their semantic identity on capture. */
export function canonicalJson(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item !== null && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => codePointOrder(a, b))
          .map(([key, val]) => [key, canonical(val)])
      );
    return item;
  };
  return JSON.stringify(canonical(value));
}
function invalidated(reportId: string, reason: Tombstone['reason_code']): InvalidatedReport {
  return {
    schema_version: 1,
    report_id: reportId,
    validity_status: 'invalidated',
    reason,
    original_cohort: reason === 'deletion' ? 'unavailable_due_to_deletion' : 'unavailable_due_to_identity_conflict',
    adoption: { status: 'inconclusive', reason }
  };
}
function storedReport(row: SnapshotRow): ComparisonReport | FlexibleComparisonReport {
  try {
    const raw: unknown = JSON.parse(row.input_json);
    if (FlexibleSnapshotInputSchema.safeParse(raw).success) {
      const input = parseComparison(FlexibleSnapshotInputSchema, raw, 'invalid_snapshot');
      const report = projectFlexibleComparison(input);
      if (report.snapshot_hash !== row.snapshot_hash) throw new Error('invalid_snapshot');
      if (canonicalJson(report) === row.report_json) return report;
      // Old snapshots have no source provenance. Validate their original algorithm,
      // then expose a conservative current view without rewriting frozen evidence.
      if (input.assignments.some(a => a.usages.some(u => u.event.payload.source_compatibility))) throw new Error('invalid_snapshot');
      if (canonicalJson(projectFlexibleComparison(input, true)) !== row.report_json) throw new Error('invalid_snapshot');
      return { ...report, limitations: [...report.limitations, 'legacy_snapshot_source_trust_unverified'] };
    }
    const input = parseComparison(ComparisonSnapshotInputSchema, JSON.parse(row.input_json) as unknown, 'invalid_snapshot');
    const hash = createHash('sha256').update(canonicalJson(input)).digest('hex');
    const report = { ...projectComparison(input), snapshot_hash: hash };
    if (hash !== row.snapshot_hash || canonicalJson(report) !== row.report_json) throw new Error('invalid_snapshot');
    return report;
  } catch {
    throw new Error('invalid_snapshot');
  }
}
export function readComparisonSnapshot(store: Store, reportId: string): ComparisonReport | FlexibleComparisonReport | InvalidatedReport {
  parseComparison(IdSchema, reportId, 'invalid_report_id');
  return store.transaction(() => {
    const tombstone = store.get<Tombstone>('SELECT reason_code FROM comparison_report_tombstones WHERE report_id=?', [reportId]);
    if (tombstone) return invalidated(reportId, tombstone.reason_code);
    const row = store.get<SnapshotRow>(
      'SELECT report_id,protocol_id,input_json,report_json,snapshot_hash FROM comparison_report_snapshots WHERE report_id=? UNION ALL SELECT report_id,protocol_id,input_json,report_json,snapshot_hash FROM flexible_report_snapshots WHERE report_id=?',
      [reportId, reportId]
    );
    if (!row) throw new Error('unknown_report');
    const protocol = protocolRow(store, row.protocol_id);
    if (protocol.status === 'invalidated_by_deletion' || protocol.status === 'identity_conflict')
      return invalidated(reportId, protocol.status === 'identity_conflict' ? 'identity_conflict' : 'deletion');
    if (protocol.status !== 'frozen') throw new Error('protocol_not_active');
    return currentCompatibilityReport(store, row);
  });
}
function currentCompatibilityReport(store: Store, row: SnapshotRow): ComparisonReport | FlexibleComparisonReport {
  const original = storedReport(row);
  if (original.schema_version !== 2) return original;
  const input = FlexibleSnapshotInputSchema.parse(JSON.parse(row.input_json) as unknown);
  const effective = {
    ...input,
    assignments: input.assignments.map(a => ({ ...a, usages: a.usages.map(u => ({ ...u, event: overlayEventCompatibility(store, u.event) })) }))
  };
  if (canonicalJson(effective) === canonicalJson(input)) return original;
  const report = projectFlexibleComparison(FlexibleSnapshotInputSchema.parse(effective));
  return { ...report, snapshot_hash: original.snapshot_hash, limitations: [...report.limitations, 'source_compatibility_invalidated_since_capture'] };
}
function captureAssignment(store: Store, assignment: AssignmentRow, cutoff: string, evaluatedAt: string): SnapshotAssignment {
  const task = store.get<TaskRow>(
    'SELECT id,project_id,metadata,started_at,first_completed_at,first_assessed_at,first_success,finalized_at FROM tasks WHERE id=?',
    [assignment.task_id]
  );
  const prereg = store.get<{ metadata: string; environment_id: string }>('SELECT metadata,environment_id FROM comparison_preregistrations WHERE task_id=?', [
    assignment.task_id
  ]);
  if (!task || !prereg) throw new Error('invalid_snapshot_input');
  const end = Math.min(Date.parse(cutoff), Date.parse(assignment.followup_ends_at));
  const eligible = (at: string) => Date.parse(at) >= Date.parse(assignment.assigned_at) && Date.parse(at) < end;
  const time = (at: string | null) => (at !== null && eligible(at) ? comparisonTimestamp(at) : null);
  // Serialized criterion IDs are parsed independently; raw DB rows never enter a snapshot.
  const assessment = store.get<{ status: string; assessed_at: string; criteria_met: string }>(
    'SELECT status,assessed_at,criteria_met FROM outcomes WHERE task_id=?',
    [task.id]
  );
  const usages = store
    .all<{
      id: string;
      project_id: string;
      task_id: string;
      session_id: string;
      source_key: string;
      occurred_at: string;
      payload: string;
      recorded_at: string | null;
    }>(
      'SELECT e.id,e.project_id,e.task_id,e.session_id,e.source_key,e.occurred_at,e.payload,r.recorded_at FROM events e LEFT JOIN event_receipts r ON r.event_id=e.id WHERE e.task_id=? ORDER BY e.occurred_at,e.id',
      [task.id]
    )
    .filter(row => eligible(row.occurred_at) && (row.recorded_at === null || Date.parse(row.recorded_at) <= Date.parse(evaluatedAt)))
    .flatMap(row => {
      const event = parseComparison(
        EventSchema,
        {
          id: row.id,
          project_id: row.project_id,
          task_id: row.task_id,
          session_id: row.session_id,
          source_key: row.source_key,
          occurred_at: row.occurred_at,
          payload: JSON.parse(row.payload) as unknown
        },
        'invalid_snapshot_input'
      );
      return event.payload.kind === 'usage'
        ? [{ event_id: event.id, occurred_at: comparisonTimestamp(event.occurred_at), recorded_at: row.recorded_at, payload: event.payload }]
        : [];
    });
  const intervals = store.all<SnapshotAssignment['active_intervals'][number]>(
    'SELECT started_at,ended_at FROM active_intervals WHERE task_id=? ORDER BY started_at,id',
    [task.id]
  );
  const observations = store.all<SnapshotAssignment['observations'][number]>(
    'SELECT started_at,ended_at,status,reason FROM observations WHERE task_id=? ORDER BY started_at,id',
    [task.id]
  );
  const overlap = (row: { started_at: string; ended_at: string | null }) =>
    Date.parse(row.started_at) < end && Date.parse(row.ended_at ?? new Date(end).toISOString()) > Date.parse(assignment.assigned_at);
  const clip = (row: { started_at: string; ended_at: string | null }) => ({
    started_at: new Date(Math.max(Date.parse(row.started_at), Date.parse(assignment.assigned_at))).toISOString(),
    ended_at: new Date(Math.min(Date.parse(row.ended_at ?? new Date(end).toISOString()), end)).toISOString()
  });
  return parseComparison(
    ComparisonSnapshotInputSchema.shape.assignments.element,
    {
      assignment_id: assignment.id,
      task_id: task.id,
      variant_id: assignment.variant_id,
      assigned_at: assignment.assigned_at,
      recorded_at: assignment.recorded_at,
      followup_ends_at: assignment.followup_ends_at,
      stratum_id: assignment.stratum_id,
      block_id: assignment.block_id,
      metadata: parseComparison(TaskMetadataSchema, JSON.parse(prereg.metadata) as unknown),
      environment_id: prereg.environment_id,
      started_at: time(task.started_at),
      first_completed_at: time(task.first_completed_at),
      first_assessed_at: time(task.first_assessed_at),
      first_success: time(task.first_assessed_at) === null || task.first_success === null ? null : task.first_success === 1,
      finalized_at: time(task.finalized_at),
      outcome:
        assessment && eligible(assessment.assessed_at)
          ? { status: assessment.status, assessed_at: assessment.assessed_at, criteria_met: JSON.parse(assessment.criteria_met) as unknown }
          : null,
      rework_starts: store
        .all<{ started_at: string }>("SELECT started_at FROM attempts WHERE task_id=? AND kind='rework' ORDER BY started_at,id", [task.id])
        .filter(row => eligible(row.started_at))
        .map(row => row.started_at),
      active_intervals: intervals.filter(overlap).map(clip),
      observations: observations.filter(overlap).map(row => ({
        ...clip(row),
        status: !row.ended_at || Date.parse(row.ended_at) > end ? 'unmeasurable' : row.status,
        reason: !row.ended_at || Date.parse(row.ended_at) > end ? 'incomplete' : row.reason
      })),
      usages,
      confirmations: store
        .all<{ payload: string; recorded_at: string }>('SELECT payload,recorded_at FROM comparison_confirmations WHERE task_id=? ORDER BY occurred_at,id', [
          task.id
        ])
        .map(row => ({ ...parseComparison(ConfigurationRecordSchema, JSON.parse(row.payload) as unknown), recorded_at: row.recorded_at }))
        .filter(row => eligible(row.occurred_at) && Date.parse(row.recorded_at) <= Date.parse(evaluatedAt)),
      deviations: store
        .all<SnapshotAssignment['deviations'][number]>(
          'SELECT id,occurred_at,recorded_at,reason_code FROM comparison_deviations WHERE task_id=? ORDER BY occurred_at,id',
          [task.id]
        )
        .filter(row => eligible(row.occurred_at) && Date.parse(row.recorded_at) <= Date.parse(evaluatedAt))
    },
    'invalid_snapshot_input'
  );
}
export function createComparisonSnapshot(store: Store, request: ComparisonSnapshotRequest, clock: Clock = utcNow): ComparisonReport | FlexibleComparisonReport {
  const config = parseComparison(SnapshotRequestSchema, request, 'invalid_snapshot_request');
  return store.immediateTransaction(() => {
    if (store.get('SELECT report_id FROM comparison_report_tombstones WHERE report_id=?', [config.reportId])) throw new Error('invalidated_report');
    const row = protocolRow(store, config.protocolId);
    if (parseProtocol(JSON.parse(row.settings) as unknown).schema_version === 2) return createFlexibleSnapshot(store, config, clock);
    if (store.get('SELECT report_id FROM flexible_report_snapshots WHERE report_id=?', [config.reportId])) throw new Error('report_conflict');
    const protocol = frozenProtocol(store, row);
    if (protocol.purpose !== 'synthetic_validation') throw new Error('real_experiment_disabled');
    if (!store.get('SELECT singleton FROM comparison_workspace_scope')) throw new Error('synthetic_store_required');
    const current = store.get<SnapshotRow>(
      'SELECT report_id,protocol_id,input_json,report_json,snapshot_hash FROM comparison_report_snapshots WHERE report_id=?',
      [config.reportId]
    );
    if (current) {
      const prior = storedReport(current);
      if (
        prior.protocol_id !== config.protocolId ||
        prior.cutoff !== config.cutoff ||
        prior.revision_reason !== config.revisionReason ||
        prior.supersedes_report_id !== (config.supersedesReportId ?? null)
      )
        throw new Error('report_conflict');
      return prior;
    }
    const now = comparisonTimestamp(clock());
    if (Date.parse(config.cutoff) > Date.parse(now) || row.frozen_at === null || Date.parse(config.cutoff) < Date.parse(row.frozen_at))
      throw new Error('invalid_cutoff');
    if (config.revisionReason === 'initial') {
      if (config.supersedesReportId) throw new Error('invalid_revision');
    } else {
      if (!config.supersedesReportId) throw new Error('invalid_revision');
      const parent = readComparisonSnapshot(store, config.supersedesReportId);
      if (parent.validity_status !== 'valid' || parent.protocol_id !== config.protocolId || Date.parse(now) < Date.parse(parent.evaluated_at))
        throw new Error('invalid_revision');
      if (config.revisionReason === 'cutoff_advanced' ? Date.parse(config.cutoff) <= Date.parse(parent.cutoff) : config.cutoff !== parent.cutoff)
        throw new Error('invalid_revision');
    }
    const last =
      store.get<{ last_sequence: number }>('SELECT last_sequence FROM comparison_report_sequences WHERE protocol_id=?', [protocol.id])?.last_sequence ?? 0;
    if (!Number.isSafeInteger(last + 1)) throw new Error('revision_overflow');
    const assignments = store
      .all<AssignmentRow>(
        'SELECT id,task_id,project_id,protocol_id,variant_id,assigned_at,recorded_at,followup_ends_at,stratum_id,block_id,allocation_index,allocator_id FROM comparison_assignments WHERE protocol_id=? ORDER BY task_id',
        [protocol.id]
      )
      .filter(
        assignment =>
          Date.parse(assignment.assigned_at) >= Date.parse(protocol.recruitment_start) &&
          Date.parse(assignment.assigned_at) < Math.min(Date.parse(config.cutoff), Date.parse(protocol.recruitment_end))
      )
      .map(assignment => captureAssignment(store, assignment, config.cutoff, now));
    const registrations = store
      .all<{ task_id: string; registered_at: string; assignment_at: string | null; assignment_protocol_id: string | null }>(
        'SELECT t.id AS task_id,t.registered_at,a.assigned_at AS assignment_at,a.protocol_id AS assignment_protocol_id FROM tasks t LEFT JOIN comparison_assignments a ON a.task_id=t.id WHERE t.project_id=? ORDER BY t.id',
        [protocol.project_id]
      )
      .filter(
        task =>
          task.registered_at &&
          Date.parse(task.registered_at) >= Date.parse(protocol.recruitment_start) &&
          Date.parse(task.registered_at) < Math.min(Date.parse(config.cutoff), Date.parse(protocol.recruitment_end))
      )
      .map(task => ({
        ...task,
        assignment_at: task.assignment_at && Date.parse(task.assignment_at) < Date.parse(config.cutoff) ? task.assignment_at : null,
        assignment_protocol_id: task.assignment_at && Date.parse(task.assignment_at) < Date.parse(config.cutoff) ? task.assignment_protocol_id : null
      }));
    const input: ComparisonSnapshotInput = parseComparison(
      ComparisonSnapshotInputSchema,
      {
        schema_version: 1,
        descriptive_version: 'assignment-descriptive-1',
        report_id: config.reportId,
        protocol,
        variants: protocol.variant_ids.map(id => variantConfiguration(store, id)),
        cutoff: config.cutoff,
        evaluated_at: now,
        data_revision: row.data_revision,
        snapshot_sequence: last + 1,
        revision_reason: config.revisionReason,
        supersedes_report_id: config.supersedesReportId ?? null,
        assignments,
        registrations
      },
      'invalid_snapshot_input'
    );
    const serialized = canonicalJson(input);
    const hash = createHash('sha256').update(serialized).digest('hex');
    const report = { ...projectComparison(input), snapshot_hash: hash };
    store.execute(
      'INSERT INTO comparison_report_snapshots(report_id,protocol_id,cutoff,evaluated_at,data_revision,snapshot_sequence,schema_version,descriptive_version,revision_reason,supersedes_report_id,input_json,report_json,snapshot_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [
        config.reportId,
        protocol.id,
        config.cutoff,
        now,
        row.data_revision,
        last + 1,
        1,
        report.descriptive_version,
        config.revisionReason,
        config.supersedesReportId ?? null,
        serialized,
        canonicalJson(report),
        hash
      ]
    );
    const dependencies = [...new Set([...assignments.map(item => item.task_id), ...registrations.map(item => item.task_id)])].sort(codePointOrder);
    for (const taskId of dependencies) store.execute('INSERT INTO comparison_report_dependencies(report_id,task_id) VALUES (?,?)', [config.reportId, taskId]);
    store.execute(
      'INSERT INTO comparison_report_sequences(protocol_id,last_sequence) VALUES (?,?) ON CONFLICT(protocol_id) DO UPDATE SET last_sequence=excluded.last_sequence',
      [protocol.id, last + 1]
    );
    return report;
  });
}

function createFlexibleSnapshot(store: Store, request: ComparisonSnapshotRequest, clock: Clock): FlexibleComparisonReport {
  const config = parseComparison(SnapshotRequestSchema, request, 'invalid_snapshot_request');
  const row = protocolRow(store, config.protocolId);
  if (row.status !== 'frozen') throw new Error('protocol_not_active');
  const current = store.get<SnapshotRow>('SELECT report_id,protocol_id,input_json,report_json,snapshot_hash FROM flexible_report_snapshots WHERE report_id=?', [
    config.reportId
  ]);
  if (store.get('SELECT report_id FROM comparison_report_snapshots WHERE report_id=?', [config.reportId])) throw new Error('report_conflict');
  if (current) {
    const prior = currentCompatibilityReport(store, current);
    if (
      prior.schema_version !== 2 ||
      prior.protocol_id !== config.protocolId ||
      prior.cutoff !== config.cutoff ||
      prior.revision_reason !== config.revisionReason ||
      prior.supersedes_report_id !== (config.supersedesReportId ?? null)
    )
      throw new Error('report_conflict');
    return prior;
  }
  const now = comparisonTimestamp(clock());
  if (Date.parse(config.cutoff) > Date.parse(now) || row.frozen_at === null || Date.parse(config.cutoff) < Date.parse(row.frozen_at))
    throw new Error('invalid_cutoff');
  if (config.revisionReason === 'initial') {
    if (config.supersedesReportId) throw new Error('invalid_revision');
  } else {
    if (!config.supersedesReportId) throw new Error('invalid_revision');
    const parent = readComparisonSnapshot(store, config.supersedesReportId);
    if (
      parent.validity_status !== 'valid' ||
      parent.schema_version !== 2 ||
      parent.protocol_id !== config.protocolId ||
      Date.parse(now) < Date.parse(parent.evaluated_at)
    )
      throw new Error('invalid_revision');
    if (config.revisionReason === 'cutoff_advanced' ? Date.parse(config.cutoff) <= Date.parse(parent.cutoff) : config.cutoff !== parent.cutoff)
      throw new Error('invalid_revision');
  }
  const sequence =
    (store.get<{ last_sequence: number }>('SELECT last_sequence FROM comparison_report_sequences WHERE protocol_id=?', [config.protocolId])?.last_sequence ??
      0) + 1;
  if (!Number.isSafeInteger(sequence)) throw new Error('revision_overflow');
  const input = captureFlexibleInput(
    store,
    config.protocolId,
    config.reportId,
    config.cutoff,
    now,
    sequence,
    config.revisionReason,
    config.supersedesReportId ?? null
  );
  const report = projectFlexibleComparison(input);
  store.execute(
    'INSERT INTO flexible_report_snapshots(report_id,protocol_id,cutoff,evaluated_at,data_revision,snapshot_sequence,schema_version,descriptive_version,revision_reason,supersedes_report_id,input_json,report_json,snapshot_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [
      report.report_id,
      report.protocol_id,
      report.cutoff,
      report.evaluated_at,
      report.data_revision,
      report.snapshot_sequence,
      2,
      report.descriptive_version,
      report.revision_reason,
      report.supersedes_report_id,
      canonicalJson(input),
      canonicalJson(report),
      report.snapshot_hash
    ]
  );
  for (const task of input.assignments)
    store.execute('INSERT INTO flexible_report_dependencies(report_id,task_id) VALUES (?,?)', [report.report_id, task.task_id]);
  store.execute(
    'INSERT INTO comparison_report_sequences(protocol_id,last_sequence) VALUES (?,?) ON CONFLICT(protocol_id) DO UPDATE SET last_sequence=excluded.last_sequence',
    [report.protocol_id, sequence]
  );
  return report;
}
