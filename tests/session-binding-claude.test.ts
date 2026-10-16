import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { CandidateScope } from '../src/nested-candidate.js';
import type { BindingBaselineLedger, BindingUsageRecord, VerifiedSessionIdentity } from '../src/session-binding-contract.js';
import { ClaudeSessionBindingProvider, claudeBindingProfiles, claudeProjectDirName, type ClaudeBindingOptions } from '../src/session-binding-claude.js';
import { EventV2Schema, RuntimeEvidenceSchema } from '../src/flexible-contracts.js';
import { compilePriceBasis, parsePriceCatalog } from '../src/price-catalog.js';
import { projectCatalogCost } from '../src/catalog-cost-report.js';

// Synthetic fixtures only: no native Claude process, model call, user transcript or settings.
const hook = resolve(import.meta.dirname, '../scripts/claude-session-hook.mjs');
const privateText = 'SYNTHETIC-PRIVATE-CONTENT';
const connectCommand = 'node "/skills/harness-connect/scripts/connect.mjs" connect --origin http://127.0.0.1:4100 --product claude_code --task-name demo';
const quiet = () => Date.now() + 60000; // transcripts look finished unless a test says otherwise
let root: string; let receipts: string; let projects: string; let projectDir: string; let cwd: string; let otherProjectDir: string;
const baselineDatabases = new Set<Database.Database>();

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'hd-claude-binding-')));
  receipts = join(root, 'state', 'claude-receipts');
  projects = join(root, 'claude', 'projects'); cwd = join(root, 'repo');
  projectDir = join(projects, claudeProjectDirName(cwd)); otherProjectDir = join(projects, claudeProjectDirName(join(root, 'other')));
  mkdirSync(projectDir, { recursive: true }); mkdirSync(otherProjectDir); mkdirSync(join(cwd, 'sub'), { recursive: true }); mkdirSync(join(root, 'other'));
});
afterEach(() => {
  for (const database of baselineDatabases) if (database.open) database.close();
  baselineDatabases.clear();
  rmSync(root, { recursive: true, force: true });
});

const provider = (extra: Partial<ClaudeBindingOptions> = {}) => new ClaudeSessionBindingProvider({ receiptDir: receipts, claudeProjectsDir: projects,
  projectRoot: cwd, allowCandidateProfiles: true, now: quiet, ...extra });
const rootPath = (sid: string, dir = projectDir) => join(dir, `${sid}.jsonl`);
const childPath = (sid: string, agent: string) => join(projectDir, sid, 'subagents', `agent-${agent}.jsonl`);
function runHook(input: Record<string, unknown>, claudePid = process.pid) {
  const result = spawnSync(process.execPath, [hook, 'record', '--dir', receipts], { input: JSON.stringify(input),
    env: { ...process.env, CLAUDE_PID: String(claudePid) }, encoding: 'utf8' });
  expect(result.status).toBe(0); expect(result.stdout).toBe('');
}
function locate(sessionId: string) {
  const result = spawnSync(process.execPath, [hook, 'locate', '--dir', receipts], { env: { ...process.env, CLAUDE_CODE_SESSION_ID: sessionId }, encoding: 'utf8' });
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as { receipt: string | null; reason?: string; role?: string };
}
const common = (sid: string, event: string, at = cwd) => ({ session_id: sid, transcript_path: rootPath(sid), cwd: at, hook_event_name: event, permission_mode: 'default' });
function connect(sid: string, extra: Record<string, unknown> = {}, claudePid = process.pid) {
  runHook({ ...common(sid, 'PreToolUse'), tool_name: 'Bash', tool_use_id: 'toolu_' + randomUUID().replaceAll('-', ''),
    tool_input: { command: connectCommand, description: privateText }, ...extra }, claudePid);
}
function subagent(sid: string, agent: string, event: 'SubagentStart' | 'SubagentStop', transcript = childPath(sid, agent)) {
  runHook({ ...common(sid, event), agent_id: agent, agent_type: 'general-purpose',
    ...(event === 'SubagentStop' ? { agent_transcript_path: transcript, last_assistant_message: privateText, stop_hook_active: false } : {}) });
}
const userRow = (sid: string, at: string, extra: Record<string, unknown> = {}) => ({ type: 'user', sessionId: sid, version: '2.1.291', cwd, timestamp: at, ...extra,
  message: { role: 'user', content: privateText } });
function assistant(sid: string, request: string, tokens: [number, number, number, number], extra: Record<string, unknown> = {}, model = 'claude-opus-5-5') {
  const [input, write, read, output] = tokens;
  return { type: 'assistant', sessionId: sid, version: '2.1.291', timestamp: '2026-10-07T01:00:00.000Z', requestId: request, ...extra,
    message: { id: 'msg_' + request, model, stop_reason: 'end_turn', content: [{ type: 'text', text: privateText }],
      usage: { input_tokens: input, cache_creation_input_tokens: write, cache_read_input_tokens: read, output_tokens: output } } };
}
const lines = (rows: unknown[]) => rows.map(row => JSON.stringify(row) + '\n').join('');
function writeRoot(sid: string, rows: unknown[] = [], dir = projectDir) {
  writeFileSync(rootPath(sid, dir), lines([userRow(sid, '2026-10-07T00:59:00.000Z'), ...rows]), { mode: 0o600 });
}
function writeChild(sid: string, agent: string, rows: unknown[]) {
  mkdirSync(join(projectDir, sid, 'subagents'), { recursive: true }); writeFileSync(childPath(sid, agent), lines(rows), { mode: 0o600 });
}
const childRow = (sid: string, agent: string, at: string) => userRow(sid, at, { agentId: agent, isSidechain: true });
/** Mirrors the integration coordinator's scopeFor(), which reads nativeMapping. */
const scopeFor = (identities: VerifiedSessionIdentity[]): CandidateScope => ({ projectId: 'project-1', taskId: 'task-1', allowedRootTurnIds: ['binding-observation'],
  sessions: identities.map(value => ({ sessionId: value.sessionId, rootSessionId: value.nativeMapping?.nativeSessionId ?? value.sessionId,
    parentSessionId: value.parentSessionId, sourceId: value.sessionId, product: value.product,
    nativeSessionId: value.nativeMapping?.nativeSessionId ?? value.sessionId, processId: value.nativeMapping?.processId ?? null, agentId: value.nativeMapping?.agentId ?? null })) });
const ids = (records: BindingUsageRecord[]) => records.map(r => r.requestId);
async function currentIdentity(sid: string, p = provider()) {
  const located = locate(sid); expect(located.receipt).toMatch(/^[a-f0-9-]{36}$/);
  return p.resolveCurrent({ receipt: located.receipt! });
}
function forgedReceipt(sid: string, transcript: string, claudePid: number) {
  const receipt = randomUUID();
  mkdirSync(join(receipts, 'connect'), { recursive: true, mode: 0o700 });
  writeFileSync(join(receipts, 'connect', `${receipt}.json`), JSON.stringify({ schema_version: 1, kind: 'connect', receipt_id: receipt, session_id: sid,
    agent_id: null, agent_type: null, transcript_path: transcript, agent_transcript_path: null, cwd, claude_pid: claudePid,
    recorded_at: new Date().toISOString(), uid: process.getuid?.() ?? null }), { mode: 0o600 });
  return receipt;
}

