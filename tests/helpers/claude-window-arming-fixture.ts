import { closeSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { bounded, observedProcess } from '../../scripts/tool-update/fixtures.mjs';
import { Store } from '../../src/store.js';
import { Lifecycle } from '../../src/core/lifecycle.js';
import { createOrdinaryWindowTask } from '../../src/ordinary-observation.js';
import { installCodexConnectInstallation, previewCodexConnectInstallation } from '../../src/connect/codex-connect-installation.js';
import { ordinaryWindowDecisionKeyForSelection } from '../../src/core/ordinary-window-activation.js';
import { publishOrdinaryWindowEmissionControl } from '../../src/ordinary-window-emission.js';
import { ClaudeWindowPendingReceiptSchema } from '../../src/session-binding-claude.js';
import { installClaudeConnectInstallation, previewClaudeConnectInstallation } from '../../src/connect/claude-connect-installation.js';
import { createClaudeWindowFixture } from './claude-window-fixture.js';
import { runCodexWindowHook } from './codex-window-hook-fixture.js';

const effectsSchema = z.object({
  kind: z.literal('effects'),
  effects: z.object({
    ownedReads: z.number(),
    unauthorizedCalls: z.number(),
    nativeCalls: z.number(),
    processCalls: z.number(),
    metadataWrites: z.number(),
    operations: z.array(z.string())
  })
});

export function createClaudeWindowArmingFixture(install = true) {
  const base = createClaudeWindowFixture();
  // The hook, not the connection fixture's emit helper, must supply every selected receipt.
  rmSync(join(base.receiptDirectory, `${base.receipt.receipt}.json`));
  base.life.start(base.taskId);
  const database = join(base.directory, 'store.sqlite');
  base.store.execute('VACUUM INTO ?', [database]);
  const store = new Store(database);
  publishOrdinaryWindowEmissionControl(store, ordinaryWindowDecisionKeyForSelection(base.selection), new Date().toISOString());
  const installationOptions = { bundleMode: 'ordinary_window' } as const;
  if (install) {
    const preview = previewClaudeConnectInstallation(base.projectRoot, installationOptions);
    const installed = installClaudeConnectInstallation(base.projectRoot, {
      ...installationOptions,
      expectedPackageHash: preview.packageHash,
      expectedInstalledHash: preview.installedHash
    });
    if (installed.state !== 'installed') throw new Error('fixture_claude_installation_failed');
  }
  const scripts = join(base.projectRoot, '.claude/skills/harness-connect/scripts');
  base.binary.state.pid = process.pid;
  const options = {
    ...base.options,
    store,
    clock: () => new Date().toISOString(),
    binaryAdapters: {
      ...base.binary.adapters,
      readProcess: (pid: number) => {
        const metadata = base.binary.adapters.readProcess(pid === process.pid ? 3107 : pid);
        return metadata === null ? null : { ...metadata, pid };
      }
    }
  };
  return {
    ...base,
    store,
    database,
    options,
    scripts,
    controlPath: join(base.receiptDirectory, 'ordinary-window-control.json'),
    input: {
      hook_event_name: 'SessionStart',
      session_id: base.nativeSessionId,
      cwd: base.projectRoot,
      transcript_path: base.sourcePath,
      prompt: 'SYNTHETIC_PRIVATE_SENTINEL'
    },
    run: (args: string[]) =>
      runCodexWindowHook({
        scriptPath: resolve('tests/helpers/ordinary-window-report-cli.mjs'),
        receiptDirectory: base.receiptDirectory,
        projectRoot: base.projectRoot,
        nativePrefixes: [base.claudeProjectsDirectory],
        args: [],
        input: ['--db', database, ...args]
      }),
    packet: (value: unknown) => {
      const path = join(base.directory, 'packet.json');
      writeFileSync(path, JSON.stringify(value));
      return path;
    },
    cleanup: () => {
      store.close();
      base.cleanup();
    }
  };
}

export function createCodexArmingSibling(f: ReturnType<typeof createClaudeWindowArmingFixture>) {
  const options = { bundleMode: 'ordinary_window', productVersion: '0.167.0', sourceRoots: [f.claudeProjectsDirectory] } as const;
  const preview = previewCodexConnectInstallation(f.projectRoot, options);
  const installed = installCodexConnectInstallation(f.projectRoot, {
    ...options,
    expectedPackageHash: preview.packageHash,
    expectedInstalledHash: preview.installedHash
  });
  if (installed.state !== 'installed') throw new Error('fixture_codex_installation_failed');
  const taskId = createOrdinaryWindowTask(f.store, {
    schema_version: 2,
    mode: 'ordinary_window',
    project_id: f.selection.projectId,
    product: 'codex',
    declared_version: '0.167.0',
    policy_id: 'codex-binding-root-window-v1',
    criterion_ids: ['accepted']
  });
  new Lifecycle(f.store).start(taskId);
  return taskId;
}

export async function runClaudeArmingHook(
  f: ReturnType<typeof createClaudeWindowArmingFixture>,
  options: {
    readonly input?: unknown;
    readonly afterControlRead?: () => void | Promise<void>;
  } = {}
) {
  const script = join(f.scripts, 'claude-window-session-hook.mjs');
  const bootstrap = join(f.scripts, 'claude-connect-config.mjs');
  const fd = openSync(f.sourcePath, 'r');
  let stdout = '',
    stderr = '',
    ready = false,
    transitioned = false;
  let ledger: z.infer<typeof effectsSchema> | undefined;
  let transition: Promise<void> | undefined;
  const launched = observedProcess(
    process.execPath,
    ['--import', resolve('tests/helpers/claude-window-launcher.mjs'), script, 'record'],
    {
      env: {
        ...process.env,
        HARNESS_DELTA_CLAUDE_WINDOW_RECEIPT_DIR: undefined,
        CLAUDE_CONFIG_DIR: f.claudeProjectsDirectory,
        CLAUDE_WINDOW_FIXTURE: JSON.stringify({
          script,
          codeFiles: [bootstrap],
          directory: f.receiptDirectory,
          nativePrefixes: [f.claudeProjectsDirectory, '/proc', '/dev/fd']
        })
      },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc', fd]
    },
    child => {
      const sendInput = () => {
        child.stdin?.end(JSON.stringify(options.input ?? f.input));
      };
      child.once('spawn', () => {
        child.stdout?.on('data', (chunk: Buffer) => {
          stdout += chunk.toString();
        });
        child.stderr?.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        child.stdin?.on('error', error => {
          if (!('code' in error) || error.code !== 'EPIPE') throw error;
        });
      });
      child.on('message', (message: unknown) => {
        if (z.object({ kind: z.literal('ready') }).safeParse(message).success) {
          ready = true;
          if (!options.afterControlRead) sendInput();
        }
        if (!transitioned && options.afterControlRead && z.object({ kind: z.literal('control_read') }).safeParse(message).success) {
          transitioned = true;
          transition = Promise.resolve().then(options.afterControlRead).then(sendInput);
          void transition.catch(() => child.kill('SIGKILL'));
        }
        const parsed = effectsSchema.safeParse(message);
        if (parsed.success) ledger = parsed.data;
      });
    }
  );
  closeSync(fd);
  let code: number | null;
  try {
    [code] = await bounded(launched.closed, 10000);
    await transition;
  } catch (error) {
    launched.child.kill('SIGKILL');
    throw error;
  }
  if (!ready || !ledger || (options.afterControlRead && !transitioned)) {
    throw new Error('claude_window_arming_missing_signal', { cause: { code, stderr } });
  }
  const receipts = readdirSync(f.receiptDirectory)
    .filter(name => /^[a-f0-9-]{36}\.json$/.test(name))
    .map(name => ClaudeWindowPendingReceiptSchema.parse(JSON.parse(readFileSync(join(f.receiptDirectory, name), 'utf8'))));
  return { code, stdout, stderr, effects: ledger.effects, receipts };
}
