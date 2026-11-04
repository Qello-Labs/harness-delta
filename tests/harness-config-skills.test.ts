import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';

test('register reference package applies its actual wrapper to explicit synthetic files', () => {
  const root = mkdtempSync(join(tmpdir(), 'harness-skill-synthetic-'));
  try {
    writeFileSync(join(root, 'policy.md'), 'Synthetic guidance\n');
    writeFileSync(join(root, 'notes.md'), 'Synthetic manual prerequisites\n');
    for (const version of ['baseline', 'v2']) {
      const input = join(root, 'input.json');
      writeFileSync(
        input,
        JSON.stringify({
          schema_version: 1,
          harness_id: 'search',
          version,
          policy_version: 'policy-v1',
          readme_path: 'notes.md',
          artifacts: [{ artifact_id: 'instruction', role: 'instruction', source_path: 'policy.md', target_path: 'harness.md' }]
        })
      );
      const output = execFileSync(
        process.execPath,
        ['skills/harness-register/scripts/run.mjs', '--harness-delta', resolve('.'), '--root', root, '--input', input],
        { encoding: 'utf8' }
      );
      expect(JSON.parse(output) as unknown).toMatchObject({ status: 'registered' });
      expect(output).not.toContain(root);
    }
    const guide = readFileSync('skills/harness-register/SKILL.md', 'utf8');
    expect(guide).toContain('name: harness-register');
    expect(guide).toContain('--harness-delta');
    expect(guide).toContain('source_path');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('comparison reference package generates a portable pair without a DB and repeats without replacing it', () => {
  const root = mkdtempSync(join(tmpdir(), 'harness-pair-skill-synthetic-'));
  try {
    writeFileSync(join(root, 'policy.md'), 'Synthetic guidance\n');
    writeFileSync(join(root, 'notes.md'), 'Synthetic manual prerequisites\n');
    const input = join(root, 'input.json');
    for (const version of ['baseline', 'v2']) {
      writeFileSync(
        input,
        JSON.stringify({
          schema_version: 1,
          harness_id: 'search',
          version,
          policy_version: 'policy-v1',
          readme_path: 'notes.md',
          artifacts: [{ artifact_id: 'instruction', role: 'instruction', source_path: 'policy.md', target_path: 'harness.md' }]
        })
      );
      execFileSync(process.execPath, ['skills/harness-register/scripts/run.mjs', '--harness-delta', resolve('.'), '--root', root, '--input', input]);
    }
    writeFileSync(input, JSON.stringify({ schema_version: 1, id: 'baseline-vs-v2', name: 'Baseline vs v2', arm_a: 'baseline', arm_b: 'v2' }));
    const args = ['skills/harness-compare-config/scripts/run.mjs', '--harness-delta', resolve('.'), '--root', root, '--input', input];
    expect(JSON.parse(execFileSync(process.execPath, args, { encoding: 'utf8' })) as unknown).toMatchObject({ status: 'generated' });
    const bytes = readFileSync(join(root, 'harness-config/comparisons/baseline-vs-v2.json'));
    expect(JSON.parse(execFileSync(process.execPath, args, { encoding: 'utf8' })) as unknown).toMatchObject({ status: 'already_generated' });
    expect(readFileSync(join(root, 'harness-config/comparisons/baseline-vs-v2.json'))).toEqual(bytes);
    expect(bytes.toString()).not.toContain(root);
    expect(readFileSync('skills/harness-compare-config/SKILL.md', 'utf8')).toContain('name: harness-compare-config');
    const absent = spawnSync(process.execPath, ['skills/harness-compare-config/scripts/run.mjs', '--harness-delta', root, '--root', root, '--input', input], {
      encoding: 'utf8'
    });
    expect(absent.status).toBe(1);
    expect(absent.stderr).toBe('harness_delta_build_required\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
