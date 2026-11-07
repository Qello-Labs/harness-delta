import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeAll, expect, test } from 'vitest';
import { runToolUpdate } from '../scripts/tool-update.mjs';
import { assessCandidate, assessmentSchema, consumedContracts, contractReviewSchema } from '../scripts/tool-update/assessment.mjs';
import type { Assessment, ContractReview } from '../scripts/tool-update/assessment.mjs';
import { canonical, digest, publishRecord } from '../scripts/tool-update/manifest.mjs';
import type { Baseline } from '../scripts/tool-update/manifest.mjs';
import { candidateSchema, observationSchema } from '../scripts/tool-update/discovery.mjs';
import type { Candidate, Observation, Product, Release } from '../scripts/tool-update/discovery.mjs';
import { legacySourcePathAllowlist } from '../scripts/tool-update/source-snapshot.mjs';

const root = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const temporary: string[] = [];
afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});
async function scratch() {
  const directory = await mkdtemp(join(realpathSync(tmpdir()), 'tool-update-review-'));
  temporary.push(directory);
  return directory;
}
const key = {
  product: 'codex',
  route: 'file',
  profile_id: 'codex-file-checkpoint-v1',
  operation: 'collect',
  topology: 'root'
} as const;
const profile = key.profile_id;
const commits: Record<string, string> = {
  '0.150.0': '7'.repeat(40),
  '0.151.0': '8'.repeat(40),
  '0.158.0': '9'.repeat(40),
  '0.162.1': '1'.repeat(40),
  '0.162.2': '2'.repeat(40),
  '0.163.0': '3'.repeat(40)
};
const evidence = 'c'.repeat(64);
let sourceDigest = '';
function fixture(versions = ['0.162.1', '0.162.2', '0.163.0'], product: Product = 'codex') {
  const releases: Release[] = versions.map((version, i) => ({
    version,
    release_id: i + 1,
    tag: `${product === 'codex' ? 'rust-v' : 'v'}${version}`,
    commit: commits[version] ?? String(i + 1).repeat(40),
    npm_integrity: `sha512-${Buffer.alloc(64, i).toString('base64')}`
  }));
  const last = releases.at(-1);
  if (!last) throw new Error('fixture_release_required');
  const { version, ...identity } = last;
  const candidate: Candidate = { schema_version: 1, kind: 'candidate', product, target: version, ...identity };
  const observation: Observation = {
    schema_version: 1,
    kind: 'observation',
    product,
    checked_at: '2026-10-24T00:00:00.000Z',
    result: 'metadata_reconciled',
    reasons: ['baseline_missing'],
    heads: { github: version, npm_latest: version, npm_stable: version },
    checks: [],
    releases,
    candidate_id: digest(candidate)
  };
  return { root, candidate, observation };
}
function baseline(version = '0.162.1', evidenceIds = ['a'.repeat(64)]): Baseline {
  return {
    schema_version: 1,
    kind: 'baseline',
    rows: [
      {
        ...key,
        last_reviewed_version: version,
        contract_revision: 'consumed-v1',
        evidence_ids: evidenceIds,
        source_digest: 'b'.repeat(64)
      }
    ]
  };
}
type Judgment = 'unaffected' | 'affected' | 'unknown';
const contracts = (judgment: Judgment, overrides: Partial<Record<(typeof consumedContracts)[number], Judgment>> = {}) =>
  consumedContracts.map(contract_id => ({ contract_id, judgment: overrides[contract_id] ?? judgment }));
const ref = (version: string) => ({ version, commit: commits[version] ?? '' });
function review(from: string, to: string, change: Partial<ContractReview> = {}): ContractReview {
  return {
    schema_version: 1,
    kind: 'contract_review',
    ...key,
    contract_revision: 'consumed-v1',
    from: ref(from),
    to: ref(to),
    contracts: contracts('unaffected'),
    evidence_ids: [evidence],
    source_digest: sourceDigest,
    ...change
  };
}
const first = () => review('0.162.1', '0.162.2');
const second = () => review('0.162.2', '0.163.0');
const assess = (reviews: readonly unknown[] | null = null, input = fixture(), base: Baseline | null = baseline()) =>
  assessCandidate({ ...input, baseline: base, reviews });
