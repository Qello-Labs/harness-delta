import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants, closeSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { metadataName, type AgentMetadata } from './agent-metadata.js';
import { IdSchema, TimestampSchema } from './contracts.js';
import { parseCodexCandidateRollout, type CodexCandidateSnapshot } from './codex-candidate-rollout.js';
import { checkedCandidateScope, type CandidateScope } from './nested-candidate.js';
import { resolveSourceCompatibility } from './source-compatibility.js';
import { codexBindingAdmission, isCodexGptModel } from './codex-binding-admission.js';
import { bindingIdentityKey, CurrentIdentityRequestSchema, VerifiedSessionIdentitySchema, type BindingCapabilities, type BindingReadBoundary, type ChildDiscovery,
  type SessionBindingProvider, type UsageBatch, type VerifiedSessionIdentity } from './session-binding-contract.js';

const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
export const codexRootPilotVersions = Object.freeze(['0.162.0', '0.162.1'] as const);
const receiptVersionSchema = z.enum(['0.160.0', ...codexRootPilotVersions]);
const receiptSchema = z.strictObject({ schemaVersion: z.literal(1), receipt: z.uuid(), productVersion: receiptVersionSchema,
  event: z.enum(['SessionStart', 'SubagentStart']), sessionId: IdSchema, parentSessionId: IdSchema.nullable(), turnId: IdSchema.nullable(),
  nativeRootSessionId: IdSchema.optional(),
  sourceRef: z.string().min(1).max(4096), sourceIdentity: IdSchema, cwd: z.string().min(1).max(4096), createdAt: TimestampSchema });
type Receipt = z.infer<typeof receiptSchema>;
const headerSchema = z.object({ type: z.literal('session_meta'), payload: z.object({ id: IdSchema, session_id: IdSchema,
  agent_nickname: z.unknown().optional(), agent_role: z.unknown().optional(),
  parent_thread_id: IdSchema.nullish(), cli_version: receiptVersionSchema, cwd: z.string(),
  source: z.union([z.enum(['cli', 'exec', 'vscode', 'mcp']), z.object({ subagent: z.object({ thread_spawn:
    z.object({ parent_thread_id: IdSchema, depth: z.number().int().positive() }) }) })]) }) });
const cursorSchema = z.strictObject({ session: IdSchema, sourceIdentity: IdSchema, scope: z.string().length(64),
  baselineAt: TimestampSchema.nullable(), lastAt: TimestampSchema, size: z.number().int().nonnegative(), prefix: z.string().length(64),
  settled: z.array(z.string().length(64)).max(65536) });
type Cursor = z.infer<typeof cursorSchema>;
const sourceProofSchema = z.strictObject({ schemaVersion: z.literal(1), receipt: z.uuid(), sourceFingerprint: z.string().length(64) });
const turnIdentitySchema = z.object({ type: z.literal('turn_context'), payload: z.object({ turn_id: IdSchema.nullish(), root_turn_id: IdSchema.nullish() }) });
const requestIdentitySchema = z.object({ type: z.literal('token_usage_record'), payload: z.object({
  thread_id: IdSchema, session_id: IdSchema, turn_id: IdSchema, root_turn_id: IdSchema,
}) });
export interface CodexSessionBindingOptions {
  receiptDirectory: string;
  /** Exact approved transcript directories; never defaults to the user's home. */
  sourceRoots: string[];
  projectRoot: string;
  /** Reviewed hook configuration must match the independently verified native binary. Not source qualification. */
  productVersion?: string;
  /** Trusted local operator's exact root-only pilot; never profile/browser authority. */
  ordinaryRootPilot?: boolean;
  /** Internal bounded qualification reader; ordinary service admission still applies. */
  ordinaryFamilyQualification?: boolean;
  ordinaryFamilyAdmission?: boolean;
  clock?: () => string;
  maxDepth?: number;
  maxReceipts?: number;
  maxSourceBytes?: number;
  maxFamilyMembers?: number;
}
/** Returns a proposed hooks.json value; does not create config, trust hooks, or
 * override any existing hook definitions. Merge/review remains a human action.
 * Official lifecycle shape: https://learn.chatgpt.com/docs/hooks . */
