import { afterEach, expect, test, vi } from 'vitest';
import { join } from 'node:path';
import { readdir, readFile, rm } from 'node:fs/promises';
import { auditedCli, projectRoot, scratch } from './helpers/tool-update-difference-cli-fixture.js';
import type { TransportResponse } from './helpers/tool-update-difference-cli-fixture.js';
import { sourceFixture } from './helpers/tool-update-source-fixture.js';
import { fixture, now } from './tool-update-discovery-fixture.js';
import { collectCodexSourceEvidence } from '../scripts/tool-update/difference-source.mjs';
import { discover, observationSchema } from '../scripts/tool-update/discovery.mjs';
import { loadRecord, publishRecord } from '../scripts/tool-update/manifest.mjs';
import { differenceJobSchema } from '../scripts/tool-update/difference-records.mjs';

afterEach(() => vi.unstubAllEnvs());

test.each(['discover', 'collect-difference-evidence'] as const)('%s CLI never prints or persists the opted-in credential', async command => {
  const root = await scratch();
  const token = 'synthetic-cli-environment-secret';
  vi.stubEnv('HARNESS_DELTA_GITHUB_TOKEN', token);
  const responses: TransportResponse[] = [];
  const remember = async (url: URL, response: Response) => {
    const headers: [string, string][] = [];
    response.headers.forEach((value, name) => headers.push([name, value]));
    responses.push({
      url: url.href,
      status: response.status,
      headers,
      body: await response.clone().text()
    });
    return response;
  };
  try {
    let args: string[];
    if (command === 'discover') {
      const wire = fixture({
        etag: null,
        rewrite: (url, _attempt, _init, response) => remember(url, response)
      });
      await discover('codex', { fetchImpl: wire.fetchImpl, now });
      args = [command, '--product', 'codex', '--out', root];
    } else {
      const wire = sourceFixture({
        rewrite: (url, _attempt, response) => remember(url, response)
      });
      await collectCodexSourceEvidence(wire.job, {
        fetch: wire.fetchImpl
      });
      const id = await publishRecord(root, wire.job, differenceJobSchema);
      args = [command, '--job', join(root, 'difference-jobs', `${id}.json`), '--out', root];
    }
    const result = await auditedCli(root, join(projectRoot, 'scripts/tool-update.mjs'), args, responses);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain(token);
    expect(result.stderr).not.toContain(token);
    const entries = await readdir(root, {
      recursive: true,
      withFileTypes: true
    });
    for (const entry of entries.filter(entry => entry.isFile())) {
      expect((await readFile(join(entry.parentPath, entry.name))).includes(Buffer.from(token))).toBe(false);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const invalidTokens = [
  ['internal tab', 'synthetic\ttoken'],
  ['trailing tab', 'synthetic-token\t'],
  ['SOH', 'synthetic\u0001token'],
  ['DEL', 'synthetic\u007ftoken'],
  ['Latin-1', 'synthetic-\u00e9-token'],
  ['above U+00FF', 'synthetic-\u0100-token'],
  ['punctuation', 'synthetic:malformed-token'],
  ['leading padding', '=synthetic-leading-padding'],
  ['internal padding', 'synthetic=internal-padding'],
  ['padding only', '='.repeat(32)]
] as const;

test.each((['discover', 'collect-difference-evidence'] as const).flatMap(command => invalidTokens.map(([label, token]) => [command, label, token] as const)))(
  '%s CLI refuses malformed %s credentials before fetch without exposing them',
  async (command, _label, token) => {
    const root = await scratch();
    vi.stubEnv('HARNESS_DELTA_GITHUB_TOKEN', token);
    try {
      let args: string[];
      if (command === 'discover') {
        args = [command, '--product', 'codex', '--out', root];
      } else {
        const id = await publishRecord(root, sourceFixture().job, differenceJobSchema);
        args = [command, '--job', join(root, 'difference-jobs', `${id}.json`), '--out', root];
      }
      const result = await auditedCli(root, join(projectRoot, 'scripts/tool-update.mjs'), args);
      expect(result.exitCode).toBe(2);
      expect(result.ledger).toMatchObject({ network: 0 });
      if (command === 'discover') {
        expect(result.output).toMatchObject({ status: 'discovery_incomplete' });
        const [name] = await readdir(join(root, 'observations'));
        if (!name) throw new Error('synthetic_failure_observation_required');
        const observation = await loadRecord(join(root, 'observations', name), observationSchema);
        expect(observation.reasons).toContain('metadata_invalid');
      } else {
        expect(result.output).toMatchObject({ status: 'difference_evidence_created', failure: 'source_identity_invalid' });
      }
      const forbidden = new Set([token, JSON.stringify(token).slice(1, -1)]);
      const entries = await readdir(root, { recursive: true, withFileTypes: true });
      for (const value of forbidden) {
        expect(result.stdout).not.toContain(value);
        expect(result.stderr).not.toContain(value);
        expect(JSON.stringify(result.output)).not.toContain(value);
        for (const entry of entries.filter(entry => entry.isFile())) {
          expect((await readFile(join(entry.parentPath, entry.name))).includes(Buffer.from(value))).toBe(false);
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
);