describe('Claude current-session identity', () => {
  it('binds the session that the hook observed and stores no content', async () => {
    const sid = randomUUID(); writeRoot(sid); connect(sid);
    const identity = await currentIdentity(sid);
    expect(identity).toEqual({ product: 'claude_code', productVersion: '2.1.291', sessionId: sid, sourceRef: rootPath(sid),
      sourceIdentity: expect.stringMatching(/^[a-f0-9]{64}$/) as string, cwd, identityEvidenceId: expect.stringMatching(/^claude-session:/) as string,
      parentSessionId: null, createdAt: '2026-10-07T00:59:00.000Z', nativeMapping: { nativeSessionId: sid, processId: expect.stringMatching(/^claude-process:[1-9][0-9]*:[a-f0-9]{64}$/) as string, agentId: null } });
    const stored = readdirSync(join(receipts, 'connect')).map(name => readFileSync(join(receipts, 'connect', name), 'utf8')).join('');
    expect(stored).not.toContain(privateText); expect(stored).not.toContain('--task-name');
  });

  it('returns a byte-identical identity for repeated skill calls, cwd changes and hook copies', async () => {
    const sid = randomUUID(); writeRoot(sid); const p = provider();
    const toolUse = { tool_use_id: 'toolu_same' };
    connect(sid, toolUse); connect(sid, toolUse);
    expect(readdirSync(join(receipts, 'connect'))).toHaveLength(1);
    const first = await currentIdentity(sid, p);
    rmSync(join(receipts, 'connect'), { recursive: true });
    connect(sid, { cwd: join(cwd, 'sub') });
    expect(JSON.stringify(await currentIdentity(sid, p))).toBe(JSON.stringify(first));
  });

  it('does not accept environment, other-process or ambiguous evidence in the locator', () => {
    const sid = randomUUID(); const other = randomUUID(); writeRoot(sid); writeRoot(other);
    connect(sid);
    // A Bash command can set CLAUDE_CODE_SESSION_ID; it only narrows lookup.
    expect(locate(other)).toEqual({ receipt: null, reason: 'hook_receipt_missing' });
    connect(other, {}, 999999);
    expect(locate(other)).toEqual({ receipt: null, reason: 'hook_receipt_missing' });
    expect(locate('not-a-session')).toEqual({ receipt: null, reason: 'current_identity_unavailable' });
    symlinkSync(join(root, 'missing'), join(receipts, 'connect', `${randomUUID()}.json`));
    expect(locate(sid).receipt).not.toBeNull();
    writeChild(sid, 'a1', [childRow(sid, 'a1', '2026-10-07T01:00:00.000Z')]);
    connect(sid, { agent_id: 'a1', agent_type: 'general-purpose' });
    expect(locate(sid)).toEqual({ receipt: null, reason: 'hook_receipt_ambiguous' });
  });

  it('records only the connect command and subagent metadata, and nothing after deletion', async () => {
    const sid = randomUUID();
    runHook({ ...common(sid, 'PreToolUse'), tool_name: 'Bash', tool_use_id: 'toolu_1', tool_input: { command: 'npm test' } });
    runHook({ ...common(sid, 'UserPromptSubmit'), prompt: privateText });
    expect(() => readdirSync(join(receipts, 'connect'))).toThrow();
    subagent(sid, 'a1', 'SubagentStop');
    const stop = readFileSync(join(receipts, 'sessions', sid, 'agents', 'a1.subagent_stop.json'), 'utf8');
    expect(stop).not.toContain(privateText); expect(JSON.parse(stop)).not.toHaveProperty('last_assistant_message');
    await provider().forgetSession(sid);
    subagent(sid, 'a2', 'SubagentStart'); connect(sid);
    expect(() => readdirSync(join(receipts, 'sessions', sid))).toThrow();
    expect(() => readdirSync(join(receipts, 'connect'))).toThrow();
  });

  it('fails closed for unqualified, unknown, expired, loose, dead-process and other-project evidence', async () => {
    const sid = randomUUID(); writeRoot(sid); connect(sid); const receipt = locate(sid).receipt!;
    expect(claudeBindingProfiles.map(profile => [profile.version, profile.status])).toEqual([['2.1.301', 'qualified'], ['2.1.296', 'qualified'], ['2.1.294', 'candidate'], ['2.1.293', 'candidate'], ['2.1.291', 'candidate']]);
    const production = provider({ allowCandidateProfiles: false });
    expect(production.capabilities().productionSupported).toBe(false);
    await expect(production.resolveCurrent({ receipt })).rejects.toThrow('claude_source_version_unsupported');
    await expect(provider({ profiles: [{ version: '9.9.9', status: 'qualified', evidence: 'x' }] }).resolveCurrent({ receipt })).rejects.toThrow('claude_source_version_unsupported');
    chmodSync(join(receipts, 'connect', `${receipt}.json`), 0o644);
    await expect(provider().resolveCurrent({ receipt })).rejects.toThrow('claude_receipt_untrusted');
    chmodSync(join(receipts, 'connect', `${receipt}.json`), 0o600);
    // An expired receipt cannot open a new connection, but remains for bound revalidation.
    await expect(provider({ now: () => Date.now() + 3600000 }).resolveCurrent({ receipt })).rejects.toThrow('claude_receipt_expired');
    expect(readdirSync(join(receipts, 'connect'))).toContain(`${receipt}.json`);
    // Forged receipts: an exited process is refused.
    const exited = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
    await expect(provider().resolveCurrent({ receipt: forgedReceipt(sid, rootPath(sid), Number(exited.stdout)) })).rejects.toThrow('claude_process_absent');
    // Another project's session is refused from paths alone; its unreadable transcript is never opened.
    const foreign = randomUUID(); writeRoot(foreign, [], otherProjectDir); chmodSync(rootPath(foreign, otherProjectDir), 0o000);
    await expect(provider().resolveCurrent({ receipt: forgedReceipt(foreign, rootPath(foreign, otherProjectDir), process.pid) })).rejects.toThrow('claude_project_mismatch');
    // Documented local-trust limit: a same-user forgery naming a live session of this project is not detectable.
    const sibling = randomUUID(); writeRoot(sibling);
    expect((await provider().resolveCurrent({ receipt: forgedReceipt(sibling, rootPath(sibling), process.pid) })).sessionId).toBe(sibling);
  });
});

describe('Claude durable baseline exclusions', () => {
  function openLedger(sourceIdentity: string) {
    const database = new Database(join(root, 'baseline.sqlite'));
    baselineDatabases.add(database);
    database.exec('CREATE TABLE IF NOT EXISTS exclusions (source TEXT NOT NULL, request TEXT NOT NULL, PRIMARY KEY (source, request))');
    const lookup = database.prepare('SELECT 1 FROM exclusions WHERE source = ? AND request = ?');
    const insert = database.prepare('INSERT OR IGNORE INTO exclusions (source, request) VALUES (?, ?)');
    const batches: number[] = [];
    const insertMany = database.transaction((requestIds: readonly string[]) => {
      for (const requestId of requestIds) insert.run(sourceIdentity, requestId);
    });
    const ledger: BindingBaselineLedger = {
      has: requestId => lookup.get(sourceIdentity, requestId) !== undefined,
      add: requestId => { insert.run(sourceIdentity, requestId); },
      addMany: requestIds => { batches.push(requestIds.length); insertMany(requestIds); },
    };
    return { database, ledger, batches };
  }

  it('excludes large history and in-flight IDs after live rollover and a durable restart', async () => {
    const sid = randomUUID();
    const pending = assistant(sid, 'pending', [1, 0, 0, 1]);
    writeRoot(sid, [
      ...Array.from({ length: 1500 }, (_, i) => assistant(sid, `prior_${i}`, [1, 0, 0, 1])),
      assistant(sid, 'foreign_agent', [1, 0, 0, 1], { agentId: 'child', isSidechain: true }),
      { ...pending, message: { ...pending.message, usage: undefined } },
      assistant(sid, 'in_flight', [1, 0, 0, 1]),
    ]);
    connect(sid); const p = provider(); const parent = await currentIdentity(sid, p); const scope = scopeFor([parent]);
    const initial = openLedger(parent.sourceIdentity);
    const writingAt = statSync(rootPath(sid)).mtimeMs;
    const baseline = await provider({ now: () => writingAt }).readUsage(parent, null, scope, { baseline: true, baselineLedger: initial.ledger });
    expect(baseline).toMatchObject({ records: [], gaps: [] });
    expect(JSON.parse(Buffer.from(baseline.cursor, 'base64url').toString('utf8'))).toMatchObject({ v: 3, baselineExcluded: [] });
    expect(initial.ledger.has('prior_0')).toBe(true);
    expect(initial.ledger.has('prior_1499')).toBe(true);
    expect(initial.ledger.has('pending')).toBe(true);
    expect(initial.ledger.has('in_flight')).toBe(true);
    expect(initial.ledger.has('foreign_agent')).toBe(false);
    appendFileSync(rootPath(sid), lines(Array.from({ length: 1025 }, (_, i) => assistant(sid, `live_${i}`, [1, 0, 0, 1]))));
    const live = await p.readUsage(parent, baseline.cursor, scope, { baseline: false, baselineLedger: initial.ledger });
    expect(live.records).toHaveLength(1025);
    expect(initial.ledger.has('live_0')).toBe(false);
    initial.database.close();
    const reopened = openLedger(parent.sourceIdentity);
    appendFileSync(rootPath(sid), lines([
      assistant(sid, 'prior_0', [9, 0, 0, 9]), assistant(sid, 'prior_1499', [9, 0, 0, 9]),
      assistant(sid, 'pending', [2, 0, 0, 3]), assistant(sid, 'fresh', [2, 0, 0, 2]),
      assistant(sid, 'in_flight', [3, 0, 0, 3]),
    ]));
    const replay = await provider().readUsage(parent, live.cursor, scope, { baseline: false, baselineLedger: reopened.ledger });
    expect(ids(replay.records)).toEqual(['fresh']);
    expect(replay.gaps).toEqual([]);
  });

  it('excludes every historical ID across bounded baseline read windows', async () => {
    const sid = randomUUID();
    const historySize = 10240;
    writeRoot(sid, Array.from({ length: historySize }, (_, i) => assistant(sid, `prior_${i}`, [1, 0, 0, 1])));
    connect(sid); const p = provider({ maxReadBytes: 65536 }); const parent = await currentIdentity(sid, p);
    const { ledger, batches } = openLedger(parent.sourceIdentity);
    const baseline = await p.readUsage(parent, null, scopeFor([parent]), { baseline: true, baselineLedger: ledger });
    expect(baseline.records).toEqual([]);
    expect(Array.from({ length: historySize }, (_, i) => ledger.has(`prior_${i}`)).every(Boolean)).toBe(true);
    const nonemptyBatches = batches.filter(size => size > 0);
    expect(nonemptyBatches.reduce((total, size) => total + size, 0)).toBe(historySize);
    expect(nonemptyBatches.length).toBeGreaterThan(1);
    expect(nonemptyBatches.length).toBeLessThan(100);
    appendFileSync(rootPath(sid), lines([assistant(sid, 'prior_0', [2, 0, 0, 2]), assistant(sid, 'new', [1, 0, 0, 1])]));
    expect(ids((await p.readUsage(parent, baseline.cursor, scopeFor([parent]), { baseline: false, baselineLedger: ledger })).records)).toEqual(['new']);
  });

  it('migrates legacy cursor exclusions into the ledger without losing replay protection', async () => {
    const sid = randomUUID(); writeRoot(sid, [assistant(sid, 'prior', [1, 0, 0, 1])]); connect(sid);
    const p = provider(); const parent = await currentIdentity(sid, p); const scope = scopeFor([parent]);
    const legacy = await p.readUsage(parent, null, scope, { baseline: true });
    const { ledger } = openLedger(parent.sourceIdentity);
    appendFileSync(rootPath(sid), lines([assistant(sid, 'prior', [2, 0, 0, 2]), assistant(sid, 'new', [1, 0, 0, 1])]));
    const migrated = await p.readUsage(parent, legacy.cursor, scope, { baseline: false, baselineLedger: ledger });
    expect(ids(migrated.records)).toEqual(['new']);
    expect(ledger.has('prior')).toBe(true);
    expect(JSON.parse(Buffer.from(migrated.cursor, 'base64url').toString('utf8'))).toMatchObject({ v: 3, baselineExcluded: [] });
  });

  it('refuses a partial durable baseline and excludes its completed tail on retry', async () => {
    const sid = randomUUID(); writeRoot(sid, [assistant(sid, 'prior', [1, 0, 0, 1])]); connect(sid);
    const p = provider(); const parent = await currentIdentity(sid, p); const scope = scopeFor([parent]);
    const { ledger } = openLedger(parent.sourceIdentity);
    const tail = JSON.stringify(assistant(sid, 'tail', [1, 0, 0, 1]));
    appendFileSync(rootPath(sid), tail.slice(0, 40));
    await expect(p.readUsage(parent, null, scope, { baseline: true, baselineLedger: ledger })).rejects.toThrow('claude_baseline_incomplete');
    appendFileSync(rootPath(sid), tail.slice(40) + '\n');
    const baseline = await p.readUsage(parent, null, scope, { baseline: true, baselineLedger: ledger });
    appendFileSync(rootPath(sid), lines([assistant(sid, 'tail', [2, 0, 0, 2])]));
    expect((await provider().readUsage(parent, baseline.cursor, scope, { baseline: false, baselineLedger: ledger })).records).toEqual([]);
    expect(ledger.has('tail')).toBe(true);
  });

  it('reports live compaction as a gap with the durable ledger', async () => {
    const sid = randomUUID(); writeRoot(sid); connect(sid);
    const p = provider(); const parent = await currentIdentity(sid, p); const scope = scopeFor([parent]);
    const { ledger } = openLedger(parent.sourceIdentity);
    const baseline = await p.readUsage(parent, null, scope, { baseline: true, baselineLedger: ledger });
    appendFileSync(rootPath(sid), lines([{ type: 'system', subtype: 'compact_boundary', sessionId: sid }, assistant(sid, 'new', [1, 0, 0, 1])]));
    const live = await p.readUsage(parent, baseline.cursor, scope, { baseline: false, baselineLedger: ledger });
    expect(ids(live.records)).toEqual(['new']);
    expect(live.gaps).toEqual(['binding_usage_incomplete']);
  });

  it('never invokes the ledger when source authorization or process ownership fails', async () => {
    const sid = randomUUID(); writeRoot(sid, [assistant(sid, 'prior', [1, 0, 0, 1])]); connect(sid);
    const p = provider(); const parent = await currentIdentity(sid, p);
    const baseline = await p.readUsage(parent, null, scopeFor([parent]), { baseline: true });
    const ledger: BindingBaselineLedger = { has: vi.fn(() => false), add: vi.fn() };
    const denied = provider({ authorizeSource: () => { throw new Error('scope_denied_before_read'); } });
    await expect(denied.readUsage(parent, baseline.cursor, scopeFor([parent]), { baseline: false, baselineLedger: ledger })).rejects.toThrow('scope_denied_before_read');
    const changed = provider({ readProcessIdentity: () => 'synthetic-reused-start' });
    await expect(changed.readUsage(parent, null, scopeFor([parent]), { baseline: true, baselineLedger: ledger })).rejects.toThrow('claude_bound_identity_changed');
    await expect(p.readUsage(parent, null, scopeFor([]), { baseline: true, baselineLedger: ledger })).rejects.toThrow('claude_scope_mismatch');
    expect(ledger.has).not.toHaveBeenCalled(); expect(ledger.add).not.toHaveBeenCalled();
  });
});

