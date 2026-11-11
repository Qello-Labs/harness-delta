import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { createWindowResourceRegistry, verifyWindowCleanup, verifyWindowResourceRegistry } from '../scripts/tool-update/codex-window-registry.mjs';

const roots: string[] = [];
const registries: ReturnType<typeof createWindowResourceRegistry>[] = [];
afterEach(() => {
  for (const registry of registries.splice(0)) registry.close();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'window-registry-'));
  roots.push(root);
  const caseRoot = join(root, 'cases', 'normal');
  mkdirSync(caseRoot, { recursive: true, mode: 0o700 });
  const registry = createWindowResourceRegistry({
    root: caseRoot,
    caseId: 'normal',
    batchStartedMs: 0
  });
  registries.push(registry);
  const resource = join(caseRoot, 'owned-state');
  writeFileSync(resource, 'synthetic', { mode: 0o600 });
  registry.recordPath(resource);
  return { root, caseRoot, registry, resource };
}

test('cleanup requires positive absence of every recorded path', async () => {
  const f = fixture();
  const reference = f.registry.seal();
  await expect(verifyWindowResourceRegistry(reference)).rejects.toThrow('cleanup_unverified');
});

test('a sealed registry proves closure only after its recorded resource disappears', async () => {
  const f = fixture();
  const reference = f.registry.seal();
  unlinkSync(f.resource);
  expect(await verifyWindowResourceRegistry(reference)).toEqual({
    closedResources: 1,
    caseId: 'normal'
  });
});

test.each(['missing', 'edited', 'appended', 'replaced', 'symlink'] as const)('cleanup refuses a %s sealed registry', async variant => {
  const f = fixture();
  const reference = f.registry.seal();
  unlinkSync(f.resource);
  const original = readFileSync(reference.registry_path);
  switch (variant) {
    case 'missing':
      unlinkSync(reference.registry_path);
      break;
    case 'edited':
      writeFileSync(reference.registry_path, original.toString().replace('owned-state', 'other-state'));
      break;
    case 'appended':
      appendFileSync(reference.registry_path, '{}\n');
      break;
    case 'replaced':
      renameSync(reference.registry_path, reference.registry_path + '.old');
      writeFileSync(reference.registry_path, original, {
        mode: 0o600
      });
      break;
    case 'symlink':
      renameSync(reference.registry_path, reference.registry_path + '.old');
      symlinkSync(reference.registry_path + '.old', reference.registry_path);
      break;
  }
  await expect(verifyWindowResourceRegistry(reference)).rejects.toThrow('registry_invalid');
});

test('the live writer refuses an edited chain before appending another resource', () => {
  const f = fixture();
  appendFileSync(join(f.caseRoot, '.codex-window-resources.jsonl'), '{}\n');
  expect(() => f.registry.recordPath(f.resource)).toThrow('registry_invalid');
});

test('registry ownership cannot follow a path outside its case or through a symlink', () => {
  const f = fixture();
  const outside = join(f.root, 'outside');
  writeFileSync(outside, 'synthetic', { mode: 0o600 });
  const alias = join(f.caseRoot, 'alias');
  symlinkSync(outside, alias);
  expect(() => f.registry.recordPath(outside)).toThrow('resource_scope_invalid');
  expect(() => f.registry.recordPath(alias)).toThrow('resource_scope_invalid');
  f.registry.seal();
});

test('a still-present recorded PID cannot be declared gone by a cleanup boolean', async () => {
  const f = fixture();
  f.registry.recordPid({
    pid: process.pid,
    uid: process.getuid?.() ?? -1,
    started: 'synthetic-current-process'
  });
  const reference = f.registry.seal();
  unlinkSync(f.resource);
  await expect(verifyWindowResourceRegistry(reference)).rejects.toThrow('cleanup_unverified');
});

test('an image attachment must disappear independently of deletion of its image path', async () => {
  const f = fixture();
  f.registry.recordImage({ path: f.resource, devices: ['/dev/disk99999'] });
  const reference = f.registry.seal();
  unlinkSync(f.resource);
  await expect(
    verifyWindowResourceRegistry(reference, {
      attachedImages: () => Promise.resolve([f.resource])
    })
  ).rejects.toThrow('cleanup_unverified');
});

