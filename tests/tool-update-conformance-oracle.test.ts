import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { historical, projectTranscript, reconcileCollector, reconcileOracle } from '../scripts/tool-update/claude-oracle.mjs';
import { ClaudeSessionBindingProvider } from '../src/session-binding-claude.js';
import { fixture, usage, row, lines, scenarioFixture } from './tool-update-conformance-fixture.js';
import type { CandidateScope } from '../src/nested-candidate.js';

describe('independent own-request oracle', () => {
  it.each(['normal', 'sigint'] as const)('reconciles the historical %s counts without claiming a native trial', scenario => {
    const { ledger, sources } = scenarioFixture(scenario);
    expect(reconcileOracle(scenario, ledger, sources)).toMatchObject(historical[scenario]);
  });
  it('preserves absent interrupted usage as missing rather than zero', () => {
    const { ledger, sources } = scenarioFixture('sigint');
    sources[0]?.delete('req_conformance_6');
    expect(reconcileOracle('sigint', ledger, sources).interrupted_usage).toEqual({ status: 'missing', value: null });
  });
  it('rejects an incomplete final native JSON line', () => {
    expect(() => projectTranscript('{"type":', randomUUID())).toThrow('source_invalid');
  });
  it('correlates provisional snapshots and deduplicates terminal replay', () => {
    const sid = randomUUID(), terminal = row(2, sid), provisional = row(2, sid, null, false);
    expect(projectTranscript(lines([provisional, terminal, terminal, provisional]), sid).size).toBe(1);
    expect(projectTranscript(lines([provisional, terminal]), sid).get('req_conformance_2')?.terminal).toBe(true);
  });
  it('rejects conflicting terminal counters', () => {
    const sid = randomUUID(), value = row(2, sid);
    const changed = { ...value, message: { ...value.message, usage: { ...usage, output_tokens: 112 } } };
    expect(() => projectTranscript(lines([value, changed]), sid)).toThrow('request_conflict');
  });
  it('rejects a terminal TTL split conflict even when the aggregate is unchanged', () => {
    const sid = randomUUID(), value = row(2, sid);
    const changed = { ...value, message: { ...value.message, usage: { ...usage,
      cache_creation: { ephemeral_5m_input_tokens: 6, ephemeral_1h_input_tokens: 5 } } } };
    expect(() => projectTranscript(lines([value, changed]), sid)).toThrow('request_conflict');
  });
  it('never treats absent counters as observed zero', () => {
    const sid = randomUUID(), value = row(2, sid);
    expect(() => projectTranscript(lines([{ ...value, message: { ...value.message, usage: {} } }]), sid)).toThrow('counter_invalid');
  });
  it('checks cache TTL subsets independently', () => {
    const sid = randomUUID(), value = row(2, sid);
    const changed = { ...value, message: { ...value.message, usage: { ...usage, cache_creation_input_tokens: 12 } } };
    expect(() => projectTranscript(lines([changed]), sid)).toThrow('counter_invalid');
  });
  it('excludes copied child rows from root own usage', () => {
    const sid = randomUUID();
    expect(projectTranscript(lines([row(2, sid), row(3, sid, 'a')]), sid).size).toBe(1);
  });
  it('rejects request reuse across source owners', () => {
    const { ledger, sources } = scenarioFixture('normal'), first = sources[0];
    const duplicate = first?.get('req_conformance_2');
    if (!duplicate || !sources[1]) throw new Error('synthetic_fixture_invalid');
    sources[1].set('req_conformance_2', duplicate);
    expect(() => reconcileOracle('normal', ledger, sources)).toThrow('ownership_invalid');
  });
  it('rejects zero collector records even when independent counters pass', () => {
    const { ledger, sources } = scenarioFixture('normal');
    expect(() => reconcileCollector(reconcileOracle('normal', ledger, sources), [], sources)).toThrow('collector_mismatch');
  });
});

describe('shipped collector on explicitly synthetic sources', () => {
  it('excludes baseline, holds incomplete flush and retains cache components as partial', async () => {
    const root = fixture(), cwd = join(root, 'project'), projects = join(root, 'projects'), receipts = join(root, 'receipts');
    const sid = randomUUID(), receipt = randomUUID();
    const dir = join(projects, cwd.replace(/[^A-Za-z0-9]/g, '-')), source = join(dir, `${sid}.jsonl`);
    mkdirSync(cwd); mkdirSync(dir, { recursive: true }); mkdirSync(join(receipts, 'connect'), { recursive: true, mode: 0o700 });
    writeFileSync(source, lines([row(1, sid)]), { mode: 0o600 });
    writeFileSync(join(receipts, 'connect', `${receipt}.json`), JSON.stringify({
      schema_version: 1, kind: 'connect', receipt_id: receipt, session_id: sid, agent_id: null, agent_type: null,
      transcript_path: source, agent_transcript_path: null, cwd, claude_pid: process.pid,
      recorded_at: new Date().toISOString(), uid: process.getuid?.() ?? null,
    }), { mode: 0o600 });
    // The real Node identity is checked. No Claude image proof is injected.
    const provider = new ClaudeSessionBindingProvider({ receiptDir: receipts, claudeProjectsDir: projects,
      projectRoot: cwd, allowCandidateProfiles: true, productVersion: '2.1.306' });
    const identity = await provider.resolveCurrent({ receipt });
    const scope: CandidateScope = { projectId: 'synthetic', taskId: 'synthetic', allowedRootTurnIds: ['binding-observation'],
      sessions: [{ sessionId: sid, rootSessionId: sid, parentSessionId: null, sourceId: sid, product: 'claude_code',
        nativeSessionId: sid, processId: identity.nativeMapping?.processId ?? null, agentId: null }] };
    const baseline = new Set<string>();
    await provider.readUsage(identity, null, scope, { baseline: true, baselineLedger: { has: id => baseline.has(id), add: id => { baseline.add(id); } } });
    const terminal = row(2, sid), partial = row(4, sid, null, false);
    writeFileSync(source, lines([row(1, sid), row(2, sid, null, false), terminal, terminal, row(3, sid, 'child'), partial]) + '{"type":',
      { mode: 0o600 });
    const batch = await provider.readUsage(identity, null, scope, { baseline: false,
      baselineLedger: { has: id => baseline.has(id), add: id => { baseline.add(id); } } });
    expect(batch.records.map(value => value.requestId)).toEqual(['req_conformance_2']);
    expect(batch.records[0]?.payload).toMatchObject({ input_total: { status: 'observed', value: 135 },
      output_total: { status: 'observed', value: 111 }, cached_input: { value: 23 },
      reasoning_output: { status: 'unmeasurable', value: null }, cache_write_1h_observed: true });
    expect(batch.gaps).toContain('binding_partial_usage');
    const projected = projectTranscript(lines([row(1, sid), terminal, partial]), sid, null, ['req_conformance_1']);
    expect(reconcileCollector({ served: 3, terminal: 2, baseline: 1, retained: [1], input: 135,
      output: 111, incomplete: 1, interrupted_usage: { status: 'missing', value: null } }, [batch], [projected]))
      .toEqual({ records: 1, input: 135, output: 111, partial_usage: true, complete_cost: false });
  });
});
