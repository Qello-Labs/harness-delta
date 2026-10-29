import { z } from 'zod';
import { compareVersions, digest, fail, parseBaseline, versionSchema } from './manifest.mjs';
import { candidateSchema, observationSchema, discoveryReasonCodes, products, positiveInteger,
  integritySchema, commitSchema, versionFromTag, recordFits } from './discovery-records.mjs';
import { transport } from './discovery-transport.mjs';
export { candidateSchema, observationSchema, discoveryReasonCodes };

const configurations = {
  codex: { repository: 'openai/codex', package: '@openai/codex' },
  claude_code: { repository: 'anthropics/claude-code', package: '@anthropic-ai/claude-code' },
};
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const mismatchReasons = new Set(['npm_latest_mismatch', 'stable_head_mismatch']);

function addRelease(map, identities, row) {
  const previous = map.get(row.version);
  if (previous && (previous.release_id !== row.release_id || previous.tag !== row.tag)) fail('metadata_conflict');
  const identity = identities.get(row.release_id);
  if (identity !== undefined && identity !== row.version) fail('metadata_conflict');
  identities.set(row.release_id, row.version);
  map.set(row.version, row);
}

function projectRelease(row, product) {
  if (!object(row) || typeof row.draft !== 'boolean' || typeof row.prerelease !== 'boolean' ||
      row.draft || row.prerelease || !positiveInteger.safeParse(row.id).success) fail('metadata_invalid');
  const version = versionFromTag(product, row.tag_name);
  if (version === null) fail('metadata_invalid');
  return { version, release_id: row.id, tag: row.tag_name };
}

async function githubLatest(io, product, repository) {
  const { body: metadata } = await io.get(`https://api.github.com/repos/${repository}`, 'github_repository', '1');
  if (!object(metadata) || metadata.full_name !== repository || !positiveInteger.safeParse(metadata.id).success)
    fail('metadata_conflict');
  const identity = { repository, id: metadata.id };
  io.bindRepository(identity);
  const { body } = await io.get(`https://api.github.com/repos/${repository}/releases/latest`, 'github_latest', '1');
  return projectRelease(body, product);
}

async function npmInventory(io, packageName) {
  const url = `https://registry.npmjs.org/${packageName.replace('/', '%2f')}`;
  const { body } = await io.get(url, 'npm', '1');
  if (!object(body) || body.name !== packageName || !object(body.versions) || !object(body['dist-tags'])) fail('metadata_invalid');
  const versions = new Map();
  const entries = Object.entries(body.versions);
  if (entries.length > 10000) fail('item_limit');
  for (const [version, row] of entries) {
    if (!versionSchema.safeParse(version).success) continue;
    if (!object(row) || row.version !== version || row.name !== packageName) fail('metadata_conflict');
    versions.set(version, row);
  }
  const latest = body['dist-tags'].latest;
  return { versions, latest: versionSchema.safeParse(latest).success ? latest : null };
}

async function resolveTag(io, repository, row) {
  const base = `https://api.github.com/repos/${repository}`;
  const { body } = await io.get(`${base}/git/ref/tags/${row.tag}`, 'github_tag', row.version);
  if (!object(body) || body.ref !== `refs/tags/${row.tag}` || !object(body.object)) fail('tag_invalid');
  let target = body.object;
  const seen = new Set();
  for (let depth = 0; depth <= 8; depth++) {
    if (!commitSchema.safeParse(target.sha).success) fail('tag_invalid');
    if (seen.has(target.sha)) fail('tag_cycle');
    seen.add(target.sha);
    if (target.type === 'commit') return target.sha;
    if (target.type !== 'tag') fail('tag_invalid');
    if (depth === 8) fail('tag_depth_limit');
    const { body: tag } = await io.get(`${base}/git/tags/${target.sha}`, 'github_tag', row.version);
    if (!object(tag) || tag.sha !== target.sha || !object(tag.object)) fail('tag_invalid');
    target = tag.object;
  }
  return fail('tag_depth_limit');
}

