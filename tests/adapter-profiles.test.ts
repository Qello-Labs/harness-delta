import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { lookupFileProfile, registeredFileProfiles } from '../src/adapter-profiles.js';

test('lookup returns only exact registered profiles', () => {
  expect(registeredFileProfiles.map(profile => [profile.product, profile.version])).toEqual([
    ['codex', '0.156.1'],
    ['claude_code', '2.1.283'],
    ['codex', '0.158.0']
  ]);
  expect(lookupFileProfile('codex', '0.156.1')).toMatchObject({
    kind: 'registered',
    product: 'codex',
    version: '0.156.1',
    counterMode: 'cumulative_total',
    evidence: { completeTotals: false, reasoning: 'explicit_zero_observed_nonzero_unmeasurable' }
  });
  expect(lookupFileProfile('claude_code', '2.1.283')).toMatchObject({
    kind: 'registered',
    product: 'claude_code',
    version: '2.1.283',
    counterMode: 'message_components',
    evidence: { completeTotals: false, reasoning: 'unmeasurable' }
  });
  for (const version of ['0.159.0', '0.158.0-rc.1', '0.158.0+build.1', '0.156.1-rc.1', '0.156.1+build.1', '0.156.10', '0.156.1 ', '2.1.283']) {
    expect(lookupFileProfile('codex', version)).toBe('unsupported');
  }
  expect(lookupFileProfile('claude_code', '0.156.1')).toBe('unsupported');
  expect(lookupFileProfile('claude_code', '2.1.283-rc.1')).toBe('unsupported');
  expect(lookupFileProfile('CODEX', '0.156.1')).toBe('unsupported');
  const codex = lookupFileProfile('codex', '0.156.1');
  expect(codex).not.toBe('unsupported');
  if (codex !== 'unsupported' && codex.product === 'codex') {
    expect(codex.recognizedTypes).toEqual(['session_meta', 'event_msg', 'response_item', 'world_state', 'turn_context', 'token_usage_record', 'compacted']);
    expect(codex.counterFields).toEqual(['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens']);
    expect(codex.allowedSources).toEqual(['cli', 'exec']);
  }
  const claude = lookupFileProfile('claude_code', '2.1.283');
  if (claude !== 'unsupported' && claude.product === 'claude_code') {
    expect(claude.identityTypes).toEqual(['assistant', 'user', 'attachment']);
    expect(claude.componentFields).toEqual(['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']);
  }
});

test('production parser source takes versions from the registry', () => {
  const source = readFileSync(new URL('../src/sources/adapters.ts', import.meta.url), 'utf8');
  expect(source).toContain('lookupCompatibleFileProfile');
  expect(source).not.toContain('0.156.1');
  expect(source).not.toContain('2.1.283');
  expect(source).not.toContain('0.158.0');
  expect(source).not.toContain('profile.evidence');
});