export function proposeCodexSessionBindingHooks(options: Pick<CodexSessionBindingOptions, 'receiptDirectory' | 'sourceRoots' | 'projectRoot' | 'productVersion'> & {
  nodeExecutable: string; scriptPath: string;
}) {
  const paths = [options.nodeExecutable, options.scriptPath, options.receiptDirectory, options.projectRoot, ...options.sourceRoots];
  if (!options.sourceRoots.length || paths.some(path => !isAbsolute(path) || path.length > 4096 || path.includes(String.fromCharCode(0)) || /[\r\n]/.test(path))) throw new Error('binding_configuration_invalid');
  const version = receiptVersionSchema.safeParse(options.productVersion ?? '0.160.0');
  if (!version.success) throw new Error('binding_configuration_invalid');
  const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
  const command = [options.nodeExecutable, options.scriptPath, '--receipt-directory', options.receiptDirectory,
    ...options.sourceRoots.flatMap(root => ['--source-root', root]),
    ...(options.productVersion === undefined ? [] : ['--product-version', version.data])].map(quote).join(' ');
  const handler = { type: 'command' as const, command, timeout: 5, additionalContextLimit: 256 };
  return { destination: join(options.projectRoot, '.codex', 'hooks.json'), productionSupported: false as const,
    configuration: { description: 'Metadata-only session binding receipt proposal. Requires project and exact hook trust.',
      hooks: { SessionStart: [{ matcher: 'startup|resume|clear|compact', hooks: [{ ...handler }] }], SubagentStart: [{ hooks: [{ ...handler }] }] } },
    requirements: ['review_and_merge_existing_hooks', 'trust_project_and_exact_hooks', 'new_or_resumed_session_start_boundary',
      'native_source_qualification_required', 'exact_native_hook_path_and_header_conformance_required'] };
}
/** Metadata receipts are trusted local hook output, never native CLI admission.
 * Ordinary sessions and descendants remain unqualified for production collection.
 * Cursor signatures are process-local: a provider restart requires a fresh baseline.
 */
