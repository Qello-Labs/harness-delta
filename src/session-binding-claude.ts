import { pendingChildReadiness } from './binding-child-readiness.js';
import { familyDiscovery, familyProviderError } from './binding-family-diagnostics.js';
import { bindingIdentityKey } from './session-binding-contract.js';
import { readCacheWriteTtl } from './cache-write-ttl.js';
import { claudeAgentMetadata } from './agent-metadata.js';
import { claudeBindingAdmission } from './claude-binding-admission.js';
import { readClaudeProcessBinary, type ClaudeProcessBinary } from './claude-process-binary.js';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, rmSync, writeFileSync, type Stats } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { z } from 'zod';
import { IdSchema, ModelSchema, TimestampSchema, TokenSchema, addTokens, type Reading } from './contracts.js';
import type { CandidateScope } from './nested-candidate.js';
// Type-only: the shared module is owned by the integration work item.
import type { BindingCapabilities, BindingReadBoundary, BindingUsageRecord, ChildDiscovery, CurrentIdentityRequest, SessionBindingProvider,
  NativeConnectionProof, UsageBatch, VerifiedSessionIdentity } from './session-binding-contract.js';

/** Claude Code ordinary-session binding provider.
 *
 * Identity and relations come from receipts written by scripts/claude-session-hook.mjs,
 * a command hook the harness-connect skill registers in its frontmatter. Claude Code
 * supplies session_id, transcript_path, cwd, agent_id and agent_transcript_path to that
 * hook and sets CLAUDE_PID (https://code.claude.com/docs/en/hooks, /env-vars, /skills).
 * Model-stated IDs, the Bash tool's environment and cwd are never proof.
 *
 * Receipts are owner-private local files. Like the Codex recorder, this is local trust,
 * not authentication: any process running as the same user, including a model-authored
 * Bash command, can write such a file. The provider narrows that boundary (live
 * same-user PID and process start, transcript inside the configured project's native
 * directory, and fresh receipt for new connections) but cannot detect a deliberate same-user forgery that names
 * such a transcript of this project.
 *
 * Claude subagents share the root session_id; each member has its own transcript under
 * <session>/subagents/ (documented layout). Membership is verified; the direct parent of
 * a nested subagent is not in the documented hook input, so members are flattened under
 * the root. The project directory encoding and every transcript row field read here are
 * undocumented native formats. Native profile evidence does not grant collection authority.
 *
 * Project scope is checked from receipt metadata and paths before any transcript read.
 * Only metadata leaves leave this module; transcript text, prompts, responses and tool
 * input never do.
 */

export interface ClaudeTranscriptProfile { readonly version: string; readonly status: 'qualified' | 'candidate'; readonly evidence: string }
/** Exact versions only. A candidate profile is synthetic-fixture evidence. A qualified profile also has
 * native transcript, skill-hook, family-membership and own-counter evidence for that exact version.
 * Neither status opens ordinary production collection: the binding service admits a source only
 * through a qualification lease, the human-pilot scope or a synthetic task. */
export const claudeBindingProfiles: readonly ClaudeTranscriptProfile[] = Object.freeze([
  Object.freeze({ version: '2.1.296', status: 'qualified' as const, evidence: 'offline-actual-binary;native-pilot-2026-10-13;validation/claude-ordinary-binding-02196-qualification.md' }),
  Object.freeze({ version: '2.1.294', status: 'candidate' as const, evidence: 'official-changelog-2.1.294;synthetic-fixtures;native-qualification-pending' }),
  Object.freeze({ version: '2.1.293', status: 'candidate' as const, evidence: 'synthetic-fixtures;native-qualification-pending' }),
  Object.freeze({ version: '2.1.291', status: 'candidate' as const, evidence: 'official-docs-2026-10-07;synthetic-fixtures;native-qualification-pending' }),
]);

export interface ClaudeBindingOptions {
  receiptDir: string;
  /** Claude Code's projects directory (normally ~/.claude/projects; CLAUDE_CONFIG_DIR moves it). */
  claudeProjectsDir: string;
  /** The task's registered project root; every identity's cwd is this exact value. */
  projectRoot: string;
  /** Synthetic tests and separately approved qualification only. Never a browser or UI flag. */
  allowCandidateProfiles?: boolean;
  /** The ordinary coordinator still supplies per-task, per-source read authority. */
  ordinaryAdmission?: boolean;
  profiles?: readonly ClaudeTranscriptProfile[];
  /** Task-owned metadata authorization, invoked before every content-bearing source read. */
  authorizeSource?: (metadata: { nativeSessionId: string; agentId: string | null; sourceRef: string; sourceIdentity: string; birthtimeMs: number }) => void;
  /** Metadata-only process-start proof. Injection is for synthetic tests. */
  readProcessIdentity?: (pid: number) => string;
  /** Metadata-only native image verification. Injection is for synthetic fixtures. */
  readProcessBinary?: (pid: number) => ClaudeProcessBinary;
  /** A new ordinary member is selected from Start/file metadata before its body is read. */
  memberEligible?: (metadata: {
    nativeSessionId: string; agentId: string; sourceRef: string; sourceIdentity: string;
    birthtimeMs: number; recordedAt?: string; processId: string;
  }) => boolean;
  /** Root plus distinct receipt or native-file members; checked before child reads. */
  maxFamilyMembers?: number;
  receiptMaxAgeMs?: number;
  /** A trailing request is held back while its transcript was written this recently. */
  quiescenceMs?: number;
  maxReadBytes?: number;
  now?: () => number;
}

const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
// uuid (36) + ':' + agent must fit IdSchema's 128 characters.
const agentPattern = /^[A-Za-z0-9_-]{1,91}$/;
const metadataWindow = 1048576;
// First-row search for identity metadata stops here; a member beyond it is reported, not dropped.
const metadataScanLimit = 16 * 1048576;
const recentLimit = 1024;
const absolutePath = z.string().min(1).max(4096).refine(value => isAbsolute(value) && !value.includes('\0'));
const ReceiptSchema = z.strictObject({
  schema_version: z.literal(1), kind: z.enum(['connect', 'subagent_start', 'subagent_stop']),
  receipt_id: z.string().regex(uuidPattern), session_id: z.string().regex(uuidPattern),
  agent_id: z.string().regex(agentPattern).nullable(), agent_type: z.string().max(128).nullable(),
  transcript_path: absolutePath, agent_transcript_path: absolutePath.nullable(), cwd: absolutePath,
  claude_pid: z.number().int().positive(), recorded_at: TimestampSchema, uid: z.number().int().nonnegative().nullable(),
});
type Receipt = z.infer<typeof ReceiptSchema>;
const CursorSchema = z.strictObject({ v: z.literal(3), source: IdSchema, offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  recent: z.array(z.tuple([IdSchema, z.string().regex(/^[a-f0-9]{64}$/)])).max(recentLimit),
  baselineExcluded: z.array(IdSchema).max(recentLimit) });