export async function discover(product, options = {}) {
  if (!products.safeParse(product).success) fail('invalid_product');
  const { fetchImpl = fetch, now = () => new Date().toISOString(), baseline = null } = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  timeout.unref();
  const io = transport(fetchImpl, now, controller.signal);
  const observation = {
    schema_version: 2, kind: 'observation', inventory_scope: 'latest_and_npm_review_range',
    product, checked_at: new Date().toISOString(),
    result: 'discovery_incomplete', reasons: [],
    heads: { github: null, npm_latest: null, npm_stable: null },
    checks: [], releases: [], candidate_id: null,
  };
  let candidate;
  try {
    observation.checked_at = io.stamp();
    let reviewed = null;
    if (baseline !== null) {
      try { reviewed = parseBaseline(baseline); } catch { fail('baseline_invalid'); }
    }
    const rows = reviewed?.rows.filter(row => row.product === product) ?? [];
    if (rows.length === 0) observation.reasons.push('baseline_missing');
    const configuration = configurations[product];
    const latest = await githubLatest(io, product, configuration.repository);
    const githubHead = latest.version;
    observation.heads.github = githubHead;
    const npm = await npmInventory(io, configuration.package);
    const npmHead = [...npm.versions.keys()].sort(compareVersions).at(-1) ?? null;
    observation.heads.npm_latest = npm.latest;
    observation.heads.npm_stable = npmHead;
    if (githubHead === null) fail('github_empty');
    if (npmHead === null) fail('npm_empty');
    if (npm.latest !== npmHead) fail('npm_latest_mismatch');
    if (githubHead !== npmHead) fail('stable_head_mismatch');
    if (rows.some(row => compareVersions(row.last_reviewed_version, githubHead) > 0)) fail('baseline_ahead');
    const start = rows.map(row => row.last_reviewed_version).sort(compareVersions)[0] ?? githubHead;
    const required = new Set([start, githubHead]);
    if (rows.length > 0) {
      for (const version of npm.versions.keys()) {
        if (compareVersions(version, start) >= 0 && compareVersions(version, githubHead) <= 0) required.add(version);
      }
    }
    if (required.size > 512) fail('reference_limit');
    const releases = new Map(), identities = new Map();
    const prefix = latest.tag.slice(0, -latest.version.length);
    for (const version of [...required].sort(compareVersions)) {
      let release = latest;
      if (version !== githubHead) {
        const tag = `${prefix}${version}`;
        const { body } = await io.get(`https://api.github.com/repos/${configuration.repository}/releases/tags/${tag}`,
          'github_release', version);
        release = projectRelease(body, product);
        if (release.version !== version || release.tag !== tag) fail('metadata_conflict');
      }
      addRelease(releases, identities, release);
      const metadata = npm.versions.get(version);
      if (!metadata) fail('npm_version_missing');
      if (!object(metadata.dist) || !integritySchema.safeParse(metadata.dist.integrity).success) fail('npm_integrity_missing');
      const commit = await resolveTag(io, configuration.repository, release);
      observation.releases.push({ ...release, commit, npm_integrity: metadata.dist.integrity });
    }
    await io.revalidate();
    const target = observation.releases.find(row => row.version === githubHead);
    candidate = candidateSchema.parse({
      schema_version: 1, kind: 'candidate', product, target: githubHead,
      release_id: target.release_id, tag: target.tag, commit: target.commit, npm_integrity: target.npm_integrity,
    });
    observation.result = 'metadata_reconciled';
    observation.candidate_id = digest(candidate);
  } catch (error) {
    const code = controller.signal.aborted ? 'deadline_exceeded' :
      error instanceof Error && 'code' in error && discoveryReasonCodes.includes(error.code) ? error.code :
        error instanceof z.ZodError ? 'metadata_invalid' : 'request_failed';
    observation.reasons.push(code);
    observation.result = code === 'metadata_conflict' ? 'metadata_conflict' :
      mismatchReasons.has(code) ? 'release_mismatch' : 'discovery_incomplete';
    observation.releases = [];
    observation.candidate_id = null;
    candidate = null;
  } finally { clearTimeout(timeout); }
  observation.checks = io.checks();
  observation.reasons = [...new Set(observation.reasons)].sort((a, b) => a.localeCompare(b, 'en'));
  if (!recordFits(observation)) {
    observation.result = 'discovery_incomplete';
    observation.reasons = ['record_limit'];
    observation.checks = [];
    observation.releases = [];
    observation.candidate_id = null;
    candidate = null;
  }
  return { candidate, observation: observationSchema.parse(observation) };
}
