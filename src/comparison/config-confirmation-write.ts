import { randomUUID } from 'node:crypto';
import { comparisonTimestamp, ConfirmationInputSchema, ConfigurationRecordSchema, parseComparison } from '../comparison-contracts.js';
import { parseProtocol } from '../flexible-contracts.js';
import { comparisonVariant, protocolRow } from '../core/protocol-store.js';
import { Lifecycle } from '../core/lifecycle.js';
import {
  assignedTask,
  bindConfigurationToSession,
  policyStops,
  selectedArtifactSnapshot,
  type ConfirmationRow,
  type SelectedArtifact
} from '../core/configuration-evidence.js';
import type { Store } from '../store.js';
import type { AssignmentRow } from '../core/assignment-contract.js';
import type { z } from 'zod';

export function confirmConfiguration(store: Store, input: unknown, timestamp: string, artifacts?: readonly SelectedArtifact[]): void {
  const config = parseComparison(ConfirmationInputSchema, input);
  const now = comparisonTimestamp(timestamp);
  const occurredAt = comparisonTimestamp(config.occurred_at ?? now);
  if (config.evidence_method === 'self_attested' && artifacts !== undefined) throw new Error('unexpected_selected_artifacts');
  // Mechanical file checks describe current files, not reconstructed historical configurations.
  if (config.evidence_method === 'selected_artifact_hash' && Date.parse(occurredAt) !== Date.parse(now)) throw new Error('invalid_confirmation_time');
  const hash = config.evidence_method === 'selected_artifact_hash' ? selectedArtifactSnapshot(artifacts).hash : null;
  store.immediateTransaction(() => {
    const assignment = assignedTask(store, config.task_id);
    if (Date.parse(occurredAt) < Date.parse(assignment.assigned_at) || Date.parse(occurredAt) > Date.parse(now)) throw new Error('invalid_confirmation_time');
    const { assigned, preregistration, codes } = configurationDeviations(store, assignment, config);
    if (
      (hash !== null && hash !== assigned.instruction_manifest_hash) ||
      (config.environment_id !== null && config.environment_id !== preregistration.environment_id)
    )
      codes.push('mismatch');
    const status = codes.some(code => code !== 'unknown') ? 'mismatch' : codes.length ? 'unknown' : 'confirmed';
    const record = parseComparison(ConfigurationRecordSchema, {
      ...config,
      occurred_at: occurredAt,
      verification_status: status,
      observed_config_hash: hash,
      verification_scope: hash === null ? 'declared_settings' : 'selected_artifacts_and_declared_settings',
      deviation_codes: codes
    });
    const payload = JSON.stringify(record);
    const existing = store.get<ConfirmationRow>('SELECT * FROM comparison_confirmations WHERE id = ?', [config.id]);
    if (existing) {
      if (existing.task_id !== config.task_id || existing.payload !== payload) throw new Error('confirmation_conflict');
      return;
    }
    const task = new Lifecycle(store).task(config.task_id);
    if (task.state === 'finalized') throw new Error('invalid_transition');
    if (task.last_transition_at && Date.parse(now) < Date.parse(task.last_transition_at)) throw new Error('clock_regression');
    const previous = store.get<ConfirmationRow>('SELECT * FROM comparison_confirmations WHERE task_id = ? ORDER BY rowid DESC LIMIT 1', [config.task_id]);
    if (previous && (Date.parse(now) < Date.parse(previous.recorded_at) || Date.parse(occurredAt) < Date.parse(previous.occurred_at)))
      throw new Error('clock_regression');
    store.execute('INSERT INTO comparison_confirmations(id,task_id,occurred_at,recorded_at,payload) VALUES (?,?,?,?,?)', [
      config.id,
      config.task_id,
      occurredAt,
      now,
      payload
    ]);
    if (config.session_id) bindConfigurationToSession(store, config.id, config.session_id);
    for (const code of codes)
      store.execute('INSERT INTO comparison_deviations(id,task_id,occurred_at,recorded_at,reason_code) VALUES (?,?,?,?,?)', [
        randomUUID(),
        config.task_id,
        occurredAt,
        now,
        code
      ]);
    if (task.state === 'active' && policyStops(store, assignment, record)) new Lifecycle(store, () => now).pause(config.task_id);
  });
}

function configurationDeviations(store: Store, assignment: AssignmentRow, config: z.infer<typeof ConfirmationInputSchema>) {
  const assigned = comparisonVariant(store, assignment.variant_id);
  if (config.actual_variant_id !== null) comparisonVariant(store, config.actual_variant_id);
  const preregistration = store.get<{ environment_id: string }>('SELECT environment_id FROM comparison_preregistrations WHERE task_id = ?', [config.task_id]);
  if (!preregistration) throw new Error('preregistration_conflict');
  const protocol = parseProtocol(JSON.parse(protocolRow(store, assignment.protocol_id).settings) as unknown);
  const codes: z.infer<typeof ConfigurationRecordSchema>['deviation_codes'] = [];
  if (config.actual_variant_id === null || config.environment_id === null) codes.push('unknown');
  if (config.actual_variant_id !== null && config.actual_variant_id !== assignment.variant_id) codes.push('crossover');
  if (assigned.schema_version === 1) {
    if ([config.product, config.product_version, config.model, config.reasoning_setting].includes(null) && !codes.includes('unknown')) codes.push('unknown');
    if (
      (config.product !== null && config.product !== assigned.product) ||
      (config.product_version !== null && config.product_version !== assigned.product_version) ||
      (config.model !== null && config.model !== assigned.model) ||
      (config.reasoning_setting !== null && config.reasoning_setting !== assigned.reasoning_setting)
    )
      codes.push('version_drift');
  } else if (protocol.schema_version === 2) {
    if (config.product === null || config.product_version === null) {
      if (!codes.includes('unknown')) codes.push('unknown');
    } else if (!protocol.source_profiles.some(p => p.product === config.product && p.product_version === config.product_version)) codes.push('version_drift');
  }
  return { assigned, preregistration, codes };
}