function lane(assessment: Assessment, name: string = profile, operation = 'collect') {
  const value = assessment.lanes.find(row => row.profile_id === name && row.operation === operation);
  if (!value) throw new Error('fixture_lane_required');
  return value;
}
const zeroInput = () => fixture(['0.163.0']);
const zeroReview = (change: Partial<ContractReview> = {}) => review('0.162.1', '0.163.0', change);
const zero = (record: ContractReview, bound: readonly string[] = [digest(record)]) => assess([record], zeroInput(), baseline('0.163.0', [...bound]));
beforeAll(async () => {
  sourceDigest = (await assessCandidate(zeroInput())).source_digest;
}, 60_000);

test('a review record is a strict fixed-code object', () => {
  const valid = first();
  expect(contractReviewSchema.safeParse(valid).success).toBe(true);
  const [head, ...tail] = valid.contracts;
  if (!head) throw new Error('fixture_contract_required');
  for (const bad of [
    { ...valid, note: 'free text' },
    { ...valid, path: '/Users/synthetic/private' },
    { ...valid, schema_version: 2 },
    { ...valid, contract_revision: 'consumed-v2' },
    { ...valid, contracts: [head, ...tail, head] },
    { ...valid, contracts: tail },
    { ...valid, contracts: [head, head, ...tail.slice(1)] },
    { ...valid, contracts: [...tail, head] },
    { ...valid, contracts: [{ ...head, judgment: 'pass' }, ...tail] },
    { ...valid, contracts: [{ ...head, extra: 'text' }, ...tail] },
    { ...valid, evidence_ids: [] },
    { ...valid, evidence_ids: ['d'.repeat(64), evidence] },
    { ...valid, evidence_ids: [evidence, evidence] },
    { ...valid, source_digest: 'F'.repeat(64) },
    { ...valid, evidence_ids: Array.from({ length: 65 }, (_, index) => index.toString(16).padStart(64, '0')) },
    { ...valid, from: ref('0.162.2'), to: ref('0.162.1') },
    { ...valid, to: valid.from },
    { ...valid, to: { ...valid.to, commit: 'F'.repeat(40) } },
    { ...valid, from: { ...valid.from, version: '0.162.x' } },
    { ...valid, to: { ...valid.to, version: '0.162.2-beta' } }
  ])
    expect(contractReviewSchema.safeParse(bad).success).toBe(false);
});

test('record-review publishes the record under its content address and prints one status', async () => {
  const output = await scratch();
  const record = first();
  const input = join(output, 'input.json');
  await writeFile(input, JSON.stringify(record));
  const result = await runToolUpdate(['record-review', '--input', input, '--out', output]);
  expect(result).toEqual({ exitCode: 0, output: { status: 'review_recorded', review_id: digest(record) } });
  expect(await readFile(join(output, 'reviews', `${digest(record)}.json`), 'utf8')).toBe(canonical(record));
  expect(await runToolUpdate(['record-review', '--input', input, '--out', output])).toEqual(result);
  expect(await readdir(join(output, 'reviews'))).toEqual([`${digest(record)}.json`]);
  const { stdout, stderr } = await promisify(execFile)(process.execPath, ['scripts/tool-update.mjs', 'record-review', '--input', input, '--out', output], {
    cwd: root,
    timeout: 30_000
  });
  expect(stdout).toBe(`${JSON.stringify(result.output)}\n`);
  expect(stderr).toBe('');
});

test('record-review rejects malformed input without publishing and requires both options', async () => {
  const output = await scratch();
  const input = join(output, 'input.json');
  await writeFile(input, JSON.stringify({ ...first(), note: 'synthetic-secret' }));
  expect(await runToolUpdate(['record-review', '--input', input, '--out', output])).toEqual({ exitCode: 2, output: { status: 'invalid_review' } });
  expect(await readdir(output)).toEqual(['input.json']);
  expect(await runToolUpdate(['record-review', '--input', input])).toEqual({ exitCode: 2, output: { status: 'invalid_arguments' } });
  expect(await runToolUpdate(['record-review', '--out', output])).toEqual({ exitCode: 2, output: { status: 'invalid_arguments' } });
});

