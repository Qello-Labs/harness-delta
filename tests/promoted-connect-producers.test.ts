import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';
import { installClaudeConnectInstallation, previewClaudeConnectInstallation } from '../src/connect/claude-connect-installation.js';

const roots: string[] = [];
const contract = 'promoted-payload-v1';
const products = ['codex', 'claude_code'] as const;
type Product = (typeof products)[number];
const effectsSchema = z.object({
  unauthorizedCalls: z.number(),
  nativeCalls: z.number(),
  processCalls: z.number(),
  metadataWrites: z.number(),
  operations: z.array(z.string())
});
const pendingSchema = z
  .object({
    schemaVersion: z.literal(3),
    kind: z.literal('promotion_pending'),
    producerContract: z.literal(contract),
    receipt: z.uuid(),
    product: z.enum(products),
    productVersion: z.string(),
    event: z.enum(['connect', 'subagent_start', 'subagent_stop']),
    nativeSessionId: z.string(),
    nativeRootSessionId: z.string(),
    agentId: z.string().nullable(),
    sourceRef: z.string().nullable(),
    cwd: z.string(),
    processIdHint: z.number().int().positive().nullable(),
    recordedAt: z.iso.datetime()
  })
  .strict();
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture(product: Product) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'promoted-producer-synthetic-')));
  roots.push(root);
  const directory = join(root, '.harness-delta', `${product === 'codex' ? 'codex' : 'claude'}-promoted-receipts`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const native = join(root, 'synthetic-native');
  mkdirSync(native);
  writeFileSync(join(native, 'root.jsonl'), 'SYNTHETIC_NATIVE');
  const script = resolve(
    product === 'codex' ? 'scripts/session-binding-codex-promoted-hook.mjs' : 'skills/harness-connect-promoted-claude/scripts/claude-session-hook.mjs'
  );
  const productVersion = product === 'codex' ? '0.169.0' : '2.1.319';
  const control = {
    schemaVersion: 1,
    producerContract: contract,
    projectRoot: root,
    product,
    productVersion,
    state: 'active'
  };
  const input = {
    hook_event_name: 'SessionStart',
    source: 'startup',
    session_id: '11111111-1111-4111-8111-111111111111',
    cwd: root,
    transcript_path: join(native, 'root.jsonl'),
    process_id: 12345,
    prompt: 'SYNTHETIC_EXCLUDED'
  };
  const args = ['--receipt-directory', directory, '--project-root', root, '--product-version', productVersion];
  return {
    root,
    directory,
    native,
    script,
    productVersion,
    control,
    input,
    args
  };
}
type Fixture = ReturnType<typeof fixture>;
test('installed Claude producer loads only its promoted configuration', async () => {
  const f = fixture('claude_code');
  const options = {
    bundleMode: 'promoted' as const,
    productVersion: f.productVersion,
    promotedInUse: false,
    quiescentBoundaryConfirmed: true
  };
  const preview = previewClaudeConnectInstallation(f.root, options);
  expect(preview.blockers).toEqual([]);
  expect(
    installClaudeConnectInstallation(f.root, {
      ...options,
      expectedPackageHash: preview.packageHash,
      expectedInstalledHash: preview.installedHash
    }).state
  ).toBe('installed');
  const scripts = join(f.root, '.claude/skills/harness-connect/scripts');
  const legacyConfig = join(scripts, 'claude-connect-config.mjs');
  writeFileSync(legacyConfig, 'throw new Error("synthetic_legacy_config_must_not_load");\n');
  control(f);
  const result = await invoke(f, {
    script: join(scripts, 'claude-promoted-session-hook.mjs'),
    args: [],
    codeFiles: [join(scripts, 'claude-promoted-connect-config.mjs'), legacyConfig]
  });
  requireNoAccess(result);
  expect(result.code).toBe(0);
  expect(receipts(f)).toMatchObject([
    {
      product: 'claude_code',
      productVersion: f.productVersion
    }
  ]);
});
function control(f: Fixture, value: unknown = f.control) {
  writeFileSync(join(f.directory, 'promotion-control.json'), JSON.stringify(value), { mode: 0o600 });
}
async function invoke(
  f: Fixture,
  options: {
    readonly script?: string;
    readonly args?: readonly string[];
    readonly input?: unknown;
    readonly codeFiles?: readonly string[];
  } = {}
) {
  const script = options.script ?? f.script;
  const child = spawn(process.execPath, ['--import', resolve('tests/helpers/promoted-producer-tripwire.mjs'), script, ...(options.args ?? f.args)], {
    env: {
      ...process.env,
      PROMOTED_PRODUCER_FIXTURE: JSON.stringify({
        directory: f.directory,
        nativePrefixes: [f.native, '/proc', '/dev/fd'],
        codeFiles: [script, ...(options.codeFiles ?? [])]
      })
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    signal: AbortSignal.timeout(10000)
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const closed = new Promise<number | null>((resolveClose, reject) => {
    child.once('error', reject);
    child.once('close', resolveClose);
  });
  child.stdin.on('error', error => {
    if (!('code' in error) || error.code !== 'EPIPE') throw error;
  });
  child.stdin.end(JSON.stringify(options.input ?? f.input));
  const code = await closed;
  const marker = stderr.split('\n').find(line => line.startsWith('PROMOTED_EFFECTS:'));
  if (!marker) throw new Error(`synthetic_effects_missing:${stderr}`);
  return {
    code,
    stdout,
    stderr,
    effects: effectsSchema.parse(JSON.parse(marker.slice('PROMOTED_EFFECTS:'.length)))
  };
}
function requireNoAccess(result: Awaited<ReturnType<typeof invoke>>) {
  expect(result.effects).toMatchObject({
    unauthorizedCalls: 0,
    nativeCalls: 0,
    processCalls: 0,
    operations: []
  });
}
function receipts(f: Fixture) {
  return readdirSync(f.directory)
    .filter(name => name !== 'promotion-control.json')
    .map(name => pendingSchema.parse(JSON.parse(readFileSync(join(f.directory, name), 'utf8'))));
}

test.each(products)('%s emits only bounded local hints without consulting absent or revoked grants', async product => {
  const f = fixture(product);
  control(f);
  const absent = await invoke(f);
  requireNoAccess(absent);
  expect(absent.code).toBe(0);
  writeFileSync(join(f.root, 'revoked-grant.json'), JSON.stringify({ state: 'revoked' }));
  const revoked = await invoke(f);
  requireNoAccess(revoked);
  expect(revoked.code).toBe(0);
  expect(receipts(f)).toEqual([
    expect.objectContaining({
      product,
      productVersion: f.productVersion,
      event: 'connect',
      sourceRef: f.input.transcript_path,
      cwd: f.root,
      nativeSessionId: f.input.session_id,
      nativeRootSessionId: f.input.session_id,
      agentId: null,
      processIdHint: 12345
    }),
    expect.objectContaining({
      product,
      productVersion: f.productVersion,
      event: 'connect'
    })
  ]);
});

test.each(products)('%s stale installed payload-only copy never inspects native hints with stale active control', async product => {
  const f = fixture(product);
  const installed = join(f.root, 'installed.mjs');
  copyFileSync(f.script, installed);
  control(f);
  writeFileSync(join(f.root, 'revoked-grant.json'), '{"state":"revoked"}');
  const result = await invoke(f, {
    script: installed,
    input: {
      ...f.input,
      transcript_path: join(f.native, 'missing-image')
    }
  });
  requireNoAccess(result);
  expect(result.code).toBe(0);
  expect(receipts(f)).toEqual([
    expect.objectContaining({
      sourceRef: join(f.native, 'missing-image')
    })
  ]);
});

test.each(products)('%s root-only SubagentStart remains unverified metadata without source discovery', async product => {
  const f = fixture(product);
  control(f);
  const result = await invoke(f, {
    input: {
      ...f.input,
      hook_event_name: 'SubagentStart',
      agent_id: 'synthetic-child',
      transcript_path: undefined
    }
  });
  requireNoAccess(result);
  expect(result.code).toBe(0);
  expect(receipts(f)).toEqual([
    expect.objectContaining({
      event: 'subagent_start',
      nativeSessionId: f.input.session_id,
      nativeRootSessionId: f.input.session_id,
      agentId: 'synthetic-child',
      sourceRef: null
    })
  ]);
});

test.each(
  products.flatMap(product =>
    ['missing', 'closed', 'wrong-version', 'extra-field'].map(state => ({
      product,
      state
    }))
  )
)('$product suppresses emission for $state control', async ({ product, state }) => {
  const f = fixture(product);
  if (state !== 'missing') {
    control(f, {
      ...f.control,
      ...(state === 'closed' ? { state: 'closed' } : {}),
      ...(state === 'wrong-version' ? { productVersion: '9.9.9' } : {}),
      ...(state === 'extra-field' ? { grant: true } : {})
    });
  }
  const result = await invoke(f);
  requireNoAccess(result);
  expect(result.stdout).toBe('');
  expect(receipts(f)).toEqual([]);
});

test.each(
  products.flatMap(product =>
    ['lstatSync', 'realpathSync', 'openSync'].map(operation => ({
      product,
      operation
    }))
  )
)('$product access oracle rejects deliberate $operation in a disposable producer copy', async ({ product, operation }) => {
  const f = fixture(product);
  control(f);
  const mutated = join(f.root, 'mutated.mjs');
  writeFileSync(
    mutated,
    `import * as nativeFs from 'node:fs';\nnativeFs.${operation}(${JSON.stringify(f.input.transcript_path)});\n` +
      readFileSync(f.script, 'utf8').replace(/^#![^\n]*\n/, '')
  );
  const result = await invoke(f, { script: mutated });
  expect(() => requireNoAccess(result)).toThrow();
  expect(result.effects.nativeCalls).toBe(1);
  expect(result.effects.operations).toEqual([operation]);
});

test('Claude installed configuration supplies only explicit producer arguments', async () => {
  const f = fixture('claude_code');
  control(f);
  const installed = join(f.root, 'scripts', 'claude-promoted-session-hook.mjs');
  mkdirSync(dirname(installed));
  copyFileSync(f.script, installed);
  const config = join(dirname(installed), 'claude-promoted-connect-config.mjs');
  writeFileSync(
    config,
    `process.env.HARNESS_DELTA_PROMOTED_RECEIPT_DIR=${JSON.stringify(f.directory)};\n` +
      `process.env.HARNESS_DELTA_PROMOTED_PROJECT_ROOT=${JSON.stringify(f.root)};\n` +
      `process.env.HARNESS_DELTA_PROMOTED_PRODUCT_VERSION=${JSON.stringify(f.productVersion)};\n`
  );
  const result = await invoke(f, {
    script: installed,
    args: [],
    codeFiles: [config]
  });
  requireNoAccess(result);
  expect(result.code).toBe(0);
  expect(receipts(f)).toEqual([
    expect.objectContaining({
      product: 'claude_code',
      productVersion: f.productVersion
    })
  ]);
});

test.each(products)('%s bounds input and rejects malformed target arguments before emission', async product => {
  const f = fixture(product);
  control(f);
  for (const options of [
    { input: { ...f.input, transcript_path: 'x'.repeat(4097) } },
    { input: { ...f.input, prompt: 'x'.repeat(65537) } },
    { args: [...f.args, '--source-root', f.native] },
    { args: [...f.args.slice(0, -1), 'invalid'] }
  ]) {
    const result = await invoke(f, options);
    requireNoAccess(result);
    expect(result.code).toBe(1);
    expect(receipts(f)).toEqual([]);
  }
});

test.each(products)('%s connect helper requires an explicit receipt and cannot claim live authority', async product => {
  const f = fixture(product);
  const script = resolve(`skills/harness-connect-promoted-${product === 'codex' ? 'codex' : 'claude'}/scripts/connect.mjs`);
  const args = ['connect', '--origin', 'http://127.0.0.1:43210', '--project', 'synthetic-project', '--task', 'synthetic-task'];
  const missing = await invoke(f, { script, args });
  requireNoAccess(missing);
  expect(JSON.parse(missing.stdout)).toMatchObject({
    status: 'blocked',
    reason_code: 'invalid_input',
    verified: false
  });
  const explicit = await invoke(f, {
    script,
    args: [...args, '--receipt', '11111111-1111-4111-8111-111111111111']
  });
  requireNoAccess(explicit);
  expect(JSON.parse(explicit.stdout)).toMatchObject({
    status: 'blocked',
    reason_code: 'promoted_provider_unavailable',
    verified: false,
    collection_active: false
  });
  expect(receipts(f)).toEqual([]);
});
