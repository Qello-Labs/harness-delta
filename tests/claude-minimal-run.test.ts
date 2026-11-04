import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { createClaudeMinimalIntent, executeClaudeMinimalIntent } from '../src/claude-minimal-run.js';
import { compiledWorker } from './helpers/compiled-worker.js';

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'claude-minimal-')));
  const compiled = compiledWorker(root);
  const executable = join(root, 'synthetic-product');
  const bytes = `#!${process.execPath}\nrequire('node:fs').writeFileSync('synthetic-launched', 'x');\n`;
  writeFileSync(executable, bytes, { mode: 0o700 });
  const prepared = createClaudeMinimalIntent(
    join(root, 'intent'),
    { path: executable, version: '2.1.288', sha256: createHash('sha256').update(bytes).digest('hex') },
    join(compiled, 'claude-probe-hook-mediator.js')
  );
  const consent = { intent_sha256: prepared.sha256, approval_reference: 'synthetic-approval', actual_model_run: true, transient_trace_log_hooks: true };
  return { root, prepared, consent, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
test('private preparation creates a concrete intent and empty fixture without launching or activating telemetry', () => {
  const f = fixture();
  try {
    expect(existsSync(join(f.prepared.intent.cwd, 'synthetic-launched'))).toBe(false);
    expect(existsSync(join(f.prepared.intent.workspace, 'claude-probe-manifest.json'))).toBe(false);
    expect(statSync(f.prepared.intentPath).mode & 0o777).toBe(0o600);
    expect(f.prepared.intent).toMatchObject({
      productVersion: '2.1.288',
      model: 'claude-sonnet-5-5',
      effort: 'high',
      durationMs: 120000,
      actualExecutionApproved: false,
      productGateDelta: false
    });
  } finally {
    f.cleanup();
  }
});
test('missing or mismatched actual-run/settings consent cannot reserve or launch', async () => {
  const f = fixture();
  try {
    for (const bad of [
      {},
      { ...f.consent, intent_sha256: '0'.repeat(64) },
      { ...f.consent, actual_model_run: false },
      { ...f.consent, transient_trace_log_hooks: false }
    ]) {
      await expect(executeClaudeMinimalIntent(f.prepared.intentPath, bad)).rejects.toThrow('claude_minimal_consent_required');
    }
    expect(existsSync(join(f.root, 'intent', 'execution-request.reserved'))).toBe(false);
    expect(existsSync(join(f.prepared.intent.cwd, 'synthetic-launched'))).toBe(false);
  } finally {
    f.cleanup();
  }
});
test('synthetic execution persists failed terminal evidence and the same intent cannot run again', async () => {
  const f = fixture();
  try {
    const result = await executeClaudeMinimalIntent(f.prepared.intentPath, f.consent);
    expect(result).toMatchObject({
      status: 'failed',
      reason: 'claude_probe_terminal_missing',
      invocationCalls: 1,
      nativeSchemaQualified: false,
      productGateDelta: false,
      completeCost: null
    });
    expect(existsSync(join(f.prepared.intent.cwd, 'synthetic-launched'))).toBe(true);
    expect(JSON.parse(readFileSync(join(f.root, 'intent', 'execution-result.json'), 'utf8'))).toMatchObject({ status: 'failed', productGateDelta: false });
    await expect(executeClaudeMinimalIntent(f.prepared.intentPath, f.consent)).rejects.toThrow('claude_minimal_already_reserved');
  } finally {
    f.cleanup();
  }
});
test('modified intent cannot use its original consent hash', async () => {
  const f = fixture();
  try {
    writeFileSync(f.prepared.intentPath, JSON.stringify({ ...f.prepared.intent, model: 'changed-model' }));
    await expect(executeClaudeMinimalIntent(f.prepared.intentPath, f.consent)).rejects.toThrow();
    expect(existsSync(join(f.root, 'intent', 'execution-request.reserved'))).toBe(false);
  } finally {
    f.cleanup();
  }
});

test('a changed prepared hook implementation cannot reserve a native attempt', async () => {
  const f = fixture();
  try {
    writeFileSync(f.prepared.intent.mediatorPath, '// changed synthetic hook');
    await expect(executeClaudeMinimalIntent(f.prepared.intentPath, f.consent)).rejects.toThrow('claude_minimal_invalid_intent');
    expect(existsSync(join(f.root, 'intent', 'execution-request.reserved'))).toBe(false);
  } finally {
    f.cleanup();
  }
});
