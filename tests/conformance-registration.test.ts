import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, test } from 'vitest';
import { registrationMain } from '../scripts/conformance/register.js';
import { evidenceIdentity, evidenceSources } from '../scripts/conformance/evidence.js';
import { codex01580Candidate } from '../scripts/conformance/candidate.js';
import { checkNames } from '../scripts/conformance/checks.js';

test('explicit source registration binds evidence; dry runs and stale reports cannot mutate the registry', () => {
  const root = mkdtempSync(join(tmpdir(), 'synthetic-admission-'));
  try {
    for (const path of evidenceSources) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), 'synthetic application implementation');
    }
    const registry = join(root, 'src/codex-admissions.json');
    writeFileSync(registry, '[]\n');
    const identity = evidenceIdentity(root, codex01580Candidate);
    const report = {
      ...identity,
      version: '0.158.0',
      scenario: 'exec_initial_resume',
      confirmed: true,
      stop: null,
      productVersionBefore: 'match',
      productVersionAfter: 'match',
      configMetadataUnchanged: true,
      stages: ['initial', 'resume'].map(stage => ({
        stage,
        exit: 'ok',
        rolloutMatch: 'match',
        parseError: null,
        sameRolloutAsInitial: stage === 'resume' ? true : null,
        conformance: { version: '0.158.0', blocked: false, limitExceeded: false, checks: Object.fromEntries(checkNames.map(check => [check, 'pass'])) }
      }))
    };
    const path = join(root, 'report.json');
    writeFileSync(path, JSON.stringify(report));
    const args = ['--candidate', '0.158.0', '--report', path];
    expect(registrationMain(args, root, () => undefined)).toBe(0);
    expect(readFileSync(registry, 'utf8')).toBe('[]\n');
    writeFileSync(join(root, evidenceSources[0]), 'changed implementation');
    expect(registrationMain([...args, '--register'], root, () => undefined)).toBe(1);
    expect(readFileSync(registry, 'utf8')).toBe('[]\n');
    writeFileSync(join(root, evidenceSources[0]), 'synthetic application implementation');
    expect(registrationMain([...args, '--register'], root, () => undefined)).toBe(0);
    expect(JSON.parse(readFileSync(registry, 'utf8'))).toEqual([{ version: '0.158.0', ...identity, scenario: 'exec_initial_resume' }]);
    expect(registrationMain([...args, '--register'], root, () => undefined)).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
