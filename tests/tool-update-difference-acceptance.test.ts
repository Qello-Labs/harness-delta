import { copyFile, cp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { afterEach, beforeAll, expect, test } from 'vitest';
import { z } from 'zod';
import { consumedContracts } from '../scripts/tool-update/assessment.mjs';
import { engineFiles, mapRevision } from '../scripts/tool-update/difference-contracts.mjs';
import { judgmentEngineDigest } from '../scripts/tool-update/difference-judgment.mjs';
import type { CurrentIdentities } from '../scripts/tool-update/difference-judgment.mjs';
import { differenceEvidenceSchema, differenceJobSchema, differenceJudgmentSchema } from '../scripts/tool-update/difference-records.mjs';
import type { DifferenceEvidence } from '../scripts/tool-update/difference-records.mjs';
import { collectClaudeDocumentationEvidence, collectCodexSourceEvidence } from '../scripts/tool-update/difference-source.mjs';
import { candidateSchema, observationSchema } from '../scripts/tool-update/discovery.mjs';
import type { Candidate, Observation } from '../scripts/tool-update/discovery.mjs';
import { canonical, digest, loadRecord, publishRecord } from '../scripts/tool-update/manifest.mjs';
import type { Baseline } from '../scripts/tool-update/manifest.mjs';
import { sourcePathAllowlist, withSourceSnapshot } from '../scripts/tool-update/source-snapshot.mjs';
import { claudeJob, documentationWire, privateMarker } from './helpers/tool-update-claude-evidence-fixture.js';
import { auditedCli, projectRoot, readAssessment, scratch, tree } from './helpers/tool-update-difference-cli-fixture.js';
import type { TransportResponse } from './helpers/tool-update-difference-cli-fixture.js';
import { differenceJob } from './helpers/tool-update-difference-fixture.js';
import { sourceFixture, sourcePrivateText } from './helpers/tool-update-source-fixture.js';

const roots: string[] = [];
let identities: CurrentIdentities;
beforeAll(async () => {
  const snapshot = await withSourceSnapshot(projectRoot, () => null);
  identities = {
    source_digest: snapshot.source_digest,
    engine_digest: await judgmentEngineDigest(projectRoot),
    map_revision: mapRevision
  };
}, 60_000);
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function temporary() {
  const root = await scratch();
  roots.push(root);
  return root;
}
async function metadata(product: 'codex' | 'claude_code', targetVersion?: string) {
  const root = await temporary();
  const seed = product === 'codex' ? differenceJob() : claudeJob();
  const releases = seed.inventory.releases.map((ref, index) => ({
    ...ref,
    version: index === seed.inventory.releases.length - 1 && targetVersion ? targetVersion : ref.version,
    release_id: index + 1,
    tag: `${product === 'codex' ? 'rust-v' : 'v'}${index === seed.inventory.releases.length - 1 && targetVersion ? targetVersion : ref.version}`,
    npm_integrity: `sha512-${Buffer.alloc(64, index + 1).toString('base64')}`
  }));
  const last = releases.at(-1);
  if (!last || !seed.baseline_row) {
    throw new Error('synthetic_release_required');
  }
  const { version, ...release } = last;
  const candidate: Candidate = {
    schema_version: 1,
    kind: 'candidate',
    product,
    target: version,
    ...release
  };
  const observation: Observation = {
    schema_version: 1,
    kind: 'observation',
    product,
    checked_at: '2026-11-07T00:00:00.000Z',
    result: 'metadata_reconciled',
    reasons: [],
    heads: { github: version, npm_latest: version, npm_stable: version },
    checks: [],
    releases,
    candidate_id: digest(candidate)
  };
  const baseline: Baseline = {
    schema_version: 1,
    kind: 'baseline',
    rows: [
      {
        ...seed.lane,
        last_reviewed_version: seed.baseline_row.ref.version,
        contract_revision: 'consumed-v1',
        evidence_ids: ['f'.repeat(64)],
        source_digest: identities.source_digest
      }
    ]
  };
  const candidateId = await publishRecord(root, candidate, candidateSchema);
  const observationId = await publishRecord(root, observation, observationSchema);
  const baselinePath = join(root, 'baseline.json');
  await writeFile(baselinePath, canonical(baseline));
  const inputArgs = [
    '--manifest',
    join(root, 'candidates', `${candidateId}.json`),
    '--observation',
    join(root, 'observations', `${observationId}.json`),
    '--baseline',
    baselinePath
  ];
  const records = join(root, 'records');
  return { root, records, inputArgs, lane: seed.lane, baselinePath };
}
const statusSchema = z.object({ status: z.string() }).catchall(z.unknown());
const effectsSchema = z.strictObject({
  network: z.number(),
  processes: z.number(),
  modules: z.number(),
  privateReads: z.number(),
  writes: z.array(z.string())
});
async function command(
  input: Awaited<ReturnType<typeof metadata>>,
  args: readonly string[],
  transport?: readonly TransportResponse[],
  sourceRoot = projectRoot
) {
  const result = await auditedCli(input.root, join(sourceRoot, 'scripts/tool-update.mjs'), [...args, '--out', input.records], transport);
  expect(result.exitCode, result.stdout + result.stderr).toBe(0);
  expect(result.stderr).toBe('');
  const effects = effectsSchema.parse(result.ledger);
  expect({
    processes: effects.processes,
    modules: effects.modules,
    privateReads: effects.privateReads
  }).toEqual({ processes: 0, modules: 0, privateReads: 0 });
  expect(effects.network).toBe(transport?.length ?? 0);
  expect(effects.writes.some(path => path.startsWith(`${input.records}/`))).toBe(true);
  for (const path of effects.writes) {
    expect(
      [input.records, result.temporary].some(root => {
        const rel = relative(root, path);
        return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
      }),
      path
    ).toBe(true);
  }
  expect(await readdir(result.home)).toEqual([]);
  expect(await readdir(result.temporary)).toEqual([]);
  return statusSchema.parse(result.output);
}
async function createJob(input: Awaited<ReturnType<typeof metadata>>) {
  const lane = input.lane;
  const result = await command(input, [
    'difference-job',
    ...input.inputArgs,
    '--route',
    lane.route,
    '--profile',
    lane.profile_id,
    '--operation',
    lane.operation,
    '--topology',
    lane.topology
  ]);
  expect(result.status).toBe('difference_job_created');
  const id = z.string().parse(result.job_id);
  const path = join(input.records, 'difference-jobs', `${id}.json`);
  return { path, record: await loadRecord(path, differenceJobSchema) };
}
async function collect(input: Awaited<ReturnType<typeof metadata>>, job: Awaited<ReturnType<typeof createJob>>) {
  const wire = job.record.lane.product === 'codex' ? sourceFixture({ job: job.record }) : documentationWire();
  const transport: TransportResponse[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    const response = await wire.fetchImpl(url, init);
    transport.push({
      url,
      status: response.status,
      headers: [...response.headers.entries()],
      body: await response.clone().text()
    });
    return response;
  };
  const collector = job.record.lane.product === 'codex' ? collectCodexSourceEvidence : collectClaudeDocumentationEvidence;
  const prepared = await collector(job.record, { fetch: fetchImpl });
  expect(prepared.failure).toBeNull();
  const result = await command(input, ['collect-difference-evidence', '--job', job.path], transport);
  expect(result.status).toBe('difference_evidence_created');
  expect(result.failure).toBeNull();
  const ids = z.array(z.string()).parse(result.evidence_ids);
  const paths = ids.map(id => join(input.records, 'difference-evidence', `${id}.json`));
  return {
    paths,
    records: await Promise.all(paths.map(path => loadRecord(path, differenceEvidenceSchema)))
  };
}
async function judge(input: Awaited<ReturnType<typeof metadata>>, jobPath: string, paths: readonly string[], sourceRoot = projectRoot) {
  const result = await command(input, ['judge', '--job', jobPath, ...paths.flatMap(path => ['--evidence', path])], undefined, sourceRoot);
  expect(result.status).toBe('difference_judgment_created');
  const path = join(input.records, 'difference-judgments', `${z.string().parse(result.judgment_id)}.json`);
  return { path, record: await loadRecord(path, differenceJudgmentSchema) };
}
async function assess(input: Awaited<ReturnType<typeof metadata>>, judgmentPath?: string, sourceRoot = projectRoot) {
  const result = await command(input, ['assess', ...input.inputArgs, ...(judgmentPath ? ['--judgment', judgmentPath] : [])], undefined, sourceRoot);
  expect(result.status).toBe('assessment_created');
  return readAssessment(input.records, z.string().parse(result.assessment_id));
}

test.each(['codex', 'claude_code'] as const)(
  'the audited %s CLI pipeline preserves records, frozen coverage and static gates',
  async product => {
    const input = await metadata(product);
    const history = await assess(input);
    const frozenPath = join(input.root, 'frozen-state.json');
    await writeFile(
      frozenPath,
      canonical({
        task: { topology: 'root', max_depth: 0, max_members: 1 },
        segment: {
          children: 'unobserved',
          usage: null,
          cost: null,
          completeness: 'unknown'
        }
      })
    );
    const before = (await tree(input.root)).filter(([path]) => !['audit.mjs', 'ledger.json'].includes(path));
    const job = await createJob(input);
    const evidence = await collect(input, job);
    const judgment = await judge(input, job.path, evidence.paths);
    const current = await assess(input, judgment.path);

    expect(judgment.record.groups.map(group => group.contract_id)).toEqual(consumedContracts);
    expect(judgment.record.groups.map(group => group.result)).toEqual(
      product === 'codex' ? ['unknown', 'unaffected', 'unknown', 'unknown', 'unknown', 'unknown', 'unaffected', 'unknown'] : Array<string>(8).fill('unknown')
    );
    const versions = product === 'codex' ? ['0.163.0', '0.164.0', '0.165.0'] : ['2.1.306', '2.1.307', '2.1.308'];
    expect(judgment.record.comparisons.map(row => [row.comparison_kind, row.from.version, row.to.version])).toEqual([
      ['adjacent_release', versions[0], versions[1]],
      ['adjacent_release', versions[1], versions[2]],
      ['parser_base', versions[0], versions[2]]
    ]);
    expect(judgment.record.coverage_reasons).toEqual([]);
    if (current.record.schema_version !== 9 || current.record.judgment_ids === undefined) {
      throw new Error('machine_schema_9_required');
    }
    expect(
      current.record.lanes.map(({ automated, ...lane }) => {
        expect(automated.validation).toBe('pending');
        return lane;
      })
    ).toEqual(history.record.lanes);
    const lane = current.record.lanes.find(row => row.profile_id === input.lane.profile_id && row.operation === input.lane.operation);
    expect(lane?.static_selection).toBe('inherited');
    expect(lane?.automated.required_validation).toEqual(expect.arrayContaining(['native_execution', 'backend_counter_meaning', 'real_session']));
    expect(lane?.automated.comparisons).toHaveLength(3);
    expect((await assess(input)).bytes).toBe(history.bytes);
    for (const [path, hash] of before) {
      expect(await tree(input.root)).toContainEqual([path, hash]);
    }
    expect(await readdir(input.records)).toEqual(['assessments', 'difference-evidence', 'difference-jobs', 'difference-judgments']);
    const portable = canonical({
      job: job.record,
      evidence: evidence.records,
      judgment: judgment.record,
      assessment: current.record
    });
    expect(portable).not.toContain(sourcePrivateText);
    expect(portable).not.toContain(privateMarker);
  },
  120_000
);

const driftCases = [
  ['source_digest', 'stale_source'],
  ['engine_digest', 'stale_engine'],
  ['map_revision', 'stale_map'],
  ['policy_revision', 'stale_policy'],
  ['capability_revision', 'stale_evidence']
] as const;
test('a collected machine judgment preserves the exact-only family beside the inherited root window', async () => {
  const input = await metadata('codex', '0.166.0');
  const history = await assess(input);
  const job = await createJob(input);
  const evidence = await collect(input, job);
  const judgment = await judge(input, job.path, evidence.paths);

  const current = await assess(input, judgment.path);
  if (current.record.schema_version !== 9 || current.record.judgment_ids === undefined) {
    throw new Error('machine_schema_9_required');
  }
  const family = current.record.lanes.find(row => row.profile_id === 'codex-binding-01660-direct-family-v1' && row.operation === 'collect');
  expect(family).toMatchObject({
    static_selection: 'exact',
    declared_scope: { exact_only: true, max_depth: 1, max_members: 3 }
  });
  expect(current.record.lanes.find(row => row.profile_id === input.lane.profile_id && row.operation === input.lane.operation)?.static_selection).toBe(
    'inherited'
  );
  expect(
    current.record.lanes.map(({ automated, ...lane }) => {
      expect(automated.validation).toBe('pending');
      return lane;
    })
  ).toEqual(history.record.lanes);
}, 120_000);

test.each(driftCases)(
  'one %s evidence byte makes the real CLI retain unknown with %s',
  async (field, reason) => {
    const input = await metadata('codex');
    const job = await createJob(input);
    const evidence = await collect(input, job);
    const before = await judge(input, job.path, evidence.paths);
    expect(before.record.groups[1]?.result).toBe('unaffected');
    const index = evidence.records.findIndex(record => record.method === 'codex_source_identity');
    const record = evidence.records[index];
    if (!record) throw new Error('source_evidence_required');
    const value = record[field];
    const replacement = field.endsWith('_digest') ? `${value[0] === '0' ? '1' : '0'}${value.slice(1)}` : `${value.slice(0, -1)}0`;
    const changed: DifferenceEvidence = differenceEvidenceSchema.parse({
      ...record,
      [field]: replacement
    });
    const originalBytes = Buffer.from(canonical(record)),
      changedBytes = Buffer.from(canonical(changed));
    expect(originalBytes.length).toBe(changedBytes.length);
    expect([...originalBytes].filter((byte, offset) => byte !== changedBytes[offset])).toHaveLength(1);
    const id = await publishRecord(input.records, changed, differenceEvidenceSchema);
    const paths = evidence.paths.map((path, offset) => (offset === index ? join(input.records, 'difference-evidence', `${id}.json`) : path));

    const judgment = await judge(input, job.path, paths);
    expect(judgment.record.groups[1]).toMatchObject({
      result: 'unknown',
      eligibility_recommendation: 'validation_pending'
    });
    expect(judgment.record.groups[1]?.facets.flatMap(facet => facet.reasons)).toContain(reason);
    const assessed = await assess(input, judgment.path);
    if (assessed.record.schema_version !== 9 || assessed.record.judgment_ids === undefined) {
      throw new Error('machine_schema_9_required');
    }
    const lane = assessed.record.lanes.find(row => row.profile_id === input.lane.profile_id && row.operation === input.lane.operation);
    expect(lane?.automated.contracts).toContainEqual({
      contract_id: 'fields_types_enums',
      judgment: 'unknown'
    });
    expect(await loadRecord(job.path, differenceJobSchema)).toEqual(job.record);
  },
  120_000
);

async function sourceCopy() {
  const root = await temporary();
  for (const path of new Set([...sourcePathAllowlist, ...engineFiles])) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await copyFile(join(projectRoot, path), join(root, path));
  }
  await cp(join(projectRoot, 'scripts/tool-update'), join(root, 'scripts/tool-update'), { recursive: true });
  await symlink(join(projectRoot, 'node_modules'), join(root, 'node_modules'), 'dir');
  return root;
}
test.each([
  ['src/nested-candidate.ts', 'stale_source'],
  ['scripts/tool-update/difference-judgment.mjs', 'stale_engine']
] as const)(
  'one consumed %s byte stales a previously collected pipeline without rewriting history',
  async (path, reason) => {
    const input = await metadata('codex');
    const job = await createJob(input);
    const evidence = await collect(input, job);
    const judgment = await judge(input, job.path, evidence.paths);
    const original = await assess(input, judgment.path);
    const copy = await sourceCopy();
    const target = join(copy, path);
    const bytes = await readFile(target);
    await writeFile(target, Buffer.concat([bytes, Buffer.from('\n')]));
    const recordsBefore = await tree(input.records);

    const stale = await assess(input, judgment.path, copy);
    if (stale.record.schema_version !== 9 || stale.record.judgment_ids === undefined) {
      throw new Error('machine_schema_9_required');
    }
    const lane = stale.record.lanes.find(row => row.profile_id === input.lane.profile_id && row.operation === input.lane.operation);
    expect(lane?.automated.freshness_reasons).toEqual([reason]);
    expect(lane?.automated.contracts.map(row => row.judgment)).toEqual(Array<string>(8).fill('unknown'));
    expect(lane?.automated.required_validation).toContain('fresh_evidence');
    for (const [name, hash] of recordsBefore) {
      expect(await tree(input.records)).toContainEqual([name, hash]);
    }
    expect((await assess(input, judgment.path)).bytes).toBe(original.bytes);
  },
  120_000
);
