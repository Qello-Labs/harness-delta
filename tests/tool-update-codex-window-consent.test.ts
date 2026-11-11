import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { deriveWindowNativeRecipe } from '../scripts/tool-update/codex-window-native-recipe.mjs';
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
  vi.restoreAllMocks();
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
  const caseRoot = join(f.root, 'cases/normal');
  const { inputs } = nativeFixture(f.root);
  const files = [inputs.native_path, inputs.host_path, inputs.config_path, inputs.environment_path, inputs.profile_path, inputs.quota_packet_path];
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
    const original = readFileSync(path);
    appendFileSync(path, '-changed');
    expect(() => revalidateWindowConsent(capability, pins)).toThrow('pin_drift');
    writeFileSync(path, original);
  }
});

test.each(['launcher', 'tool', 'interpreter', 'process', 'runtime_data', 'host_root', 'node_root', 'environment_markers'])(
  'native preflight refuses omitted or extra %s closure',
  variant => {
    const f = fixture();
    const n = nativeFixture(f.root);
    const intent = {
      ...f.intent,
      case_root: join(f.root, 'cases/normal'),
      plan: { ...f.intent.plan, inputs: n.inputs }
    };
    if (variant === 'launcher') {
      n.manifest.files = n.manifest.files.filter(row => row.role !== 'launcher');
    }
    if (variant === 'tool') {
      const tool = n.manifest.files.find(row => row.role === 'system_tool');
      if (!tool) throw new Error('fixture_tool_missing');
      tool.path = n.toolPath;
    }
    if (variant === 'interpreter') {
      n.manifest.process_paths.push(realpathSync(process.execPath));
    }
    if (variant === 'process') {
      n.manifest.process_paths.push(n.denied[0] ?? '');
    }
    if (variant === 'runtime_data') {
      n.manifest.runtime_paths = n.manifest.runtime_paths.filter(path => path !== n.toolPath);
    }
    if (variant === 'host_root') {
      n.manifest.argv = [n.inputs.host_path];
      writeFileSync(n.argvPath, JSON.stringify(n.manifest.argv));
      const argv = n.manifest.files.find(row => row.role === 'argv');
      if (!argv) throw new Error('fixture_argv_missing');
      argv.size = lstatSync(n.argvPath).size;
      argv.sha256 = sha256(n.argvPath);
    }
    if (variant === 'node_root') {
      n.manifest.argv = [realpathSync(process.execPath), join(n.inputs.prefix_root, 'node_modules/@openai/codex/bin/codex.js'), '--version'];
      writeFileSync(n.argvPath, JSON.stringify(n.manifest.argv));
      const argv = n.manifest.files.find(row => row.role === 'argv');
      if (!argv) throw new Error('fixture_argv_missing');
      argv.size = lstatSync(n.argvPath).size;
      argv.sha256 = sha256(n.argvPath);
    }
    if (variant === 'environment_markers') {
      writeFileSync(
        n.inputs.environment_path,
        JSON.stringify({
          CODEX_MANAGED_BY_NPM: '0',
          CODEX_MANAGED_BY_BUN: '1'
        })
      );
      const environment = n.manifest.files.find(row => row.role === 'environment');
      if (!environment) throw new Error('fixture_environment_missing');
      environment.size = lstatSync(n.inputs.environment_path).size;
      environment.sha256 = sha256(n.inputs.environment_path);
    }
    n.freezeManifest();
    expect(() => snapshotWindowExecutorPins(intent)).toThrow('pin_drift');
  }
);

test.each(['different_major', 'missing_major', 'missing_controller'])('native preflight refuses a frozen controller runtime with %s', variant => {
  const f = fixture();
  const n = nativeFixture(f.root);
  const intent = {
    ...f.intent,
    case_root: join(f.root, 'cases/normal'),
    plan: { ...f.intent.plan, inputs: n.inputs }
  };
  expect(() => snapshotWindowExecutorPins(intent)).not.toThrow();
  if (variant === 'different_major') {
    n.manifest.controller_runtime.node_major += 1;
  } else if (variant === 'missing_major') {
    Reflect.deleteProperty(n.manifest.controller_runtime, 'node_major');
  } else {
    Reflect.deleteProperty(n.manifest, 'controller_runtime');
  }
  n.freezeManifest();
  expect(() => snapshotWindowExecutorPins(intent)).toThrow('pin_drift');
});

