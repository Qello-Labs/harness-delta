import { createHash } from 'node:crypto';
import { differenceJob } from './tool-update-difference-fixture.js';
import { parseDifferenceJob } from '../../scripts/tool-update/difference-records.mjs';
import type { SyntheticReplay, SyntheticRequest } from '../../scripts/tool-update/difference-fixtures.mjs';

export function claudeJob() {
  const base = differenceJob();
  const lane = {
    product: 'claude_code',
    route: 'claude_binding',
    profile_id: 'claude-binding-root-window-v1',
    operation: 'collect',
    topology: 'root'
  } as const;
  const releases = [306, 307, 308].map((patch, index) => ({
    version: `2.1.${patch}`,
    commit: String(index + 1).repeat(40)
  }));
  const first = releases[0],
    last = releases[2];
  if (!first || !last || !base.baseline_row) {
    throw new Error('synthetic_inventory_invalid');
  }
  return parseDifferenceJob({
    ...base,
    lane,
    repository_id: 'anthropics_claude_code',
    baseline_row: { ...base.baseline_row, ...lane, ref: first },
    parser_base: { ...first, profile_id: lane.profile_id },
    target: last,
    comparison: {
      comparison_kind: 'adjacent_release',
      from: first,
      to: last
    },
    inventory: { ...base.inventory, releases }
  });
}
export const privateMarker = 'SYNTHETIC-PRIVATE-NEVER-RETAIN';
export function documentationWire(
  options: {
    readonly lines?: Readonly<Record<string, string>>;
    readonly annotated?: boolean;
    readonly rewrite?: (url: URL, attempt: number, response: Response) => Response | Promise<Response>;
  } = {}
) {
  const job = claudeJob();
  const bodies = new Map<string, string>();
  const blobs = new Map<string, string>();
  const json = (value: unknown) => JSON.stringify(value);
  const repository = '/repos/anthropics/claude-code';
  bodies.set(
    repository,
    json({
      id: 937253475,
      name: 'claude-code',
      full_name: 'anthropics/claude-code',
      owner: { login: 'anthropics', id: 76263028 },
      fork: false
    })
  );
  bodies.set(`${repository}/contents/CHANGELOG.md`, privateMarker);
  for (const ref of job.inventory.releases) {
    const content = [...job.inventory.releases]
      .reverse()
      .filter(row => row.version <= ref.version)
      .map(row => `## ${row.version}\n${options.lines?.[row.version] ?? '- synthetic maintenance'}\n`)
      .join('\n');
    const blob = createHash('sha1')
      .update(`blob ${Buffer.byteLength(content)}\0`)
      .update(content)
      .digest('hex');
    blobs.set(blob, content);
    const tag = `v${ref.version}`,
      tagSha = createHash('sha1').update(tag).digest('hex');
    bodies.set(
      `${repository}/git/ref/tags/${tag}`,
      json({
        ref: `refs/tags/${tag}`,
        object: {
          type: options.annotated ? 'tag' : 'commit',
          sha: options.annotated ? tagSha : ref.commit
        }
      })
    );
    bodies.set(
      `${repository}/git/tags/${tagSha}`,
      json({
        sha: tagSha,
        tag,
        object: { type: 'commit', sha: ref.commit }
      })
    );
    bodies.set(
      `${repository}/git/trees/${ref.commit}`,
      json({
        sha: ref.commit,
        truncated: false,
        tree: [
          {
            path: 'CHANGELOG.md',
            mode: '100644',
            type: 'blob',
            sha: blob
          }
        ]
      })
    );
  }
  for (const [sha, text] of blobs) {
    bodies.set(`${repository}/git/blobs/${sha}`, text);
  }
  const counts = new Map<string, number>();
  const calls: URL[] = [];
  const fetchImpl = async (value: string) => {
    const url = new URL(value);
    calls.push(url);
    const path = url.pathname.replace('/repositories/937253475', repository);
    const attempt = (counts.get(path) ?? 0) + 1;
    counts.set(path, attempt);
    const body = bodies.get(path);
    const response = body === undefined ? new Response(null, { status: 404 }) : new Response(body);
    return options.rewrite ? options.rewrite(url, attempt, response) : response;
  };
  return { job, fetchImpl, calls, counts };
}
export function syntheticRequest(request = 1): SyntheticRequest {
  return {
    request,
    message: request,
    owner: 'root',
    terminal: true,
    excluded: false,
    counters: {
      input: 135,
      output: 111,
      cached: 23,
      cache_write: 11,
      reasoning: null
    }
  };
}
export function syntheticRun(): SyntheticReplay {
  const row = syntheticRequest();
  return {
    fixture_id: 'parser_provider_v1',
    scenario_id: 'unchanged',
    test_hash: '1'.repeat(64),
    harness_hash: '2'.repeat(64),
    input_hash: '3'.repeat(64),
    expected: [row],
    actual: [row]
  };
}
