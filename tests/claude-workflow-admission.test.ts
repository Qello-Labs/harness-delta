import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { expect, test } from 'vitest';
import { ZodError } from 'zod';
import { evaluateReadiness, productionSourceEvidence, type ReadinessInput } from '../src/readiness.js';
import { evaluateCostCoverage } from '../src/cost-coverage.js';
import { createClaudeWorkflowAdapter } from '../src/claude-workflow-adapter.js';
import { registerProtocol, freezeProtocol } from '../src/comparison.js';
import { runAssignedWorkflow, workflowStatus } from '../src/task-workflow.js';
import { makeFlexibleFixture } from './helpers/flexible-fixture.js';
import { claudeWorkflowFixture as fixture, claudeWorkflowProfile as profile } from './helpers/claude-workflow-fixture.js';
import { claudeWorkflowChildProfileId } from '../src/claude-workflow-versions.js';

const evidenceId = 'claude-workflow-02196-root-native-v1';
const rootSemanticsDigest = '27298b4ecb2fc8c2982afc6307268a19ccf2652db787c96dff4b52321526333a';
const childEvidenceId = 'claude-workflow-02196-direct-child-native-v1';
const childSemanticsDigest = 'dfe01a0be5489858a2d60cf2dc0076073296e2f34d11ca62f5b184e4b37690d8';
const childProfile = { ...profile, profile_id: claudeWorkflowChildProfileId };

test('protocol registration rejects two Claude profiles at the same product version', () => {
  const f = fixture(); try {
    expect(() => registerProtocol(f.store, { ...makeFlexibleFixture().protocol, id: 'duplicate-claude-profiles',
      source_profiles: [profile, childProfile] })).toThrow(/^invalid_comparison_input$/);
    expect(f.store.get('SELECT id FROM comparison_protocols WHERE id=?', ['duplicate-claude-profiles'])).toBeUndefined();
  } finally { f.cleanup(); }
});
function readiness(): ReadinessInput {
  const f = makeFlexibleFixture();
  return { protocol: { ...f.protocol, purpose: 'real_experiment', source_profiles: [profile] }, source_evidence_ids: [evidenceId],
    coverage: [{ evidence: f.coverage, decision: evaluateCostCoverage(f.coverage) }], analysis_evidence_id: null, invalidated: false, followup_complete: true };
}
test('the parent-only Claude 2.1.296 registration admits allocation but never complete cost or inference', () => {
  // Both earlier root admissions, 2.1.288 and 2.1.291, are retired.
  expect(productionSourceEvidence.filter(row => row.product === 'claude_code')).toEqual([
    { id: evidenceId, ...profile, validation_kind: 'real_operations', complete_cost: false, semantics_digest: rootSemanticsDigest },
    { id: childEvidenceId, ...childProfile, validation_kind: 'real_operations', complete_cost: false, semantics_digest: childSemanticsDigest },
  ]);
  expect(Object.isFrozen(productionSourceEvidence.find(row => row.id === evidenceId))).toBe(true);
  expect(evaluateReadiness(readiness())).toMatchObject({ real_allocation: true, complete_cost: false, inference: false });
});
test.each([{ ...profile, product_version: '2.1.288' }, { ...profile, product_version: '2.1.291' }, { ...profile, product_version: '2.1.290' }, { ...profile, product_version: '2.1.297' }, { ...profile, profile_id: 'claude-child-own-v1' }])(
  'unmatched Claude source $product_version/$profile_id remains closed', mismatch => {
    expect(evaluateReadiness({ ...readiness(), protocol: { ...readiness().protocol, source_profiles: [mismatch] } })).toMatchObject({ real_allocation: false });
  });

