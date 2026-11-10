import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import {
  reserveWindowConsent,
  revalidateWindowConsent,
  snapshotWindowExecutorPins,
  verifyWindowConsent,
  writeConsentedWindowEmission
} from '../scripts/tool-update/codex-window-consent.mjs';
import { createSyntheticWindowCollection } from '../scripts/tool-update/codex-window-collection.mjs';
import { runCodexWindowHook } from './helpers/codex-window-hook-fixture.js';
import { appendFileSync } from 'node:fs';

const roots: string[] = [];

test('a consent-bound synthetic case uses genuine exact-root trial and collection APIs without product authority', async () => {
  const f = fixture();
  const now = Date.now();
  writeFileSync(
    f.consentFile,
    JSON.stringify({
      ...f.consent,
      issued_at: now,
      expires_at: now + 60000
    })
  );
  const capability = reserveWindowConsent({
    intentFile: f.intentFile,
    consentFile: f.consentFile,
    observedPins: f.pins
  });
  const session = createSyntheticWindowCollection(capability, f.pins);
  try {
    const source = join(session.sourceRoot, 'root.jsonl');
    const nativeId = 'synthetic-exact-root';
    writeFileSync(
      source,
      JSON.stringify({
        type: 'session_meta',
        payload: {
          id: nativeId,
          session_id: nativeId,
          cli_version: '0.167.0',
          cwd: session.projectRoot,
          source: 'cli'
        }
      }) + '\n',
      { mode: 0o600 }
    );
    const hook = await runCodexWindowHook({
      projectRoot: session.projectRoot,
      receiptDirectory: session.receiptDirectory,
      nativePrefixes: [session.sourceRoot],
      input: {
        hook_event_name: 'SessionStart',
        source: 'startup',
        session_id: nativeId,
        cwd: session.projectRoot,
        transcript_path: source
      }
    });
    expect(hook.effects).toEqual({
      nativeCalls: 0,
      processCalls: 0,
      operations: []
    });
    const receipt = hook.receipts[0];
    if (!receipt) throw new Error('synthetic_receipt_missing');
    await session.connect(receipt);
    const timestamp = new Date().toISOString();
    appendFileSync(
      source,
      [
        {
          type: 'turn_context',
          timestamp,
          payload: {
            cwd: session.projectRoot,
            turn_id: 'turn',
            root_turn_id: 'turn',
            model: 'gpt-6.1-sol',
            effort: 'high'
          }
        },
        {
          type: 'token_usage_record',
          timestamp,
          payload: {
            thread_id: nativeId,
            session_id: nativeId,
            turn_id: 'turn',
            root_turn_id: 'turn',
            response_id: 'synthetic-response',
            usage: {
              input_tokens: 100,
              cached_input_tokens: 10,
              output_tokens: 20,
              reasoning_output_tokens: 5,
              total_tokens: 120
            }
          }
        }
      ]
        .map(row => JSON.stringify(row))
        .join('\n') + '\n'
    );
    await session.collect();
    await session.collect();
    expect(session.store.eventCount()).toBe(1);
    expect(session.store.all('SELECT * FROM comparison_assignments')).toEqual([]);
    expect(session.store.get('SELECT decision_kind,trial_native_root_id,trial_tokens_consumed FROM ordinary_window_activations')).toMatchObject({
      decision_kind: 'trial',
      trial_native_root_id: nativeId,
      trial_tokens_consumed: 120
    });
    renameSync(f.consentFile, join(f.root, 'revoked.json'));
    await expect(session.collect()).rejects.toThrow('consent_storage_invalid');
    expect(session.store.eventCount()).toBe(1);
  } finally {
    session.close();
  }
});
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test('emission is bound to a reserved external packet and closes on revocation without source authority', () => {
  const f = fixture();
  vi.useFakeTimers();
  vi.setSystemTime(2000);
  mkdirSync(join(f.root, 'project'), { mode: 0o700 });
  const capability = reserveWindowConsent({
    intentFile: f.intentFile,
    consentFile: f.consentFile,
    observedPins: f.pins
  });
  const control = writeConsentedWindowEmission(capability, f.pins);
  try {
    expect(control).toMatchObject({
      authority: 'none',
      origin: 'synthetic',
      actual_qualification: false
    });
    control.check();
    renameSync(f.consentFile, join(f.root, 'revoked.json'));
    expect(() => control.check()).toThrow('consent_storage_invalid');
    expect(JSON.parse(readFileSync(join(f.root, 'project/.harness-delta/window-receipts/ordinary-window-control.json'), 'utf8'))).toMatchObject({
      state: 'inactive'
    });
  } finally {
    control.close();
  }
});

