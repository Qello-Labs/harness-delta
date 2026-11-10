import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { reserveSyntheticWindowEmission, writeWindowEmissionControl } from '../scripts/tool-update/codex-window-conformance.mjs';
import { runCodexWindowHook } from './helpers/codex-window-hook-fixture.js';
import { Store } from '../src/store.js';
import { Lifecycle } from '../src/core/lifecycle.js';
import { ordinaryWindowDigest, ordinaryWindowPolicies } from '../src/core/ordinary-window-policy.js';
import { publishOrdinaryWindowEmissionControl } from '../src/ordinary-window-emission.js';

const directories: string[] = [];
test('the unchanged production publisher stays inactive without a recorded decision', () => {
  const f = fixture();
  const store = new Store(':memory:');
  try {
    new Lifecycle(store).registerProject('synthetic-project', f.projectRoot);
    const policy = ordinaryWindowPolicies.find(value => value.policyId === 'codex-binding-root-window-v1');
    if (!policy) throw new Error('fixture_policy_missing');
    expect(
      publishOrdinaryWindowEmissionControl(
        store,
        {
          project_id: 'synthetic-project',
          product: 'codex',
          source: policy.source,
          policy_id: policy.policyId,
          policy_revision: policy.ruleRevision,
          policy_digest: ordinaryWindowDigest(policy),
          evidence_mode: policy.evidenceMode
        },
        new Date().toISOString()
      )
    ).toMatchObject({
      state: 'inactive',
      runtime_authority: false
    });
    expect(JSON.parse(readFileSync(join(f.projectRoot, '.harness-delta/window-receipts/ordinary-window-control.json'), 'utf8'))).toMatchObject({
      state: 'inactive'
    });
  } finally {
    store.close();
  }
});
afterEach(() => {
  vi.useRealTimers();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});
function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'window-control-'));
  directories.push(root);
  const projectRoot = join(root, 'project');
  mkdirSync(projectRoot, { mode: 0o700 });
  const expiresAt = Date.now() + 60000;
  return {
    root,
    projectRoot,
    expiresAt,
    consent: {
      origin: 'synthetic',
      case_id: 'source_receipt_loading',
      project_root: projectRoot,
      expires_at: expiresAt
    }
  };
}

test.each(['check_then_close', 'close_only'])('a substituted receipt-directory symlink refuses at %s without outside enumeration', operation => {
  const f = fixture();
  const outside = fixture();
  const control = writeWindowEmissionControl(reserveSyntheticWindowEmission(f));
  const directory = join(f.projectRoot, '.harness-delta/window-receipts');
  const archived = join(f.projectRoot, '.harness-delta/original-receipts');
  for (let index = 0; index < 17; index += 1) {
    writeFileSync(join(outside.root, `${index}.json`), 'outside-sentinel');
  }
  renameSync(directory, archived);
  symlinkSync(outside.root, directory, 'dir');
  try {
    if (operation === 'check_then_close') {
      expect(() => control.check()).toThrow('receipt_storage_changed');
    }
  } finally {
    expect(() => control.close()).toThrow('receipt_storage_changed');
  }
  expect(JSON.parse(readFileSync(join(archived, 'ordinary-window-control.json'), 'utf8'))).toMatchObject({ state: 'active' });
});

test.each(['check_then_close', 'close_only'])('a byte-identical replacement control refuses at %s without rewriting it', operation => {
  const f = fixture();
  const control = writeWindowEmissionControl(reserveSyntheticWindowEmission(f));
  const path = join(f.projectRoot, '.harness-delta/window-receipts/ordinary-window-control.json');
  const bytes = readFileSync(path);
  renameSync(path, join(f.root, 'original-control.json'));
  writeFileSync(path, bytes, { mode: 0o600 });
  try {
    if (operation === 'check_then_close') {
      expect(() => control.check()).toThrow('control_storage_changed');
    }
  } finally {
    expect(() => control.close()).toThrow('control_storage_changed');
  }
  expect(readFileSync(path)).toEqual(bytes);
});