test('a lane closes only when every edge has a matching all-unaffected record', async () => {
  const plain = await assess(null);
  const result = await assess([second(), first()]);
  if (result.schema_version !== 6) throw new Error('schema_6_required');
  const selected = lane(result);
  expect(result.schema_version).toBe(6);
  expect(selected.review.edges.every(edge => edge.contracts.every(row => row.judgment === 'unaffected'))).toBe(true);
  expect(selected.review.contracts).toEqual(contracts('unaffected'));
  expect(selected.gates.contracts_reviewed).toBe('closed');
  expect(selected.reasons).toEqual(lane(plain).reasons.filter(reason => reason !== 'contracts_unknown'));
  expect(selected.reasons).toContain('minor_transition');
  expect(selected.live).toEqual(lane(plain).live);
  expect(selected.review.parser_comparison).toEqual(lane(plain).review.parser_comparison);
  expect(selected.review.releases).toEqual(lane(plain).review.releases);
  expect(
    result.lanes
      .filter(row => row !== selected)
      .map(row => {
        const { selection_policy, ...previous } = row;
        expect(selection_policy).toBeDefined();
        return previous;
      })
  ).toEqual(plain.lanes.filter(row => row !== lane(plain)));
  expect(result.review_sources).toEqual(plain.review_sources);
  expect(result.source_digest).toBe(plain.source_digest);
  expect(result.review_ids).toEqual([digest(first()), digest(second())].sort());
  expect(result.unused_review_ids).toEqual([]);
});

test('closed contracts never imply support', async () => {
  const closed = [lane(await assess([first(), second()])), lane(await zero(zeroReview()))];
  for (const selected of closed) {
    expect(selected.gates.contracts_reviewed).toBe('closed');
    expect({ ...selected.gates, contracts_reviewed: 'x' }).toEqual({
      contracts_reviewed: 'x',
      conformance: 'not_assessed',
      regression: 'not_assessed',
      implementation_review: 'not_assessed',
      admission: 'not_assessed',
      default_promotion: 'not_assessed'
    });
    expect(Object.values(selected.live)).toEqual(Array<string>(5).fill('not_assessed'));
  }
});

test('an edge without a matching record keeps the lane unknown', async () => {
  const selected = lane(await assess([second()]));
  expect(selected.review.edges.map(edge => edge.contracts[0]?.judgment)).toEqual(['unknown', 'unaffected']);
  expect(selected.review.contracts).toEqual(contracts('unknown'));
  expect(selected.gates.contracts_reviewed).toBe('unknown');
  expect(selected.reasons).toContain('contracts_unknown');
  expect(selected.reasons).not.toContain('contracts_affected');
});

test('lane contracts are the per-contract worst case across edges', async () => {
  const result = await assess([
    review('0.162.1', '0.162.2', {
      contracts: contracts('unaffected', {
        identity_source_mapping: 'affected',
        fields_types_enums: 'unknown'
      })
    }),
    review('0.162.2', '0.163.0', {
      contracts: contracts('unaffected', {
        fields_types_enums: 'affected',
        identity_source_mapping: 'unknown',
        hooks_order_receipts_loading: 'unknown'
      })
    })
  ]);
  const selected = lane(result);
  expect(selected.review.contracts).toEqual(
    contracts('unaffected', {
      identity_source_mapping: 'affected',
      fields_types_enums: 'affected',
      hooks_order_receipts_loading: 'unknown'
    })
  );
  expect(selected.gates.contracts_reviewed).toBe('affected');
  expect(selected.reasons).toEqual(expect.arrayContaining(['contracts_affected', 'contracts_unknown']));
  const unknown = lane(
    await assess([
      first(),
      review('0.162.2', '0.163.0', {
        contracts: contracts('unaffected', { fields_types_enums: 'unknown' })
      })
    ])
  );
  expect(unknown.gates.contracts_reviewed).toBe('unknown');
  expect(unknown.review.contracts).toEqual(contracts('unaffected', { fields_types_enums: 'unknown' }));
  expect(unknown.reasons).not.toContain('contracts_affected');
});

test('review option order and repeats do not change the assessment', async () => {
  const forward = await assess([first(), second()]);
  expect(await assess([second(), first()])).toEqual(forward);
  expect(await assess([second(), first(), first()])).toEqual(forward);
  expect(digest(await assess([second(), first()]))).toBe(digest(forward));
});

test('a source digest mismatch keeps the edge unknown and marks the lane', async () => {
  const stale = review('0.162.1', '0.162.2', { source_digest: 'f'.repeat(64) });
  const result = await assess([stale, second()]);
  const selected = lane(result);
  expect(selected.review.edges.map(edge => edge.contracts[0]?.judgment)).toEqual(['unknown', 'unaffected']);
  expect(selected.gates.contracts_reviewed).toBe('unknown');
  expect(selected.reasons).toEqual(expect.arrayContaining(['review_source_changed', 'contracts_unknown']));
  if (result.schema_version !== 6) throw new Error('schema_6_required');
  expect(result.unused_review_ids).toEqual([]);
  expect(result.review_ids).toContain(digest(stale));
});