function cleanupPacket(f: ReturnType<typeof fixture>) {
  const reference = f.registry.seal();
  unlinkSync(f.resource);
  const consentFile = join(f.root, 'cleanup-consent.json');
  const packet = {
    schema_version: 1,
    kind: 'codex_window_cleanup_consent',
    consent_id: randomUUID(),
    approval_reference: 'a'.repeat(64),
    issued_at: 1000,
    expires_at: 5000,
    batch_root: f.root,
    batch_started_continuous_ms: 0,
    batch_deadline_continuous_ms: 1200000,
    registries: [reference]
  };
  writeFileSync(consentFile, JSON.stringify(packet), { mode: 0o600 });
  return { consentFile, packet };
}

test('cleanup accepts a bound external packet without requiring an active trial', async () => {
  const f = fixture();
  const { consentFile } = cleanupPacket(f);
  expect(
    await verifyWindowCleanup({
      batchRoot: f.root,
      consentFile,
      now: () => 2000,
      continuousNow: () => 2000
    })
  ).toMatchObject({
    status: 'cleanup_verified',
    registries: 1,
    closed_resources: 1,
    execution_attempted: false
  });
});

test('cleanup cannot extend the frozen twenty minute batch deadline', async () => {
  const f = fixture();
  const { consentFile, packet } = cleanupPacket(f);
  writeFileSync(consentFile, JSON.stringify({ ...packet, batch_deadline_continuous_ms: 1200001 }));
  await expect(
    verifyWindowCleanup({
      batchRoot: f.root,
      consentFile,
      now: () => 2000,
      continuousNow: () => 2000
    })
  ).rejects.toThrow('cleanup_consent_invalid');
});

test('cleanup cannot omit another consumed case registry', async () => {
  const f = fixture();
  const { consentFile } = cleanupPacket(f);
  const otherRoot = join(f.root, 'cases', 'sigint');
  mkdirSync(otherRoot, { mode: 0o700 });
  const other = createWindowResourceRegistry({
    root: otherRoot,
    caseId: 'sigint',
    batchStartedMs: 0
  });
  other.seal();
  await expect(
    verifyWindowCleanup({
      batchRoot: f.root,
      consentFile,
      now: () => 2000,
      continuousNow: () => 2000
    })
  ).rejects.toThrow('registry_invalid');
});

test.each(['expired', 'wrong_root', 'foreign_mode', 'duplicate_case'] as const)('cleanup rejects %s external authority', async variant => {
  const f = fixture();
  const { consentFile, packet } = cleanupPacket(f);
  const changed = {
    ...packet,
    expires_at: variant === 'expired' ? 2000 : 5000,
    batch_root: variant === 'wrong_root' ? f.caseRoot : f.root,
    registries: variant === 'duplicate_case' ? [packet.registries[0], packet.registries[0]] : packet.registries
  };
  writeFileSync(consentFile, JSON.stringify(changed));
  if (variant === 'foreign_mode') chmodSync(consentFile, 0o644);
  await expect(
    verifyWindowCleanup({
      batchRoot: f.root,
      consentFile,
      now: () => 2000,
      continuousNow: () => 2000
    })
  ).rejects.toThrow('cleanup_consent_invalid');
});

test('the cleanup command rejects expired consent before any native clock or resource inspection', () => {
  const f = fixture();
  const { consentFile } = cleanupPacket(f);
  const result = spawnSync(
    process.execPath,
    [resolve('scripts/tool-update/codex-window-conformance.mjs'), 'verify-cleanup', '--batch', f.root, '--consent', consentFile],
    {
      encoding: 'utf8',
      timeout: 20_000,
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }
    }
  );
  expect(result.status).toBe(2);
  expect(JSON.parse(result.stdout)).toMatchObject({
    status: 'refused',
    code: 'cleanup_consent_invalid',
    execution_attempted: false
  });
}, 20_000);
