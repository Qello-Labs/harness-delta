import { z } from 'zod';
import {
  emptyOrdinaryWindowCoverage,
  OrdinaryWindowConnectionProofSchema,
  OrdinaryWindowCoverageSchema,
  resolveOrdinaryWindow
} from '../../core/ordinary-window-policy.js';
import { ordinaryWindowSelection, ordinaryWindowSelectionHash, ordinaryWindowStatus } from '../../core/ordinary-window-store.js';
import { parseTaskMetadata } from '../../flexible-contracts.js';
import { Lifecycle } from '../../lifecycle.js';
import { ordinaryTask } from '../../ordinary-observation.js';
import { effectiveSourceCompatibility } from '../../source-compatibility.js';
import type { Store } from '../../store.js';

/** Persisted evidence is descriptive, including after pause, revocation or finalization. */
export function readOrdinaryWindowStatus(store: Store, taskId: string) {
  return store.transaction(() => {
    const task = new Lifecycle(store).task(taskId);
    const selection = ordinaryWindowSelection(store, taskId);
    const prepared = ordinaryTask(store, taskId);
    if (!selection || !prepared) {
      throw new Error('ordinary_preparation_required');
    }
    const metadata = parseTaskMetadata(JSON.parse(task.metadata) as unknown);
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
    const compatibility = effectiveSourceCompatibility(store, resolved.compatibility);
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
