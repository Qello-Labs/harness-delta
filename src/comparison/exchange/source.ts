import { z } from 'zod';
import type { Store } from '../../store.js';
import { type Clock, utcNow } from '../../core/lifecycle.js';
import { IdSchema } from '../../contracts.js';
import { comparisonProtocol, protocolRow } from '../../core/protocol-store.js';
import { FlexibleSnapshotInputSchema } from '../reports/flexible-comparison.js';
import { ComparisonSnapshotInputSchema } from '../reports/comparison-contracts.js';
import { readComparisonSnapshot } from '../reports/comparison-snapshot.js';
import { canonicalJson } from '../../core/canonical-json.js';
import { codePointOrder } from '../reports/comparison-task.js';
import { exchangeSource } from './deletion.js';
import { SourceConfigSchema, parseExchange, parseExchangePackage, digest, uuid, time } from './contracts.js';
import type { ExchangePackage, SharedAssignment, Notice } from './contracts.js';

const ExportRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('assignment_metadata'), protocolId: IdSchema, snapshotId: IdSchema, packageId: uuid }),
  z.strictObject({ kind: z.literal('deletion_metadata'), namespaceId: uuid, packageId: uuid })
]);
export type ExportRequest = z.infer<typeof ExportRequestSchema>;
export function registerExchangeSource(store: Store, input: unknown): void {
  const config = parseExchange(SourceConfigSchema, input);
  config.owned_strata.sort(codePointOrder);
  store.immediateTransaction(() => {
    const old = exchangeSource(store);
    if (old && canonicalJson(old) === canonicalJson(config)) return;
    if (
      old ||
      store.get('SELECT id FROM tasks LIMIT 1') ||
      store.get('SELECT id FROM tombstones LIMIT 1') ||
      store.get('SELECT key_id FROM comparison_identity_tombstones LIMIT 1') ||
      store.get('SELECT report_id FROM comparison_report_snapshots LIMIT 1') ||
      store.get('SELECT report_id FROM flexible_report_snapshots LIMIT 1') ||
      store.get('SELECT report_id FROM comparison_report_tombstones LIMIT 1') ||
      store.get('SELECT id FROM sessions LIMIT 1') ||
      store.get('SELECT id FROM events LIMIT 1') ||
      store.all('SELECT id FROM projects').length !== 1
    )
      throw new Error('source_scope_not_empty');
    const row = protocolRow(store, config.protocol_id);
    const protocol = comparisonProtocol(store, row);
    if (protocol.purpose !== 'synthetic_validation') throw new Error('real_experiment_disabled');
    if (row.project_id !== config.local_project_id || config.owned_strata.some(id => !protocol.strata.some(s => s.id === id)))
      throw new Error('authority_conflict');
    store.execute("INSERT OR IGNORE INTO comparison_workspace_scope VALUES (1,'synthetic_validation')", []);
    store.execute('INSERT INTO exchange_sources(singleton,namespace_id,project_id,protocol_id,shared_project_id,config_json) VALUES (1,?,?,?,?,?)', [
      config.namespace_id,
      config.local_project_id,
      config.protocol_id,
      config.shared_project_id,
      canonicalJson(config)
    ]);
  });
}
interface Receipt {
  request_json: string | null;
  metadata_json: string | null;
  digest: string | null;
  invalidated: number;
  revision: number;
}
interface ExportMetadata {
  produced_at: string;
  identity_captured_at: string;
  tombstones?: Notice[];
}
type Identity = Omit<SharedAssignment, 'evidence'>;
export function buildExchangePackage(store: Store, input: ExportRequest, clock: Clock = utcNow): ExchangePackage {
  const request = parseExchange(ExportRequestSchema, input);
  return store.immediateTransaction(() => {
    const source = exchangeSource(store);
    if (!source) throw new Error('unknown_mapping');
    if (request.kind === 'assignment_metadata' ? request.protocolId !== source.protocol_id : request.namespaceId !== source.namespace_id)
      throw new Error('unknown_mapping');
    const prior = store.get<Receipt>('SELECT * FROM exchange_export_receipts WHERE package_id=?', [request.packageId]);
    if (prior?.invalidated) throw new Error('export_invalidated');
    if (prior && prior.request_json !== canonicalJson(request)) throw new Error('package_conflict');
    const now = prior ? undefined : parseExchange(time, clock());
    const metadata = prior ? (JSON.parse(prior.metadata_json!) as ExportMetadata) : { produced_at: now!, identity_captured_at: now! };
    const last = store.get<{ revision: number }>('SELECT revision FROM exchange_sources WHERE singleton=1')!.revision;
    const revision = prior?.revision ?? last + 1;
    if (!Number.isSafeInteger(revision)) throw new Error('revision_overflow');
    const notices = store.all<Notice>('SELECT kind,target_id,reason,invalidated_at FROM exchange_scope_notices ORDER BY kind');
    const tombstones = notices.some(n => n.kind === 'project') ? notices.filter(n => n.kind === 'project') : notices;
    const base = {
      schema_version: 1 as const,
      package_id: request.packageId,
      namespace_id: source.namespace_id,
      shared_project_id: source.shared_project_id,
      export_revision: revision,
      produced_at: metadata.produced_at,
      tombstones
    };
    let result: ExchangePackage;
    if (request.kind === 'deletion_metadata') {
      result = parseExchangePackage({ ...base, kind: request.kind, tombstones: metadata.tombstones ?? tombstones });
      metadata.tombstones = result.tombstones;
    } else {
      if (notices.length) throw new Error('export_invalidated');
      const report = readComparisonSnapshot(store, request.snapshotId);

      if (report.validity_status !== 'valid' || report.protocol_id !== source.protocol_id) throw new Error('export_invalidated');
      if (Date.parse(metadata.produced_at) < Date.parse(report.evaluated_at) || Date.parse(metadata.identity_captured_at) > Date.parse(metadata.produced_at))
        throw new Error('invalid_exchange_package');
      if (report.schema_version === 2) {
        const saved = store.get<{ input_json: string }>('SELECT input_json FROM flexible_report_snapshots WHERE report_id=?', [request.snapshotId]);
        if (!saved) throw new Error('invalid_snapshot');
        const snapshot = parseExchange(FlexibleSnapshotInputSchema, JSON.parse(saved.input_json) as unknown);
        const assignments = report.tasks.map(task => {
          const raw = snapshot.assignments.find(a => a.task_id === task.task_id)!;
          if (!source.owned_strata.includes(raw.stratum_id)) throw new Error('authority_conflict');
          let sealed = store.get<{ identity_json: string }>('SELECT identity_json FROM exchange_export_identities WHERE task_id=?', [task.task_id]);
          if (!sealed) {
            const allocation = store.get<{ allocation_index: number; allocator_id: string }>(
              'SELECT allocation_index,allocator_id FROM comparison_assignments WHERE task_id=?',
              [task.task_id]
            )!;
            const keys = store.all<{ key_id: string; kind: string }>('SELECT key_id,kind FROM comparison_identity_keys WHERE task_id=? ORDER BY key_id', [
              task.task_id
            ]);
            const logical = keys.find(k => k.kind === 'logical')?.key_id;
            if (!logical) throw new Error('invalid_exchange_package');
            const registered = store.get<{ registered_at: string }>('SELECT registered_at FROM tasks WHERE id=?', [task.task_id])!.registered_at;
            const identity = {
              task_id: task.task_id,
              logical_task_id: logical,
              alias_ids: keys.map(k => k.key_id).filter(k => k !== logical),
              assignment_id: raw.assignment_id,
              protocol_id: source.protocol_id,
              original_variant_id: raw.variant_id,
              stratum_id: raw.stratum_id,
              block_id: raw.block_id,
              ...allocation,
              assigned_at: raw.assigned_at,
              assignment_recorded_at: raw.recorded_at,
              followup_ends_at: raw.followup_ends_at,
              registered_at: registered,
              metadata: raw.metadata,
              environment_id: raw.environment_id
            };
            sealed = { identity_json: canonicalJson(identity) };
            store.execute('INSERT INTO exchange_export_identities VALUES (?,?,?,?)', [
              task.task_id,
              source.protocol_id,
              sealed.identity_json,
              metadata.identity_captured_at
            ]);
          }
          const end = Math.min(Date.parse(report.cutoff), Date.parse(raw.followup_ends_at));
          const within = (at: string | null) => (at !== null && Date.parse(at) >= Date.parse(raw.assigned_at) && Date.parse(at) < end ? at : null);
          const assessed = task.quality.outcome === null ? null : within(raw.outcome?.assessed_at ?? null);
          return {
            ...(JSON.parse(sealed.identity_json) as Record<string, unknown>),
            evidence: {
              started: raw.started_at !== null,
              first_completed_at: within(raw.first_completed_at),
              first_assessed_at: within(raw.first_assessed_at),
              first_success: task.quality.first_success,
              finalized_at: assessed,
              current_outcome: task.quality.outcome,
              outcome_assessed_at: assessed,
              criteria_met: task.quality.criteria_met,
              rework_count: task.time.rework_count,
              deviations: task.deviations,
              observations: [],
              time: { active_ms: task.time.active_ms, elapsed_ms: task.time.elapsed_ms, elapsed_is_labor: false },
              cost: task.cost,
              runtime_summary: task.runtime_summary,
              cost_provenance: {
                price_table_id: report.price_table.id,
                price_table_hash: report.price_table_hash,
                formula_version: report.formula_version,
                source_snapshot_hash: report.snapshot_hash
              }
            }
          };
        });
        const { project_id: omitted, ...settings } = snapshot.protocol;
        void omitted;
        result = parseExchangePackage({
          ...base,
          schema_version: 2,
          kind: request.kind,
          protocol_id: source.protocol_id,
          cutoff: report.cutoff,
          source_evaluated_at: report.evaluated_at,
          source_snapshot_sequence: report.snapshot_sequence,
          identity_captured_at: metadata.identity_captured_at,
          protocol: { settings: { ...settings, shared_project_id: source.shared_project_id }, frozen_at: protocolRow(store, source.protocol_id).frozen_at },
          variants: snapshot.variants,
          authority: snapshot.protocol.strata.filter(s => source.owned_strata.includes(s.id)).map(s => ({ stratum_id: s.id, allocator_id: s.allocator_id })),
          assignments,
          price_table: report.price_table,
          price_table_hash: report.price_table_hash,
          formula_version: report.formula_version
        });
      } else {
        const saved = store.get<{ input_json: string }>('SELECT input_json FROM comparison_report_snapshots WHERE report_id=?', [request.snapshotId])!;
        const snapshot = parseExchange(ComparisonSnapshotInputSchema, JSON.parse(saved.input_json) as unknown);
        if (
          store
            .all<{ stratum_id: string }>('SELECT stratum_id FROM comparison_assignments WHERE protocol_id=?', [source.protocol_id])
            .some(a => !source.owned_strata.includes(a.stratum_id))
        )
          throw new Error('authority_conflict');
        const assignments = report.tasks.map(task => {
          let sealed = store.get<{ identity_json: string }>('SELECT identity_json FROM exchange_export_identities WHERE task_id=?', [task.task_id]);
          if (!sealed) {
            const a = store.get<{ allocation_index: number; allocator_id: string; recorded_at: string }>(
              'SELECT allocation_index,allocator_id,recorded_at FROM comparison_assignments WHERE task_id=?',
              [task.task_id]
            )!;
            const keys = store.all<{ key_id: string; kind: string }>('SELECT key_id,kind FROM comparison_identity_keys WHERE task_id=? ORDER BY key_id', [
              task.task_id
            ]);
            const logical = keys
              .filter(k => k.kind === 'logical')
              .map(k => k.key_id)
              .sort(codePointOrder)[0];
            if (!logical) throw new Error('invalid_exchange_package');
            const registration = store.get<{ registered_at: string }>('SELECT registered_at FROM tasks WHERE id=?', [task.task_id])!;
            const identity: Identity = {
              task_id: task.task_id,
              logical_task_id: logical,
              alias_ids: keys
                .map(k => k.key_id)
                .filter(k => k !== logical)
                .sort(codePointOrder),
              assignment_id: task.assignment_id,
              protocol_id: source.protocol_id,
              original_variant_id: task.original_variant_id,
              stratum_id: task.stratum_id,
              block_id: task.block_id,
              allocation_index: a.allocation_index,
              allocator_id: a.allocator_id,
              assigned_at: task.assigned_at,
              assignment_recorded_at: a.recorded_at,
              followup_ends_at: task.followup_ends_at,
              registered_at: registration.registered_at,
              metadata: task.metadata,
              environment_id: task.environment_id
            };
            sealed = { identity_json: canonicalJson(identity) };
            store.execute('INSERT INTO exchange_export_identities VALUES (?,?,?,?)', [
              task.task_id,
              source.protocol_id,
              sealed.identity_json,
              metadata.identity_captured_at
            ]);
          }
          const raw = snapshot.assignments.find(a => a.task_id === task.task_id)!;
          return {
            ...(JSON.parse(sealed.identity_json) as Identity),
            evidence: {
              started: task.started,
              first_completed_at: task.first_completed_at,
              first_assessed_at: task.first_assessed_at,
              first_success: task.first_success,
              finalized_at: task.finalized_at,
              current_outcome: task.current_outcome,
              outcome_assessed_at: task.current_outcome === null ? null : raw.outcome!.assessed_at,
              criteria_met: [...task.criteria_met].sort(codePointOrder),
              rework_count: task.rework_count,
              usage: task.usage,
              actual_configuration: task.actual_configuration,
              deviations: task.deviations.map(d => ({ occurred_at: d.occurred_at, recorded_at: d.recorded_at, reason_code: d.reason_code })),
              observations: task.observations,
              time: task.time
            }
          };
        });
        const { project_id: omitted, ...settings } = report.settings;
        void omitted;
        result = parseExchangePackage({
          ...base,
          kind: request.kind,
          protocol_id: source.protocol_id,
          cutoff: report.cutoff,
          source_evaluated_at: report.evaluated_at,
          source_snapshot_sequence: report.snapshot_sequence,
          identity_captured_at: metadata.identity_captured_at,
          protocol: { settings: { ...settings, shared_project_id: source.shared_project_id }, frozen_at: protocolRow(store, source.protocol_id).frozen_at },
          variants: report.variants,
          authority: report.settings.strata
            .filter(s => source.owned_strata.includes(s.id))
            .map(s => ({ stratum_id: s.id, allocator_id: s.allocator_id }))
            .sort((a, b) => codePointOrder(a.stratum_id, b.stratum_id)),
          assignments
        });
      }
    }
    if (prior) {
      if (digest(result) !== prior.digest) throw new Error('package_conflict');
      return result;
    }
    store.execute('UPDATE exchange_sources SET revision=? WHERE singleton=1', [revision]);
    store.execute('INSERT INTO exchange_export_receipts(package_id,namespace_id,revision,request_json,metadata_json,digest) VALUES (?,?,?,?,?,?)', [
      request.packageId,
      source.namespace_id,
      revision,
      canonicalJson(request),
      canonicalJson(metadata),
      digest(result)
    ]);
    return result;
  });
}
