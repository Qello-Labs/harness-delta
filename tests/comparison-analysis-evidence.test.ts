import { expect, test } from 'vitest';
import { builtInCases, makeDesign } from '../scripts/analysis-validation/cases.js';
import { assessStudyCase } from '../scripts/analysis-validation/eligibility.js';
test('rejects unsupported mechanisms, incomplete endpoints, omitted slots and population misalignment', () => {
  const original = builtInCases().find(c => c.caseId === 'b4r4-decrease-base')!;
  const rejected = (input: unknown, code: string) => expect(assessStudyCase(input)).toEqual({ status: 'rejected', reasonCodes: [code] });
  for (const usageCoverage of ['partial', 'missing', 'error', 'excluded', 'unmeasurable']) {
    const c = structuredClone(original);
    c.population[0]!.usageCoverage = usageCoverage as (typeof c.population)[0]['usageCoverage'];
    rejected(c, 'incomplete_usage');
  }
  for (const qualityState of ['pending', 'missing']) {
    const c = structuredClone(original);
    c.population[0]!.qualityState = qualityState as 'pending' | 'missing';
    rejected(c, 'incomplete_quality');
  }
  for (const [key, values, code] of [
    ['grouping', ['actual_only'], 'unsupported_grouping'],
    ['enrollment', ['adaptive', 'unknown'], 'unsupported_enrollment'],
    ['history', ['carryover', 'unknown'], 'unsupported_history'],
    ['truncation', ['outcome_dependent', 'unknown'], 'unsupported_truncation']
  ] as const)
    for (const value of values) rejected({ ...original, [key]: value }, code);
  rejected({ ...original, origin: 'real' }, 'invalid_case');
  rejected({ ...original, confidenceInterval: true }, 'invalid_case');
  for (const population of [original.population.slice(1), [...original.population].reverse(), [...original.population, original.population[0]!]])
    rejected({ ...original, population }, 'population_alignment');
  const hole = structuredClone(original);
  hole.design.strata[0]!.blocks[0]!.observationMask = [true, false, true, false];
  rejected(hole, 'non_prefix');
  rejected({ ...original, design: makeDesign(8, [[8, 0]]) }, 'resource_limit');
  rejected({ ...original, design: makeDesign(6, [[6, 6]]) }, 'operation_limit');
  rejected({ ...original, design: makeDesign(4, [[0]]), population: [] }, 'empty_population');
  expect(assessStudyCase({ ...original, population: original.population.map(t => ({ ...t, yA: 0, yB: 0 })) })).toEqual({ status: 'eligible' });
});