test('native preflight refuses an omitted loaded Node interpreter dependency', () => {
  const f = fixture();
  const dependency = join(f.root, 'synthetic-loaded-dependency.dylib');
  writeFileSync(dependency, 'synthetic-runtime-dependency', { mode: 0o600 });
  const n = nativeFixture(f.root, [dependency]);
  const intent = {
    ...f.intent,
    case_root: join(f.root, 'cases/normal'),
    plan: { ...f.intent.plan, inputs: n.inputs }
  };
  expect(() => snapshotWindowExecutorPins(intent)).not.toThrow();
  n.manifest.files = n.manifest.files.filter(row => row.path !== dependency);
  n.manifest.runtime_paths = n.manifest.runtime_paths.filter(path => path !== dependency);
  n.freezeManifest();
  expect(() => snapshotWindowExecutorPins(intent)).toThrow('pin_drift');
});

test.each(['inode', 'target'])('native preflight binds runtime alias %s identity', variant => {
  const f = fixture();
  const n = nativeFixture(f.root);
  const alias = join(f.root, 'runtime-alias');
  symlinkSync(n.toolPath, alias);
  const stat = lstatSync(alias, { bigint: true });
  const row = {
    path: alias,
    mode: Number(stat.mode & 0o7777n),
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    target: n.toolPath
  };
  n.manifest.runtime_links.push(row);
  n.freezeManifest();
  const intent = {
    ...f.intent,
    case_root: join(f.root, 'cases/normal'),
    plan: { ...f.intent.plan, inputs: n.inputs }
  };
  expect(() => snapshotWindowExecutorPins(intent)).not.toThrow();
  if (variant === 'inode') {
    renameSync(alias, alias + '.old');
    symlinkSync(n.toolPath, alias);
  } else {
    row.target = n.inputs.native_path;
    n.freezeManifest();
  }
  expect(() => snapshotWindowExecutorPins(intent)).toThrow('pin_drift');
});

function runtimeFixturePaths() {
  return z
    .object({ sharedObjects: z.array(z.string()) })
    .parse(process.report.getReport())
    .sharedObjects.filter(path => !path.startsWith('/usr/lib/') && !path.startsWith('/System/'))
    .map(path => realpathSync(path));
}

const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

function nativeFixture(root: string, sharedObjects: readonly string[] = []) {
  const prefix = join(root, 'prefix');
  const caseRoot = join(root, 'cases/normal');
  const bin = join(prefix, 'node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin');
  const launcher = join(prefix, 'node_modules/@openai/codex/bin/codex.js');
  mkdirSync(join(prefix, 'node_modules/@openai/codex/bin'), {
    recursive: true,
    mode: 0o700
  });
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  mkdirSync(caseRoot, { recursive: true, mode: 0o700 });
  const inputs = {
    batch_root: root,
    prefix_root: prefix,
    native_path: join(bin, 'codex'),
    host_path: join(bin, 'codex-code-mode-host'),
    config_path: join(caseRoot, 'config.json'),
    environment_path: join(caseRoot, 'environment.json'),
    profile_path: join(root, 'profile.sb'),
    quota_packet_path: join(root, 'quota.json'),
    native_manifest_path: join(root, 'native-manifest.json'),
    native_manifest_sha256: '',
    native_manifest_identity: ''
  };
  const denied = ['rg', 'voice-host', 'libvoice.dylib', 'resource.json'].map(name => join(prefix, name));
  const argvPath = join(caseRoot, 'argv.json');
  const toolPath = join(root, 'synthetic-system-tool');
  const runtime = realpathSync(process.execPath);
  // Host dependency counts vary independently of the controller identity.
  vi.spyOn(process.report, 'getReport').mockReturnValue({
    ...process.report.getReport(),
    sharedObjects: [...sharedObjects]
  });
  const dependencies = [...new Set(runtimeFixturePaths())].filter(path => path !== runtime);
  const launcherInput = {
    argv_tail: ['--version'],
    environment: { PATH: '/usr/bin:/bin' }
  };
  const recipe = deriveWindowNativeRecipe(prefix, launcherInput);
  const argv = [...recipe.argv];
  const roles = [
    [inputs.native_path, 'native'],
    [inputs.host_path, 'host'],
    [inputs.config_path, 'config'],
    [inputs.environment_path, 'environment'],
    [argvPath, 'argv'],
    [toolPath, 'runtime_data'],
    [launcher, 'launcher'],
    [inputs.profile_path, 'profile'],
    [inputs.quota_packet_path, 'quota'],
    [recipe.resolution.platform_package_json, 'denied'],
    ...denied.map(path => [path, 'denied'])
  ];
  for (const [path, role] of roles) {
    if (path) {
      writeFileSync(path, role === 'argv' ? JSON.stringify(argv) : role === 'environment' ? JSON.stringify(recipe.environment) : 'synthetic-only', {
        mode: 0o600
      });
    }
  }
  const files = [...roles, ...dependencies.map(path => [path, 'runtime_data']), [runtime, 'runtime'], [realpathSync('/bin/ps'), 'system_tool']].map(
    ([path, role]) => {
      if (!path || !role) throw new Error('fixture_role_missing');
      const stat = lstatSync(path, { bigint: true });
      return {
        path,
        role,
        size: Number(stat.size),
        mode: Number(stat.mode & 0o7777n),
        dev: stat.dev.toString(),
        ino: stat.ino.toString(),
        sha256: sha256(path),
        ...(role === 'system_tool' ? { tool: 'ps' } : {})
      };
    }
  );
  const directories = nativeDirectoryFixture(prefix);
  const inventoryPath = join(root, 'b0-inventory.json');
  const inventory = {
    files: files
      .filter(row => row.path.startsWith(prefix + '/'))
      .map(row => ({
        path: row.path,
        size: row.size,
        mode: '0' + row.mode.toString(8),
        sha256: row.sha256,
        mach_o: {
          signing: {
            cdhash: 'a'.repeat(40),
            identifier: 'synthetic-only',
            verification: 'synthetic'
          }
        }
      }))
  };
  writeFileSync(inventoryPath, JSON.stringify(inventory), { mode: 0o600 });
  const runtimeLinks: {
    path: string;
    mode: number;
    dev: string;
    ino: string;
    target: string;
  }[] = [];
  const manifest = {
    schema_version: 1,
    prefix_root: prefix,
    b0_inventory: {
      path: inventoryPath,
      sha256: sha256(inventoryPath),
      mode: lstatSync(inventoryPath).mode & 0o7777,
      size: lstatSync(inventoryPath).size,
      dev: lstatSync(inventoryPath, { bigint: true }).dev.toString(),
      ino: lstatSync(inventoryPath, { bigint: true }).ino.toString()
    },
    argv,
    launcher_input: launcherInput,
    controller_runtime: {
      node_major: Number(process.versions.node.split('.')[0])
    },
    process_paths: [inputs.native_path, inputs.host_path],
    runtime_paths: [runtime, toolPath, ...dependencies],
    runtime_links: runtimeLinks,
    system_tools: ['ps'],
    files,
    directories
  };
  function freezeManifest() {
    writeFileSync(inputs.native_manifest_path, JSON.stringify(manifest), {
      mode: 0o600
    });
    inputs.native_manifest_sha256 = sha256(inputs.native_manifest_path);
    const stat = lstatSync(inputs.native_manifest_path, { bigint: true });
    inputs.native_manifest_identity = [stat.dev, stat.ino, stat.size, stat.mode & 0o7777n].join(':');
  }
  freezeManifest();
  return {
    inputs,
    manifest,
    denied,
    argvPath,
    toolPath,
    inventoryPath,
    freezeManifest
  };
}

