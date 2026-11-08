import { createHash } from 'node:crypto';
import { codexSourcePaths } from '../../scripts/tool-update/difference-contracts.mjs';
import type { DifferenceJob } from '../../scripts/tool-update/difference-records.mjs';
import type { collectCodexSourceEvidence } from '../../scripts/tool-update/difference-source.mjs';
import { differenceJob } from './tool-update-difference-fixture.js';

export const sourcePrivateText = 'SYNTHETIC_PRIVATE_MATERIAL';
export const sourceJson = (value: unknown) => new Response(JSON.stringify(value));
const syntheticOid = (value: string) => createHash('sha1').update(value).digest('hex');
export const syntheticSchema = () => ({
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  additionalProperties: false,
  properties: {
    model: { type: 'string', description: sourcePrivateText },
    model_reasoning_effort: { $ref: '#/definitions/Effort' },
    sandbox_mode: { allOf: [{ $ref: '#/definitions/Permission' }] }
  },
  definitions: {
    Effort: { type: 'string', enum: ['low', 'high'] },
    Permission: { type: 'string', enum: ['read-only', 'workspace-write'] }
  }
});
export interface SourceFixtureOptions {
  readonly job?: DifferenceJob;
  readonly annotated?: boolean;
  readonly etag?: boolean;
  readonly change?: (version: string, files: Map<string, { readonly type: 'tree' | 'blob'; readonly value: string }>) => void;
  readonly rewrite?: (url: URL, attempt: number, response: Response, init: RequestInit) => Response | Promise<Response>;
}
export function sourceFixture(options: SourceFixtureOptions = {}) {
  const job = options.job ?? differenceJob();
  const responses = new Map<string, unknown>();
  const blobs = new Map<string, string>();
  const prefix = '/repos/openai/codex';
  responses.set(prefix, {
    id: 965415649,
    name: 'codex',
    full_name: 'openai/codex',
    owner: { id: 14957082, login: 'openai' },
    fork: false,
    description: sourcePrivateText
  });
  for (const ref of job.inventory.releases) {
    const files = new Map(
      Object.values(codexSourcePaths).map(({ path, type }) => [
        path,
        {
          type,
          value: path.endsWith('config.schema.json') ? JSON.stringify(syntheticSchema()) : syntheticOid(path)
        }
      ])
    );
    files.set('README.md', { type: 'blob', value: sourcePrivateText });
    for (const path of [...files.keys()]) {
      const parts = path.split('/');
      for (let depth = 1; depth < parts.length; depth++) {
        const parent = parts.slice(0, depth).join('/');
        if (!files.has(parent)) {
          files.set(parent, {
            type: 'tree',
            value: syntheticOid(parent)
          });
        }
      }
    }
    options.change?.(ref.version, files);
    const entries = new Map<
      string,
      {
        readonly path: string;
        readonly type: 'tree' | 'blob';
        readonly mode: string;
        readonly sha: string;
      }[]
    >();
    const ordered = [...files].sort(([a], [b]) => b.split('/').length - a.split('/').length);
    for (const [path, file] of ordered) {
      const slash = path.lastIndexOf('/');
      const parent = slash < 0 ? '' : path.slice(0, slash);
      const name = path.slice(slash + 1);
      const children = entries.get(path) ?? [];
      const sha =
        file.type === 'tree'
          ? syntheticOid(JSON.stringify([file.value, children]))
          : createHash('sha1')
              .update(`blob ${Buffer.byteLength(file.value)}\0`)
              .update(file.value)
              .digest('hex');
      if (file.type === 'tree') {
        responses.set(`${prefix}/git/trees/${sha}`, {
          sha,
          truncated: false,
          tree: children
        });
      } else blobs.set(`${prefix}/git/blobs/${sha}`, file.value);
      const siblings = entries.get(parent) ?? [];
      siblings.push({
        path: name,
        type: file.type,
        mode: file.type === 'tree' ? '040000' : '100644',
        sha
      });
      entries.set(parent, siblings);
    }
    responses.set(`${prefix}/git/trees/${ref.commit}`, {
      sha: ref.commit,
      truncated: false,
      tree: entries.get('')
    });
    const tag = `rust-v${ref.version}`;
    const tagSha = syntheticOid(tag);
    responses.set(`${prefix}/git/ref/tags/${tag}`, {
      ref: `refs/tags/${tag}`,
      object: {
        type: options.annotated ? 'tag' : 'commit',
        sha: options.annotated ? tagSha : ref.commit
      }
    });
    if (options.annotated) {
      responses.set(`${prefix}/git/tags/${tagSha}`, {
        sha: tagSha,
        tag,
        object: { type: 'commit', sha: ref.commit }
      });
    }
  }
  const counts = new Map<string, number>();
  const calls: { readonly url: URL; readonly init: RequestInit }[] = [];
  const fetchImpl: Parameters<typeof collectCodexSourceEvidence>[1]['fetch'] = async (input, init) => {
    const url = new URL(input);
    calls.push({ url, init });
    const attempt = (counts.get(input) ?? 0) + 1;
    counts.set(input, attempt);
    const path = url.pathname.replace('/repositories/965415649', prefix);
    let response: Response;
    if (options.etag && new Headers(init.headers).has('if-none-match')) response = new Response(null, { status: 304 });
    else if (blobs.has(path)) response = new Response(blobs.get(path));
    else if (responses.has(path)) {
      response = sourceJson(responses.get(path));
    } else response = new Response(null, { status: 404 });
    if (options.etag && response.status === 200) {
      response.headers.set('etag', '"synthetic-etag"');
    }
    return options.rewrite ? options.rewrite(url, attempt, response, init) : response;
  };
  return { job, fetchImpl, calls, counts };
}