test('records that match no lane or edge are listed as unused', async () => {
  const unmatched = [
    review('0.162.1', '0.162.2', { profile_id: 'codex-file-legacy-v1' }),
    review('0.150.0', '0.151.0'),
    review('0.162.1', '0.162.2', { product: 'claude_code' }),
    review('0.162.1', '0.162.2', { operation: 'restart' }),
    review('0.162.1', '0.162.2', { topology: 'root_direct_child' }),
    review('0.162.1', '0.162.2', { route: 'codex_workflow' }),
    review('0.158.0', '0.162.1')
  ];
  const result = await assess([...unmatched, first()]);
  if (result.schema_version !== 6) throw new Error('schema_6_required');
  expect(result.unused_review_ids).toEqual(unmatched.map(digest).sort());
  expect(lane(result).gates.contracts_reviewed).toBe('unknown');
  expect(lane(result, 'codex-file-legacy-v1').gates.contracts_reviewed).toBe('unknown');
});

test('conflicting records for one lane edge fail closed', async () => {
  const other = review('0.162.1', '0.162.2', { evidence_ids: ['d'.repeat(64)] });
  await expect(assess([first(), other, second()])).rejects.toMatchObject({ code: 'review_conflict' });
  await expect(assess([first(), review('0.162.1', '0.162.2', { source_digest: 'f'.repeat(64) })])).rejects.toMatchObject({ code: 'review_conflict' });
});

test.each([
  ['to', () => review('0.162.1', '0.162.2', { to: { version: '0.162.2', commit: 'f'.repeat(40) } })],
  ['from', () => review('0.162.1', '0.162.2', { from: { version: '0.162.1', commit: 'f'.repeat(40) } })]
])('a record with a conflicting %s commit fails closed', async (_, build) => {
  await expect(assess([build(), second()])).rejects.toMatchObject({ code: 'review_commit_conflict' });
});

test('a malformed record fails closed', async () => {
  await expect(assess([{ ...first(), note: 'synthetic-secret' }])).rejects.toMatchObject({ code: 'invalid_review' });
  await expect(assess([{ ...first(), contracts: contracts('unaffected').slice(1) }])).rejects.toMatchObject({ code: 'invalid_review' });
});

test('a baseline-bound record with the target version closes a zero-edge lane', async () => {
  const record = zeroReview();
  const plain = await assess(null, zeroInput(), baseline('0.163.0'));
  const selected = lane(await zero(record));
  expect(selected.review.edges).toEqual([]);
  expect(selected.review.contracts).toEqual(contracts('unaffected'));
  expect(selected.gates.contracts_reviewed).toBe('closed');
  expect(selected.reasons).toEqual(lane(plain).reasons.filter(reason => reason !== 'contracts_unknown'));
});

test.each([
  ['codex', ['0.160.0'], 'codex_workflow', 'codex-workflow-own-response-v1', 'launch'],
  ['claude_code', ['2.1.282', '2.1.283'], 'file', 'claude-file-message-components-v1', 'collect'],
  ['claude_code', ['2.1.283'], 'file', 'claude-file-message-components-v1', 'collect']
] as const)('clean %s %j lanes can close without any remaining reason', async (product, versions, route, profile_id, operation) => {
  const input = fixture([...versions], product);
  const from = input.observation.releases[0];
  const to = input.observation.releases.at(-1);
  if (!from || !to) throw new Error('fixture_release_required');
  const record = review('0.162.1', '0.163.0', {
    product,
    route,
    profile_id,
    operation,
    from: versions.length === 1 ? { version: '0.1.0', commit: 'f'.repeat(40) } : { version: from.version, commit: from.commit },
    to: { version: to.version, commit: to.commit }
  });
  const base: Baseline = {
    schema_version: 1,
    kind: 'baseline',
    rows: [
      {
        product,
        route,
        profile_id,
        operation,
        topology: 'root',
        last_reviewed_version: from.version,
        contract_revision: 'consumed-v1',
        evidence_ids: [digest(record)],
        source_digest: sourceDigest
      }
    ]
  };
  const selected = lane(await assess([record], input, base), profile_id, operation);
  expect(selected.gates.contracts_reviewed).toBe('closed');
  expect(selected.reasons).toEqual([]);
  expect(Object.values(selected.gates).slice(1)).toEqual(Array<string>(5).fill('not_assessed'));
});