describe('Claude family relations', () => {
  it('links hook-evidenced subagents once they have rows and reports unevidenced member files', async () => {
    const sid = randomUUID(); const other = randomUUID(); writeRoot(sid); writeRoot(other); connect(sid); const p = provider();
    const parent = await currentIdentity(sid, p);
    writeChild(sid, 'a1', [childRow(sid, 'a1', '2026-10-07T01:05:00.000Z')]); writeChild(sid, 'a2', []); writeChild(sid, 'zz', []); writeChild(sid, 'a3', []); writeChild(sid, 'a4', []); writeChild(sid, 'a5', []);
    subagent(sid, 'a1', 'SubagentStart'); subagent(sid, 'a1', 'SubagentStart'); subagent(sid, 'a1', 'SubagentStop');
    subagent(sid, 'a2', 'SubagentStop', join(root, 'elsewhere.jsonl'));
    subagent(other, 'a3', 'SubagentStart');
    // Same session ID but another root transcript is not relation evidence for this parent.
    runHook({ ...common(sid, 'SubagentStart'), transcript_path: rootPath(other), agent_id: 'a4', agent_type: 'general-purpose' });
    subagent(sid, 'a5', 'SubagentStart');
    const found = await p.discoverChildren(parent);
    expect(found.children.map(c => [c.parentSessionId, c.identity.sessionId, c.identity.parentSessionId, c.identity.createdAt, c.relationEvidenceId === c.identity.identityEvidenceId]))
      .toEqual([[sid, `${sid}:a1`, sid, '2026-10-07T01:05:00.000Z', true]]);
    // Empty Start sources now remain explicit unresolved-family gaps.
    expect(found.gaps).toEqual(['binding_ancestry_unverified', 'source_unavailable']);
    expect(found.children[0]!.identity.nativeMapping).toEqual({ nativeSessionId: sid, processId: null, agentId: 'a1' });
    // a5 has no rows yet; it is linked later with its first own-row time, and a1 stays byte-identical.
    appendFileSync(childPath(sid, 'a5'), lines([childRow(sid, 'a5', '2026-10-07T00:30:00.000Z')]));
    const later = await p.discoverChildren(parent);
    expect(later.children.map(c => [c.identity.sessionId, c.identity.createdAt])).toEqual([[`${sid}:a1`, '2026-10-07T01:05:00.000Z'], [`${sid}:a5`, '2026-10-07T00:30:00.000Z']]);
    expect(JSON.stringify(later.children[0])).toBe(JSON.stringify(found.children[0]));
    expect(await p.discoverChildren(later.children[0]!.identity)).toEqual({ children: [], gaps: [] });
  });

  it('reports a member whose own rows cannot be attributed instead of dropping it', async () => {
    const sid = randomUUID(); writeRoot(sid); connect(sid); const p = provider(); const parent = await currentIdentity(sid, p);
    // Rows without the agent marker (undocumented field absent) are not attributable to a1.
    writeChild(sid, 'a1', [userRow(sid, '2026-10-07T01:00:00.000Z'), assistant(sid, 'req_x', [1, 0, 0, 1])]);
    // A first own row behind more than one metadata window is still found.
    writeChild(sid, 'a2', [{ type: 'user', sessionId: sid, agentId: 'a2', pad: 'x'.repeat(1100000) }, childRow(sid, 'a2', '2026-10-07T01:00:00.000Z')]);
    subagent(sid, 'a1', 'SubagentStart'); subagent(sid, 'a2', 'SubagentStart');
    const found = await p.discoverChildren(parent);
    expect(found.children.map(c => c.identity.sessionId)).toEqual([`${sid}:a2`]);
    expect(found.gaps).toEqual(['binding_ancestry_unverified']);
    // A partial source remains a gap; only a fresh Start can enter the coordinator barrier.
    const next = randomUUID(); writeRoot(next); rmSync(join(receipts, 'connect'), { recursive: true }); connect(next);
    const nextParent = await currentIdentity(next, p);
    mkdirSync(join(projectDir, next, 'subagents'), { recursive: true }); writeFileSync(childPath(next, 'a3'), '{"type":"user","sessionId"', { mode: 0o600 });
    subagent(next, 'a3', 'SubagentStart');
    expect(await p.discoverChildren(nextParent)).toEqual({ children: [], gaps: ['source_unavailable'] });
  });

  it('resolves a skill call inside a subagent to the same identity discovery links', async () => {
    const sid = randomUUID(); writeRoot(sid); writeChild(sid, 'a1', [childRow(sid, 'a1', '2026-10-07T01:00:00.000Z')]);
    connect(sid); const p = provider(); const parent = await currentIdentity(sid, p);
    subagent(sid, 'a1', 'SubagentStart');
    const discovered = (await p.discoverChildren(parent)).children[0]!.identity;
    rmSync(join(receipts, 'connect'), { recursive: true });
    // The hook's transcript_path inside a subagent is undocumented; both forms resolve the member.
    connect(sid, { agent_id: 'a1', agent_type: 'general-purpose', transcript_path: childPath(sid, 'a1') });
    expect(locate(sid).role).toBe('child');
    expect(JSON.stringify(await currentIdentity(sid, p))).toBe(JSON.stringify(discovered));
  });

  it('forgets a deleted session so receipts cannot re-link it', async () => {
    const sid = randomUUID(); const kept = randomUUID(); writeRoot(sid); writeRoot(kept); writeChild(sid, 'a1', [childRow(sid, 'a1', '2026-10-07T01:00:00.000Z')]);
    connect(sid); connect(kept); const p = provider(); const parent = await currentIdentity(sid, p); const receipt = locate(sid).receipt!;
    subagent(sid, 'a1', 'SubagentStart');
    await p.forgetSession(sid);
    expect(await p.discoverChildren(parent)).toEqual({ children: [], gaps: [] });
    await expect(p.resolveCurrent({ receipt })).rejects.toThrow('claude_receipt_missing');
    expect((await currentIdentity(kept, p)).sessionId).toBe(kept);
  });
});

