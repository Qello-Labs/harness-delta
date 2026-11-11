import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { createWindowStartupJournal } from '../scripts/tool-update/codex-window-startup-journal.mjs';
import { recoverWindowQuota } from '../scripts/tool-update/codex-window-quota-recovery.mjs';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Attachment {
  attached: boolean;
  foreignMount: boolean;
  plainDetachFails: boolean;
  detaches: string[][];
  tools: string[];
}

function fixture(options: { readonly image?: boolean; readonly attached?: boolean; readonly record?: boolean } = {}) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'quota-recovery-'));
  roots.push(root);
  chmodSync(root, 0o700);
  const image = join(root, 'volume.sparseimage');
  if (options.image !== false) writeFileSync(image, '', { mode: 0o600 });
  const directory = lstatSync(root);
  const stat = options.image === false ? undefined : lstatSync(image);
  const identity = stat ? { root_dev: directory.dev, root_ino: directory.ino, image_dev: stat.dev, image_ino: stat.ino } : null;
  const journal = createWindowStartupJournal(root);
  journal.append('guardian-ready');
  journal.append('create-begin');
  journal.append('create-complete', options.record === false ? null : identity);
  journal.close();
  const state: Attachment = {
    attached: options.attached ?? true,
    foreignMount: false,
    plainDetachFails: false,
    detaches: [],
    tools: []
  };
  const mounts = join(root, 'mounts');
  const run = (command: string, args: readonly string[], settings: { readonly input?: string } = {}) => {
    state.tools.push(`${command} ${args[0] ?? ''}`.trim());
    if (command === '/usr/bin/plutil') return Promise.resolve({ code: 0, stdout: settings.input ?? '' });
    if (command !== '/usr/bin/hdiutil') throw new Error('unexpected_tool');
    if (args[0] === 'info') {
      const images = state.attached
        ? [
            {
              'image-path': image,
              'system-entities': [
                { 'dev-entry': '/dev/disk70', 'content-hint': 'GUID_partition_scheme' },
                { 'dev-entry': '/dev/disk70s2', 'content-hint': 'Apple_APFS' },
                {
                  'dev-entry': '/dev/disk71s1',
                  'content-hint': 'Apple_APFS',
                  'mount-point': state.foreignMount ? '/Volumes/Elsewhere' : join(mounts, 'HarnessQuotaState')
                }
              ]
            },
            { 'image-path': '/Users/someone/other.dmg', 'system-entities': [{ 'dev-entry': '/dev/disk9' }] }
          ]
        : [{ 'image-path': '/Users/someone/other.dmg', 'system-entities': [{ 'dev-entry': '/dev/disk9' }] }];
      return Promise.resolve({ code: 0, stdout: JSON.stringify({ images }) });
    }
    if (args[0] === 'detach') {
      state.detaches.push([...args]);
      if (state.plainDetachFails && !args.includes('-force')) return Promise.resolve({ code: 1, stdout: '' });
      state.attached = false;
      return Promise.resolve({ code: 0, stdout: '' });
    }
    throw new Error('unexpected_hdiutil_operation');
  };
  return { root, image, identity, state, run };
}

test('recovers an attached image by the journaled identity without any guardian', async () => {
  const f = fixture();
  const result = await recoverWindowQuota(f.root, { run: f.run });
  expect(result).toMatchObject({
    recovered: true,
    detached: true,
    image_deleted: true,
    identity: f.identity,
    identity_source: 'journal',
    journal: { entries: 3, last_phase: 'create-complete' }
  });
  expect(f.state.detaches).toEqual([['detach', '/dev/disk70']]);
  expect(existsSync(f.image)).toBe(false);
  const receipt: unknown = JSON.parse(readFileSync(join(f.root, 'startup-recovery.json'), 'utf8'));
  expect(receipt).toMatchObject({ recovered: true, journal: { entries: 3 } });
});

test('refuses an image whose identity differs from the journal and touches nothing', async () => {
  const f = fixture();
  rmSync(f.image);
  writeFileSync(f.image, 'replacement', { mode: 0o600 });
  await expect(recoverWindowQuota(f.root, { run: f.run })).rejects.toThrow('recovery_identity_mismatch');
  expect(f.state.tools).toEqual([]);
  expect(existsSync(f.image)).toBe(true);
});

