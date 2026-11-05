import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';
test('application helper rejects non-loopback origins before making requests', () => {
  const script = resolve('skills/harness-apply/scripts/apply.mjs');
  for (const origin of ['https://example.invalid', 'http://localhost:4317', 'http://127.0.0.1:4317/path']) {
    let stderr = '';
    try {
      execFileSync(process.execPath, [script, 'status', '--origin', origin, '--task', 'synthetic'], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      stderr = String((error as { stderr: Buffer }).stderr);
    }
    expect(stderr.trim()).toBe('invalid_application_request');
  }
});
test('application package pins separate setup/working roles and preserves capability blockers', () => {
  const skill = readFileSync(resolve('skills/harness-apply/SKILL.md'), 'utf8');
  expect(skill).toContain('name: harness-apply');
  expect(skill).toContain('checkpoint');
  expect(skill).toContain('native window');
  expect(skill).toContain('agent_reported');
  expect(skill).not.toContain('application-publish');
  expect(skill).toContain('harness-connect');
});
