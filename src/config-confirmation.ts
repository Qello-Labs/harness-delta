import { parseProtocol, RuntimeEvidenceSchema, type RuntimeEvidence } from './flexible-contracts.js';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { comparisonTimestamp, ConfirmationInputSchema, ConfigurationRecordSchema, parseComparison } from './comparison-contracts.js';
import { protocolRow, comparisonVariant } from './comparison.js';
import { IdSchema } from './contracts.js';
import { Lifecycle } from './lifecycle.js';
import type { AssignmentRow } from './allocation.js';
import type { Store } from './store.js';
import type { z } from 'zod';

export interface SelectedArtifact {
  artifactId: string;
  path: string;
}
export type ConfigurationRecord = z.infer<typeof ConfigurationRecordSchema> & { recorded_at: string; session_ids: string[] };
interface ConfirmationRow {
  id: string;
  task_id: string;
  occurred_at: string;
  recorded_at: string;
  payload: string;
}

function assignedTask(store: Store, taskId: string): AssignmentRow {
  const row = store.get<AssignmentRow>('SELECT * FROM comparison_assignments WHERE task_id = ?', [parseComparison(IdSchema, taskId)]);
  if (!row) throw new Error('task_not_assigned');
  return row;
}
/** Exact transient bytes for per-invocation application, never stored by the report. */
export function selectedArtifactSnapshot(artifacts: readonly SelectedArtifact[] | undefined) {
  if (!artifacts || artifacts.length === 0 || artifacts.length > 256) throw new Error('selected_artifacts_required');
  try {
    const ids = new Set<string>();
    let totalBytes = 0;
    const instructions: { artifact_id: string; content: string }[] = [];
    const manifest = artifacts
      .map(artifact => {
        const id = parseComparison(IdSchema, artifact.artifactId);
        if (ids.has(id)) throw new Error('duplicate_artifact');
        ids.add(id);
        const fd = openSync(artifact.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const before = fstatSync(fd);
          totalBytes += before.size;
          if (!before.isFile() || before.size > 1048576 || totalBytes > 16 * 1048576) throw new Error('invalid_artifact');
          const bytes = Buffer.alloc(before.size);
          let offset = 0;
          while (offset < bytes.length) {
            const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
            if (!count) throw new Error('invalid_artifact');
            offset += count;
          }
          const after = fstatSync(fd);
          if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('invalid_artifact');
          const content = bytes.toString('utf8');
          if (!Buffer.from(content, 'utf8').equals(bytes) || content.includes('\0')) throw new Error('invalid_artifact');
          instructions.push({ artifact_id: id, content });
          return { artifact_id: id, sha256: createHash('sha256').update(bytes).digest('hex') };
        } finally {
          closeSync(fd);
        }
      })
      .sort((a, b) => (a.artifact_id < b.artifact_id ? -1 : a.artifact_id > b.artifact_id ? 1 : 0));
    return {
      hash: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
      instructions: instructions.sort((a, b) => (a.artifact_id < b.artifact_id ? -1 : a.artifact_id > b.artifact_id ? 1 : 0))
    };
  } catch {
    throw new Error('selected_artifact_error');
  }
}

function policyStops(store: Store, assignment: AssignmentRow, record: z.infer<typeof ConfigurationRecordSchema>): boolean {
  const row = protocolRow(store, assignment.protocol_id);
  const config = parseProtocol(JSON.parse(row.settings) as unknown);
  if (record.deviation_codes.includes('version_drift')) return true;
  return (
    (record.deviation_codes.includes('unknown') && config.deviation_policy.unknown === 'stop') ||
    (record.deviation_codes.some(code => code === 'mismatch' || code === 'crossover') && config.deviation_policy.mismatch === 'stop')
  );
}

