import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import { assessCandidate, assessmentSchema, validateBaselineForSource } from '../scripts/tool-update/assessment.mjs';
import type { Assessment } from '../scripts/tool-update/assessment.mjs';
import { digest } from '../scripts/tool-update/manifest.mjs';
import type { Baseline } from '../scripts/tool-update/manifest.mjs';
import type { Candidate, Observation, Product, Release } from '../scripts/tool-update/discovery.mjs';
import { laneSchema, sourceLanes } from '../scripts/tool-update/lanes.mjs';
import { sourcePathAllowlist, withSourceSnapshot } from '../scripts/tool-update/source-snapshot.mjs';

const root = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const temporary: string[] = [];
afterEach(async () => { for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true }); });
function fixture(product: Product = 'codex', versions = ['0.163.0']) {
  const releases: Release[] = versions.map((version, i) => ({
    version, release_id: i + 1, tag: `${product === 'codex' ? 'rust-v' : 'v'}${version}`,
    commit: String(i + 1).repeat(40), npm_integrity: `sha512-${Buffer.alloc(64, i).toString('base64')}`,
  }));
  const last = releases.at(-1);
  if (!last) throw new Error('fixture_release_required');
  const { version, ...identity } = last;
  const candidate: Candidate = { schema_version: 1, kind: 'candidate', product, target: version, ...identity };
  const observation: Observation = {
    schema_version: 1, kind: 'observation', product, checked_at: '2026-10-24T00:00:00.000Z',
    result: 'metadata_reconciled', reasons: ['baseline_missing'],
    heads: { github: version, npm_latest: version, npm_stable: version }, checks: [], releases,
    candidate_id: digest(candidate),
  };
  return { root, candidate, observation };
}
function baseline(version = '0.162.1'): Baseline {
  return { schema_version: 1, kind: 'baseline', rows: [{
    product: 'codex', route: 'file', profile_id: 'codex-file-checkpoint-v1',
    operation: 'collect', topology: 'root', last_reviewed_version: version,
    contract_revision: 'consumed-v1', evidence_ids: ['a'.repeat(64)], source_digest: 'b'.repeat(64),
  }] };
}
function lane(assessment: Assessment, profile: string, operation = 'collect') {
  const value = assessment.lanes.find(row => row.profile_id === profile && row.operation === operation);
  if (!value) throw new Error('fixture_lane_required');
  return value;
}
async function sourceFixture() {
  const directory = await mkdtemp(join(realpathSync(tmpdir()), 'tool-update-test-'));
  temporary.push(directory);
  for (const path of sourcePathAllowlist) {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await copyFile(join(root, path), join(directory, path));
  }
  await symlink(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir');
  return directory;
}

test('projects the actual current source without Store or private paths', async () => {
  const snapshot = await withSourceSnapshot(root, source => ({
    windows: source.windows, lanes: sourceLanes(source),
    child: source.resolve('codex', '0.160.0', 'codex_workflow', 'codex-workflow-direct-child-v1'),
  }));
  expect(snapshot.value.windows).toContainEqual({
    product: 'codex', source: 'file', base: '0.158.0', upper_exclusive: '0.164.0', profile_id: 'codex-file-checkpoint-v1',
  });
  expect(snapshot.value.child?.state).toBe('verified');
  expect(snapshot.source_paths).toContain('src/codex-admissions.json');
  expect(snapshot.source_paths).not.toContain('src/store.ts');
  expect(snapshot.source_paths.every(path => sourcePathAllowlist.includes(path))).toBe(true);
  expect(snapshot.value.lanes.every(row => laneSchema.safeParse(row).success)).toBe(true);
});

test.each([
  ['codex', '0.163.999', 'codex-file-checkpoint-v1', 'inherited'],
  ['codex', '0.164.0', 'codex-file-checkpoint-v1', 'unsupported'],
  ['codex', '0.165.0', 'codex-file-checkpoint-v1', 'unsupported'],
  ['claude_code', '2.1.999', 'claude-file-message-components-v1', 'inherited'],
  ['claude_code', '2.2.0', 'claude-file-message-components-v1', 'unsupported'],
] as const)('uses current finite windows for %s %s', async (product, target, profile, expected) => {
  const result = await assessCandidate(fixture(product, [target]));
  expect(lane(result, profile).static_selection).toBe(expected);
  expect(lane(result, profile).review.coverage).toBe('baseline_missing');
});

test('keeps exact root and child profiles separate before selecting windows', async () => {
  const result = await assessCandidate(fixture('codex', ['0.160.0']));
  expect(lane(result, 'codex-workflow-own-response-v1', 'launch').static_selection).toBe('exact');
  expect(lane(result, 'codex-workflow-direct-child-v1', 'launch')).toMatchObject({
    static_selection: 'exact', topology: 'root_direct_child', declared_scope: { read_only: true, max_members: 2 },
  });
  expect(lane(result, 'codex-workflow-direct-child-v1', 'resume').static_selection).toBe('unsupported');
  expect(lane(result, 'codex-workflow-direct-child-v1', 'link').static_selection).toBe('unsupported');
});

test.each(['2.1.296', '2.1.301'])('preserves exact-only Claude child and resume for %s', async target => {
  const result = await assessCandidate(fixture('claude_code', [target]));
  expect(lane(result, 'claude-workflow-own-trace-v1', 'launch').static_selection).toBe(target === '2.1.296' ? 'exact' : 'inherited');
  expect(lane(result, 'claude-workflow-own-trace-v1', 'resume').static_selection).toBe(target === '2.1.296' ? 'exact' : 'unsupported');
  expect(lane(result, 'claude-workflow-direct-child-v1', 'launch').static_selection).toBe(target === '2.1.296' ? 'exact' : 'unsupported');
  expect(lane(result, 'claude-workflow-direct-child-v1', 'resume').static_selection).toBe('unsupported');
});

test('ordinary profiles are exact-only even when their compatibility state is unverified', async () => {
  const result = await assessCandidate(fixture('claude_code', ['2.1.306']));
  expect(lane(result, 'claude-binding-2-1-306-family-v1', 'link')).toMatchObject({
    static_selection: 'exact', compatibility: { state: 'compatibility_unverified' }, declared_scope: { exact_only: true },
  });
  expect(lane(result, 'claude-binding-2-1-301-family-v1', 'link').static_selection).toBe('unsupported');
  expect(lane(result, 'claude-binding-2-1-306-family-v1', 'resume').static_selection).toBe('unsupported');
  expect(lane(result, 'claude-workflow-direct-child-v1', 'launch').review.parser_comparison?.from_version).toBe('2.1.296');
});
test.each(['2.1.288', '2.1.291'])('retired Claude workflow %s is distinct from an unreviewed newer version', async target => {
  const result = await assessCandidate(fixture('claude_code', [target]));
  expect(lane(result, 'claude-workflow-own-trace-v1', 'launch').reasons).toContain('retired');
  expect(lane(result, 'claude-workflow-own-trace-v1', 'launch').static_selection).toBe('unsupported');
});
test('historical ordinary profiles remain explicit lanes after default changes', async () => {
  const result = await assessCandidate(fixture('claude_code', ['2.1.306']));
  expect(lane(result, 'claude-binding-02196-family-v1', 'link').static_selection).toBe('unsupported');
  expect(lane(result, 'claude-binding-2-1-301-family-v1', 'link').static_selection).toBe('unsupported');
  expect(lane(result, 'claude-binding-2-1-306-family-v1', 'link').static_selection).toBe('exact');
});

test('pins every adjacent review edge and keeps parser cumulative review separate', async () => {
  const result = await assessCandidate({ ...fixture('codex', ['0.162.1', '0.162.2', '0.163.0']), baseline: baseline() });
  const review = lane(result, 'codex-file-checkpoint-v1').review;
  expect(review.edges.map(edge => [edge.from.version, edge.to.version])).toEqual([
    ['0.162.1', '0.162.2'], ['0.162.2', '0.163.0'],
  ]);
  expect(review.edges.every(edge => edge.from.commit.length === 40 && edge.contracts.every(row => row.judgment === 'unknown'))).toBe(true);
  expect(review.parser_comparison?.from_version).toBe('0.158.0');
  expect(lane(result, 'codex-file-checkpoint-v1').reasons).toContain('minor_transition');
  expect(lane(result, 'codex-workflow-own-response-v1', 'launch').review.coverage).toBe('baseline_missing');
  expect(result.review_sources).toHaveLength(6);
  expect(result.review_sources.map(row => row.commit)).toEqual([
    '1'.repeat(40), '1'.repeat(40), '2'.repeat(40), '2'.repeat(40), '3'.repeat(40), '3'.repeat(40),
  ]);
  expect(result.review_sources.every(row => row.availability === 'not_assessed')).toBe(true);
});

test('equal baseline has no interval but does not pass review or runtime gates', async () => {
  const result = await assessCandidate({ ...fixture(), baseline: baseline('0.163.0') });
  const selected = lane(result, 'codex-file-checkpoint-v1');
  expect(selected.review.edges).toEqual([]);
  expect(selected.review.releases).toEqual([]);
  expect(selected.gates.contracts_reviewed).toBe('unknown');
  expect(Object.values(selected.live)).toEqual(Array<string>(5).fill('not_assessed'));
  expect(Object.values(selected.gates).slice(1).every(value => value === 'not_assessed')).toBe(true);
});

test('rejects an ahead baseline', async () => {
  await expect(assessCandidate({ ...fixture(), baseline: baseline('0.164.0') })).rejects.toMatchObject({ code: 'baseline_ahead' });
});
test('rejects missing pinned baseline history', async () => {
  await expect(assessCandidate({ ...fixture(), baseline: baseline() })).rejects.toMatchObject({ code: 'discovery_incomplete' });
});
test('rejects unknown ordinary profiles before using baseline coverage', async () => {
  const input = baseline();
  const row = input.rows[0];
  if (!row) throw new Error('fixture_row_required');
  await expect(validateBaselineForSource({ ...input, rows: [{ ...row,
    route: 'codex_binding', profile_id: 'codex-binding-09999-direct-family-v1',
  }] }, root)).rejects.toMatchObject({ code: 'invalid_baseline' });
});
test('rejects permanently unsupported child resume baseline keys', async () => {
  await expect(validateBaselineForSource({ schema_version: 1, kind: 'baseline', rows: [{
    product: 'codex', route: 'codex_workflow', profile_id: 'codex-workflow-direct-child-v1',
    operation: 'resume', topology: 'root_direct_child', last_reviewed_version: '0.160.0',
    contract_revision: 'consumed-v1', evidence_ids: ['a'.repeat(64)], source_digest: 'b'.repeat(64),
  }] }, root)).rejects.toMatchObject({ code: 'invalid_baseline' });
});
test.each(['candidate_id', 'product', 'commit', 'heads'] as const)('rejects candidate-observation %s mismatch before source IO', async field => {
  const input = fixture();
  const observation = field === 'commit' ? { ...input.observation, releases: input.observation.releases.map(row => ({ ...row, commit: 'f'.repeat(40) })) }
    : field === 'product' ? { ...input.observation, product: 'claude_code', releases: input.observation.releases.map(row => ({ ...row, tag: `v${row.version}` })) }
    : field === 'heads' ? { ...input.observation, heads: { github: '0.162.0', npm_latest: '0.163.0', npm_stable: '0.163.0' } }
    : { ...input.observation, candidate_id: 'f'.repeat(64) };
  await expect(assessCandidate({ ...input, observation, root: '/not-read' })).rejects.toMatchObject({ code: 'observation_mismatch' });
});

test('ignores stale dist and responds to current source mutations', async () => {
  const directory = await sourceFixture();
  const before = await assessCandidate({ ...fixture('codex', ['0.164.0']), root: directory });
  await mkdir(join(directory, 'dist'));
  await writeFile(join(directory, 'dist/source-compatibility.js'), 'throw new Error("must_not_load_dist")');
  const path = join(directory, 'src/source-compatibility.ts');
  await writeFile(path, (await readFile(path, 'utf8')).replaceAll("upper_exclusive: '0.164.0'", "upper_exclusive: '0.165.0'"));
  const after = await assessCandidate({ ...fixture('codex', ['0.164.0']), root: directory });
  expect(lane(before, 'codex-file-checkpoint-v1').static_selection).toBe('unsupported');
  expect(lane(after, 'codex-file-checkpoint-v1').static_selection).toBe('inherited');
  expect(after.source_digest).not.toBe(before.source_digest);
});

test('rejects drift between compilation and projection completion', async () => {
  const directory = await sourceFixture();
  await expect(withSourceSnapshot(directory, async source => {
    await writeFile(join(directory, 'src/codex-admissions.json'), '[]');
    return source.windows.length;
  })).rejects.toMatchObject({ code: 'source_drift' });
});
test('rejects a runtime Store import without opening its body', async () => {
  const directory = await sourceFixture();
  const path = join(directory, 'src/source-compatibility.ts');
  await writeFile(path, `import './store.js';\n${await readFile(path, 'utf8')}`);
  await writeFile(join(directory, 'src/store.ts'), 'throw new Error("private_database_must_not_open")');
  await expect(assessCandidate({ ...fixture(), root: directory })).rejects.toMatchObject({ code: 'source_snapshot_unavailable' });
});
test('changed imperative operation contracts require a new scope review', async () => {
  const directory = await sourceFixture();
  const path = join(directory, 'src/codex-workflow-adapter.ts');
  await writeFile(path, `${await readFile(path, 'utf8')}\nexport const changedScope = true;\n`);
  await expect(assessCandidate({ ...fixture(), root: directory })).rejects.toMatchObject({ code: 'source_scope_changed' });
});
test('new filesystem-capable builtins cannot enter the static registry closure', async () => {
  const directory = await sourceFixture();
  const path = join(directory, 'src/source-compatibility.ts');
  await writeFile(path, `import 'node:sqlite';\n${await readFile(path, 'utf8')}`);
  await expect(assessCandidate({ ...fixture(), root: directory })).rejects.toMatchObject({ code: 'source_snapshot_unavailable' });
});
test('rejects lockfile and package disagreement instead of using dist', async () => {
  const directory = await sourceFixture();
  const path = join(directory, 'package.json');
  await writeFile(path, (await readFile(path, 'utf8')).replace('"typescript": "6.0.3"', '"typescript": "6.0.2"'));
  await expect(assessCandidate({ ...fixture(), root: directory })).rejects.toMatchObject({ code: 'source_snapshot_unavailable' });
});
test('strict portable assessment rejects private fields and invented gate passes', async () => {
  const result = await assessCandidate(fixture());
  const first = result.lanes[0];
  if (!first) throw new Error('fixture_lane_required');
  expect(assessmentSchema.safeParse({ ...result, private_path: '/SECRET' }).success).toBe(false);
  expect(assessmentSchema.safeParse({ ...result, lanes: [{ ...first, live: { ...first.live, source: '/SECRET' } }] }).success).toBe(false);
  expect(assessmentSchema.safeParse({ ...result, lanes: [{ ...first, gates: { ...first.gates, conformance: 'pass' } }] }).success).toBe(false);
  expect(assessmentSchema.safeParse({ ...result, source_paths: ['../SECRET'] }).success).toBe(false);
});