type Cursor = z.infer<typeof CursorSchema>;

const fail = (code: string): never => { throw familyProviderError(new Error(code), code); };
/** Synchronous work as a promise; a throw becomes a rejection. */
const settle = <T>(work: () => T): Promise<T> => new Promise<T>(resolve => { resolve(work()); });
const sha = (parts: unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const currentUid = () => typeof process.getuid === 'function' ? process.getuid() : null;
/** Fixed metadata-only OS query; no command line, environment or native source reads. */
const processIdentity = (pid: number): string => {
  let metadata: string;
  try {
    metadata = execFileSync('ps', ['-o', 'uid=', '-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8', timeout: 2000, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch { return fail('claude_process_absent'); }
  const match = /^(\d+)\s+(.+)$/.exec(metadata);
  if (!match || Number(match[1]) !== currentUid() || !Number.isFinite(Date.parse(match[2]!))) fail('claude_receipt_untrusted');
  return metadata;
};
const isPrivate = (stat: Stats) => (stat.mode & 0o077) === 0 && (currentUid() === null || stat.uid === currentUid());
/** Claude's native project directory name for a launch cwd (undocumented; qualification item). */
export const claudeProjectDirName = (path: string) => path.replace(/[^A-Za-z0-9]/g, '-');
const within = (child: string, parent: string) => { const rel = relative(parent, child); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); };
const nativeOf = (identity: VerifiedSessionIdentity) => {
  const [native, agent, extra] = identity.sessionId.split(':');
  if (identity.product !== 'claude_code' || !native || !uuidPattern.test(native) || extra !== undefined || (agent !== undefined && !agentPattern.test(agent))) fail('claude_identity_invalid');
  const mapping = identity.nativeMapping;
  if (mapping && (mapping.nativeSessionId !== native || mapping.agentId !== (agent ?? null))) fail('claude_identity_invalid');
  return { native: native!, agent: agent ?? null };
};
/** Provider-specific causes collapse onto the shared gap vocabulary. */
const sharedGap: Record<string, string> = {
  source_replaced: 'source_changed', source_truncated: 'source_changed', source_missing: 'source_unavailable', source_error: 'source_unavailable',
  invalid_line: 'binding_usage_incomplete', oversized_line_skipped: 'binding_usage_incomplete', foreign_session_row: 'binding_usage_incomplete',
  ownership_unverified: 'binding_ancestry_unverified', usage_missing: 'missing_usage', usage_incomplete: 'missing_usage', request_id_missing: 'missing_usage',
  request_conflict: 'incomplete_request', unsupported_version: 'unsupported_history', compaction_usage_unverified: 'binding_usage_incomplete',
  cache_write_1h_observed: 'binding_partial_usage', server_tool_use_unpriced: 'binding_partial_usage',
  child_relation_unverified: 'binding_ancestry_unverified', child_receipt_mismatch: 'binding_ancestry_unverified', child_receipt_invalid: 'binding_ancestry_unverified',
  child_receipt_untrusted: 'binding_ancestry_unverified', child_source_mismatch: 'binding_ancestry_unverified', child_source_missing: 'source_unavailable',
  binding_unobserved_context: 'binding_unobserved_context',
};
const shared = (codes: Iterable<string>) => [...new Set([...codes].map(code => sharedGap[code] ?? 'binding_usage_incomplete'))].sort();

function readPrivateFile(path: string, limit: number): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit || !isPrivate(stat)) fail('claude_receipt_untrusted');
    const buffer = Buffer.alloc(stat.size); let offset = 0;
    while (offset < stat.size) { const length = readSync(fd, buffer, offset, stat.size - offset, offset); if (!length) break; offset += length; }
    return buffer.subarray(0, offset).toString('utf8');
  } catch (error) {
    if (error instanceof Error && error.message === 'claude_receipt_untrusted') throw error;
    return fail('claude_receipt_missing');
  } finally { if (fd !== undefined) closeSync(fd); }
}
function assertPrivateDir(path: string) {
  let stat: Stats;
  try { stat = lstatSync(path); } catch { return fail('claude_receipt_missing'); }
  if (!stat.isDirectory() || !isPrivate(stat)) fail('claude_receipt_untrusted');
}
/** Owner's regular file at its canonical path; symlinks are refused. */
function checkedSourceFile(path: string): Stats {
  let stat: Stats;
  try { stat = lstatSync(path); } catch { return fail('claude_source_missing'); }
  if (!stat.isFile() || (stat.mode & 0o400) === 0 || (currentUid() !== null && stat.uid !== currentUid())) fail('claude_source_untrusted');
  try { if (realpathSync(path) !== path) fail('claude_source_untrusted'); } catch { fail('claude_source_untrusted'); }
  return stat;
}

interface RowMeta { type: unknown; sessionId: unknown; agentId: unknown; isSidechain: unknown; version: unknown; timestamp: unknown; subtype: unknown; requestId: unknown;
  message: { model: unknown; usage: Record<string, unknown> | null } | null }
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
/** Retains metadata leaves only; the parsed line is dropped immediately. */
function rowMeta(line: string): RowMeta | null {
  let row: Record<string, unknown> | null;
  try { row = object(JSON.parse(line)); } catch { return null; }
  if (!row) return null;
  const message = object(row.message);
  return { type: row.type, sessionId: row.sessionId, agentId: row.agentId, isSidechain: row.isSidechain, version: row.version,
    timestamp: row.timestamp, subtype: row.subtype, requestId: row.requestId,
    message: message ? { model: message.model, usage: object(message.usage) } : null };
}
/** Own rows: root rows carry no agent marker; member rows carry exactly their agent ID. */
const ownRow = (row: RowMeta, native: string, agent: string | null) => row.sessionId === native
  && (agent === null ? row.agentId === undefined && row.isSidechain !== true : row.agentId === agent);
