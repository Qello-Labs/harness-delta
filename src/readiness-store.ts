import { z } from 'zod';
import { parseComparison, ProtocolDraftSchema } from './comparison-contracts.js';
import { resolveSourceCompatibility, assertCompatibilityAllowed } from './source-compatibility.js';
import type { FlexibleProtocol } from './flexible-contracts.js';
import type { Store } from './store.js';
import { protocolRow } from './core/protocol-store.js';
import { parseProtocol, FlexibleProtocolDraftSchema, type CostCoverageEvidence } from './flexible-contracts.js';
import { codexWorkflowCostFacts } from './codex-workflow-journal.js';
import { evaluateCostCoverage } from './cost-coverage.js';
import { evaluateReadiness, productionSourceEvidence, syntheticSourceEvidence } from './readiness.js';
import { getCodexBindingAdmission, isAdmittedCodexBindingProtocol } from './codex-binding-admission.js';
export function comparisonReadiness(store: Store, protocolId: string, at = new Date().toISOString()) {
  const row = protocolRow(store, protocolId);
  const protocol = parseProtocol(JSON.parse(row.settings) as unknown);
  if (protocol.schema_version !== 2) throw new Error('unsupported_readiness_mode');
  const tasks = store.all<{ task_id: string; assigned_at: string; followup_ends_at: string; started_at: string | null }>(
    'SELECT a.task_id,a.assigned_at,a.followup_ends_at,t.started_at FROM comparison_assignments a JOIN tasks t ON t.id=a.task_id WHERE a.protocol_id=? ORDER BY a.task_id',
    [protocolId]
  );
  const registry = protocol.purpose === 'synthetic_validation' ? syntheticSourceEvidence : productionSourceEvidence;
  const ids = registry
    .filter(e => protocol.source_profiles.some(p => p.product === e.product && p.product_version === e.product_version && p.profile_id === e.profile_id))
    .map(e => e.id);
  const blocked = protocol.source_profiles.some(profile => {
    const source =
      profile.product === 'codex'
        ? profile.profile_id === getCodexBindingAdmission(profile.product_version)?.profileId
          ? 'codex_binding'
          : 'codex_workflow'
        : profile.product === 'claude_code'
          ? 'claude_workflow'
          : null;
    const compatibility = source && resolveSourceCompatibility(profile.product, profile.product_version, source, profile.profile_id);
    if (!compatibility) return false;
    try {
      assertCompatibilityAllowed(store, compatibility);
      return false;
    } catch {
      return true;
    }
  });
  const coverage = tasks.map(t => {
    const evidence: CostCoverageEvidence = {
      profile_id: 'unsupported-production-cost',
      task_id: t.task_id,
      window_start: t.assigned_at,
      window_end: t.followup_ends_at,
      ...codexWorkflowCostFacts(store, t.task_id)
    };
    return { evidence, decision: evaluateCostCoverage(evidence) };
  });
  return evaluateReadiness({
    protocol,
    source_evidence_ids: ids,
    coverage,
    analysis_evidence_id: null,
    invalidated: row.status !== 'frozen' || blocked,
    followup_complete: tasks.length > 0 && tasks.every(t => Date.parse(t.followup_ends_at) <= Date.parse(at))
  });
}

/** Functional pilots can observe conditional sources without gaining experiment admission. */
export function functionalWorkflowEligible(store: Store, protocol: FlexibleProtocol): boolean {
  if (isAdmittedCodexBindingProtocol(protocol)) return false;
  if (protocol.purpose !== 'functional_pilot' || protocolRow(store, protocol.id).status !== 'frozen' || protocol.source_profiles.length === 0) return false;
  return protocol.source_profiles.every(profile => {
    const source = profile.product === 'codex' ? 'codex_workflow' : profile.product === 'claude_code' ? 'claude_workflow' : null;
    const compatibility = source && resolveSourceCompatibility(profile.product, profile.product_version, source, profile.profile_id);
    if (!compatibility) return false;
    try {
      assertCompatibilityAllowed(store, compatibility);
      return true;
    } catch {
      return false;
    }
  });
}

export function showProtocol(store: Store, id: string) {
  const row = protocolRow(store, id);
  const configuration = parseComparison(z.union([ProtocolDraftSchema, FlexibleProtocolDraftSchema]), JSON.parse(row.settings) as unknown);
  const realAllocation =
    configuration.schema_version === 2 &&
    configuration.purpose !== 'synthetic_validation' &&
    row.status === 'frozen' &&
    comparisonReadiness(store, id).real_allocation;
  return {
    schema_version: configuration.schema_version,
    configuration,
    status: row.status,
    frozen_at: row.frozen_at,
    data_revision: row.data_revision,
    invalidated_reason: row.invalidated_reason,
    real_allocation_enabled: realAllocation,
    experiment_readiness: realAllocation
      ? 'source_qualified_partial'
      : configuration.schema_version === 1 || configuration.purpose === 'synthetic_validation'
        ? 'synthetic_only'
        : 'source_unqualified'
  };
}