function nativeDirectoryFixture(prefix: string) {
  const directories: {
    path: string;
    mode: number;
    dev: string;
    ino: string;
    entries: string[];
  }[] = [];
  function visit(path: string) {
    const stat = lstatSync(path, { bigint: true });
    const entries = readdirSync(path).sort();
    directories.push({
      path,
      mode: Number(stat.mode & 0o7777n),
      dev: stat.dev.toString(),
      ino: stat.ino.toString(),
      entries
    });
    for (const name of entries) {
      if (lstatSync(join(path, name)).isDirectory()) {
        visit(join(path, name));
      }
    }
  }
  visit(prefix);
  return directories;
}

test.each([
  'same_bytes_inode',
  'mode',
  'device',
  'inode',
  'size',
  'hash',
  'extra_resource',
  'empty_directory',
  'denied_bytes',
  'runtime',
  'system_tool',
  'argv',
  'manifest_bytes',
  'inventory_bytes',
  'missing_manifest',
  'missing_file',
  'symlink',
  'host_sibling',
  'native_limit',
  'host_limit',
  'unlisted_directory',
  'omitted_denied',
  'argv_binding',
  'manifest_replacement',
  'inventory_replacement',
  'profile_replacement',
  'quota_replacement'
])('frozen native preflight refuses %s without executing any inventoried file', variant => {
  const f = fixture();
  const n = nativeFixture(f.root);
  const intent = {
    ...f.intent,
    case_root: join(f.root, 'cases/normal'),
    plan: { ...f.intent.plan, inputs: n.inputs }
  };
  expect(() => snapshotWindowExecutorPins(intent)).not.toThrow();
  const native = n.manifest.files.find(row => row.role === 'native');
  if (!native) throw new Error('fixture_native_missing');
  if (variant.endsWith('_replacement')) {
    const paths = new Map([
      ['manifest_replacement', n.inputs.native_manifest_path],
      ['inventory_replacement', n.inventoryPath],
      ['profile_replacement', n.inputs.profile_path],
      ['quota_replacement', n.inputs.quota_packet_path]
    ]);
    const path = paths.get(variant);
    if (!path) throw new Error('fixture_replacement_missing');
    const replacement = join(f.root, 'replacement');
    writeFileSync(replacement, readFileSync(path), { mode: 0o600 });
    renameSync(replacement, path);
  } else if (variant === 'same_bytes_inode') {
    const replacement = join(f.root, 'replacement');
    writeFileSync(replacement, readFileSync(n.inputs.native_path), {
      mode: 0o600
    });
    renameSync(replacement, n.inputs.native_path);
  } else if (variant === 'mode') chmodSync(n.inputs.native_path, 0o644);
  else if (['device', 'inode', 'size', 'hash'].includes(variant)) {
    if (variant === 'device') {
      native.dev = (BigInt(native.dev) + 1n).toString();
    }
    if (variant === 'inode') {
      native.ino = (BigInt(native.ino) + 1n).toString();
    }
    if (variant === 'size') native.size += 1;
    if (variant === 'hash') native.sha256 = 'f'.repeat(64);
    n.freezeManifest();
  } else if (variant === 'extra_resource') {
    writeFileSync(join(n.inputs.prefix_root, 'extra-resource'), 'extra');
  } else if (variant === 'empty_directory') {
    mkdirSync(join(n.inputs.prefix_root, 'extra-directory'));
  } else if (variant === 'denied_bytes') {
    appendFileSync(n.denied[2] ?? '', 'changed');
  } else if (['runtime', 'system_tool'].includes(variant)) {
    const row = n.manifest.files.find(row => row.role === variant);
    if (!row) throw new Error('fixture_role_missing');
    row.sha256 = 'f'.repeat(64);
    n.freezeManifest();
  } else if (variant === 'argv') appendFileSync(n.argvPath, '\n');
  else if (variant === 'manifest_bytes') {
    appendFileSync(n.inputs.native_manifest_path, '\n');
  } else if (variant === 'inventory_bytes') {
    appendFileSync(n.inventoryPath, '\n');
  } else if (variant === 'missing_manifest') {
    renameSync(n.inputs.native_manifest_path, join(f.root, 'removed'));
  } else if (variant === 'missing_file') {
    renameSync(n.toolPath, join(f.root, 'removed'));
  } else if (variant === 'symlink') {
    renameSync(n.toolPath, join(f.root, 'tool-target'));
    symlinkSync(join(f.root, 'tool-target'), n.toolPath);
  } else if (variant === 'host_sibling') {
    n.inputs.host_path = n.inputs.native_path;
  } else if (variant === 'native_limit') {
    truncateSync(n.inputs.native_path, 300 * 1048576 + 1);
  } else if (variant === 'host_limit') {
    truncateSync(n.inputs.host_path, 128 * 1048576 + 1);
  } else if (variant === 'unlisted_directory') {
    n.manifest.directories.pop();
    n.freezeManifest();
  } else if (variant === 'omitted_denied') {
    n.manifest.files = n.manifest.files.filter(row => row.path !== n.denied[0]);
    n.freezeManifest();
  } else if (variant === 'argv_binding') {
    n.manifest.argv = ['exec'];
    n.freezeManifest();
  }
  expect(() => snapshotWindowExecutorPins(intent)).toThrow('pin_drift');
});

