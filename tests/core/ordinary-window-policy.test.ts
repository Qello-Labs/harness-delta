import { describe, expect, it } from 'vitest';
import {
  OrdinaryWindowConnectionProofSchema,
  ordinaryWindowDigest,
  ordinaryWindowPolicies,
  OrdinaryWindowSelectionSchema,
  resolveOrdinaryWindow
} from '../../src/core/ordinary-window-policy.js';
import { resolveSourceCompatibility, sourceCompatibilityWindows } from '../../src/source-compatibility.js';

describe('ordinary root policy selection', () => {
  it.each([
    ['codex', '0.162.1', false],
    ['codex', '0.163.0', false],
    ['codex', '0.163.1', true],
    ['codex', '0.164.0', true],
    ['codex', '0.165.0', true],
    ['codex', '0.166.0', true],
    ['codex', '0.167.0', true],
    ['codex', '0.169.999', true],
    ['codex', '0.170.0', false],
    ['codex', '0.171.0', false],
    ['codex', '0.164.0-rc.1', false],
    ['codex', '00.164.0', false],
    ['claude_code', '2.1.306', false],
    ['claude_code', '2.1.307', true],
    ['claude_code', '2.1.318', true],
    ['claude_code', '2.1.319', true],
    ['claude_code', '2.2.0', false],
    ['claude_code', '2.1.319+build', false],
    ['claude_code', '2.1.1000000000', false],
    ['other', '2.1.319', false]
  ])('selects only the strict stable range for %s %s', (product, version, eligible) => {
    const result = resolveOrdinaryWindow(product, version);
    expect(result !== null).toBe(eligible);
    if (result) {
      expect(result.compatibility.product_version).toBe(version);
      expect(result.compatibility.state).toBe('compatibility_unverified');
      expect(result.policy.maxMembers).toBe(1);
      expect(result.policy.maxDepth).toBe(0);
    }
  });

  it('does not manufacture exact rows or reinterpret the legacy binding resolver', () => {
    expect(resolveSourceCompatibility('codex', '0.164.0', 'codex_binding')).toBeNull();
    expect(resolveSourceCompatibility('claude_code', '2.1.318', 'claude_binding')).toBeNull();
    expect(resolveSourceCompatibility('codex', '0.166.0', 'codex_binding')).toMatchObject({
      state: 'compatibility_unverified',
      profile_id: 'codex-binding-01660-direct-family-v1',
      parser_version: '0.166.0',
      rule_revision: 'forward-version-v1'
    });
    expect(sourceCompatibilityWindows).toHaveLength(5);
    expect(resolveOrdinaryWindow('codex', '0.166.0', 'claude-binding-root-window-v1')).toBeNull();
  });

  it('freezes parser, finality, identity, price and finite policy identity in a versioned selection', () => {
    const selected = resolveOrdinaryWindow('claude_code', '2.1.318');
    if (!selected) throw new Error('fixture_policy_missing');
    const selection = {
      schemaVersion: 2,
      mode: 'ordinary_window',
      taskId: 'task',
      projectId: 'project',
      declaredVersion: '2.1.318',
      policy: selected.policy,
      policyDigest: selected.policyDigest,
      priceTableId: 'price',
      preparedAt: '2026-11-06T00:00:00.000Z'
    };
    expect(OrdinaryWindowSelectionSchema.parse(selection).policy).toMatchObject({
      baseVersion: '2.1.306',
      upperExclusive: '2.2.0',
      algorithmId: 'claude_terminal_message_v1',
      finalityContractId: 'claude_terminal_message_window_v1',
      evidenceMode: 'publisher_verified_local_pin'
    });
    expect(
      OrdinaryWindowSelectionSchema.safeParse({
        ...selection,
        declaredVersion: '2.2.0'
      }).success
    ).toBe(false);
    expect(
      OrdinaryWindowSelectionSchema.safeParse({
        ...selection,
        policy: { ...selected.policy, maxMembers: 3 }
      }).success
    ).toBe(false);
    expect(
      OrdinaryWindowSelectionSchema.safeParse({
        ...selection,
        policyDigest: 'a'.repeat(64)
      }).success
    ).toBe(false);
    expect(ordinaryWindowPolicies.map(policy => ordinaryWindowDigest(policy))).toHaveLength(2);
  });

  it('represents unavailable Codex process proof without accepting it as Claude disk proof', () => {
    const proof = {
      schemaVersion: 2,
      mode: 'codex_source_only',
      product: 'codex',
      receipt: '00000000-0000-4000-8000-000000000001',
      recordedAt: '2026-11-06T00:00:00.000Z',
      nativeSessionId: 'native',
      sourceRef: '/synthetic/root.jsonl',
      sourceIdentity: 'source',
      cwd: '/synthetic/project',
      productVersion: '0.167.0',
      agentId: null,
      rootOwnership: 'unverified',
      possibleChildContribution: 'unknown',
      mappedImageProof: 'unverified',
      processId: null,
      processStart: null,
      nativePinDigest: null,
      sourceVersionBasis: 'root_creation_header',
      lifecycle: 'startup',
      writerVersion: 'unverified',
      publisherProof: 'unavailable'
    };
    expect(OrdinaryWindowConnectionProofSchema.parse(proof).processId).toBeNull();
    expect(
      OrdinaryWindowConnectionProofSchema.safeParse({
        ...proof,
        processId: 'invented'
      }).success
    ).toBe(false);
    expect(
      OrdinaryWindowConnectionProofSchema.safeParse({
        ...proof,
        mode: 'claude_publisher_local_pin',
        product: 'claude_code'
      }).success
    ).toBe(false);
  });
});
