import { access, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { runToolUpdate } from '../scripts/tool-update.mjs';
import { assessCandidate, consumedContracts } from '../scripts/tool-update/assessment.mjs';
import { mapRevision, requiredValidations } from '../scripts/tool-update/difference-contracts.mjs';
import { judgmentEngineDigest } from '../scripts/tool-update/difference-judgment.mjs';
import type { CurrentIdentities } from '../scripts/tool-update/difference-judgment.mjs';
import { differenceEvidenceSchema, differenceJobSchema, differenceJudgmentSchema } from '../scripts/tool-update/difference-records.mjs';
import { canonical, digest, loadRecord, publishRecord } from '../scripts/tool-update/manifest.mjs';
import { z } from 'zod';
import {
  auditedCli,
  cliFixture,
  judgmentFor,
  laneKey,
  projectRoot,
  publishJudgment,
  publishReviews,
  readAssessment,
  scratch,
  tree
} from './helpers/tool-update-difference-cli-fixture.js';
import type { BaselineMode, CliFixture } from './helpers/tool-update-difference-cli-fixture.js';
import { baseRef, targetRef } from './helpers/tool-update-difference-fixture.js';
import { sourceFixture } from './helpers/tool-update-source-fixture.js';

const roots: string[] = [];
let identities: CurrentIdentities;
beforeEach(() => {
  vi.stubGlobal('fetch', () => Promise.reject(new Error('unexpected_network')));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function setup(mode: BaselineMode = 'complete', target = targetRef.version) {
  const root = await scratch();
  roots.push(root);
  return cliFixture(root, identities, mode, target);
}
beforeAll(async () => {
  const root = await scratch();
  roots.push(root);
  const seed = await cliFixture(
    root,
    {
      source_digest: 'a'.repeat(64),
      engine_digest: await judgmentEngineDigest(projectRoot),
      map_revision: mapRevision
    },
    'missing'
  );
  const plain = await assessCandidate({
    candidate: seed.candidate,
    observation: seed.observation,
    root: projectRoot
  });
  identities = {
    source_digest: plain.source_digest,
    engine_digest: await judgmentEngineDigest(projectRoot),
    map_revision: mapRevision
  };
}, 60_000);
async function assess(input: CliFixture, paths: readonly string[], extra: readonly string[] = []) {
  const result = await runToolUpdate(['assess', ...input.inputArgs, ...extra, ...paths.flatMap(path => ['--judgment', path]), '--out', input.root]);
  expect(result.exitCode, JSON.stringify(result.output)).toBe(0);
  expect(result.output.status).toBe('assessment_created');
  return readAssessment(input.root, result.output.assessment_id);
}
function automated(record: Awaited<ReturnType<typeof readAssessment>>['record']) {
  if (record.schema_version !== 9 || record.judgment_ids === undefined) {
    throw new Error('machine_schema_9_required');
  }
  const selected = record.lanes.find(row => row.profile_id === laneKey.profile_id && row.operation === laneKey.operation);
  if (!selected) throw new Error('fixture_lane_required');
  return selected.automated;
}

test('difference-job derives parser identity from the code-owned lane and pinned observation', async () => {
  const input = await setup();
  const before = await readFile(input.baselinePath);
  const result = await runToolUpdate([
    'difference-job',
    ...input.inputArgs,
    '--route',
    laneKey.route,
    '--profile',
    laneKey.profile_id,
    '--operation',
    laneKey.operation,
    '--topology',
    laneKey.topology,
    '--out',
    input.root
  ]);
  expect(result.exitCode).toBe(0);
  expect(result.output.status).toBe('difference_job_created');
  expect(result.output.job_id).toMatch(/^[a-f0-9]{64}$/);
  const names = await readdir(join(input.root, 'difference-jobs'));
  const jobs = await Promise.all(names.map(name => loadRecord(join(input.root, 'difference-jobs', name), differenceJobSchema)));
  expect(jobs.find(job => digest(job) === result.output.job_id)).toMatchObject({
    candidate_id: digest(input.candidate),
    observation_id: digest(input.observation),
    lane: laneKey,
    source_digest: identities.source_digest,
    engine_digest: identities.engine_digest,
    parser_base: { ...baseRef, profile_id: laneKey.profile_id },
    target: targetRef
  });
  expect(await readFile(input.baselinePath)).toEqual(before);
});

test('difference-job never invents a missing parser-base commit', async () => {
  const input = await setup('missing');
  const result = await runToolUpdate([
    'difference-job',
    ...input.inputArgs,
    '--route',
    laneKey.route,
    '--profile',
    laneKey.profile_id,
    '--operation',
    laneKey.operation,
    '--topology',
    laneKey.topology,
    '--out',
    input.root
  ]);
  expect(result.exitCode).toBe(0);
  expect(result.output.status).toBe('difference_job_created');
  const names = await readdir(join(input.root, 'difference-jobs'));
  const jobs = await Promise.all(names.map(name => loadRecord(join(input.root, 'difference-jobs', name), differenceJobSchema)));
  expect(jobs.every(job => job.parser_base === null)).toBe(true);
});

test('the collector publishes bounded injected public evidence with fixed output', async () => {
  const input = await setup();
  const wire = sourceFixture({ job: input.job, etag: true });
  const fetchImpl: typeof fetch = (request, init) => wire.fetchImpl(String(request instanceof Request ? request.url : request), init ?? {});
  const result = await runToolUpdate(['collect-difference-evidence', '--job', input.jobPath, '--out', input.root], { fetchImpl });
  const names = await readdir(join(input.root, 'difference-evidence'));
  expect(result).toEqual({
    exitCode: 0,
    output: {
      status: 'difference_evidence_created',
      evidence_ids: names.map(name => name.replace('.json', '')).sort(),
      failure: null
    }
  });
  expect(names).toHaveLength(6);
  expect(wire.calls.every(call => call.url.hostname === 'api.github.com')).toBe(true);
  expect(wire.calls.length).toBeLessThanOrEqual(128);
  const records = await Promise.all(names.map(name => readFile(join(input.root, 'difference-evidence', name), 'utf8')));
  expect(records.join('')).not.toContain('SYNTHETIC_PRIVATE_MATERIAL');
  const evidence = await Promise.all(names.map(name => loadRecord(join(input.root, 'difference-evidence', name), differenceEvidenceSchema)));
  const judged = await runToolUpdate([
    'judge',
    '--job',
    input.jobPath,
    ...names.flatMap(name => ['--evidence', join(input.root, 'difference-evidence', name)]),
    '--out',
    input.root
  ]);
  expect(judged.exitCode, JSON.stringify(judged.output)).toBe(0);
  const judgment = await loadRecord(join(input.root, 'difference-judgments', `${judged.output.judgment_id}.json`), differenceJudgmentSchema);
  expect(judgment.evidence_ids).toEqual(evidence.map(record => digest(record)).sort());
  expect(judgment.groups.find(group => group.contract_id === 'fields_types_enums')?.result).toBe('unaffected');
});

test('denied collector network returns a fixed failure instead of a successful packet', async () => {
  const input = await setup();
  const denied = vi.fn(() => Promise.reject(new Error('SYNTHETIC_SECRET /private/session')));
  const result = await runToolUpdate(['collect-difference-evidence', '--job', input.jobPath, '--out', input.root], { fetchImpl: denied });
  expect(denied).toHaveBeenCalled();
  expect(result.exitCode).toBe(2);
  expect(result.output.status).toBe('difference_evidence_created');
  expect(result.output.failure).toBe('source_fetch_failed');
  expect(Array.isArray(result.output.evidence_ids)).toBe(true);
  expect(JSON.stringify(result)).not.toContain('SYNTHETIC_SECRET');
});

test('judge without evidence publishes unknown groups and replay preserves one immutable judgment', async () => {
  const input = await setup();
  const args = ['judge', '--job', input.jobPath, '--out', input.root];
  const result = await runToolUpdate(args);
  expect(result.exitCode).toBe(0);
  expect(result.output.status).toBe('difference_judgment_created');
  expect(result.output.judgment_id).toMatch(/^[a-f0-9]{64}$/);
  const names = await readdir(join(input.root, 'difference-judgments'));
  expect(names).toHaveLength(1);
  const record = await loadRecord(join(input.root, 'difference-judgments', names[0] ?? ''), differenceJudgmentSchema);
  expect(record.groups.map(group => group.result)).toEqual(consumedContracts.map(() => 'unknown'));
  expect(record.evidence_ids).toEqual([]);
  expect(record.job_id).toBe(digest(input.job));
  expect(record.candidate_id).toBe(digest(input.candidate));
  const before = await tree(input.root);
  expect(await runToolUpdate(args)).toEqual(result);
  expect(await tree(input.root)).toEqual(before);
});

test('stale-source judgment publishes an unknown assessment', async () => {
  const input = await setup();
  const judgment = await publishJudgment(input, {
    ...judgmentFor(input),
    source_digest: '0'.repeat(64)
  });
  const { record } = await assess(input, [judgment.path]);
  const machine = automated(record);
  expect(machine.freshness_reasons).toEqual(['stale_source']);
  expect(machine.contracts).toEqual(
    consumedContracts.map(contract_id => ({
      contract_id,
      judgment: 'unknown'
    }))
  );
  expect(record.lanes.every(row => row.gates.contracts_reviewed === 'unknown' && row.gates.admission === 'not_assessed')).toBe(true);
});

test.each([
  ['engine_digest', '0'.repeat(64), 'stale_engine'],
  ['map_revision', 'difference-map-v1', 'stale_map']
] as const)('stale %s publishes unknown machine results with %s', async (field, value, reason) => {
  const input = await setup();
  const judgment = await publishJudgment(
    input,
    differenceJudgmentSchema.parse({
      ...judgmentFor(input),
      [field]: value
    })
  );
  const { record } = await assess(input, [judgment.path]);
  expect(automated(record).freshness_reasons).toEqual([reason]);
  expect(automated(record).contracts.every(row => row.judgment === 'unknown')).toBe(true);
});

test('cross-lane judgment is rejected without publishing', async () => {
  const input = await setup();
  const original = judgmentFor(input);
  const lane = { ...original.lane, operation: 'restart' as const };
  const judgment = await publishJudgment(input, {
    ...original,
    lane,
    baseline_row: original.baseline_row ? { ...original.baseline_row, ...lane } : null
  });
  const before = await tree(input.root);
  expect(await runToolUpdate(['assess', ...input.inputArgs, '--judgment', judgment.path, '--out', input.root])).toEqual({
    exitCode: 2,
    output: { status: 'difference_identity_mismatch' }
  });
  expect(await tree(input.root)).toEqual(before);
});

test.each(['candidate', 'observation', 'job', 'commit'] as const)('cross-%s judgment is rejected without publishing', async kind => {
  const input = await setup();
  const original = judgmentFor(input);
  const differentCommit = { ...original.target, commit: '9'.repeat(40) };
  const alternateLane = {
    ...input.job.lane,
    operation: 'restart' as const
  };
  const alternateJobId = await publishRecord(
    input.root,
    {
      ...input.job,
      lane: alternateLane,
      baseline_row: input.job.baseline_row ? { ...input.job.baseline_row, ...alternateLane } : null
    },
    differenceJobSchema
  );
  const changes = {
    candidate: {
      candidate_id: '9'.repeat(64),
      observation_candidate_id: '9'.repeat(64)
    },
    observation: { observation_id: '9'.repeat(64) },
    job: { job_id: alternateJobId },
    commit: {
      target: differentCommit,
      comparison: original.comparison ? { ...original.comparison, to: differentCommit } : null,
      inventory: {
        ...original.inventory,
        releases: original.inventory.releases.map(ref => (ref.version === original.target.version ? differentCommit : ref))
      },
      comparisons: original.comparisons.map(comparison => ({
        ...comparison,
        to: comparison.to.version === original.target.version ? differentCommit : comparison.to
      }))
    }
  };
  const judgment = await publishJudgment(input, differenceJudgmentSchema.parse({ ...original, ...changes[kind] }));
  const before = await tree(input.root);
  expect(await runToolUpdate(['assess', ...input.inputArgs, '--judgment', judgment.path, '--out', input.root])).toEqual({
    exitCode: 2,
    output: { status: 'difference_identity_mismatch' }
  });
  expect(await tree(input.root)).toEqual(before);
});

test('known machine claims preserve every static gate including the outside-window selection', async () => {
  const input = await setup('complete', '0.170.0');
  const plain = await assessCandidate({
    candidate: input.candidate,
    observation: input.observation,
    baseline: input.baseline,
    root: projectRoot
  });
  const judgment = await publishJudgment(input);
  const { record } = await assess(input, [judgment.path, judgment.path]);
  if (record.schema_version !== 9 || record.judgment_ids === undefined) {
    throw new Error('machine_schema_9_required');
  }
  expect(record.judgment_ids).toEqual([judgment.id]);
  expect(record.unused_judgment_ids).toEqual([]);
  expect(record.review_ids).toEqual([]);
  expect(record.unused_review_ids).toEqual([]);
  expect(
    record.lanes.map(({ automated: machine, ...lane }) => {
      expect(machine.validation).toBe('pending');
      return lane;
    })
  ).toEqual(plain.lanes);
  const selected = record.lanes.find(row => row.profile_id === laneKey.profile_id && row.operation === laneKey.operation);
  expect(selected?.static_selection).toBe('unsupported');
  expect(selected?.reasons).toContain('upper_bound');
  expect(automated(record).contracts).toContainEqual({
    contract_id: 'fields_types_enums',
    judgment: 'unaffected'
  });
  expect(automated(record).comparisons.every(row => row.result_scope === 'job_aggregate')).toBe(true);
  expect(automated(record).required_validation.every(code => requiredValidations.includes(code))).toBe(true);
  expect(automated(record).required_validation).toContain('real_session');
});

test.each(['missing', 'equal', 'incomplete'] as const)('%s coverage keeps judgments visible but unused and pending', async mode => {
  const input = await setup(mode);
  const judgment = await publishJudgment(input);
  const { record } = await assess(input, [judgment.path]);
  if (record.schema_version !== 9 || record.judgment_ids === undefined) throw new Error('machine_schema_9_required');
  expect(record.unused_judgment_ids).toEqual([judgment.id]);
  expect(automated(record).judgment_ids).toEqual([judgment.id]);
  expect(automated(record).pending_reasons).toContain(
    {
      missing: 'baseline_missing',
      equal: 'equal_target',
      incomplete: 'parser_chain_incomplete'
    }[mode]
  );
  expect(automated(record).validation).toBe('pending');
});

test('multiple lanes sort supplied and unused judgment IDs while retaining missing-lane requirements', async () => {
  const input = await setup();
  const first = await publishJudgment(input);
  const lane = { ...input.job.lane, operation: 'restart' as const };
  const job = {
    ...input.job,
    lane,
    baseline_row: null,
    baseline_digest: null,
    comparison: {
      comparison_kind: 'parser_base' as const,
      from: baseRef,
      to: input.job.target
    },
    reasons: ['baseline_missing'] as const
  };
  await publishRecord(input.root, job, differenceJobSchema);
  const second = await publishJudgment(input, judgmentFor({ ...input, job }));
  const { record } = await assess(input, [second.path, first.path, second.path]);
  if (record.schema_version !== 9 || record.judgment_ids === undefined) {
    throw new Error('machine_schema_9_required');
  }
  expect(record.judgment_ids).toEqual([first.id, second.id].sort());
  expect(record.unused_judgment_ids).toEqual([second.id]);
  const restart = record.lanes.find(row => row.profile_id === laneKey.profile_id && row.operation === 'restart');
  expect(restart?.automated.judgment_ids).toEqual([second.id]);
  expect(restart?.automated.pending_reasons).toContain('baseline_missing');
  const link = record.lanes.find(row => row.profile_id === laneKey.profile_id && row.operation === 'link');
  expect(link?.automated.judgment_ids).toEqual([]);
  expect(link?.automated.pending_reasons).toEqual(['judgment_missing']);
});

test.each(['unaffected', 'unknown'] as const)('manual %s claims remain separate from affected machine claims', async manual => {
  const input = await setup();
  const reviews = await publishReviews(input, manual);
  const judgment = await publishJudgment(input, judgmentFor(input, true));
  const plain = await assessCandidate({
    candidate: input.candidate,
    observation: input.observation,
    baseline: input.baseline,
    reviews: reviews.records,
    root: projectRoot
  });
  const { record } = await assess(input, [judgment.path], reviews.args);
  if (record.schema_version !== 9 || record.judgment_ids === undefined) {
    throw new Error('machine_schema_9_required');
  }
  expect(record.review_ids).toEqual(reviews.ids);
  expect(
    record.lanes.map(({ automated: machine, ...lane }) => {
      expect(machine.validation).toBe('pending');
      return lane;
    })
  ).toEqual(plain.lanes);
  const conflicts = automated(record).conflicts;
  expect(conflicts).toEqual(
    manual === 'unknown'
      ? []
      : reviews.records.map(review => ({
          review_id: digest(review),
          judgment_id: judgment.id,
          contract_id: 'fields_types_enums',
          manual_judgment: 'unaffected',
          automated_judgment: 'affected',
          comparison_kind: 'adjacent_release',
          from: review.from,
          to: review.to
        }))
  );
});

test('identical judgment replay deduplicates while conflicting decisions for one job reject atomically', async () => {
  const input = await setup();
  const first = await publishJudgment(input);
  const conflict = await publishJudgment(input, judgmentFor(input, true));
  const before = await tree(input.root);
  const result = await runToolUpdate(['assess', ...input.inputArgs, '--judgment', first.path, '--judgment', conflict.path, '--out', input.root]);
  expect(result).toEqual({
    exitCode: 2,
    output: { status: 'difference_judgment_conflict' }
  });
  expect(await tree(input.root)).toEqual(before);
});

test('a job-scoped affected claim does not contradict one unchanged edge without complete manual coverage', async () => {
  const input = await setup();
  const reviews = await publishReviews(input);
  const review = reviews.records[0];
  if (!review) throw new Error('fixture_review_required');
  const judgment = await publishJudgment(input, judgmentFor(input, true));
  const { record } = await assess(input, [judgment.path], ['--review', join(input.root, 'reviews', `${digest(review)}.json`)]);
  expect(automated(record).conflicts).toEqual([]);
  expect(automated(record).contracts).toContainEqual({
    contract_id: 'fields_types_enums',
    judgment: 'affected'
  });
  expect(record.lanes.find(row => row.profile_id === laneKey.profile_id && row.operation === laneKey.operation)?.gates.contracts_reviewed).toBe('unknown');
});

test.each([
  { schema_version: 2 },
  { engine_revision: 'difference-engine-v99' },
  { map_revision: 'difference-map-v99' },
  { contract_revision: 'consumed-v99' },
  { secret: 'SYNTHETIC_SECRET /private/session' }
])('malformed or unsupported judgment fields reject without publishing: %j', async change => {
  const input = await setup();
  const path = join(input.root, 'invalid.json');
  await writeFile(path, JSON.stringify({ ...judgmentFor(input), ...change }));
  const before = await tree(input.root);
  expect(await runToolUpdate(['assess', ...input.inputArgs, '--judgment', path, '--out', input.root])).toEqual({
    exitCode: 2,
    output: { status: 'invalid_record' }
  });
  expect(await tree(input.root)).toEqual(before);
});

test.each([false, true])('without judgments manual=%s replay retains canonical current-writer bytes', async withReviews => {
  const input = await setup();
  const reviews = withReviews ? await publishReviews(input) : null;
  const legacy = await assessCandidate({
    candidate: input.candidate,
    observation: input.observation,
    baseline: input.baseline,
    reviews: reviews?.records ?? null,
    root: projectRoot
  });
  const { bytes, record } = await assess(input, [], reviews?.args ?? []);
  expect(record.schema_version).toBe(9);
  expect(bytes).toBe(canonical(legacy));
  const judgment = await publishJudgment(input);
  await assess(input, [judgment.path], reviews?.args ?? []);
  expect((await assess(input, [], reviews?.args ?? [])).bytes).toBe(bytes);
});

const effectLedger = z.strictObject({
  network: z.number(),
  processes: z.number(),
  modules: z.number(),
  privateReads: z.number(),
  writes: z.array(z.string())
});
function assertEffects(ledger: unknown, output: string, temporary: string, expectedNetwork: 0 | 'denied' = 0) {
  const { writes, network, ...effects } = effectLedger.parse(ledger);
  expect(effects).toEqual({ processes: 0, modules: 0, privateReads: 0 });
  if (expectedNetwork === 'denied') expect(network).toBeGreaterThan(0);
  else expect(network).toBe(0);
  expect(writes.some(path => path.startsWith(`${output}/`))).toBe(true);
  for (const path of writes) {
    expect(
      [output, temporary].some(root => {
        const rel = relative(root, path);
        return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
      }),
      path
    ).toBe(true);
  }
}
test('the effect ledger traps denied network, process, Store and private filesystem probes', async () => {
  const input = await setup();
  const control = await auditedCli(input.root, '-e', [
    `
const probes=[
 ()=>fetch('https://synthetic.invalid'),
 ()=>require('node:child_process').execFileSync('synthetic-vendor'),
 ()=>import('better-sqlite3'),
 ()=>require('node:fs').readFileSync(process.env.HOME+'/synthetic.json')
];
(async()=>{
 for(const probe of probes){
  try {await probe();throw new Error('probe_not_denied');}
  catch(error){if(!error.message.startsWith('forbidden_'))throw error;}
 }
 process.stdout.write(JSON.stringify({status:'probes_denied'})+'\\n');
})();
`
  ]);
  expect(control.exitCode, control.stdout + control.stderr).toBe(0);
  expect(control.output).toEqual({ status: 'probes_denied' });
  expect(control.ledger).toEqual({
    network: 1,
    processes: 1,
    modules: 1,
    privateReads: 1,
    writes: []
  });
});
test.each([
  ['node:sqlite', 'import'],
  ['node:sqlite', 'require'],
  ['sqlite', 'import'],
  ['sqlite', 'require']
] as const)('the effect ledger calibration denies %s through %s before a synthetic database operation', async (specifier, mode) => {
  const root = await scratch();
  roots.push(root);
  const control = await auditedCli(root, '-e', [
    `
(async()=>{
 try {
  const {DatabaseSync}=${mode === 'import' ? `await import(${JSON.stringify(specifier)})` : `require(${JSON.stringify(specifier)})`};
  const database=new DatabaseSync(':memory:');
  database.exec('CREATE TABLE synthetic_probe (value INTEGER)');
  database.close();
  process.stdout.write(JSON.stringify({status:'mutation_completed'})+'\\n');
 } catch(error) {
  process.stdout.write(JSON.stringify({status:'mutation_denied',reason:error.message})+'\\n');
 }
})();
`
  ]);
  expect(control.exitCode, control.stdout + control.stderr).toBe(0);
  expect(control.ledger, JSON.stringify(control.output)).toEqual({
    network: 0,
    processes: 0,
    modules: 1,
    privateReads: 0,
    writes: []
  });
  expect(control.output).toEqual({
    status: 'mutation_denied',
    reason: 'forbidden_modules'
  });
});
test('the real source CLI in a built checkout publishes only records without Store, vendor, sessions, network or block writes', async () => {
  await access(join(projectRoot, 'dist', 'index.js'));
  const script = 'scripts/tool-update.mjs';
  const input = await setup();
  const judgment = await publishJudgment(input, judgmentFor(input, true));
  const baselineBefore = await readFile(input.baselinePath);
  const sourceBefore = await tree(join(projectRoot, 'scripts', 'tool-update'));
  const judgeRoot = join(input.root, 'judge-output');
  const judged = await auditedCli(input.root, join(projectRoot, script), ['judge', '--job', input.jobPath, '--out', judgeRoot]);
  expect(judged.exitCode, judged.stdout + judged.stderr).toBe(0);
  const judgeOutput = z
    .strictObject({
      status: z.literal('difference_judgment_created'),
      judgment_id: z.string().regex(/^[a-f0-9]{64}$/)
    })
    .parse(judged.output);
  expect(await readdir(join(judgeRoot, 'difference-judgments'))).toEqual([`${judgeOutput.judgment_id}.json`]);
  expect(judged.stderr).toBe('');
  assertEffects(judged.ledger, judgeRoot, judged.temporary);
  expect(await readdir(judgeRoot)).toEqual(['difference-judgments']);
  const output = join(input.root, 'assessment-output');
  const assessed = await auditedCli(input.root, join(projectRoot, script), ['assess', ...input.inputArgs, '--judgment', judgment.path, '--out', output]);
  expect(assessed.exitCode, assessed.stdout + assessed.stderr).toBe(0);
  const assessmentOutput = z
    .strictObject({
      status: z.literal('assessment_created'),
      assessment_id: z.string().regex(/^[a-f0-9]{64}$/)
    })
    .parse(assessed.output);
  const { record } = await readAssessment(output, assessmentOutput.assessment_id);
  expect(automated(record).contracts).toContainEqual({
    contract_id: 'fields_types_enums',
    judgment: 'affected'
  });
  expect(assessed.stderr).toBe('');
  assertEffects(assessed.ledger, output, assessed.temporary);
  expect(await readdir(output)).toEqual(['assessments']);
  expect(await readdir(assessed.home)).toEqual([]);
  expect(await readdir(assessed.temporary)).toEqual([]);
  expect(await readFile(input.baselinePath)).toEqual(baselineBefore);
  expect(await tree(join(projectRoot, 'scripts', 'tool-update'))).toEqual(sourceBefore);
}, 120_000);

test('the real difference-job CLI is offline and writes only its selected job record root', async () => {
  const input = await setup();
  const output = join(input.root, 'job-output');
  const baselineBefore = await readFile(input.baselinePath);
  const result = await auditedCli(input.root, join(projectRoot, 'scripts/tool-update.mjs'), [
    'difference-job',
    ...input.inputArgs,
    '--route',
    laneKey.route,
    '--profile',
    laneKey.profile_id,
    '--operation',
    laneKey.operation,
    '--topology',
    laneKey.topology,
    '--out',
    output
  ]);
  expect(result.exitCode, result.stdout + result.stderr).toBe(0);
  expect(result.stderr).toBe('');
  const published = z
    .strictObject({
      status: z.literal('difference_job_created'),
      job_id: z.string().regex(/^[a-f0-9]{64}$/)
    })
    .parse(result.output);
  expect(await readdir(output)).toEqual(['difference-jobs']);
  expect(await readdir(join(output, 'difference-jobs'))).toEqual([`${published.job_id}.json`]);
  const job = await loadRecord(join(output, 'difference-jobs', `${published.job_id}.json`), differenceJobSchema);
  expect(job.candidate_id).toBe(digest(input.candidate));
  expect(job.observation_id).toBe(digest(input.observation));
  expect(job.parser_base).toEqual({
    ...baseRef,
    profile_id: laneKey.profile_id
  });
  assertEffects(result.ledger, output, result.temporary);
  expect(await readdir(result.home)).toEqual([]);
  expect(await readdir(result.temporary)).toEqual([]);
  expect(await readFile(input.baselinePath)).toEqual(baselineBefore);
}, 60_000);

test('the real collector CLI records denied network with no Store, process, private reads or unrequested writes', async () => {
  const input = await setup();
  const output = join(input.root, 'evidence-output');
  const baselineBefore = await readFile(input.baselinePath);
  const result = await auditedCli(input.root, join(projectRoot, 'scripts/tool-update.mjs'), [
    'collect-difference-evidence',
    '--job',
    input.jobPath,
    '--out',
    output
  ]);
  expect(result.exitCode, result.stdout + result.stderr).toBe(2);
  expect(result.stderr).toBe('');
  const published = z
    .strictObject({
      status: z.literal('difference_evidence_created'),
      evidence_ids: z.array(z.string().regex(/^[a-f0-9]{64}$/)),
      failure: z.literal('source_fetch_failed')
    })
    .parse(result.output);
  expect(await readdir(output)).toEqual(['difference-evidence']);
  expect(await readdir(join(output, 'difference-evidence'))).toEqual(published.evidence_ids.map(id => `${id}.json`));
  assertEffects(result.ledger, output, result.temporary, 'denied');
  expect(await readdir(result.home)).toEqual([]);
  expect(await readdir(result.temporary)).toEqual([]);
  expect(await readFile(input.baselinePath)).toEqual(baselineBefore);
}, 60_000);

test('an impossible all-eight-unaffected judgment is rejected without changing static gates or published bytes', async () => {
  const input = await setup();
  const plain = await assess(input, []);
  const judgment = await publishJudgment(input);
  const impossible = {
    ...judgment.record,
    groups: judgment.record.groups.map(group => ({
      ...group,
      result: 'unaffected',
      facets: group.facets.map(facet => ({
        ...facet,
        result: 'unaffected',
        methods: ['codex_source_identity'],
        evidence_ids: judgment.record.evidence_ids,
        reasons: ['established_unchanged']
      })),
      impacts: ['none_established'],
      required_validation: [],
      variant_requirement: 'none_established',
      eligibility_recommendation: 'ready_for_scoped_review'
    }))
  };
  expect(differenceJudgmentSchema.safeParse(impossible).success).toBe(false);
  const path = join(input.root, 'difference-judgments', `${digest(impossible)}.json`);
  await writeFile(path, canonical(impossible));
  const before = await tree(input.root);
  expect(await runToolUpdate(['assess', ...input.inputArgs, '--judgment', path, '--out', input.root])).toEqual({
    exitCode: 2,
    output: { status: 'invalid_record' }
  });
  expect(await tree(input.root)).toEqual(before);
  const replay = await assess(input, []);
  expect(replay.bytes).toBe(plain.bytes);
  expect(replay.record.lanes.map(lane => lane.gates)).toEqual(plain.record.lanes.map(lane => lane.gates));
});