import { projectComparison } from '../src/comparison/reports/comparison.js';
import type { ComparisonSnapshotInput } from '../src/comparison/reports/comparison-contracts.js';
import { ProtocolSchema, VariantSchema } from '../src/comparison-contracts.js';
import { TaskMetadataSchema } from '../src/contracts.js';
import { metadata, protocol, variantA, variantB, assignmentInput, beforeRecruitment, assignmentTime } from './helpers/comparison-fixture.js';
import { reportStore } from './helpers/comparison-report-fixture.js';
import { registerProtocol, freezeProtocol } from '../src/comparison/comparison.js';
import { assignTask } from '../src/comparison/allocation.js';
function reportInput(): ComparisonSnapshotInput {
  const assigned = '2026-01-01T00:00:00.000Z',
    deadline = '2026-01-01T01:00:00.000Z';
  return {
    schema_version: 1,
    descriptive_version: 'assignment-descriptive-1',
    report_id: 'report-1',
    protocol: ProtocolSchema.parse(protocol),
    variants: [VariantSchema.parse(variantA), VariantSchema.parse(variantB)],
    cutoff: deadline,
    evaluated_at: '2026-01-03T00:00:00.000Z',
    data_revision: 0,
    snapshot_sequence: 1,
    revision_reason: 'initial',
    supersedes_report_id: null,
    registrations: [],
    assignments: [
      {
        assignment_id: 'a',
        task_id: 't',
        variant_id: variantA.id,
        assigned_at: assigned,
        recorded_at: assigned,
        followup_ends_at: deadline,
        stratum_id: 's',
        block_id: 'b',
        metadata: TaskMetadataSchema.parse(metadata),
        environment_id: 'environment-1',
        started_at: assigned,
        first_completed_at: null,
        first_assessed_at: null,
        first_success: null,
        finalized_at: '2026-01-01T00:10:00.000Z',
        outcome: { status: 'success', assessed_at: '2026-01-01T00:10:00.000Z', criteria_met: ['criterion-1'] },
        rework_starts: [],
        active_intervals: [],
        observations: [],
        usages: [],
        confirmations: [],
        deviations: []
      }
    ]
  };
}
test('existing synthetic reports retain original grouping, half-open followup, null inference and partial totals', () => {
  const data = reportInput(),
    row = data.assignments[0]!;
  row.confirmations = [
    {
      schema_version: 1,
      id: 'confirmation',
      task_id: 't',
      occurred_at: row.assigned_at,
      recorded_at: row.assigned_at,
      evidence_method: 'self_attested',
      actual_variant_id: variantB.id,
      product: null,
      product_version: null,
      model: null,
      reasoning_setting: null,
      environment_id: null,
      verification_status: 'unknown',
      observed_config_hash: null,
      verification_scope: 'declared_settings',
      deviation_codes: ['unknown']
    }
  ];
  const observed = { status: 'observed' as const, value: 0, reason: null };
  row.usages = [row.assigned_at, row.followup_ends_at].map((at, i) => ({
    event_id: `e${i}`,
    occurred_at: at,
    recorded_at: at,
    payload: {
      kind: 'usage',
      product: 'synthetic',
      product_version: '1.0.0',
      model: 'synthetic-model',
      epoch: 'e',
      input_total: { ...observed, value: i ? 99 : 0 },
      output_total: observed,
      cached_input: observed,
      reasoning_output: observed
    }
  }));
  let report = projectComparison(data);
  expect(report.arms[0]!.assigned_tasks).toBe(1);
  expect(report.arms[1]!.assigned_tasks).toBe(0);
  expect(report.tasks[0]!.usage).toMatchObject({ status: 'partial', partial_tokens: 0, complete_tokens: null });
  expect(report.adoption).toEqual({ status: 'inconclusive', reason: 'analysis_not_validated' });
  expect(assessStudyCase(report).status).toBe('rejected');
  const c = builtInCases()[0]!;
  c.population[0]!.usageCoverage = 'partial';
  expect(assessStudyCase(c)).toEqual({ status: 'rejected', reasonCodes: ['incomplete_usage'] });
  row.outcome!.assessed_at = row.followup_ends_at;
  expect(projectComparison(data).tasks[0]!.deadline_status).toBe('outcome_missing');
  row.outcome!.assessed_at = '2026-01-01T00:10:00.000Z';
  data.cutoff = '2026-01-01T00:59:59.999Z';
  report = projectComparison(data);
  expect(report.tasks[0]!.deadline_status).toBe('pending_followup');
  expect(report.total.deadline_success).toMatchObject({ value: null, reason: 'pending_followup' });
  // Every inference slot remains null; assert actual contract fields below.
  expect(report.confidence_interval).toBeNull();
  expect(report.p_value).toBeNull();
});
test('synthetic evidence cannot authorize real experiment assignments', () => {
  const store = reportStore();
  try {
    registerProtocol(store, { ...protocol, id: 'real', purpose: 'real_experiment' });
    freezeProtocol(store, 'real', beforeRecruitment);
    expect(() =>
      assignTask(store, { ...assignmentInput, task_id: 'new', logical_task_id: 'new', protocol_id: 'real' }, { clock: () => assignmentTime })
    ).toThrow('real_experiment_disabled');
  } finally {
    store.close();
  }
});