test.each(['directory_mode', 'control_mode', 'control_size', 'control_bytes'])('use-time %s drift refuses without inactivating unproven storage', variant => {
  const f = fixture();
  const control = writeWindowEmissionControl(reserveSyntheticWindowEmission(f));
  const directory = join(f.projectRoot, '.harness-delta/window-receipts');
  const path = join(directory, 'ordinary-window-control.json');
  if (variant === 'directory_mode') chmodSync(directory, 0o755);
  else if (variant === 'control_mode') chmodSync(path, 0o644);
  else if (variant === 'control_size') {
    writeFileSync(path, Buffer.alloc(4097));
  } else {
    writeFileSync(path, readFileSync(path, 'utf8').replace('"active"', '"xxxxxx"'));
  }
  const bytes = readFileSync(path);
  const code = variant === 'directory_mode' ? 'receipt_storage_changed' : 'control_storage_changed';
  try {
    expect(() => control.check()).toThrow(code);
  } finally {
    expect(() => control.close()).toThrow(code);
  }
  expect(readFileSync(path)).toEqual(bytes);
});

test('the subprocess access oracle detects a deliberately bad disposable hook copy', async () => {
  const f = fixture();
  const native = join(f.root, 'native-sentinel');
  writeFileSync(native, '', { mode: 0o600 });
  const control = writeWindowEmissionControl(reserveSyntheticWindowEmission(f));
  try {
    const copy = join(f.root, 'bad-hook.mjs');
    writeFileSync(copy, readFileSync('scripts/session-binding-codex-window-hook.mjs', 'utf8') + `\nlstatSync(${JSON.stringify(native)});\n`, { mode: 0o600 });
    const result = await runCodexWindowHook({
      projectRoot: f.projectRoot,
      receiptDirectory: join(f.projectRoot, '.harness-delta/window-receipts'),
      scriptPath: copy,
      nativePrefixes: [native],
      input: {
        hook_event_name: 'SessionStart',
        source: 'startup',
        session_id: 'synthetic-root',
        cwd: f.projectRoot,
        transcript_path: native
      }
    });
    expect(result.effects).toEqual({
      nativeCalls: 1,
      processCalls: 0,
      operations: ['lstatSync']
    });
  } finally {
    control.close();
  }
});

test('the private emission control enables the unchanged metadata hook without granting source authority', async () => {
  const f = fixture();
  const reservation = reserveSyntheticWindowEmission(f);
  const control = writeWindowEmissionControl(reservation);
  const directory = join(f.projectRoot, '.harness-delta/window-receipts');
  expect(lstatSync(directory).mode & 0o777).toBe(0o700);
  expect(lstatSync(join(directory, 'ordinary-window-control.json')).mode & 0o777).toBe(0o600);
  const native = join(f.root, 'unread-native');
  mkdirSync(native, { mode: 0o700 });
  const helper = await runCodexWindowHook({
    projectRoot: f.projectRoot,
    receiptDirectory: directory,
    nativePrefixes: [native],
    input: {
      hook_event_name: 'SessionStart',
      source: 'startup',
      session_id: 'synthetic-root',
      cwd: f.projectRoot,
      transcript_path: join(native, 'absent.jsonl')
    }
  });
  expect(helper.code).toBe(0);
  expect(helper.receipts).toHaveLength(1);
  expect(helper.effects).toEqual({
    nativeCalls: 0,
    processCalls: 0,
    operations: []
  });
  expect(JSON.parse(readFileSync(join(directory, 'ordinary-window-control.json'), 'utf8'))).toEqual({
    schemaVersion: 1,
    projectRoot: f.projectRoot,
    product: 'codex',
    policyId: 'codex-binding-root-window-v1',
    policyRevision: 'codex-ordinary-root-window-v1',
    evidenceMode: 'source_only',
    state: 'active'
  });
  control.close();
  const stopped = await runCodexWindowHook({
    projectRoot: f.projectRoot,
    receiptDirectory: directory,
    input: {
      hook_event_name: 'SessionStart',
      source: 'startup',
      session_id: 'later-root',
      cwd: f.projectRoot,
      transcript_path: join(native, 'absent.jsonl')
    }
  });
  expect(stopped.receipts).toHaveLength(1);
  expect(control.authority).toBe('none');
});

