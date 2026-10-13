import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import {
  hashInstrumentedBinary, readInstrumentedBuildIdentity, resolveInstrumentedBuildIdentity,
} from '../src/instrumented-codex-build-identity.js';
import { instrumentedFixtureProfile, makeInstrumentedCostFixture } from './helpers/instrumented-codex-fixture.js';

test('binary identity is computed from a non-symlink file rather than caller metadata', () => {
  const root = mkdtempSync(join(tmpdir(), 'harness-build-identity-'));
  const binary = join(root, 'synthetic-binary');
  try {
    writeFileSync(binary, 'synthetic-executable-v1');
    const expected = createHash('sha256').update('synthetic-executable-v1').digest('hex');
    expect(hashInstrumentedBinary(binary)).toBe(expected);
    const alias = join(root, 'alias');
    symlinkSync(binary, alias);
    expect(() => hashInstrumentedBinary(alias)).toThrow();
    writeFileSync(binary, 'synthetic-executable-v2');
    expect(hashInstrumentedBinary(binary)).not.toBe(expected);
  } finally { rmSync(root, { recursive: true }); }
});

test('a self-consistent profile and matching real bytes do not substitute for code-owned qualification', () => {
  const root = mkdtempSync(join(tmpdir(), 'harness-build-identity-'));
  const binary = join(root, 'synthetic-binary');
  const f = makeInstrumentedCostFixture();
  try {
    writeFileSync(binary, 'synthetic-executable');
    const profile = { ...instrumentedFixtureProfile, binary_sha256: hashInstrumentedBinary(binary) };
    expect(readInstrumentedBuildIdentity(f.store, profile)).toBeNull();
    expect(() => resolveInstrumentedBuildIdentity(f.store, binary, profile)).toThrow('unqualified_build');
    expect(() => resolveInstrumentedBuildIdentity(f.store, binary, instrumentedFixtureProfile)).toThrow('binary_changed');
  } finally { f.store.close(); rmSync(root, { recursive: true }); }
});
