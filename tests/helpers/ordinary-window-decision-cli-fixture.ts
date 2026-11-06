import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store } from '../../src/store.js';
import type { ordinaryWindowFixture } from './ordinary-window-fixture.js';
import { runCodexWindowHook } from './codex-window-hook-fixture.js';

export function prepareOrdinaryWindowDecisionCliFixture(f: ReturnType<typeof ordinaryWindowFixture>, directory: string) {
  const product = f.selection.policy.product;

  const projectRoot = join(directory, 'project');
  const sourceRoot = join(directory, 'native');
  for (const path of [projectRoot, sourceRoot]) {
    mkdirSync(path, { mode: 0o700 });
  }
  f.store.execute('UPDATE projects SET local_root=? WHERE id=?', [projectRoot, 'project']);
  f.life.start(f.taskId);
  const database = join(directory, 'store.sqlite');
  f.store.execute('VACUUM INTO ?', [database]);

  const receiptDirectory = join(projectRoot, '.harness-delta', product === 'codex' ? 'window-receipts' : 'claude-window-receipts');
  const controlPath = join(receiptDirectory, 'ordinary-window-control.json');
  const packetPath = join(directory, 'packet.json');
  const run = (args: string[], aliases: readonly { path: string; target: string }[] = []) =>
    runCodexWindowHook({
      scriptPath: resolve('tests/helpers/ordinary-window-report-cli.mjs'),
      receiptDirectory: directory,
      projectRoot,
      nativePrefixes: [sourceRoot],
      nativeAliases: aliases,
      args: [],
      input: ['--db', database, ...args]
    });
  const packet = (value: unknown) => {
    writeFileSync(packetPath, JSON.stringify(value));
    return packetPath;
  };
  const rows = () => {
    const stored = new Store(database);
    try {
      return {
        decisions: stored.all('SELECT * FROM ordinary_window_activations'),
        tasks: stored.all('SELECT * FROM tasks'),
        settings: stored.all('SELECT * FROM ordinary_tasks'),
        sessions: stored.all('SELECT * FROM sessions'),
        segments: stored.all('SELECT * FROM binding_root_segments'),
        proofs: stored.all('SELECT * FROM ordinary_window_segments'),
        bindings: stored.all('SELECT * FROM session_bindings'),
        replay: stored.all('SELECT * FROM binding_requests'),
        exclusions: stored.all('SELECT * FROM binding_baseline_exclusions'),
        events: stored.all('SELECT * FROM events'),
        pins: stored.all('SELECT * FROM session_source_compatibility')
      };
    } finally {
      stored.close();
    }
  };
  return {
    ...f,
    directory,
    projectRoot,
    sourceRoot,
    database,
    receiptDirectory,
    controlPath,
    run,
    packet,
    rows
  };
}
