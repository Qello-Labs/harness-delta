import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { admittedImage } from '../scripts/tool-update/conformance.mjs';
import { projectTranscript } from '../scripts/tool-update/claude-oracle.mjs';
import type { Approval } from '../scripts/tool-update/conformance.mjs';
import type { ServedRequest } from '../scripts/tool-update/claude-oracle.mjs';

// Synthetic only. No vendor image, binary-proof injection, API or socket is used.
const roots: string[] = [];
export const fixture = () => {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'hd-runner-test-')));
  chmodSync(path, 0o700); roots.push(path); return path;
};
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
export const pins = Object.fromEntries(['binary', 'runtime', 'source', 'build', 'instrument', 'skill', 'lockfile',
  'package', 'supervisor', 'python', 'ps', 'pgrep', 'git'].map(key => [key, 'a'.repeat(64)]));
export const approval = (): Approval => ({
  schema_version: 1, approved: true, run_id: randomUUID(), approved_at: '2026-10-24T00:00:00Z',
  expires_at: '2026-10-24T00:30:00Z', product: 'claude_code', version: admittedImage.version,
  binary_sha256: admittedImage.sha256, binary_size: admittedImage.size,
  route: 'claude_binding', profile_id: 'claude-binding-2-1-306-family-v1',
  runtime: { version: 'v24.21.0', sha256: 'b'.repeat(64), platform: 'darwin', arch: 'arm64' },
  scope: { kind: 'localhost_synthetic_print', roots: 1, members: 2, scenarios: ['normal', 'sigint'], model: 'claude-sonnet-5-5' },
  mode: 'manual', localhost_only_not_isolated: true,
  budgets: { duration_ms: 100000, termination_ms: 5000, term_grace_ms: 1000 }, pins,
});
export const context = { now: Date.parse('2026-10-24T00:10:00Z'), version: 'v24.21.0', platform: 'darwin', arch: 'arm64',
  runtimeSha256: 'b'.repeat(64), binarySha256: admittedImage.sha256, binarySize: admittedImage.size, pins };

export const usage = { input_tokens: 101, output_tokens: 111, cache_read_input_tokens: 23, cache_creation_input_tokens: 11,
  cache_creation: { ephemeral_5m_input_tokens: 7, ephemeral_1h_input_tokens: 4 } };
export const row = (id: number, session: string, agent: string | null = null, terminal = true) => ({
  type: 'assistant', sessionId: session, version: '2.1.306', timestamp: '2026-10-24T00:00:00.000Z',
  requestId: `req_conformance_${id}`, ...(agent ? { agentId: agent, isSidechain: true } : {}),
  message: { id: `msg_conformance_${id}`, model: 'claude-sonnet-5-5', stop_reason: terminal ? 'end_turn' : null,
    content: [{ type: 'text', text: 'SYNTHETIC-CONTENT-NEVER-EVIDENCE' }], usage },
});
export const lines = (rows: readonly unknown[]) => rows.map(value => JSON.stringify(value) + '\n').join('');
export function scenarioFixture(scenario: 'normal' | 'sigint') {
  const session = randomUUID(), terminal = scenario === 'normal';
  const ledger: ServedRequest[] = [1, 2, 3, 4, 5, 6].map(id => ({
    requestId: `req_conformance_${id}`, owner: id === 3 ? 'child-1' : id === 5 ? 'child-2' : 'root',
    status: id === 6 && !terminal ? 'partial' : 'terminal', counters: usage,
  }));
  const sources = [
    projectTranscript(lines([row(1, session), row(2, session), row(4, session), row(6, session, null, terminal)]), session, null, ['req_conformance_1']),
    projectTranscript(lines([row(3, session, 'a')]), session, 'a'),
    projectTranscript(lines([row(5, session, 'b')]), session, 'b'),
  ];
  return { session, ledger, sources };
}
