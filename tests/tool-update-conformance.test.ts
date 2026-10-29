import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { failureEvidenceSchema, parseArguments, persistFailure, runConformance, validateApproval } from '../scripts/tool-update/conformance.mjs';
import { bounded, ConformanceError, observedProcess, privateRead, repository, safeCode, treeDigest } from '../scripts/tool-update/fixtures.mjs';
import { projectTranscript } from '../scripts/tool-update/claude-oracle.mjs';
import { runLocalhost } from '../scripts/tool-update/claude-localhost.mjs';
import { fixture, pins, approval, context, row, lines } from './tool-update-conformance-fixture.js';

describe('strict execution authority', () => {
  it('accepts a separately supplied exact manual input when every pin matches', () => {
    expect(validateApproval(approval(), context).scope.members).toBe(2);
  });
  it.each([
    undefined, {}, { ...approval(), approved: false }, { ...approval(), version: '2.1.307' },
    { ...approval(), extra: true }, { ...approval(), scope: { ...approval().scope, resume: true } },
    { ...approval(), runtime: { ...approval().runtime, path: '/private-runtime' } },
    { ...approval(), budgets: { ...approval().budgets, duration_ms: 0 } },
    { ...approval(), pins: { ...pins, extra: 'a'.repeat(64) } },
  ])('rejects missing unknown or unregistered authority before launch %#', value => {
    expect(() => validateApproval(value, context)).toThrow('approval_invalid');
  });
  it('rejects unattended execution without independently verified egress containment', () => {
    expect(() => validateApproval({ ...approval(), mode: 'unattended' }, context)).toThrow('unattended_isolation_unverified');
  });
  it.each([
    { ...context, version: 'v26.3.0' }, { ...context, runtimeSha256: 'c'.repeat(64) },
    { ...context, arch: 'x64' }, { ...context, platform: 'linux' },
  ])('rejects a mismatched selected runtime %#', value => {
    expect(() => validateApproval(approval(), value)).toThrow('runtime_mismatch');
  });
  it.each([{ ...context, binarySha256: 'c'.repeat(64) }, { ...context, binarySize: 1 }])('rejects image drift %#', value => {
    expect(() => validateApproval(approval(), value)).toThrow('binary_mismatch');
  });
  it('rejects instrument or lockfile drift', () => {
    expect(() => validateApproval(approval(), { ...context, pins: { ...pins, lockfile: 'c'.repeat(64) } })).toThrow('approval_mismatch');
  });
  it('changes a source pin when bytes change without relying on filenames', () => {
    const root = fixture(), path = join(root, 'instrument.mjs');
    writeFileSync(path, 'export const fixture = 1;\n');
    const before = treeDigest(root);
    writeFileSync(path, 'export const fixture = 2;\n');
    expect(treeDigest(root)).not.toBe(before);
  });
  it('rejects expired authority rather than silently refreshing it', () => {
    expect(() => validateApproval(approval(), { ...context, now: Date.parse('2026-10-24T00:30:00Z') })).toThrow('approval_expired');
  });
  it('requires all three explicit local CLI inputs without duplicate flags', () => {
    expect(parseArguments(['--approval', '/a', '--binary', '/b', '--out', '/o'])).toEqual({ approvalFile: '/a', binary: '/b', out: '/o' });
    expect(() => parseArguments(['--approval', '/a', '--approval', '/b', '--out', '/o'])).toThrow('approval_invalid');
  });
  it('projects unknown errors to a fixed enum without paths or raw text', () => {
    expect(safeCode(new Error('/private/example native prompt'))).toBe('runner_failed');
  });
  it('requires authority on the exported runner seam before any fixture or child activity', async () => {
    await expect(runLocalhost({ approvalFile: '/nonexistent-synthetic-approval', binary: 'relative-unapproved-image',
      root: fixture(), scenario: 'normal' })).rejects.toThrow('private_input_invalid');
  });
});

