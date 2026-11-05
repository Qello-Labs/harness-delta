import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { confirmationPlan, readConfirmation, renderConfirmation } from '../scripts/conformance/confirm.js';
import { matchExactSessionFilename } from '../scripts/conformance/filename.js';
import { hookTrustArguments, rejectBypass, sessionStartHookIdentity, sessionStartTrustedHash } from '../scripts/conformance/hook.js';

const lines = [
  'command: /synthetic/codex-not-run',
  'options: -c check_for_update_on_startup=false',
  'synthetic request: one short turn',
  'model: synthetic',
  'settings: defaults',
  'plan: initial and resume',
  'limits: 1 turn, 30 seconds',
  'warmup and internal requests may exceed the requested turn',
  'source selection: exact filename',
  'product-created files: new session file only',
  'report stores: labels and check outcomes'
];

test('confirmation text discloses the plan and rejects reused or piped answers', () => {
  const plan = confirmationPlan(lines);
  const rendered = renderConfirmation(plan);
  for (const line of lines) expect(rendered).toContain(line);
  expect(rendered).toContain("The user's own trusted hooks may still run; this invocation does not disable them.");
  expect(rendered).not.toContain('--yes');
  expect(rendered).not.toContain('dangerously-bypass-hook-trust');
  expect(rendered).not.toContain('SECRET_PROMPT');
  expect(readConfirmation(plan, { readLine: () => 'confirm' }, null)).toBe('confirmed');
  for (const answer of ['yes', 'y', '', null]) {
    expect(readConfirmation(plan, { readLine: () => answer }, null)).toBe('aborted');
  }
  expect(readConfirmation(plan, { readLine: () => 'confirm' }, { fingerprint: plan.fingerprint })).toBe('aborted');
});

test('filename matching is product-specific and reads names only', () => {
  const id = '11112222-3333-4444-5555-666677778888';
  const codex = `rollout-2026-01-01T00-00-00-${id}.jsonl`;
  expect(matchExactSessionFilename(['other.jsonl'], id, 'codex')).toBe('none');
  expect(matchExactSessionFilename([`${id}.jsonl`], id, 'codex')).toBe('none');
  expect(matchExactSessionFilename([codex], id, 'codex')).toBe('match');
  expect(matchExactSessionFilename([codex, `rollout-later-${id}.jsonl`], id, 'codex')).toBe('ambiguous');
  expect(matchExactSessionFilename([codex], '', 'codex')).toBe('none');
  expect(matchExactSessionFilename([codex], '444455556666', 'codex')).toBe('none');
  expect(matchExactSessionFilename([codex], '4444-5555-666677778888', 'codex')).toBe('none');
  expect(matchExactSessionFilename(['other.jsonl'], 's1', 'claude_code')).toBe('none');
  expect(matchExactSessionFilename(['s1.jsonl'], 's1', 'claude_code')).toBe('match');
  expect(matchExactSessionFilename(['s1.jsonl', 's1.jsonl'], 's1', 'claude_code')).toBe('ambiguous');
  expect(matchExactSessionFilename([codex], 's1', 'claude_code')).toBe('none');
  expect(matchExactSessionFilename(['.jsonl'], '', 'claude_code')).toBe('none');
  expect(readFileSync(new URL('../scripts/conformance/filename.ts', import.meta.url), 'utf8')).not.toContain('node:fs');
});

test('hook trust arguments use the source-derived state key and reject unsafe hashes and commands', () => {
  const hash = `sha256:${'a'.repeat(64)}`;
  const stateKey = '/<session-flags>/config.toml:session_start:0:0';
  expect(stateKey.includes('"')).toBe(false);
  expect(stateKey.includes('\\')).toBe(false);
  const args = hookTrustArguments({ command: '/synthetic/hook', trustedHash: hash });
  expect(args).toEqual([
    '-c',
    'hooks.SessionStart=[{hooks=[{type="command",command="/synthetic/hook"}]}]',
    '-c',
    `hooks.state={"${stateKey}"={trusted_hash="${hash}"}}`
  ]);
  // Codex rust-v0.158.0 takes the key before the first `=` and splits it on every `.`
  // without honoring quotes, so a quoted dotted key would be split apart.
  const keySegments = args.filter((_, index) => index % 2 === 1).map(arg => arg.slice(0, arg.indexOf('=')).split('.'));
  expect(keySegments).toEqual([
    ['hooks', 'SessionStart'],
    ['hooks', 'state']
  ]);
  expect(() => hookTrustArguments({ command: '/synthetic/hook', trustedHash: 'a'.repeat(64) })).toThrow(/^invalid_hook_trust$/);
  expect(() => hookTrustArguments({ command: '/synthetic/hook', trustedHash: `sha256:${'A'.repeat(64)}` })).toThrow(/^invalid_hook_trust$/);
  expect(() => hookTrustArguments({ command: '/synthetic/hook', trustedHash: 'sha256:abc' })).toThrow(/^invalid_hook_trust$/);
  for (const command of ['echo hello', '/tmp/hook;id', '/tmp/hook"x', 'relative/hook', '/tmp/a b', '/tmp/hook\\x', '/tmp/../hook']) {
    expect(() => hookTrustArguments({ command, trustedHash: hash })).toThrow(/^invalid_hook_command$/);
  }
  expect(() => rejectBypass(['--dangerously-bypass-hook-trust'])).toThrow(/^bypass_rejected$/);
  expect(readFileSync(new URL('../scripts/conformance/hook.ts', import.meta.url), 'utf8')).not.toContain('node:fs');
});

test('the SessionStart trusted hash follows the source-derived normalized identity', () => {
  // Reference digest computed independently (Python hashlib) over the pinned preimage.
  expect(sessionStartHookIdentity('/synthetic/hook')).toBe(
    '{"event_name":"session_start","hooks":[{"async":false,"command":"/synthetic/hook","timeout":600,"type":"command"}]}'
  );
  expect(sessionStartTrustedHash('/synthetic/hook')).toBe('sha256:8db9f718a661878ce480f044378622df9ded752e63415b48110deb677cac4485');
  expect(() => sessionStartTrustedHash('relative/hook')).toThrow(/^invalid_hook_command$/);
  const command = '/synthetic/hook';
  expect(() => hookTrustArguments({ command, trustedHash: sessionStartTrustedHash(command) })).not.toThrow();
});
