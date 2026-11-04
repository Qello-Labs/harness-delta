import { expect, it, vi } from 'vitest';
import { calibrateEndpoint, checkCoupledCoverage } from '../scripts/analysis-validation/confidence-runner.js';
import { confidenceDesigns, alphas, coupledCases } from '../scripts/analysis-validation/confidence-cases.js';
import { domains } from '../scripts/analysis-validation/confidence-contracts.js';
import { rational } from '../scripts/analysis-validation/contracts.js';
it('calibrates each small truth schedule and detects omitted/duplicate truth identities', () => {
  const d = confidenceDesigns()[0]!.design;
  const result = calibrateEndpoint(d, domains[0]!, alphas);
  expect(result.failures).toEqual([]);
  expect(result.counts).toMatchObject({ truth_tables: 9, observations: 6, envelopes: 30, coverage_checks: 45 });
});
it('preserves paired low usage/quality decline and high usage/unchanged quality coverage', () => {
  const d = confidenceDesigns()[0]!.design;
  for (const [usage, quality] of [
    [
      { potentialA: [2], potentialB: [0] },
      { potentialA: [1], potentialB: [0] }
    ],
    [
      { potentialA: [0], potentialB: [2] },
      { potentialA: [1], potentialB: [1] }
    ],
    [
      { potentialA: [0], potentialB: [2] },
      { potentialA: [0], potentialB: [1] }
    ]
  ]) {
    const result = checkCoupledCoverage(d, usage!, quality!, rational(1n, 20n));
    expect(result).toEqual({ jointCoverage: rational(1n), marginalUsageCoverage: rational(1n), marginalQualityCoverage: rational(1n) });
  }
});
it('retains exactly twelve zipped template identities for each design, including duplicate-valued short cases', () => {
  const all = confidenceDesigns().flatMap(({ id, design }) =>
    coupledCases(
      id,
      design.strata.flatMap(s => s.blocks).reduce((n, b) => n + b.observationMask.filter(Boolean).length, 0)
    )
  );
  expect(all).toHaveLength(108);
  expect(new Set(all.map(x => x.id)).size).toBe(108);
  expect(all[4]!.usage).toEqual({ potentialA: [0], potentialB: [2] });
  expect(all[4]!.quality).toEqual({ potentialA: [0], potentialB: [1] });
  expect(all[5]!.quality).toEqual({ potentialA: [1], potentialB: [0] });
});
import * as caseModule from '../scripts/analysis-validation/confidence-cases.js';
import * as methodModule from '../scripts/analysis-validation/confidence.js';
import { oracleCalibration } from './helpers/confidence-oracle.js';
it('makes omitted and duplicate truth tables visible as failed evidence', () => {
  const original = caseModule.truthTables;
  for (const mutate of [(x: ReturnType<typeof original>) => x.slice(1), (x: ReturnType<typeof original>) => [x[0]!, ...x.slice(0, -1)]]) {
    const spy = vi.spyOn(caseModule, 'truthTables').mockImplementation((n, d) => mutate(original(n, d)));
    try {
      expect(calibrateEndpoint(confidenceDesigns()[0]!.design, domains[0]!, alphas).failures).toContain('truth_registry');
    } finally {
      spy.mockRestore();
    }
  }
});
it('detects incomplete nuisance maximization even when coverage could remain conservative', () => {
  const original = methodModule.createConfidenceEvaluator;
  const spy = vi.spyOn(methodModule, 'createConfidenceEvaluator').mockImplementation((d, e) => {
    const real = original(d, e);
    return { ...real, envelopes: o => real.envelopes(o).map(x => ({ ...x, value: rational(1n), compatibleCount: x.compatibleCount ? 1 : 0 })) };
  });
  try {
    expect(calibrateEndpoint(confidenceDesigns()[0]!.design, domains[0]!, alphas).failures.some(x => x.startsWith('envelope:'))).toBe(true);
  } finally {
    spy.mockRestore();
  }
});
it('quality endpoint uses all assigned tasks including single-arm paths', () => {
  const result = calibrateEndpoint(confidenceDesigns()[3]!.design, domains[1]!, alphas);
  expect(result.failures).toEqual([]);
  expect(result.counts.truth_tables).toBe(16);
  const oracle = oracleCalibration(confidenceDesigns()[3]!.design, domains[1]!);
  expect(oracle.support.map(x => x.labels.join(''))).toEqual(['AA', 'AB', 'BA', 'BB']);
});
import { assessStudyCase } from '../scripts/analysis-validation/eligibility.js';
import { builtInCases } from '../scripts/analysis-validation/cases.js';
it('preserves synthetic completeness and mechanism gates before endpoint projection', () => {
  const source = builtInCases()[0]!;
  for (const usageCoverage of ['partial', 'missing', 'error', 'excluded', 'unmeasurable'])
    expect(assessStudyCase({ ...source, population: source.population.map(x => ({ ...x, usageCoverage })) }).status).toBe('rejected');
  for (const qualityState of ['pending', 'missing'])
    expect(assessStudyCase({ ...source, population: source.population.map(x => ({ ...x, qualityState })) }).status).toBe('rejected');
  for (const patch of [
    { origin: 'real' },
    { grouping: 'actual_only' },
    { enrollment: 'adaptive' },
    { history: 'carryover' },
    { truncation: 'outcome_dependent' },
    { metric: 'ratio' },
    { metric: 'criterion_fulfillment' }
  ])
    expect(assessStudyCase({ ...source, ...patch }).status).toBe('rejected');
});
it('detects skipped alpha coverage rather than accepting a reduced registry', () => {
  expect(calibrateEndpoint(confidenceDesigns()[0]!.design, domains[0]!, alphas.slice(1)).failures).toContain('alpha_registry');
});
it('rejects coupled schedules with surplus tasks or nonbinary quality before inference', () => {
  const d = confidenceDesigns()[0]!.design,
    h = { potentialA: [0], potentialB: [1] };
  expect(() => checkCoupledCoverage(d, { potentialA: [0, 0], potentialB: [1, 2] }, h, rational(1n, 20n))).toThrow('schedule_alignment');
  expect(() => checkCoupledCoverage(d, h, { potentialA: [0], potentialB: [2] }, rational(1n, 20n))).toThrow('invalid_outcomes');
});
import { EndpointEvidenceSchema } from '../scripts/analysis-validation/confidence-contracts.js';
import { evidenceJson } from '../scripts/analysis-validation/confidence-runner.js';
it('evidence boundary rejects unknown fields and noncanonical exact fractions', () => {
  const { cache, ...result } = calibrateEndpoint(confidenceDesigns()[0]!.design, domains[0]!, alphas);
  expect(cache.size).toBe(6);
  const valid = evidenceJson({ design_id: 'b2r1', ...result });
  expect(EndpointEvidenceSchema.safeParse(valid).success).toBe(true);
  expect(EndpointEvidenceSchema.safeParse({ ...(valid as object), source_content: 'forbidden' }).success).toBe(false);
  const bad = structuredClone(valid) as { summaries: { alpha: { numerator: string; denominator: string } }[] };
  bad.summaries[0]!.alpha = { numerator: '2', denominator: '80' };
  expect(EndpointEvidenceSchema.safeParse(bad).success).toBe(false);
});
import * as designModule from '../scripts/analysis-validation/design.js';
it('detects removed assignment paths and corrupted weights independently', () => {
  const original = designModule.enumerateDesign;
  for (const mutate of [
    (x: ReturnType<typeof original>) => x.slice(1),
    (x: ReturnType<typeof original>) => x.map(row => ({ ...row, weight: rational(1n, 3n) }))
  ]) {
    const spy = vi.spyOn(designModule, 'enumerateDesign').mockImplementation(d => mutate(original(d)));
    try {
      // Missing paths can also be rejected by observation-support validation.
      let detected = false;
      try {
        detected = calibrateEndpoint(confidenceDesigns()[0]!.design, domains[0]!, alphas).failures.includes('support_weights');
      } catch {
        detected = true;
      }
      expect(detected).toBe(true);
    } finally {
      spy.mockRestore();
    }
  }
});
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, cpSync, symlinkSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { confidenceProvenance, confidenceSourceFiles } from '../scripts/analysis-validation/confidence-runner.js';
it('rejects external confidence arguments before compiling', () => {
  for (const args of [['--data', 'private.db'], ['--alpha', '0.05'], ['--seed', '1'], ['--bound', '3'], ['--help']]) {
    const result = spawnSync(process.execPath, ['scripts/confidence-validation-command.mjs', ...args], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({ status: 'fail', failures: ['unknown_arguments'] });
  }
});
it('provenance binds oracle wrapper config and dependency closure without running a full study', () => {
  const root = mkdtempSync(join(tmpdir(), 'confidence-provenance-'));
  try {
    for (const path of confidenceSourceFiles) {
      const target = join(root, path);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(path, target);
    }
    symlinkSync(join(process.cwd(), 'node_modules'), join(root, 'node_modules'), 'dir');
    const compile = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'scripts/analysis-validation/confidence-tsconfig.json'], {
      cwd: root,
      encoding: 'utf8'
    });
    expect(compile.status, compile.stdout + compile.stderr).toBe(0);
    const probe = () => {
      const result = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          "import {confidenceProvenance} from './.harness-delta/confidence-validation-build/scripts/analysis-validation/confidence-runner.js'; console.log(JSON.stringify(confidenceProvenance()));"
        ],
        { cwd: root, encoding: 'utf8' }
      );
      expect(result.status, result.stderr).toBe(0);
      return JSON.parse(result.stdout) as ReturnType<typeof confidenceProvenance>;
    };
    const baseline = probe();
    expect(baseline).toEqual(confidenceProvenance());
    for (const path of [
      'tests/helpers/confidence-oracle.ts',
      'scripts/confidence-validation-command.mjs',
      'scripts/analysis-validation/confidence-tsconfig.json',
      'package.json'
    ]) {
      const file = join(root, path),
        before = readFileSync(file);
      writeFileSync(file, Buffer.concat([before, Buffer.from('\n ')]));
      expect(probe().source_sha256).not.toBe(baseline.source_sha256);
      writeFileSync(file, before);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
it('accounts for one observed-dataset lookup per truth/path reused across all alphas', () => {
  const result = calibrateEndpoint(confidenceDesigns()[0]!.design, domains[0]!, alphas);
  expect(result.counts.coverage_paths).toBe(18);
});
it('detects missing and duplicate target identities despite a superficially valid set', () => {
  const original = methodModule.createConfidenceEvaluator;
  for (const mutate of [
    (x: ReturnType<ReturnType<typeof original>['envelopes']>) => x.slice(1),
    (x: ReturnType<ReturnType<typeof original>['envelopes']>) => [x[0]!, ...x.slice(0, -1)]
  ]) {
    const spy = vi.spyOn(methodModule, 'createConfidenceEvaluator').mockImplementation((d, e) => {
      const real = original(d, e);
      return { ...real, envelopes: o => mutate(real.envelopes(o)) };
    });
    try {
      expect(calibrateEndpoint(confidenceDesigns()[0]!.design, domains[0]!, alphas).failures).toContain('observation_target_alpha_registry');
    } finally {
      spy.mockRestore();
    }
  }
});
import { referenceTail } from '../scripts/analysis-validation/statistics.js';
import { observationSchema } from '../scripts/analysis-validation/confidence-contracts.js';
it('fails oracle agreement when the candidate substitutes the v1 fixed-observation tail', () => {
  const original = methodModule.createConfidenceEvaluator,
    d = confidenceDesigns()[3]!.design;
  const spy = vi.spyOn(methodModule, 'createConfidenceEvaluator').mockImplementation((design, endpoint) => {
    const real = original(design, endpoint);
    return {
      ...real,
      envelopes: input => {
        const obs = observationSchema.parse(input),
          fixed = referenceTail(designModule.enumerateDesign(design), obs.values, obs.labels);
        return real.envelopes(obs).map(row => ({ ...row, value: row.compatibleCount ? fixed : rational(0n) }));
      }
    };
  });
  try {
    expect(calibrateEndpoint(d, domains[0]!, alphas).failures.some(x => x.startsWith('envelope:'))).toBe(true);
  } finally {
    spy.mockRestore();
  }
});