const observed = (value: number): Reading => ({ status: 'observed', value, reason: null });
const token = (value: unknown): number | null => TokenSchema.safeParse(value).success ? value as number : null;
const isoTimestamp = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const time = Date.parse(value); if (!Number.isFinite(time)) return null;
  const normalized = new Date(time).toISOString();
  return TimestampSchema.safeParse(normalized).success ? normalized : null;
};
interface Line { start: number; end: number; text: string }
interface ReadChunk { lines: Line[]; end: number; size: number; stat: Stats; oversized: boolean }
interface Pending { requestId: string; first: Line; record: BindingUsageRecord; fingerprint: string; conflict: boolean }

export class ClaudeSessionBindingProvider implements SessionBindingProvider {
  readonly product = 'claude_code' as const;
  readonly #options: Required<Omit<ClaudeBindingOptions, 'profiles' | 'authorizeSource' | 'memberEligible'>> & Pick<ClaudeBindingOptions, 'authorizeSource' | 'memberEligible'> & { profiles: readonly ClaudeTranscriptProfile[] };
  constructor(options: ClaudeBindingOptions) {
    if (!isAbsolute(options.receiptDir) || !isAbsolute(options.claudeProjectsDir) || !isAbsolute(options.projectRoot)) fail('claude_binding_config_invalid');
    this.#options = { allowCandidateProfiles: false, ordinaryAdmission: false, profiles: claudeBindingProfiles, receiptMaxAgeMs: 600000, quiescenceMs: 30000,
      maxReadBytes: 8 * 1048576, maxFamilyMembers: 32, readProcessIdentity: processIdentity,
      readProcessBinary: readClaudeProcessBinary, now: Date.now, ...options };
    if (!Number.isSafeInteger(this.#options.maxFamilyMembers) || this.#options.maxFamilyMembers < 1 || this.#options.maxFamilyMembers > 32) fail('claude_binding_config_invalid');
  }

  capabilities(): BindingCapabilities {
    const qualified = this.#options.profiles.some(profile => profile.status === 'qualified');
    // A qualified transcript profile is not an ordinary production admission; the service decides that.
    return { currentIdentity: 'native_hook', ancestry: 'verified_relations', usage: 'own_requests',
      productionSupported: this.#options.ordinaryAdmission && claudeBindingAdmission.qualified,
      // Members are verified relations of the root; nested direct parents are not claimed.
      maxDepth: 1,
      reasons: ['claude_skill_hooks_required_per_session', 'claude_family_flattened_direct_parent_unverified', 'claude_receipts_local_trust',
        ...(qualified ? [] : ['claude_transcript_profile_unqualified'])] };
  }

  /** Version support is decided from native transcript rows against exact profiles. */
  supportedVersion(version: unknown): boolean {
    if (this.#options.ordinaryAdmission) return version === claudeBindingAdmission.productVersion;
    const profile = this.#options.profiles.find(p => p.version === version);
    // Transcript qualification cannot bypass the separately approved pilot authority.
    return profile !== undefined && this.#options.allowCandidateProfiles;
  }

  /** Metadata-only pilot scope check before receipt or transcript access. */
  assertProjectRoot(projectRoot: string): void {
    if (projectRoot !== this.#options.projectRoot) fail('binding_pilot_scope_invalid');
  }
  revalidateBound(input: CurrentIdentityRequest, expected: VerifiedSessionIdentity): Promise<VerifiedSessionIdentity> {
    return settle(() => this.#resolve(input, expected));
  }
  resolveCurrent(input: CurrentIdentityRequest): Promise<VerifiedSessionIdentity> { return settle(() => this.#resolve(input)); }
  inspectCurrent(input: CurrentIdentityRequest): Promise<NativeConnectionProof> {
    return settle(() => {
      if (!uuidPattern.test(input.receipt)) return fail('claude_receipt_invalid');
      assertPrivateDir(this.#options.receiptDir); assertPrivateDir(join(this.#options.receiptDir, 'connect'));
      const receipt = this.#receipt(join(this.#options.receiptDir, 'connect', `${input.receipt}.json`));
      const age = this.#options.now() - Date.parse(receipt.recorded_at);
      if (receipt.kind !== 'connect' || receipt.receipt_id !== input.receipt ||
        age < -5000 || age > this.#options.receiptMaxAgeMs) return fail('claude_receipt_expired');
      if (receipt.agent_id !== null) return fail('binding_child_requires_root');
      if (this.#forgotten(receipt.session_id)) return fail('deleted_identifier');
      const processId = this.#currentProcessProof(receipt.claude_pid);
      this.#assertProjectScope(receipt.transcript_path, receipt.cwd);
      const stat = this.#rootStat(receipt.transcript_path, receipt.session_id);
      const binary = this.#options.readProcessBinary(receipt.claude_pid);
      if (binary.productVersion !== claudeBindingAdmission.productVersion ||
        binary.sha256 !== claudeBindingAdmission.binarySha256) return fail('claude_binary_unqualified');
      return { receipt: receipt.receipt_id, recordedAt: receipt.recorded_at,
        nativeSessionId: receipt.session_id, agentId: null, sourceRef: receipt.transcript_path,
        sourceIdentity: this.#sourceIdentity(stat, receipt.session_id), cwd: this.#options.projectRoot,
        processId, productVersion: binary.productVersion };
    });
  }
  discoverChildren(parent: VerifiedSessionIdentity): Promise<ChildDiscovery> { return settle(() => this.#discover(parent)); }
  /** A null cursor reads the complete owned snapshot to the current end.
   * - `baseline: true` (root connect/restart, or a member that existed before observation):
   *   prior usage is excluded. No records are returned; every request seen so far, including
   *   one with missing counters, is remembered separately from observed replay IDs.
   *   Without a durable baseline ledger, more than 1,024 distinct baseline IDs fail closed.
   *   An unreadable/partial baseline always fails closed.
   *   Excluded IDs never evict as live requests advance, so later rows never count as
   *   new. Row-level defects in excluded history are not reported as gaps.
   * - otherwise (a member created during observation, or any later read): every own request
   *   is returned from the first one, independent of discovery time; only a request still
   *   being written is held back until complete. */
  readUsage(session: VerifiedSessionIdentity, cursor: string | null, scope: CandidateScope, boundary?: BindingReadBoundary): Promise<UsageBatch> {
    return settle(() => this.#usage(session, cursor, scope, boundary?.baseline === true, boundary?.baselineLedger));
  }

  /** Task/session deletion: removes this session's receipts and tombstones it so later
   * hook writes and replayed receipts cannot re-link it. Transcripts are never touched. */
  forgetSession(nativeSessionId: string): Promise<void> {
    return settle(() => {
      if (!uuidPattern.test(nativeSessionId)) fail('claude_identity_invalid');
      const forgotten = join(this.#options.receiptDir, 'forgotten');
      mkdirSync(forgotten, { recursive: true, mode: 0o700 });
      writeFileSync(join(forgotten, nativeSessionId), '', { mode: 0o600 });
      rmSync(join(this.#options.receiptDir, 'sessions', nativeSessionId), { recursive: true, force: true });
      const connectDir = join(this.#options.receiptDir, 'connect');
      const names = (() => { try { return readdirSync(connectDir); } catch { return []; } })();
      for (const name of names) {
        if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
        const sessionId = (() => { try { return this.#receipt(join(connectDir, name)).session_id; } catch { return null; } })();
        if (sessionId === nativeSessionId) rmSync(join(connectDir, name), { force: true });
      }
    });
  }

  #forgotten(native: string) { try { lstatSync(join(this.#options.receiptDir, 'forgotten', native)); return true; } catch { return false; } }
  #receipt(path: string): Receipt {
    const parsed = (() => { try { return ReceiptSchema.safeParse(JSON.parse(readPrivateFile(path, 16384))); } catch (error) {
      if (error instanceof Error && error.message.startsWith('claude_receipt_')) throw error; return fail('claude_receipt_invalid'); } })();
    if (!parsed.success) fail('claude_receipt_invalid');
    const receipt = parsed.data!;
    if (receipt.uid !== currentUid()) fail('claude_receipt_untrusted');
    return receipt;
  }
  #projectsRoot(): string { try { return realpathSync(this.#options.claudeProjectsDir); } catch { return fail('claude_source_missing'); } }
  /** <projects>/<encoded project>/<session>.jsonl or <projects>/<encoded project>/<session>/subagents/agent-<id>.jsonl */
  #memberPathValid(ref: string, native: string, agent: string | null): boolean {
    const projects = this.#projectsRoot();
    if (agent === null) return basename(ref) === `${native}.jsonl` && dirname(dirname(ref)) === projects;
    const projectDir = dirname(dirname(dirname(ref)));
    return ref === join(projectDir, native, 'subagents', `agent-${agent}.jsonl`) && dirname(projectDir) === projects;
  }
  #childPath(rootPath: string, native: string, agent: string) { return join(dirname(rootPath), native, 'subagents', `agent-${agent}.jsonl`); }
  /** Scope before content: the transcript must live in the registered project's native
   * directory and the hook cwd must be inside the project. No transcript byte is read. */
  #assertProjectScope(rootPath: string, hookCwd: string) {
    let root: string; let cwd: string;
    try { root = realpathSync(this.#options.projectRoot); cwd = realpathSync(hookCwd); } catch { return fail('claude_project_mismatch'); }
    const name = basename(dirname(rootPath));
    if (![root, this.#options.projectRoot].some(path => claudeProjectDirName(path) === name) || !within(cwd, root)) fail('claude_project_mismatch');
  }
  #sourceIdentity(stat: Stats, sessionId: string) { return sha(['claude-transcript-v2', stat.dev, stat.ino, stat.birthtimeMs, sessionId]); }

  #currentProcessProof(pid: number): string {
    try { process.kill(pid, 0); } catch (error) {
      fail((error as NodeJS.ErrnoException).code === 'EPERM' ? 'claude_receipt_untrusted' : 'claude_process_absent');
    }
    const identity = this.#options.readProcessIdentity(pid);
    if (this.#options.ordinaryAdmission) {
      const binary = this.#options.readProcessBinary(pid);
      if (binary.productVersion !== claudeBindingAdmission.productVersion ||
        binary.sha256 !== claudeBindingAdmission.binarySha256) return fail('claude_binary_unqualified');
    }
    return `claude-process:${pid}:${sha([pid, identity])}`;
  }
  /** Durable root proof is sufficient after restart, without searching receipt directories. */
  #assertBoundProcess(proof: string | null | undefined): void {
    const match = typeof proof === 'string' ? /^claude-process:([1-9][0-9]{0,9}):[a-f0-9]{64}$/.exec(proof) : null;
    if (!match || this.#currentProcessProof(Number(match[1])) !== proof) fail('claude_bound_identity_changed');
  }
  #authorize(path: string, stat: Stats, native: string, agent: string | null) {
    this.#options.authorizeSource?.({ nativeSessionId: native, agentId: agent, sourceRef: path,
      sourceIdentity: this.#sourceIdentity(stat, agent === null ? native : `${native}:${agent}`), birthtimeMs: stat.birthtimeMs });
  }
  #readLines(path: string, offset: number, limit: number, native: string, agent: string | null, expectedSourceIdentity: string, processProof: string | null | undefined): ReadChunk {
    const stat = checkedSourceFile(path);
    const sessionId = agent === null ? native : `${native}:${agent}`;
    if (this.#sourceIdentity(stat, sessionId) !== expectedSourceIdentity) fail('claude_source_replaced');
    this.#assertBoundProcess(processProof);
    this.#authorize(path, stat, native, agent);
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = fstatSync(fd);
      if (this.#sourceIdentity(opened, sessionId) !== expectedSourceIdentity || opened.uid !== stat.uid || opened.mode !== stat.mode) fail('claude_source_untrusted');
      const none: ReadChunk = { lines: [], end: offset, size: opened.size, stat: opened, oversized: false };
      if (opened.size <= offset) return none;
      const length = Math.min(limit, opened.size - offset);
      const buffer = Buffer.alloc(length); let read = 0;
      while (read < length) { const n = readSync(fd, buffer, read, length - read, offset + read); if (!n) break; read += n; }
      const last = buffer.subarray(0, read).lastIndexOf(0x0a);
      if (last < 0) {
        if (read < limit) return none;
        // A single line larger than the read window is skipped without parsing.
        let probe = offset + read; const chunk = Buffer.alloc(65536);
        while (probe < opened.size) {
          const current = checkedSourceFile(path);
          if (this.#sourceIdentity(current, sessionId) !== expectedSourceIdentity) fail('claude_source_replaced');
          const descriptor = fstatSync(fd);
          if (this.#sourceIdentity(descriptor, sessionId) !== expectedSourceIdentity || descriptor.uid !== current.uid || descriptor.mode !== current.mode) fail('claude_source_untrusted');
          this.#assertBoundProcess(processProof);
          this.#authorize(path, current, native, agent);
          const n = readSync(fd, chunk, 0, Math.min(chunk.length, opened.size - probe), probe); if (!n) return none;
          const index = chunk.subarray(0, n).indexOf(0x0a);
          if (index >= 0) return { ...none, end: probe + index + 1, oversized: true };
          probe += n;
        }
        return none;
      }
      const lines: Line[] = []; let start = 0;
      while (start <= last) {
        const newline = buffer.indexOf(0x0a, start);
        if (newline > start) lines.push({ start: offset + start, end: offset + newline + 1, text: buffer.subarray(start, newline).toString('utf8') });
        start = newline + 1;
      }
      return { lines, end: offset + last + 1, size: opened.size, stat: opened, oversized: false };
    } finally { closeSync(fd); }
  }
  /** First own row's timestamp and version, scanning bounded windows from the start. */
  #firstOwnRow(path: string, native: string, agent: string | null, sourceIdentity: string, processProof: string | null | undefined): { createdAt: string | null; version: string | null; scanned: number } {
    let createdAt: string | null = null; let offset = 0; let scanned = 0;
    while (offset < metadataScanLimit) {
      const chunk = this.#readLines(path, offset, metadataWindow, native, agent, sourceIdentity, processProof);
      scanned += chunk.lines.length;
      for (const line of chunk.lines) {
        const row = rowMeta(line.text);
        if (!row || !ownRow(row, native, agent)) continue;
        createdAt ??= isoTimestamp(row.timestamp);
        if (typeof row.version === 'string' && createdAt !== null) return { createdAt, version: row.version, scanned };
      }
      if (chunk.end <= offset || chunk.end >= chunk.size) break;
      offset = chunk.end;
    }
    return { createdAt, version: null, scanned };
  }
  #identity(native: string, agent: string | null, rootPath: string, sourcePath: string, stat: Stats, version: string, createdAt: string, agentType?: unknown, processId: string | null = null): VerifiedSessionIdentity {
    const agentMetadata = claudeAgentMetadata(agentType);
    const sessionId = agent === null ? native : `${native}:${agent}`;
    // Stable per member: repeated connects and rediscovery yield byte-identical identities.
    const evidence = agent === null ? `claude-session:${sha([native, rootPath])}` : `claude-agent:${sha([native, agent, rootPath])}`;
    return { ...(agentMetadata ? { agentMetadata } : {}), product: 'claude_code', productVersion: version, sessionId, sourceRef: sourcePath, sourceIdentity: this.#sourceIdentity(stat, sessionId),
      cwd: this.#options.projectRoot, identityEvidenceId: evidence, parentSessionId: agent === null ? null : native, createdAt,
      nativeMapping: { nativeSessionId: native, processId, agentId: agent } };
  }
  #rootStat(rootPath: string, native: string): Stats {
    if (!this.#memberPathValid(rootPath, native, null)) fail('claude_source_untrusted');
    return checkedSourceFile(rootPath);
  }

  #resolve(input: CurrentIdentityRequest, expected?: VerifiedSessionIdentity): VerifiedSessionIdentity {
    const receiptId = typeof input?.receipt === 'string' && uuidPattern.test(input.receipt) ? input.receipt : fail('claude_receipt_invalid');
    assertPrivateDir(this.#options.receiptDir); assertPrivateDir(join(this.#options.receiptDir, 'connect'));
    const receipt = this.#receipt(join(this.#options.receiptDir, 'connect', `${receiptId}.json`));
    const recordedAt = Date.parse(receipt.recorded_at); const age = this.#options.now() - recordedAt;
    if (receipt.kind !== 'connect' || receipt.receipt_id !== receiptId || age < -5000 || (!expected && age > this.#options.receiptMaxAgeMs)) fail('claude_receipt_expired');
    if (expected && (expected.product !== 'claude_code' || expected.parentSessionId !== null || receipt.agent_id !== null
      || expected.sessionId !== receipt.session_id || expected.nativeMapping?.nativeSessionId !== receipt.session_id
      || expected.nativeMapping.agentId !== null
      || expected.cwd !== this.#options.projectRoot || expected.sourceRef !== receipt.transcript_path)) fail('claude_bound_identity_changed');
    if (this.#forgotten(receipt.session_id)) fail('deleted_identifier');
    const processId = this.#currentProcessProof(receipt.claude_pid);
    if (expected && expected.nativeMapping?.processId !== processId) fail('claude_bound_identity_changed');
    // Inside a subagent the hook transcript may be the root or the member file; derive the root.
    const native = receipt.session_id;
    const rootPath = receipt.agent_id !== null && receipt.transcript_path.endsWith(join(native, 'subagents', `agent-${receipt.agent_id}.jsonl`))
      ? join(dirname(dirname(dirname(receipt.transcript_path))), `${native}.jsonl`) : receipt.transcript_path;
    if (!this.#memberPathValid(rootPath, native, null)) fail('claude_source_untrusted');
    this.#assertProjectScope(rootPath, receipt.cwd);
    const rootStat = this.#rootStat(rootPath, native);
    if (expected) {
      if (this.#sourceIdentity(rootStat, native) !== expected.sourceIdentity) fail('claude_bound_identity_changed');
      const identity = this.#identity(native, null, rootPath, rootPath, rootStat, expected.productVersion, expected.createdAt, receipt.agent_type, processId);
      if (bindingIdentityKey(identity) !== bindingIdentityKey(expected)) fail('claude_bound_identity_changed');
      if (!this.supportedVersion(identity.productVersion)) fail('claude_source_version_unsupported');
      this.#authorize(rootPath, rootStat, native, null);
      return identity;
    }
    // A connecting session has just written its transcript; a stale file is not current.
    if (rootStat.mtimeMs < recordedAt - this.#options.receiptMaxAgeMs) fail('claude_source_stale');
    const root = this.#firstOwnRow(rootPath, native, null, this.#sourceIdentity(rootStat, native), processId);
    if (root.version === null || root.createdAt === null) fail('claude_source_version_unobserved');
    if (!this.supportedVersion(root.version)) fail('claude_source_version_unsupported');
    if (receipt.agent_id === null) {
      const identity = this.#identity(native, null, rootPath, rootPath, rootStat, root.version!, root.createdAt!, receipt.agent_type, processId);
      return identity;
    }
    // A re-invocation inside a subagent resolves to that member, never a new root.
    const childPath = this.#childPath(rootPath, native, receipt.agent_id);
    const childStat = (() => { try { return checkedSourceFile(childPath); } catch { return fail('claude_child_source_unavailable'); } })();
    const child = this.#firstOwnRow(childPath, native, receipt.agent_id, this.#sourceIdentity(childStat, `${native}:${receipt.agent_id}`), processId);
    if (child.createdAt === null) fail('claude_child_source_unavailable');
    return this.#identity(native, receipt.agent_id, rootPath, childPath, childStat, root.version!, child.createdAt!, receipt.agent_type);
  }

  #discover(parent: VerifiedSessionIdentity): ChildDiscovery {
    const { native, agent } = nativeOf(parent);
    // Claude members are discovered from the root's own receipts and layout only.
    if (agent !== null || parent.parentSessionId !== null || this.#forgotten(native)) return { children: [], gaps: [] };
    this.#assertBoundProcess(parent.nativeMapping?.processId);
    this.#assertProjectScope(parent.sourceRef, parent.cwd);
    const rootStat = this.#rootStat(parent.sourceRef, native);
    if (this.#sourceIdentity(rootStat, native) !== parent.sourceIdentity) return familyDiscovery({ children: [], gaps: shared(['source_replaced']) }, ['source_replaced']);
    const gaps: string[] = [];
    const agentsDir = join(this.#options.receiptDir, 'sessions', native, 'agents');
    const names = (() => {
      try { assertPrivateDir(agentsDir); return readdirSync(agentsDir); } catch (error) {
        if (error instanceof Error && error.message === 'claude_receipt_untrusted') gaps.push('child_receipt_untrusted');
        return [];
      }
    })();
    const receipts = new Map<string, Receipt[]>();
    for (const name of names) {
      const matched = /^([A-Za-z0-9_-]{1,91})\.(subagent_start|subagent_stop)\.json$/.exec(name);
      if (!matched) continue;
      let receipt: Receipt;
      try { receipt = this.#receipt(join(agentsDir, name)); } catch { gaps.push('child_receipt_invalid'); continue; }
      // Relation proof: same native session and the root transcript this parent was bound with.
      if (receipt.agent_id !== matched[1] || receipt.kind !== matched[2] || receipt.session_id !== native || receipt.transcript_path !== parent.sourceRef) { gaps.push('child_receipt_mismatch'); continue; }
      try { this.#assertProjectScope(parent.sourceRef, receipt.cwd); } catch { gaps.push('child_receipt_mismatch'); continue; }
      receipts.set(receipt.agent_id, [...(receipts.get(receipt.agent_id) ?? []), receipt]);
    }
    const files = (() => { try { return readdirSync(join(dirname(parent.sourceRef), native, 'subagents')); } catch { return []; } })();
    const members = new Set(receipts.keys());
    for (const file of files) {
      const matched = /^agent-([A-Za-z0-9_-]{1,91})\.jsonl$/.exec(file);
      if (matched) members.add(matched[1]!);
    }
    if (!this.#options.ordinaryAdmission && members.size >= this.#options.maxFamilyMembers) fail('claude_family_scope_limit');
    const children: ChildDiscovery['children'] = [];
    const excludedMembers = new Set<string>();
    if (this.#options.ordinaryAdmission) {
      const processId = parent.nativeMapping?.processId;
      const rootPid = Number(processId?.split(':')[1]);
      let eligibleMembers = 0;
      for (const [agentId, list] of receipts) {
        const start = list.find(receipt => receipt.kind === 'subagent_start');
        const expected = this.#childPath(parent.sourceRef, native, agentId);
        let stat: Stats;
        try { stat = checkedSourceFile(expected); } catch { continue; }
        if (!start || !processId || start.claude_pid !== rootPid || !this.#options.memberEligible?.({
          nativeSessionId: native, agentId, sourceRef: expected,
          sourceIdentity: this.#sourceIdentity(stat, `${native}:${agentId}`),
          birthtimeMs: stat.birthtimeMs, recordedAt: start.recorded_at, processId,
        })) { excludedMembers.add(agentId); continue; }
        eligibleMembers++;
      }
      if (eligibleMembers >= this.#options.maxFamilyMembers) fail('claude_family_scope_limit');
    }
    const pending: number[] = [];
    const pendingStarts: Array<{ receiptId: string; agentId: string; recordedAt: string }> = [];
    const readinessWindowMs = this.#options.ordinaryAdmission ? 300000 : 2000;
    const waitForStart = (start: Receipt) => { pending.push(Date.parse(start.recorded_at) + readinessWindowMs); pendingStarts.push({ receiptId: start.receipt_id, agentId: start.agent_id!, recordedAt: start.recorded_at }); };
    for (const [agentId, list] of [...receipts.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (excludedMembers.has(agentId)) continue;
      const expected = this.#childPath(parent.sourceRef, native, agentId);
      const stop = list.find(r => r.kind === 'subagent_stop');
      if (stop && stop.agent_transcript_path !== expected) {
        const real = (() => { try { return realpathSync(stop.agent_transcript_path!); } catch { return null; } })();
        if (real !== expected) { gaps.push('child_source_mismatch'); continue; }
      }
      const start = list.find(receipt => receipt.kind === 'subagent_start');
      const startAt = start ? Date.parse(start.recorded_at) : NaN;
      const age = this.#options.now() - startAt;
      const rootPid = Number(parent.nativeMapping?.processId?.split(':')[1]);
      const canWait = !stop && !!start && start.claude_pid === rootPid && startAt >= Date.parse(parent.createdAt) && age >= 0 && age < readinessWindowMs;
      let stat: Stats;
      try { lstatSync(expected); } catch (error) {
        if (this.#options.ordinaryAdmission && start && !canWait &&
          error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          gaps.push('binding_unobserved_context'); continue;
        }
        if (canWait && (error as NodeJS.ErrnoException).code === 'ENOENT') waitForStart(start);
        gaps.push('child_source_missing'); continue;
      }
      try { stat = checkedSourceFile(expected); } catch { gaps.push('child_source_missing'); continue; }
      // A member file can appear after the first metadata pass.
      const processId = parent.nativeMapping?.processId;
      if (this.#options.ordinaryAdmission && (!start || !processId || start.claude_pid !== rootPid || !this.#options.memberEligible?.({
        nativeSessionId: native, agentId, sourceRef: expected,
        sourceIdentity: this.#sourceIdentity(stat, `${native}:${agentId}`),
        birthtimeMs: stat.birthtimeMs, recordedAt: start.recorded_at, processId,
      }))) { gaps.push('binding_unobserved_context'); continue; }
      // A fresh Start may hold family measurement until an attributable own row exists.
      // Complete lines without that identity remain terminal, never silently dropped.
      const first = this.#firstOwnRow(expected, native, agentId, this.#sourceIdentity(stat, `${native}:${agentId}`), parent.nativeMapping?.processId);
      if (first.createdAt === null) {
        if (first.scanned > 0) gaps.push('ownership_unverified');
        else { gaps.push('child_source_missing'); if (canWait) waitForStart(start); }
        continue;
      }
      const identity = this.#identity(native, agentId, parent.sourceRef, expected, stat, parent.productVersion, first.createdAt, (list.find(r => r.kind === 'subagent_start') ?? stop)?.agent_type);
      children.push({ parentSessionId: native, relationEvidenceId: identity.identityEvidenceId, identity });
    }
    // Native member files without a hook receipt (for example, spawned before connect or
    // while hooks were absent) are neither linked nor counted.
    for (const file of files) {
      const matched = /^agent-([A-Za-z0-9_-]{1,91})\.jsonl$/.exec(file);
      if (matched && !receipts.has(matched[1]!)) {
        if (!this.#options.ordinaryAdmission) { gaps.push('child_relation_unverified'); continue; }
        const agentId = matched[1]!;
        const sourceRef = this.#childPath(parent.sourceRef, native, agentId);
        const stat = checkedSourceFile(sourceRef);
        const processId = parent.nativeMapping?.processId;
        if (!processId) return fail('claude_process_unobserved');
        const eligible = this.#options.memberEligible?.({
          nativeSessionId: native, agentId, sourceRef,
          sourceIdentity: this.#sourceIdentity(stat, `${native}:${agentId}`),
          birthtimeMs: stat.birthtimeMs, processId,
        });
        if (!eligible) gaps.push('binding_unobserved_context');
      }
    }
    if (excludedMembers.size) gaps.push('binding_unobserved_context');
    const result = familyDiscovery({ children, gaps: shared(gaps) }, gaps);
    return pending.length && pending.length === gaps.filter(gap => gap !== 'binding_unobserved_context').length
      ? pendingChildReadiness(result, Math.min(...pending), pendingStarts) : result;
  }

  #usage(session: VerifiedSessionIdentity, cursorText: string | null, scope: CandidateScope, baseline: boolean, baselineLedger?: BindingReadBoundary['baselineLedger']): UsageBatch {
    const { native, agent } = nativeOf(session);
    if (this.#forgotten(native)) fail('deleted_identifier');
    const mapping = scope.sessions.find(m => m.sourceId === session.sessionId && m.product === 'claude_code' && m.nativeSessionId === native && m.agentId === agent);
    if (!mapping) return fail('claude_scope_mismatch');
    const roots = scope.sessions.filter(member => member.sessionId === mapping.rootSessionId && member.rootSessionId === mapping.rootSessionId
      && member.product === 'claude_code' && member.nativeSessionId === native && member.agentId === null && member.parentSessionId === null);
    if (roots.length !== 1 || (agent === null && roots[0]!.processId !== session.nativeMapping?.processId)) fail('claude_bound_identity_changed');
    const rootProcessProof = roots[0]!.processId;
    this.#assertBoundProcess(rootProcessProof);
    if (!this.supportedVersion(session.productVersion)) fail('claude_source_version_unsupported');
    if (!this.#memberPathValid(session.sourceRef, native, agent)) fail('claude_source_untrusted');
    const rootPath = agent === null ? session.sourceRef : join(dirname(dirname(dirname(session.sourceRef))), `${native}.jsonl`);
    this.#assertProjectScope(rootPath, session.cwd);
    const encode = (cursor: Cursor) => Buffer.from(JSON.stringify(cursor)).toString('base64url');
    const start: Cursor = cursorText === null ? { v: 3, source: session.sourceIdentity, offset: 0, recent: [], baselineExcluded: [] } : (() => {
      try { return CursorSchema.parse(JSON.parse(Buffer.from(cursorText, 'base64url').toString('utf8'))); } catch { return fail('claude_cursor_invalid'); } })();
    const unchanged = (gap: string): UsageBatch => baseline ? fail('claude_baseline_incomplete') : ({ records: [], cursor: encode(start), gaps: shared([gap]) });
    if (start.source !== session.sourceIdentity) return unchanged('source_replaced');
    const gaps = new Set<string>();
    const recent = new Map(start.recent); const baselineExcluded = new Set(start.baselineExcluded);
    const records: BindingUsageRecord[] = [];
    let offset = start.offset;
    // A null cursor or a baseline reads to the current end; a later cursor reads one window per call.
    const toEnd = cursorText === null || baseline;
    for (;;) {
      let chunk: ReadChunk;
      try { chunk = this.#readLines(session.sourceRef, offset, this.#options.maxReadBytes, native, agent, session.sourceIdentity, rootProcessProof); } catch (error) {
        if (!(error instanceof Error) || !['claude_source_missing', 'claude_source_untrusted', 'claude_source_replaced'].includes(error.message)) throw error;
        return unchanged(error.message === 'claude_source_missing' ? 'source_missing' : error.message === 'claude_source_replaced' ? 'source_replaced' : 'source_error');
      }
      if (this.#sourceIdentity(chunk.stat, session.sessionId) !== session.sourceIdentity) return unchanged('source_replaced');
      if (chunk.size < offset) return unchanged('source_truncated');
      if (baseline && chunk.oversized) fail('claude_baseline_incomplete');
      // Migrate legacy exclusions only after the source's read authority is checked.
      if (baselineLedger) {
        if (baselineLedger.addMany) baselineLedger.addMany([...baselineExcluded]);
        else for (const requestId of baselineExcluded) baselineLedger.add(requestId);
        baselineExcluded.clear();
      }
      if (chunk.oversized) gaps.add('oversized_line_skipped');
      const baselineIds = new Set<string>();
      if (baseline) for (const line of chunk.lines) {
        const row = rowMeta(line.text);
        if (!row) return fail('claude_baseline_incomplete');
        if (row.type !== 'assistant' || !ownRow(row, native, agent) || row.message?.model === '<synthetic>') continue;
        const request = IdSchema.safeParse(row.requestId);
        if (!request.success) return fail('claude_baseline_incomplete');
        // Preserve ownership IDs even when an in-flight row has missing counters.
        if (baselineLedger) baselineIds.add(request.data);
        else {
          baselineExcluded.add(request.data);
          if (baselineExcluded.size > recentLimit) fail('claude_baseline_limit');
        }
      }
      if (baselineLedger && baselineIds.size) {
        if (baselineLedger.addMany) baselineLedger.addMany([...baselineIds]);
        else for (const requestId of baselineIds) baselineLedger.add(requestId);
      }
      const pending = this.#collect(chunk, native, agent, session.productVersion, gaps);
      // While the file is still being written, a request whose rows end the window may be
      // incomplete: hold it back and resume from its first row on the next read.
      const tail = pending.at(-1);
      const writing = this.#options.now() - chunk.stat.mtimeMs < this.#options.quiescenceMs;
      const trailing = tail !== undefined && chunk.lines.filter(line => line.start > tail.first.start).every(line => {
        const row = rowMeta(line.text); return row?.type === 'assistant' && row.requestId === tail.requestId; });
      const held = !baseline && writing && trailing ? tail : undefined;
      for (const item of pending) {
        if (baseline || (baselineLedger ? baselineLedger.has(item.requestId) : baselineExcluded.has(item.requestId))) continue;
        if (item === held) continue;
        const seen = recent.get(item.requestId);
        // Rows of an already emitted request (later batch or replay) are never re-emitted.
        if (seen !== undefined && (item.conflict || seen !== item.fingerprint)) fail('binding_request_conflict');
        if (item.conflict) { gaps.add('request_conflict'); recent.set(item.requestId, item.fingerprint); continue; }
        if (seen === undefined) { records.push(item.record); recent.set(item.requestId, item.fingerprint); }
      }
      const before = offset;
      offset = held ? held.first.start : chunk.end;
      if (baseline && offset <= before && offset < chunk.size) fail('claude_baseline_incomplete');
      if (!toEnd || held || offset <= before || offset >= chunk.size) break;
    }
    return { records, cursor: encode({ v: 3, source: session.sourceIdentity, offset, recent: [...recent.entries()].slice(-recentLimit), baselineExcluded: [...baselineExcluded] }),
      gaps: baseline ? [] : shared(gaps) };
  }

  /** Groups own assistant rows by request; every row of one request must agree. */
  #collect(chunk: ReadChunk, native: string, agent: string | null, version: string, gaps: Set<string>): Pending[] {
    const byRequest = new Map<string, Pending>();
    for (const line of chunk.lines) {
      const row = rowMeta(line.text);
      if (!row) { gaps.add('invalid_line'); continue; }
      if (row.type === 'system' && row.subtype === 'compact_boundary') gaps.add('compaction_usage_unverified');
      if (row.type !== 'assistant') continue;
      if (row.sessionId !== native) { gaps.add('foreign_session_row'); continue; }
      // Descendant rows copied into this file are counted only from the descendant's own file.
      if (!ownRow(row, native, agent)) {
        if (agent !== null ? row.agentId === undefined : row.agentId === null) gaps.add('ownership_unverified');
        continue;
      }
      const usage = row.message?.usage;
      if (!row.message || !usage) { gaps.add('usage_missing'); continue; }
      if (row.message.model === '<synthetic>') continue;
      if (row.version !== version || !this.supportedVersion(row.version)) { gaps.add('unsupported_version'); continue; }
      const requestId = IdSchema.safeParse(row.requestId);
      if (!requestId.success) { gaps.add('request_id_missing'); continue; }
      const model = ModelSchema.safeParse(row.message.model);
      const occurredAt = isoTimestamp(row.timestamp);
      const ordinary = token(usage.input_tokens); const write = token(usage.cache_creation_input_tokens);
      const read = token(usage.cache_read_input_tokens); const output = token(usage.output_tokens);
      if (!model.success || occurredAt === null || ordinary === null || write === null || read === null || output === null) { gaps.add('usage_incomplete'); continue; }
      const creation = object(usage.cache_creation);
      const ttl = readCacheWriteTtl(usage.cache_creation, write);
      const oneHourWrite = creation !== null && (token(creation.ephemeral_1h_input_tokens) ?? 0) > 0;
      if (oneHourWrite) gaps.add('cache_write_1h_observed');
      const server = object(usage.server_tool_use); if (server && Object.values(server).some(v => (token(v) ?? 0) > 0)) gaps.add('server_tool_use_unpriced');
      // Retain old fingerprints only when no new TTL evidence exists. This avoids
      // replaying old cursors while numeric splits and malformed evidence conflict.
      const fingerprint = sha([model.data, ordinary, write, read, output, version, ...(oneHourWrite ? ['cache_write_1h_observed'] : []),
        ...(usage.cache_creation === undefined ? [] : ['cache_write_ttl-v1', ttl])]);
      const old = byRequest.get(requestId.data);
      if (old) { if (old.fingerprint !== fingerprint) old.conflict = true; continue; }
      // The first row's timestamp is the request's deterministic occurrence time.
      byRequest.set(requestId.data, { requestId: requestId.data, first: line, fingerprint, conflict: false, record: {
        requestId: requestId.data, sessionId: agent === null ? native : `${native}:${agent}`, occurredAt, turnId: null, effort: null,
        payload: { kind: 'usage', schema_version: 2, product: 'claude_code', product_version: version, model: model.data, epoch: 'sequential',
          ...(oneHourWrite ? { cache_write_1h_observed: true as const } : {}),
          cache_write_ttl: ttl,
          attribution: 'verified', input_total: observed(addTokens([ordinary, write, read])), cached_input: observed(read),
          output_total: observed(output), reasoning_output: { status: 'unmeasurable', value: null, reason: 'unsupported' },
          billing_components: [{ kind: 'ordinary_input', reading: observed(ordinary) }, { kind: 'cache_read', reading: observed(read) },
            { kind: 'cache_write', reading: observed(write) },
            { kind: 'output', reading: observed(output) }] } } });
    }
    return [...byRequest.values()];
  }
}

export function createClaudeSessionBindingProvider(options: ClaudeBindingOptions): ClaudeSessionBindingProvider {
  return new ClaudeSessionBindingProvider(options);
}
