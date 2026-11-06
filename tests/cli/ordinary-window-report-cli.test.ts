import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { Store } from '../../src/store.js';
import { codexWindowControl, runCodexWindowHook } from '../helpers/codex-window-hook-fixture.js';
import { windowReportCutoff, windowReportFixture } from '../helpers/ordinary-window-report-fixture.js';

function savedEffects(store: Store) {
  return {
    activations: store.all('SELECT * FROM ordinary_window_activations'),
    selections: store.all('SELECT * FROM ordinary_window_selections'),
    coverage: store.all('SELECT * FROM ordinary_window_segments'),
    segments: store.all('SELECT * FROM binding_root_segments'),
    bindings: store.all('SELECT * FROM session_bindings'),
    tasks: store.all('SELECT * FROM tasks'),
    ...{
      events: store.all('SELECT * FROM events'),
      replay: store.all('SELECT * FROM binding_requests'),
      exclusions: store.all('SELECT * FROM binding_baseline_exclusions'),
      pins: store.all('SELECT * FROM session_source_compatibility')
    }
  };
}

test.each(['codex', 'claude_code'] as const)(
  'real CLI reports %s saved evidence without any unauthorized read or process call',
  async product => {
    const f = windowReportFixture(product);
    const directory = mkdtempSync(join(tmpdir(), 'window-report-cli-'));
    const database = join(directory, 'report.sqlite');
    try {
      f.life.start(f.taskId);
      f.put('reference', 'compatibility_unverified', { zero: true, model: product === 'codex' ? 'gpt-6.1-sol' : 'claude-opus-5-5' });
      const before = savedEffects(f.store);
      f.store.execute('VACUUM INTO ?', [database]);
      writeFileSync(join(directory, 'ordinary-window-control.json'), JSON.stringify(codexWindowControl('/synthetic/window-project')));
      const run = (args: string[]) =>
        runCodexWindowHook({
          scriptPath: resolve('tests/helpers/ordinary-window-report-cli.mjs'),
          receiptDirectory: directory,
          projectRoot: '/synthetic/window-project',
          nativePrefixes: ['/synthetic'],
          args: [],
          input: ['--db', database, ...args]
        });
      const args = ['report', 'ordinary-window', f.taskId, '--cutoff', windowReportCutoff];
      const json = await run(args);
      expect(json.effects).toEqual({ nativeCalls: 0, processCalls: 0, operations: [] });
      expect(json.code).toBe(0);
      const report: unknown = JSON.parse(json.stdout);
      expect(report).toMatchObject({
        mode: 'ordinary_window',
        schema_version: 3,
        inference: false,
        collection: { state: 'disabled', reason: 'binding_window_activation_required' },
        usage: { verified: { partial_tokens: null }, compatibility_unverified: { partial_tokens: 0 } },
        cost: { verified: { partial_amount: null }, compatibility_unverified: { partial_amount: '0' } }
      });
      const markdown = await run([...args, '--format', 'markdown']);
      expect(markdown.effects).toEqual({ nativeCalls: 0, processCalls: 0, operations: [] });
      expect(markdown.code).toBe(0);
      const embedded = markdown.stdout.split('```json\n')[1]?.split('\n```')[0];
      expect(JSON.parse(embedded ?? 'null') as unknown).toEqual(report);
      const status = await run(['compatibility', 'ordinary-window', 'status', f.taskId]);
      expect(status.effects).toEqual({ nativeCalls: 0, processCalls: 0, operations: [] });
      expect(status.code).toBe(0);
      expect(JSON.parse(status.stdout) as unknown).toMatchObject({
        report_version: 'ordinary-window-status-v1',
        coverage: { status: 'missing', segments: [] },
        collection: { state: 'disabled', reason: 'binding_window_activation_required' }
      });
      const denied = await run(['report', 'task', f.taskId, '--cutoff', windowReportCutoff]);
      expect(denied.effects).toEqual({ nativeCalls: 0, processCalls: 0, operations: [] });
      expect(denied.code).toBe(2);
      expect(denied.stderr).toBe('binding_window_activation_required\n');
      const after = new Store(database);
      try {
        expect(savedEffects(after)).toEqual(before);
      } finally {
        after.close();
      }
      expect(json.stdout + markdown.stdout + status.stdout).not.toContain('/synthetic/');
      expect(f.calls).toEqual([]);
    } finally {
      f.store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
  20000
);

test.each([
  { args: ['report', 'ordinary-window', 'absent', '--cutoff', windowReportCutoff] },
  { args: ['compatibility', 'ordinary-window', 'status', 'absent'] },
  { args: ['compatibility', 'ordinary-window', 'activate', '--packet', 'synthetic-packet'] }
])('CLI refuses unavailable input without a decision writer: $args', async ({ args }) => {
  const directory = mkdtempSync(join(tmpdir(), 'window-report-refusal-'));
  const database = join(directory, 'report.sqlite');
  const store = new Store(database);
  store.close();
  try {
    const result = await runCodexWindowHook({
      scriptPath: resolve('tests/helpers/ordinary-window-report-cli.mjs'),
      receiptDirectory: directory,
      projectRoot: '/synthetic/window-project',
      nativePrefixes: ['/synthetic'],
      args: [],
      input: ['--db', database, ...args]
    });
    expect(result.effects).toEqual({ nativeCalls: 0, processCalls: 0, operations: [] });
    expect(result.code).toBe(2);
    const after = new Store(database);
    try {
      expect(after.all('SELECT * FROM ordinary_window_activations')).toEqual([]);
    } finally {
      after.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