export function requireConfigurationConfirmation(store: Store, taskId: string, timestamp: string): void {
  const assignment = store.get<AssignmentRow>('SELECT * FROM comparison_assignments WHERE task_id = ?', [taskId]);
  if (!assignment) return;
  const row = store.get<ConfirmationRow>('SELECT * FROM comparison_confirmations WHERE task_id = ? ORDER BY rowid DESC LIMIT 1', [taskId]);
  if (!row) throw new Error('configuration_confirmation_required');
  if (Date.parse(timestamp) < Date.parse(row.recorded_at)) throw new Error('clock_regression');
  const record = parseComparison(ConfigurationRecordSchema, JSON.parse(row.payload) as unknown);
  if (policyStops(store, assignment, record)) throw new Error('configuration_policy_stop');
}

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
    const assigned = comparisonVariant(store, assignment.variant_id);
    if (config.actual_variant_id !== null) comparisonVariant(store, config.actual_variant_id);
    const preregistration = store.get<{ environment_id: string }>('SELECT environment_id FROM comparison_preregistrations WHERE task_id = ?', [config.task_id]);
    if (!preregistration) throw new Error('preregistration_conflict');
    const codes: z.infer<typeof ConfigurationRecordSchema>['deviation_codes'] = [];
    const protocol = parseProtocol(JSON.parse(protocolRow(store, assignment.protocol_id).settings) as unknown);
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

export function bindConfigurationToSession(store: Store, confirmationId: string, sessionId: string): void {
  parseComparison(IdSchema, confirmationId);
  parseComparison(IdSchema, sessionId);
  store.transaction(() => {
    const confirmation = store.get<ConfirmationRow>('SELECT * FROM comparison_confirmations WHERE id = ?', [confirmationId]);
    const session = store.get<{ task_id: string; project_id: string }>('SELECT task_id,project_id FROM sessions WHERE id = ?', [sessionId]);
    if (!confirmation || !session || confirmation.task_id !== session.task_id) throw new Error('scope_mismatch');
    store.execute('INSERT OR IGNORE INTO comparison_confirmation_sessions(confirmation_id,session_id,task_id,project_id) VALUES (?,?,?,?)', [
      confirmationId,
      sessionId,
      session.task_id,
      session.project_id
    ]);
  });
}

export function configurationHistory(store: Store, taskId: string) {
  const assignment = assignedTask(store, taskId);
  return {
    schema_version: 1,
    task_id: taskId,
    assignment_id: assignment.id,
    assigned_variant_id: assignment.variant_id,
    confirmations: store.all<ConfirmationRow>('SELECT * FROM comparison_confirmations WHERE task_id = ? ORDER BY rowid', [taskId]).map(row => ({
      ...parseComparison(ConfigurationRecordSchema, JSON.parse(row.payload) as unknown),
      recorded_at: row.recorded_at,
      session_ids: store
        .all<{ session_id: string }>('SELECT session_id FROM comparison_confirmation_sessions WHERE confirmation_id = ? ORDER BY session_id', [row.id])
        .map(session => session.session_id)
    })),
    deviations: store.all<{ reason_code: string; occurred_at: string; recorded_at: string }>(
      'SELECT reason_code,occurred_at,recorded_at FROM comparison_deviations WHERE task_id = ? ORDER BY rowid',
      [taskId]
    ),
    limitations: ['configuration_evidence_does_not_verify_global_isolation', 'self_attestation_does_not_verify_behavior']
  };
}

export function classifyFlexibleConfirmation(
  assignedVariantId: string,
  input: RuntimeEvidence,
  previous: RuntimeEvidence | null,
  actualVariantId: string | null
): { runtime_change: boolean; harness_deviation: 'none' | 'unknown' | 'crossover' } {
  parseComparison(IdSchema, assignedVariantId);
  if (actualVariantId !== null) parseComparison(IdSchema, actualVariantId);
  const runtime = parseComparison(RuntimeEvidenceSchema, input, 'invalid_runtime');
  const before = previous === null ? null : parseComparison(RuntimeEvidenceSchema, previous, 'invalid_runtime');
  if (before && before.task_id !== runtime.task_id) throw new Error('scope_mismatch');
  return {
    runtime_change: before !== null && (before.model !== runtime.model || before.effort !== runtime.effort),
    harness_deviation: actualVariantId === null ? 'unknown' : actualVariantId === assignedVariantId ? 'none' : 'crossover'
  };
}