describe('source scope and privacy fences', () => {
  it('rejects revoked scope before parsing a source body', () => {
    const root = fixture(), source = join(root, 'source');
    writeFileSync(source, 'SYNTHETIC-CONTENT', { mode: 0o600 });
    expect(() => privateRead(source, root, () => false)).toThrow('scope_inactive');
  });
  it('rejects symbolic links and foreign paths', () => {
    const root = fixture(), other = fixture(), source = join(other, 'source'), link = join(root, 'link');
    writeFileSync(source, 'SYNTHETIC-CONTENT', { mode: 0o600 }); symlinkSync(source, link);
    expect(() => privateRead(link, root)).toThrow('source_invalid');
  });
  it('does not embed source text in the independent metadata projection', () => {
    const sid = randomUUID();
    expect(JSON.stringify([...projectTranscript(lines([row(2, sid)]), sid)])).not.toContain('SYNTHETIC-CONTENT-NEVER-EVIDENCE');
  });
});

describe('strict sanitized failure evidence', () => {
  it('prints only a fixed CLI failure and persists no rejected paths', async () => {
    const out = fixture();
    const launched = observedProcess(realpathSync(process.execPath),
      [join(repository, 'scripts/tool-update/conformance.mjs'), '--approval', '/nonexistent-synthetic-approval',
        '--binary', '/nonexistent-synthetic-image', '--out', out]);
    let stdout = '', stderr = '';
    launched.child.stdout?.on('data', (bytes: Buffer) => { stdout += bytes.toString(); });
    launched.child.stderr?.on('data', (bytes: Buffer) => { stderr += bytes.toString(); });
    expect((await bounded(launched.closed, 5000))[0]).toBe(1);
    expect(JSON.parse(stdout) as unknown).toEqual({ kind: 'failure', code: 'runner_failed' });
    expect(stderr).toBe('');
    const name = readdirSync(out)[0];
    if (!name) throw new Error('synthetic_failure_file_missing');
    const text = readFileSync(join(out, name), 'utf8');
    expect(text).not.toContain('nonexistent-synthetic');
    expect(failureEvidenceSchema.parse(JSON.parse(text) as unknown).execution_attempted).toBe(false);
  });
  it('writes initialization failure after establishing a private output root without launching', async () => {
    const out = fixture();
    await expect(runConformance({ approvalFile: '/nonexistent-synthetic-approval',
      binary: 'relative-unapproved-image', out })).rejects.toThrow('private_input_invalid');
    const names = readdirSync(out);
    expect(names).toHaveLength(1);
    const name = names[0];
    if (!name) throw new Error('synthetic_failure_file_missing');
    expect(name).toMatch(/^failure-[a-f0-9-]{36}\.json$/);
    const text = readFileSync(join(out, name), 'utf8');
    const evidence = failureEvidenceSchema.parse(JSON.parse(text) as unknown);
    expect(evidence).toMatchObject({ status: 'failed', code: 'private_input_invalid', stage: 'initialization',
      run_id: null, scenario: null, execution_attempted: false, authenticated: false,
      ordinary_qualified: false, interactive_qualified: false, complete_cost: false, egress_isolation_verified: false });
    expect(statSync(join(out, name)).mode & 0o777).toBe(0o600);
    expect(text).not.toContain(out);
  });
  it.each(['scenario', 'cleanup'] as const)('records only fixed codes for %s failures', stage => {
    const out = fixture(), raw = '/private/synthetic-home raw synthetic stderr';
    const evidence = persistFailure(out, { runId: randomUUID(), stage, scenario: 'sigint', executionAttempted: true },
      stage === 'cleanup' ? new ConformanceError('cleanup_unverified') : new Error(raw));
    expect(evidence.code).toBe(stage === 'cleanup' ? 'cleanup_unverified' : 'runner_failed');
    expect(JSON.stringify(evidence)).not.toContain(raw);
    expect(failureEvidenceSchema.safeParse({ ...evidence, raw_stderr: raw }).success).toBe(false);
    expect(readdirSync(out)).toHaveLength(1);
  });
});