describe('Claude usage collection', () => {
  it.each([
    [undefined, 'missing'], [{ ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 0 }, 'observed'],
    [{ ephemeral_5m_input_tokens: 20 }, 'missing'], [{ ephemeral_5m_input_tokens: -1, ephemeral_1h_input_tokens: 21 }, 'error'],
    [{ ephemeral_5m_input_tokens: 10.5, ephemeral_1h_input_tokens: 9.5 }, 'error'],
    [{ ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 11 }, 'error'],
    [{ ephemeral_5m_input_tokens: Number.MAX_SAFE_INTEGER, ephemeral_1h_input_tokens: 1 }, 'error'],
    [null, 'error'],
  ] as const)('preserves TTL state without discarding aggregate usage (%j)', async (creation, status) => {
    const sid = randomUUID(); const row = assistant(sid, 'req_ttl_state', [10, 20, 30, 5]);
    const extended = { ...row, message: { ...row.message, usage: { ...row.message.usage,
      ...(creation === undefined ? {} : { cache_creation: creation }) } } };
    writeRoot(sid, [extended]); connect(sid); const p = provider(); const parent = await currentIdentity(sid, p);
    const batch = await p.readUsage(parent, null, scopeFor([parent]), { baseline: false });
    expect(batch.records[0]?.payload.cache_write_ttl).toMatchObject({ status, source: 'product_usage_cache_creation' });
    expect(batch.records[0]?.payload.input_total).toEqual({ status: 'observed', value: 60, reason: null });
    expect(JSON.stringify(batch)).not.toContain(privateText);
  });

  it('rejects conflicting numeric TTL splits with identical totals and one-hour flag', async () => {
    const sid = randomUUID(); const row = assistant(sid, 'req_split_conflict', [10, 20, 30, 5]);
    const split = (hour: number) => ({ ...row, message: { ...row.message, usage: { ...row.message.usage,
      cache_creation: { ephemeral_5m_input_tokens: 20 - hour, ephemeral_1h_input_tokens: hour } } } });
    writeRoot(sid, [split(10), split(11)]); connect(sid); const p = provider(); const parent = await currentIdentity(sid, p);
    const batch = await p.readUsage(parent, null, scopeFor([parent]), { baseline: false });
    expect(batch.records).toEqual([]); expect(batch.gaps).toContain('incomplete_request');
  });

  it.each([
    ['claude-haiku-5-5', 20, '0.0000038'], ['claude-haiku-5-5', 10, '0.0000038'],
    ['claude-sonnet-5-5', 20, '0.000073'], ['claude-sonnet-5-5', 10, '0.000073'],
  ] as const)('does not price known one-hour writes as five-minute writes (%s, %i)', async (model, oneHour, amount) => {
    const sid = randomUUID(); const row = assistant(sid, 'req_1h', [10, 20, 30, 5], {}, model);
    const extended = { ...row, message: { ...row.message, usage: { ...row.message.usage,
      cache_creation: { ephemeral_1h_input_tokens: oneHour, ephemeral_5m_input_tokens: 20 - oneHour } } } };
    writeRoot(sid, [extended]); connect(sid); const p = provider(); const parent = await currentIdentity(sid, p);
    const batch = await p.readUsage(parent, null, scopeFor([parent]), { baseline: false });
    expect(batch.gaps).toContain('binding_partial_usage');
    const record = batch.records[0]!;
    expect(record.payload.billing_components.find(component => component.kind === 'cache_write')?.reading)
      .toEqual({ status: 'observed', value: 20, reason: null });
    expect(record.payload.cache_write_1h_observed).toBe(true);
    expect(record.payload.cache_write_ttl).toEqual({ status: 'observed', source: 'product_usage_cache_creation',
      five_minute_tokens: 20 - oneHour, one_hour_tokens: oneHour });
    expect(record.payload.input_total).toEqual({ status: 'observed', value: 60, reason: null });
    const runtime = RuntimeEvidenceSchema.parse({ id: 'runtime-1h', task_id: 'task-1', session_id: sid, request_id: record.requestId,
      turn_id: null, model, effort: null, product: 'claude_code', product_version: '2.1.291', source: 'product_log',
      boundary: 'request', occurred_at: record.occurredAt, recorded_at: record.occurredAt });
    const event = EventV2Schema.parse({ id: 'event-1h', source_key: 'event-1h', task_id: 'task-1', project_id: 'project-1', session_id: sid,
      occurred_at: record.occurredAt, payload: { ...record.payload, runtime_evidence_id: runtime.id } });
    const catalog = parsePriceCatalog(JSON.parse(readFileSync(new URL('../config/prices/catalogs/reference-catalog-2026-10-08.json', import.meta.url), 'utf8')) as unknown);
    const report = projectCatalogCost([event], compilePriceBasis(catalog), 'task-1', '2026-10-08T00:00:00Z', 'output-only-v1',
      { referenceBinding: true, runtimeEvidence: [runtime] });
    expect(report).toMatchObject({ partial_amount: null, legacy_unverified_partial_amount: amount, complete_amount: null });
    expect(report.price_reasons).toEqual(['unverified_condition']);
    expect(report.matches.find(match => match.component === 'cache_write')).toMatchObject({ status: 'unavailable', price_per_unit: null });
    expect(JSON.stringify(batch)).not.toContain(privateText);
  });

  it('rejects request rows that disagree about one-hour writes even with identical token totals', async () => {
    const sid = randomUUID(); const row = assistant(sid, 'req_ttl_conflict', [10, 20, 30, 5]);
    const oneHour = { ...row, message: { ...row.message, usage: { ...row.message.usage, cache_creation: { ephemeral_1h_input_tokens: 20 } } } };
    writeRoot(sid, [row, oneHour]); connect(sid); const p = provider(); const parent = await currentIdentity(sid, p);
    const batch = await p.readUsage(parent, null, scopeFor([parent]), { baseline: false });
    expect(batch.records).toEqual([]); expect(batch.gaps).toContain('incomplete_request');
  });

  it('counts each request once across the family and excludes copies, conflicts and non-requests', async () => {
    const sid = randomUUID(); const foreign = randomUUID();
    writeRoot(sid, [
      assistant(sid, 'req_root1', [10, 20, 30, 5]), assistant(sid, 'req_root1', [10, 20, 30, 5], { timestamp: '2026-10-07T01:00:05.000Z' }),
      assistant(sid, 'req_child1', [1, 0, 0, 1], { isSidechain: true, agentId: 'a1' }),
      assistant(sid, 'req_err', [0, 0, 0, 0], {}, '<synthetic>'),
      assistant(sid, 'req_conflict', [1, 0, 0, 1]), assistant(sid, 'req_conflict', [1, 0, 0, 2]),
      assistant(foreign, 'req_foreign', [9, 9, 9, 9]),
      assistant(sid, 'req_newer', [1, 1, 1, 1], { version: '2.1.292' }),
      { ...assistant(sid, 'x', [1, 1, 1, 1]), requestId: undefined },
      userRow(sid, '2026-10-07T01:01:00.000Z'),
    ]);
    writeChild(sid, 'a1', [childRow(sid, 'a1', '2026-10-07T00:59:30.000Z'), assistant(sid, 'req_child1', [1, 2, 3, 4], { isSidechain: true, agentId: 'a1' }),
      assistant(sid, 'req_grandchild', [7, 7, 7, 7], { isSidechain: true, agentId: 'a9' })]);
    connect(sid); subagent(sid, 'a1', 'SubagentStart'); const p = provider();
    const parent = await currentIdentity(sid, p); const child = (await p.discoverChildren(parent)).children[0]!.identity;
    const scope = scopeFor([parent, child]);
    const rootBatch = await p.readUsage(parent, null, scope, { baseline: false }); const childBatch = await p.readUsage(child, null, scope, { baseline: false });
    expect(rootBatch.records).toHaveLength(1);
    expect(rootBatch.records[0]).toMatchObject({ requestId: 'req_root1', sessionId: sid, occurredAt: '2026-10-07T01:00:00.000Z', payload: {
      input_total: { value: 60 }, cached_input: { value: 30 }, output_total: { value: 5 }, reasoning_output: { status: 'unmeasurable' },
      model: 'claude-opus-5-5', product_version: '2.1.291', billing_components: [{ kind: 'ordinary_input', reading: { value: 10 } },
        { kind: 'cache_read', reading: { value: 30 } }, { kind: 'cache_write', reading: { value: 20 } }, { kind: 'output', reading: { value: 5 } }] } });
    expect(rootBatch.gaps).toEqual(['binding_usage_incomplete', 'incomplete_request', 'missing_usage', 'unsupported_history']);
    expect(childBatch.records.map(r => [r.requestId, r.sessionId])).toEqual([['req_child1', `${sid}:a1`]]);
    const family = [...rootBatch.records, ...childBatch.records];
    expect(new Set(ids(family)).size).toBe(family.length);
    expect(JSON.stringify([rootBatch, childBatch])).not.toContain(privateText);
  });

  it('emits a request written across polls once, with its first-row time', async () => {
    const sid = randomUUID(); writeRoot(sid, [assistant(sid, 'req_s', [1, 0, 0, 3])]); connect(sid);
    const parent = await currentIdentity(sid); const scope = scopeFor([parent]);
    const writing = provider({ now: Date.now });
    const first = await writing.readUsage(parent, null, scope, { baseline: false });
    expect(first.records).toEqual([]);
    appendFileSync(rootPath(sid), lines([assistant(sid, 'req_s', [1, 0, 0, 3], { timestamp: '2026-10-07T01:00:02.000Z' }), userRow(sid, '2026-10-07T01:00:03.000Z')]));
    const second = await writing.readUsage(parent, first.cursor, scope);
    expect(second.records.map(r => [r.requestId, r.occurredAt])).toEqual([['req_s', '2026-10-07T01:00:00.000Z']]);
    appendFileSync(rootPath(sid), lines([assistant(sid, 'req_s', [1, 0, 0, 3]), userRow(sid, '2026-10-07T01:00:04.000Z')]));
    const replay = await writing.readUsage(parent, second.cursor, scope);
    expect(replay).toMatchObject({ records: [], gaps: [] });
    appendFileSync(rootPath(sid), lines([assistant(sid, 'req_s', [1, 0, 0, 9]), userRow(sid, '2026-10-07T01:00:05.000Z')]));
    await expect(writing.readUsage(parent, replay.cursor, scope)).rejects.toThrow('binding_request_conflict');
  });

  it('excludes pre-observation usage at a baseline, including a response still being written', async () => {
    const sid = randomUUID();
    writeRoot(sid, [assistant(sid, 'req_old', [5, 0, 0, 5]), { type: 'system', subtype: 'compact_boundary', sessionId: sid }, assistant(sid, 'req_live', [1, 0, 0, 1])]);
    connect(sid); const parent = await currentIdentity(sid); const scope = scopeFor([parent]);
    const writing = provider({ now: Date.now });
    const baseline = await writing.readUsage(parent, null, scope, { baseline: true });
    expect(baseline).toMatchObject({ records: [], gaps: [] });
    appendFileSync(rootPath(sid), lines([assistant(sid, 'req_live', [1, 0, 0, 1]), userRow(sid, '2026-10-07T01:02:00.000Z'), assistant(sid, 'req_new', [2, 0, 0, 2]), userRow(sid, '2026-10-07T01:03:00.000Z')]));
    expect(ids((await writing.readUsage(parent, baseline.cursor, scope)).records)).toEqual(['req_new']);
  });

  it('retains incomplete baseline request IDs after the observed replay window rolls', async () => {
    const sid = randomUUID();
    const pending = assistant(sid, 'req_pending', [1, 0, 0, 1]);
    writeRoot(sid, [{...pending, message: {...pending.message, usage: undefined}}]); connect(sid);
    const p = provider(); const parent = await currentIdentity(sid, p); const scope = scopeFor([parent]);
    const baseline = await p.readUsage(parent, null, scope, { baseline: true });
    appendFileSync(rootPath(sid), lines(Array.from({length: 1025}, (_, i) => assistant(sid, `new_${i}`, [1, 0, 0, 1]))));
    const observed = await p.readUsage(parent, baseline.cursor, scope);
    expect(observed.records).toHaveLength(1025);
    appendFileSync(rootPath(sid), lines([assistant(sid, 'req_pending', [2, 0, 0, 3]), userRow(sid, '2026-10-07T01:10:00.000Z')]));
    expect((await p.readUsage(parent, observed.cursor, scope)).records).toEqual([]);
  });

  it('fails closed instead of forgetting an over-capacity or partial baseline', async () => {
    const sid = randomUUID();
    writeRoot(sid, Array.from({length: 1025}, (_, i) => assistant(sid, `prior_${i}`, [1, 0, 0, 1])));
    connect(sid); const p = provider(); const parent = await currentIdentity(sid, p); const scope = scopeFor([parent]);
    await expect(p.readUsage(parent, null, scope, { baseline: true })).rejects.toThrow('claude_baseline_limit');
    writeRoot(sid); const refreshed = await currentIdentity(sid, p);
    appendFileSync(rootPath(sid), '{"type":"assistant"');
    await expect(p.readUsage(refreshed, null, scopeFor([refreshed]), { baseline: true })).rejects.toThrow('claude_baseline_incomplete');
    rmSync(rootPath(sid));
    await expect(p.readUsage(refreshed, null, scopeFor([refreshed]), { baseline: true })).rejects.toThrow('claude_baseline_incomplete');
  });

  it('includes a fresh child from its first request, without a discovery-time filter', async () => {
    const sid = randomUUID(); writeRoot(sid); connect(sid); const p = provider(); const parent = await currentIdentity(sid, p);
    writeChild(sid, 'a1', [childRow(sid, 'a1', '2026-10-07T01:00:00.000Z'), assistant(sid, 'req_c1', [1, 0, 0, 1], { agentId: 'a1', isSidechain: true }),
      assistant(sid, 'req_c2', [2, 0, 0, 2], { agentId: 'a1', isSidechain: true, timestamp: '2026-10-07T01:00:30.000Z' }), childRow(sid, 'a1', '2026-10-07T01:00:40.000Z')]);
    subagent(sid, 'a1', 'SubagentStart');
    const child = (await p.discoverChildren(parent)).children[0]!.identity; const scope = scopeFor([parent, child]);
    expect(ids((await p.readUsage(child, null, scope, { baseline: false })).records)).toEqual(['req_c1', 'req_c2']);
    expect((await p.readUsage(child, null, scope, { baseline: true })).records).toEqual([]);
  });

  it('reads a null-cursor snapshot to the end even beyond one read window', async () => {
    const sid = randomUUID();
    writeRoot(sid, Array.from({ length: 40 }, (_, i) => [assistant(sid, `req_${i}`, [1, 0, 0, 1]), userRow(sid, '2026-10-07T01:00:00.000Z')]).flat());
    connect(sid); const p = provider({ maxReadBytes: 4096 }); const parent = await currentIdentity(sid, p); const scope = scopeFor([parent]);
    const snapshot = await p.readUsage(parent, null, scope, { baseline: false });
    expect(snapshot.records).toHaveLength(40);
    expect((await p.readUsage(parent, snapshot.cursor, scope)).records).toEqual([]);
  });

  it('continues from a cursor across collector restart and refuses replaced or unscoped sources', async () => {
    const sid = randomUUID(); writeRoot(sid, [assistant(sid, 'req_1', [1, 0, 0, 1])]); connect(sid);
    const parent = await currentIdentity(sid); const scope = scopeFor([parent]);
    const first = await provider().readUsage(parent, null, scope, { baseline: false });
    appendFileSync(rootPath(sid), lines([assistant(sid, 'req_2', [2, 0, 0, 2])]) + '{"type":"assistant","partial');
    const restarted = provider();
    const second = await restarted.readUsage(parent, first.cursor, scope);
    expect([first, second].map(batch => ids(batch.records))).toEqual([['req_1'], ['req_2']]);
    expect((await restarted.readUsage(parent, second.cursor, scope)).records).toEqual([]);
    truncateSync(rootPath(sid), 10);
    expect((await restarted.readUsage(parent, second.cursor, scope)).gaps).toEqual(['source_changed']);
    rmSync(rootPath(sid)); writeRoot(sid, [assistant(sid, 'req_3', [3, 0, 0, 3])]);
    expect(await restarted.readUsage(parent, second.cursor, scope)).toMatchObject({ records: [], gaps: ['source_changed'] });
    const other = randomUUID(); writeRoot(other); connect(other);
    rmSync(join(receipts, 'connect'), { recursive: true }); connect(other);
    const otherIdentity = await currentIdentity(other);
    await expect(restarted.readUsage(otherIdentity, null, scope)).rejects.toThrow('claude_scope_mismatch');
  });

  it('keeps a new parent session separate so the common layer can bind it to the same task', async () => {
    const first = randomUUID(); const next = randomUUID();
    writeRoot(first, [assistant(first, 'req_a', [1, 0, 0, 1])]); writeRoot(next, [assistant(next, 'req_b', [2, 0, 0, 2])]);
    connect(first); const a = await currentIdentity(first);
    rmSync(join(receipts, 'connect'), { recursive: true }); connect(next); const b = await currentIdentity(next);
    expect(a.sessionId).not.toBe(b.sessionId); expect(a.sourceIdentity).not.toBe(b.sourceIdentity);
    const scope = scopeFor([a, b]);
    expect(ids((await provider().readUsage(a, null, scope, { baseline: false })).records)).toEqual(['req_a']);
    expect(ids((await provider().readUsage(b, null, scope, { baseline: false })).records)).toEqual(['req_b']);
  });
});