test('closing an exact-only lane preserves no-window and transition reasons', async () => {
  const input = fixture(['0.164.0']);
  const target = input.observation.releases[0];
  if (!target) throw new Error('fixture_release_required');
  const plain = await assessCandidate(input);
  const selected = plain.lanes.find(row => row.reasons.includes('exact_only') && row.reasons.includes('no_window'));
  if (!selected) throw new Error('fixture_lane_required');
  const { product, route, profile_id, operation, topology } = selected;
  const record = review('0.163.0', '0.164.0', {
    product,
    route,
    profile_id,
    operation,
    topology,
    to: { version: target.version, commit: target.commit }
  });
  const base: Baseline = {
    schema_version: 1,
    kind: 'baseline',
    rows: [
      {
        product,
        route,
        profile_id,
        operation,
        topology,
        last_reviewed_version: target.version,
        contract_revision: 'consumed-v1',
        evidence_ids: [digest(record)],
        source_digest: sourceDigest
      }
    ]
  };
  const result = await assess([record], input, base);
  const closed = result.lanes.find(row => row.profile_id === profile_id && row.operation === operation && row.topology === topology);
  expect(closed?.gates.contracts_reviewed).toBe('closed');
  expect(closed?.reasons).toEqual(selected.reasons.filter(reason => !['baseline_missing', 'contracts_unknown'].includes(reason)));
  expect(closed?.reasons).toEqual(expect.arrayContaining(['exact_only', 'no_window', 'minor_transition']));
});

test('a record alone cannot close a lane the baseline does not bind', async () => {
  const record = zeroReview();
  const result = await zero(record, ['a'.repeat(64)]);
  expect(lane(result).gates.contracts_reviewed).toBe('unknown');
  expect(lane(result).reasons).toContain('contracts_unknown');
  if (result.schema_version !== 6) throw new Error('schema_6_required');
  expect(result.unused_review_ids).toEqual([digest(record)]);
});

test.each([
  ['stale digest', () => zeroReview({ source_digest: 'f'.repeat(64) }), 'unknown', true],
  ['older to version', () => review('0.158.0', '0.162.1'), 'unknown', false],
  ['affected contract', () => zeroReview({ contracts: contracts('unaffected', { fields_types_enums: 'affected' }) }), 'affected', false],
  ['unknown contract', () => zeroReview({ contracts: contracts('unaffected', { fields_types_enums: 'unknown' }) }), 'unknown', false]
] as const)('zero-edge binding with %s does not close the lane', async (_, build, gate, changed) => {
  const result = await zero(build());
  expect(lane(result).gates.contracts_reviewed).toBe(gate);
  expect(lane(result).reasons).toContain('contracts_unknown');
  expect(lane(result).reasons.includes('review_source_changed')).toBe(changed);
});

test('lanes without a baseline row stay unknown whatever is supplied', async () => {
  const legacy = zeroReview({ profile_id: 'codex-file-legacy-v1' });
  const result = await assess([legacy], zeroInput(), baseline('0.163.0', [digest(legacy)]));
  const selected = lane(result, 'codex-file-legacy-v1');
  expect(selected.review.coverage).toBe('baseline_missing');
  expect(selected.gates.contracts_reviewed).toBe('unknown');
  expect(selected.reasons).toContain('baseline_missing');
  expect(selected.review.contracts).toEqual(contracts('unknown'));
  if (result.schema_version !== 6) throw new Error('schema_6_required');
  expect(result.unused_review_ids).toEqual([digest(legacy)]);
});

