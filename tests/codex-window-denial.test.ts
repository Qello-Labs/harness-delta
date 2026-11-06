import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';
import { CodexWindowPendingReceiptSchema } from '../src/session-binding-codex.js';
import { codexWindowControl, runCodexWindowHook } from './helpers/codex-window-hook-fixture.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});
const resultSchema = z.object({
  outcome: z.string(),
  providerCalls: z.object({
    factory: z.number(),
    pending: z.number(),
    inspect: z.number(),
    revalidate: z.number(),
    read: z.number()
  }),
  events: z.number(),
  proofs: z.number(),
  bindings: z.number(),
  replay: z.number(),
  exclusions: z.number(),
  pins: z.number()
});
async function fixture() {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'codex-window-denial-'));
  directories.push(directory);
  const projectRoot = join(directory, 'project');
  const receiptDirectory = join(projectRoot, '.harness-delta', 'window-receipts');
  const sourceRoot = join(directory, 'native');
  const assetRoot = join(directory, 'vendor-assets');
  for (const path of [receiptDirectory, sourceRoot, assetRoot]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  const source = join(sourceRoot, 'root.jsonl');
  writeFileSync(
    source,
    JSON.stringify({
      type: 'session_meta',
      payload: {
        id: 'native-root',
        session_id: 'native-root',
        cli_version: '0.167.0',
        cwd: projectRoot,
        source: 'cli'
      }
    }) + '\n'
  );
  writeFileSync(join(receiptDirectory, 'ordinary-window-control.json'), JSON.stringify(codexWindowControl(projectRoot)), { mode: 0o600 });
  const helper = await runCodexWindowHook({
    projectRoot,
    receiptDirectory,
    nativePrefixes: [sourceRoot, assetRoot],
    input: {
      hook_event_name: 'SessionStart',
      session_id: 'native-root',
      cwd: projectRoot,
      transcript_path: source,
      source: 'startup'
    }
  });
  expect(helper.code).toBe(0);
  expect(helper.effects).toEqual({
    nativeCalls: 0,
    processCalls: 0,
    operations: []
  });
  const pending = CodexWindowPendingReceiptSchema.parse(helper.receipts[0]);
  return {
    directory,
    sourceRoot,
    assetRoot,
    projectRoot,
    receiptDirectory,
    helper,
    run: async (authority: string, entry = 'internal_connect', nativePrefixes = [sourceRoot, assetRoot], metadataDirectory = receiptDirectory) => {
      const provider = await runCodexWindowHook({
        receiptDirectory: metadataDirectory,
        projectRoot,
        nativePrefixes,
        scriptPath: resolve('tests/helpers/codex-window-provider-denial.mjs'),
        stdin: JSON.stringify({
          authority,
          entry,
          projectRoot,
          receiptDirectory: metadataDirectory,
          sourceRoot,
          receipt: pending.receipt,
          recordedAt: pending.recordedAt
        })
      });
      expect(provider.code).toBe(0);
      return {
        ...provider,
        result: resultSchema.parse(JSON.parse(provider.stdout))
      };
    }
  };
}

test.each([
  'absent',
  'revoked',
  'wrong_project',
  'wrong_task',
  'wrong_product',
  'wrong_policy',
  'wrong_revision',
  'stale_implementation',
  'wrong_digest',
  'wrong_mode',
  'inactive_task'
])('stale active helper control cannot authorize native or process access with %s Store authority', async authority => {
  const f = await fixture();
  const provider = await f.run(authority);
  expect(provider.effects).toEqual({
    nativeCalls: 0,
    processCalls: 0,
    operations: []
  });
  expect(provider.result.providerCalls).toEqual({
    factory: 0,
    pending: 0,
    inspect: 0,
    revalidate: 0,
    read: 0
  });
  expect(provider.result.outcome).not.toBe('connected');
  expect(provider.result).toMatchObject({
    events: 0,
    proofs: 0,
    bindings: 0,
    replay: 0,
    exclusions: 0,
    pins: 0
  });
});

test.each(['ordinary_public', 'assigned_public'])('keeps %s closed even with valid synthetic Store authority and stale active helper control', async entry => {
  const f = await fixture();
  const provider = await f.run('active', entry);
  expect(provider.effects).toEqual({
    nativeCalls: 0,
    processCalls: 0,
    operations: []
  });
  expect(provider.result).toMatchObject({
    outcome: 'binding_window_unavailable',
    providerCalls: {
      factory: 0,
      pending: 0,
      inspect: 0,
      revalidate: 0,
      read: 0
    },
    events: 0,
    proofs: 0,
    bindings: 0,
    replay: 0,
    exclusions: 0,
    pins: 0
  });
});

test('requires an issued callback rather than a wrapper around otherwise valid authority', async () => {
  const f = await fixture();
  const provider = await f.run('active', 'forged_authorization');
  expect(provider.effects).toEqual({
    nativeCalls: 0,
    processCalls: 0,
    operations: []
  });
  expect(provider.result).toMatchObject({
    outcome: 'binding_scope_revoked',
    events: 0,
    proofs: 0,
    bindings: 0,
    replay: 0,
    pins: 0
  });
});

