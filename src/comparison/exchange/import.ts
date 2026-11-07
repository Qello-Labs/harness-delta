import { registerPriceTable } from '../../pricing/pricing.js';
import type { Store } from '../../store.js';
import { type Clock, utcNow } from '../../core/lifecycle.js';
import { canonicalJson } from '../../core/canonical-json.js';
import { parseExchangePackage, parseExchange, time, digest } from './contracts.js';
import { readMapping, registeredDestination } from './mapping.js';
import { validateDataAuthority, validateDataPackage, existingConflict } from './identity.js';
import { invalidateExchangeProtocol, retireImportedProject, assertNotRetired, bumpMergedRevision } from './invalidation.js';
export interface ImportReceipt {
  status: 'imported' | 'replayed' | 'deletions_applied' | 'deletions_applied_data_rejected' | 'conflict_recorded';
  reason?: string;
}
interface ImportRevision {
  revision: number;
  cutoff: string;
  evaluated_at: string;
  snapshot_sequence: number;
}
export function importExchangePackage(store: Store, input: unknown, localProjectId: string, clock: Clock = utcNow): ImportReceipt {
  const pkg = parseExchangePackage(input);
  const now = parseExchange(time, clock());
  return store.immediateTransaction(() => {
    const writer = store.get<{ protocol_id: string }>('SELECT protocol_id FROM exchange_writers WHERE namespace_id=? AND shared_project_id=?', [
      pkg.namespace_id,
      pkg.shared_project_id
    ]);
    if (!writer) throw new Error('authority_conflict');
    const mapping = readMapping(store, pkg.shared_project_id, writer.protocol_id, localProjectId);
    if (Date.parse(pkg.produced_at) > Date.parse(now)) throw new Error('invalid_exchange_package');
    for (const n of pkg.tombstones) {
      if (
        (n.kind === 'project' ? n.target_id !== pkg.shared_project_id : n.target_id !== writer.protocol_id) ||
        Date.parse(n.invalidated_at) > Date.parse(pkg.produced_at)
      )
        throw new Error('authority_conflict');
    }
    if (pkg.kind === 'assignment_metadata') validateDataAuthority(pkg, mapping, now);
    let changed = false;
    for (const n of pkg.tombstones)
      changed =
        (n.kind === 'project'
          ? retireImportedProject(store, pkg.shared_project_id, n.invalidated_at)
          : invalidateExchangeProtocol(store, pkg.shared_project_id, n.target_id, n.reason, n.invalidated_at)) || changed;
    if (pkg.kind === 'assignment_metadata') {
      try {
        registeredDestination(store, localProjectId);
        assertNotRetired(store, pkg.shared_project_id, pkg.protocol_id);
      } catch (e) {
        if (changed) return { status: 'deletions_applied_data_rejected', reason: 'deleted_identifier' };
        throw e;
      }
      validateDataPackage(pkg, mapping, now);
    }
    const hash = digest(pkg);
    const prior = store.get<{ package_id: string; digest: string | null }>(
      'SELECT package_id,digest FROM exchange_import_receipts WHERE package_id=? OR (namespace_id=? AND revision=?)',
      [pkg.package_id, pkg.namespace_id, pkg.export_revision]
    );
    if (prior) {
      if (prior.package_id !== pkg.package_id || prior.digest !== hash) {
        if (changed)
          return { status: pkg.kind === 'assignment_metadata' ? 'deletions_applied_data_rejected' : 'deletions_applied', reason: 'package_conflict' };
        throw new Error('package_conflict');
      }
      return { status: changed ? 'deletions_applied' : 'replayed' };
    }
    if (pkg.kind === 'assignment_metadata') {
      const old = store.get<ImportRevision>('SELECT revision,cutoff,evaluated_at,snapshot_sequence FROM exchange_import_revisions WHERE namespace_id=?', [
        pkg.namespace_id
      ]);
      const highest =
        store.get<{ value: number | null }>('SELECT MAX(revision) AS value FROM exchange_import_receipts WHERE namespace_id=?', [pkg.namespace_id])?.value ?? 0;
      if (
        pkg.export_revision <= highest ||
        (old &&
          (Date.parse(pkg.cutoff) < Date.parse(old.cutoff) ||
            Date.parse(pkg.source_evaluated_at) < Date.parse(old.evaluated_at) ||
            pkg.source_snapshot_sequence < old.snapshot_sequence))
      )
        throw new Error('stale_revision');
      if (pkg.schema_version === 2) {
        const price = store.get<{ payload: string }>('SELECT payload FROM price_tables WHERE id=?', [pkg.price_table.id]);
        if (price && canonicalJson(JSON.parse(price.payload) as unknown) !== canonicalJson(pkg.price_table)) {
          invalidateExchangeProtocol(store, pkg.shared_project_id, pkg.protocol_id, 'identity_conflict', now);
          return { status: 'conflict_recorded', reason: 'price_table_conflict' };
        }
        registerPriceTable(store, pkg.price_table);
      }
      const conflict = existingConflict(store, pkg);
      if (conflict) {
        for (const id of conflict.protocols) invalidateExchangeProtocol(store, pkg.shared_project_id, id, 'identity_conflict', now);
        return { status: 'conflict_recorded', reason: conflict.reason };
      }
      if (old && pkg.source_snapshot_sequence === old.snapshot_sequence) {
        const current = store
          .all<{ assignment_json: string }>('SELECT assignment_json FROM exchange_tasks WHERE namespace_id=? ORDER BY task_id', [pkg.namespace_id])
          .map(r => JSON.parse(r.assignment_json) as unknown);
        const incoming = [...pkg.assignments].sort((a, b) => (a.task_id < b.task_id ? -1 : a.task_id > b.task_id ? 1 : 0));
        if (pkg.cutoff !== old.cutoff || pkg.source_evaluated_at !== old.evaluated_at || canonicalJson(current) !== canonicalJson(incoming))
          throw new Error('evidence_conflict');
      }
      // Replace a source's full current contribution; replay never adds cumulative totals.
      store.execute('DELETE FROM exchange_tasks WHERE namespace_id=?', [pkg.namespace_id]);
      for (const a of pkg.assignments) {
        store.execute('INSERT INTO exchange_tasks VALUES (?,?,?,?,?,?,?,?,?)', [
          pkg.shared_project_id,
          pkg.protocol_id,
          pkg.namespace_id,
          a.task_id,
          a.assignment_id,
          a.stratum_id,
          a.allocation_index,
          canonicalJson(a),
          a.evidence.finalized_at
        ]);
        for (const key of new Set([a.task_id, a.logical_task_id, ...a.alias_ids]))
          store.execute('INSERT INTO exchange_identity_keys VALUES (?,?,?,?,?)', [pkg.shared_project_id, key, a.task_id, pkg.protocol_id, pkg.namespace_id]);
      }
      const { assignments, ...header } = pkg;
      void assignments;
      store.execute(
        'INSERT INTO exchange_import_revisions VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(namespace_id) DO UPDATE SET revision=excluded.revision,cutoff=excluded.cutoff,evaluated_at=excluded.evaluated_at,snapshot_sequence=excluded.snapshot_sequence,received_at=excluded.received_at,header_json=excluded.header_json',
        [
          pkg.namespace_id,
          pkg.shared_project_id,
          pkg.protocol_id,
          pkg.export_revision,
          pkg.cutoff,
          pkg.source_evaluated_at,
          pkg.source_snapshot_sequence,
          now,
          canonicalJson(header)
        ]
      );
      bumpMergedRevision(store, pkg.shared_project_id);
    }
    store.execute('INSERT INTO exchange_import_receipts VALUES (?,?,?,?,?,?,?)', [
      pkg.package_id,
      pkg.namespace_id,
      pkg.shared_project_id,
      writer.protocol_id,
      pkg.export_revision,
      hash,
      pkg.kind
    ]);
    return { status: pkg.kind === 'assignment_metadata' ? 'imported' : changed ? 'deletions_applied' : 'replayed' };
  });
}