test('parser comparison needs a contiguous chain from the parser base to the target', async () => {
  const input = fixture(['0.158.0', '0.162.1', '0.162.2', '0.163.0']);
  const chain = review('0.158.0', '0.162.1');
  const parser = async (reviews: readonly unknown[]) => lane(await assess(reviews, input)).review.parser_comparison;
  expect(await parser([first(), second()])).toMatchObject({ from_version: '0.158.0', contracts: contracts('unknown') });
  expect(await parser([chain, first()])).toMatchObject({ contracts: contracts('unknown') });
  expect(await parser([chain, second()])).toMatchObject({ contracts: contracts('unknown') });
  const stale = await assess([review('0.158.0', '0.162.1', { source_digest: 'f'.repeat(64) }), first(), second()], input);
  expect(lane(stale).review.parser_comparison).toMatchObject({ contracts: contracts('unknown') });
  expect(lane(stale).reasons).toContain('review_source_changed');
  const closed = await assess([second(), chain, first()], input);
  expect(lane(closed).review.parser_comparison).toMatchObject({
    from_version: '0.158.0',
    to: { version: '0.163.0' },
    contracts: contracts('unaffected')
  });
  if (closed.schema_version !== 6) throw new Error('schema_6_required');
  expect(closed.unused_review_ids).toEqual([]);
  const mixed = await assess(
    [
      chain,
      first(),
      review('0.162.2', '0.163.0', {
        contracts: contracts('unaffected', { fields_types_enums: 'affected' })
      })
    ],
    input
  );
  expect(lane(mixed).review.parser_comparison?.contracts).toEqual(contracts('unaffected', { fields_types_enums: 'affected' }));
  expect(lane(mixed).gates.contracts_reviewed).toBe('affected');
});

test('parser comparison cannot skip an observed release', async () => {
  const result = await assess([review('0.158.0', '0.163.0')], fixture(['0.158.0', '0.162.1', '0.163.0']));
  expect(lane(result).review.parser_comparison?.contracts).toEqual(contracts('unknown'));
  if (result.schema_version !== 6) throw new Error('schema_6_required');
  expect(result.unused_review_ids).toEqual([digest(review('0.158.0', '0.163.0'))]);
});

test('parser comparison cannot trust a base or intermediate commit absent from the observation', async () => {
  const chain = [
    review('0.158.0', '0.151.0', { to: { version: '0.160.0', commit: 'a'.repeat(40) } }),
    review('0.151.0', '0.162.1', { from: { version: '0.160.0', commit: 'b'.repeat(40) } }),
    first(),
    second()
  ];
  const result = await assess(chain, fixture(['0.158.0', '0.162.1', '0.162.2', '0.163.0']));
  expect(lane(result).review.parser_comparison?.contracts).toEqual(contracts('unknown'));
  const missingBase = await assess([review('0.158.0', '0.162.1'), first(), second()]);
  expect(lane(missingBase).review.parser_comparison?.contracts).toEqual(contracts('unknown'));
});

test('without reviews the assessment writes schema 5 and old schemas stay readable', async () => {
  const plain = await assess(null);
  expect(plain.schema_version).toBe(5);
  expect(plain).not.toHaveProperty('review_ids');
  expect(await assess(undefined)).toEqual(plain);
  if (plain.schema_version !== 5) throw new Error('schema_5_required');
  const { inventory_scope: scope, ...fields } = plain;
  expect(scope).toBe('legacy_full_inventory');
  expect(
    assessmentSchema.safeParse({
      ...fields,
      schema_version: 1,
      rule_revision: 'static-assessment-v1',
      source_paths: legacySourcePathAllowlist,
      lanes: plain.lanes.filter(row => row.rule_revision === 'forward-version-v1')
    }).success
  ).toBe(true);
  const selected = lane(plain);
  const forged = {
    ...plain,
    lanes: plain.lanes.map(row =>
      row === selected
        ? {
            ...row,
            review: { ...row.review, contracts: contracts('affected') }
          }
        : row
    )
  };
  expect(assessmentSchema.safeParse(forged).success).toBe(false);
  for (const overrides of [
    { gates: { ...selected.gates, contracts_reviewed: 'closed' } },
    { reasons: [...selected.reasons, 'contracts_affected'] },
    { reasons: [...selected.reasons, 'review_source_changed'] }
  ])
    expect(assessmentSchema.safeParse({ ...plain, lanes: [{ ...selected, ...overrides }] }).success).toBe(false);
  const closed = await assess([first(), second()]);
  expect(assessmentSchema.safeParse(closed).success).toBe(true);
  if (closed.schema_version !== 6) throw new Error('schema_6_required');
  const schema3 = {
    ...closed,
    schema_version: 3,
    rule_revision: 'static-assessment-v1',
    source_paths: legacySourcePathAllowlist,
    lanes: closed.lanes
      .filter(row => row.rule_revision === 'forward-version-v1')
      .map(row => {
        const { selection_policy, ...previous } = row;
        expect(selection_policy).toBeDefined();
        return previous;
      })
  };
  expect(assessmentSchema.safeParse(schema3).success).toBe(true);
  expect(assessmentSchema.safeParse({ ...closed, review_ids: [...closed.review_ids].reverse() }).success).toBe(false);
  expect(
    assessmentSchema.safeParse({
      ...closed,
      lanes: closed.lanes.map(row =>
        row.profile_id === profile && row.operation === 'collect'
          ? { ...row, gates: { ...row.gates, contracts_reviewed: 'closed' }, review: { ...row.review, contracts: contracts('unknown') } }
          : row
      )
    }).success
  ).toBe(false);
});

