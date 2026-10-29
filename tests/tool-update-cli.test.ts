import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, test } from 'vitest';
import { runToolUpdate } from '../scripts/tool-update.mjs';
import { digest } from '../scripts/tool-update/manifest.mjs';
import { candidateSchema, observationSchema } from '../scripts/tool-update/discovery.mjs';
import { assessmentSchema } from '../scripts/tool-update/assessment.mjs';

const roots: string[] = [];
const checkedAt = '2026-10-24T00:00:00.000Z';
const integrity = `sha512-${Buffer.alloc(64, 1).toString('base64')}`;
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function temporaryRoot() {
  const root = await mkdtemp(join(realpathSync(tmpdir()), 'tool-update-cli-'));
  roots.push(root); return root;
}
const releases = [
  { id: 101, tag_name: 'rust-v0.163.0', draft: false, prerelease: false },
  { id: 100, tag_name: 'rust-v0.162.0', draft: false, prerelease: false },
];
function transport(mismatch = false): typeof fetch {
  return input => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === 'registry.npmjs.org') {
      const target = mismatch ? '0.164.0' : '0.163.0';
      return Promise.resolve(Response.json({ name: '@openai/codex', 'dist-tags': { latest: target }, versions: {
        '0.162.0': { name: '@openai/codex', version: '0.162.0', dist: { integrity } },
        [target]: { name: '@openai/codex', version: target, dist: { integrity } },
      } }));
    }
    if (url.pathname === '/repos/openai/codex')
      return Promise.resolve(Response.json({ id: 42, full_name: 'openai/codex' }));
    if (url.pathname.endsWith('/releases/latest')) return Promise.resolve(Response.json(releases[0]));
    if (url.pathname.includes('/git/ref')) return Promise.resolve(Response.json({
      ref: `refs/tags/${decodeURIComponent(url.pathname.split('/').at(-1) ?? '')}`,
      object: { type: 'commit', sha: 'a'.repeat(40) },
    }));
    return Promise.reject(new Error('synthetic-private HTTP error /Users/synthetic/private'));
  };
}
test('local discovery publishes candidate then a matching completion observation', async () => {
  const root = await temporaryRoot();
  const result = await runToolUpdate(['discover', '--product', 'codex', '--out', root],
    { fetchImpl: transport(), now: () => checkedAt });
  expect(result.exitCode).toBe(0);
  const candidateNames = await readdir(join(root, 'candidates'));
  const observationNames = await readdir(join(root, 'observations'));
  const candidate = candidateSchema.parse(JSON.parse(await readFile(join(root, 'candidates', candidateNames[0] ?? ''), 'utf8')));
  const observation = observationSchema.parse(JSON.parse(await readFile(join(root, 'observations', observationNames[0] ?? ''), 'utf8')));
  expect(result.output).toMatchObject({ status: 'metadata_reconciled', candidate_id: digest(candidate),
    observation_id: digest(observation) });
  expect(observation.candidate_id).toBe(digest(candidate));
  expect(candidate.target).toBe('0.163.0');
  expect(JSON.stringify(observation)).not.toContain(root);
});
test('a failed requery records failure rather than reporting prior success', async () => {
  const root = await temporaryRoot();
  const args = ['discover', '--product', 'codex', '--out', root];
  await runToolUpdate(args, { fetchImpl: transport(), now: () => checkedAt });
  const failure = await runToolUpdate(args, { fetchImpl: transport(true), now: () => '2026-10-24T00:01:00.000Z' });
  expect(failure.exitCode).toBe(2);
  expect(failure.output).toMatchObject({ status: 'release_mismatch', candidate_id: null });
  expect(await readdir(join(root, 'candidates'))).toHaveLength(1);
  expect(await readdir(join(root, 'observations'))).toHaveLength(2);
});
test('query time changes observations without retargeting a candidate', async () => {
  const root = await temporaryRoot();
  const args = ['discover', '--product', 'codex', '--out', root];
  const first = await runToolUpdate(args, { fetchImpl: transport(), now: () => checkedAt });
  const second = await runToolUpdate(args, { fetchImpl: transport(), now: () => '2026-10-24T00:01:00.000Z' });
  expect(first.exitCode).toBe(0); expect(second.exitCode).toBe(0);
  expect(first.output.candidate_id).toBe(second.output.candidate_id);
  expect(first.output.observation_id).not.toBe(second.output.observation_id);
});
test('network exceptions cannot leak their messages into diagnostics', async () => {
  const root = await temporaryRoot();
  const result = await runToolUpdate(['discover', '--product', 'codex', '--out', root], {
    fetchImpl: () => Promise.reject(new Error('synthetic-secret /Users/synthetic/private')),
    now: () => checkedAt,
  });
  expect(result.exitCode).toBe(2);
  expect(result.output.status).toBe('discovery_incomplete');
  const files = await readdir(join(root, 'observations'));
  const record = await readFile(join(root, 'observations', files[0] ?? ''), 'utf8');
  expect(record).not.toContain('synthetic-secret');
  expect(record).not.toContain('/Users/');
});
test('assessment CLI writes a source-fresh static result without granting support', async () => {
  const root = await temporaryRoot();
  const discovered = await runToolUpdate(['discover', '--product', 'codex', '--out', root],
    { fetchImpl: transport(), now: () => checkedAt });
  const result = await runToolUpdate(['assess',
    '--manifest', join(root, 'candidates', `${discovered.output.candidate_id}.json`),
    '--observation', join(root, 'observations', `${discovered.output.observation_id}.json`)]);
  expect(result.exitCode).toBe(0);
  expect(result.output.status).toBe('assessment_created');
  const raw: unknown = JSON.parse(await readFile(join(root, 'assessments', `${result.output.assessment_id}.json`), 'utf8'));
  const record = assessmentSchema.parse(raw);
  expect(record).toMatchObject({ schema_version: 2, inventory_scope: 'latest_and_npm_review_range' });
  expect(record.baseline_digest).toBeNull();
  expect(record.lanes.every(lane => lane.review.coverage === 'baseline_missing' &&
    lane.gates.contracts_reviewed === 'unknown' && lane.gates.admission === 'not_assessed')).toBe(true);
});
test('failed completion publication cannot turn an orphan candidate into a success', async () => {
  const root = await temporaryRoot();
  const outside = await temporaryRoot();
  await symlink(outside, join(root, 'observations'));
  const result = await runToolUpdate(['discover', '--product', 'codex', '--out', root],
    { fetchImpl: transport(), now: () => checkedAt });
  expect(result).toEqual({ exitCode: 2, output: { status: 'unsafe_output' } });
  expect(await readdir(join(root, 'candidates'))).toHaveLength(1);
  expect(await readdir(outside)).toEqual([]);
});
test('invalid baseline fields fail before network access and never leak input', async () => {
  const root = await temporaryRoot();
  const path = join(root, 'baseline.json');
  await writeFile(path, JSON.stringify({ schema_version: 1, kind: 'baseline', rows: [], secret: 'synthetic-secret' }));
  let fetched = false;
  const result = await runToolUpdate(['discover', '--product', 'codex', '--out', root, '--baseline', path], {
    fetchImpl: () => { fetched = true; return Promise.reject(new Error('unexpected_fetch')); },
  });
  expect(result).toEqual({ exitCode: 2, output: { status: 'invalid_baseline' } });
  expect(fetched).toBe(false);
});
test.each([
  [], ['--untrusted', 'synthetic-secret'], ['discover', '--product', 'codex'],
  ['assess', '--manifest', '/Users/synthetic/private'],
].map(args => ({ args })))('invalid command arguments have fixed diagnostics', async ({ args }) => {
  expect(await runToolUpdate(args)).toEqual({ exitCode: 2, output: { status: 'invalid_arguments' } });
});
test('the actual Node CLI writes only to its chosen output outside an isolated source copy', async () => {
  const root = await temporaryRoot();
  const loader = join(root, 'transport.mjs');
  // A self-contained loader avoids importing test-runner code into the child.
  await writeFile(loader, `const integrity=${JSON.stringify(integrity)};
const releases=${JSON.stringify(releases)};
globalThis.fetch=(${transport.toString()})();\n`);
  const project = join(root, 'project');
  await mkdir(join(project, 'scripts'), { recursive: true });
  await cp('scripts/tool-update', join(project, 'scripts/tool-update'), { recursive: true });
  await cp('scripts/tool-update.mjs', join(project, 'scripts/tool-update.mjs'));
  await symlink(realpathSync('node_modules'), join(project, 'node_modules'), 'dir');
  const inventory = async () => {
    const items: string[][] = [];
    const walk = async (directory: string) => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isSymbolicLink()) items.push([path, 'symlink']);
        else if (entry.isDirectory()) { items.push([path, 'directory']); await walk(path); }
        else items.push([path, digest(await readFile(path))]);
      }
    };
    await walk(project);
    return items.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  };
  const execute = promisify(execFile);
  const before = await inventory();
  const { stdout, stderr } = await execute(process.execPath, ['--import', loader, join(project, 'scripts/tool-update.mjs'),
    'discover', '--product', 'codex', '--out', join(root, 'output')], { timeout: 30_000, cwd: project });
  const output: unknown = JSON.parse(stdout);
  expect(output).toMatchObject({ status: 'metadata_reconciled' });
  expect(stderr).toBe('');
  expect(await inventory()).toEqual(before);
});