test.each(['expiry', 'intent_replacement', 'consent_replacement', 'reservation_removed', 'pin_drift'])(
  'reserved capabilities are rechecked for %s at use',
  variant => {
    const f = fixture();
    vi.useFakeTimers();
    vi.setSystemTime(2000);
    const capability = reserveWindowConsent({
      intentFile: f.intentFile,
      consentFile: f.consentFile,
      observedPins: f.pins
    });
    expect(revalidateWindowConsent(capability, f.pins)).toMatchObject({
      origin: 'synthetic',
      authority: 'none'
    });
    let observed = f.pins;
    if (variant === 'expiry') vi.setSystemTime(f.consent.expires_at);
    else if (variant === 'reservation_removed') {
      renameSync(join(f.root, '.codex-window-launch-reservation.json'), join(f.root, 'revoked.json'));
    } else if (variant === 'pin_drift') {
      observed = { ...f.pins, native: 'f'.repeat(64) };
    } else {
      const path = variant === 'intent_replacement' ? f.intentFile : f.consentFile;
      const copy = join(f.root, 'replacement.json');
      writeFileSync(copy, readFileSync(path), { mode: 0o600 });
      renameSync(copy, path);
    }
    expect(() => revalidateWindowConsent(capability, observed)).toThrow(/consent_expired|consent_mismatch|consent_storage_invalid|pin_drift/);
  }
);

test('the real verification command refuses a forged approval without attempting execution', () => {
  const f = fixture();
  writeFileSync(f.consentFile, JSON.stringify({ approved: true }));
  const result = spawnSync(
    process.execPath,
    [resolve('scripts/tool-update/codex-window-conformance.mjs'), 'verify-consent', '--intent', f.intentFile, '--consent', f.consentFile],
    {
      encoding: 'utf8',
      timeout: 20_000,
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }
    }
  );
  expect(result.status).toBe(2);
  expect(JSON.parse(result.stdout)).toEqual({
    status: 'refused',
    code: 'consent_invalid',
    execution_attempted: false,
    actual_qualification: false
  });
  expect(existsSync(join(f.root, '.codex-window-launch-reservation.json'))).toBe(false);
  expect(result.stderr).toBe('');
}, 20_000);
const pinNames = ['native', 'host', 'source', 'build', 'instrument', 'runtime', 'lockfile', 'config', 'environment', 'egress', 'quota'];
function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'window-consent-'));
  roots.push(root);
  const pins = Object.fromEntries(pinNames.map((name, index) => [name, String(index % 10).repeat(64)]));
  const intent = {
    schema_version: 1,
    kind: 'codex_window_disabled_intent',
    authority: 'none',
    execution_enabled: false,
    actual_qualification: false,
    case_id: 'normal',
    case_root: root,
    plan_digest: 'a'.repeat(64),
    plan: {
      schema_version: 1,
      product: 'codex',
      version: '0.167.0',
      commit: '086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a',
      route: 'codex_binding',
      policy_id: 'codex-binding-root-window-v1',
      operation: 'collect',
      topology: 'root',
      runtime: 'node24',
      platform: 'darwin_arm64',
      model: 'gpt-6.1-sol',
      effort: 'high',
      pins
    },
    owner_ms: 120000,
    cleanup_ms: 5000,
    audit_reserve_ms: 10000,
    containment_qualified: false
  };
  const intentBytes = JSON.stringify(intent);
  const intentSha256 = createHash('sha256').update(intentBytes).digest('hex');
  const consent = {
    schema_version: 1,
    kind: 'codex_window_b1_consent',
    consent_id: randomUUID(),
    approval_reference: 'b'.repeat(64),
    issued_at: 1000,
    expires_at: 100000,
    intent_sha256: intentSha256,
    case_id: 'normal',
    case_root: root,
    product: 'codex',
    version: '0.167.0',
    operation: 'collect',
    topology: 'root',
    pins
  };
  const intentFile = join(root, 'intent.json');
  const consentFile = join(root, 'consent.json');
  writeFileSync(intentFile, intentBytes, { mode: 0o600 });
  writeFileSync(consentFile, JSON.stringify(consent), { mode: 0o600 });
  const context = {
    intentSha256,
    caseRoot: root,
    caseId: 'normal',
    pins,
    now: 2000
  };
  return { root, pins, intent, consent, intentFile, consentFile, context };
}

