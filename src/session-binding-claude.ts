import { pendingChildReadiness } from './binding/binding-child-readiness.js';
import { familyDiscovery, familyProviderError } from './binding/binding-family-diagnostics.js';
import { bindingIdentityKey, PromotionPendingReceiptSchema } from './session-binding-contract.js';
import { readCacheWriteTtl } from './sources/cache-write-ttl.js';
import { claudeAgentMetadata } from './sources/agent-metadata.js';
import { getEffectiveClaudeBindingAdmission, isClaudeModel } from './claude-binding-admission.js';
import {
  legacyClaudeTranscriptProfiles,
  lookupEffectiveToolVersionFacet,
  lookupToolVersionProfile,
  orderedToolVersionProfiles
} from './core/tool-version-profiles.js';
import type { ToolVersionPromotionAuthority } from './core/tool-version-promotion-store.js';
import {
  type ClaudeProcessBinary,
  type ClaudeWindowBinaryAdapters,
  ClaudeWindowBinaryReader,
  createClaudeWindowBinaryAdapters,
  readClaudeProcessBinary
} from './claude-process-binary.js';
import { assertClaudeWindowSourceAuthorization, type ClaudeWindowSourceAuthorization } from './core/ordinary-window-store.js';
import { emptyOrdinaryWindowCoverage, type OrdinaryWindowConnectionProof, type OrdinaryWindowCoverage } from './core/ordinary-window-policy.js';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  rmSync,
  type Stats,
  writeFileSync
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { z } from 'zod';
import { addTokens, IdSchema, ModelSchema, type Reading, TimestampSchema, TokenSchema } from './contracts.js';
import type { CandidateScope } from './nested-candidate.js';
// Type-only: the shared module is owned by the integration work item.
import type {
  BindingCapabilities,
  BindingReadBoundary,
  BindingUsageRecord,
  ChildDiscovery,
  CurrentIdentityRequest,
  NativeConnectionProof,
  OrdinaryWindowReadBoundary,
  OrdinaryWindowUsageBatch,
  PromotionBindingAuthority,
  PromotionBindingProof,
  PromotionPendingReceipt,
  SessionBindingProvider,
  UsageBatch,
  VerifiedSessionIdentity
} from './session-binding-contract.js';

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

export interface ClaudeTranscriptProfile {
  readonly version: string;
  readonly status: 'qualified' | 'candidate';
  readonly evidence: string;
}
/** Exact versions only. A candidate profile is synthetic-fixture evidence. A qualified profile also has
 * native transcript, skill-hook, family-membership and own-counter evidence for that exact version.
 * Ordinary admission is a separate code-owned use policy; transcript qualification
 * does not open comparison, pilot or other-version collection. */