test.each(['same_bytes_inode', 'extra_resource'])('local verified consent rechecks %s even when supplied cached pins', variant => {
  const f = fixture();
  const n = nativeFixture(f.root);
  const caseRoot = join(f.root, 'cases/normal');
  const intent = {
    ...f.intent,
    case_root: caseRoot,
    plan: { ...f.intent.plan, inputs: n.inputs }
  };
  const pins = snapshotWindowExecutorPins(intent);
  const bytes = JSON.stringify({
    ...intent,
    plan: { ...intent.plan, pins }
  });
  const intentFile = join(caseRoot, 'intent.json');
  const consentFile = join(caseRoot, 'consent.json');
  writeFileSync(intentFile, bytes, { mode: 0o600 });
  writeFileSync(
    consentFile,
    JSON.stringify({
      ...f.consent,
      case_root: caseRoot,
      pins,
      intent_sha256: createHash('sha256').update(bytes).digest('hex')
    }),
    { mode: 0o600 }
  );
  vi.useFakeTimers();
  vi.setSystemTime(2000);
  const capability = reserveWindowConsent({ intentFile, consentFile });
  if (variant === 'same_bytes_inode') {
    const path = n.denied[2];
    if (!path) throw new Error('fixture_denied_missing');
    const replacement = join(f.root, 'replacement');
    writeFileSync(replacement, readFileSync(path), { mode: 0o600 });
    renameSync(replacement, path);
  } else {
    writeFileSync(join(n.inputs.prefix_root, 'extra-resource'), 'synthetic-only');
  }
  expect(() => revalidateWindowConsent(capability, pins)).toThrow('pin_drift');
  expect(existsSync(join(caseRoot, 'project'))).toBe(false);
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
