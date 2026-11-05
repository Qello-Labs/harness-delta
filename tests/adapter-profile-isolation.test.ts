import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { lookupFileProfile } from '../src/adapter-profiles.js';
import { parseSnapshot } from '../src/adapters.js';
import { codex01580Candidate } from '../scripts/conformance/candidate.js';

function readTree(dir: string): string {
  return readdirSync(dir)
    .map(entry => {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) return readTree(path);
      return entry.endsWith('.ts') ? readFileSync(path, 'utf8') : '';
    })
    .join('\n');
}

test('production sources cannot see the conformance candidate', () => {
  const source = readTree('src');
  expect(source).not.toContain('scripts/conformance');
  expect(source).not.toContain('ConformanceCandidate');
  expect(source).not.toContain('conformance_candidate');
  // Forward windows may name verified versions, but candidate code stays isolated.
  expect(source).not.toContain('codex01580Candidate');
  expect(source).not.toContain('dangerously-bypass-hook-trust');
  expect(readFileSync('src/otel-journal.ts', 'utf8')).not.toContain('adapter-profiles');
  expect(readFileSync('src/sources/otel-projection.ts', 'utf8')).not.toContain('adapter-profiles');
  expect(readFileSync('src/sources/otel-receiver.ts', 'utf8')).not.toContain('adapter-profiles');
  expect(lookupFileProfile('codex', codex01580Candidate.version)).toMatchObject({
    kind: 'registered',
    boundaryMode: 'settings_checkpoint',
    commandDiagnostics: false
  });
  expect(codex01580Candidate).toMatchObject({
    kind: 'conformance_candidate',
    product: 'codex',
    version: '0.158.0',
    admitted: false,
    productionUsageField: 'total_token_usage',
    inspectedUsageField: 'last_token_usage',
    excludedTypes: ['token_usage_record']
  });
  expect(parseSnapshot.length).toBe(3);
  expect(() =>
    parseSnapshot('', {
      sessionId: 's1',
      projectRoot: '/synthetic',
      product: 'codex',
      version: '0.164.0'
    })
  ).toThrow(/^unsupported$/);
});