test('the same subprocess oracle observes real authorized source access without process or native-asset inspection', async () => {
  const f = await fixture();
  const before = readFileSync(join(f.sourceRoot, 'root.jsonl'));
  const provider = await f.run('active');
  expect(provider.result).toMatchObject({
    outcome: 'connected',
    events: 0,
    proofs: 1,
    bindings: 1,
    pins: 1
  });
  expect(provider.effects.nativeCalls).toBeGreaterThan(0);
  expect(provider.effects.processCalls).toBe(0);
  expect(provider.effects.operations).toContain('openSync');
  expect(readFileSync(join(f.sourceRoot, 'root.jsonl'))).toEqual(before);
  const assets = await f.run('active', 'internal_connect', [f.assetRoot]);
  expect(assets.result.outcome).toBe('connected');
  expect(assets.effects).toEqual({
    nativeCalls: 0,
    processCalls: 0,
    operations: []
  });
});

test('checks owned ancestor symlinks before touching an aliased native metadata directory', async () => {
  const f = await fixture();
  const nativeMetadata = join(f.sourceRoot, 'receipts');
  mkdirSync(nativeMetadata, { mode: 0o700 });
  for (const name of ['ordinary-window-control.json', `${CodexWindowPendingReceiptSchema.parse(f.helper.receipts[0]).receipt}.json`]) {
    writeFileSync(join(nativeMetadata, name), readFileSync(join(f.receiptDirectory, name)), { mode: 0o600 });
  }
  const alias = join(f.projectRoot, '.harness-delta', 'native-alias');
  symlinkSync(f.sourceRoot, alias, 'dir');
  const metadataDirectory = join(alias, 'receipts');
  const prefixes = [f.sourceRoot, metadataDirectory];
  const helper = await runCodexWindowHook({
    projectRoot: f.projectRoot,
    receiptDirectory: metadataDirectory,
    nativePrefixes: prefixes,
    input: {
      hook_event_name: 'SessionStart',
      session_id: 'native-root',
      cwd: f.projectRoot,
      transcript_path: join(f.sourceRoot, 'root.jsonl'),
      source: 'startup'
    }
  });
  expect(helper.effects).toEqual({
    nativeCalls: 0,
    processCalls: 0,
    operations: []
  });
  const provider = await f.run('active', 'internal_connect', prefixes, metadataDirectory);
  expect(provider.effects).toEqual({
    nativeCalls: 0,
    processCalls: 0,
    operations: []
  });
  expect(provider.result).toMatchObject({
    outcome: 'binding_metadata_untrusted',
    events: 0,
    proofs: 0,
    bindings: 0,
    pins: 0
  });
});

test('rejects a historical native tombstone before source inspection and rolls back the acquiring reservation', async () => {
  const f = await fixture();
  const provider = await f.run('native_deleted');
  expect(provider.effects).toEqual({ nativeCalls: 0, processCalls: 0, operations: [] });
  expect(provider.result).toMatchObject({
    outcome: 'deleted_identifier',
    events: 0,
    proofs: 0,
    bindings: 0,
    replay: 0,
    exclusions: 0,
    pins: 0,
    providerCalls: { inspect: 0, revalidate: 0, read: 0 }
  });
});

test('retains Codex source access when the identical native ID is positively scoped to deletion of the other product', async () => {
  const f = await fixture();
  const provider = await f.run('other_product_deleted');
  expect(provider.result).toMatchObject({ outcome: 'connected', events: 0, proofs: 1, bindings: 1, pins: 1 });
  expect(provider.effects.nativeCalls).toBeGreaterThan(0);
  expect(provider.effects.processCalls).toBe(0);
});

test('refuses a bounded owned receipt FIFO without waiting for a writer or opening a native source', async () => {
  const f = await fixture();
  const pending = CodexWindowPendingReceiptSchema.parse(f.helper.receipts[0]);
  const path = join(f.receiptDirectory, `${pending.receipt}.json`);
  unlinkSync(path);
  execFileSync('mkfifo', [path], { timeout: 5000 });
  chmodSync(path, 0o600);
  const provider = await f.run('active');
  expect(provider.effects).toEqual({ nativeCalls: 0, processCalls: 0, operations: [] });
  expect(provider.result).toMatchObject({ outcome: 'binding_metadata_untrusted', events: 0, proofs: 0, bindings: 0, pins: 0 });
});

test.each(['selection_deleted', 'scope_rows_deleted'])(
  'orphan window %s cannot return cached, static or newly constructed public providers',
  async authority => {
    const f = await fixture();
    for (const entry of ['web_factory', 'web_cached', 'web_static']) {
      const provider = await f.run(authority, entry);
      expect(provider.effects).toEqual({ nativeCalls: 0, processCalls: 0, operations: [] });
      expect(provider.result).toMatchObject({
        outcome: 'binding_window_unavailable',
        providerCalls: { factory: 0, pending: 0, inspect: 0, revalidate: 0, read: 0 },
        events: 0,
        proofs: 0,
        bindings: 0,
        pins: 0
      });
    }
  }
);
