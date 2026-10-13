import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { claudeWorkflowChildAgentType, prepareClaudeNativeProbe, reserveClaudeProbeAction } from '../src/claude-native-probe.js';

function options(workspace: string) {
  return { workspace, binary: { path: '/synthetic/claude-2.1.288', version: '2.1.288', sha256: 'a'.repeat(64) },
    destination: { endpoint: 'http://127.0.0.1:43123', headers: { 'x-harness-delta-token': 'SYNTHETIC_TOKEN' }, processId: 'process-1' },
    nativeSessionId: '00000000-0000-4000-8000-000000000001', model: 'claude-sonnet-5-5', effort: 'high' as const,
    hookCommand: 'node synthetic-hook.js' };
}
// The assigned workflow takes its own version list; the internal probe stays on 2.1.288.
function workflowOptions(workspace: string) {
  return { ...options(workspace), binary: { path: '/synthetic/claude-2.1.296', version: '2.1.296', sha256: 'a'.repeat(64) } };
}
test('prepare-only probe writes private ephemeral candidate settings and token-free argv/manifest', async () => {
  const root = mkdtempSync(join(tmpdir(), 'claude-probe-prepare-'));
  try {
    const prepared = await prepareClaudeNativeProbe(options(root));
    const settings = JSON.parse(readFileSync(prepared.settingsPath, 'utf8')) as { env: Record<string, string>; hooks: Record<string, unknown> };
    expect(statSync(prepared.settingsPath).mode & 0o777).toBe(0o600);
    expect(settings.env).toMatchObject({ OTEL_TRACES_EXPORTER: 'otlp', OTEL_METRICS_EXPORTER: 'none', CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: '1', ENABLE_ENHANCED_TELEMETRY_BETA: '1', ENABLE_BETA_TRACING_DETAILED: '0', OTEL_LOG_USER_PROMPTS: '0', OTEL_LOG_ASSISTANT_RESPONSES: '0', OTEL_LOG_TOOL_DETAILS: '0', OTEL_LOG_RAW_API_BODIES: '0' });
    expect(settings.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT).toBe('http://127.0.0.1:43123/v1/traces');
    expect(settings.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe('http://127.0.0.1:43123/v1/logs');
    expect(Object.keys(settings.hooks).sort()).toEqual(['PreToolUse', 'SessionEnd', 'SessionStart', 'SubagentStart', 'SubagentStop']);
    expect(JSON.stringify(prepared.argv) + readFileSync(prepared.manifestPath, 'utf8')).not.toContain('SYNTHETIC_TOKEN');
    // Observed 2.1.288 default is auto mode, whose classifier adds non-requested model requests.
    expect(prepared.argv.join(' ')).toContain('--permission-mode dontAsk');
    // Observed 2.1.288 launches Agent children asynchronously unless background tasks are disabled.
    expect(settings.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe('1');
    expect(prepared.argv).toContain('--restricted'); expect(prepared.argv).not.toContain('--bare'); expect(prepared.argv).not.toContain('--dangerously-skip-permissions');
    expect(prepared.manifest.limits).toMatchObject({ plannedRequests: 3, wallTimeMs: 120000, estimatedBudgetUsd: '0.10', hardBillingBound: null });
    await prepared.dispose(); expect(() => statSync(prepared.settingsPath)).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('launch and child reservations persist through disposal/reprepare and prohibit automatic reuse', async () => {
  const root = mkdtempSync(join(tmpdir(), 'claude-probe-reservation-'));
  try {
    const prepared = await prepareClaudeNativeProbe(options(root));
    reserveClaudeProbeAction(root, 'launch', 'process-1'); reserveClaudeProbeAction(root, 'child', 'process-1');
    await prepared.dispose();
    const reopened = await prepareClaudeNativeProbe(options(root));
    expect(() => reserveClaudeProbeAction(root, 'launch', 'process-1')).toThrow('claude_probe_already_reserved');
    expect(() => reserveClaudeProbeAction(root, 'child', 'process-1')).toThrow('claude_probe_already_reserved');
    await reopened.dispose();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test.each([{ version: '2.1.289' }, { sha256: 'bad' }])('unqualified binary declaration rejects before writing: %j', async patch => {
  const root = mkdtempSync(join(tmpdir(), 'claude-probe-invalid-'));
  try { const o = options(root); await expect(prepareClaudeNativeProbe({ ...o, binary: { ...o.binary, ...patch } })).rejects.toThrow('claude_probe_invalid_preparation'); }
  finally { rmSync(root, { recursive: true, force: true }); }
});
test('provider alias/model drift, bad identity and non-loopback destinations cannot prepare', async () => {
  const root = mkdtempSync(join(tmpdir(), 'claude-probe-invalid-'));
  try {
    const o = options(root);
    for (const patch of [{ model: 'sonnet' }, { nativeSessionId: 'not-a-uuid' }, { destination: { ...o.destination, endpoint: 'http://example.com:4318' } }]) await expect(prepareClaudeNativeProbe({ ...o, ...patch })).rejects.toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('reservations are bound to immutable manifest and child requires launch reservation first', async () => {
  const root = mkdtempSync(join(tmpdir(), 'claude-probe-boundary-'));
  try {
    const p = await prepareClaudeNativeProbe(options(root));
    expect(() => reserveClaudeProbeAction(root, 'launch', 'foreign-process')).toThrow('claude_probe_reservation_scope');
    expect(() => reserveClaudeProbeAction(root, 'child', 'process-1')).toThrow('claude_probe_launch_required');
    await p.dispose();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('workflow launch also pins a classifier-free permission mode', async () => {
  const root = mkdtempSync(join(tmpdir(), 'claude-probe-workflow-'));
  try {
    const prepared = await prepareClaudeNativeProbe(workflowOptions(root), { model: 'claude-sonnet-5-5', effort: 'high', childRuntime: { model: 'claude-sonnet-5-5', effort: 'high' },
      instructions: 'Synthetic instructions.', maxTurns: 4, requestLimit: 8, durationMs: 120000, permissions: 'read-only' });
    expect(prepared.argv.join(' ')).toContain('--permission-mode dontAsk');
    await prepared.dispose();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('workflow permissions choose a Bash-free toolset and pass a budget only when requested', async () => {
  const root = mkdtempSync(join(tmpdir(), 'claude-probe-workflow-'));
  const flag = (argv: readonly string[], name: string) => argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;
  const base = { model: null, effort: null, instructions: 'Synthetic instructions.', maxTurns: 300, requestLimit: 600, durationMs: 3600000 };
  try {
    const readOnly = await prepareClaudeNativeProbe(workflowOptions(join(root, 'a')), { ...base, permissions: 'read-only' });
    expect([flag(readOnly.argv, '--tools'), flag(readOnly.argv, '--allowedTools')]).toEqual(['Read,Glob,Grep', 'Read,Glob,Grep']);
    expect(readOnly.argv).not.toContain('--max-budget-usd');
    expect(readOnly.manifest.limits).toMatchObject({ wallTimeMs: 3600000, plannedRequests: 600, estimatedBudgetUsd: null });
    await readOnly.dispose();
    const edit = await prepareClaudeNativeProbe(workflowOptions(join(root, 'b')), { ...base, permissions: 'workspace-edit', maxBudgetUsd: 5 });
    expect([flag(edit.argv, '--tools'), flag(edit.argv, '--allowedTools')]).toEqual(['Read,Glob,Grep,Edit,Write', 'Read,Glob,Grep,Edit,Write']);
    expect(flag(edit.argv, '--max-budget-usd')).toBe('5');
    expect(edit.argv.join(' ')).not.toMatch(/Bash/);
    await edit.dispose();
    await expect(prepareClaudeNativeProbe(options(join(root, 'c')), { ...base, permissions: 'bypass' as 'read-only' })).rejects.toThrow('claude_probe_invalid_preparation');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('workflow session modes choose the persistence flags, the SessionStart matcher and the manifest marker', async () => {
  const root = mkdtempSync(join(tmpdir(), 'claude-probe-session-'));
  const flag = (argv: readonly string[], name: string) => argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;
  const matcher = (path: string) => (JSON.parse(readFileSync(path, 'utf8')) as { hooks: { SessionStart: { matcher: string }[] } }).hooks.SessionStart[0]!.matcher;
  const base = { model: null, effort: null, instructions: 'Synthetic instructions.', maxTurns: 4, requestLimit: 8, durationMs: 120000, permissions: 'read-only' as const };
  const id = workflowOptions(root).nativeSessionId;
  try {
    const fresh = await prepareClaudeNativeProbe(workflowOptions(join(root, 'fresh')), base);
    expect([flag(fresh.argv, '--session-id'), fresh.argv.includes('--no-session-persistence'), fresh.argv.includes('--resume'), matcher(fresh.settingsPath)]).toEqual([id, true, false, 'startup']);
    expect(fresh.manifest).not.toHaveProperty('sessionPersistence'); await fresh.dispose();
    const kept = await prepareClaudeNativeProbe(workflowOptions(join(root, 'kept')), { ...base, session: 'persistent' });
    expect([flag(kept.argv, '--session-id'), kept.argv.includes('--no-session-persistence'), kept.argv.includes('--resume'), matcher(kept.settingsPath)]).toEqual([id, false, false, 'startup']);
    expect(kept.manifest.sessionPersistence).toBe('persistent'); await kept.dispose();
    // The CLI refuses --session-id together with --resume.
    const resumed = await prepareClaudeNativeProbe(workflowOptions(join(root, 'resumed')), { ...base, session: 'resume' });
    expect([flag(resumed.argv, '--resume'), resumed.argv.includes('--session-id'), resumed.argv.includes('--no-session-persistence'), matcher(resumed.settingsPath)]).toEqual([id, false, false, 'resume']);
    expect(JSON.parse(readFileSync(resumed.manifestPath, 'utf8'))).toMatchObject({ nativeSessionId: id, sessionPersistence: 'resume' }); await resumed.dispose();
    for (const session of ['persistent', 'resume'] as const)
      await expect(prepareClaudeNativeProbe(workflowOptions(join(root, 'child-' + session)), { ...base, session, childRuntime: { model: 'claude-sonnet-5-5', effort: 'high' } }))
        .rejects.toThrow('claude_probe_invalid_preparation');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('the workflow child is one read-only agent type bounded by the run turn limit; the probe keeps its acknowledgment child', async () => {
  const root = mkdtempSync(join(tmpdir(), 'claude-probe-child-'));
  const agents = (argv: readonly string[]) => JSON.parse(readFileSync(argv[argv.indexOf('--agents') + 1]!, 'utf8')) as Record<string, { tools: string[]; disallowedTools: string[]; maxTurns: number; model: string; effort: string; background: boolean }>;
  const matchers = (path: string) => { const hooks = (JSON.parse(readFileSync(path, 'utf8')) as { hooks: Record<string, { matcher: string }[]> }).hooks; return [hooks.SubagentStart![0]!.matcher, hooks.SubagentStop![0]!.matcher]; };
  try {
    const workflow = await prepareClaudeNativeProbe(workflowOptions(join(root, 'workflow')), { model: null, effort: null, childRuntime: { model: 'claude-haiku-5-5', effort: 'low' },
      instructions: 'Synthetic instructions.', maxTurns: 7, requestLimit: 8, durationMs: 120000, permissions: 'read-only' });
    const workflowAgents = agents(workflow.argv);
    expect(Object.keys(workflowAgents)).toEqual([claudeWorkflowChildAgentType]);
    expect(workflowAgents[claudeWorkflowChildAgentType]).toMatchObject({ tools: ['Read', 'Glob', 'Grep'], maxTurns: 7, model: 'claude-haiku-5-5', effort: 'low', background: false });
    const denied = workflowAgents[claudeWorkflowChildAgentType]!.disallowedTools;
    expect(denied).toEqual(expect.arrayContaining(['Agent', 'Bash', 'Write', 'Edit'])); expect(denied).not.toContain('Read');
    expect(matchers(workflow.settingsPath)).toEqual(['^workflow-child$', '^workflow-child$']); await workflow.dispose();
    const probe = await prepareClaudeNativeProbe(options(join(root, 'probe')));
    const probeAgents = agents(probe.argv);
    expect(Object.keys(probeAgents)).toEqual(['qualification-child']);
    expect(probeAgents['qualification-child']).toMatchObject({ tools: [], maxTurns: 1 });
    expect(matchers(probe.settingsPath)).toEqual(['^qualification-child$', '^qualification-child$']); await probe.dispose();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