test('real file preflight rehashes every scoped executor input instead of trusting a cached caller pin', () => {
  const f = fixture();
  const prefix = join(f.root, 'prefix');
  const caseRoot = join(f.root, 'cases/normal');
  mkdirSync(prefix, { mode: 0o700 });
  mkdirSync(caseRoot, { mode: 0o700, recursive: true });
  const inputs = {
    batch_root: f.root,
    prefix_root: prefix,
    native_path: join(prefix, 'synthetic-native'),
    host_path: join(prefix, 'synthetic-host'),
    config_path: join(caseRoot, 'config.json'),
    environment_path: join(caseRoot, 'environment.json'),
    profile_path: join(f.root, 'profile.sb'),
    quota_packet_path: join(f.root, 'quota.json')
  };
  const files = [inputs.native_path, inputs.host_path, inputs.config_path, inputs.environment_path, inputs.profile_path, inputs.quota_packet_path];
  for (const path of files) {
    writeFileSync(path, 'synthetic-only', { mode: 0o600 });
  }
  const scopedIntent = {
    ...f.intent,
    case_root: caseRoot,
    plan: { ...f.intent.plan, inputs }
  };
  const pins = snapshotWindowExecutorPins(scopedIntent);
  const bytes = JSON.stringify({
    ...scopedIntent,
    plan: { ...scopedIntent.plan, pins }
  });
  const intentFile = join(caseRoot, 'intent.json');
  const consentFile = join(caseRoot, 'consent.json');
  const now = Date.now();
  writeFileSync(intentFile, bytes, { mode: 0o600 });
  writeFileSync(
    consentFile,
    JSON.stringify({
      ...f.consent,
      case_root: caseRoot,
      pins,
      issued_at: now,
      expires_at: now + 60000,
      intent_sha256: createHash('sha256').update(bytes).digest('hex')
    }),
    { mode: 0o600 }
  );
  const capability = reserveWindowConsent({ intentFile, consentFile });
  expect(revalidateWindowConsent(capability)).toMatchObject({
    origin: 'local_verified_inputs',
    authority: 'none'
  });
  expect(() => createSyntheticWindowCollection(capability, pins)).toThrow('b1_execution_disabled');
  for (const path of files) {
    appendFileSync(path, '-changed');
    expect(() => revalidateWindowConsent(capability, pins)).toThrow('pin_drift');
    writeFileSync(path, 'synthetic-only');
  }
});

test('an external packet is accepted only for its exact frozen intent and pin binding', () => {
  const f = fixture();
  expect(verifyWindowConsent(f.consent, f.context)).toMatchObject({
    intent_sha256: f.context.intentSha256,
    case_root: f.root
  });
});

test.each([undefined, {}, { approved: true }, { schema_version: 2 }])('malformed or merely asserted approval does not verify %#', packet => {
  expect(() => verifyWindowConsent(packet, fixture().context)).toThrow('consent_invalid');
});

test.each(pinNames)('refuses %s pin drift before any launch reservation', name => {
  const f = fixture();
  const changed = { ...f.pins, [name]: 'f'.repeat(64) };
  expect(() => verifyWindowConsent(f.consent, { ...f.context, pins: changed })).toThrow('consent_mismatch');
  expect(existsSync(join(f.root, '.codex-window-launch-reservation.json'))).toBe(false);
});

test.each(['expired', 'future', 'wrong_hash', 'wrong_root', 'child', 'extra'])('refuses %s consent', variant => {
  const f = fixture();
  const packet = {
    ...f.consent,
    ...(variant === 'expired' ? { expires_at: 2000 } : {}),
    ...(variant === 'future' ? { issued_at: 2001 } : {}),
    ...(variant === 'wrong_hash' ? { intent_sha256: 'f'.repeat(64) } : {}),
    ...(variant === 'wrong_root' ? { case_root: '/wrong' } : {}),
    ...(variant === 'child' ? { topology: 'bounded_family' } : {}),
    ...(variant === 'extra' ? { approved: true } : {})
  };
  expect(() => verifyWindowConsent(packet, f.context)).toThrow(/consent_invalid|consent_expired|consent_mismatch/);
});

test('the exclusive durable reservation rejects replay even with a copied packet or a new nonce', () => {
  const f = fixture();
  const capability = reserveWindowConsent({
    intentFile: f.intentFile,
    consentFile: f.consentFile,
    now: 2000,
    observedPins: f.pins
  });
  expect(JSON.stringify(capability)).toBe('{}');
  expect(() =>
    reserveWindowConsent({
      intentFile: f.intentFile,
      consentFile: f.consentFile,
      now: 2000,
      observedPins: f.pins
    })
  ).toThrow('consent_reused');
  writeFileSync(f.consentFile, JSON.stringify({ ...f.consent, consent_id: randomUUID() }));
  expect(() =>
    reserveWindowConsent({
      intentFile: f.intentFile,
      consentFile: f.consentFile,
      now: 2000,
      observedPins: f.pins
    })
  ).toThrow('consent_reused');
});

test('same-JSON byte drift in a frozen intent cannot reuse its old consent hash', () => {
  const f = fixture();
  writeFileSync(f.intentFile, readFileSync(f.intentFile, 'utf8') + '\n');
  expect(() =>
    reserveWindowConsent({
      intentFile: f.intentFile,
      consentFile: f.consentFile,
      now: 2000,
      observedPins: f.pins
    })
  ).toThrow('consent_mismatch');
});

test.each(['mode', 'symlink'])('refuses unsafe %s packet storage before reservation', variant => {
  const f = fixture();
  let consentFile = f.consentFile;
  if (variant === 'mode') chmodSync(consentFile, 0o644);
  else {
    consentFile = join(f.root, 'alias.json');
    symlinkSync(f.consentFile, consentFile);
  }
  expect(() =>
    reserveWindowConsent({
      intentFile: f.intentFile,
      consentFile,
      now: 2000,
      observedPins: f.pins
    })
  ).toThrow('consent_storage_invalid');
  expect(existsSync(join(f.root, '.codex-window-launch-reservation.json'))).toBe(false);
});