describe('Claude agent display metadata', () => {
  it('retains configured root names and native child types without deriving names from transcript text', async () => {
    const sid = randomUUID(); writeRoot(sid); connect(sid, { agent_type: 'security-reviewer', agent_name: privateText });
    const p = provider(); const rootIdentity = await currentIdentity(sid, p);
    expect(rootIdentity).toMatchObject({ agentMetadata: { source: 'claude_hook', agentType: 'security-reviewer' } });
    writeChild(sid, 'kid', [childRow(sid, 'kid', '2026-10-07T01:00:00.000Z')]);
    runHook({ ...common(sid, 'SubagentStart'), agent_id: 'kid', agent_type: 'my-plugin:reviewer', last_assistant_message: privateText });
    const children = await p.discoverChildren(rootIdentity);
    expect(children.children[0]?.identity).toMatchObject({ agentMetadata: { source: 'claude_hook', agentType: 'my-plugin:reviewer' } });
    expect(JSON.stringify(children)).not.toContain(privateText);
  });
});


describe('Claude bound-session authorization', () => {
  it('revalidates an existing live root after receipt and transcript freshness expire', async () => {
    const sid = randomUUID(); writeRoot(sid); connect(sid);
    const receipt = locate(sid).receipt!; const p = provider();
    const identity = await p.resolveCurrent({ receipt });
    const late = provider({ now: () => Date.now() + 7200000 });
    expect(await late.revalidateBound({ receipt }, identity)).toEqual(identity);
    await expect(late.resolveCurrent({ receipt })).rejects.toThrow('claude_receipt_expired');
    expect(await late.revalidateBound({ receipt }, identity)).toEqual(identity);
  });

  it('rejects a different root or replaced source before authorizing transcript access', async () => {
    const sid = randomUUID(); writeRoot(sid); connect(sid);
    const receipt = locate(sid).receipt!; const identity = await provider().resolveCurrent({ receipt });
    const authorizeSource = vi.fn(); const guarded = provider({ authorizeSource });
    const other = randomUUID(); writeRoot(other);
    await expect(guarded.revalidateBound({ receipt: forgedReceipt(other, rootPath(other), process.pid) }, identity)).rejects.toThrow('claude_bound_identity_changed');
    rmSync(rootPath(sid)); writeRoot(sid);
    await expect(guarded.revalidateBound({ receipt }, identity)).rejects.toThrow('claude_bound_identity_changed');
    expect(authorizeSource).not.toHaveBeenCalled();
  });

  it('authorizes exact metadata before identity, discovery and usage content reads', async () => {
    const sid = randomUUID(); writeRoot(sid); connect(sid);
    const receipt = locate(sid).receipt!;
    const identity = await provider().resolveCurrent({ receipt });
    const authorizeSource = vi.fn(() => { throw new Error('scope_denied_before_read'); });
    const guarded = provider({ authorizeSource });
    // Invalid content would fail identity parsing if content were accessed first.
    writeFileSync(rootPath(sid), 'invalid synthetic row\n');
    await expect(guarded.resolveCurrent({ receipt })).rejects.toThrow('scope_denied_before_read');
    expect(authorizeSource).toHaveBeenLastCalledWith({ nativeSessionId: sid, agentId: null, sourceRef: rootPath(sid),
      sourceIdentity: identity.sourceIdentity, birthtimeMs: expect.any(Number) as number });
    await expect(guarded.readUsage(identity, null, scopeFor([identity]))).rejects.toThrow('scope_denied_before_read');
    writeChild(sid, 'denied', []); subagent(sid, 'denied', 'SubagentStart');
    await expect(guarded.discoverChildren(identity)).rejects.toThrow('scope_denied_before_read');
    expect(authorizeSource).toHaveBeenLastCalledWith(expect.objectContaining({ nativeSessionId: sid, agentId: 'denied', sourceRef: childPath(sid, 'denied') }));
  });

  it('keeps the qualified 2.1.296 transcript profile behind explicit pilot authority', async () => {
    const sid = randomUUID(); writeRoot(sid);
    writeFileSync(rootPath(sid), lines([userRow(sid, '2026-10-07T00:59:00.000Z', { version: '2.1.296' })]));
    connect(sid); const receipt = locate(sid).receipt!;
    const production = provider({ allowCandidateProfiles: false });
    await expect(production.resolveCurrent({ receipt })).rejects.toThrow('claude_source_version_unsupported');
    expect((await provider().resolveCurrent({ receipt })).productVersion).toBe('2.1.296');
    expect(production.capabilities()).toMatchObject({ productionSupported: false });
    expect(production.capabilities().reasons).not.toContain('claude_transcript_profile_unqualified');
    const candidatesOnly = provider({ allowCandidateProfiles: false, profiles: claudeBindingProfiles.filter(profile => profile.status === 'candidate') });
    expect(candidatesOnly.capabilities().reasons).toContain('claude_transcript_profile_unqualified');
    await expect(candidatesOnly.resolveCurrent({ receipt })).rejects.toThrow('claude_source_version_unsupported');
  });

  it.each(['2.1.293', '2.1.294'])('keeps Claude %s a code-owned synthetic candidate', async version => {
    const sid = randomUUID(); writeRoot(sid);
    writeFileSync(rootPath(sid), lines([userRow(sid, '2026-10-07T00:59:00.000Z', { version })]));
    connect(sid); const receipt = locate(sid).receipt!;
    expect((await provider().resolveCurrent({ receipt })).productVersion).toBe(version);
    await expect(provider({ allowCandidateProfiles: false }).resolveCurrent({ receipt })).rejects.toThrow('claude_source_version_unsupported');
    expect(claudeBindingProfiles.find(profile => profile.version === version)?.status).toBe('candidate');
  });

  it('collects 2.1.296 own usage once and excludes the prior baseline', async () => {
    const sid = randomUUID(); const version = '2.1.296';
    writeFileSync(rootPath(sid), lines([
      userRow(sid, '2026-10-07T00:59:00.000Z', { version }),
      assistant(sid, 'old', [10, 2, 3, 4], { version }),
    ]), { mode: 0o600 });
    connect(sid);
    const p = provider(); const identity = await currentIdentity(sid, p); const scope = scopeFor([identity]);
    const baseline = await p.readUsage(identity, null, scope, { baseline: true });
    appendFileSync(rootPath(sid), lines([
      assistant(sid, 'new', [20, 4, 6, 8], { version }),
      userRow(sid, '2026-10-07T01:01:00.000Z', { version }),
    ]));
    const batch = await p.readUsage(identity, baseline.cursor, scope);
    expect(ids(batch.records)).toEqual(['new']);
    expect(batch.records[0]?.payload).toMatchObject({ product_version: version, input_total: { value: 30 }, output_total: { value: 8 } });
    expect((await p.readUsage(identity, batch.cursor, scope)).records).toEqual([]);
    expect(JSON.stringify(batch)).not.toContain(privateText);
  });

  it('keeps 2.1.296 family requests separate under the three-member ceiling', async () => {
    const sid = randomUUID(); const version = '2.1.296';
    writeFileSync(rootPath(sid), lines([userRow(sid, '2026-10-07T00:59:00.000Z', { version })]), { mode: 0o600 });
    connect(sid); const p = provider({ maxFamilyMembers: 3 }); const parent = await currentIdentity(sid, p);
    for (const agent of ['one', 'two']) {
      writeChild(sid, agent, [
        childRow(sid, agent, '2026-10-07T01:00:00.000Z'),
        assistant(sid, agent, [10, 2, 3, 4], { version, agentId: agent, isSidechain: true }),
        userRow(sid, '2026-10-07T01:01:00.000Z', { version, agentId: agent, isSidechain: true }),
      ].map(row => ({ ...row, version })));
      subagent(sid, agent, 'SubagentStart');
    }
    const discovered = await p.discoverChildren(parent);
    const children = discovered.children.map(child => child.identity); const scope = scopeFor([parent, ...children]);
    expect(children.map(child => child.productVersion)).toEqual([version, version]);
    const batches = await Promise.all(children.map(child => p.readUsage(child, null, scope, { baseline: false })));
    expect(batches.flatMap(batch => ids(batch.records)).sort()).toEqual(['one', 'two']);
    writeChild(sid, 'extra', []); subagent(sid, 'extra', 'SubagentStart');
    await expect(p.discoverChildren(parent)).rejects.toThrow('claude_family_scope_limit');
  });

  it('waits for correlated terminal child counters even after a quiet nonassistant boundary', async () => {
    const sid = randomUUID(); const version = '2.1.296'; const agent = 'finality';
    writeFileSync(rootPath(sid), lines([userRow(sid, '2026-10-07T00:59:00.000Z', { version })]), { mode: 0o600 });
    connect(sid); const p = provider({ quiescenceMs: 0 }); const parent = await currentIdentity(sid, p);
    const row = assistant(sid, 'native_pending', [104, 15, 27, 16], { version, agentId: agent, isSidechain: true });
    const provisional = { ...row, message: { ...row.message, stop_reason: null } };
    writeChild(sid, agent, [
      { ...childRow(sid, agent, '2026-10-07T00:59:30.000Z'), version },
      provisional, userRow(sid, '2026-10-07T01:00:01.000Z', { version, agentId: agent, isSidechain: true }),
    ]);
    subagent(sid, agent, 'SubagentStart');
    const child = (await p.discoverChildren(parent)).children[0]?.identity;
    expect(child).toBeDefined(); if (!child) throw new Error('synthetic_child_missing');
    const scope = scopeFor([parent, child]);
    const pending = await p.readUsage(child, null, scope, { baseline: false });
    expect(pending.records).toEqual([]);
    const terminal = { ...row, timestamp: '2026-10-07T01:00:02.000Z',
      message: { ...row.message, stop_reason: 'tool_use', usage: { ...row.message.usage, output_tokens: 111 } } };
    appendFileSync(childPath(sid, agent), lines([terminal]));
    const complete = await p.readUsage(child, pending.cursor, scope);
    expect(complete.records).toHaveLength(1);
    expect(complete.records[0]).toMatchObject({ requestId: 'native_pending', occurredAt: row.timestamp,
      payload: { input_total: { value: 146 }, cached_input: { value: 27 }, output_total: { value: 111 } } });
    appendFileSync(childPath(sid, agent), lines([provisional, terminal]));
    const replay = await provider({ quiescenceMs: 0 }).readUsage(child, complete.cursor, scope);
    expect(replay.records).toEqual([]);
    appendFileSync(childPath(sid, agent), lines([{ ...terminal,
      message: { ...terminal.message, usage: { ...terminal.message.usage, output_tokens: 112 } } }]));
    await expect(p.readUsage(child, replay.cursor, scope)).rejects.toThrow('binding_request_conflict');
    expect(JSON.stringify(complete)).not.toContain(privateText);
  });

  it('retains pending terminality across read windows and provider restart', async () => {
    const sid = randomUUID(); const version = '2.1.296';
    writeFileSync(rootPath(sid), lines([userRow(sid, '2026-10-07T00:59:00.000Z', { version })]), { mode: 0o600 });
    connect(sid); const p = provider({ quiescenceMs: 0, maxReadBytes: 4096 });
    const identity = await currentIdentity(sid, p); const scope = scopeFor([identity]);
    const baseline = await p.readUsage(identity, null, scope, { baseline: true });
    const row = assistant(sid, 'window_pending', [1, 0, 0, 16], { version });
    appendFileSync(rootPath(sid), lines([
      { ...row, message: { ...row.message, stop_reason: null } },
      ...Array.from({ length: 24 }, () => userRow(sid, '2026-10-07T01:00:01.000Z', { version })),
    ]));
    const pending = await p.readUsage(identity, baseline.cursor, scope);
    expect(pending.records).toEqual([]);
    appendFileSync(rootPath(sid), lines([{ ...row, timestamp: '2026-10-07T01:00:02.000Z',
      message: { ...row.message, usage: { ...row.message.usage, output_tokens: 111 } } }]));
    const resumed = await provider({ quiescenceMs: 0, maxReadBytes: 4096 }).readUsage(identity, pending.cursor, scope);
    expect(resumed.records).toHaveLength(1);
    expect(resumed.records[0]).toMatchObject({ occurredAt: row.timestamp, payload: { output_total: { value: 111 } } });
    expect(resumed.gaps).toEqual([]);
  });

  it('permanently excludes a native provisional request observed at baseline', async () => {
    const sid = randomUUID(); const version = '2.1.296';
    const row = assistant(sid, 'baseline_pending', [1, 0, 0, 16], { version });
    writeFileSync(rootPath(sid), lines([
      userRow(sid, '2026-10-07T00:59:00.000Z', { version }),
      { ...row, message: { ...row.message, stop_reason: null } },
    ]), { mode: 0o600 });
    connect(sid); const p = provider({ quiescenceMs: 0 }); const identity = await currentIdentity(sid, p);
    const scope = scopeFor([identity]); const baseline = await p.readUsage(identity, null, scope, { baseline: true });
    appendFileSync(rootPath(sid), lines([
      { ...row, message: { ...row.message, usage: { ...row.message.usage, output_tokens: 111 } } },
      assistant(sid, 'fresh_terminal', [2, 0, 0, 7], { version }),
    ]));
    expect(ids((await p.readUsage(identity, baseline.cursor, scope)).records)).toEqual(['fresh_terminal']);
  });

  it.each(['message_id', 'final_counters'])('excludes contradictory native %s evidence before commitment', async conflict => {
    const sid = randomUUID(); const version = '2.1.296';
    const row = assistant(sid, 'contradictory', [1, 0, 0, 111], { version });
    const second = { ...row, message: { ...row.message,
      id: conflict === 'message_id' ? 'msg_other' : row.message.id,
      usage: { ...row.message.usage, output_tokens: conflict === 'final_counters' ? 112 : 111 } } };
    const initial = conflict === 'message_id' ? { ...row, message: { ...row.message, stop_reason: null } } : row;
    writeFileSync(rootPath(sid), lines([userRow(sid, '2026-10-07T00:59:00.000Z', { version }), initial, second]), { mode: 0o600 });
    connect(sid); const p = provider({ quiescenceMs: 0 }); const identity = await currentIdentity(sid, p);
    const batch = await p.readUsage(identity, null, scopeFor([identity]), { baseline: false });
    expect(batch.records).toEqual([]);
    expect(batch.gaps).toContain('incomplete_request');
  });

  it.each([4096, 65536])('rejects contradictory message IDs across %s-byte snapshot windows without dropping a neighbor', async maxReadBytes => {
    const sid = randomUUID(); const version = '2.1.296';
    const row = assistant(sid, 'window_conflict', [1, 0, 0, 111], { version });
    writeFileSync(rootPath(sid), lines([
      userRow(sid, '2026-10-07T00:59:00.000Z', { version }), row,
      ...Array.from({ length: 40 }, () => userRow(sid, '2026-10-07T01:00:01.000Z', { version })),
      { ...row, message: { ...row.message, id: 'msg_other' } },
      assistant(sid, 'valid_neighbor', [2, 0, 0, 7], { version }),
    ]), { mode: 0o600 });
    connect(sid); const p = provider({ quiescenceMs: 0, maxReadBytes }); const identity = await currentIdentity(sid, p);
    const batch = await p.readUsage(identity, null, scopeFor([identity]), { baseline: false });
    expect(ids(batch.records)).toEqual(['valid_neighbor']);
    expect(batch.gaps).toContain('incomplete_request');
  });

  it('bounds oversized-line probing within the pending native forward scan', async () => {
    const sid = randomUUID(); const version = '2.1.296';
    const row = assistant(sid, 'oversized_pending', [1, 0, 0, 16], { version });
    writeFileSync(rootPath(sid), lines([
      userRow(sid, '2026-10-07T00:59:00.000Z', { version }),
      { ...row, message: { ...row.message, stop_reason: null } },
      { ...userRow(sid, '2026-10-07T01:00:01.000Z', { version }),
        message: { role: 'user', content: 'S'.repeat(20 * 1024 * 1024) } },
      { ...row, message: { ...row.message, usage: { ...row.message.usage, output_tokens: 111 } } },
    ]), { mode: 0o600 });
    connect(sid); const authorizeSource = vi.fn();
    const p = provider({ quiescenceMs: 0, maxReadBytes: 1024 * 1024, authorizeSource,
      readProcessIdentity: () => 'synthetic-process' });
    const identity = await currentIdentity(sid, p); authorizeSource.mockClear();
    const batch = await p.readUsage(identity, null, scopeFor([identity]), { baseline: false });
    expect(batch.records).toEqual([]);
    expect(batch.gaps).toContain('missing_usage');
    expect(authorizeSource.mock.calls.length).toBeLessThanOrEqual(260);
    expect(JSON.parse(Buffer.from(batch.cursor, 'base64url').toString())).toMatchObject({ offset: Buffer.byteLength(lines([
      userRow(sid, '2026-10-07T00:59:00.000Z', { version }),
    ])) });
  });

  it('keeps packaged hook root and Unicode agent-type projection synchronized', () => {
    const packagedHook = resolve(import.meta.dirname, '../skills/harness-connect/scripts/claude-session-hook.mjs');
    expect(readFileSync(packagedHook, 'utf8')).toBe(readFileSync(hook, 'utf8'));
    const sid = randomUUID();
    const result = spawnSync(process.execPath, [packagedHook, 'record', '--dir', receipts], {
      input: JSON.stringify({ ...common(sid, 'PreToolUse'), tool_name: 'Bash', tool_use_id: 'toolu_unicode',
        tool_input: { command: connectCommand }, agent_type: '검토자' }), env: { ...process.env, CLAUDE_PID: String(process.pid) }, encoding: 'utf8' });
    expect(result.status).toBe(0);
    const receipt = locate(sid).receipt!;
    expect(JSON.parse(readFileSync(join(receipts, 'connect', `${receipt}.json`), 'utf8'))).toMatchObject({ agent_id: null, agent_type: '검토자' });
  });
});


