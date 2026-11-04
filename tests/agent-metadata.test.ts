import { expect, test } from 'vitest';
import { metadataName } from '../src/agent-metadata.js';
import { bindingIdentityKey, VerifiedSessionIdentitySchema } from '../src/session-binding-contract.js';

test('names are bounded single-line metadata and strict identity contracts reject private fields and wrong-product sources', () => {
  expect(metadataName('  검토자  ')).toBe('검토자');
  for (const value of [null, undefined, '', '   ', 'x'.repeat(129), 'line\nsecond', 'name\u202e', { text: 'synthetic-private' }])
    expect(metadataName(value)).toBeNull();
  const identity = {
    product: 'codex',
    productVersion: '0.160.0',
    sessionId: 'synthetic-session',
    sourceRef: '/synthetic/session',
    sourceIdentity: 'synthetic-source',
    cwd: '/synthetic/project',
    identityEvidenceId: 'synthetic-proof',
    parentSessionId: null,
    createdAt: '2026-10-08T00:00:00Z'
  };
  const legacy = VerifiedSessionIdentitySchema.parse(identity);
  const named = VerifiedSessionIdentitySchema.parse({ ...identity, agentMetadata: { source: 'codex_session_meta', nickname: 'Cedar', role: null } });
  expect(bindingIdentityKey(named)).toBe(bindingIdentityKey(legacy));
  expect(VerifiedSessionIdentitySchema.safeParse({ ...identity, agentMetadata: { source: 'claude_hook', agentType: 'Explore' } }).success).toBe(false);
  expect(
    VerifiedSessionIdentitySchema.safeParse({
      ...identity,
      agentMetadata: { source: 'codex_session_meta', nickname: 'Cedar', role: null, prompt: 'synthetic-private' }
    }).success
  ).toBe(false);
});