async function stage(versions = ['0.162.1', '0.162.2', '0.163.0']) {
  const output = await scratch();
  const input = fixture(versions);
  const candidateId = await publishRecord(output, input.candidate, candidateSchema);
  const observationId = await publishRecord(output, input.observation, observationSchema);
  const file = async (name: string, value: unknown) => {
    const path = join(output, name);
    await writeFile(path, JSON.stringify(value));
    return path;
  };
  const run = async (reviews: readonly unknown[], base: Baseline = baseline()) => {
    const args = [
      'assess',
      '--manifest',
      join(output, 'candidates', `${candidateId}.json`),
      '--observation',
      join(output, 'observations', `${observationId}.json`),
      '--baseline',
      await file('baseline.json', base)
    ];
    for (const [index, value] of reviews.entries()) args.push('--review', await file(`review-${index}.json`, value));
    return runToolUpdate(args);
  };
  return { output, run };
}

test('assess --review is repeatable, order independent and writes schema 6', async () => {
  const { output, run } = await stage();
  const forward = await run([first(), second()]);
  expect(forward).toMatchObject({ exitCode: 0, output: { status: 'assessment_created' } });
  expect(await run([second(), first()])).toEqual(forward);
  const stored: unknown = JSON.parse(await readFile(join(output, 'assessments', `${forward.output.assessment_id}.json`), 'utf8'));
  const record = assessmentSchema.parse(stored);
  expect(record.schema_version).toBe(6);
  expect(lane(record).gates.contracts_reviewed).toBe('closed');
  const plain = await run([]);
  const plainRecord = assessmentSchema.parse(JSON.parse(await readFile(join(output, 'assessments', `${plain.output.assessment_id}.json`), 'utf8')));
  expect(plainRecord.schema_version).toBe(5);
});

test('assess --review reports fixed codes for conflicting, commit-conflicting and malformed records', async () => {
  const { run } = await stage();
  expect(await run([first(), review('0.162.1', '0.162.2', { evidence_ids: ['d'.repeat(64)] })])).toEqual({
    exitCode: 2,
    output: { status: 'review_conflict' }
  });
  expect(await run([review('0.162.1', '0.162.2', { to: { version: '0.162.2', commit: 'f'.repeat(40) } })])).toEqual({
    exitCode: 2,
    output: { status: 'review_commit_conflict' }
  });
  expect(await run([{ ...first(), note: 'synthetic-secret' }])).toEqual({ exitCode: 2, output: { status: 'invalid_review' } });
});

test('review-file failures are fixed and independent of option order', async () => {
  const { output } = await stage();
  const input = fixture();
  const baselinePath = join(output, 'baseline.json');
  const invalid = join(output, 'a-invalid.json');
  const unreadable = join(output, 'z-nonjson.json');
  await writeFile(baselinePath, JSON.stringify(baseline()));
  await writeFile(invalid, JSON.stringify({ ...first(), note: 'synthetic-secret' }));
  await writeFile(unreadable, 'synthetic-invalid-json');
  const args = [
    'assess',
    '--manifest',
    join(output, 'candidates', `${digest(input.candidate)}.json`),
    '--observation',
    join(output, 'observations', `${digest(input.observation)}.json`),
    '--baseline',
    baselinePath
  ];
  for (const files of [
    [invalid, unreadable],
    [unreadable, invalid]
  ]) {
    expect(await runToolUpdate([...args, ...files.flatMap(path => ['--review', path])])).toEqual({ exitCode: 2, output: { status: 'invalid_review' } });
  }
  expect(await runToolUpdate([...args, '--review', unreadable])).toEqual({ exitCode: 2, output: { status: 'record_read_failed' } });
});