describe('Claude family metadata preflight', () => {
  it('refuses an excess family before reading any child transcript', async () => {
    const sid = randomUUID(); writeRoot(sid); connect(sid);
    const parent = await currentIdentity(sid);
    for (const agent of ['a', 'b', 'c']) { writeChild(sid, agent, []); subagent(sid, agent, 'SubagentStart'); }
    const authorizeSource = vi.fn();
    await expect(provider({ maxFamilyMembers: 3, authorizeSource }).discoverChildren(parent)).rejects.toThrow('claude_family_scope_limit');
    expect(authorizeSource).not.toHaveBeenCalled();
  });

  it('checks configured project authority without accessing receipts', () => {
    const p = provider();
    expect(() => p.assertProjectRoot(cwd)).not.toThrow();
    expect(() => p.assertProjectRoot(join(root, 'other'))).toThrow('binding_pilot_scope_invalid');
  });
});


describe('Claude bound-session failure boundaries', () => {
  it('omits the new-connection transcript-mtime guard only for a persisted root', async () => {
    const sid = randomUUID(); writeRoot(sid); connect(sid); const receipt = locate(sid).receipt!;
    const older = new Date(Date.now() - 1200000); utimesSync(rootPath(sid), older, older);
    const identity = await provider({ receiptMaxAgeMs: 1800000 }).resolveCurrent({ receipt });
    await expect(provider().resolveCurrent({ receipt })).rejects.toThrow('claude_source_stale');
    expect(await provider().revalidateBound({ receipt }, identity)).toEqual(identity);
  });

  it.each(['pid', 'uid', 'null_uid', 'cwd', 'child', 'receipt_id', 'loose_receipt', 'unreadable_source', 'missing_receipt', 'missing_source', 'deleted', 'legacy_pid'] as const)(
    'rejects %s before transcript authorization', async defect => {
      const sid = randomUUID(); writeRoot(sid); connect(sid); const receipt = locate(sid).receipt!;
      let identity = await provider().resolveCurrent({ receipt });
      const path = join(receipts, 'connect', `${receipt}.json`);
      const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      if (defect === 'pid') value.claude_pid = process.ppid;
      if (defect === 'uid') value.uid = (process.getuid?.() ?? 0) + 1;
      if (defect === 'null_uid') value.uid = null;
      if (defect === 'cwd') value.cwd = join(root, 'other');
      if (defect === 'child') value.agent_id = 'child';
      if (defect === 'receipt_id') value.receipt_id = randomUUID();
      writeFileSync(path, JSON.stringify(value));
      if (defect === 'loose_receipt') chmodSync(path, 0o644);
      if (defect === 'unreadable_source') chmodSync(rootPath(sid), 0o000);
      if (defect === 'missing_receipt') rmSync(path);
      if (defect === 'missing_source') rmSync(rootPath(sid));
      if (defect === 'deleted') {
        mkdirSync(join(receipts, 'forgotten'), { recursive: true, mode: 0o700 });
        writeFileSync(join(receipts, 'forgotten', sid), '', { mode: 0o600 });
      }
      if (defect === 'legacy_pid') identity = { ...identity, nativeMapping: { ...identity.nativeMapping!, processId: null } };
      const authorizeSource = vi.fn();
      await expect(provider({ authorizeSource }).revalidateBound({ receipt }, identity)).rejects.toThrow();
      expect(authorizeSource).not.toHaveBeenCalled();
    });

  it('rejects an exited bound process before authorization', async () => {
    const sid = randomUUID(); writeRoot(sid); connect(sid); const receipt = locate(sid).receipt!;
    const identity = await provider().resolveCurrent({ receipt });
    const exited = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
    const path = join(receipts, 'connect', `${receipt}.json`);
    const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    value.claude_pid = Number(exited.stdout); writeFileSync(path, JSON.stringify(value));
    const authorizeSource = vi.fn();
    await expect(provider({ authorizeSource }).revalidateBound({ receipt }, { ...identity,
      nativeMapping: { ...identity.nativeMapping!, processId: exited.stdout } })).rejects.toThrow('claude_process_absent');
    expect(authorizeSource).not.toHaveBeenCalled();
  });
});


