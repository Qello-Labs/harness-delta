import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
test('native apply UI offers an opening action, actual post-review, and separate working handoff', () => {
  const source = readFileSync('ui/src/HarnessApplication.tsx', 'utf8');
  expect(source).toContain('application-prepare');
  expect(source).toContain('application-open');
  expect(source).toContain('application-launch-context');
  expect(source).toContain('application-handoff');
  expect(source).toContain('agent_reported');
  for (const obsolete of ['application-publish', 'application-execute', 'application-permission', 'inputPaths', 'outputPaths', 'approvalDigest'])
    expect(source).not.toContain(obsolete);
});
