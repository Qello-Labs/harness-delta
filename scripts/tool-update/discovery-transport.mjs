import { createHash } from 'node:crypto';
import { digest, fail } from './manifest.mjs';
import { instant, checkOrder } from './discovery-records.mjs';

const hashBytes = value => createHash('sha256').update(value).digest('hex');
const redirects = new Set([301, 302, 303, 307, 308]);

// One invocation owns the byte ledger, deadline, and transient validators.
export function transport(fetchImpl, now, signal) {
  let total = 0;
  const snapshots = [];
  const groups = new Map();
  let repositoryIdentity;
  function stamp() {
    const parsed = instant.safeParse(now());
    if (!parsed.success) fail('metadata_invalid');
    return parsed.data;
  }
  async function bounded(promise) {
    signal.throwIfAborted();
    let abort;
    const stopped = new Promise((resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
    });
    try { return await Promise.race([promise, stopped]); }
    finally { signal.removeEventListener('abort', abort); }
  }
  async function request(url, source, etag = null) {
    const limit = source === 'github_latest' || source === 'github_release' ? 64 * 1024 * 1024 :
      source === 'npm' ? 32 * 1024 * 1024 : 4 * 1024 * 1024;
    const original = new URL(url);
    const visited = new Set();
    let current = url;
    for (let hop = 0; hop <= 5; hop++) {
      if (visited.has(current)) fail('redirect_invalid');
      visited.add(current);
      const headers = source === 'npm' ? { accept: 'application/json' } : {
        accept: 'application/vnd.github+json',
        'user-agent': 'harness-delta-tool-update',
      };
      if (etag !== null) headers['if-none-match'] = etag;
      const response = await bounded(fetchImpl(current, { redirect: 'manual', signal, headers }));
      if (response.redirected || (response.url && response.url !== current)) fail('redirect_invalid');
      if (redirects.has(response.status)) {
        const location = response.headers.get('location');
        void response.body?.cancel().catch(() => {});
        if (!location) fail('redirect_invalid');
        let destination;
        try { destination = new URL(location, current); } catch { fail('redirect_invalid'); }
        const query = url => [...url.searchParams.entries()].sort().map(pair => pair.join('=')).join('&');
        const named = repositoryIdentity ? `/repos/${repositoryIdentity.repository}/releases/` : '';
        const suffix = named && original.pathname.startsWith(named) ? original.pathname.slice(named.length) : null;
        const permittedPath = destination.pathname === original.pathname ||
          (source === 'github_latest' || source === 'github_release') && suffix !== null &&
          destination.pathname === `/repositories/${repositoryIdentity.id}/releases/${suffix}`;
        if (destination.origin !== original.origin || destination.username || destination.password ||
            destination.hash || !permittedPath ||
            query(destination) !== query(original)) fail('redirect_invalid');
        current = destination.href;
        continue;
      }
      if (response.status === 304 && etag !== null) return { unchanged: true, checkedAt: stamp() };
      if (response.status === 403 || response.status === 429) fail('rate_limited');
      if (response.status === 404 && source === 'github_tag') fail('tag_missing');
      if (response.status === 404 && source === 'github_release') fail('github_release_missing');
      if (response.status !== 200) fail('http_error');
      const length = response.headers.get('content-length');
      if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > limit)) {
        void response.body?.cancel().catch(() => {});
        fail('response_limit');
      }
      const validator = response.headers.get('etag');
      if (validator !== null && (validator.length > 1024 || /[\r\n]/.test(validator))) fail('metadata_invalid');
      const chunks = [];
      let size = 0;
      const reader = response.body?.getReader();
      if (!reader) fail('metadata_invalid');
      try {
        for (;;) {
          const { done, value } = await bounded(reader.read());
          if (done) break;
          size += value.byteLength;
          total += value.byteLength;
          if (size > limit) fail('response_limit');
          if (total > 512 * 1024 * 1024) fail('total_limit');
          chunks.push(value);
        }
      } finally {
        // Cancel even after an aborted or over-budget read, without waiting on a producer.
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      const bytes = Buffer.concat(chunks);
      const rawDigest = hashBytes(bytes);
      const link = source === 'github_releases' ? response.headers.get('link') : null;
      return { bytes, rawDigest, etag: validator, link, checkedAt: stamp() };
    }
    return fail('redirect_invalid');
  }
  return {
    stamp,
    bindRepository(identity) { repositoryIdentity = identity; },
    async get(url, source, key) {
      if (snapshots.length >= 512) fail('reference_limit');
      const response = await request(url, source);
      snapshots.push({ url, source, key, ...response });
      let body;
      try { body = JSON.parse(response.bytes.toString('utf8')); }
      catch { fail('metadata_invalid'); }
      // Raw response bytes are never retained after projection.
      delete snapshots[snapshots.length - 1].bytes;
      const groupKey = `${source}:${key}`;
      const group = groups.get(groupKey) ?? {
        source, key, queried_at: response.checkedAt, checked_at: response.checkedAt, parts: [],
      };
      group.parts.push({ sha256: response.rawDigest, validator: response.etag === null ? null : hashBytes(response.etag) });
      groups.set(groupKey, group);
      return { body, link: response.link };
    },
    async revalidate() {
      for (const entry of snapshots) {
        const response = await request(entry.url, entry.source, entry.etag);
        if (!response.unchanged && (response.rawDigest !== entry.rawDigest || response.link !== entry.link)) fail('metadata_drift');
        groups.get(`${entry.source}:${entry.key}`).checked_at = response.checkedAt;
      }
    },
    checks() {
      return [...groups.values()].map(group => ({
        source: group.source, key: group.key, queried_at: group.queried_at, checked_at: group.checked_at,
        sha256: group.parts.length === 1 ? group.parts[0].sha256 : digest(group.parts.map(part => part.sha256)),
        validator: group.parts.every(part => part.validator === null) ? null :
          group.parts.length === 1 ? group.parts[0].validator : digest(group.parts.map(part => part.validator)),
      })).sort(checkOrder);
    },
  };
}