describe('Claude live process identity', () => {
  it('rejects PID reuse even when the numeric PID remains signalable', async () => {
    const sid = randomUUID(); writeRoot(sid); connect(sid); const receipt = locate(sid).receipt!;
    const identity = await provider({ readProcessIdentity: () => 'synthetic-process-start-one' }).resolveCurrent({ receipt });
    const authorizeSource = vi.fn();
    await expect(provider({ authorizeSource, readProcessIdentity: () => 'synthetic-process-start-two' })
      .revalidateBound({ receipt }, identity)).rejects.toThrow('claude_bound_identity_changed');
    expect(authorizeSource).not.toHaveBeenCalled();
  });
});


describe('Claude active-observation process fence', () => {
  it('blocks discovery and root/child usage after the bound process start changes', async () => {
    const sid = randomUUID(); writeRoot(sid); connect(sid);
    const receipt = locate(sid).receipt!;
    const original = provider({ readProcessIdentity: () => 'synthetic-original-start' });
    const parent = await original.resolveCurrent({ receipt });
    writeChild(sid, 'child', [childRow(sid, 'child', '2026-10-07T01:00:00.000Z')]); subagent(sid, 'child', 'SubagentStart');
    const child = (await original.discoverChildren(parent)).children[0]!.identity;
    const authorizeSource = vi.fn();
    const changed = provider({ readProcessIdentity: () => 'synthetic-reused-pid-start', authorizeSource });
    await expect(changed.discoverChildren(parent)).rejects.toThrow('claude_bound_identity_changed');
    await expect(changed.readUsage(parent, null, scopeFor([parent, child]))).rejects.toThrow('claude_bound_identity_changed');
    await expect(changed.readUsage(child, null, scopeFor([parent, child]))).rejects.toThrow('claude_bound_identity_changed');
    expect(authorizeSource).not.toHaveBeenCalled();
  });

  it('requires the persisted root process proof before child usage access', async () => {
    const sid = randomUUID(); writeRoot(sid); connect(sid); const p = provider(); const parent = await currentIdentity(sid, p);
    writeChild(sid, 'child', [childRow(sid, 'child', '2026-10-07T01:00:00.000Z')]); subagent(sid, 'child', 'SubagentStart');
    const child = (await p.discoverChildren(parent)).children[0]!.identity;
    const authorizeSource = vi.fn(); const guarded = provider({ authorizeSource });
    await expect(guarded.readUsage(child, null, scopeFor([child]))).rejects.toThrow('claude_bound_identity_changed');
    expect(authorizeSource).not.toHaveBeenCalled();
  });
});