import { runStudy, provenance, verifyRegistry } from '../scripts/analysis-validation/runner.js';
import { rejectionCases } from '../scripts/analysis-validation/cases.js';
test('evidence pins expected and executed checks and is deterministic', () => {
  const a = runStudy(),
    b = runStudy();
  expect(a).toEqual(b);
  expect(a).toMatchObject({
    schema_version: 1,
    r10_status: 'unvalidated',
    adoption: 'inconclusive',
    status: 'pass',
    failures: [],
    counts: { cases: 432, rejected_cases: 26, statistics: 7272, tails: 7272, expectations: 432, calibrations: 432 }
  });
  expect(a.counts).toEqual(a.expected_counts);
  expect(a.cases).toHaveLength(432);
  expect(a.rejected_cases).toHaveLength(26);
  expect(JSON.stringify(a)).not.toMatch(/\/Users\/|hostname|source_path|session_id|pending_variants/);
  expect(provenance()).toEqual(a.provenance);
}, 30000);
test('registry rejects missing duplicate skipped or unexpected checks', () => {
  expect(verifyRegistry(['a', 'b'], ['a', 'b'])).toBe(true);
  for (const actual of [['a'], ['a', 'a'], ['a', 'b', 'c'], ['b']]) expect(verifyRegistry(['a', 'b'], actual)).toBe(false);
  expect(rejectionCases().map(c => c.id)).toEqual([
    'usage-partial',
    'usage-missing',
    'usage-error',
    'usage-excluded',
    'usage-unmeasurable',
    'quality-missing',
    'quality-pending',
    'grouping-actual_only',
    'enrollment-adaptive',
    'enrollment-unknown',
    'history-carryover',
    'history-unknown',
    'truncation-outcome_dependent',
    'truncation-unknown',
    'real-origin',
    'requested-interval',
    'missing-id',
    'reordered-ids',
    'duplicate-id',
    'interior-hole',
    'unequal-arm-missingness',
    'high-usage-missingness',
    'queue-bound',
    'operation-bound',
    'empty-population',
    'unknown-block-order'
  ]);
});

import { vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, cpSync, symlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { sourceFiles, main } from '../scripts/analysis-validation/runner.js';
import * as statisticModule from '../scripts/analysis-validation/statistics.js';
test('source closure covers every study source and changes to oracle, wrapper, settings or cases alter provenance', () => {
  const declared = sourceFiles
    .filter(x => x.startsWith('scripts/analysis-validation/') && x.endsWith('.ts'))
    .map(x => x.split('/').at(-1))
    .sort();
  expect(declared).toEqual(
    readdirSync('scripts/analysis-validation')
      .filter(x => x.endsWith('.ts') && !x.startsWith('confidence'))
      .sort()
  );
});
test('injected candidate mismatch becomes failed evidence and a nonzero command status', () => {
  const spy = vi.spyOn(statisticModule, 'computeStatistic').mockReturnValue({ numerator: 999n, denominator: 1n });
  const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true),
    argv = process.argv;
  try {
    process.argv = [process.execPath, 'runner'];
    expect(main()).toBe(1);
    const text = String(stdout.mock.calls[0]![0]);
    expect(JSON.parse(text)).toMatchObject({ status: 'fail', r10_status: 'unvalidated' });
  } finally {
    process.argv = argv;
    stdout.mockRestore();
    spy.mockRestore();
  }
}, 30000);
test('wrapper rejects every external argument before compilation and runs only isolated offline output', () => {
  const bad = spawnSync(process.execPath, ['scripts/analysis-validation-command.mjs', '--data', 'private.db'], { encoding: 'utf8' });
  expect(bad.status).toBe(1);
  expect(JSON.parse(bad.stdout)).toEqual({ status: 'fail', failures: ['unknown_arguments'] });
  const root = mkdtempSync(join(tmpdir(), 'analysis-command-'));
  try {
    for (const path of sourceFiles) {
      const target = join(root, path);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(path, target);
    }
    symlinkSync(join(process.cwd(), 'node_modules'), join(root, 'node_modules'), 'dir');
    const result = spawnSync(process.execPath, ['scripts/analysis-validation-command.mjs'], { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'pass', counts: { cases: 432 }, r10_status: 'unvalidated' });
    const probe = () =>
      JSON.parse(
        spawnSync(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            "import {provenance} from './.harness-delta/analysis-validation-build/scripts/analysis-validation/runner.js'; console.log(JSON.stringify(provenance()));"
          ],
          { cwd: root, encoding: 'utf8' }
        ).stdout
      ) as ReturnType<typeof provenance>;
    const before = probe();
    for (const path of [
      'tests/helpers/analysis-oracle.ts',
      'scripts/analysis-validation-command.mjs',
      'scripts/analysis-validation/tsconfig.json',
      'scripts/analysis-validation/cases.ts',
      'scripts/analysis-validation/statistics.ts'
    ]) {
      const file = join(root, path),
        original = readFileSync(file);
      writeFileSync(file, Buffer.concat([original, Buffer.from('\n// mutation\n')]));
      const after = probe();
      expect(after.source_sha256).not.toBe(before.source_sha256);
      expect(after.files.find(x => x.path === path)!.sha256).not.toBe(before.files.find(x => x.path === path)!.sha256);
      writeFileSync(file, original);
    }
    // Mutate the isolated compiled oracle, then prove the actual process fails.
    const oracle = join(root, '.harness-delta/analysis-validation-build/tests/helpers/analysis-oracle.js');
    writeFileSync(oracle, readFileSync(oracle, 'utf8').replace('arms.B * 2n - arms.A * 2n', 'arms.B * 2n - arms.A * 2n + 1n'));
    const failed = spawnSync(process.execPath, ['.harness-delta/analysis-validation-build/scripts/analysis-validation/runner.js'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024
    });
    expect(failed.status).toBe(1);
    expect(JSON.parse(failed.stdout)).toMatchObject({ status: 'fail' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);

test('analysis rejects an empty stratum even when other strata contain retained tasks', () => {
  const c = builtInCases().find(x => x.caseId === 'b4r4-decrease-base')!;
  expect(assessStudyCase({ ...c, design: makeDesign(4, [[4], [0]]) })).toEqual({ status: 'rejected', reasonCodes: ['empty_stratum'] });
});

import * as caseModule from '../scripts/analysis-validation/cases.js';
test('case-specific classification and calibration registry detects swaps hidden by aggregate counts', () => {
  const cases = caseModule.builtInCases(),
    zero = cases.find(x => x.caseId === 'b2r1-zero-base')!,
    effect = cases.find(x => x.caseId === 'b2r1-heterogeneous-effect-base')!;
  [zero.population, effect.population] = [effect.population, zero.population];
  const spy = vi.spyOn(caseModule, 'builtInCases').mockReturnValue(cases);
  try {
    const evidence = runStudy();
    expect(evidence.status).toBe('fail');
    expect(evidence.failures).toContain('b2r1-zero-base:classification_registry');
    expect(evidence.failures).toContain('b2r1-zero-base:check_registry');
  } finally {
    spy.mockRestore();
  }
}, 30000);
test('provenance includes fixed design and case fingerprints', () => {
  expect(provenance().design_sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(provenance().cases_sha256).toMatch(/^[a-f0-9]{64}$/);
});

test('bounded study rejects standardized cost and realized model adjustment', () => {
  expect(assessStudyCase({ primary_metric: 'standardized_cost', grouping: 'realized_model' })).toEqual({
    status: 'rejected',
    reasonCodes: ['unsupported_cost_analysis']
  });
});