test.each(['edited', 'truncated', 'moved'] as const)('refuses a %s journal before any tool runs', async variant => {
  const f = fixture();
  const path = join(f.root, 'startup-journal.jsonl');
  if (variant === 'edited') writeFileSync(path, readFileSync(path, 'utf8').replace('create-begin', 'create-nothing'));
  else if (variant === 'truncated') writeFileSync(path, '');
  else {
    const other = mkdtempSync(join(realpathSync(tmpdir()), 'quota-recovery-'));
    roots.push(other);
    chmodSync(other, 0o700);
    writeFileSync(join(other, 'startup-journal.jsonl'), readFileSync(path));
    writeFileSync(join(other, 'volume.sparseimage'), '', { mode: 0o600 });
    await expect(recoverWindowQuota(other, { run: f.run })).rejects.toThrow('startup_journal_changed');
    expect(f.state.tools).toEqual([]);
    return;
  }
  await expect(recoverWindowQuota(f.root, { run: f.run })).rejects.toThrow('startup_journal_changed');
  expect(f.state.tools).toEqual([]);
  expect(existsSync(f.image)).toBe(true);
});

test('a missing journal is refused rather than inventing ownership', async () => {
  const f = fixture();
  rmSync(join(f.root, 'startup-journal.jsonl'));
  await expect(recoverWindowQuota(f.root, { run: f.run })).rejects.toThrow('startup_journal_changed');
  expect(f.state.tools).toEqual([]);
});

test('an image created before its identity was journaled is bound by the pinned root', async () => {
  const f = fixture({ record: false });
  const result = await recoverWindowQuota(f.root, { run: f.run });
  expect(result).toMatchObject({ recovered: true, detached: true, image_deleted: true, identity: null, identity_source: 'root' });
  expect(existsSync(f.image)).toBe(false);
});

test('nothing attached and nothing created is a verified empty recovery', async () => {
  const f = fixture({ image: false, attached: false });
  const result = await recoverWindowQuota(f.root, { run: f.run });
  expect(result).toMatchObject({ recovered: true, detached: false, image_deleted: false, identity: null });
  expect(f.state.detaches).toEqual([]);
});

test('an unattached leftover image is deleted after positive absence of an attachment', async () => {
  const f = fixture({ attached: false });
  const result = await recoverWindowQuota(f.root, { run: f.run });
  expect(result).toMatchObject({ recovered: true, detached: false, image_deleted: true });
  expect(f.state.detaches).toEqual([]);
  expect(existsSync(f.image)).toBe(false);
});

test('a mount outside the owned mount root is never detached', async () => {
  const f = fixture();
  f.state.foreignMount = true;
  await expect(recoverWindowQuota(f.root, { run: f.run })).rejects.toThrow('recovery_ownership_unverified');
  expect(f.state.detaches).toEqual([]);
  expect(existsSync(f.image)).toBe(true);
});

test('a busy volume falls back to a forced detach of the same whole disk only', async () => {
  const f = fixture();
  f.state.plainDetachFails = true;
  const result = await recoverWindowQuota(f.root, { run: f.run });
  expect(result).toMatchObject({ recovered: true, detached: true });
  expect(f.state.detaches).toEqual([
    ['detach', '/dev/disk70'],
    ['detach', '-force', '/dev/disk70']
  ]);
});

test('the image is not deleted while an attachment remains', async () => {
  const f = fixture();
  const run: typeof f.run = (command, args, settings) => {
    if (command === '/usr/bin/hdiutil' && args[0] === 'detach') {
      f.state.detaches.push([...args]);
      return Promise.resolve({ code: 0, stdout: '' });
    }
    return f.run(command, args, settings);
  };
  await expect(recoverWindowQuota(f.root, { run })).rejects.toThrow('recovery_cleanup_unverified');
  expect(existsSync(f.image)).toBe(true);
});

test('recovery needs an owned private root', async () => {
  const f = fixture();
  chmodSync(f.root, 0o755);
  await expect(recoverWindowQuota(f.root, { run: f.run })).rejects.toThrow('owned_mode_invalid');
  expect(f.state.tools).toEqual([]);
});

test('the journal is only read, never appended to, by recovery', async () => {
  const f = fixture();
  const before = readFileSync(join(f.root, 'startup-journal.jsonl'), 'utf8');
  await recoverWindowQuota(f.root, { run: f.run });
  expect(readFileSync(join(f.root, 'startup-journal.jsonl'), 'utf8')).toBe(before);
});
