import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import { Store } from '../src/store.js';
import { Lifecycle } from '../src/lifecycle.js';
import { assignTask } from '../src/comparison/allocation.js';
import { freezeProtocol, registerProtocol, registerVariant } from '../src/comparison.js';
import { configurationHistory, bindConfigurationToSession } from '../src/configuration-evidence.js';
import { confirmConfiguration } from '../src/comparison/config-confirmation-write.js';
import { assignmentInput, assignmentTime, beforeRecruitment, metadata, protocol, seedProject, variantA, variantB } from './helpers/comparison-fixture.js';

const confirmation = {
  schema_version: 1,
  id: 'confirmation-1',
  task_id: 'task-1',
  occurred_at: assignmentTime,
  evidence_method: 'self_attested',
  actual_variant_id: 'variant-a',
  product: 'synthetic',
  product_version: '1.0.0',
  model: 'synthetic-model',
  reasoning_setting: 'none',
  environment_id: 'environment-1'
};
function setup(store: Store, overrides: Record<string, unknown> = {}) {
  seedProject(store);
  registerVariant(store, variantA);
  registerVariant(store, variantB);
  registerProtocol(store, { ...protocol, ...overrides });
  freezeProtocol(store, protocol.id, beforeRecruitment);
  return assignTask(store, assignmentInput, { clock: () => assignmentTime, shuffle: values => values });
}

test('assigned tasks require explicit application evidence while ordinary lifecycle stays unchanged', () => {
  const store = new Store(':memory:');
  const life = new Lifecycle(store, () => assignmentTime);
  try {
    const assigned = setup(store);
    expect(() => life.start('task-1')).toThrow('configuration_confirmation_required');
    confirmConfiguration(store, confirmation, assignmentTime);
    confirmConfiguration(store, confirmation, assignmentTime);
    expect(configurationHistory(store, 'task-1')).toMatchObject({
      assignment_id: assigned.assignment_id,
      confirmations: [{ id: 'confirmation-1', evidence_method: 'self_attested', verification_status: 'confirmed', observed_config_hash: null }]
    });
    expect(store.all('SELECT id FROM comparison_confirmations')).toHaveLength(1);
    expect(() => confirmConfiguration(store, { ...confirmation, model: 'other-model' }, assignmentTime)).toThrow('confirmation_conflict');
    life.start('task-1');
    life.pause('task-1');
    life.resume('task-1');
    life.declareFirst('task-1');
    life.assessFirst('task-1', false);
    life.rework('task-1');
    life.finalize('task-1', 'success', ['criterion-1']);
    expect(life.summary('task-1')).toMatchObject({ first_success: false, rework_count: 1, outcome: 'success' });
    expect(store.get('SELECT variant_id FROM comparison_assignments')).toEqual({ variant_id: 'variant-a' });
    expect(() => confirmConfiguration(store, { ...confirmation, id: 'late' }, assignmentTime)).toThrow('invalid_transition');
    life.createTask('project-1', 'ordinary', metadata);
    life.start('ordinary');
    expect(life.state('ordinary')).toBe('active');
  } finally {
    store.close();
  }
});

test('unknown and crossover are auditable and remain in their original assignment under continue policy', () => {
  const store = new Store(':memory:');
  const life = new Lifecycle(store, () => assignmentTime);
  try {
    const assigned = setup(store);
    confirmConfiguration(store, { ...confirmation, actual_variant_id: null }, assignmentTime);
    life.start('task-1');
    confirmConfiguration(store, { ...confirmation, id: 'crossed', actual_variant_id: 'variant-b' }, assignmentTime);
    const history = configurationHistory(store, 'task-1');
    expect(history).toMatchObject({
      assignment_id: assigned.assignment_id,
      confirmations: [
        { verification_status: 'unknown', deviation_codes: ['unknown'] },
        { verification_status: 'mismatch', deviation_codes: ['crossover'] }
      ]
    });
    expect(store.all<{ reason_code: string }>('SELECT reason_code FROM comparison_deviations ORDER BY rowid').map(row => row.reason_code)).toEqual([
      'unknown',
      'crossover'
    ]);
    life.pause('task-1');
    life.resume('task-1');
    expect(life.state('task-1')).toBe('active');
  } finally {
    store.close();
  }
});

