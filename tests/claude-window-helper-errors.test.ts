import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';
import { bounded, observedProcess } from '../scripts/tool-update/fixtures.mjs';
import { installClaudeConnectInstallation, previewClaudeConnectInstallation } from '../src/connect/claude-connect-installation.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const effectsSchema = z.object({
  kind: z.literal('effects'),
  effects: z.object({
    ownedReads: z.number(),
    unauthorizedCalls: z.number(),
    nativeCalls: z.number(),
    processCalls: z.number(),
    metadataWrites: z.number(),
    operations: z.array(z.string())
  }),
  attempts: z.number(),
  connections: z.number(),
  requests: z.array(z.object({ method: z.string() }))
});

async function invoke(error: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'claude-helper-errors-')));
  roots.push(root);
  const projectRoot = join(root, 'project');
  mkdirSync(projectRoot, { mode: 0o700 });
  const options = {
    bundleMode: 'ordinary_window' as const,
    packageRoot: resolve('skills/harness-connect'),
    windowPackageRoot: resolve('skills/harness-connect-window-claude')
  };
  const preview = previewClaudeConnectInstallation(projectRoot, options);
  expect(preview.blockers).toEqual([]);
  expect(
    installClaudeConnectInstallation(projectRoot, {
      ...options,
      expectedPackageHash: preview.packageHash,
      expectedInstalledHash: preview.installedHash
    }).state
  ).toBe('installed');
  const script = join(projectRoot, '.claude/skills/harness-connect/scripts/connect-window.mjs');
  const origin = 'http://127.0.0.1:43210';
  const project = 'synthetic-project';
  const task = 'synthetic-task';
  const receipt = '11111111-1111-4111-8111-111111111111';
  let stdout = '';
  let stderr = '';
  let ledger: z.infer<typeof effectsSchema> | undefined;
  const launched = observedProcess(
    process.execPath,
    [
      '--import',
      resolve('tests/helpers/claude-window-launcher.mjs'),
      script,
      'connect',
      '--origin',
      origin,
      '--project',
      project,
      '--task',
      task,
      '--receipt',
      receipt
    ],
    {
      env: {
        ...process.env,
        CLAUDE_WINDOW_FIXTURE: JSON.stringify({
          script,
          nativePrefixes: ['/proc', '/dev/fd'],
          scenario: {
            origin,
            project,
            task,
            receipt,
            csrf: 'a'.repeat(64),
            serverError: error,
            view: {
              schema_version: 1,
              kind: 'claude_window_task',
              project_id: project,
              task_id: task,
              version: `"${'b'.repeat(64)}"`,
              state: 'active',
              connection_enabled: true,
              reason: null,
              selected_root_id: null
            }
          }
        })
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    },
    child => {
      child.once('spawn', () => {
        child.stdout?.on('data', (chunk: Buffer) => {
          stdout += chunk.toString();
        });
        child.stderr?.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
        });
      });
      child.on('message', (message: unknown) => {
        const parsed = effectsSchema.safeParse(message);
        if (parsed.success) ledger = parsed.data;
      });
    }
  );
  let code: number | null;
  try {
    [code] = await bounded(launched.closed, 10000);
  } catch (failure) {
    launched.child.kill('SIGKILL');
    throw failure;
  }
  expect(code).toBe(1);
  expect(stderr).toBe('');
  expect(ledger?.effects).toEqual({ ownedReads: 0, unauthorizedCalls: 0, nativeCalls: 0, processCalls: 0, metadataWrites: 0, operations: [] });
  expect([ledger?.attempts, ledger?.connections, ledger?.requests.map(request => request.method)]).toEqual([1, 0, ['GET', 'POST']]);
  const result: unknown = JSON.parse(stdout);
  return result;
}

test.each([
  'binding_executable_identity_unverified',
  'binding_executable_changed',
  'binding_contract_failed',
  'binding_source_version_mismatch',
  'binding_ownership_unverified',
  'binding_configuration_invalid',
  'binding_source_limit',
  'binding_usage_invalid',
  'binding_cursor_invalid'
])('installed helper preserves fixed server failure %s without native effects or retries', async error => {
  expect(await invoke(error)).toEqual({ status: 'blocked', reason_code: error, verified: false });
});

test.each(['binding_future_code', 'binding_source_unavailable /SYNTHETIC_PRIVATE', '/SYNTHETIC_PRIVATE', 'binding_executable_changed\nSECRET'])(
  'installed helper masks unregistered or private server failure %s',
  async error => {
    expect(await invoke(error)).toEqual({ status: 'blocked', reason_code: 'local_ui_request_failed', verified: false });
  }
);
