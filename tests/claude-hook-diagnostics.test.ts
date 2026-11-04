import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Synthetic hook stdin only. Never invoke a product CLI or inspect user sessions.
const session = '11111111-1111-4111-8111-111111111111';
const otherSession = '22222222-2222-4222-8222-222222222222';
const secret = 'SYNTHETIC-PRIVATE-CONTENT';
let root: string;
let receipts: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hd-hook-diagnostics-'));
  receipts = join(root, 'receipts');
});
afterEach(() => {
  chmodSync(root, 0o700);
  rmSync(root, { recursive: true, force: true });
});
const stop = () => ({
  session_id: session,
  hook_event_name: 'SubagentStop',
  transcript_path: '/synthetic/parent.jsonl',
  cwd: '/synthetic/project',
  agent_id: 'child-a',
  agent_transcript_path: '/synthetic/subagents/agent-child-a.jsonl',
  last_assistant_message: secret,
  tool_input: { command: secret },
  prompt: secret,
  background_tasks: [{ description: secret }]
});
const outcome = (status: string, reasonCode: string) => ({ schema_version: 1, kind: 'subagent_stop', status, reason_code: reasonCode });

for (const path of ['scripts/claude-session-hook.mjs', 'skills/harness-connect/scripts/claude-session-hook.mjs']) {
  describe(path, () => {
    const hook = resolve(import.meta.dirname, '..', path);
    const record = (input: unknown, diagnosticSession: string | null = session, claudePid: string = '12345', prefix: string[] = []) =>
      spawnSync(process.execPath, [...prefix, hook, 'record', '--dir', receipts, ...(diagnosticSession ? ['--diagnostics-session', diagnosticSession] : [])], {
        input: typeof input === 'string' ? input : JSON.stringify(input),
        encoding: 'utf8',
        env: { PATH: process.env.PATH, CLAUDE_PID: claudePid }
      });
    const diagnostic = (result: ReturnType<typeof record>) => {
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).not.toContain(secret);
      expect(result.stderr).not.toContain('/synthetic');
      expect(result.stderr).not.toContain(session);
      expect(result.stderr).not.toBe('');
      return JSON.parse(result.stderr) as unknown;
    };

    it.each([
      ['session_id', '', 'session_id_invalid'],
      ['transcript_path', 'relative.jsonl', 'transcript_path_invalid'],
      ['cwd', undefined, 'cwd_invalid'],
      ['agent_id', '../child', 'agent_id_invalid'],
      ['agent_transcript_path', undefined, 'agent_transcript_path_invalid'],
      ['agent_transcript_path', '~/child.jsonl', 'agent_transcript_path_invalid']
    ])('reports rejected %s without creating a stop receipt', (field, value, reasonCode) => {
      expect(diagnostic(record({ ...stop(), [field]: value }))).toEqual(outcome('rejected', reasonCode));
      expect(() => readdirSync(receipts)).toThrow();
    });

    it('reports missing native PID without relaxing admission', () => {
      expect(diagnostic(record(stop(), session, ''))).toEqual(outcome('rejected', 'claude_pid_invalid'));
      expect(() => readdirSync(receipts)).toThrow();
    });

    it('reports malformed or oversized stdin without echoing it', () => {
      expect(diagnostic(record('{"private":"' + secret))).toEqual({
        schema_version: 1,
        kind: null,
        status: 'rejected',
        reason_code: 'hook_input_invalid_json'
      });
      expect(diagnostic(record(secret.repeat(200000)))).toEqual({ schema_version: 1, kind: null, status: 'rejected', reason_code: 'hook_input_too_large' });
      expect(() => readdirSync(receipts)).toThrow();
    });

    it('distinguishes successful write, existing receipt and deletion suppression', () => {
      expect(diagnostic(record(stop()))).toEqual(outcome('recorded', 'receipt_recorded'));
      const filename = join(receipts, 'sessions', session, 'agents', 'child-a.subagent_stop.json');
      const before = readFileSync(filename, 'utf8');
      expect(before).not.toContain(secret);
      expect(diagnostic(record(stop()))).toEqual(outcome('ignored', 'receipt_exists'));
      expect(readFileSync(filename, 'utf8')).toBe(before);
      mkdirSync(join(receipts, 'forgotten'), { mode: 0o700 });
      writeFileSync(join(receipts, 'forgotten', session), '', { mode: 0o600 });
      expect(diagnostic(record({ ...stop(), agent_id: 'child-b' }))).toEqual(outcome('ignored', 'session_forgotten'));
      expect(readdirSync(join(receipts, 'sessions', session, 'agents'))).toEqual(['child-a.subagent_stop.json']);
    });

    it('reports write failure with a fixed code and never an exception path', () => {
      writeFileSync(receipts, secret);
      expect(diagnostic(record(stop()))).toEqual(outcome('error', 'receipt_write_failed'));
      expect(readFileSync(receipts, 'utf8')).toBe(secret);
    });

    it('reports atomic link failure separately from an existing receipt', () => {
      // Fault injection at the filesystem boundary makes a non-EEXIST link error deterministic.
      const preload = join(root, 'link-failure.mjs');
      writeFileSync(
        preload,
        `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
        fs.linkSync = () => { throw Object.assign(new Error('${secret}'), { code: 'EPERM' }); }; syncBuiltinESMExports();`
      );
      expect(diagnostic(record(stop(), session, '12345', ['--import', preload]))).toEqual(outcome('error', 'receipt_write_failed'));
      expect(readdirSync(join(receipts, 'sessions', session, 'agents'))).toEqual([]);
    });

    it('fails closed when the deletion marker lookup is obstructed', () => {
      mkdirSync(receipts, { mode: 0o700 });
      writeFileSync(join(receipts, 'forgotten'), secret, { mode: 0o600 });
      expect(diagnostic(record(stop()))).toEqual(outcome('error', 'receipt_write_failed'));
      expect(readdirSync(receipts)).toEqual(['forgotten']);
    });

    it('never blocks a session when the diagnostic reader closes', async () => {
      const child = spawn(process.execPath, [hook, 'record', '--dir', receipts, '--diagnostics-session', session], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { PATH: process.env.PATH, CLAUDE_PID: '12345' }
      });
      let stdout = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.destroy();
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
        child.stdin.end('{' + secret);
      });
      expect(code).toBe(0);
      expect(stdout).toBe('');
      expect(() => readdirSync(receipts)).toThrow();
    });

    it('ignores malformed event selectors without converting raw input into errors', () => {
      for (const event of [{ toString: secret }, '__proto__', ['SubagentStop']]) {
        const result = record({ ...stop(), hook_event_name: event });
        expect(result.status).toBe(0);
        expect(result.stdout).toBe('');
        expect(result.stderr).toBe('');
      }
    });

    it('keeps default mode silent and filters diagnostics to an explicitly selected session', () => {
      for (const input of [stop(), { ...stop(), agent_transcript_path: null }, '{' + secret]) {
        const result = record(input, null);
        expect(result.status).toBe(0);
        expect(result.stdout).toBe('');
        expect(result.stderr).toBe('');
      }
      const foreign = record({ ...stop(), session_id: otherSession });
      expect(foreign.stderr).toBe('');
      const badSelection = record(stop(), 'invalid');
      expect(badSelection.stderr).toBe('');
      const unrelated = record({ ...stop(), hook_event_name: 'UserPromptSubmit', prompt: secret });
      expect(unrelated.stderr).toBe('');
      const tool = record({ ...stop(), hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: secret } });
      expect(tool.stderr).toBe('');
    });
  });
}