test('stop policies pause active tasks and prevent resume; version drift cannot restart an old assignment', () => {
  for (const change of [{ actual_variant_id: null }, { actual_variant_id: 'variant-b' }, { product_version: '1.0.1' }]) {
    const store = new Store(':memory:');
    let now = assignmentTime;
    const life = new Lifecycle(store, () => now);
    try {
      setup(store, { deviation_policy: { mismatch: 'stop', unknown: 'stop', version_drift: 'new_phase' } });
      confirmConfiguration(store, confirmation, now);
      life.start('task-1');
      now = '2026-01-01T00:00:10Z';
      confirmConfiguration(store, { ...confirmation, ...change, id: 'changed', occurred_at: now }, now);
      expect(life.state('task-1')).toBe('paused');
      expect(() => life.resume('task-1')).toThrow('configuration_policy_stop');
      expect(store.get('SELECT ended_at FROM active_intervals')).toEqual({ ended_at: '2026-01-01T00:00:10.000Z' });
    } finally {
      store.close();
    }
  }
});

test('selected artifact hashes are computed from explicit files without storing paths or claiming global isolation', () => {
  const root = mkdtempSync(join(tmpdir(), 'selected-artifacts-'));
  const path = join(root, 'instructions.txt');
  const store = new Store(':memory:');
  try {
    writeFileSync(path, 'SYNTHETIC_INSTRUCTION_SENTINEL');
    const fileHash = createHash('sha256').update('SYNTHETIC_INSTRUCTION_SENTINEL').digest('hex');
    const manifest = createHash('sha256')
      .update(JSON.stringify([{ artifact_id: 'instructions', sha256: fileHash }]))
      .digest('hex');
    seedProject(store);
    registerVariant(store, { ...variantA, instruction_manifest_hash: manifest });
    registerVariant(store, variantB);
    registerProtocol(store, protocol);
    freezeProtocol(store, protocol.id, beforeRecruitment);
    assignTask(store, assignmentInput, { clock: () => assignmentTime, shuffle: values => values });
    expect(() => confirmConfiguration(store, { ...confirmation, evidence_method: 'selected_artifact_hash' }, assignmentTime)).toThrow(
      'selected_artifacts_required'
    );
    confirmConfiguration(store, { ...confirmation, evidence_method: 'selected_artifact_hash' }, assignmentTime, [{ artifactId: 'instructions', path }]);
    expect(configurationHistory(store, 'task-1')).toMatchObject({
      confirmations: [{ verification_status: 'confirmed', observed_config_hash: manifest, verification_scope: 'selected_artifacts_and_declared_settings' }]
    });
    writeFileSync(path, 'SYNTHETIC_CHANGED_INSTRUCTIONS');
    confirmConfiguration(store, { ...confirmation, id: 'changed', evidence_method: 'selected_artifact_hash' }, assignmentTime, [
      { artifactId: 'instructions', path }
    ]);
    expect(configurationHistory(store, 'task-1').confirmations[1]).toMatchObject({ verification_status: 'mismatch', deviation_codes: ['mismatch'] });
    const persisted = JSON.stringify(store.all('SELECT * FROM comparison_confirmations'));
    expect(persisted).not.toContain(root);
    expect(persisted).not.toContain('SYNTHETIC_INSTRUCTION_SENTINEL');
    expect(() =>
      confirmConfiguration(store, { ...confirmation, id: 'bad-file', evidence_method: 'selected_artifact_hash' }, assignmentTime, [
        { artifactId: 'instructions', path: join(root, 'missing') }
      ])
    ).toThrow(/^selected_artifact_error$/);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('confirmation linkage is explicit and cannot attach another task session or alter past evidence', () => {
  const store = new Store(':memory:');
  const life = new Lifecycle(store, () => assignmentTime);
  try {
    setup(store);
    confirmConfiguration(store, confirmation, assignmentTime);
    store.execute('INSERT INTO sessions(id,task_id,project_id) VALUES (?,?,?)', ['session-1', 'task-1', 'project-1']);
    bindConfigurationToSession(store, 'confirmation-1', 'session-1');
    bindConfigurationToSession(store, 'confirmation-1', 'session-1');
    life.createTask('project-1', 'ordinary', metadata);
    store.execute('INSERT INTO sessions(id,task_id,project_id) VALUES (?,?,?)', ['other-session', 'ordinary', 'project-1']);
    expect(() => bindConfigurationToSession(store, 'confirmation-1', 'other-session')).toThrow('scope_mismatch');
    expect(configurationHistory(store, 'task-1').confirmations[0]).toMatchObject({ session_ids: ['session-1'] });
    expect(() => store.execute('UPDATE comparison_confirmations SET payload = ? WHERE id = ?', ['{}', 'confirmation-1'])).toThrow(
      'immutable_comparison_confirmation'
    );
    expect(() => life.linkSession('task-1', 'real-source', '/synthetic/not-read', 'codex', '0.164.0')).toThrow('unsupported');
    expect(() => confirmConfiguration(store, { ...confirmation, id: 'private', prompt: 'PRIVATE_SENTINEL' }, assignmentTime)).toThrow(
      /^invalid_comparison_input$/
    );
    expect(() => confirmConfiguration(store, { ...confirmation, id: 'backdated', occurred_at: beforeRecruitment }, assignmentTime)).toThrow(
      'invalid_confirmation_time'
    );
    expect(() => confirmConfiguration(store, { ...confirmation, id: 'future', occurred_at: '2026-01-01T01:00:00Z' }, assignmentTime)).toThrow(
      'invalid_confirmation_time'
    );
  } finally {
    store.close();
  }
});

test('current mechanical confirmation captures invocation time when occurrence is omitted', () => {
  const root = mkdtempSync(join(tmpdir(), 'current-artifact-'));
  const file = join(root, 'instructions.md');
  const store = new Store(':memory:');
  try {
    writeFileSync(file, 'SYNTHETIC_INSTRUCTIONS');
    setup(store);
    const input: Record<string, unknown> = { ...confirmation, evidence_method: 'selected_artifact_hash' };
    delete input.occurred_at;
    confirmConfiguration(store, input, assignmentTime, [{ artifactId: 'instructions', path: file }]);
    expect(configurationHistory(store, 'task-1').confirmations[0]).toMatchObject({
      occurred_at: '2026-01-01T00:00:00.000Z',
      recorded_at: '2026-01-01T00:00:00.000Z',
      evidence_method: 'selected_artifact_hash'
    });
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('future-recorded configuration cannot authorize a backdated task start', () => {
  const store = new Store(':memory:');
  try {
    setup(store);
    confirmConfiguration(store, { ...confirmation, occurred_at: '2026-01-01T00:00:10Z' }, '2026-01-01T00:00:10Z');
    const life = new Lifecycle(store, () => assignmentTime);
    expect(() => life.start('task-1')).toThrow('clock_regression');
    expect(life.state('task-1')).toBe('registered');
  } finally {
    store.close();
  }
});

test('human abandonment records one cancellation deviation without altering the original assignment', () => {
  const store = new Store(':memory:');
  const life = new Lifecycle(store, () => assignmentTime);
  try {
    const assignment = setup(store);
    confirmConfiguration(store, confirmation, assignmentTime);
    life.start('task-1');
    life.finalize('task-1', 'aborted', []);
    expect(configurationHistory(store, 'task-1')).toMatchObject({
      assignment_id: assignment.assignment_id,
      deviations: [{ reason_code: 'cancellation', occurred_at: '2026-01-01T00:00:00.000Z', recorded_at: '2026-01-01T00:00:00.000Z' }]
    });
    expect(() => life.finalize('task-1', 'aborted', [])).toThrow('invalid_transition');
    expect(store.all('SELECT id FROM comparison_deviations')).toHaveLength(1);
  } finally {
    store.close();
  }
});

test.each([false, true])('mixed unknown and mismatch honors every stop policy (active=%s)', active => {
  const store = new Store(':memory:');
  const life = new Lifecycle(store, () => assignmentTime);
  try {
    setup(store, { deviation_policy: { mismatch: 'continue', unknown: 'stop', version_drift: 'stop' } });
    if (active) {
      confirmConfiguration(store, confirmation, assignmentTime);
      life.start('task-1');
    }
    confirmConfiguration(store, { ...confirmation, id: 'mixed', actual_variant_id: null, environment_id: 'environment-2' }, assignmentTime);
    expect(configurationHistory(store, 'task-1').confirmations.at(-1)).toMatchObject({
      verification_status: 'mismatch',
      deviation_codes: ['unknown', 'mismatch']
    });
    if (active) {
      expect(life.state('task-1')).toBe('paused');
      expect(() => life.resume('task-1')).toThrow('configuration_policy_stop');
    } else {
      expect(() => life.start('task-1')).toThrow('configuration_policy_stop');
      expect(life.state('task-1')).toBe('registered');
    }
  } finally {
    store.close();
  }
});