describe('Claude usage-window process fence', () => {
  it('rechecks the pinned process before an oversized-line probe window', async () => {
    const sid = randomUUID(); writeRoot(sid); connect(sid);
    const original = provider({ readProcessIdentity: () => 'synthetic-original-start' });
    const parent = await currentIdentity(sid, original);
    const initial = await original.readUsage(parent, null, scopeFor([parent]));
    appendFileSync(rootPath(sid), 'x'.repeat(150000) + '\n');
    let start = 'synthetic-original-start';
    const authorizeSource = vi.fn(() => { start = 'synthetic-reused-start'; });
    const guarded = provider({ maxReadBytes: 4096, readProcessIdentity: () => start, authorizeSource });
    await expect(guarded.readUsage(parent, initial.cursor, scopeFor([parent]))).rejects.toThrow('claude_bound_identity_changed');
    expect(authorizeSource).toHaveBeenCalledTimes(1);
  });

  it('authorizes each oversized-line probe and stops at the opened snapshot', async () => {
    const sid = randomUUID(); writeRoot(sid); connect(sid);
    const original = provider({ readProcessIdentity: () => 'synthetic-original-start' });
    const parent = await currentIdentity(sid, original);
    const initial = await original.readUsage(parent, null, scopeFor([parent]));
    appendFileSync(rootPath(sid), 'x'.repeat(150000));
    const authorizeSource = vi.fn(() => {
      if (authorizeSource.mock.calls.length === 2) appendFileSync(rootPath(sid), '\n' + lines([assistant(sid, 'after_oversized', [1, 0, 0, 1])]));
    });
    const guarded = provider({ maxReadBytes: 4096, readProcessIdentity: () => 'synthetic-original-start', authorizeSource });
    const pending = await guarded.readUsage(parent, initial.cursor, scopeFor([parent]));
    expect(pending).toEqual({ records: [], cursor: initial.cursor, gaps: [] });
    expect(authorizeSource).toHaveBeenCalledTimes(4);
    const skipped = await guarded.readUsage(parent, pending.cursor, scopeFor([parent]));
    expect(skipped.gaps).toEqual(['binding_usage_incomplete']);
    expect(ids((await guarded.readUsage(parent, skipped.cursor, scopeFor([parent]))).records)).toEqual(['after_oversized']);
  });

  it('rechecks the persisted root process before the next content window', async () => {
    const sid = randomUUID();
    writeRoot(sid, Array.from({ length: 40 }, (_, index) => assistant(sid, `window_${index}`, [1, 0, 0, 1])));
    connect(sid); const receipt = locate(sid).receipt!;
    const parent = await provider({ readProcessIdentity: () => 'synthetic-original-start' }).resolveCurrent({ receipt });
    let start = 'synthetic-original-start';
    const authorizeSource = vi.fn(() => { start = 'synthetic-reused-start'; });
    const guarded = provider({ maxReadBytes: 4096, readProcessIdentity: () => start, authorizeSource });
    await expect(guarded.readUsage(parent, null, scopeFor([parent]))).rejects.toThrow('claude_bound_identity_changed');
    expect(authorizeSource).toHaveBeenCalledTimes(1);
  });
});