export class CodexSessionBindingProvider implements SessionBindingProvider {
  readonly product = 'codex' as const;
  private readonly directory: string;
  private readonly roots: string[];
  private readonly projectRoot: string;
  private readonly productVersion: z.infer<typeof receiptVersionSchema>;
  private readonly ordinaryRootPilot: boolean;
  private readonly ordinaryFamilyQualification: boolean;
  private readonly ordinaryFamilyAdmission: boolean;
  private readonly clock: () => string;
  private readonly maxDepth: number;
  private readonly maxReceipts: number;
  private readonly maxSourceBytes: number;
  private readonly maxFamilyMembers: number;
  private readonly cursorKey = randomBytes(32);
  constructor(options: CodexSessionBindingOptions) {
    const version = receiptVersionSchema.safeParse(options.productVersion ?? '0.160.0');
    if (!version.success) throw new Error('binding_configuration_invalid');
    this.productVersion = version.data;
    this.ordinaryRootPilot = options.ordinaryRootPilot === true;
    this.ordinaryFamilyQualification = options.ordinaryFamilyQualification === true;
    this.ordinaryFamilyAdmission = options.ordinaryFamilyAdmission === true;
    this.directory = realpathSync(options.receiptDirectory);
    this.projectRoot = realpathSync(options.projectRoot);
    this.roots = options.sourceRoots.map(root => realpathSync(root));
    if (!this.roots.length) throw new Error('binding_configuration_invalid');
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.maxDepth = options.maxDepth ?? 8; this.maxReceipts = options.maxReceipts ?? 1024; this.maxSourceBytes = options.maxSourceBytes ?? 8 * 1024 * 1024;
    this.maxFamilyMembers = options.maxFamilyMembers ?? 32;
    if(this.ordinaryRootPilot&&(!codexRootPilotVersions.some(version=>version===this.productVersion)||this.maxDepth!==1||this.maxFamilyMembers!==1))throw new Error('binding_configuration_invalid');
    if(this.ordinaryFamilyQualification&&(this.productVersion!=='0.162.1'||this.ordinaryRootPilot||this.maxDepth!==1||this.maxFamilyMembers!==3))throw new Error('binding_configuration_invalid');
    if(this.ordinaryFamilyAdmission&&(this.productVersion!==codexBindingAdmission.productVersion||this.ordinaryRootPilot||this.ordinaryFamilyQualification||this.maxDepth!==codexBindingAdmission.maxDepth||this.maxFamilyMembers!==codexBindingAdmission.maxFamilyMembers))throw new Error('binding_configuration_invalid');
    for (const [value, limit] of [[this.maxFamilyMembers, 32], [this.maxDepth, 31], [this.maxReceipts, 65536], [this.maxSourceBytes, 8 * 1024 * 1024]] as const) {
      if (!Number.isSafeInteger(value) || value < 1 || value > limit) throw new Error('binding_configuration_invalid');
    }
    this.checkDirectory();
  }
  capabilities(): BindingCapabilities {
    return { currentIdentity: 'native_hook', ancestry: 'verified_relations', usage: 'own_requests', productionSupported: this.ordinaryFamilyAdmission,
      maxDepth: this.maxDepth, reasons: [...(this.ordinaryFamilyAdmission?[]:['codex_ordinary_source_unqualified', 'codex_native_hook_path_and_header_conformance_pending']), 'codex_paginated_descendant_history_unsupported',
        `binding_receipt_limit_${this.maxReceipts}`, `binding_source_byte_limit_${this.maxSourceBytes}`, `binding_family_scope_limit_${this.maxFamilyMembers}`,
        'binding_turn_limit_64', 'binding_metadata_header_byte_limit_65536'] };
  }
  admissionProfile(): string | null {
    return this.ordinaryFamilyAdmission ? codexBindingAdmission.profileId : null;
  }
  /** Metadata-only pilot scope check before any receipt/source access. */
  assertProjectRoot(projectRoot: string): void {
    if(projectRoot!==this.projectRoot)throw new Error('binding_pilot_scope_invalid');
  }
  assertPilotVersion(version: string): void {
    if(version!==this.productVersion||this.maxDepth!==1||codexRootPilotVersions.some(candidate=>candidate===version)&&this.maxFamilyMembers!==1)throw new Error('binding_pilot_scope_invalid');
  }
  private checkDirectory(): void {
    let stat: ReturnType<typeof lstatSync>;
    try { stat = lstatSync(this.directory); } catch { throw new Error('binding_metadata_untrusted'); }
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw new Error('binding_metadata_untrusted');
  }
  private sourcePath(path: string): string {
    // Reject lexical escapes before resolving or statting any caller path.
    if (!isAbsolute(path) || resolve(path) !== path || !this.roots.some(root => {
      const r = relative(root, path); return r !== '' && r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r);
    })) throw new Error('binding_source_unapproved');
    let canonical: string;
    try { canonical = realpathSync(path); } catch { throw new Error('binding_source_unavailable'); }
    if (canonical !== path) throw new Error('binding_source_unapproved');
    return path;
  }
  private sourceMetadata(record: Receipt): void {
    this.sourcePath(record.sourceRef);
    let stat: ReturnType<typeof lstatSync>;
    try { stat = lstatSync(record.sourceRef); } catch { throw new Error('binding_source_unavailable'); }
    if (!stat.isFile() || `${stat.dev}:${stat.ino}` !== record.sourceIdentity) throw new Error('binding_source_changed');
  }
  private readReceipt(receipt: string): Receipt {
    try {
      this.checkDirectory();
      const name = z.uuid().parse(receipt); const path = join(this.directory, `${name}.json`);
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes: Buffer;
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size > 16384 || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw new Error('invalid');
        bytes = Buffer.alloc(stat.size); if (readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) throw new Error('invalid');
      } finally { closeSync(fd); }
      const record = receiptSchema.parse(JSON.parse(bytes.toString('utf8')) as unknown);
      if (record.productVersion !== this.productVersion || record.receipt !== receipt ||
        (record.event === 'SessionStart' ? record.parentSessionId !== null || record.turnId !== null || record.nativeRootSessionId !== undefined : record.turnId === null || (record.nativeRootSessionId === undefined ? record.parentSessionId === null || record.parentSessionId === record.sessionId : record.parentSessionId !== null || record.nativeRootSessionId === record.sessionId))) throw new Error('invalid');
      return record;
    } catch { throw new Error('binding_identity_unavailable'); }
  }
  private receipts(): Receipt[] {
    this.checkDirectory();
    let names: string[];
    try { names = readdirSync(this.directory); } catch { throw new Error('binding_metadata_untrusted'); }
    names = names.filter(name => name !== '.identities');
    if (names.length > this.maxReceipts) throw new Error('binding_receipt_limit');
    const records: Receipt[] = [];
    for (const name of names) {
      if (!/^[0-9a-f-]{36}\.json$/.test(name)) throw new Error('binding_metadata_untrusted');
      const record = this.readReceipt(name.slice(0, -5));
      if (record.cwd === this.projectRoot) records.push(record);
    }
    return records;
  }
  private identity(record: Receipt, agentMetadata?: AgentMetadata): VerifiedSessionIdentity {
    return VerifiedSessionIdentitySchema.parse({ product: this.product, productVersion: record.productVersion,
      sessionId: record.sessionId, sourceRef: record.sourceRef, sourceIdentity: record.sourceIdentity, cwd: record.cwd,
      ...(agentMetadata ? { agentMetadata } : {}),
      identityEvidenceId: record.receipt, parentSessionId: record.parentSessionId, createdAt: record.createdAt });
  }
  private verified(session: VerifiedSessionIdentity): Receipt {
    const record = this.canonical(this.readReceipt(session.identityEvidenceId), this.receipts());
    if (record.cwd !== this.projectRoot || bindingIdentityKey(this.identity(record)) !== bindingIdentityKey(session)) throw new Error('binding_identity_unavailable');
    return record;
  }
  private relation(record: Receipt, records: Receipt[]): Receipt {
    if (record.nativeRootSessionId === undefined) return record; // Legacy explicit direct-parent fixtures.
    if (record.cwd !== this.projectRoot) throw new Error('binding_ancestry_unverified');
    const roots = records.filter(r => r.event === 'SessionStart' && r.sessionId === record.nativeRootSessionId && r.cwd === this.projectRoot);
    if (!roots.length || new Set(roots.map(r => JSON.stringify([r.sourceRef, r.sourceIdentity]))).size !== 1) throw new Error('binding_ancestry_unverified');
    // First prove native family/root receipts and exact hook-supplied source metadata.
    // Read only the child's first envelope, never history or a searched source path.
    for (const root of roots) this.sourceMetadata(root);
    this.sourceMetadata(record);
    let header: z.infer<typeof headerSchema>['payload'];
    try { header = this.readHeader(record); } catch { throw new Error('binding_ancestry_unverified'); }
    if (header.id !== record.sessionId || header.session_id !== record.nativeRootSessionId || header.cwd !== this.projectRoot ||
      !header.parent_thread_id || header.parent_thread_id === record.sessionId || typeof header.source === 'string' ||
      header.source.subagent.thread_spawn.parent_thread_id !== header.parent_thread_id ||
      !records.some(r => r.sessionId === header.parent_thread_id && r.cwd === this.projectRoot &&
        (r.event === 'SessionStart' ? r.sessionId === record.nativeRootSessionId : r.nativeRootSessionId === undefined || r.nativeRootSessionId === record.nativeRootSessionId))) throw new Error('binding_ancestry_unverified');
    return { ...record, parentSessionId: header.parent_thread_id };
  }
  private checkFamilyLimit(record: Receipt, records: Receipt[]): void {
    let root = record; const seen = new Set<string>();
    while (root.nativeRootSessionId === undefined && root.parentSessionId !== null) {
      if (seen.has(root.sessionId)) throw new Error('binding_ancestry_unverified');
      seen.add(root.sessionId); const parent = records.find(r => r.sessionId === root.parentSessionId);
      if (!parent) throw new Error('binding_ancestry_unverified'); root = parent;
    }
    const family = root.nativeRootSessionId ?? root.sessionId;
    const members = new Set([family]); let changed = true;
    // Hook metadata only. Prove the ceiling before any child source/header read.
    while (changed) { changed = false; for (const r of records) {
      if (r.nativeRootSessionId === family || r.nativeRootSessionId === undefined && r.parentSessionId !== null && members.has(r.parentSessionId)) {
        if (!members.has(r.sessionId)) { members.add(r.sessionId); changed = true; }
      }
    } }
    const sources = records.filter(r => members.has(r.sessionId));
    if (new Set(sources.map(r => JSON.stringify([r.sourceRef,r.sourceIdentity]))).size > this.maxFamilyMembers || members.size > this.maxFamilyMembers) throw new Error('binding_family_limit');
    for (const id of members) if (new Set(sources.filter(r=>r.sessionId===id).map(r=>JSON.stringify([r.sourceRef,r.sourceIdentity]))).size>1) throw new Error('binding_identity_ambiguous');
  }
  private canonical(record: Receipt, records: Receipt[]): Receipt {
    this.checkFamilyLimit(record, records);
    record = this.relation(record, records);
    const matches = records.filter(r => r.sessionId === record.sessionId).map(r => this.relation(r, records));
    if (!matches.length || new Set(matches.map(r => JSON.stringify([r.parentSessionId, r.sourceRef, r.sourceIdentity]))).size !== 1) throw new Error('binding_identity_ambiguous');
    const fingerprint = (r: Receipt) => hash(JSON.stringify([this.product, r.productVersion, r.cwd, r.sessionId,
      r.parentSessionId, r.sourceRef, r.sourceIdentity]));
    const directory = join(this.directory, '.identities');
    const path = join(directory, `${hash(JSON.stringify([this.product, record.cwd, record.sessionId]))}.json`);
    try {
      mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      // eslint-disable-next-line preserve-caught-error -- Receipt-journal filesystem paths stay private.
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw new Error('binding_metadata_untrusted');
    }
    let stat: ReturnType<typeof lstatSync>;
    try { stat = lstatSync(directory); } catch { throw new Error('binding_metadata_untrusted'); }
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw new Error('binding_metadata_untrusted');
    // Persist the first verified source proof once. Later hooks may share a native
    // timestamp or sort earlier lexically, but cannot replace this durable receipt.
    const first = matches.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.receipt.localeCompare(b.receipt))[0]!;
    const pending = join(directory, `${randomUUID()}.pending`);
    let pendingCreated = false; let cleanupFailed = false;
    try {
      writeFileSync(pending, JSON.stringify({ schemaVersion: 1, receipt: first.receipt, sourceFingerprint: fingerprint(first) }), { flag: 'wx', mode: 0o600 });
      pendingCreated = true;
      // Publish a fully written proof atomically without replacing an existing
      // proof. Concurrent provider instances must converge on the same winner.
      linkSync(pending, path);
    } catch (error) {
      // eslint-disable-next-line preserve-caught-error -- Receipt-journal filesystem paths stay private.
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw new Error('binding_metadata_untrusted');
    } finally {
      if (pendingCreated) {
        try { unlinkSync(pending); } catch { cleanupFailed = true; }
      }
    }
    if (cleanupFailed) throw new Error('binding_metadata_untrusted');
    let proof: z.infer<typeof sourceProofSchema>;
    try {
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size > 4096 || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw new Error('invalid');
        const bytes = Buffer.alloc(stat.size);
        if (readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) throw new Error('invalid');
        proof = sourceProofSchema.parse(JSON.parse(bytes.toString('utf8')) as unknown);
      } finally { closeSync(fd); }
    } catch { throw new Error('binding_metadata_untrusted'); }
    const retained = this.relation(this.readReceipt(proof.receipt), records);
    if (proof.sourceFingerprint !== fingerprint(record) || proof.sourceFingerprint !== fingerprint(retained) ||
      !matches.some(r => r.receipt === retained.receipt)) throw new Error('binding_identity_ambiguous');
    return retained;
  }
  private readSource(record: Receipt, headerOnly = false): Buffer {
    this.sourcePath(record.sourceRef);
    let fd: number;
    try { fd = openSync(record.sourceRef, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { throw new Error('binding_source_unavailable'); }
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || `${before.dev}:${before.ino}` !== record.sourceIdentity) throw new Error('binding_source_changed');
      if (headerOnly) {
        // Metadata discovery reads exactly the first native envelope, never a body
        // line, even when a header is malformed or a partial write is pending.
        const bytes: number[] = []; const byte = Buffer.alloc(1);
        while (bytes.length < 65536 && readSync(fd, byte, 0, 1, bytes.length) === 1) {
          if (byte[0] === 10) return Buffer.from(bytes);
          bytes.push(byte[0]!);
        }
        throw new Error('binding_metadata_unavailable');
      }
      if (before.size > this.maxSourceBytes) throw new Error('binding_source_limit');
      const bytes = Buffer.alloc(before.size);
      if (readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) throw new Error('binding_source_changed');
      const after = fstatSync(fd);
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error('binding_source_changed');
      return bytes;
    } catch (error) {
      if (error instanceof Error && ['binding_source_changed', 'binding_metadata_unavailable', 'binding_source_limit'].includes(error.message)) throw error;
      // eslint-disable-next-line preserve-caught-error -- Native filesystem errors may contain private source paths.
      throw new Error('binding_source_unavailable');
    } finally { closeSync(fd); }
  }
  private readHeader(record: Receipt): z.infer<typeof headerSchema>['payload'] {
    if(record.productVersion!=='0.160.0'&&!this.ordinaryRootPilot&&!this.ordinaryFamilyQualification&&!this.ordinaryFamilyAdmission)throw new Error('binding_source_unqualified');
    const bytes = this.readSource(record, true);
    try {
      const header = headerSchema.parse(JSON.parse(bytes.toString('utf8')) as unknown).payload;
      if (header.cli_version !== record.productVersion) throw new Error('invalid');
      return header;
    }
    catch { throw new Error('binding_metadata_unavailable'); }
  }
  /** Qualification-only explicit connect: root hook metadata before any source read. */
  assertRootReceipt(input: {receipt:string}, sessionId:string|null): void {
    const record=this.readReceipt(CurrentIdentityRequestSchema.parse(input).receipt);
    if(record.cwd!==this.projectRoot||record.event!=='SessionStart'||record.parentSessionId!==null||sessionId!==null&&record.sessionId!==sessionId)throw new Error('binding_qualification_live_root_required');
  }
  resolveApplicationIdentity(input: {receipt:string}): Promise<VerifiedSessionIdentity> {this.assertRootReceipt(input,null);return this.resolveCurrent(input);}
  async resolveCurrent(input: { receipt: string }): Promise<VerifiedSessionIdentity> {
    let record = this.readReceipt(CurrentIdentityRequestSchema.parse(input).receipt);
    if (record.cwd !== this.projectRoot) throw new Error('binding_identity_unavailable');
    const records = this.receipts(); record = this.canonical(record, records);
    // The trusted receipt bounds metadata verification without a history scan.
    this.sourceMetadata(record);
    if(this.ordinaryFamilyAdmission&&record.parentSessionId===null) {
      const header=this.readHeader(record);
      if(header.id!==record.sessionId||header.session_id!==record.sessionId||header.cwd!==this.projectRoot||
        header.cli_version!==record.productVersion||header.source!=='cli'||
        header.parent_thread_id!==undefined&&header.parent_thread_id!==null)throw new Error('binding_scope_mismatch');
    }
    const ancestry = record.parentSessionId === null ? null : this.verifyAncestry(record, records);
    return await Promise.resolve(this.identity(record, ancestry?.agentMetadata));
  }
  private verifyAncestry(record: Receipt, records: Receipt[]): { rootSessionId: string; agentMetadata: AgentMetadata | undefined } {
    let agentMetadata: AgentMetadata | undefined;
    const seen = new Set<string>(); const chain = [record]; let current = record; let depth = 0;
    while (current.parentSessionId !== null) {
      if (seen.has(current.sessionId) || ++depth > this.maxDepth) throw new Error('binding_ancestry_unverified');
      seen.add(current.sessionId);
      const matches = records.filter(r => r.sessionId === current.parentSessionId);
      if (!matches.length) throw new Error('binding_ancestry_unverified');
      try { current = this.canonical(matches[0]!, records); } catch { throw new Error('binding_ancestry_unverified'); }
      chain.push(current);
    }
    if (seen.has(current.sessionId)) throw new Error('binding_ancestry_unverified');
    // First prove the complete chain and pinned source metadata, then inspect only
    // each child's session_meta envelope. No root hook alone authenticates a child.
    for (const item of chain) this.sourceMetadata(item);
    for (const [index, item] of chain.slice(0, -1).entries()) {
      let header: z.infer<typeof headerSchema>['payload'];
      try { header = this.readHeader(item); }
      catch { throw new Error('binding_ancestry_unverified'); }
      if (header.id !== item.sessionId || header.session_id !== current.sessionId || header.cli_version !== item.productVersion ||
        header.cwd !== this.projectRoot || header.parent_thread_id !== item.parentSessionId || typeof header.source === 'string' ||
        header.source.subagent.thread_spawn.parent_thread_id !== item.parentSessionId || header.source.subagent.thread_spawn.depth !== depth - index) throw new Error('binding_ancestry_unverified');
      if (index === 0) {
        // Project names from this verified envelope, without a second header read.
        const nickname = metadataName(header.agent_nickname); const role = metadataName(header.agent_role);
        if (nickname !== null || role !== null) agentMetadata = { source: 'codex_session_meta', nickname, role };
      }
    }
    return { rootSessionId: current.sessionId, agentMetadata };
  }
  async discoverChildren(parent: VerifiedSessionIdentity): Promise<ChildDiscovery> {
    const records = this.receipts();
    try { this.checkFamilyLimit(this.readReceipt(parent.identityEvidenceId), records); }
    catch (error) { if (error instanceof Error && error.message === 'binding_family_limit') return { children: [], gaps: ['binding_family_limit'] }; throw error; }
    const parentReceipt = this.verified(parent);
    this.sourceMetadata(parentReceipt);
    const family = parentReceipt.parentSessionId === null ? parentReceipt.sessionId : this.verifyAncestry(parentReceipt, records).rootSessionId;
    const children: ChildDiscovery['children'] = []; const gaps = new Set<string>();
    const candidates = records.filter(r => r.nativeRootSessionId === family || r.nativeRootSessionId === undefined && r.parentSessionId === parent.sessionId);
    for (const id of new Set(candidates.map(r => r.sessionId))) {
      const matches = records.filter(r => r.sessionId === id);
      let child: Receipt; let agentMetadata: AgentMetadata | undefined;
      try { child = this.canonical(matches[0]!, records); if (child.parentSessionId !== parent.sessionId) continue; agentMetadata = this.verifyAncestry(child, records).agentMetadata; }
      catch { gaps.add('binding_ancestry_unverified'); continue; }
      children.push({ parentSessionId: parent.sessionId, identity: this.identity(child, agentMetadata), relationEvidenceId: child.receipt });
    }
    return await Promise.resolve({ children, gaps: [...gaps] });
  }
  private decodeCursor(value: string): Cursor {
    try {
      if (value.length > 6 * 1024 * 1024) throw new Error('invalid');
      const [body, signature, extra] = value.split('.');
      if (!body || !/^[A-Za-z0-9_-]+$/.test(body) || !signature || !/^[0-9a-f]{64}$/.test(signature) || extra !== undefined) throw new Error('invalid');
      const expected = createHmac('sha256', this.cursorKey).update(body).digest(); const actual = Buffer.from(signature, 'hex');
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error('invalid');
      return cursorSchema.parse(JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as unknown);
    } catch { throw new Error('binding_cursor_invalid'); }
  }
  private encodeCursor(cursor: Cursor): string {
    const body = Buffer.from(JSON.stringify(cursor)).toString('base64url');
    return `${body}.${createHmac('sha256', this.cursorKey).update(body).digest('hex')}`;
  }
  async readUsage(session: VerifiedSessionIdentity, cursor: string | null, inputScope: CandidateScope, boundary?: BindingReadBoundary): Promise<UsageBatch> {
    let scope: CandidateScope;
    try { scope = checkedCandidateScope(inputScope); } catch { throw new Error('binding_scope_mismatch'); }
    const compatibility = this.ordinaryFamilyAdmission
      ? resolveSourceCompatibility('codex',this.productVersion,'codex_binding',codexBindingAdmission.profileId)
      : this.ordinaryRootPilot || this.ordinaryFamilyQualification ? resolveSourceCompatibility('codex',this.productVersion,'codex_workflow','codex-workflow-own-response-v1') : null;
    if(this.ordinaryRootPilot&&(scope.sessions.length!==1||session.parentSessionId!==null||!compatibility))throw new Error('binding_pilot_family_scope');
    const record = this.verified(session);
    const mapping = scope.sessions.find(s => s.nativeSessionId === session.sessionId);
    if (!mapping || mapping.product !== 'codex' || mapping.parentSessionId !== session.parentSessionId || mapping.sessionId !== session.sessionId) throw new Error('binding_scope_mismatch');
    // Siblings can be discovered without resetting an existing session's cursor.
    // Only the authorized task and this source's exact ancestry bind the cursor.
    const lineage = [mapping]; let ancestor = mapping;
    while (ancestor.parentSessionId !== null) { ancestor = scope.sessions.find(s => s.sessionId === ancestor.parentSessionId)!; lineage.push(ancestor); }
    const scopeHash = hash(JSON.stringify([scope.projectId, scope.taskId, lineage]));
    const previous = cursor === null ? null : this.decodeCursor(cursor);
    if (previous && (previous.session !== session.sessionId || previous.sourceIdentity !== session.sourceIdentity || previous.scope !== scopeHash)) throw new Error('binding_cursor_invalid');
    if (record.parentSessionId !== null) this.verifyAncestry(record, this.receipts());
    else {
      // Validate the native root metadata envelope before any transcript body is
      // read. A receipt's path alone cannot admit a different native source.
      const header = this.readHeader(record);
      if (header.id !== record.sessionId || header.session_id !== mapping.nativeSessionId ||
        (header.parent_thread_id ?? null) !== null || typeof header.source !== 'string' ||
        this.ordinaryFamilyAdmission&&header.source!=='cli' || header.cwd !== this.projectRoot) throw new Error('binding_scope_mismatch');
    }
    const bytes = this.readSource(record); const now = TimestampSchema.parse(this.clock());
    if (previous && (bytes.length < previous.size || hash(bytes.subarray(0, previous.size)) !== previous.prefix)) throw new Error('binding_source_changed');
    if (previous && Date.parse(now) < Date.parse(previous.lastAt)) throw new Error('binding_clock_regressed');
    // Root-turn permission comes from the authorized native source, never a model
    // supplied turn. For children the hook's turn is only a narrowing hint; the
    // native request still must satisfy all independent parser ancestry checks.
    const rootTurns = new Set<string>();
    for (const line of bytes.toString('utf8').split('\n').slice(0, -1)) {
      let row: unknown; try { row = JSON.parse(line) as unknown; } catch { throw new Error('candidate_invalid_metadata'); }
      const parsed = turnIdentitySchema.safeParse(row);
      if (parsed.success) {
        const turn = session.parentSessionId === null ? parsed.data.payload.turn_id : parsed.data.payload.root_turn_id;
        if (turn != null) rootTurns.add(turn);
      }
      const request = requestIdentitySchema.safeParse(row);
      if (request.success && request.data.payload.thread_id === mapping.nativeSessionId &&
        request.data.payload.session_id === lineage.at(-1)!.nativeSessionId &&
        (session.parentSessionId !== null || request.data.payload.root_turn_id === request.data.payload.turn_id)) {
        // Native own-response identity can prove the turn permission even when
        // runtime context is absent. Projection still emits a missing-runtime gap
        // and cannot count the request without its native model/effort boundary.
        rootTurns.add(request.data.payload.root_turn_id);
      }
    }
    if (rootTurns.size > 64) throw new Error('binding_turn_limit');
    // With no native context, parser still validates header/counters and reports
    // missing runtime. No request can be attributed via this sentinel permission.
    scope = { ...scope, ...(this.ordinaryFamilyQualification ? { sessions: [...lineage].reverse() } : {}),
      allowedRootTurnIds: rootTurns.size ? [...rootTurns] : ['binding-observation'] };
    let snapshot: CodexCandidateSnapshot; let historyGap = false;
    try { snapshot = parseCodexCandidateRollout(bytes.toString('utf8'), scope, mapping.sourceId, this.projectRoot, now, compatibility ?? undefined); }
    catch (error) {
      if (!(error instanceof Error) || error.message !== 'candidate_unsupported_history') throw error;
      snapshot = { records: [], hasGap: false }; historyGap = true;
    }
    const settled = new Set(previous?.settled ?? []);
    const records: UsageBatch['records'] = []; const excludedRecords: UsageBatch['records'] = []; const gaps = new Set(snapshot.hasGap ? ['binding_partial_usage'] : []);
    if (historyGap) gaps.add('candidate_unsupported_history');
    // Null returns an initial own-request snapshot. The coordinator discards it
    // for root/restart baselines, and may retain a freshly evidenced child's own
    // first responses under the parent's already active observation boundary.
    for (const { projection, contextAt } of snapshot.records) {
      if (settled.has(projection.event.id)) continue;
      if (Date.parse(projection.event.occurred_at) > Date.parse(now)) { gaps.add('binding_future_usage'); continue; }
      settled.add(projection.event.id);
      const { runtime_evidence_id: runtimeEvidenceId, ...payload } = projection.event.payload;
      void runtimeEvidenceId;
      if(this.ordinaryFamilyAdmission&&!isCodexGptModel(payload.model))throw new Error('binding_runtime_unsupported');
      const excluded = previous?.baselineAt != null && Date.parse(contextAt) <= Date.parse(previous.baselineAt);
      if (excluded) gaps.add('binding_unobserved_context');
      (excluded ? excludedRecords : records).push({ requestId: projection.runtime.request_id!, sessionId: session.sessionId, occurredAt: projection.event.occurred_at,
        turnId: projection.runtime.turn_id, effort: projection.runtime.effort, payload });
    }
    return await Promise.resolve({ records, ...(excludedRecords.length ? {excludedRecords} : {}), gaps: [...gaps], cursor: this.encodeCursor({ session: session.sessionId, sourceIdentity: session.sourceIdentity,
      scope: scopeHash, baselineAt: previous ? previous.baselineAt : boundary?.baseline === false ? null : now,
      lastAt: now, size: bytes.length, prefix: hash(bytes), settled: [...settled] }) });
  }
}