test('an admitted Claude protocol reports native execution and still checks child scope and binary before assignment', async () => {
  const f = fixture(); try {
    expect(workflowStatus(f.store, f.protocolId)).toMatchObject({ native_execution: true, blockers: ['whole_task_cost_unconfirmed', 'analysis_unverified'] });
    await expect(runAssignedWorkflow(f.store, f.input, createClaudeWorkflowAdapter(f.store, { ...f.execution, child_runtime: { model: 'child-model', effort: 'low' } }), { model: null, effort: null }))
      .rejects.toThrow(/^workflow_adapter_mismatch$/);
    await expect(runAssignedWorkflow(f.store, f.input, createClaudeWorkflowAdapter(f.store, { ...f.execution, binary: { ...f.execution.binary, sha256: 'f'.repeat(64) } }), { model: null, effort: null }))
      .rejects.toThrow(/^claude_probe_executable_mismatch$/);
    expect(f.store.all('SELECT * FROM comparison_assignments')).toHaveLength(0);
    expect(f.store.all('SELECT * FROM claude_workflow_runs')).toHaveLength(0);
  } finally { f.cleanup(); }
});
test('workspace-edit refuses harness files the model could edit inside the project root', async () => {
  const f = fixture(); try {
    const prompt = join(f.project, 'prompt.txt'); writeFileSync(prompt, 'SYNTHETIC_PRIVATE_TASK');
    const insideBinary = join(f.project, 'claude'); writeFileSync(insideBinary, 'synthetic');
    // A symlinked mediator outside the root whose target is inside it.
    const target = join(f.project, 'mediator.js'); writeFileSync(target, ''); const outside = join(dirname(f.project), 'linked'); mkdirSync(outside);
    symlinkSync(target, join(outside, 'mediator.js'));
    const cases: Record<string, unknown>[] = [{ workspace: join(f.project, 'workspace') }, { mediator_path: join(f.project, 'dist', 'claude-probe-hook-mediator.js') }, { prompt_file: prompt },
      { binary: { ...f.execution.binary, path: insideBinary } }, { mediator_path: join(outside, 'mediator.js') }];
    // A case-insensitive volume reaches the same directory through another spelling.
    const alias = join(dirname(f.project), basename(f.project).toUpperCase());
    if (existsSync(alias)) cases.push({ mediator_path: join(alias, 'dist', 'claude-probe-hook-mediator.js') });
    for (const inside of cases)
      await expect(runAssignedWorkflow(f.store, f.input, createClaudeWorkflowAdapter(f.store, { ...f.execution, ...inside }), { model: null, effort: null }))
        .rejects.toThrow(/^claude_workflow_harness_inside_project$/);
    // Read-only runs cannot modify files, so the same layout reaches the next preflight check.
    await expect(runAssignedWorkflow(f.store, f.input, createClaudeWorkflowAdapter(f.store, { ...f.execution, permissions: 'read-only', workspace: join(f.project, 'workspace'),
      binary: { ...f.execution.binary, sha256: 'f'.repeat(64) } }), { model: null, effort: null })).rejects.toThrow(/^claude_probe_executable_mismatch$/);
    expect(f.store.all('SELECT * FROM comparison_assignments')).toHaveLength(0);
  } finally { f.cleanup(); }
});
test.each(['2.1.288', '2.1.291'])('a new %s protocol cannot register after retirement', version => {
  expect(() => fixture(version)).toThrow(/^claude_workflow_version_not_latest$/);
});
test.each(['2.1.288', '2.1.291'])('a stored %s protocol keeps its version but its tasks cannot launch after retirement', async version => {
  const f = fixture(); try {
    // A stored row stands for a protocol registered before its version was retired.
    const row = f.store.get<{ settings: string }>('SELECT settings FROM comparison_protocols WHERE id=?', [f.protocolId])!;
    const settings = { ...JSON.parse(row.settings) as Record<string, unknown>, id: 'protocol-retired', source_profiles: [{ ...profile, product_version: version }] };
    f.store.execute("INSERT INTO comparison_protocols(id,project_id,settings) VALUES ('protocol-retired','project-1',?)", [JSON.stringify(settings)]);
    // The rule runs at insert only: an identical re-registration of the stored row succeeds,
    // while the same settings under a new ID are refused.
    expect(() => registerProtocol(f.store, settings)).not.toThrow();
    expect(() => registerProtocol(f.store, { ...settings, id: 'protocol-retired-new' })).toThrow(/^claude_workflow_version_not_latest$/);
    freezeProtocol(f.store, 'protocol-retired', new Date(Date.now() - 120000).toISOString());
    const status = workflowStatus(f.store, 'protocol-retired');
    expect(status).toMatchObject({ native_execution: false });
    expect(status.blockers).toEqual(expect.arrayContaining(['native_source_unqualified', 'native_adapter_not_wired']));
    const input = { ...f.input, assignment: { ...f.input.assignment, protocol_id: 'protocol-retired' }, product_version: version };
    // A retired binary no longer parses; an admitted binary still meets a closed protocol.
    expect(() => createClaudeWorkflowAdapter(f.store, { ...f.execution, binary: { ...f.execution.binary, version } })).toThrow(ZodError);
    await expect(runAssignedWorkflow(f.store, input, createClaudeWorkflowAdapter(f.store, f.execution), { model: null, effort: null })).rejects.toThrow(/^real_experiment_disabled$/);
    expect(f.store.all('SELECT * FROM comparison_assignments')).toHaveLength(0);
  } finally { f.cleanup(); }
});
test('the configured product version, binary version and registered profile must agree before assignment', async () => {
  const f = fixture(); try {
    await expect(runAssignedWorkflow(f.store, { ...f.input, product_version: '2.1.288' }, createClaudeWorkflowAdapter(f.store, f.execution), { model: null, effort: null }))
      .rejects.toThrow(/^workflow_adapter_mismatch$/);
    expect(f.store.all('SELECT * FROM comparison_assignments')).toHaveLength(0);
  } finally { f.cleanup(); }
});
test('a synthetic_validation protocol may name a non-latest own-trace profile', () => {
  const f = fixture(); try {
    const synthetic = { ...makeFlexibleFixture().protocol, id: 'synthetic-2188', purpose: 'synthetic_validation' as const, source_profiles: [{ ...profile, product_version: '2.1.288' }] };
    expect(() => registerProtocol(f.store, synthetic)).not.toThrow();
    expect(f.store.get('SELECT id FROM comparison_protocols WHERE id=?', ['synthetic-2188'])).toEqual({ id: 'synthetic-2188' });
  } finally { f.cleanup(); }
});