test('forged, serialized and reused process-local reservations cannot write a control', () => {
  const f = fixture();
  const reservation = reserveSyntheticWindowEmission(f);
  expect(() => writeWindowEmissionControl({})).toThrow('consent_invalid');
  expect(() => writeWindowEmissionControl(z.record(z.string(), z.unknown()).parse(JSON.parse(JSON.stringify(reservation))))).toThrow('consent_invalid');
  const control = writeWindowEmissionControl(reservation);
  expect(() => writeWindowEmissionControl(reservation)).toThrow('consent_invalid');
  control.close();
});

test('receipt admission stops at the seventeenth entry without reading or rewriting receipt bytes', () => {
  const f = fixture();
  const control = writeWindowEmissionControl(reserveSyntheticWindowEmission(f));
  const directory = join(f.projectRoot, '.harness-delta/window-receipts');
  try {
    for (let index = 0; index < 16; index += 1) {
      writeFileSync(join(directory, `${index}.json`), 'synthetic', {
        mode: 0o600
      });
    }
    control.check();
    writeFileSync(join(directory, 'overflow.json'), 'untouched-sentinel', {
      mode: 0o600
    });
    expect(() => control.check()).toThrow('receipt_limit');
    expect(readFileSync(join(directory, 'overflow.json'), 'utf8')).toBe('untouched-sentinel');
    expect(JSON.parse(readFileSync(join(directory, 'ordinary-window-control.json'), 'utf8'))).toMatchObject({ state: 'inactive' });
  } finally {
    control.close();
  }
});

test.each(['expired', 'wrong_project', 'extra_key', 'not_synthetic'])('refuses %s consent before creating storage', variant => {
  const f = fixture();
  const consent = {
    ...f.consent,
    ...(variant === 'expired' ? { expires_at: Date.now() } : {}),
    ...(variant === 'wrong_project' ? { project_root: f.root } : {}),
    ...(variant === 'extra_key' ? { approved: true } : {}),
    ...(variant === 'not_synthetic' ? { origin: 'actual' } : {})
  };
  expect(() => reserveSyntheticWindowEmission({ ...f, consent })).toThrow('consent_invalid');
});

test('expiry inactivates the control without waiting for another runner operation', () => {
  vi.useFakeTimers();
  const f = fixture();
  const control = writeWindowEmissionControl(reserveSyntheticWindowEmission(f));
  vi.advanceTimersByTime(60000);
  expect(
    z.object({ state: z.string() }).parse(JSON.parse(readFileSync(join(f.projectRoot, '.harness-delta/window-receipts/ordinary-window-control.json'), 'utf8')))
      .state
  ).toBe('inactive');
  expect(() => control.check()).toThrow('consent_expired');
});

test.each(['symlink', 'mode', 'existing_control'])('refuses unsafe %s storage without modifying its contents', variant => {
  const f = fixture();
  if (variant === 'mode') chmodSync(f.projectRoot, 0o755);
  if (variant === 'symlink') {
    symlinkSync(f.root, join(f.projectRoot, '.harness-delta'), 'dir');
  }
  if (variant === 'existing_control') {
    mkdirSync(join(f.projectRoot, '.harness-delta/window-receipts'), {
      recursive: true,
      mode: 0o700
    });
    writeFileSync(join(f.projectRoot, '.harness-delta/window-receipts/ordinary-window-control.json'), 'historical-bytes', { mode: 0o600 });
  }
  expect(() => writeWindowEmissionControl(reserveSyntheticWindowEmission(f))).toThrow();
  if (variant === 'existing_control') {
    expect(readFileSync(join(f.projectRoot, '.harness-delta/window-receipts/ordinary-window-control.json'), 'utf8')).toBe('historical-bytes');
  }
});
