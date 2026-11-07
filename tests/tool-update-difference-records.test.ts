import { afterEach, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  differenceEvidenceSchema,
  differenceJobId,
  differenceJobSchema,
  differenceJudgmentSchema,
  parseDifferenceEvidence,
  parseDifferenceJob,
  parseDifferenceJudgment
} from '../scripts/tool-update/difference-records.mjs';
import { judgeDifferences, judgmentEngineDigest } from '../scripts/tool-update/difference-judgment.mjs';
import { engineFiles } from '../scripts/tool-update/difference-contracts.mjs';
import { canonical, maxRecordBytes, publishRecord } from '../scripts/tool-update/manifest.mjs';
import { currentIdentities, differenceJob, sourceEvidence } from './helpers/tool-update-difference-fixture.js';

const roots: string[] = [];
async function temporaryRoot() {
  const root = await mkdtemp(join(realpathSync(tmpdir()), 'difference-records-'));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
function variants(value: unknown, change: (value: unknown) => unknown): unknown[] {
  const values = [change(value)];
  if (Array.isArray(value)) {
    value.forEach((child: unknown, index) => {
      for (const replacement of variants(child, change)) {
        values.push(value.map((item: unknown, i) => (i === index ? replacement : item)));
      }
    });
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      for (const replacement of variants(child, change)) {
        values.push({ ...value, [key]: replacement });
      }
    }
  }
  return values;
}
function records() {
  const job = differenceJob();
  const evidence = sourceEvidence(job);
  const first = evidence[0];
  if (!first) throw new Error('missing_synthetic_evidence');
  return [
    { record: job, parse: parseDifferenceJob },
    { record: first, parse: parseDifferenceEvidence },
    {
      record: judgeDifferences(job, evidence, currentIdentities),
      parse: parseDifferenceJudgment
    }
  ];
}
test('schema-1 records round-trip complete portable identities without adding defaults', () => {
  for (const { record, parse } of records()) {
    expect(parse(record)).toEqual(record);
  }
});
test.each(['prompt', 'response', 'source_text', 'patch', 'url', 'local_path', 'command', 'approved', 'admitted', 'user_name', 'explanation'])(
  'all record object boundaries reject injected %s with a fixed diagnostic',
  key => {
    for (const { record, parse } of records()) {
      for (const input of variants(record, value =>
        value !== null && typeof value === 'object' && !Array.isArray(value) ? { ...value, [key]: 'synthetic-private' } : value
      ).filter(value => canonical(value) !== canonical(record))) {
        expect(() => parse(input)).toThrowError('invalid_record');
      }
    }
  }
);
test.each(['arbitrary prose', 'https://invalid.example/synthetic', '/Users/synthetic/private', '../synthetic', 'C:\\synthetic\\private'])(
  'finite string fields reject %s at every nesting level',
  replacement => {
    for (const { record, parse } of records()) {
      for (const input of variants(record, value => (typeof value === 'string' ? replacement : value)).filter(value => canonical(value) !== canonical(record)))
        expect(() => parse(input)).toThrowError('invalid_record');
    }
  }
);
test('all three parse boundaries enforce the unchanged byte limit before schema validation', () => {
  for (const { record, parse } of records()) {
    expect(() => parse({ ...record, payload: 'x'.repeat(maxRecordBytes) })).toThrowError('record_too_large');
  }
});
test('missing baseline requires both explicit nulls and its fixed reason', () => {
  const job = {
    ...differenceJob(),
    baseline_digest: null,
    baseline_row: null
  };
  expect(() => parseDifferenceJob(job)).toThrowError('invalid_record');
  expect(
    parseDifferenceJob({
      ...job,
      comparison: {
        comparison_kind: 'parser_base',
        from: { version: '0.163.0', commit: '1'.repeat(40) },
        to: job.target
      },
      reasons: ['baseline_missing']
    })
  ).toMatchObject({ baseline_digest: null, baseline_row: null });
});
test.each(['candidate', 'repository', 'lane', 'parser_profile', 'parser_base', 'comparison', 'baseline_row'] as const)(
  'jobs reject conflicting %s identities',
  kind => {
    const job = differenceJob();
    const invalid = {
      candidate: { ...job, observation_candidate_id: '0'.repeat(64) },
      repository: { ...job, repository_id: 'anthropics_claude_code' },
      lane: { ...job, lane: { ...job.lane, route: 'claude_binding' } },
      parser_profile: {
        ...job,
        parser_base: {
          ...job.parser_base,
          profile_id: 'codex-file-checkpoint-v1'
        }
      },
      parser_base: {
        ...job,
        parser_base: { ...job.parser_base, version: '0.162.0' }
      },
      comparison: {
        ...job,
        comparison: {
          ...job.comparison,
          to: { ...job.target, commit: '9'.repeat(40) }
        }
      },
      baseline_row: {
        ...job,
        baseline_row: { ...job.baseline_row, operation: 'resume' }
      }
    };
    expect(() => parseDifferenceJob(invalid[kind])).toThrowError('invalid_record');
  }
);
test.each(['build', 'native_pin', 'artifact'] as const)('static jobs cannot fabricate a %s hash', pin => {
  const job = differenceJob();
  expect(() =>
    parseDifferenceJob({
      ...job,
      pins: {
        ...job.pins,
        [pin]: {
          applicability: 'not_applicable',
          digest: '0'.repeat(64)
        }
      }
    })
  ).toThrowError('invalid_record');
  expect(() =>
    parseDifferenceJob({
      ...job,
      pins: {
        ...job.pins,
        [pin]: {
          applicability: 'applicable',
          digest: '0'.repeat(64)
        }
      }
    })
  ).toThrowError('invalid_record');
});
test('judgments reject missing, duplicated, reordered and extra groups', () => {
  const judgment = judgeDifferences(differenceJob(), sourceEvidence(), currentIdentities);
  const first = judgment.groups[0];
  if (!first) throw new Error('missing_synthetic_group');
  for (const groups of [judgment.groups.slice(1), [first, ...judgment.groups.slice(0, -1)], [...judgment.groups].reverse(), [...judgment.groups, first]]) {
    expect(() => parseDifferenceJudgment({ ...judgment, groups })).toThrowError('invalid_record');
  }
});
test('judgments reject established facets claimed by a method without that capability', () => {
  const judgment = judgeDifferences(differenceJob(), sourceEvidence(), currentIdentities);
  const groups = judgment.groups.map(group =>
    group.contract_id === 'fields_types_enums' ? { ...group, facets: group.facets.map(facet => ({ ...facet, methods: ['serialized_schema'] })) } : group
  );
  expect(() => parseDifferenceJudgment({ ...judgment, groups })).toThrowError('invalid_record');
});
test('structured facts preserve observed zero versus missing and reject a false unchanged claim', () => {
  const record = sourceEvidence()[0];
  if (!record) throw new Error('missing_synthetic_evidence');
  const finding = {
    contract_id: 'fields_types_enums',
    facet: 'serialized_shape',
    result: 'unknown',
    reason: 'unresolved_dependency',
    impact: 'undetermined',
    field_id: 'input_tokens',
    expected: { kind: 'number', value: 0 },
    actual: { kind: 'number', value: null }
  };
  expect(parseDifferenceEvidence({ ...record, findings: [finding] }).findings[0]).toEqual(finding);
  expect(() =>
    parseDifferenceEvidence({ ...record, findings: [{ ...finding, result: 'unaffected', reason: 'established_unchanged', impact: 'none_established' }] })
  ).toThrowError('invalid_record');
});
test('independent SHA-256 over portable canonical bytes gives the job publication ID', async () => {
  const job = differenceJob();
  const root = await temporaryRoot();
  const portable: unknown = JSON.parse(JSON.stringify(job), (key: string, value: unknown) => {
    void key;
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en')))
      : value;
  });
  const expected = createHash('sha256')
    .update(`${JSON.stringify(portable)}\n`)
    .digest('hex');
  const id = await publishRecord(root, job, differenceJobSchema);
  expect(id).toBe(expected);
  expect(differenceJobId({ ...job })).toBe(expected);
  expect(await readFile(join(root, 'difference-jobs', `${id}.json`), 'utf8')).toBe(`${JSON.stringify(portable)}\n`);
});
test('publication and reduction change nothing outside the requested record root', async () => {
  const parent = await temporaryRoot();
  const root = join(parent, 'requested');
  await writeFile(join(parent, 'outside-sentinel'), 'synthetic-unchanged');
  const job = differenceJob();
  const evidence = sourceEvidence(job);
  const first = evidence[0];
  if (!first) throw new Error('missing_synthetic_evidence');
  const judgment = judgeDifferences(job, evidence, currentIdentities);
  const jobId = await publishRecord(root, job, differenceJobSchema);
  const evidenceId = await publishRecord(root, first, differenceEvidenceSchema);
  const judgmentId = await publishRecord(root, judgment, differenceJudgmentSchema);
  expect((await readdir(parent, { recursive: true })).sort()).toEqual(
    [
      'outside-sentinel',
      'requested',
      'requested/difference-evidence',
      `requested/difference-evidence/${evidenceId}.json`,
      'requested/difference-jobs',
      `requested/difference-jobs/${jobId}.json`,
      'requested/difference-judgments',
      `requested/difference-judgments/${judgmentId}.json`
    ].sort()
  );
  expect(await readFile(join(parent, 'outside-sentinel'), 'utf8')).toBe('synthetic-unchanged');
});
test('engine digest changes for each listed input but not an unlisted neighbour', async () => {
  const root = await temporaryRoot();
  for (const path of engineFiles) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), `synthetic input ${path}`);
  }
  const before = await judgmentEngineDigest(root);
  for (const path of engineFiles) {
    const original = `synthetic input ${path}`;
    await writeFile(join(root, path), `${original}\nchanged`);
    expect(await judgmentEngineDigest(root), path).not.toBe(before);
    await writeFile(join(root, path), original);
  }
  await writeFile(join(root, 'scripts/tool-update/unlisted.mjs'), 'synthetic neighbour');
  expect(await judgmentEngineDigest(root)).toBe(before);
});