test('the frozen direct-child registration admits allocation but never complete cost or inference', () => {
  const row = productionSourceEvidence.find(evidence => evidence.id === childEvidenceId);
  expect(row).toBeDefined();
  expect(Object.isFrozen(row)).toBe(true);
  const input = { ...readiness(), protocol: { ...readiness().protocol, source_profiles: [childProfile] }, source_evidence_ids: [childEvidenceId] };
  expect(evaluateReadiness(input)).toMatchObject({ real_allocation: true, complete_cost: false, inference: false });
  for (const mismatch of [{ ...childProfile, product_version: '2.1.291' }, { ...childProfile, product_version: '2.1.297' }, profile]) {
    expect(evaluateReadiness({ ...input, protocol: { ...input.protocol, source_profiles: [mismatch] } }))
      .toMatchObject({ real_allocation: false, complete_cost: false, inference: false });
  }
});

test('every production source digest names recorded evidence, never a placeholder', () => {
  for (const row of productionSourceEvidence) {
    expect(row.semantics_digest).toMatch(/^[a-f0-9]{64}$/);
    // A digest of one repeated character is a placeholder, not the hash of an evidence record.
    expect(new Set(row.semantics_digest).size).toBeGreaterThan(8);
  }
  expect(new Set(productionSourceEvidence.map(row => row.semantics_digest)).size).toBe(productionSourceEvidence.length);
});
