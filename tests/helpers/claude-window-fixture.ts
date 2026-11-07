import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClaudeWindowBinaryAdapters, ClaudeWindowImageStat, ClaudeWindowSignature } from '../../src/claude-process-binary.js';
import { OrdinaryWindowCoverageSchema } from '../../src/core/ordinary-window-policy.js';
import { collectOrdinaryClaudeWindow, connectOrdinaryClaudeWindow } from '../../src/ordinary-session-binding.js';
import { claudeProjectDirName } from '../../src/session-binding-claude.js';
import { ordinaryWindowFixture } from './ordinary-window-fixture.js';

export const claudeWindowJsonl = (rows: readonly unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n';

function imageBytes() {
  const bytes = Buffer.alloc(64, 17);
  bytes.writeUInt32LE(0xfeedfacf);
  bytes.writeUInt32LE(0x0100000c, 4);
  return bytes;
}

function syntheticBinary() {
  const operations: string[] = [];
  const state = {
    pid: 3107,
    start: 'synthetic-process-start',
    inode: 7,
    bytes: imageBytes(),
    signatureBytes: imageBytes(),
    cdHash: 'a'.repeat(40)
  };
  const stat = (): ClaudeWindowImageStat => ({
    device: 3,
    inode: state.inode,
    size: state.bytes.length,
    mode: 0o755,
    mtimeMs: 10,
    ctimeMs: 11,
    regularFile: true
  });
  const signature = (): ClaudeWindowSignature => ({
    valid: true,
    team: 'Q6L2SF6YDW',
    identifier: 'com.anthropic.claude-code',
    cdHash: state.cdHash
  });
  function effect<T>(operation: string, value: T): T {
    operations.push(operation);
    return value;
  }
  const path = '/synthetic/claude/standalone/claude';
  const adapters: ClaudeWindowBinaryAdapters = {
    currentUid: () => effect('uid', 501),
    readProcess: pid =>
      effect(
        'process',
        pid === 3107
          ? {
              pid: state.pid,
              uid: 501,
              start: state.start,
              parentPid: 3106
            }
          : {
              pid: 3106,
              uid: 501,
              start: 'synthetic-parent-start',
              parentPid: 3105
            }
      ),
    readImage: () => effect('image', { path, layout: 'standalone', requiredHost: null }),
    realpath: () => effect('realpath', path),
    stat: () => effect('stat', stat()),
    open: () =>
      effect('open', {
        stat: () => effect('fstat', stat()),
        read: (buffer, offset, length, position) => effect('read', state.bytes.copy(buffer, offset, position, position + length)),
        verifySignature: () =>
          effect('signature', {
            signature: signature(),
            sha256: createHash('sha256').update(state.signatureBytes).digest('hex'),
            stat: stat()
          }),
        close: () => {
          operations.push('close');
        }
      })
  };
  return { adapters, operations, state };
}

export function createClaudeWindowFixture(product: 'codex' | 'claude_code' = 'claude_code') {
  const base = ordinaryWindowFixture(product);
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'claude-window-')));
  const projectRoot = join(directory, 'project');
  const claudeProjectsDirectory = join(directory, 'claude-projects');
  const receiptDirectory = join(projectRoot, '.harness-delta', 'claude-window-receipts');
  const projectDirectory = join(claudeProjectsDirectory, claudeProjectDirName(projectRoot));
  for (const path of [projectRoot, projectDirectory, receiptDirectory]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  base.store.execute('UPDATE projects SET local_root=? WHERE id=?', [projectRoot, base.selection.projectId]);
  let milliseconds = Date.parse(base.clock());
  const clock = () => new Date(milliseconds).toISOString();
  const advance = (amount = 1000) => {
    milliseconds += amount;
  };
  const nativeSessionId = randomUUID();
  const sourcePath = join(projectDirectory, `${nativeSessionId}.jsonl`);
  const binary = syntheticBinary();
  const user = (overrides: Readonly<Record<string, unknown>> = {}) => ({
    type: 'user',
    sessionId: nativeSessionId,
    version: base.selection.declaredVersion,
    cwd: projectRoot,
    isSidechain: false,
    timestamp: clock(),
    ...overrides
  });
  const assistant = (requestId: string, counters: Readonly<Record<string, unknown>> = {}) => ({
    type: 'assistant',
    sessionId: nativeSessionId,
    version: base.selection.declaredVersion,
    cwd: projectRoot,
    isSidechain: false,
    requestId,
    timestamp: clock(),
    message: {
      id: `msg_${requestId}`,
      role: 'assistant',
      model: 'claude-opus-5-5',
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 11,
        cache_creation_input_tokens: 3,
        cache_read_input_tokens: 7,
        output_tokens: 5,
        ...counters
      }
    }
  });
  const emit = (overrides: Readonly<Record<string, unknown>> = {}) => {
    const receipt = randomUUID();
    const pending = {
      schemaVersion: 2,
      kind: 'claude_window_pending',
      receipt,
      product: 'claude_code',
      event: 'connect',
      nativeSessionId,
      nativeRootSessionId: nativeSessionId,
      agentId: null,
      sourceRef: sourcePath,
      cwd: projectRoot,
      processIdHint: 3107,
      recordedAt: clock(),
      ...overrides
    };
    writeFileSync(join(receiptDirectory, `${receipt}.json`), JSON.stringify(pending), { mode: 0o600 });
    return pending;
  };
  writeFileSync(sourcePath, claudeWindowJsonl([user()]), { mode: 0o600 });
  const receipt = emit();
  const options = {
    store: base.store,
    taskId: base.taskId,
    receiptDirectory,
    claudeProjectsDirectory,
    clock,
    binaryAdapters: binary.adapters
  };
  let rootSessionId: string | undefined;
  return {
    ...base,
    directory,
    projectRoot,
    claudeProjectsDirectory,
    receiptDirectory,
    projectDirectory,
    sourcePath,
    nativeSessionId,
    binary,
    options,
    clock,
    advance,
    receipt,
    user,
    assistant,
    emit,
    append: (rows: readonly unknown[]) => appendFileSync(sourcePath, claudeWindowJsonl(rows)),
    replace: (rows: readonly unknown[]) => writeFileSync(sourcePath, claudeWindowJsonl(rows), { mode: 0o600 }),
    connect: async (id = receipt.receipt) => {
      const result = await connectOrdinaryClaudeWindow(options, {
        receipt: id
      });
      rootSessionId = result.rootSessionId;
      return result;
    },
    collect: () => {
      if (!rootSessionId) throw new Error('fixture_not_connected');
      return collectOrdinaryClaudeWindow(options, rootSessionId);
    },
    usageState: () => ({
      events: base.store.all('SELECT * FROM events'),
      requests: base.store.all('SELECT * FROM binding_requests'),
      exclusions: base.store.all('SELECT * FROM binding_baseline_exclusions'),
      provenance: base.store.all('SELECT * FROM session_source_compatibility'),
      evidence: base.store.all('SELECT * FROM runtime_evidence'),
      cursors: base.store.all('SELECT cursor FROM session_bindings'),
      coverage: base.store.all<{ coverage: string }>('SELECT coverage FROM ordinary_window_segments')
    }),
    coverage: () => {
      const row = base.store.get<{ coverage: string }>('SELECT coverage FROM ordinary_window_segments ORDER BY rowid DESC LIMIT 1');
      if (!row) throw new Error('fixture_coverage_missing');
      return OrdinaryWindowCoverageSchema.parse(JSON.parse(row.coverage));
    },
    payloads: () =>
      base.store
        .all<{ payload: string }>("SELECT payload FROM events WHERE json_extract(payload,'$.kind')='usage'")
        .map((row): unknown => JSON.parse(row.payload)),
    cleanup: () => {
      base.store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  };
}
