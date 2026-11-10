import { expect, test } from 'vitest';
import { immutableGithubPath } from '../scripts/tool-update/manifest.mjs';

const sha = 'a'.repeat(40);
test.each([
  [`/git/trees/${sha}`, true],
  [`/git/blobs/${sha}`, true],
  [`/git/tags/${sha}`, true],
  [`/contents/CHANGELOG.md?ref=${sha}`, true],
  [`/contents/nested/file.json?ref=${sha.toUpperCase()}`, true],
  ['', false],
  [`/git/ref/tags/${sha}`, false],
  ['/git/trees/main', false],
  [`/git/trees/${sha.slice(1)}`, false],
  [`/git/trees/${sha}0`, false],
  [`/git/trees/${sha}/extra`, false],
  [`/git/blobs/${sha}?raw=1`, false],
  [`/git/tags/${sha}#fragment`, false],
  [`/git/trees/${sha}?recursive=1`, false],
  [`/git/trees/${sha}\n`, false],
  [`/contents/file?ref=${sha}\r\n`, false],
  ['/contents/CHANGELOG.md', false],
  ['/contents/CHANGELOG.md?ref=main', false],
  [`/contents/CHANGELOG.md?ref=${sha}&extra=1`, false],
  [`/contents/CHANGELOG.md?ref=${sha}&ref=main`, false],
  [`/contents//file?ref=${sha}`, false],
  [`/contents/?ref=${sha}`, false],
  [`/unclassified/${sha}`, false]
] as const)('classifies immutable GitHub resource %s as %s', (path, expected) => {
  expect(immutableGithubPath(path)).toBe(expected);
});