export const claudeBindingProfiles: readonly ClaudeTranscriptProfile[] = Object.freeze(legacyClaudeTranscriptProfiles().map(profile => Object.freeze(profile)));
const legacyProductVersion = z
  .string()
  .parse(
    orderedToolVersionProfiles('transcriptProfile', 'claude_code').find(
      profile => profile.product === 'claude_code' && profile.transcriptProfile?.legacyDefault
    )?.version
  );

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
  productVersion?: string;
  promotionAuthority?: PromotionBindingAuthority;
  profiles?: readonly ClaudeTranscriptProfile[];
  /** Task-owned metadata authorization, invoked before every content-bearing source read. */
  authorizeSource?: (metadata: { nativeSessionId: string; agentId: string | null; sourceRef: string; sourceIdentity: string; birthtimeMs: number }) => void;
  /** Metadata-only process-start proof. Injection is for synthetic tests. */
  readProcessIdentity?: (pid: number) => string;
  /** Metadata-only native image verification. Injection is for synthetic fixtures. */
  readProcessBinary?: (pid: number) => ClaudeProcessBinary;
  /** A new ordinary member is selected from Start/file metadata before its body is read. */
  memberEligible?: (metadata: {
    nativeSessionId: string;
    agentId: string;
    sourceRef: string;
    sourceIdentity: string;
    birthtimeMs: number;
    recordedAt?: string;
    processId: string;
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
const absolutePath = z
  .string()
  .min(1)
  .max(4096)
  .refine(value => isAbsolute(value) && !value.includes('\0'));
const ReceiptSchema = z.strictObject({
  schema_version: z.literal(1),
  kind: z.enum(['connect', 'subagent_start', 'subagent_stop']),
  receipt_id: z.string().regex(uuidPattern),
  session_id: z.string().regex(uuidPattern),
  agent_id: z.string().regex(agentPattern).nullable(),
  agent_type: z.string().max(128).nullable(),
  transcript_path: absolutePath,
  agent_transcript_path: absolutePath.nullable(),
  cwd: absolutePath,
  claude_pid: z.number().int().positive(),
  recorded_at: TimestampSchema,
  uid: z.number().int().nonnegative().nullable()
});
type Receipt = z.infer<typeof ReceiptSchema>;
const CursorSchema = z.strictObject({
  v: z.literal(3),
  source: IdSchema,
  offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  recent: z.array(z.tuple([IdSchema, z.string().regex(/^[a-f0-9]{64}$/)])).max(recentLimit),
  baselineExcluded: z.array(IdSchema).max(recentLimit)
});
type Cursor = z.infer<typeof CursorSchema>;

const fail = (code: string): never => {
  throw familyProviderError(new Error(code), code);
};
/** Synchronous work as a promise; a throw becomes a rejection. */
const settle = <T>(work: () => T): Promise<T> =>
  new Promise<T>(resolve => {
    resolve(work());
  });
const sha = (parts: unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const currentUid = () => (typeof process.getuid === 'function' ? process.getuid() : null);
/** Fixed metadata-only OS query; no command line, environment or native source reads. */
const processIdentity = (pid: number): string => {
  let metadata: string;
  try {
    metadata = execFileSync('ps', ['-o', 'uid=', '-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 2000,
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
  } catch {
    return fail('claude_process_absent');
  }
  const match = /^(\d+)\s+(.+)$/.exec(metadata);
  if (!match || Number(match[1]) !== currentUid() || !Number.isFinite(Date.parse(match[2]!))) fail('claude_receipt_untrusted');
  return metadata;
};
const isPrivate = (stat: Stats) => (stat.mode & 0o077) === 0 && (currentUid() === null || stat.uid === currentUid());
/** Claude's native project directory name for a launch cwd (undocumented; qualification item). */
export const claudeProjectDirName = (path: string) => path.replace(/[^A-Za-z0-9]/g, '-');
const within = (child: string, parent: string) => {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};
const nativeOf = (identity: VerifiedSessionIdentity) => {
  const [native, agent, extra] = identity.sessionId.split(':');
  if (identity.product !== 'claude_code' || !native || !uuidPattern.test(native) || extra !== undefined || (agent !== undefined && !agentPattern.test(agent)))
    fail('claude_identity_invalid');
  const mapping = identity.nativeMapping;
  if (mapping && (mapping.nativeSessionId !== native || mapping.agentId !== (agent ?? null))) fail('claude_identity_invalid');
  return { native: native!, agent: agent ?? null };
};
/** Provider-specific causes collapse onto the shared gap vocabulary. */
const sharedGap: Record<string, string> = {
  source_replaced: 'source_changed',
  source_truncated: 'source_changed',
  source_missing: 'source_unavailable',
  source_error: 'source_unavailable',
  invalid_line: 'binding_usage_incomplete',
  oversized_line_skipped: 'binding_usage_incomplete',
  foreign_session_row: 'binding_usage_incomplete',
  ownership_unverified: 'binding_ancestry_unverified',
  usage_missing: 'missing_usage',
  usage_incomplete: 'missing_usage',
  request_id_missing: 'missing_usage',
  request_conflict: 'incomplete_request',
  unsupported_version: 'unsupported_history',
  compaction_usage_unverified: 'binding_usage_incomplete',
  cache_write_1h_observed: 'binding_partial_usage',
  server_tool_use_unpriced: 'binding_partial_usage',
  child_relation_unverified: 'binding_ancestry_unverified',
  child_receipt_mismatch: 'binding_ancestry_unverified',
  child_receipt_invalid: 'binding_ancestry_unverified',
  child_receipt_untrusted: 'binding_ancestry_unverified',
  child_source_mismatch: 'binding_ancestry_unverified',
  child_source_missing: 'source_unavailable',
  binding_unobserved_context: 'binding_unobserved_context'
};
const shared = (codes: Iterable<string>) => [...new Set([...codes].map(code => sharedGap[code] ?? 'binding_usage_incomplete'))].sort();

function readPrivateFile(path: string, limit: number, assertAuthorized?: () => void): string {
  let fd: number | undefined;
  try {
    assertAuthorized?.();
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    assertAuthorized?.();
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit || !isPrivate(stat)) fail('claude_receipt_untrusted');
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      assertAuthorized?.();
      const length = readSync(fd, buffer, offset, stat.size - offset, offset);
      if (!length) break;
      offset += length;
    }
    return buffer.subarray(0, offset).toString('utf8');
  } catch (error) {
    if (error instanceof Error && error.message === 'claude_receipt_untrusted') throw error;
    return fail('claude_receipt_missing');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
function assertPrivateDir(path: string) {
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch {
    return fail('claude_receipt_missing');
  }
  if (!stat.isDirectory() || !isPrivate(stat)) fail('claude_receipt_untrusted');
}
/** Owner's regular file at its canonical path; symlinks are refused. */
function checkedSourceFile(path: string): Stats {
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch {
    return fail('claude_source_missing');
  }
  if (!stat.isFile() || (stat.mode & 0o400) === 0 || (currentUid() !== null && stat.uid !== currentUid())) fail('claude_source_untrusted');
  try {
    if (realpathSync(path) !== path) fail('claude_source_untrusted');
  } catch {
    fail('claude_source_untrusted');
  }
  return stat;
}

interface RowMeta {
  type: unknown;
  sessionId: unknown;
  agentId: unknown;
  isSidechain: unknown;
  version: unknown;
  timestamp: unknown;
  subtype: unknown;
  requestId: unknown;
  message: { readonly id: unknown; model: unknown; readonly stopReason: unknown; usage: Record<string, unknown> | null } | null;
}
const NativeStopReasonSchema = z.enum(['end_turn', 'tool_use', 'max_tokens', 'stop_sequence', 'refusal', 'pause_turn']).nullable();
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
/** Retains metadata leaves only; the parsed line is dropped immediately. */
function rowMeta(line: string): RowMeta | null {
  let row: Record<string, unknown> | null;
  try {
    row = object(JSON.parse(line));
  } catch {
    return null;
  }
  if (!row) return null;
  const message = object(row.message);
  return {
    type: row.type,
    sessionId: row.sessionId,
    agentId: row.agentId,
    isSidechain: row.isSidechain,
    version: row.version,
    timestamp: row.timestamp,
    subtype: row.subtype,
    requestId: row.requestId,
    message: message ? { id: message.id, model: message.model, stopReason: message.stop_reason, usage: object(message.usage) } : null
  };
}
/** Own rows: root rows carry no agent marker; member rows carry exactly their agent ID. */
const ownRow = (row: RowMeta, native: string, agent: string | null) =>
  row.sessionId === native && (agent === null ? row.agentId === undefined && row.isSidechain !== true : row.agentId === agent);
const observed = (value: number): Reading => ({ status: 'observed', value, reason: null });
const token = (value: unknown): number | null => (TokenSchema.safeParse(value).success ? (value as number) : null);
const isoTimestamp = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  const normalized = new Date(time).toISOString();
  return TimestampSchema.safeParse(normalized).success ? normalized : null;
};
interface Line {
  start: number;
  end: number;
  text: string;
}
interface ReadChunk {
  lines: Line[];
  end: number;
  size: number;
  stat: Stats;
  oversized: boolean;
  readonly scanLimited: boolean;
}
interface Pending {
  requestId: string;
  first: Pick<Line, 'start'>;
  record: BindingUsageRecord;
  fingerprint: string;
  conflict: boolean;
  readonly messageId: string | null;
  readonly finalized: boolean;
}

export class ClaudeSessionBindingProvider implements SessionBindingProvider {
  readonly product = 'claude_code' as const;
  readonly promotionAuthority?: PromotionBindingAuthority;
  readonly #pending = new Map<string, PromotionBindingProof>();
  readonly #promotionAttempt = new AsyncLocalStorage<ToolVersionPromotionAuthority | undefined>();
  readonly #options: Required<Omit<ClaudeBindingOptions, 'profiles' | 'authorizeSource' | 'memberEligible' | 'promotionAuthority'>> &
    Pick<ClaudeBindingOptions, 'authorizeSource' | 'memberEligible'> & { profiles: readonly ClaudeTranscriptProfile[] };
  constructor(options: ClaudeBindingOptions) {
    if (!isAbsolute(options.receiptDir) || !isAbsolute(options.claudeProjectsDir) || !isAbsolute(options.projectRoot)) fail('claude_binding_config_invalid');
    if (options.promotionAuthority) {
      this.promotionAuthority = options.promotionAuthority;
    }
    this.#options = {
      allowCandidateProfiles: false,
      ordinaryAdmission: false,
      productVersion: legacyProductVersion,
      profiles: claudeBindingProfiles,
      receiptMaxAgeMs: 600000,
      quiescenceMs: 30000,
      maxReadBytes: 8 * 1048576,
      maxFamilyMembers: 32,
      readProcessIdentity: processIdentity,
      readProcessBinary: readClaudeProcessBinary,
      now: Date.now,
      ...options
    };
    if (
      this.#options.ordinaryAdmission &&
      !getEffectiveClaudeBindingAdmission(this.#options.productVersion, 'collect', this.#options.maxFamilyMembers === 1 ? 'root' : 'bounded_family')?.admitted
    ) {
      fail('claude_source_version_unsupported');
    }
    if (!Number.isSafeInteger(this.#options.maxFamilyMembers) || this.#options.maxFamilyMembers < 1 || this.#options.maxFamilyMembers > 32) {
      fail('claude_binding_config_invalid');
    }
  }

  capabilities(): BindingCapabilities {
    const qualified = this.#options.profiles.some(profile => profile.status === 'qualified');
    const admission = getEffectiveClaudeBindingAdmission(
      this.#options.productVersion,
      'collect',
      this.#options.maxFamilyMembers === 1 ? 'root' : 'bounded_family'
    );
    // A qualified transcript profile is not an ordinary production admission; the service decides that.
    return {
      currentIdentity: 'native_hook',
      ancestry: admission?.kind === 'promoted' && this.#options.maxFamilyMembers === 1 ? 'unavailable' : 'verified_relations',
      usage: 'own_requests',
      productionSupported: this.#options.ordinaryAdmission && admission?.admitted === true && (admission.kind === 'legacy' || admission.qualified),
      // Members are verified relations of the root; nested direct parents are not claimed.
      maxDepth: admission?.kind === 'promoted' ? admission.maxDepth : 1,
      reasons: [
        'claude_skill_hooks_required_per_session',
        'claude_family_flattened_direct_parent_unverified',
        'claude_receipts_local_trust',
        ...(qualified ? [] : ['claude_transcript_profile_unqualified'])
      ]
    };
  }

  /** Version support is decided from native transcript rows against exact profiles. */
  supportedVersion(version: unknown): boolean {
    if (this.#options.ordinaryAdmission) {
      return (
        version === this.#options.productVersion &&
        getEffectiveClaudeBindingAdmission(this.#options.productVersion, 'collect', this.#options.maxFamilyMembers === 1 ? 'root' : 'bounded_family') !==
          undefined
      );
    }
    const profile = this.#options.profiles.find(p => p.version === version);
    // Transcript qualification cannot bypass the separately approved pilot authority.
    return profile !== undefined && this.#options.allowCandidateProfiles;
  }

  #usesTerminalFinality(version: string, agent: string | null): boolean {
    return (
      (getEffectiveClaudeBindingAdmission(version, 'collect', agent === null && this.#options.maxFamilyMembers === 1 ? 'root' : 'bounded_family')
        ?.finalityVariant ?? lookupToolVersionProfile('claude_code', version)?.transcriptProfile?.finalityVariant) === 'claude_terminal_message_v1'
    );
  }
  #assertEffectiveAdmission(operation: 'link' | 'collect' | 'restart', child = false): void {
    this.#assertPromotion(undefined, operation, child);
    if (!this.#options.ordinaryAdmission) return;
    const admission = getEffectiveClaudeBindingAdmission(
      this.#options.productVersion,
      operation,
      child || (operation === 'collect' && this.#options.maxFamilyMembers > 1) ? 'bounded_family' : 'root'
    );
    if (!admission || (operation === 'collect' && admission.kind === 'promoted' && this.#options.maxFamilyMembers > admission.maxFamilyMembers)) {
      fail('claude_source_version_unsupported');
    }
  }

  #isPromoted(): boolean {
    return (
      this.promotionAuthority !== undefined ||
      getEffectiveClaudeBindingAdmission(this.#options.productVersion, 'collect', this.#options.maxFamilyMembers === 1 ? 'root' : 'bounded_family')?.kind ===
        'promoted'
    );
  }

  #assertPromotion(native?: string, operation: 'link' | 'collect' | 'restart' = 'collect', child = false): ToolVersionPromotionAuthority | undefined {
    if (!this.#isPromoted()) return undefined;
    const authority = this.promotionAuthority;
    if (!authority) return fail('promoted_provider_unavailable');
    const { key } = authority;
    const topology = this.#options.maxFamilyMembers === 1 ? 'root' : 'bounded_family';
    if (
      authority.producerContract !== 'promoted-payload-v1' ||
      !authority.grants.includes('admission') ||
      key.product !== this.product ||
      key.productVersion !== this.#options.productVersion ||
      key.source !== 'claude_binding' ||
      key.operation !== 'collect' ||
      key.topology !== topology ||
      key.platform !== `${process.platform}_${process.arch}` ||
      key.runtime !== `node${process.versions.node.split('.')[0]}` ||
      (child && (topology === 'root' || !authority.grants.includes('children')))
    ) {
      return fail('promoted_provider_unavailable');
    }
    const state = authority.assertAuthorized(native, operation);
    if (state.state !== 'allowed') return fail('promotion_denied');
    const expected = this.#promotionAttempt.getStore();
    if (expected && (state.generation !== expected.generation || state.projectionDigest !== expected.projectionDigest)) {
      return fail('promotion_authority_changed');
    }
    const facet = lookupEffectiveToolVersionFacet(key.product, key.productVersion, key.operation, key.topology, key.platform, key.runtime);
    if (!facet) return fail('claude_source_version_unsupported');
    if (
      facet.descriptor.profileId !== key.profileId ||
      facet.descriptor.sourceRef !== key.descriptorLineage ||
      authority.grants.some(grant => !facet.decision.grants.includes(grant))
    ) {
      return fail('promoted_provider_unavailable');
    }
    return state;
  }

  #assertUnchanged(before: ToolVersionPromotionAuthority | undefined, native?: string, operation: 'link' | 'collect' | 'restart' = 'collect'): void {
    const after = this.#assertPromotion(native, operation);
    if (before && (!after || before.generation !== after.generation || before.projectionDigest !== after.projectionDigest)) {
      fail('promotion_authority_changed');
    }
  }

  pendingPromotionReceipt(input: CurrentIdentityRequest): PromotionPendingReceipt {
    const before = this.#assertPromotion();
    return this.#promotionAttempt.run(before, () => {
      if (!uuidPattern.test(input.receipt)) {
        return fail('claude_receipt_invalid');
      }
      assertPrivateDir(this.#options.receiptDir);
      const receipt = PromotionPendingReceiptSchema.parse(
        JSON.parse(readPrivateFile(join(this.#options.receiptDir, `${input.receipt}.json`), 16384, () => this.#assertPromotion()))
      );
      if (receipt.receipt !== input.receipt) {
        return fail('claude_receipt_invalid');
      }
      return this.#validatePending(receipt);
    });
  }

  #validatePending(input: PromotionPendingReceipt): PromotionPendingReceipt {
    const receipt = PromotionPendingReceiptSchema.parse(input);
    this.#assertPromotion(receipt.nativeRootSessionId, 'collect', receipt.agentId !== null);
    if (
      !this.#isPromoted() ||
      receipt.product !== this.product ||
      receipt.productVersion !== this.#options.productVersion ||
      receipt.nativeSessionId !== receipt.nativeRootSessionId ||
      !uuidPattern.test(receipt.nativeSessionId) ||
      (receipt.agentId !== null && !agentPattern.test(receipt.agentId)) ||
      (receipt.event === 'connect' ? receipt.agentId !== null : receipt.agentId === null) ||
      receipt.sourceRef === null ||
      !isAbsolute(receipt.sourceRef) ||
      receipt.processIdHint === null
    ) {
      return fail('claude_receipt_invalid');
    }
    const age = this.#options.now() - Date.parse(receipt.recordedAt);
    if (age < -5000 || age > this.#options.receiptMaxAgeMs) {
      return fail('claude_receipt_expired');
    }
    return receipt;
  }

  async receivePending(input: PromotionPendingReceipt): Promise<PromotionBindingProof> {
    const before = this.#assertPromotion();
    return this.#promotionAttempt.run(before, async () => {
      const result = await settle(() => {
        const receipt = this.#validatePending(input);
        if (receipt.sourceRef === null || receipt.processIdHint === null) {
          return fail('claude_receipt_invalid');
        }
        const identity = this.#verifyNative({
          native: receipt.nativeSessionId,
          agent: receipt.agentId,
          sourceRef: receipt.sourceRef,
          cwd: receipt.cwd,
          pid: receipt.processIdHint,
          recordedAt: Date.parse(receipt.recordedAt)
        });
        const processId = identity.nativeMapping?.processId;
        if (!processId) return fail('claude_process_unobserved');
        return {
          identity,
          proof: {
            receipt: receipt.receipt,
            recordedAt: receipt.recordedAt,
            nativeSessionId: receipt.nativeSessionId,
            agentId: receipt.agentId,
            sourceRef: identity.sourceRef,
            sourceIdentity: identity.sourceIdentity,
            cwd: identity.cwd,
            processId,
            productVersion: identity.productVersion
          }
        };
      });
      this.#assertUnchanged(before, result.proof.nativeSessionId);
      this.#pending.set(result.identity.sessionId, result);
      return result;
    });
  }

  async #resolvePending(input: CurrentIdentityRequest, expected?: VerifiedSessionIdentity): Promise<PromotionBindingProof> {
    const operation = expected ? 'restart' : 'link';
    const before = this.#assertPromotion(undefined, operation);
    return this.#promotionAttempt.run(before, async () => {
      const receipt = this.pendingPromotionReceipt(input);
      const result = await this.receivePending(receipt);
      this.#assertUnchanged(before, receipt.nativeRootSessionId, operation);
      if (expected && bindingIdentityKey(expected) !== bindingIdentityKey(result.identity)) return fail('claude_bound_identity_changed');
      return result;
    });
  }

  #assertPendingIdentity(identity: VerifiedSessionIdentity): void {
    this.#assertPromotion(identity.nativeMapping?.nativeSessionId, 'collect', identity.parentSessionId !== null);
    const provenance = this.#pending.get(identity.sessionId);
    if (this.#isPromoted() && (!provenance || bindingIdentityKey(provenance.identity) !== bindingIdentityKey(identity))) {
      fail('claude_bound_identity_changed');
    }
  }

  /** Metadata-only pilot scope check before receipt or transcript access. */
  assertProjectRoot(projectRoot: string): void {
    if (projectRoot !== this.#options.projectRoot) fail('binding_pilot_scope_invalid');
  }
  revalidateBound(input: CurrentIdentityRequest, expected: VerifiedSessionIdentity): Promise<VerifiedSessionIdentity> {
    if (this.#isPromoted()) {
      return this.#resolvePending(input, expected).then(result => result.identity);
    }
    return settle(() => this.#resolve(input, expected));
  }
  resolveCurrent(input: CurrentIdentityRequest): Promise<VerifiedSessionIdentity> {
    if (this.#isPromoted()) {
      return this.#resolvePending(input).then(result => result.identity);
    }
    return settle(() => this.#resolve(input));
  }
  inspectCurrent(input: CurrentIdentityRequest): Promise<NativeConnectionProof> {
    if (this.#isPromoted()) {
      return settle(() => {
        const before = this.#assertPromotion(undefined, 'link');
        return this.#promotionAttempt.run(before, () => {
          const receipt = this.pendingPromotionReceipt(input);
          if (receipt.agentId !== null || receipt.sourceRef === null || receipt.processIdHint === null) return fail('binding_child_requires_root');
          const processId = this.#currentProcessProof(receipt.processIdHint);
          this.#assertProjectScope(receipt.sourceRef, receipt.cwd);
          const stat = this.#rootStat(receipt.sourceRef, receipt.nativeSessionId);
          this.#assertUnchanged(before, receipt.nativeRootSessionId, 'link');
          return {
            receipt: receipt.receipt,
            recordedAt: receipt.recordedAt,
            nativeSessionId: receipt.nativeSessionId,
            agentId: null,
            sourceRef: receipt.sourceRef,
            sourceIdentity: this.#sourceIdentity(stat, receipt.nativeSessionId),
            cwd: this.#options.projectRoot,
            processId,
            productVersion: this.#options.productVersion
          };
        });
      });
    }
    return settle(() => {
      this.#assertEffectiveAdmission('link');
      this.#assertEffectiveAdmission('collect');
      if (!uuidPattern.test(input.receipt)) {
        return fail('claude_receipt_invalid');
      }
      assertPrivateDir(this.#options.receiptDir);
      assertPrivateDir(join(this.#options.receiptDir, 'connect'));
      const receipt = this.#receipt(join(this.#options.receiptDir, 'connect', `${input.receipt}.json`));
      const age = this.#options.now() - Date.parse(receipt.recorded_at);
      if (receipt.kind !== 'connect' || receipt.receipt_id !== input.receipt || age < -5000 || age > this.#options.receiptMaxAgeMs) {
        return fail('claude_receipt_expired');
      }
      if (receipt.agent_id !== null) {
        return fail('binding_child_requires_root');
      }
      if (this.#forgotten(receipt.session_id)) {
        return fail('deleted_identifier');
      }
      const processId = this.#currentProcessProof(receipt.claude_pid);
      this.#assertProjectScope(receipt.transcript_path, receipt.cwd);
      const stat = this.#rootStat(receipt.transcript_path, receipt.session_id);
      const binary = this.#options.readProcessBinary(receipt.claude_pid);
      const admission = getEffectiveClaudeBindingAdmission(this.#options.productVersion, 'link');
      if (!admission || binary.productVersion !== admission.productVersion || binary.sha256 !== admission.binarySha256) {
        return fail('claude_binary_unqualified');
      }
      return {
        receipt: receipt.receipt_id,
        recordedAt: receipt.recorded_at,
        nativeSessionId: receipt.session_id,
        agentId: null,
        sourceRef: receipt.transcript_path,
        sourceIdentity: this.#sourceIdentity(stat, receipt.session_id),
        cwd: this.#options.projectRoot,
        processId,
        productVersion: binary.productVersion
      };
    });
  }
  discoverChildren(parent: VerifiedSessionIdentity): Promise<ChildDiscovery> {
    if (this.#isPromoted()) return this.#discoverPending(parent);
    return settle(() => this.#discover(parent));
  }
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
    if (this.#isPromoted()) {
      return this.#pendingUsage(session, cursor, scope, boundary);
    }
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
      const names = (() => {
        try {
          return readdirSync(connectDir);
        } catch {
          return [];
        }
      })();
      for (const name of names) {
        if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
        const sessionId = (() => {
          try {
            return this.#receipt(join(connectDir, name)).session_id;
          } catch {
            return null;
          }
        })();
        if (sessionId === nativeSessionId) rmSync(join(connectDir, name), { force: true });
      }
    });
  }

  #forgotten(native: string) {
    try {
      lstatSync(join(this.#options.receiptDir, 'forgotten', native));
      return true;
    } catch {
      return false;
    }
  }
  #receipt(path: string): Receipt {
    const parsed = (() => {
      try {
        return ReceiptSchema.safeParse(JSON.parse(readPrivateFile(path, 16384)));
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('claude_receipt_')) throw error;
        return fail('claude_receipt_invalid');
      }
    })();
    if (!parsed.success) fail('claude_receipt_invalid');
    const receipt = parsed.data!;
    if (receipt.uid !== currentUid()) fail('claude_receipt_untrusted');
    return receipt;
  }
  #projectsRoot(): string {
    this.#assertPromotion();
    try {
      return realpathSync(this.#options.claudeProjectsDir);
    } catch {
      return fail('claude_source_missing');
    }
  }
  /** <projects>/<encoded project>/<session>.jsonl or <projects>/<encoded project>/<session>/subagents/agent-<id>.jsonl */
  #memberPathValid(ref: string, native: string, agent: string | null): boolean {
    const projects = this.#projectsRoot();
    if (agent === null) return basename(ref) === `${native}.jsonl` && dirname(dirname(ref)) === projects;
    const projectDir = dirname(dirname(dirname(ref)));
    return ref === join(projectDir, native, 'subagents', `agent-${agent}.jsonl`) && dirname(projectDir) === projects;
  }
  #childPath(rootPath: string, native: string, agent: string) {
    return join(dirname(rootPath), native, 'subagents', `agent-${agent}.jsonl`);
  }
  /** Scope before content: the transcript must live in the registered project's native
   * directory and the hook cwd must be inside the project. No transcript byte is read. */
  #assertProjectScope(rootPath: string, hookCwd: string) {
    this.#assertPromotion();
    let root: string;
    let cwd: string;
    try {
      root = realpathSync(this.#options.projectRoot);
      cwd = realpathSync(hookCwd);
    } catch {
      return fail('claude_project_mismatch');
    }
    const name = basename(dirname(rootPath));
    if (![root, this.#options.projectRoot].some(path => claudeProjectDirName(path) === name) || !within(cwd, root)) fail('claude_project_mismatch');
  }
  #sourceIdentity(stat: Stats, sessionId: string) {
    return sha(['claude-transcript-v2', stat.dev, stat.ino, stat.birthtimeMs, sessionId]);
  }

  #currentProcessProof(pid: number): string {
    this.#assertPromotion();
    this.#assertEffectiveAdmission('collect');
    try {
      process.kill(pid, 0);
    } catch (error) {
      fail((error as NodeJS.ErrnoException).code === 'EPERM' ? 'claude_receipt_untrusted' : 'claude_process_absent');
    }
    const identity = this.#options.readProcessIdentity(pid);
    this.#assertPromotion();
    if (this.#options.ordinaryAdmission || this.#isPromoted()) {
      const binary = this.#options.readProcessBinary(pid);
      this.#assertPromotion();
      const admission = getEffectiveClaudeBindingAdmission(
        this.#options.productVersion,
        'collect',
        this.#options.maxFamilyMembers === 1 ? 'root' : 'bounded_family'
      );
      if (!admission || binary.productVersion !== admission.productVersion || binary.sha256 !== admission.binarySha256) {
        return fail('claude_binary_unqualified');
      }
    }
    return `claude-process:${pid}:${sha([pid, identity])}`;
  }
  /** Durable root proof is sufficient after restart, without searching receipt directories. */
  #assertBoundProcess(proof: string | null | undefined): void {
    const match = typeof proof === 'string' ? /^claude-process:([1-9][0-9]{0,9}):[a-f0-9]{64}$/.exec(proof) : null;
    if (!match || this.#currentProcessProof(Number(match[1])) !== proof) fail('claude_bound_identity_changed');
  }
  #authorize(path: string, stat: Stats, native: string, agent: string | null) {
    this.#assertPromotion(native, 'collect', agent !== null);
    this.#options.authorizeSource?.({
      nativeSessionId: native,
      agentId: agent,
      sourceRef: path,
      sourceIdentity: this.#sourceIdentity(stat, agent === null ? native : `${native}:${agent}`),
      birthtimeMs: stat.birthtimeMs
    });
    this.#assertPromotion(native, 'collect', agent !== null);
  }
  #readLines(
    path: string,
    offset: number,
    limit: number,
    native: string,
    agent: string | null,
    expectedSourceIdentity: string,
    processProof: string | null | undefined,
    scanEnd = Number.POSITIVE_INFINITY
  ): ReadChunk {
    this.#assertPromotion(native, 'collect', agent !== null);
    this.#assertEffectiveAdmission('collect', agent !== null);
    const stat = checkedSourceFile(path);
    const sessionId = agent === null ? native : `${native}:${agent}`;
    if (this.#sourceIdentity(stat, sessionId) !== expectedSourceIdentity) {
      fail('claude_source_replaced');
    }
    this.#assertBoundProcess(processProof);
    this.#authorize(path, stat, native, agent);
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      this.#assertPromotion(native, 'collect', agent !== null);
      const opened = fstatSync(fd);
      this.#assertPromotion(native, 'collect', agent !== null);
      if (this.#sourceIdentity(opened, sessionId) !== expectedSourceIdentity || opened.uid !== stat.uid || opened.mode !== stat.mode) {
        fail('claude_source_untrusted');
      }
      const none: ReadChunk = {
        lines: [],
        end: offset,
        size: opened.size,
        stat: opened,
        oversized: false,
        scanLimited: false
      };
      if (opened.size <= offset) return none;
      const length = Math.min(limit, opened.size - offset, Math.max(0, scanEnd - offset));
      if (!length) return { ...none, scanLimited: scanEnd < opened.size };
      const buffer = Buffer.alloc(length);
      let read = 0;
      while (read < length) {
        this.#assertPromotion(native, 'collect', agent !== null);
        const n = readSync(fd, buffer, read, length - read, offset + read);
        if (!n) break;
        read += n;
      }
      const last = buffer.subarray(0, read).lastIndexOf(0x0a);
      if (last < 0) {
        if (read < limit) {
          return {
            ...none,
            scanLimited: offset + read >= scanEnd && scanEnd < opened.size
          };
        }
        // A single line larger than the read window is skipped without parsing.
        let probe = offset + read;
        const chunk = Buffer.alloc(65536);
        const probeEnd = Math.min(opened.size, scanEnd);
        while (probe < probeEnd) {
          const current = checkedSourceFile(path);
          if (this.#sourceIdentity(current, sessionId) !== expectedSourceIdentity) fail('claude_source_replaced');
          const descriptor = fstatSync(fd);
          if (this.#sourceIdentity(descriptor, sessionId) !== expectedSourceIdentity || descriptor.uid !== current.uid || descriptor.mode !== current.mode) {
            fail('claude_source_untrusted');
          }
          this.#assertBoundProcess(processProof);
          this.#authorize(path, current, native, agent);
          const n = readSync(fd, chunk, 0, Math.min(chunk.length, probeEnd - probe), probe);
          if (!n) return none;
          const index = chunk.subarray(0, n).indexOf(0x0a);
          if (index >= 0) {
            return {
              ...none,
              end: probe + index + 1,
              oversized: true
            };
          }
          probe += n;
        }
        return { ...none, scanLimited: probeEnd < opened.size };
      }
      const lines: Line[] = [];
      let start = 0;
      while (start <= last) {
        const newline = buffer.indexOf(0x0a, start);
        if (newline > start) {
          lines.push({
            start: offset + start,
            end: offset + newline + 1,
            text: buffer.subarray(start, newline).toString('utf8')
          });
        }
        start = newline + 1;
      }
      return {
        lines,
        end: offset + last + 1,
        size: opened.size,
        stat: opened,
        oversized: false,
        scanLimited: false
      };
    } finally {
      closeSync(fd);
    }
  }
  /** First own row's timestamp and version, scanning bounded windows from the start. */
  #firstOwnRow(
    path: string,
    native: string,
    agent: string | null,
    sourceIdentity: string,
    processProof: string | null | undefined
  ): { createdAt: string | null; version: string | null; scanned: number } {
    let createdAt: string | null = null;
    let offset = 0;
    let scanned = 0;
    while (offset < metadataScanLimit) {
      const chunk = this.#readLines(path, offset, metadataWindow, native, agent, sourceIdentity, processProof, metadataScanLimit);
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
  #identity(
    native: string,
    agent: string | null,
    rootPath: string,
    sourcePath: string,
    stat: Stats,
    version: string,
    createdAt: string,
    agentType?: unknown,
    processId: string | null = null
  ): VerifiedSessionIdentity {
    const agentMetadata = claudeAgentMetadata(agentType);
    const sessionId = agent === null ? native : `${native}:${agent}`;
    // Stable per member: repeated connects and rediscovery yield byte-identical identities.
    const evidence = agent === null ? `claude-session:${sha([native, rootPath])}` : `claude-agent:${sha([native, agent, rootPath])}`;
    return {
      ...(agentMetadata ? { agentMetadata } : {}),
      product: 'claude_code',
      productVersion: version,
      sessionId,
      sourceRef: sourcePath,
      sourceIdentity: this.#sourceIdentity(stat, sessionId),
      cwd: this.#options.projectRoot,
      identityEvidenceId: evidence,
      parentSessionId: agent === null ? null : native,
      createdAt,
      nativeMapping: { nativeSessionId: native, processId, agentId: agent }
    };
  }
  #rootStat(rootPath: string, native: string): Stats {
    this.#assertPromotion(native);
    if (!this.#memberPathValid(rootPath, native, null)) fail('claude_source_untrusted');
    return checkedSourceFile(rootPath);
  }

  #resolve(input: CurrentIdentityRequest, expected?: VerifiedSessionIdentity): VerifiedSessionIdentity {
    this.#assertEffectiveAdmission(expected ? 'restart' : 'link');
    this.#assertEffectiveAdmission('collect');
    const receiptId = typeof input?.receipt === 'string' && uuidPattern.test(input.receipt) ? input.receipt : fail('claude_receipt_invalid');
    assertPrivateDir(this.#options.receiptDir);
    assertPrivateDir(join(this.#options.receiptDir, 'connect'));
    const receipt = this.#receipt(join(this.#options.receiptDir, 'connect', `${receiptId}.json`));
    this.#assertEffectiveAdmission(expected ? 'restart' : 'link', receipt.agent_id !== null);
    const recordedAt = Date.parse(receipt.recorded_at);
    const age = this.#options.now() - recordedAt;
    if (receipt.kind !== 'connect' || receipt.receipt_id !== receiptId || age < -5000 || (!expected && age > this.#options.receiptMaxAgeMs)) {
      fail('claude_receipt_expired');
    }
    return this.#verifyNative(
      {
        native: receipt.session_id,
        agent: receipt.agent_id,
        sourceRef: receipt.transcript_path,
        cwd: receipt.cwd,
        pid: receipt.claude_pid,
        recordedAt,
        agentType: receipt.agent_type
      },
      expected
    );
  }

  #verifyNative(
    metadata: {
      readonly native: string;
      readonly agent: string | null;
      readonly sourceRef: string;
      readonly cwd: string;
      readonly pid: number;
      readonly recordedAt: number;
      readonly agentType?: unknown;
    },
    expected?: VerifiedSessionIdentity
  ): VerifiedSessionIdentity {
    this.#assertPromotion(metadata.native, expected ? 'restart' : 'collect', metadata.agent !== null);
    if (
      expected &&
      (expected.product !== 'claude_code' ||
        expected.parentSessionId !== null ||
        metadata.agent !== null ||
        expected.sessionId !== metadata.native ||
        expected.nativeMapping?.nativeSessionId !== metadata.native ||
        expected.nativeMapping.agentId !== null ||
        expected.cwd !== this.#options.projectRoot ||
        expected.sourceRef !== metadata.sourceRef)
    ) {
      fail('claude_bound_identity_changed');
    }
    if (this.#forgotten(metadata.native)) fail('deleted_identifier');
    const processId = this.#currentProcessProof(metadata.pid);
    if (expected && expected.nativeMapping?.processId !== processId) {
      fail('claude_bound_identity_changed');
    }
    // Inside a subagent the hook transcript may be the root or the member file; derive the root.
    const native = metadata.native;
    const rootPath =
      metadata.agent !== null && metadata.sourceRef.endsWith(join(native, 'subagents', `agent-${metadata.agent}.jsonl`))
        ? join(dirname(dirname(dirname(metadata.sourceRef))), `${native}.jsonl`)
        : metadata.sourceRef;
    if (!this.#memberPathValid(rootPath, native, null)) {
      fail('claude_source_untrusted');
    }
    this.#assertProjectScope(rootPath, metadata.cwd);
    const rootStat = this.#rootStat(rootPath, native);
    if (expected) {
      if (this.#sourceIdentity(rootStat, native) !== expected.sourceIdentity) fail('claude_bound_identity_changed');
      const identity = this.#identity(native, null, rootPath, rootPath, rootStat, expected.productVersion, expected.createdAt, metadata.agentType, processId);
      if (bindingIdentityKey(identity) !== bindingIdentityKey(expected)) {
        fail('claude_bound_identity_changed');
      }
      if (!this.supportedVersion(identity.productVersion)) {
        fail('claude_source_version_unsupported');
      }
      this.#authorize(rootPath, rootStat, native, null);
      return identity;
    }
    // A connecting session has just written its transcript; a stale file is not current.
    if (rootStat.mtimeMs < metadata.recordedAt - this.#options.receiptMaxAgeMs) {
      fail('claude_source_stale');
    }
    const root = this.#firstOwnRow(rootPath, native, null, this.#sourceIdentity(rootStat, native), processId);
    if (root.version === null || root.createdAt === null) {
      fail('claude_source_version_unobserved');
    }
    if (!this.supportedVersion(root.version)) {
      fail('claude_source_version_unsupported');
    }
    if (metadata.agent === null) {
      const identity = this.#identity(native, null, rootPath, rootPath, rootStat, root.version!, root.createdAt!, metadata.agentType, processId);
      return identity;
    }
    // A re-invocation inside a subagent resolves to that member, never a new root.
    const childPath = this.#childPath(rootPath, native, metadata.agent);
    const childStat = (() => {
      try {
        return checkedSourceFile(childPath);
      } catch {
        return fail('claude_child_source_unavailable');
      }
    })();
    const child = this.#firstOwnRow(childPath, native, metadata.agent, this.#sourceIdentity(childStat, `${native}:${metadata.agent}`), processId);
    if (child.createdAt === null) fail('claude_child_source_unavailable');
    return this.#identity(
      native,
      metadata.agent,
      rootPath,
      childPath,
      childStat,
      root.version!,
      child.createdAt!,
      metadata.agentType,
      this.#isPromoted() ? processId : null
    );
  }

  async #pendingUsage(session: VerifiedSessionIdentity, cursor: string | null, scope: CandidateScope, boundary?: BindingReadBoundary): Promise<UsageBatch> {
    this.#assertPendingIdentity(session);
    const before = this.#assertPromotion(session.nativeMapping?.nativeSessionId);
    return this.#promotionAttempt.run(before, async () => {
      const result = await settle(() => this.#usage(session, cursor, scope, boundary?.baseline === true, boundary?.baselineLedger));
      this.#assertUnchanged(before, session.nativeMapping?.nativeSessionId);
      return result;
    });
  }

  async #discoverPending(parent: VerifiedSessionIdentity): Promise<ChildDiscovery> {
    this.#assertPendingIdentity(parent);
    const { native, agent } = nativeOf(parent);
    const before = this.#assertPromotion(native);
    return this.#promotionAttempt.run(before, async () => {
      if (agent !== null || this.#options.maxFamilyMembers === 1) {
        return { children: [], gaps: [] };
      }
      this.#assertPromotion(native, 'collect', true);
      this.#assertBoundProcess(parent.nativeMapping?.processId);
      this.#assertProjectScope(parent.sourceRef, parent.cwd);
      const rootStat = this.#rootStat(parent.sourceRef, native);
      if (this.#sourceIdentity(rootStat, native) !== parent.sourceIdentity) {
        return fail('claude_source_replaced');
      }
      assertPrivateDir(this.#options.receiptDir);
      const members = new Map<string, PromotionPendingReceipt>();
      for (const name of readdirSync(this.#options.receiptDir).sort()) {
        if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
        this.#assertPromotion(native, 'collect', true);
        const receipt = this.pendingPromotionReceipt({
          receipt: name.slice(0, -5)
        });
        if (receipt.nativeRootSessionId !== native || receipt.agentId === null) continue;
        if (receipt.processIdHint !== Number(parent.nativeMapping?.processId?.split(':')[1])) return fail('claude_bound_identity_changed');
        if (receipt.sourceRef !== parent.sourceRef && receipt.sourceRef !== this.#childPath(parent.sourceRef, native, receipt.agentId)) {
          return fail('claude_source_untrusted');
        }
        const previous = members.get(receipt.agentId);
        if (!previous || receipt.recordedAt > previous.recordedAt) {
          members.set(receipt.agentId, receipt);
        }
      }
      if (members.size >= this.#options.maxFamilyMembers) {
        return fail('claude_family_scope_limit');
      }
      const children: ChildDiscovery['children'] = [];
      const gaps: string[] = [];
      for (const receipt of members.values()) {
        this.#assertPromotion(native, 'collect', true);
        const childPath = this.#childPath(parent.sourceRef, native, receipt.agentId!);
        const stat = checkedSourceFile(childPath);
        if (
          !this.#options.memberEligible?.({
            nativeSessionId: native,
            agentId: receipt.agentId!,
            sourceRef: childPath,
            sourceIdentity: this.#sourceIdentity(stat, `${native}:${receipt.agentId}`),
            birthtimeMs: stat.birthtimeMs,
            recordedAt: receipt.recordedAt,
            processId: parent.nativeMapping?.processId ?? ''
          })
        ) {
          gaps.push('binding_unobserved_context');
          continue;
        }
        this.#assertPromotion(native, 'collect', true);
        const result = await this.receivePending(receipt);
        this.#assertUnchanged(before, native);
        children.push({
          parentSessionId: native,
          relationEvidenceId: result.identity.identityEvidenceId,
          identity: result.identity
        });
      }
      this.#assertUnchanged(before, native);
      return { children, gaps };
    });
  }

  #familyDiscoveryEnabled(parent: VerifiedSessionIdentity): boolean {
    this.#assertEffectiveAdmission('collect');
    const admission = getEffectiveClaudeBindingAdmission(
      this.#options.productVersion,
      'collect',
      this.#options.maxFamilyMembers === 1 ? 'root' : 'bounded_family'
    );
    if (
      this.#options.ordinaryAdmission &&
      admission?.kind === 'promoted' &&
      (this.#options.maxFamilyMembers === 1 || !getEffectiveClaudeBindingAdmission(this.#options.productVersion, 'collect', 'bounded_family'))
    ) {
      return false;
    }
    this.#assertEffectiveAdmission('collect', true);
    const { native, agent } = nativeOf(parent);
    return agent === null && parent.parentSessionId === null && !this.#forgotten(native);
  }

  #discover(parent: VerifiedSessionIdentity): ChildDiscovery {
    const { native } = nativeOf(parent);
    // Claude members are discovered from the root's own receipts and layout only.
    if (!this.#familyDiscoveryEnabled(parent)) return { children: [], gaps: [] };
    this.#assertBoundProcess(parent.nativeMapping?.processId);
    this.#assertProjectScope(parent.sourceRef, parent.cwd);
    const rootStat = this.#rootStat(parent.sourceRef, native);
    if (this.#sourceIdentity(rootStat, native) !== parent.sourceIdentity)
      return familyDiscovery({ children: [], gaps: shared(['source_replaced']) }, ['source_replaced']);
    const gaps: string[] = [];
    let names: string[] = [];
    try {
      assertPrivateDir(join(this.#options.receiptDir, 'sessions', native, 'agents'));
      names = readdirSync(join(this.#options.receiptDir, 'sessions', native, 'agents'));
    } catch (error) {
      if (error instanceof Error && error.message === 'claude_receipt_untrusted') gaps.push('child_receipt_untrusted');
    }
    const receipts = new Map<string, Receipt[]>();
    for (const name of names) {
      const matched = /^([A-Za-z0-9_-]{1,91})\.(subagent_start|subagent_stop)\.json$/.exec(name);
      if (!matched) continue;
      let receipt: Receipt;
      try {
        receipt = this.#receipt(join(this.#options.receiptDir, 'sessions', native, 'agents', name));
      } catch {
        gaps.push('child_receipt_invalid');
        continue;
      }
      // Relation proof: same native session and the root transcript this parent was bound with.
      if (receipt.agent_id !== matched[1] || receipt.kind !== matched[2] || receipt.session_id !== native || receipt.transcript_path !== parent.sourceRef) {
        gaps.push('child_receipt_mismatch');
        continue;
      }
      try {
        this.#assertProjectScope(parent.sourceRef, receipt.cwd);
      } catch {
        gaps.push('child_receipt_mismatch');
        continue;
      }
      receipts.set(receipt.agent_id, [...(receipts.get(receipt.agent_id) ?? []), receipt]);
    }
    let files: string[];
    try {
      files = readdirSync(join(dirname(parent.sourceRef), native, 'subagents'));
    } catch {
      files = [];
    }
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
        try {
          stat = checkedSourceFile(expected);
        } catch {
          continue;
        }
        if (
          !start ||
          !processId ||
          start.claude_pid !== rootPid ||
          !this.#options.memberEligible?.({
            nativeSessionId: native,
            agentId,
            sourceRef: expected,
            sourceIdentity: this.#sourceIdentity(stat, `${native}:${agentId}`),
            birthtimeMs: stat.birthtimeMs,
            recordedAt: start.recorded_at,
            processId
          })
        ) {
          excludedMembers.add(agentId);
          continue;
        }
        eligibleMembers++;
      }
      if (eligibleMembers >= this.#options.maxFamilyMembers) fail('claude_family_scope_limit');
    }
    const pending: number[] = [];
    const pendingStarts: Array<{ receiptId: string; agentId: string; recordedAt: string }> = [];
    const readinessWindowMs = this.#options.ordinaryAdmission ? 300000 : 2000;
    const waitForStart = (start: Receipt) => {
      pending.push(Date.parse(start.recorded_at) + readinessWindowMs);
      pendingStarts.push({ receiptId: start.receipt_id, agentId: start.agent_id!, recordedAt: start.recorded_at });
    };
    for (const [agentId, list] of [...receipts.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (excludedMembers.has(agentId)) continue;
      const expected = this.#childPath(parent.sourceRef, native, agentId);
      const stop = list.find(r => r.kind === 'subagent_stop');
      if (stop && stop.agent_transcript_path !== expected) {
        const real = (() => {
          try {
            return realpathSync(stop.agent_transcript_path!);
          } catch {
            return null;
          }
        })();
        if (real !== expected) {
          gaps.push('child_source_mismatch');
          continue;
        }
      }
      const start = list.find(receipt => receipt.kind === 'subagent_start');
      const startAt = start ? Date.parse(start.recorded_at) : NaN;
      const age = this.#options.now() - startAt;
      const rootPid = Number(parent.nativeMapping?.processId?.split(':')[1]);
      const canWait = !stop && !!start && start.claude_pid === rootPid && startAt >= Date.parse(parent.createdAt) && age >= 0 && age < readinessWindowMs;
      let stat: Stats;
      try {
        lstatSync(expected);
      } catch (error) {
        if (this.#options.ordinaryAdmission && start && !canWait && error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          gaps.push('binding_unobserved_context');
          continue;
        }
        if (canWait && (error as NodeJS.ErrnoException).code === 'ENOENT') waitForStart(start);
        gaps.push('child_source_missing');
        continue;
      }
      try {
        stat = checkedSourceFile(expected);
      } catch {
        gaps.push('child_source_missing');
        continue;
      }
      // A member file can appear after the first metadata pass.
      const processId = parent.nativeMapping?.processId;
      if (
        this.#options.ordinaryAdmission &&
        (!start ||
          !processId ||
          start.claude_pid !== rootPid ||
          !this.#options.memberEligible?.({
            nativeSessionId: native,
            agentId,
            sourceRef: expected,
            sourceIdentity: this.#sourceIdentity(stat, `${native}:${agentId}`),
            birthtimeMs: stat.birthtimeMs,
            recordedAt: start.recorded_at,
            processId
          }))
      ) {
        gaps.push('binding_unobserved_context');
        continue;
      }
      // A fresh Start may hold family measurement until an attributable own row exists.
      // Complete lines without that identity remain terminal, never silently dropped.
      const first = this.#firstOwnRow(expected, native, agentId, this.#sourceIdentity(stat, `${native}:${agentId}`), parent.nativeMapping?.processId);
      if (first.createdAt === null) {
        if (first.scanned > 0) gaps.push('ownership_unverified');
        else {
          gaps.push('child_source_missing');
          if (canWait) waitForStart(start);
        }
        continue;
      }
      const identity = this.#identity(
        native,
        agentId,
        parent.sourceRef,
        expected,
        stat,
        parent.productVersion,
        first.createdAt,
        (list.find(r => r.kind === 'subagent_start') ?? stop)?.agent_type
      );
      children.push({ parentSessionId: native, relationEvidenceId: identity.identityEvidenceId, identity });
    }
    // Native member files without a hook receipt (for example, spawned before connect or
    // while hooks were absent) are neither linked nor counted.
    for (const file of files) {
      const matched = /^agent-([A-Za-z0-9_-]{1,91})\.jsonl$/.exec(file);
      if (matched && !receipts.has(matched[1]!)) {
        if (!this.#options.ordinaryAdmission) {
          gaps.push('child_relation_unverified');
          continue;
        }
        const agentId = matched[1]!;
        const sourceRef = this.#childPath(parent.sourceRef, native, agentId);
        const stat = checkedSourceFile(sourceRef);
        const processId = parent.nativeMapping?.processId;
        if (!processId) return fail('claude_process_unobserved');
        const eligible = this.#options.memberEligible?.({
          nativeSessionId: native,
          agentId,
          sourceRef,
          sourceIdentity: this.#sourceIdentity(stat, `${native}:${agentId}`),
          birthtimeMs: stat.birthtimeMs,
          processId
        });
        if (!eligible) gaps.push('binding_unobserved_context');
      }
    }
    if (excludedMembers.size) gaps.push('binding_unobserved_context');
    return pending.length && pending.length === gaps.filter(gap => gap !== 'binding_unobserved_context').length
      ? pendingChildReadiness(familyDiscovery({ children, gaps: shared(gaps) }, gaps), Math.min(...pending), pendingStarts)
      : familyDiscovery({ children, gaps: shared(gaps) }, gaps);
  }

  #usage(
    session: VerifiedSessionIdentity,
    cursorText: string | null,
    scope: CandidateScope,
    baseline: boolean,
    baselineLedger?: BindingReadBoundary['baselineLedger']
  ): UsageBatch {
    this.#assertEffectiveAdmission('collect', session.parentSessionId !== null);
    const { native, agent } = nativeOf(session);
    if (this.#forgotten(native)) fail('deleted_identifier');
    const mapping = scope.sessions.find(
      m => m.sourceId === session.sessionId && m.product === 'claude_code' && m.nativeSessionId === native && m.agentId === agent
    );
    if (!mapping) return fail('claude_scope_mismatch');
    const roots = scope.sessions.filter(
      member =>
        member.sessionId === mapping.rootSessionId &&
        member.rootSessionId === mapping.rootSessionId &&
        member.product === 'claude_code' &&
        member.nativeSessionId === native &&
        member.agentId === null &&
        member.parentSessionId === null
    );
    if (roots.length !== 1 || (agent === null && roots[0]!.processId !== session.nativeMapping?.processId)) fail('claude_bound_identity_changed');
    const rootProcessProof = roots[0]!.processId;
    this.#assertBoundProcess(rootProcessProof);
    if (!this.supportedVersion(session.productVersion)) {
      fail('claude_source_version_unsupported');
    }
    if (!this.#memberPathValid(session.sourceRef, native, agent)) {
      fail('claude_source_untrusted');
    }
    const rootPath = agent === null ? session.sourceRef : join(dirname(dirname(dirname(session.sourceRef))), `${native}.jsonl`);
    this.#assertProjectScope(rootPath, session.cwd);
    const encode = (cursor: Cursor) => Buffer.from(JSON.stringify(cursor)).toString('base64url');
    const start: Cursor =
      cursorText === null
        ? {
            v: 3,
            source: session.sourceIdentity,
            offset: 0,
            recent: [],
            baselineExcluded: []
          }
        : (() => {
            try {
              return CursorSchema.parse(JSON.parse(Buffer.from(cursorText, 'base64url').toString('utf8')));
            } catch {
              return fail('claude_cursor_invalid');
            }
          })();
    const unchanged = (gap: string): UsageBatch =>
      baseline ? fail('claude_baseline_incomplete') : { records: [], cursor: encode(start), gaps: shared([gap]) };
    if (start.source !== session.sourceIdentity) {
      return unchanged('source_replaced');
    }
    const gaps = new Set<string>();
    const recent = new Map(start.recent);
    const baselineExcluded = new Set(start.baselineExcluded);
    const records: BindingUsageRecord[] = [];
    let offset = start.offset;
    let readOffset = offset,
      scannedBytes = 0;
    const byRequest = new Map<string, Pending>();
    const nativeFinality = this.#usesTerminalFinality(session.productVersion, agent);
    // A null cursor or a baseline reads to the current end; a later cursor reads one window per call.
    const toEnd = cursorText === null || baseline;
    for (;;) {
      let chunk: ReadChunk;
      const readLimit = nativeFinality && byRequest.size ? Math.min(this.#options.maxReadBytes, metadataScanLimit - scannedBytes) : this.#options.maxReadBytes;
      const scanEnd = nativeFinality ? readOffset + metadataScanLimit - (byRequest.size ? scannedBytes : 0) : Number.POSITIVE_INFINITY;
      try {
        chunk = this.#readLines(session.sourceRef, readOffset, readLimit, native, agent, session.sourceIdentity, rootProcessProof, scanEnd);
      } catch (error) {
        if (!(error instanceof Error) || !['claude_source_missing', 'claude_source_untrusted', 'claude_source_replaced'].includes(error.message)) throw error;
        return unchanged(
          error.message === 'claude_source_missing' ? 'source_missing' : error.message === 'claude_source_replaced' ? 'source_replaced' : 'source_error'
        );
      }
      if (this.#sourceIdentity(chunk.stat, session.sessionId) !== session.sourceIdentity) return unchanged('source_replaced');
      if (chunk.size < readOffset) return unchanged('source_truncated');
      if (baseline && (chunk.oversized || chunk.scanLimited)) {
        fail('claude_baseline_incomplete');
      }
      // Migrate legacy exclusions only after the source's read authority is checked.
      if (baselineLedger) {
        if (baselineLedger.addMany) {
          baselineLedger.addMany([...baselineExcluded]);
        } else {
          for (const requestId of baselineExcluded) {
            baselineLedger.add(requestId);
          }
        }
        baselineExcluded.clear();
      }
      if (chunk.oversized) gaps.add('oversized_line_skipped');
      const baselineIds = new Set<string>();
      if (baseline) {
        for (const line of chunk.lines) {
          const row = rowMeta(line.text);
          if (!row) return fail('claude_baseline_incomplete');
          if (row.type !== 'assistant' || !ownRow(row, native, agent) || row.message?.model === '<synthetic>') continue;
          const request = IdSchema.safeParse(row.requestId);
          if (!request.success) {
            return fail('claude_baseline_incomplete');
          }
          // Preserve ownership IDs even when an in-flight row has missing counters.
          if (baselineLedger) baselineIds.add(request.data);
          else {
            baselineExcluded.add(request.data);
            if (baselineExcluded.size > recentLimit) {
              fail('claude_baseline_limit');
            }
          }
        }
      }
      if (baselineLedger && baselineIds.size) {
        if (baselineLedger.addMany) {
          baselineLedger.addMany([...baselineIds]);
        } else {
          for (const requestId of baselineIds) {
            baselineLedger.add(requestId);
          }
        }
      }
      const pending = this.#collect(chunk, native, agent, session.productVersion, gaps, byRequest);
      // Native thinking fragments remain provisional across user/tool rows and quiet intervals.
      // Earlier candidate formats retain their existing trailing-row policy.
      const tail = pending.at(-1);
      const writing = this.#options.now() - chunk.stat.mtimeMs < this.#options.quiescenceMs;
      const trailing =
        tail !== undefined &&
        chunk.lines
          .filter(line => line.start > tail.first.start)
          .every(line => {
            const row = rowMeta(line.text);
            return row?.type === 'assistant' && row.requestId === tail.requestId;
          });
      let held = baseline
        ? undefined
        : nativeFinality
          ? pending.find(
              item =>
                !item.finalized && !recent.has(item.requestId) && !(baselineLedger ? baselineLedger.has(item.requestId) : baselineExcluded.has(item.requestId))
            )
          : writing && trailing
            ? tail
            : undefined;
      const more = chunk.end > readOffset && chunk.end < chunk.size;
      const scanLimited = chunk.scanLimited || (nativeFinality && byRequest.size > 0 && more && scannedBytes + chunk.end - readOffset >= metadataScanLimit);
      if (scanLimited && !baseline) {
        gaps.add('usage_incomplete');
        held ??= pending.find(
          item => !recent.has(item.requestId) && !(baselineLedger ? baselineLedger.has(item.requestId) : baselineExcluded.has(item.requestId))
        );
      }
      // Final candidates are still uncommitted while another snapshot window can contradict them.
      const collectingSnapshot = nativeFinality && !baseline && more && !scanLimited && (held !== undefined || toEnd);
      for (const item of collectingSnapshot ? [] : pending) {
        if (baseline || (baselineLedger ? baselineLedger.has(item.requestId) : baselineExcluded.has(item.requestId))) {
          byRequest.delete(item.requestId);
          continue;
        }
        if (item === held || (nativeFinality && held && item.first.start > held.first.start)) continue;
        if (!item.finalized) {
          byRequest.delete(item.requestId);
          continue;
        }
        const seen = recent.get(item.requestId);
        // Rows of an already emitted request (later batch or replay) are never re-emitted.
        if (seen !== undefined && (item.conflict || seen !== item.fingerprint)) fail('binding_request_conflict');
        if (item.conflict) {
          gaps.add('request_conflict');
          recent.set(item.requestId, item.fingerprint);
          byRequest.delete(item.requestId);
          continue;
        }
        if (seen === undefined) {
          records.push(item.record);
          recent.set(item.requestId, item.fingerprint);
        }
        byRequest.delete(item.requestId);
      }
      const before = readOffset;
      readOffset = chunk.end;
      scannedBytes += readOffset - before;
      offset = held ? held.first.start : chunk.end;
      if (baseline && readOffset <= before && readOffset < chunk.size) {
        fail('claude_baseline_incomplete');
      }
      if (nativeFinality && held && !scanLimited && readOffset > before && readOffset < chunk.size) {
        if (scannedBytes < metadataScanLimit) continue;
        gaps.add('usage_incomplete');
      }
      if (!toEnd || held || readOffset <= before || readOffset >= chunk.size) break;
    }
    return {
      records,
      cursor: encode({
        v: 3,
        source: session.sourceIdentity,
        offset,
        recent: [...recent.entries()].slice(-recentLimit),
        baselineExcluded: [...baselineExcluded]
      }),
      gaps: baseline ? [] : shared(gaps)
    };
  }

  /** Thinking snapshots share a message ID, but only terminal snapshots establish whole-request counters. */
  #collect(chunk: ReadChunk, native: string, agent: string | null, version: string, gaps: Set<string>, byRequest: Map<string, Pending>): Pending[] {
    for (const line of chunk.lines) {
      const row = rowMeta(line.text);
      if (!row) {
        gaps.add('invalid_line');
        continue;
      }
      if (row.type === 'system' && row.subtype === 'compact_boundary') {
        gaps.add('compaction_usage_unverified');
      }
      if (row.type !== 'assistant') continue;
      if (row.sessionId !== native) {
        gaps.add('foreign_session_row');
        continue;
      }
      // Descendant rows copied into this file are counted only from the descendant's own file.
      if (!ownRow(row, native, agent)) {
        if (agent !== null ? row.agentId === undefined : row.agentId === null) gaps.add('ownership_unverified');
        continue;
      }
      const usage = row.message?.usage;
      if (!row.message || !usage) {
        gaps.add('usage_missing');
        continue;
      }
      if (row.message.model === '<synthetic>') continue;
      if (row.version !== version || !this.supportedVersion(row.version)) {
        gaps.add('unsupported_version');
        continue;
      }
      const requestId = IdSchema.safeParse(row.requestId);
      if (!requestId.success) {
        gaps.add('request_id_missing');
        continue;
      }
      let messageId: string | null = null,
        finalized = true;
      if (this.#usesTerminalFinality(version, agent)) {
        const id = IdSchema.safeParse(row.message.id);
        const stop = NativeStopReasonSchema.safeParse(row.message.stopReason);
        if (!id.success || !stop.success) {
          gaps.add('usage_incomplete');
          continue;
        }
        messageId = id.data;
        finalized = stop.data !== null;
      }
      const model = ModelSchema.safeParse(row.message.model);
      const occurredAt = isoTimestamp(row.timestamp);
      const ordinary = token(usage.input_tokens);
      const write = token(usage.cache_creation_input_tokens);
      const read = token(usage.cache_read_input_tokens);
      const output = token(usage.output_tokens);
      if (!model.success || occurredAt === null || ordinary === null || write === null || read === null || output === null) {
        gaps.add('usage_incomplete');
        continue;
      }
      const creation = object(usage.cache_creation);
      const ttl = readCacheWriteTtl(usage.cache_creation, write);
      const oneHourWrite = creation !== null && (token(creation.ephemeral_1h_input_tokens) ?? 0) > 0;
      if (finalized && oneHourWrite) gaps.add('cache_write_1h_observed');
      const server = object(usage.server_tool_use);
      if (finalized && server && Object.values(server).some(v => (token(v) ?? 0) > 0)) gaps.add('server_tool_use_unpriced');
      // Retain old fingerprints only when no new TTL evidence exists. This avoids
      // replaying old cursors while numeric splits and malformed evidence conflict.
      const fingerprint = sha([
        model.data,
        ordinary,
        write,
        read,
        output,
        version,
        ...(oneHourWrite ? ['cache_write_1h_observed'] : []),
        ...(usage.cache_creation === undefined ? [] : ['cache_write_ttl-v1', ttl])
      ]);
      const old = byRequest.get(requestId.data);
      if (old) {
        if (old.messageId !== messageId || (old.finalized && finalized && old.fingerprint !== fingerprint)) old.conflict = true;
        if (old.finalized || !finalized) continue;
      }
      // The first row's timestamp is the request's deterministic occurrence time.
      byRequest.set(requestId.data, {
        requestId: requestId.data,
        first: old?.first ?? { start: line.start },
        fingerprint,
        conflict: old?.conflict ?? false,
        messageId,
        finalized,
        record: {
          requestId: requestId.data,
          sessionId: agent === null ? native : `${native}:${agent}`,
          occurredAt: old?.record.occurredAt ?? occurredAt,
          turnId: null,
          effort: null,
          payload: {
            kind: 'usage',
            schema_version: 2,
            product: 'claude_code',
            product_version: version,
            model: model.data,
            epoch: 'sequential',
            ...(oneHourWrite ? { cache_write_1h_observed: true as const } : {}),
            cache_write_ttl: ttl,
            attribution: 'verified',
            input_total: observed(addTokens([ordinary, write, read])),
            cached_input: observed(read),
            output_total: observed(output),
            reasoning_output: {
              status: 'unmeasurable',
              value: null,
              reason: 'unsupported'
            },
            billing_components: [
              {
                kind: 'ordinary_input',
                reading: observed(ordinary)
              },
              { kind: 'cache_read', reading: observed(read) },
              { kind: 'cache_write', reading: observed(write) },
              { kind: 'output', reading: observed(output) }
            ]
          }
        }
      });
    }
    return [...byRequest.values()];
  }
}

export function createClaudeSessionBindingProvider(options: ClaudeBindingOptions): ClaudeSessionBindingProvider {
  return new ClaudeSessionBindingProvider(options);
}

export const ClaudeWindowPendingReceiptSchema = z.strictObject({
  schemaVersion: z.literal(2),
  kind: z.literal('claude_window_pending'),
  receipt: z.uuid(),
  product: z.literal('claude_code'),
  event: z.enum(['connect', 'subagent_start', 'subagent_stop']),
  nativeSessionId: z.string().regex(uuidPattern),
  nativeRootSessionId: z.string().regex(uuidPattern),
  agentId: IdSchema.nullable(),
  sourceRef: z.string().min(1).max(4096).nullable(),
  cwd: z.string().min(1).max(4096),
  processIdHint: z.number().int().positive().nullable(),
  recordedAt: TimestampSchema
});
export type ClaudeWindowPendingReceipt = z.infer<typeof ClaudeWindowPendingReceiptSchema>;
export interface ClaudeWindowBindingOptions {
  readonly authorization: ClaudeWindowSourceAuthorization;
  readonly receiptDirectory: string;
  readonly claudeProjectsDirectory: string;
  readonly projectRoot: string;
  readonly clock?: () => string;
  readonly binaryAdapters?: ClaudeWindowBinaryAdapters;
  readonly expectedNativePinDigest?: string;
  readonly maxReadBytes?: number;
  readonly maxSourceBytes?: number;
}
const claudeWindowCursorSchema = z.strictObject({
  schemaVersion: z.literal(2),
  source: IdSchema,
  scope: z.string().length(64),
  offset: z
    .number()
    .int()
    .nonnegative()
    .max(8 * 1048576),
  prefix: z.string().length(64),
  settled: z.array(z.tuple([IdSchema, z.string().length(64)])).max(65536),
  excluded: z.array(IdSchema).max(65536)
});
type ClaudeWindowCursor = z.infer<typeof claudeWindowCursorSchema>;
interface ClaudeWindowRequest {
  readonly requestId: string;
  readonly messageId: string;
  readonly fingerprint: string;
  readonly finalized: boolean;
  readonly counters: readonly number[];
  readonly record: BindingUsageRecord;
}
const windowPath = (path: string): boolean =>
  isAbsolute(path) && join(path) === path && path.length <= 4096 && ![0, 10, 13].some(code => path.includes(String.fromCharCode(code)));
const windowFileKey = (stat: Stats): string => `${stat.dev}:${stat.ino}`;
const windowSourceSame = (before: Stats, after: Stats): boolean =>
  before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;

export class ClaudeWindowSessionBindingProvider implements SessionBindingProvider {
  readonly product = 'claude_code' as const;
  readonly #clock: () => string;
  readonly #readBytes: number;
  readonly #sourceBytes: number;
  #binary: ClaudeWindowBinaryReader | undefined;

  constructor(readonly options: ClaudeWindowBindingOptions) {
    const context = this.#access('metadata');
    if (
      options.projectRoot !== context.projectRoot ||
      ![options.projectRoot, options.receiptDirectory, options.claudeProjectsDirectory].every(windowPath) ||
      options.receiptDirectory === join(options.projectRoot, '.harness-delta') ||
      !within(options.receiptDirectory, join(options.projectRoot, '.harness-delta'))
    )
      throw new Error('binding_configuration_invalid');
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#readBytes = options.maxReadBytes ?? 65536;
    this.#sourceBytes = options.maxSourceBytes ?? 8 * 1048576;
    if (![this.#readBytes, this.#sourceBytes].every(size => Number.isSafeInteger(size) && size >= 1 && size <= 8 * 1048576))
      throw new Error('binding_configuration_invalid');
  }
  #access(kind: 'metadata' | 'source' | 'observe') {
    return assertClaudeWindowSourceAuthorization(this.options.authorization, kind);
  }
  #io<T>(kind: 'metadata' | 'source' | 'observe', operation: () => T): T {
    this.#access(kind);
    let value: T;
    try {
      value = operation();
    } catch {
      this.#access(kind);
      throw new Error(kind === 'metadata' ? 'binding_metadata_untrusted' : 'binding_source_unavailable');
    }
    this.#access(kind);
    return value;
  }
  capabilities(): BindingCapabilities {
    this.#access('metadata');
    return {
      currentIdentity: 'native_hook',
      ancestry: 'unavailable',
      usage: 'root_source_reference',
      productionSupported: false,
      maxDepth: 0,
      reasons: ['root_ownership_unverified', 'children_unobserved', 'mapped_image_unverified']
    };
  }
  #metadataRoot(): void {
    const stat = this.#directory(this.options.receiptDirectory, 'metadata');
    if (!stat || !isPrivate(stat)) throw new Error('binding_metadata_untrusted');
  }
  #directory(path: string, kind: 'metadata' | 'source', missing = false): Stats | null {
    const paths: string[] = [];
    for (let current = path; ; current = dirname(current)) {
      paths.push(current);
      if (dirname(current) === current) break;
    }
    let result: Stats | null = null;
    for (const current of paths.reverse()) {
      this.#access(kind);
      let stat: Stats;
      try {
        stat = lstatSync(current);
      } catch (error) {
        this.#access(kind);
        if (missing && error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
        throw new Error(kind === 'metadata' ? 'binding_metadata_untrusted' : 'binding_source_unavailable', { cause: error });
      }
      this.#access(kind);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(kind === 'metadata' ? 'binding_metadata_untrusted' : 'binding_source_changed');
      result = stat;
    }
    return result;
  }
  pendingReceipt(input: CurrentIdentityRequest): ClaudeWindowPendingReceipt {
    const receipt = this.#receipt(input);
    const context = this.#access('metadata');
    if (Date.parse(receipt.recordedAt) < Date.parse(context.selection.preparedAt) || Date.parse(receipt.recordedAt) > Date.parse(this.#clock()))
      throw new Error('binding_receipt_stale');
    return receipt;
  }
  #receipt(input: CurrentIdentityRequest): ClaudeWindowPendingReceipt {
    this.#access('metadata');
    if (!uuidPattern.test(input.receipt)) throw new Error('binding_identity_unavailable');
    this.#metadataRoot();
    this.#access('metadata');
    let fd: number;
    try {
      fd = openSync(join(this.options.receiptDirectory, `${input.receipt}.json`), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch {
      throw new Error('binding_metadata_untrusted');
    }
    try {
      const stat = this.#io('metadata', () => fstatSync(fd));
      if (!stat.isFile() || stat.size > 16384 || !isPrivate(stat)) throw new Error('binding_metadata_untrusted');
      const bytes = Buffer.alloc(stat.size);
      if (this.#io('metadata', () => readSync(fd, bytes, 0, bytes.length, 0)) !== bytes.length) throw new Error('binding_metadata_untrusted');
      let value: unknown;
      try {
        value = JSON.parse(bytes.toString('utf8'));
      } catch {
        throw new Error('binding_metadata_untrusted');
      }
      const parsed = ClaudeWindowPendingReceiptSchema.safeParse(value);
      const context = this.#access('metadata');
      if (!parsed.success || parsed.data.receipt !== input.receipt || !windowPath(parsed.data.cwd) || !within(parsed.data.cwd, context.projectRoot))
        throw new Error('binding_metadata_untrusted');
      return parsed.data;
    } finally {
      closeSync(fd);
    }
  }
  #root(input: CurrentIdentityRequest): ClaudeWindowPendingReceipt {
    const receipt = this.pendingReceipt(input);
    const context = this.#access('source');
    if (
      receipt.event !== 'connect' ||
      receipt.agentId !== null ||
      receipt.nativeSessionId !== receipt.nativeRootSessionId ||
      receipt.nativeSessionId !== context.nativeRootId ||
      receipt.sourceRef === null ||
      receipt.processIdHint === null
    )
      throw new Error('binding_identity_unavailable');
    if (context.nativePinDigest === null && Date.parse(this.#clock()) - Date.parse(receipt.recordedAt) > 600000) throw new Error('binding_receipt_stale');
    const expected = join(this.options.claudeProjectsDirectory, claudeProjectDirName(context.projectRoot), `${receipt.nativeSessionId}.jsonl`);
    if (!windowPath(receipt.sourceRef) || receipt.sourceRef !== expected || (context.sourceRef !== null && context.sourceRef !== receipt.sourceRef))
      throw new Error('binding_scope_mismatch');
    return receipt;
  }
  #scratch(): void {
    const path = join(this.options.receiptDirectory, '.image-verification');
    this.#access('metadata');
    let stat: Stats | undefined;
    try {
      stat = lstatSync(path);
    } catch (error) {
      this.#access('metadata');
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw new Error('binding_metadata_untrusted', { cause: error });
    }
    this.#access('metadata');
    if (!stat) {
      this.#io('metadata', () => mkdirSync(path, { mode: 0o700 }));
      stat = this.#io('metadata', () => lstatSync(path));
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || !isPrivate(stat)) throw new Error('binding_metadata_untrusted');
  }
  #pin(pid: number) {
    const context = this.#access('source');
    if (!this.#binary && this.options.binaryAdapters === undefined) this.#scratch();
    this.#binary ??= new ClaudeWindowBinaryReader({
      assertAuthorized: () => {
        this.#access('source');
      },
      adapters:
        this.options.binaryAdapters ??
        createClaudeWindowBinaryAdapters({
          assertAuthorized: () => {
            this.#access('source');
          },
          scratchDirectory: join(this.options.receiptDirectory, '.image-verification')
        })
    });
    const pin = this.#binary.snapshot(pid);
    const digest = sha([pin]);
    if (
      (context.nativePinDigest !== null && context.nativePinDigest !== digest) ||
      (this.options.expectedNativePinDigest !== undefined && this.options.expectedNativePinDigest !== digest)
    )
      throw new Error('binding_executable_changed');
    const processId = `claude-window:${pid}:${sha([pin.process.uid, pin.process.start])}`;
    const processStart = sha([pin.process.start, pin.parent.pid, pin.parent.start]);
    if ((context.processId !== null && context.processId !== processId) || (context.processStart !== null && context.processStart !== processStart))
      throw new Error('binding_executable_changed');
    return { digest, processId, processStart };
  }
  #source(path: string, native: string, expectedIdentity?: string): Stats {
    const context = this.#access('source');
    if (
      context.nativeRootId !== native ||
      !windowPath(path) ||
      path !== join(this.options.claudeProjectsDirectory, claudeProjectDirName(context.projectRoot), `${native}.jsonl`) ||
      (context.sourceRef !== null && context.sourceRef !== path)
    )
      throw new Error('binding_scope_mismatch');
    this.#directory(dirname(path), 'source');
    if (
      this.#io('source', () => realpathSync(this.options.claudeProjectsDirectory)) !== this.options.claudeProjectsDirectory ||
      this.#io('source', () => realpathSync(path)) !== path
    )
      throw new Error('binding_source_changed');
    const stat = this.#io('source', () => lstatSync(path));
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.uid !== currentUid() ||
      (expectedIdentity !== undefined && windowFileKey(stat) !== expectedIdentity) ||
      (context.sourceIdentity !== null && context.sourceIdentity !== windowFileKey(stat))
    )
      throw new Error('binding_source_changed');
    if (stat.size > this.#sourceBytes) throw new Error('binding_source_limit');
    return stat;
  }
  #snapshot(path: string, native: string, expectedIdentity?: string) {
    const before = this.#source(path, native, expectedIdentity);
    this.#access('source');
    let fd: number;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch {
      throw new Error('binding_source_unavailable');
    }
    try {
      if (
        !windowSourceSame(
          before,
          this.#io('source', () => fstatSync(fd))
        )
      )
        throw new Error('binding_source_changed');
      const bytes = Buffer.alloc(before.size);
      for (let offset = 0; offset < bytes.length;) {
        const length = Math.min(this.#readBytes, bytes.length - offset);
        const count = this.#io('source', () => readSync(fd, bytes, offset, length, offset));
        if (count < 1 || count > length) throw new Error('binding_source_changed');
        offset += count;
      }
      if (
        !windowSourceSame(
          before,
          this.#io('source', () => fstatSync(fd))
        ) ||
        !windowSourceSame(before, this.#source(path, native, expectedIdentity))
      )
        throw new Error('binding_source_changed');
      return { bytes, stat: before };
    } finally {
      closeSync(fd);
    }
  }
  inspectWindowCurrent(input: CurrentIdentityRequest): Promise<OrdinaryWindowConnectionProof> {
    return settle(() => this.#inspectWindow(input));
  }
  #inspectWindow(input: CurrentIdentityRequest): OrdinaryWindowConnectionProof {
    const receipt = this.#root(input);
    if (receipt.processIdHint === null || receipt.sourceRef === null) throw new Error('binding_identity_unavailable');
    const pin = this.#pin(receipt.processIdHint);
    const snapshot = this.#snapshot(receipt.sourceRef, receipt.nativeSessionId);
    const version = this.#access('source').selection.declaredVersion;
    const rows = this.#rawRows(snapshot.bytes);
    const first = rows.find(row => row.sessionId === receipt.nativeSessionId && row.agentId === undefined && row.isSidechain !== true);
    if (!first) throw new Error('binding_identity_unavailable');
    if (first.version !== version) throw new Error('binding_source_version_mismatch');
    this.#pin(receipt.processIdHint);
    return {
      schemaVersion: 2,
      mode: 'claude_publisher_local_pin',
      product: 'claude_code',
      receipt: receipt.receipt,
      recordedAt: receipt.recordedAt,
      nativeSessionId: receipt.nativeSessionId,
      agentId: null,
      sourceRef: receipt.sourceRef,
      sourceIdentity: windowFileKey(snapshot.stat),
      cwd: this.options.projectRoot,
      productVersion: version,
      processId: pin.processId,
      processStart: pin.processStart,
      nativePinDigest: pin.digest,
      sourceVersionBasis: 'scoped_source',
      publisherProof: 'verified_disk_assets',
      rootOwnership: 'unverified',
      possibleChildContribution: 'unknown',
      mappedImageProof: 'unverified'
    };
  }
  #identity(proof: OrdinaryWindowConnectionProof): VerifiedSessionIdentity {
    if (proof.mode !== 'claude_publisher_local_pin') throw new Error('binding_identity_mismatch');
    return {
      product: 'claude_code',
      productVersion: proof.productVersion,
      sessionId: proof.nativeSessionId,
      sourceRef: proof.sourceRef,
      sourceIdentity: proof.sourceIdentity,
      cwd: proof.cwd,
      identityEvidenceId: proof.receipt,
      parentSessionId: null,
      createdAt: proof.recordedAt,
      nativeMapping: { nativeSessionId: proof.nativeSessionId, processId: proof.processId, agentId: null }
    };
  }
  async resolveCurrent(input: CurrentIdentityRequest): Promise<VerifiedSessionIdentity> {
    return this.#identity(await this.inspectWindowCurrent(input));
  }
  async revalidateBound(input: CurrentIdentityRequest, expected: VerifiedSessionIdentity): Promise<VerifiedSessionIdentity> {
    const current = await this.resolveCurrent(input);
    this.#access('source');
    if (bindingIdentityKey(current) !== bindingIdentityKey(expected)) throw new Error('binding_identity_mismatch');
    return current;
  }
  discoverChildren(parent: VerifiedSessionIdentity): Promise<ChildDiscovery> {
    return settle(() => {
      this.#access('observe');
      this.#coverage(parent);
      return { children: [], gaps: [] };
    });
  }
  readUsage(): Promise<UsageBatch> {
    return settle(() => {
      this.#access('observe');
      throw new Error('binding_window_unavailable');
    });
  }
  #rawRows(bytes: Buffer): Record<string, unknown>[] {
    const last = bytes.lastIndexOf(10);
    if (last < 0) return [];
    return bytes
      .subarray(0, last)
      .toString('utf8')
      .split(String.fromCharCode(10))
      .filter(line => line.length > 0)
      .map(line => {
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          throw new Error('binding_contract_failed');
        }
        const row = object(value);
        if (!row) throw new Error('binding_contract_failed');
        return row;
      });
  }
  #coverage(parent: VerifiedSessionIdentity): OrdinaryWindowCoverage {
    const context = this.#access('observe');
    if (parent.sessionId !== context.nativeRootId || parent.parentSessionId !== null || parent.nativeMapping?.agentId !== null)
      throw new Error('binding_root_only_required');
    if (
      context.sourceRef === null ||
      parent.sourceRef !== context.sourceRef ||
      parent.sourceIdentity !== context.sourceIdentity ||
      parent.cwd !== context.projectRoot ||
      parent.product !== 'claude_code' ||
      parent.productVersion !== context.selection.declaredVersion ||
      parent.nativeMapping?.nativeSessionId !== context.nativeRootId ||
      parent.nativeMapping.processId !== context.processId
    )
      throw new Error('binding_scope_mismatch');
    const coverage = emptyOrdinaryWindowCoverage();
    this.#metadataRoot();
    const names = this.#io('metadata', () => readdirSync(this.options.receiptDirectory));
    if (names.length > 1026) throw new Error('binding_metadata_untrusted');
    const children = new Map<string, OrdinaryWindowCoverage['detectedChildren'][number]>();
    for (const name of names) {
      if (name === '.image-verification' || name === 'ordinary-window-control.json') continue;
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) throw new Error('binding_metadata_untrusted');
      const receipt = this.#receipt({ receipt: name.slice(0, -5) });
      if (receipt.nativeRootSessionId !== parent.sessionId || receipt.nativeSessionId !== parent.sessionId || receipt.agentId === null) continue;
      if (Date.parse(receipt.recordedAt) < Date.parse(context.selection.preparedAt) || Date.parse(receipt.recordedAt) > Date.parse(this.#clock())) continue;
      const identity = `claude-child:${sha([parent.sessionId, receipt.agentId])}`;
      const previous = children.get(identity);
      if (!previous || receipt.recordedAt < previous.firstSeenAt) {
        children.set(identity, {
          identity,
          firstSeenAt: receipt.recordedAt,
          basis: 'root_linked_receipt',
          parentRelation: 'unverified',
          usage: null,
          cost: null
        });
      }
    }
    const directory = join(dirname(context.sourceRef), context.nativeRootId, 'subagents');
    this.#access('source');
    if (this.#directory(directory, 'source', true)) {
      if (this.#io('source', () => realpathSync(directory)) !== directory) throw new Error('binding_source_changed');
      for (const name of this.#io('source', () => readdirSync(directory))) {
        const match = /^agent-([A-Za-z0-9_-]{1,91})\.jsonl$/.exec(name);
        if (!match?.[1]) continue;
        const identity = `claude-child:${sha([parent.sessionId, match[1]])}`;
        if (!children.has(identity))
          children.set(identity, {
            identity,
            firstSeenAt: this.#clock(),
            basis: 'scoped_directory_metadata',
            parentRelation: 'unverified',
            usage: null,
            cost: null
          });
      }
    }
    if (children.size > 4096) throw new Error('binding_metadata_untrusted');
    return { ...coverage, detectedChildren: [...children.values()] };
  }
  #request(row: Record<string, unknown>, native: string, version: string): ClaudeWindowRequest | null {
    if (row.type === 'summary' || row.isCompactSummary === true || (row.type === 'system' && row.subtype === 'compact_boundary'))
      throw new Error('unsupported_history');
    if (row.sessionId !== undefined && row.sessionId !== native) throw new Error('binding_ownership_unverified');
    if (row.sessionId === native && row.version !== undefined && row.version !== version) throw new Error('binding_source_version_mismatch');
    if (row.type !== 'assistant') return null;
    if (row.sessionId !== native) throw new Error('binding_ownership_unverified');
    if (typeof row.agentId === 'string' && row.isSidechain === true && IdSchema.safeParse(row.agentId).success) return null;
    if (row.agentId !== undefined || (row.isSidechain !== undefined && row.isSidechain !== false)) throw new Error('binding_ownership_unverified');
    const message = object(row.message);
    if (message?.model === '<synthetic>') return null;
    if (row.version !== version) throw new Error('binding_source_version_mismatch');
    const request = IdSchema.safeParse(row.requestId);
    const id = IdSchema.safeParse(message?.id);
    const stop = NativeStopReasonSchema.safeParse(message?.stop_reason);
    const model = ModelSchema.safeParse(message?.model);
    const occurredAt = isoTimestamp(row.timestamp);
    const usage = object(message?.usage);
    if (
      !request.success ||
      !id.success ||
      !stop.success ||
      !model.success ||
      !isClaudeModel(model.data) ||
      occurredAt === null ||
      !usage ||
      Date.parse(occurredAt) > Date.parse(this.#clock())
    )
      throw new Error('binding_contract_failed');
    const ordinary = token(usage.input_tokens),
      write = token(usage.cache_creation_input_tokens);
    const read = token(usage.cache_read_input_tokens),
      output = token(usage.output_tokens);
    if (ordinary === null || write === null || read === null || output === null) throw new Error('binding_usage_invalid');
    const ttl = readCacheWriteTtl(usage.cache_creation, write);
    if (ttl.status === 'error') throw new Error('binding_usage_invalid');
    const oneHour = ttl.status === 'observed' && ttl.one_hour_tokens > 0;
    const record: BindingUsageRecord = {
      requestId: request.data,
      sessionId: native,
      occurredAt,
      turnId: null,
      effort: null,
      payload: {
        kind: 'usage',
        schema_version: 2,
        product: 'claude_code',
        product_version: version,
        model: model.data,
        epoch: 'sequential',
        attribution: 'verified',
        input_total: observed(addTokens([ordinary, write, read])),
        cached_input: observed(read),
        output_total: observed(output),
        reasoning_output: { status: 'unmeasurable', value: null, reason: 'unsupported' },
        cache_write_ttl: ttl,
        ...(oneHour ? { cache_write_1h_observed: true as const } : {}),
        billing_components: [
          { kind: 'ordinary_input', reading: observed(ordinary) },
          { kind: 'cache_read', reading: observed(read) },
          { kind: 'cache_write', reading: observed(write) },
          { kind: 'output', reading: observed(output) }
        ]
      }
    };
    return {
      requestId: request.data,
      messageId: id.data,
      finalized: stop.data !== null,
      counters: [ordinary, write, read, output],
      fingerprint: sha([model.data, ordinary, write, read, output, ttl, stop.data]),
      record
    };
  }
  #requests(bytes: Buffer, native: string, version: string): ClaudeWindowRequest[] {
    const requests = new Map<string, ClaudeWindowRequest>();
    const requestOwners = new Map<string, string>();
    const messageOwners = new Map<string, string>();
    for (const row of this.#rawRows(bytes)) {
      const value = this.#request(row, native, version);
      if (row.type === 'assistant' && object(row.message)?.model !== '<synthetic>') {
        const request = IdSchema.safeParse(row.requestId);
        const message = IdSchema.safeParse(object(row.message)?.id);
        if (!request.success || !message.success) throw new Error('binding_contract_failed');
        const requestOwner = JSON.stringify([message.data, row.agentId ?? null]);
        const messageOwner = JSON.stringify([request.data, row.agentId ?? null]);
        if (
          (requestOwners.has(request.data) && requestOwners.get(request.data) !== requestOwner) ||
          (messageOwners.has(message.data) && messageOwners.get(message.data) !== messageOwner)
        )
          throw new Error('binding_request_conflict');
        requestOwners.set(request.data, requestOwner);
        messageOwners.set(message.data, messageOwner);
      }
      if (!value) continue;
      const old = requests.get(value.requestId);
      if (old) {
        if (
          old.messageId !== value.messageId ||
          old.record.payload.model !== value.record.payload.model ||
          (old.finalized && (!value.finalized || old.fingerprint !== value.fingerprint)) ||
          value.counters.some((counter, index) => counter < (old.counters[index] ?? 0)) ||
          Date.parse(value.record.occurredAt) < Date.parse(old.record.occurredAt)
        )
          throw new Error('binding_request_conflict');
      }
      requests.set(value.requestId, { ...value, record: { ...value.record, occurredAt: old?.record.occurredAt ?? value.record.occurredAt } });
    }
    return [...requests.values()];
  }
  readWindowUsage(
    session: VerifiedSessionIdentity,
    cursorText: string | null,
    scope: CandidateScope,
    boundary: OrdinaryWindowReadBoundary
  ): Promise<OrdinaryWindowUsageBatch> {
    return settle(() => this.#windowUsage(session, cursorText, scope, boundary));
  }
  #windowUsage(
    session: VerifiedSessionIdentity,
    cursorText: string | null,
    scope: CandidateScope,
    boundary: OrdinaryWindowReadBoundary
  ): OrdinaryWindowUsageBatch {
    const context = this.#access('observe');
    boundary.authorizeSource(session);
    if (
      context.cursor !== cursorText ||
      scope.taskId !== context.selection.taskId ||
      scope.projectId !== context.selection.projectId ||
      scope.sessions.length !== 1 ||
      scope.sessions[0]?.sourceId !== session.sessionId ||
      scope.sessions[0].agentId !== null ||
      scope.sessions[0].product !== 'claude_code' ||
      scope.sessions[0].nativeSessionId !== session.sessionId ||
      scope.sessions[0].sessionId !== scope.sessions[0].rootSessionId ||
      scope.sessions[0].parentSessionId !== null ||
      scope.sessions[0].processId !== session.nativeMapping?.processId ||
      session.parentSessionId !== null ||
      session.nativeMapping?.agentId !== null ||
      session.productVersion !== context.selection.declaredVersion
    )
      throw new Error('binding_scope_mismatch');
    const receipt = this.#root({ receipt: session.identityEvidenceId });
    if (receipt.sourceRef === null || receipt.processIdHint === null) throw new Error('binding_identity_unavailable');
    const pin = this.#pin(receipt.processIdHint);
    const snapshot = this.#snapshot(session.sourceRef, session.sessionId, session.sourceIdentity);
    const key = sha([bindingIdentityKey(session), context.selection.policyDigest, pin.digest]);
    const start = this.#cursor(cursorText, session.sourceIdentity, key);
    if (snapshot.bytes.length < start.offset || createHash('sha256').update(snapshot.bytes.subarray(0, start.offset)).digest('hex') !== start.prefix)
      throw new Error('binding_source_changed');
    const coverage = this.#coverage(session);
    const requests = this.#requests(snapshot.bytes, session.sessionId, session.productVersion);
    const settled = new Map(start.settled),
      excluded = new Set(start.excluded);
    const records: BindingUsageRecord[] = [];
    const excludedRecords: BindingUsageRecord[] = [];
    for (const request of requests) {
      const prior = settled.get(request.requestId);
      if (prior !== undefined && (!request.finalized || prior !== request.fingerprint)) throw new Error('binding_request_conflict');
      if (boundary.baseline) excluded.add(request.requestId);
      if (!request.finalized) continue;
      settled.set(request.requestId, request.fingerprint);
      if (excluded.has(request.requestId) || boundary.baselineLedger?.has(request.requestId)) excludedRecords.push(request.record);
      else if (prior === undefined) records.push(request.record);
    }
    const complete = snapshot.bytes.length === 0 || snapshot.bytes.at(-1) === 10;
    if (!complete && boundary.baseline) throw new Error('binding_source_unavailable');
    this.#pin(receipt.processIdHint);
    boundary.authorizeSource(session);
    this.#access('observe');
    if (!complete)
      return { records: [], cursor: cursorText ?? this.#encode(start), gaps: ['incomplete_request'], coverage: { ...coverage, reason: 'incomplete_request' } };
    if (boundary.baselineLedger && boundary.baseline && excluded.size) {
      if (boundary.baselineLedger.addMany) boundary.baselineLedger.addMany([...excluded]);
      else for (const id of excluded) boundary.baselineLedger.add(id);
    }
    const pending = requests.some(request => !request.finalized && !excluded.has(request.requestId));
    const cursor = this.#encode({
      schemaVersion: 2,
      source: session.sourceIdentity,
      scope: key,
      offset: snapshot.bytes.length,
      prefix: createHash('sha256').update(snapshot.bytes).digest('hex'),
      settled: [...settled],
      excluded: [...excluded]
    });
    return {
      records,
      excludedRecords,
      cursor,
      gaps: pending ? ['incomplete_request'] : [],
      coverage: { ...coverage, status: records.length ? 'partial' : 'missing', reason: pending ? 'incomplete_request' : null }
    };
  }
  #cursor(text: string | null, source: string, scope: string): ClaudeWindowCursor {
    if (text === null) return { schemaVersion: 2, source, scope, offset: 0, prefix: createHash('sha256').update('').digest('hex'), settled: [], excluded: [] };
    try {
      const parsed = claudeWindowCursorSchema.parse(JSON.parse(Buffer.from(text, 'base64url').toString('utf8')));
      if (parsed.source !== source || parsed.scope !== scope) throw new Error('binding_cursor_invalid');
      return parsed;
    } catch {
      throw new Error('binding_cursor_invalid');
    }
  }
  #encode(cursor: ClaudeWindowCursor): string {
    const encoded = Buffer.from(JSON.stringify(claudeWindowCursorSchema.parse(cursor))).toString('base64url');
    if (encoded.length > 6 * 1048576) throw new Error('binding_cursor_invalid');
    return encoded;
  }
}
