import { z } from 'zod';
import {
  emptyOrdinaryWindowCoverage,
  OrdinaryWindowConnectionProofSchema,
  OrdinaryWindowCoverageSchema,
  resolveOrdinaryWindow
} from './ordinary-window-policy.js';
import { ordinaryWindowSelection, ordinaryWindowSelectionHash, ordinaryWindowStatus } from './ordinary-window-store.js';
import type { Store } from '../store.js';
import { IdSchema } from '../contracts.js';

/** Persisted evidence is descriptive, including after pause, revocation or finalization. */
export function readOrdinaryWindowStatus(store: Store, taskId: string) {
  return store.transaction(() => {
    const task = store.get<{ project_id: string; state: 'registered' | 'active' | 'paused' | 'finalized'; metadata: string }>(
      'SELECT project_id,state,metadata FROM tasks WHERE id=?',
      [IdSchema.parse(taskId)]
    );
    if (!task) throw new Error('unknown_task');
    if (store.get("SELECT 1 FROM tombstones WHERE (kind='task' AND id=?) OR (kind='project' AND id=?)", [taskId, task.project_id]))
      throw new Error('deleted_identifier');
    if (!store.get('SELECT 1 FROM projects WHERE id=?', [task.project_id])) throw new Error('unknown_project');
    const selection = ordinaryWindowSelection(store, taskId);
    const prepared = store.get<{ settings: string; settings_hash: string; price_table_id: string; selected_root_id: string | null; revoked_at: string | null }>(
      'SELECT settings,settings_hash,price_table_id,selected_root_id,revoked_at FROM ordinary_tasks WHERE task_id=?',
      [taskId]
    );
    if (!selection || !prepared) {
      throw new Error('ordinary_preparation_required');
    }
    const metadata = z.object({ product: z.string() }).parse(JSON.parse(task.metadata));
    if (
      task.project_id !== selection.projectId ||
      metadata.product !== selection.policy.product ||
      prepared.settings !== JSON.stringify(selection) ||
      prepared.settings_hash !== ordinaryWindowSelectionHash(selection) ||
      prepared.price_table_id !== selection.priceTableId
    ) {
      throw new Error('ordinary_configuration_changed');
    }
    if (store.get('SELECT 1 FROM comparison_assignments WHERE task_id=?', [taskId])) throw new Error('binding_ordinary_assignment_conflict');
    const resolved = resolveOrdinaryWindow(selection.policy.product, selection.declaredVersion, selection.policy.policyId);
    if (!resolved) throw new Error('binding_version_out_of_window');
    const compatibility = store.get('SELECT 1 FROM source_compatibility_blocks WHERE product=? AND product_version=? AND source=?', [
      resolved.compatibility.product,
      resolved.compatibility.product_version,
      resolved.compatibility.source
    ])
      ? { ...resolved.compatibility, state: 'invalidated' as const }
      : resolved.compatibility;
    const segments = store
      .all<{
        root_session_id: string;
        state: string;
        opened_at: string;
        closed_at: string | null;
        proof: string | null;
        coverage: string | null;
        selection_hash: string | null;
      }>(
        `SELECT s.root_session_id,s.state,s.opened_at,s.closed_at,w.proof,w.coverage,w.selection_hash
       FROM binding_root_segments s LEFT JOIN ordinary_window_segments w ON w.root_session_id=s.root_session_id
       WHERE s.task_id=? ORDER BY s.opened_at,s.root_session_id`,
        [taskId]
      )
      .map(row => {
        const proof = row.proof === null ? null : OrdinaryWindowConnectionProofSchema.parse(JSON.parse(row.proof));
        if (
          proof &&
          (row.selection_hash !== ordinaryWindowSelectionHash(selection) ||
            proof.product !== selection.policy.product ||
            proof.productVersion !== selection.declaredVersion)
        ) {
          throw new Error('binding_identity_mismatch');
        }
        const coverage = row.coverage === null ? emptyOrdinaryWindowCoverage() : OrdinaryWindowCoverageSchema.parse(JSON.parse(row.coverage));
        return {
          root_session_id: row.root_session_id,
          state: z.enum(['acquiring', 'observing', 'paused', 'stopping', 'closed']).parse(row.state),
          opened_at: row.opened_at,
          closed_at: row.closed_at,
          actual_source_version: proof?.productVersion ?? null,
          source_version_basis: proof?.sourceVersionBasis ?? 'unavailable',
          publisher_proof: proof?.publisherProof ?? 'unavailable',
          mapped_image_proof: proof?.mappedImageProof ?? 'unavailable',
          writer_version: 'unverified',
          coverage: compatibility.state === 'invalidated' ? { ...coverage, status: 'invalidated' as const, reason: 'compatibility_invalidated' } : coverage
        };
      });
    const invalidatedSegment = segments.find(segment => segment.coverage.status === 'invalidated');
    return {
      schema_version: 2,
      report_version: 'ordinary-window-status-v1',
      mode: 'ordinary_window',
      task_id: taskId,
      project_id: task.project_id,
      task_state: task.state,
      selection: {
        declared_version: selection.declaredVersion,
        policy: selection.policy,
        policy_digest: selection.policyDigest,
        prepared_at: selection.preparedAt,
        price_table_id: selection.priceTableId,
        compatibility
      },
      collection: {
        state: 'disabled',
        reason: task.state === 'finalized' || prepared.revoked_at !== null ? 'binding_scope_revoked' : ordinaryWindowStatus(store, taskId).reason
      },
      selected_root_id: prepared.selected_root_id,
      automatic_children: false,
      inference: false,
      inference_refusal: 'ordinary_window_descriptive_only',
      exchange: { supported: false, reason: 'native_window_exchange_unsupported' },
      coverage_as_of: 'current_store',
      coverage: {
        scope: 'root_only',
        rootOwnership: 'unverified',
        possibleChildContribution: 'unknown',
        childrenStatus: 'unobserved',
        detectionCompleteness: 'unknown',
        status:
          compatibility.state === 'invalidated' || invalidatedSegment
            ? 'invalidated'
            : segments.some(segment => segment.coverage.status === 'partial')
              ? 'partial'
              : 'missing',
        reason: compatibility.state === 'invalidated' ? 'compatibility_invalidated' : (invalidatedSegment?.coverage.reason ?? null),
        segments
      },
      limitations: [
        'implemented_for_offline_acceptance',
        'collection_disabled_pending_product_activation_and_native_acceptance',
        'root_source_is_not_root_own_usage',
        'root_ownership_unverified',
        'possible_child_contribution_unknown',
        'child_usage_and_cost_unobserved',
        'writer_version_and_continuity_unverified',
        ...(selection.policy.evidenceMode === 'source_only'
          ? ['executable_publisher_and_process_proof_unavailable', 'version_is_root_creation_header_not_writer']
          : ['disk_identity_does_not_prove_mapped_image'])
      ]
    };
  });
}

/** Includes orphaned preparations so callers cannot fall through to exact/native paths. */
export function hasOrdinaryWindowEvidence(store: Store, taskId: string): boolean {
  return !!store.get(
    `SELECT 1 FROM ordinary_window_selections WHERE task_id=?
    UNION ALL SELECT 1 FROM ordinary_tasks WHERE task_id=? AND json_extract(settings,'$.mode')='ordinary_window'
    UNION ALL SELECT 1 FROM ordinary_window_forget_fences WHERE task_id=? LIMIT 1`,
    [IdSchema.parse(taskId), taskId, taskId]
  );
}
