import type { DiscoveryOptions, Product } from '../scripts/tool-update/discovery.mjs';

export const checkedAt = '2026-10-24T00:00:00.000Z';
export const commit = 'a'.repeat(40);
export const integrity = `sha512-${Buffer.alloc(64, 1).toString('base64')}`;
export const privateText = 'SYNTHETIC_SECRET /private/session prompt response';
export const now = () => checkedAt;
export const json = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json', ...headers } });

export function release(version: string, product: Product = 'codex', id = Number(version.split('.')[2]) + 1) {
  return { id, tag_name: `${product === 'codex' ? 'rust-v' : 'v'}${version}`, draft: false, prerelease: false, body: privateText };
}
export function baseline(version: string) {
  return {
    schema_version: 1, kind: 'baseline',
    rows: [{
      product: 'codex', route: 'file', profile_id: 'codex-file-checkpoint-v1',
      operation: 'collect', topology: 'root', last_reviewed_version: version,
      contract_revision: 'consumed-v1', evidence_ids: ['b'.repeat(64)], source_digest: 'c'.repeat(64),
    }],
  };
}

export interface FixtureOptions {
  readonly product?: Product;
  readonly pages?: readonly (readonly unknown[])[];
  readonly versions?: readonly string[];
  readonly latest?: string;
  readonly githubLatest?: unknown;
  readonly etag?: string | null;
  readonly rewrite?: (url: URL, attempt: number, init: RequestInit | undefined, response: Response) => Response | Promise<Response>;
}
export function fixture(options: FixtureOptions = {}) {
  const product = options.product ?? 'codex';
  const packageName = product === 'codex' ? '@openai/codex' : '@anthropic-ai/claude-code';
  const repository = product === 'codex' ? 'openai/codex' : 'anthropics/claude-code';
  const versions = options.versions ?? ['1.0.1', '1.0.2', '1.0.10'];
  const pages = options.pages ?? [versions.map(version => release(version, product))];
  const rows = pages.flat();
  const githubLatest = options.githubLatest === undefined ? rows.find(row => typeof row === 'object' && row !== null &&
    'tag_name' in row && ['rust-v1.0.10', 'v1.0.10', '1.0.10'].includes(String(row.tag_name))) ?? rows[0] : options.githubLatest;
  const etag = options.etag === undefined ? '"opaque-validator"' : options.etag;
  const calls: { url: string; conditional: string | null; signal: AbortSignal | null | undefined }[] = [];
  const counts = new Map<string, number>();
  const npmBody = {
    name: packageName, 'dist-tags': { latest: options.latest ?? '1.0.10' },
    versions: Object.fromEntries(versions.map(version => [version, {
      name: packageName, version, dist: { integrity, tarball: privateText }, description: privateText,
    }])),
    readme: privateText,
  };
  const fetchImpl: NonNullable<DiscoveryOptions['fetchImpl']> = async (input, init) => {
    const url = new URL(input);
    const attempt = (counts.get(input) ?? 0) + 1;
    counts.set(input, attempt);
    const conditional = new Headers(init?.headers).get('if-none-match');
    calls.push({ url: input, conditional, signal: init?.signal });
    let response: Response;
    const headers: Record<string, string> = etag === null ? {} : { etag };
    if (conditional !== null) response = new Response(null, { status: 304 });
    else if (url.host === 'registry.npmjs.org') response = json(npmBody, headers);
    else if (url.pathname === `/repos/${repository}`) response = json({ id: 42, full_name: repository }, headers);
    else if (url.pathname.endsWith('/releases/latest')) response = json(githubLatest, headers);
    else if (url.pathname.includes('/releases/tags/')) {
      const tag = url.pathname.split('/').at(-1);
      const row = rows.find(row => typeof row === 'object' && row !== null && 'tag_name' in row && row.tag_name === tag);
      response = row === undefined ? new Response(null, { status: 404 }) : json(row, headers);
    } else if (url.pathname.includes('/git/ref/tags/')) {
      const tag = url.pathname.split('/').at(-1);
      response = json({ ref: `refs/tags/${tag}`, object: { type: 'commit', sha: commit }, private: privateText }, headers);
    } else response = new Response(null, { status: 404 });
    return options.rewrite ? options.rewrite(url, attempt, init, response) : response;
  };
  return { fetchImpl, calls, counts, npmBody };
}
