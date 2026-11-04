import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { diagnosticArguments, runDiagnostic, type DiagnosticDeps } from '../scripts/conformance/minimal-diagnostic.js';
import {
  allMcpDisabled,
  boundedSpawn,
  createDiagnosticEnvironment,
  diagnosticMain,
  filteredDiagnosticEnvironment,
  isolationArguments
} from '../scripts/conformance/minimal-diagnostic-runner.js';
const disabled = JSON.stringify(
  ['code-review', 'codex_app', 'computer-use', 'cua_repl', 'node_repl'].map(name => ({ name, enabled: false, transport: { secret: 'PRIVATE' } }))
);
const result = (stdout: string) => ({ code: 0, timedOut: false, spawnError: false, stdout });
describe('explicit diagnostic execution adaptor', () => {
  it('filters inherited product variables and applies only the verified process-local access reductions', () => {
    expect(
      filteredDiagnosticEnvironment({
        PATH: 'synthetic',
        CLAUDE_TEST: 'private',
        CODEX_HOME: 'private',
        OTEL_TEST: 'private',
        ENABLE_TEST: 'private',
        BETA_TRACING_TEST: 'private',
        SAFE: 'kept'
      })
    ).toEqual({ PATH: 'synthetic', SAFE: 'kept' });
    expect(isolationArguments).toEqual([
      '-c',
      'mcp_servers.node_repl.enabled=false',
      '-c',
      'mcp_servers.computer-use.enabled=false',
      '-c',
      'plugins.unified-computer-use@openai-bundled.mcp_servers.cua_repl.enabled=false'
    ]);
    expect(allMcpDisabled(disabled)).toBe(true);
    expect(allMcpDisabled(JSON.stringify([{ name: 'unexpected', enabled: true }]))).toBe(false);
    expect(allMcpDisabled('[]')).toBe(false);
    expect(allMcpDisabled('PRIVATE invalid')).toBe(false);
  });
  it('does nothing without the explicit execution flag or with an unpinned binary', async () => {
    let calls = 0;
    const env = {
      cwd: '/synthetic/repository',
      binary: '/synthetic/release/codex',
      execute: () => {
        calls++;
        return Promise.resolve('observed_semantics_unknown');
      },
      write: () => {
        /* no output */
      }
    };
    expect(await diagnosticMain([], env)).toBe(2);
    expect(await diagnosticMain(['--execute-approved-five-attempts', '--binary', '/different/codex'], env)).toBe(2);
    expect(calls).toBe(0);
    expect(await diagnosticMain(['--execute-approved-five-attempts', '--binary', env.binary], env)).toBe(0);
    expect(calls).toBe(1);
  });
  it('uses private empty fixtures, overrides every probe and generation, checks config, and persists one fixed ledger', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hd-real-adaptor-test-'));
    const home = join(root, 'home');
    const cwd = join(root, 'repo');
    const temp = join(root, 'temp');
    mkdirSync(join(home, '.codex'), { recursive: true });
    mkdirSync(cwd);
    mkdirSync(temp);
    writeFileSync(join(home, '.codex/config.toml'), '# synthetic\n');
    writeFileSync(join(home, '.codex/AGENTS.md'), '');
    const calls: string[][] = [];
    let generations = 0;
    try {
      const env = createDiagnosticEnvironment({
        home,
        cwd,
        tempRoot: temp,
        env: { PATH: 'synthetic' },
        processRunner: (_binary, args, options) => {
          calls.push([...args]);
          expect(args.slice(0, 6)).toEqual(isolationArguments);
          if (args.includes('--version')) return Promise.resolve(result('codex-cli 0.160.0\n'));
          if (args.includes('list')) return Promise.resolve(result(disabled));
          generations++;
          expect(statSync(options.cwd).mode & 0o777).toBe(0o700);
          const id = generations < 4 ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222';
          return Promise.resolve(
            result(
              [{ type: 'thread.started', thread_id: id }, { type: 'turn.started' }, { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 1 } }]
                .map(x => JSON.stringify(x))
                .join('\n')
            )
          );
        },
        write: () => {
          /* no output */
        }
      });
      expect(await diagnosticMain(['--execute-approved-five-attempts', '--binary', env.binary], env)).toBe(0);
      expect(generations).toBe(5);
      expect(await diagnosticMain(['--execute-approved-five-attempts', '--binary', env.binary], env)).toBe(1);
      expect(generations).toBe(5);
      const ledger = join(cwd, '.harness-delta/work/minimal-live-collection-cost-validation-2026-10-03/generation-ledger.jsonl');
      expect(readFileSync(ledger, 'utf8')).not.toContain('PRIVATE');
      expect(statSync(ledger).mode & 0o777).toBe(0o600);
      expect(calls.filter(x => x.includes('resume'))).toHaveLength(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('blocks generation when effective MCP verification fails or config changes after a generation', async () => {
    for (const mode of ['mcp', 'changed'] as const) {
      const root = mkdtempSync(join(tmpdir(), 'hd-real-block-test-'));
      mkdirSync(join(root, '.codex'));
      const config = join(root, '.codex/config.toml');
      writeFileSync(config, '# synthetic\n');
      let generations = 0;
      try {
        const env = createDiagnosticEnvironment({
          home: root,
          cwd: root,
          tempRoot: root,
          env: {},
          processRunner: (_binary, args) => {
            if (args.includes('--version')) return Promise.resolve(result('codex-cli 0.160.0'));
            if (args.includes('list')) return Promise.resolve(result(mode === 'mcp' ? '[]' : disabled));
            generations++;
            writeFileSync(config, '# changed synthetic config\n');
            return Promise.resolve(
              result(
                JSON.stringify({ type: 'thread.started', thread_id: '11111111-1111-4111-8111-111111111111' }) +
                  '\n' +
                  JSON.stringify({ type: 'turn.started' }) +
                  '\n' +
                  JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } })
              )
            );
          },
          write: () => {
            /* no output */
          }
        });
        expect(await diagnosticMain(['--execute-approved-five-attempts', '--binary', env.binary], env)).toBe(1);
        expect(generations).toBe(mode === 'mcp' ? 0 : 1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
  it('bounds the real process, discards stderr, filters its env, and stops stdout overflow', async () => {
    const success = await boundedSpawn(
      process.execPath,
      ['-e', 'process.stderr.write("PRIVATE");process.stdout.write(JSON.stringify(Object.keys(process.env)));'],
      { cwd: tmpdir(), timeoutMs: 1000, env: { CODEX_TEST: 'private', SAFE: 'kept' }, stdoutLimit: 1024 }
    );
    expect(success.code).toBe(0);
    expect(success.stdout).toContain('SAFE');
    expect(success.stdout).not.toContain('CODEX_TEST');
    expect(success.stdout).not.toContain('PRIVATE');
    const overflow = await boundedSpawn(process.execPath, ['-e', 'process.stdout.write("x".repeat(4096));setTimeout(()=>{},5000)'], {
      cwd: tmpdir(),
      timeoutMs: 1000,
      env: {},
      stdoutLimit: 32
    });
    expect(overflow.streamStopped).toBe(true);
    expect(overflow.stdout).toBe('');
    const timeout = await boundedSpawn(process.execPath, ['-e', 'setTimeout(()=>{},5000)'], { cwd: tmpdir(), timeoutMs: 50, env: {}, stdoutLimit: 1024 });
    expect(timeout.timedOut).toBe(true);
  });
  it('interrupts an observable tool attempt while its process is still running', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hd-stream-test-'));
    const script = join(root, 'synthetic.cjs');
    writeFileSync(
      script,
      'process.stdout.write(JSON.stringify({type:"item.started",item:{type:"command_execution",command:"PRIVATE"}})+"\\n");setTimeout(()=>{},5000);'
    );
    chmodSync(script, 0o600);
    try {
      const r = await boundedSpawn(process.execPath, [script], { cwd: root, timeoutMs: 1000, env: {}, stdoutLimit: 1024, observeEvents: true });
      expect(r.streamStopped).toBe(true);
      expect(r.guardDiagnostic).toEqual({
        branch: 'item_type',
        reason: 'unexpected_item',
        eventType: 'item.started',
        itemType: 'command_execution'
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it.each([
    ['error', undefined, 'event_type', 'unexpected_event', 'error', 'unknown'],
    ['turn.failed', undefined, 'event_type', 'unexpected_event', 'turn.failed', 'unknown'],
    ['PRIVATE sk-synthetic-auth', undefined, 'event_type', 'unexpected_event', 'unknown', 'unknown'],
    ['x'.repeat(2048), undefined, 'event_type', 'unexpected_event', 'unknown', 'unknown'],
    ['item.started', 'PRIVATE /synthetic/session/auth', 'item_type', 'unexpected_item', 'item.started', 'unknown'],
    ['item.updated', 'x'.repeat(2048), 'item_type', 'unexpected_item', 'item.updated', 'unknown'],
    ...['command_execution', 'file_change', 'mcp_tool_call', 'collab_tool_call', 'web_search', 'todo_list', 'error'].map(
      item => ['item.completed', item, 'item_type', 'unexpected_item', 'item.completed', item] as const
    )
  ] as const)('records enum-only guard diagnostics for event %s and item %s', async (event, item, branch, reason, eventType, itemType) => {
    const line =
      JSON.stringify({
        type: event,
        item: { type: item, command: 'PRIVATE COMMAND', text: 'PRIVATE BODY', path: '/PRIVATE', session_id: 'PRIVATE ID', auth: 'PRIVATE AUTH' }
      }) + '\n';
    const r = await boundedSpawn(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(line)});setTimeout(()=>{},5000);`], {
      cwd: tmpdir(),
      timeoutMs: 1000,
      env: {},
      stdoutLimit: 8192,
      observeEvents: true
    });
    expect(r.streamStopped).toBe(true);
    expect(r.timedOut).toBe(false);
    const diagnostic = r.guardDiagnostic;
    expect(diagnostic).toMatchObject({ branch, reason, eventType, itemType });
    expect(JSON.stringify(diagnostic)).not.toContain('PRIVATE');
  });
  it.each(['thread.started', 'turn.started', 'turn.completed'])('identifies repeated %s boundaries without retaining their bodies', async eventType => {
    const line = JSON.stringify({ type: eventType, thread_id: 'PRIVATE ID', usage: { secret: 'PRIVATE' } }) + '\n';
    const r = await boundedSpawn(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(line + line)});setTimeout(()=>{},5000);`], {
      cwd: tmpdir(),
      timeoutMs: 1000,
      env: {},
      stdoutLimit: 1024,
      observeEvents: true
    });
    expect(r.streamStopped).toBe(true);
    expect(r.guardDiagnostic).toEqual({ branch: 'boundary_count', reason: 'repeated_boundary', eventType, itemType: 'unknown' });
  });
  it.each([
    ['PRIVATE invalid JSON\n', 1024, 'json_parse', 'invalid_json'],
    ['PRIVATE'.repeat(1024), 32, 'stdout_bytes', 'stdout_limit']
  ])('identifies body-free malformed/overflow stop %s', async (stdout, stdoutLimit, branch, reason) => {
    const r = await boundedSpawn(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(stdout)});setTimeout(()=>{},5000);`], {
      cwd: tmpdir(),
      timeoutMs: 1000,
      env: {},
      stdoutLimit,
      observeEvents: true
    });
    expect(r.streamStopped).toBe(true);
    expect(r.guardDiagnostic).toEqual({ branch, reason, eventType: 'unknown', itemType: 'unknown' });
  });
});

describe('real synthetic error guard persistence', () => {
  it.each([
    [
      { type: 'item.completed', item: { id: 'PRIVATE', type: 'error', message: 'request timed out', code: 'PRIVATE', status: 401 } },
      'item_message',
      'transport',
      'request_timeout'
    ],
    [
      { type: 'error', message: 'Your access token could not be refreshed. Please log out and sign in again.' },
      'event_message',
      'authentication',
      'refresh_token'
    ],
    [{ type: 'turn.failed', error: { message: 'rate limit exceeded: ' } }, 'turn_error_message', 'rate_limit', 'rate_limit_empty'],
    [
      { type: 'item.completed', item: { type: 'error', message: JSON.stringify({ error: { code: 'rate_limit_exceeded', status: 429 } }) } },
      'item_message',
      'rate_limit',
      undefined
    ]
  ] as const)('persists classified official-schema error evidence and stops before later completion (%j)', async (event, source, cause, template) => {
    const root = mkdtempSync(join(tmpdir(), 'hd-error-classification-test-'));
    const ledger = join(root, 'ledger.jsonl');
    let calls = 0;
    const lines =
      [
        event,
        { type: 'thread.started', thread_id: 'PRIVATE' },
        { type: 'turn.started' },
        { type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 10 } }
      ]
        .map(x => JSON.stringify(x))
        .join('\n') + '\n';
    const deps: DiagnosticDeps = {
      preflight: () => ({
        versionMatches: true,
        configurationStable: true,
        globalInstructionBytes: 0,
        mcpServerCount: 0,
        otherInstructionOverrides: false,
        hooksConfigured: false,
        codexHomeSet: false
      }),
      createFixture: () => root,
      spawn: async () => {
        calls++;
        const r = await boundedSpawn(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(lines)});setTimeout(()=>{},5000);`], {
          cwd: root,
          timeoutMs: 1000,
          env: {},
          stdoutLimit: 8192,
          observeEvents: true
        });
        expect(r.guardDiagnostic?.errorDiagnostic).toMatchObject({
          source,
          cause,
          ...(template === undefined
            ? { evidenceKind: 'structured_message', code: 'rate_limit_exceeded', status: 429 }
            : { evidenceKind: 'trusted_message', template })
        });
        return r;
      }
    };
    try {
      expect(await runDiagnostic(ledger, deps)).toBe('unexpected_activity');
      expect(calls).toBe(1);
      expect(await runDiagnostic(ledger, deps)).toBe('terminal_ledger');
      expect(calls).toBe(1);
      const saved = readFileSync(ledger, 'utf8');
      const rows = saved
        .split('\n')
        .filter(Boolean)
        .map(x => JSON.parse(x) as { kind: string; guard_diagnostic?: { error_diagnostic: unknown } });
      expect(rows.find(x => x.kind === 'process_outcome')?.guard_diagnostic?.error_diagnostic).toMatchObject({
        source,
        cause,
        evidence_kind: template === undefined ? 'structured_message' : 'trusted_message'
      });
      expect(rows.filter(x => x.kind === 'observation')).toHaveLength(0);
      expect(saved).not.toContain('PRIVATE');
      expect(saved).not.toContain('request timed out');
      expect(saved).not.toContain('Your access token');
      expect(saved).not.toContain('input_tokens');
      expect(saved).not.toContain('output_tokens');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

const resumeSession = '11111111-1111-4111-8111-111111111111';
const resumeContext = { sessionId: resumeSession, previousModel: 'gpt-6-luna', currentModel: 'gpt-5.6-luna' } as const;
const officialResumeWarning =
  'This session was recorded with model `gpt-6-luna` but is resuming with `gpt-5.6-luna`. Consider switching back to `gpt-6-luna` as it may affect Codex performance.';
const resumeWarningEvent = { type: 'item.completed', item: { id: 'item_0', type: 'error', message: officialResumeWarning } };
const resumeEvents = (warning: unknown = resumeWarningEvent) => [
  { type: 'thread.started', thread_id: resumeSession },
  warning,
  { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'PRIVATE' } },
  { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 1 } }
];
async function syntheticResume(events: unknown[], context: unknown = resumeContext, invocation?: string[]) {
  const lines = events.map(x => JSON.stringify(x)).join('\n') + '\n';
  const args = invocation ?? [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '-c',
    'sandbox_mode="read-only"',
    '--model',
    'gpt-5.6-luna',
    '-c',
    'model_reasoning_effort="low"',
    'resume',
    resumeSession,
    'Reply with exactly one word: again'
  ];
  const root = mkdtempSync(join(tmpdir(), 'hd-resume-warning-test-'));
  const binary = join(root, 'synthetic-codex');
  writeFileSync(binary, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(lines)});\n`, { mode: 0o700 });
  try {
    return await boundedSpawn(binary, args, { cwd: root, timeoutMs: 5000, env: {}, observeEvents: true, resumeWarningContext: context } as Parameters<
      typeof boundedSpawn
    >[2]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
describe('exact official nonfatal resume warning', () => {
  it('continues to a completed turn for the explicit approved same-session transition', async () => {
    const r = await syntheticResume(resumeEvents());
    expect(r.streamStopped).toBe(false);
    expect(r.code).toBe(0);
    expect(r).toHaveProperty('warningCounts', { resume_model_changed: 1 });
    expect(r.guardDiagnostic).toBeUndefined();
  });
  it('accepts the exact process isolation overrides and the approved reverse transition', async () => {
    const isolated = await syntheticResume(resumeEvents(), resumeContext, [...isolationArguments, ...diagnosticArguments(1, resumeSession)]);
    expect(isolated.streamStopped).toBe(false);
    expect(isolated.warningCounts).toEqual({ resume_model_changed: 1 });
    const reversed = {
      ...resumeWarningEvent,
      item: {
        ...resumeWarningEvent.item,
        message: officialResumeWarning.replaceAll('gpt-6-luna', 'TEMP').replaceAll('gpt-5.6-luna', 'gpt-6-luna').replaceAll('TEMP', 'gpt-5.6-luna')
      }
    };
    const r = await syntheticResume(
      resumeEvents(reversed),
      { ...resumeContext, previousModel: 'gpt-5.6-luna', currentModel: 'gpt-6-luna' },
      diagnosticArguments(2, resumeSession)
    );
    expect(r.streamStopped).toBe(false);
    expect(r.warningCounts).toEqual({ resume_model_changed: 1 });
  }, 20000); // Two independent bounded five-second fixture processes.
  it.each([
    ['no context', undefined, undefined],
    ['wrong previous model', { ...resumeContext, previousModel: 'other' }, undefined],
    ['wrong current model', { ...resumeContext, currentModel: 'other' }, undefined],
    ['same model', { ...resumeContext, previousModel: 'gpt-5.6-luna' }, undefined],
    ['different session', { ...resumeContext, sessionId: '22222222-2222-4222-8222-222222222222' }, undefined],
    ['initial invocation', resumeContext, ['exec', '--json', '--model', 'gpt-5.6-luna']],
    ['mismatched request', resumeContext, ['exec', '--json', '--model', 'gpt-6-luna', 'resume', resumeSession]],
    ['model override before exec', resumeContext, ['--model', 'other', ...diagnosticArguments(1, resumeSession)]],
    ['config override before exec', resumeContext, ['-c', 'model="other"', ...diagnosticArguments(1, resumeSession)]],
    ['duplicate model option', resumeContext, ['exec', '--json', '--model', 'gpt-5.6-luna', '--model', 'gpt-6-luna', 'resume', resumeSession]]
  ])('keeps %s fatal', async (_name, context, args) => {
    const r = await syntheticResume(resumeEvents(), context ?? null, args);
    expect(r.streamStopped).toBe(true);
  });
  it.each([
    { ...resumeWarningEvent, item: { ...resumeWarningEvent.item, message: officialResumeWarning + ' PRIVATE' } },
    { ...resumeWarningEvent, item: { ...resumeWarningEvent.item, message: 'PRIVATE ' + officialResumeWarning } },
    { ...resumeWarningEvent, item: { ...resumeWarningEvent.item, message: officialResumeWarning.replaceAll('gpt-6-luna', 'other') } },
    { ...resumeWarningEvent, item: { ...resumeWarningEvent.item, message: 'model rerouted: gpt-5.6-luna -> other' } },
    { ...resumeWarningEvent, item: { ...resumeWarningEvent.item, message: 'request timed out' } },
    { ...resumeWarningEvent, item: { ...resumeWarningEvent.item, message: 42 } },
    { ...resumeWarningEvent, item: { type: 'error', message: officialResumeWarning } },
    { ...resumeWarningEvent, item: { ...resumeWarningEvent.item, command: 'PRIVATE' } },
    { ...resumeWarningEvent, extra: 'PRIVATE' },
    { ...resumeWarningEvent, type: 'item.started' },
    { ...resumeWarningEvent, item: { ...resumeWarningEvent.item, type: 'command_execution' } },
    { type: 'error', message: officialResumeWarning },
    { type: 'turn.failed', error: { message: officialResumeWarning } }
  ])('keeps malformed, extended, rerouted and real errors fatal (%j)', async event => {
    const r = await syntheticResume(resumeEvents(event));
    expect(r.streamStopped).toBe(true);
    expect(JSON.stringify(r.guardDiagnostic)).not.toContain('PRIVATE');
  });
  it.each([
    [resumeWarningEvent, ...resumeEvents().slice(0, 1), ...resumeEvents().slice(2)],
    [...resumeEvents().slice(0, 2), resumeWarningEvent, ...resumeEvents().slice(2)],
    [resumeEvents()[0], { type: 'turn.started' }, resumeWarningEvent, resumeEvents()[4]],
    [{ type: 'thread.started', thread_id: '22222222-2222-4222-8222-222222222222' }, ...resumeEvents().slice(1)]
  ])('requires matching thread first and one warning before the turn (%j)', async (...events) => {
    const r = await syntheticResume(events);
    expect(r.streamStopped).toBe(true);
  });
});
