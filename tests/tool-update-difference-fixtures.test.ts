import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import fsPromises from 'node:fs/promises';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { projectSyntheticReplay } from '../scripts/tool-update/difference-fixtures.mjs';
import { collectClaudeDocumentationEvidence } from '../scripts/tool-update/difference-source.mjs';
import { judgeDifferences } from '../scripts/tool-update/difference-judgment.mjs';
import { differenceEvidenceSchema, differenceJudgmentSchema, parseDifferenceJudgment } from '../scripts/tool-update/difference-records.mjs';
import { digest, loadRecord, publishRecord } from '../scripts/tool-update/manifest.mjs';
import { ClaudeSessionBindingProvider } from '../src/session-binding-claude.js';
import { claudeJob, documentationWire, privateMarker, syntheticRequest, syntheticRun } from './helpers/tool-update-claude-evidence-fixture.js';
import { currentIdentities } from './helpers/tool-update-difference-fixture.js';
import type { SyntheticReplay, SyntheticRequest } from '../scripts/tool-update/difference-fixtures.mjs';
import type { CandidateScope } from '../src/nested-candidate.js';

const databaseEffects = vi.hoisted(() => ({ opens: 0 }));
vi.mock('better-sqlite3', () => ({
  default: class {
    constructor() {
      databaseEffects.opens++;
      throw new Error('forbidden_database');
    }
  }
}));
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function temporary() {
  const root = await mkdtemp(join(fs.realpathSync(tmpdir()), 'difference-fixtures-'));
  roots.push(root);
  return root;
}
test('projection preserves provisional finality, terminal replay, exclusions and independent ownership totals', () => {
  const root = syntheticRequest(1),
    child = { ...syntheticRequest(2), owner: 'child_1' } as const;
  const excluded = { ...syntheticRequest(3), excluded: true };
  const run = {
    ...syntheticRun(),
    expected: [root, child, excluded],
    actual: [
      { ...root, terminal: false },
      root,
      root,
      child,
      excluded,
      {
        ...root,
        terminal: false
      }
    ]
  };
  const result = projectSyntheticReplay(claudeJob(), run);
  expect(result.matched).toBe(true);
  expect(result.actual).toMatchObject({
    terminal: 3,
    retained: 2,
    owners: [1, 1, 0],
    missing: 0,
    conflict: false,
    totals: {
      input: 270,
      output: 222,
      cached: 46,
      cache_write: 22,
      reasoning: null
    }
  });
  expect(result.evidence.every(record => record.method === 'synthetic_parser_provider_replay' && record.findings.every(row => row.result === 'unknown'))).toBe(
    true
  );
});
test.each([null, 0])('missing usage remains distinct from observed zero (%s)', value => {
  const row = {
    ...syntheticRequest(),
    counters: { ...syntheticRequest().counters, input: value }
  };
  const result = projectSyntheticReplay(claudeJob(), {
    ...syntheticRun(),
    scenario_id: 'missing_usage',
    expected: [row],
    actual: [row]
  });
  expect(result.actual.totals.input).toBe(value);
  expect(result.evidence[0]?.findings.find(row => row.field_id === 'input_tokens')?.actual).toEqual({ kind: 'number', value });
});
test.each(['counter', 'ownership', 'message', 'partial', 'exclusion'] as const)('%s mismatches are not promoted into vendor contradictions', change => {
  const expected = syntheticRequest();
  const changed: SyntheticRequest = {
    ...expected,
    ...(change === 'ownership' ? { owner: 'child_1' } : {}),
    ...(change === 'message' ? { message: 2 } : {}),
    ...(change === 'partial' ? { terminal: false } : {}),
    ...(change === 'exclusion' ? { excluded: true } : {}),
    counters: change === 'counter' ? { ...expected.counters, input: 999 } : expected.counters
  };
  const result = projectSyntheticReplay(claudeJob(), {
    ...syntheticRun(),
    actual: [changed]
  });
  expect(result.matched).toBe(false);
  expect(result.evidence.flatMap(record => record.findings).every(row => row.result === 'unknown' && row.reason === 'conflicting_evidence')).toBe(true);
});
test.each(['counter', 'owner', 'message'] as const)('terminal replay %s conflicts cannot hide behind matching totals', change => {
  const row = syntheticRequest();
  const duplicate: SyntheticRequest = {
    ...row,
    ...(change === 'owner' ? { owner: 'child_1' } : {}),
    ...(change === 'message' ? { message: 2 } : {}),
    counters: change === 'counter' ? { ...row.counters, output: 1000 } : row.counters
  };
  const result = projectSyntheticReplay(claudeJob(), {
    ...syntheticRun(),
    actual: [row, duplicate]
  });
  expect(result.actual.conflict).toBe(true);
  expect(result.matched).toBe(false);
});
test('a backend-counter counterexample stays pending despite identical passing client fixtures', () => {
  const job = claudeJob();
  const run = syntheticRun();
  const passing = projectSyntheticReplay(job, run);
  const counterexample = projectSyntheticReplay(job, {
    ...run,
    scenario_id: 'counter_change',
    expected: [
      {
        ...syntheticRequest(),
        counters: { ...syntheticRequest().counters, input: 112 }
      }
    ]
  });
  expect(passing.matched).toBe(true);
  expect(counterexample.actual).toEqual(passing.actual);
  expect(counterexample.matched).toBe(false);
  for (const result of [passing, counterexample]) {
    const group = judgeDifferences(job, result.evidence, currentIdentities).groups.find(
      group => group.contract_id === 'counters_cache_reasoning_reset_overflow'
    );
    expect(group?.result).toBe('unknown');
    expect(group?.facets.find(row => row.facet === 'backend_counter_meaning')).toMatchObject({
      result: 'unknown',
      methods: [],
      evidence_ids: [],
      reasons: ['backend_validation_pending']
    });
  }
});
test.each(['test_hash', 'harness_hash', 'input_hash'] as const)('fixture provenance %s changes evidence independently of engine identity', key => {
  const job = claudeJob(),
    run = syntheticRun();
  const before = projectSyntheticReplay(job, run).evidence[0];
  const after = projectSyntheticReplay(job, { ...run, [key]: '9'.repeat(64) }).evidence[0];
  expect(before?.engine_digest).toBe(after?.engine_digest);
  expect(digest(before)).not.toBe(digest(after));
});
test.each([{ prompt: privateMarker }, { response: privateMarker }, { path: privateMarker }, { source: privateMarker }, { approved: true }])(
  'content injection %j is rejected with fixed diagnostics',
  addition => {
    expect(() =>
      projectSyntheticReplay(claudeJob(), {
        ...syntheticRun(),
        ...addition
      })
    ).toThrow('invalid_record');
  }
);
test('counter overflow refuses a result instead of rounding usage', () => {
  const first = {
    ...syntheticRequest(),
    counters: {
      ...syntheticRequest().counters,
      input: Number.MAX_SAFE_INTEGER
    }
  };
  expect(() =>
    projectSyntheticReplay(claudeJob(), {
      ...syntheticRun(),
      expected: [first, syntheticRequest(2)]
    })
  ).toThrow('fixture_counter_invalid');
});
test('Claude documentation and fixture evidence publish a parsed judgment with native and backend facets pending', async () => {
  const wire = documentationWire();
  const docs = await collectClaudeDocumentationEvidence(wire.job, {
    fetch: wire.fetchImpl
  });
  const replay = projectSyntheticReplay(wire.job, syntheticRun());
  const evidence = [...docs.evidence, ...replay.evidence];
  const judgment = parseDifferenceJudgment(judgeDifferences(wire.job, evidence, currentIdentities));
  const root = await temporary();
  for (const record of evidence) {
    await publishRecord(root, record, differenceEvidenceSchema);
  }
  const id = await publishRecord(root, judgment, differenceJudgmentSchema);
  expect(await loadRecord(join(root, 'difference-judgments', `${id}.json`), differenceJudgmentSchema)).toEqual(judgment);
  expect(judgment.coverage_reasons).toEqual([]);
  expect(judgment.groups.every(group => group.result === 'unknown' && group.eligibility_recommendation === 'validation_pending')).toBe(true);
  expect(
    judgment.groups
      .flatMap(group => group.facets)
      .filter(row => ['native_execution', 'backend_counter_meaning'].includes(row.facet))
      .every(row => row.result === 'unknown' && row.methods.length === 0)
  ).toBe(true);
  expect(JSON.stringify(judgment)).not.toContain(privateMarker);
});
test('the effect ledger observes zero process, real source, DB, config and non-temporary write effects', async () => {
  const root = await temporary();
  const wire = documentationWire();
  const ledger = { processes: 0, reads: 0, writes: [] as string[] };
  const noProcess = () => {
    ledger.processes++;
    throw new Error('forbidden_process');
  };
  const noRead = () => {
    ledger.reads++;
    throw new Error('forbidden_read');
  };
  vi.spyOn(childProcess, 'spawn').mockImplementation(noProcess);
  vi.spyOn(childProcess, 'spawnSync').mockImplementation(noProcess);
  vi.spyOn(childProcess, 'execFile').mockImplementation(noProcess);
  vi.spyOn(childProcess, 'execFileSync').mockImplementation(noProcess);
  vi.spyOn(childProcess, 'exec').mockImplementation(noProcess);
  vi.spyOn(childProcess, 'execSync').mockImplementation(noProcess);
  vi.spyOn(childProcess, 'fork').mockImplementation(noProcess);
  vi.spyOn(fsPromises, 'readFile').mockImplementation(noRead);
  vi.spyOn(fs, 'readFileSync').mockImplementation(noRead);
  vi.spyOn(fsPromises, 'readdir').mockImplementation(noRead);
  vi.spyOn(fs, 'readdirSync').mockImplementation(noRead);
  vi.spyOn(fs, 'openSync').mockImplementation(noRead);
  const originalOpen = fsPromises.open;
  vi.spyOn(fsPromises, 'open').mockImplementation(async (path, ...args) => {
    const target = String(path),
      rel = relative(root, target);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error('non_temporary_write');
    }
    ledger.writes.push(target);
    return originalOpen(path, ...args);
  });
  syncBuiltinESMExports();
  const docs = await collectClaudeDocumentationEvidence(wire.job, {
    fetch: wire.fetchImpl
  });
  const replay = projectSyntheticReplay(wire.job, syntheticRun());
  expect(docs.failure).toBeNull();
  expect(replay.matched).toBe(true);
  const judgment = judgeDifferences(wire.job, [...docs.evidence, ...replay.evidence], currentIdentities);
  await publishRecord(root, judgment, differenceJudgmentSchema);
  expect(ledger.processes).toBe(0);
  expect(ledger.reads).toBe(0);
  expect(databaseEffects.opens).toBe(0);
  expect(ledger.writes).toHaveLength(2);
});
test('the real provider projects replay, copied children, incomplete flush and missing reasoning into synthetic evidence', async () => {
  const root = await temporary(),
    cwd = join(root, 'project'),
    projects = join(root, 'projects'),
    receipts = join(root, 'receipts');
  const session = randomUUID(),
    receipt = randomUUID();
  const directory = join(projects, cwd.replace(/[^A-Za-z0-9]/g, '-')),
    source = join(directory, `${session}.jsonl`);
  await mkdir(cwd);
  await mkdir(directory, { recursive: true });
  await mkdir(join(receipts, 'connect'), { recursive: true, mode: 0o700 });
  const row = (id: number, terminal = true, child = false) => ({
    type: 'assistant',
    sessionId: session,
    version: '2.1.306',
    timestamp: '2026-10-24T00:00:00.000Z',
    requestId: `req_conformance_${id}`,
    ...(child ? { agentId: 'synthetic-child', isSidechain: true } : {}),
    message: {
      id: `msg_conformance_${id}`,
      model: 'claude-sonnet-5-5',
      stop_reason: terminal ? 'end_turn' : null,
      usage: {
        input_tokens: 101,
        output_tokens: 111,
        cache_read_input_tokens: 23,
        cache_creation_input_tokens: 11,
        cache_creation: {
          ephemeral_5m_input_tokens: 7,
          ephemeral_1h_input_tokens: 4
        }
      }
    }
  });
  await writeFile(source, JSON.stringify(row(1)) + '\n', { mode: 0o600 });
  await writeFile(
    join(receipts, 'connect', `${receipt}.json`),
    JSON.stringify({
      schema_version: 1,
      kind: 'connect',
      receipt_id: receipt,
      session_id: session,
      agent_id: null,
      agent_type: null,
      transcript_path: source,
      agent_transcript_path: null,
      cwd,
      claude_pid: process.pid,
      recorded_at: new Date().toISOString(),
      uid: process.getuid?.() ?? null
    }),
    { mode: 0o600 }
  );
  const provider = new ClaudeSessionBindingProvider({
    receiptDir: receipts,
    claudeProjectsDir: projects,
    projectRoot: cwd,
    allowCandidateProfiles: true,
    productVersion: '2.1.306'
  });
  const identity = await provider.resolveCurrent({ receipt });
  const scope: CandidateScope = {
    projectId: 'synthetic',
    taskId: 'synthetic',
    allowedRootTurnIds: ['binding-observation'],
    sessions: [
      {
        sessionId: session,
        rootSessionId: session,
        parentSessionId: null,
        sourceId: session,
        product: 'claude_code',
        nativeSessionId: session,
        processId: identity.nativeMapping?.processId ?? null,
        agentId: null
      }
    ]
  };
  const baseline = new Set<string>(),
    options = {
      has: (id: string) => baseline.has(id),
      add: (id: string) => {
        baseline.add(id);
      }
    };
  await provider.readUsage(identity, null, scope, {
    baseline: true,
    baselineLedger: options
  });
  await writeFile(
    source,
    [row(1), row(2, false), row(2), row(2), row(3, true, true), row(4, false)].map(value => JSON.stringify(value) + '\n').join('') + '{"type":'
  );
  const batch = await provider.readUsage(identity, null, scope, {
    baseline: false,
    baselineLedger: options
  });
  const actual: SyntheticRequest[] = batch.records.map(record => ({
    request: Number(record.requestId.split('_').at(-1)),
    message: Number(record.requestId.split('_').at(-1)),
    owner: 'root',
    terminal: true,
    excluded: false,
    counters: {
      input: record.payload.input_total.value,
      output: record.payload.output_total.value,
      cached: record.payload.cached_input.value,
      cache_write: record.payload.billing_components.find(component => component.kind === 'cache_write')?.reading.value ?? null,
      reasoning: record.payload.reasoning_output.value
    }
  }));
  const run: SyntheticReplay = {
    ...syntheticRun(),
    scenario_id: 'interrupted',
    expected: [syntheticRequest(2)],
    actual,
    test_hash: digest(await readFile(new URL(import.meta.url))),
    harness_hash: digest(await readFile(new URL('../src/session-binding-claude.ts', import.meta.url))),
    input_hash: digest(await readFile(source))
  };
  const result = projectSyntheticReplay(claudeJob(), run);
  expect(result.matched).toBe(true);
  expect(result.actual.totals).toEqual({
    input: 135,
    output: 111,
    cached: 23,
    cache_write: 11,
    reasoning: null
  });
  expect(batch.gaps).toContain('binding_partial_usage');
  expect(result.evidence.every(record => record.material.kind === 'synthetic')).toBe(true);
});
