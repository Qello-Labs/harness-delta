import { mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { codexWindowControl, runCodexWindowHook } from './helpers/codex-window-hook-fixture.js';
import { createCodexWindowProviderFixture } from './helpers/codex-window-provider-fixture.js';

const forms = ['canonical', 'dotdot', 'alias-dotdot', 'dot', 'separators', 'leaf-alias', 'intermediate-alias'] as const;
const pathCases = (['receipt-directory', 'project-root'] as const).flatMap(option => forms.map(form => ({ option, form })));

test.each(pathCases)('keeps $option $form configuration inside owned metadata storage', async ({ option, form }) => {
  const f = await createCodexWindowProviderFixture({ activate: false });
  try {
    f.lifecycle.start(f.taskId);
    expect(f.store.all('SELECT * FROM ordinary_window_activations')).toEqual([]);
    const before = f.snapshot();
    const nativeReceipts = join(f.sourceRoot, 'window-receipts');
    const nativeChild = join(f.sourceRoot, 'subdirectory');
    mkdirSync(nativeReceipts);
    mkdirSync(nativeChild);
    writeFileSync(join(nativeReceipts, 'codex-window-native-entry'), '');
    const aliases = {
      receiptParent: join(dirname(f.receiptDirectory), 'native-alias'),
      receiptLeaf: join(dirname(f.receiptDirectory), 'receipt-alias'),
      receiptIntermediate: join(dirname(f.receiptDirectory), 'metadata-alias'),
      projectParent: join(f.projectRoot, 'native-alias'),
      projectLeaf: join(f.directory, 'project-alias'),
      projectIntermediate: join(f.directory, 'project-container-alias')
    };
    symlinkSync(nativeChild, aliases.receiptParent, 'dir');
    symlinkSync(nativeReceipts, aliases.receiptLeaf, 'dir');
    symlinkSync(f.sourceRoot, aliases.receiptIntermediate, 'dir');
    symlinkSync(nativeChild, aliases.projectParent, 'dir');
    symlinkSync(f.projectRoot, aliases.projectLeaf, 'dir');
    symlinkSync(f.sourceRoot, aliases.projectIntermediate, 'dir');
    const base = option === 'receipt-directory' ? f.receiptDirectory : f.projectRoot;
    let raw: string;
    switch (form) {
      case 'canonical':
        raw = base;
        break;
      case 'dotdot':
        raw = base + '/../' + basename(base);
        break;
      case 'alias-dotdot':
        raw = option === 'receipt-directory' ? aliases.receiptParent + '/../window-receipts' : aliases.projectParent + '/..';
        break;
      case 'dot':
        raw = base + '/.';
        break;
      case 'separators':
        raw = dirname(base) + '//' + basename(base);
        break;
      case 'leaf-alias':
        raw = option === 'receipt-directory' ? aliases.receiptLeaf : aliases.projectLeaf;
        break;
      case 'intermediate-alias':
        raw = option === 'receipt-directory' ? aliases.receiptIntermediate + '/window-receipts' : aliases.projectIntermediate + '/project';
        break;
    }
    const projectRoot = option === 'project-root' ? raw : f.projectRoot;
    const receiptDirectory =
      option === 'receipt-directory'
        ? raw
        : form === 'leaf-alias' || form === 'intermediate-alias'
          ? raw + '/.harness-delta/window-receipts'
          : f.receiptDirectory;
    writeFileSync(join(f.receiptDirectory, 'ordinary-window-control.json'), JSON.stringify(codexWindowControl(projectRoot)), { mode: 0o600 });
    const beforeReceipts = readdirSync(f.receiptDirectory).filter(name => /^[0-9a-f-]{36}\.json$/.test(name));
    const result = await runCodexWindowHook({
      projectRoot: f.projectRoot,
      receiptDirectory: f.receiptDirectory,
      args: ['--receipt-directory', receiptDirectory, '--project-root', projectRoot],
      nativePrefixes: [f.sourceRoot, f.assetRoot],
      nativeAliases: [
        { path: aliases.receiptParent, target: nativeChild },
        { path: aliases.receiptLeaf, target: nativeReceipts },
        { path: aliases.receiptIntermediate, target: f.sourceRoot },
        { path: aliases.projectParent, target: nativeChild },
        { path: aliases.projectLeaf, target: f.projectRoot },
        { path: aliases.projectIntermediate, target: f.sourceRoot }
      ],
      nativeEntryNames: ['codex-window-native-entry'],
      scriptPath: resolve('tests/helpers/codex-window-directory-witness.mjs'),
      input: { hook_event_name: 'SessionStart', session_id: 'native-root', cwd: f.projectRoot, transcript_path: f.sourcePath, source: 'startup' }
    });
    expect({
      nativeEnumerationWitness: result.stderr.includes('CODEX_WINDOW_NATIVE_ENUMERATION'),
      classifiedNativeCalls: result.effects.nativeCalls,
      processCalls: result.effects.processCalls
    }).toEqual({ nativeEnumerationWitness: false, classifiedNativeCalls: 0, processCalls: 0 });
    expect(result.code).toBe(form === 'canonical' ? 0 : 1);
    expect(result.receipts).toHaveLength(beforeReceipts.length + (form === 'canonical' ? 1 : 0));
    expect(readdirSync(nativeReceipts)).toEqual(['codex-window-native-entry']);
    expect(f.snapshot()).toEqual(before);
  } finally {
    f.cleanup();
  }
});

test.each(['raw-alias', 'actual-entry'] as const)('raw traversal oracle observes native access by %s', async observation => {
  const f = await createCodexWindowProviderFixture({ activate: false });
  try {
    const nativeReceipts = join(f.sourceRoot, 'window-receipts');
    const target = join(f.sourceRoot, 'subdirectory');
    mkdirSync(nativeReceipts);
    mkdirSync(target);
    writeFileSync(join(nativeReceipts, 'codex-window-native-entry'), '');
    const alias = join(dirname(f.receiptDirectory), 'native-alias');
    symlinkSync(target, alias, 'dir');
    const raw = alias + '/../window-receipts';
    const result = await runCodexWindowHook({
      receiptDirectory: f.receiptDirectory,
      projectRoot: f.projectRoot,
      args: [raw],
      scriptPath: resolve('tests/helpers/codex-window-directory-probe.mjs'),
      nativePrefixes: observation === 'raw-alias' ? [f.sourceRoot] : [],
      nativeAliases: observation === 'raw-alias' ? [{ path: alias, target }] : [],
      nativeEntryNames: observation === 'actual-entry' ? ['codex-window-native-entry'] : []
    });
    expect(result.code).toBe(0);
    expect(result.effects).toEqual({
      nativeCalls: observation === 'raw-alias' ? 3 : 1,
      processCalls: 0,
      operations: observation === 'raw-alias' ? ['opendirSync', 'Dir.readSync', 'Dir.readSync'] : ['Dir.readSync']
    });
  } finally {
    f.cleanup();
  }
});
