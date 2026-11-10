import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import * as nativeFs from 'node:fs';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';
import { installClaudeConnectInstallation, previewClaudeConnectInstallation } from '../src/connect/claude-connect-installation.js';
import { installCodexConnectInstallation, previewCodexConnectInstallation } from '../src/connect/codex-connect-installation.js';

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
test.each(products)('%s owned installed root-only producer remains native-free after control closure and reopening', async product => {
  const f = fixture(product);
  const options = {
    bundleMode: 'promoted' as const,
    productVersion: f.productVersion,
    promotedInUse: false,
    quiescentBoundaryConfirmed: true,
    sourceRoots: [f.native]
  };
  const preview = product === 'codex' ? previewCodexConnectInstallation(f.root, options) : previewClaudeConnectInstallation(f.root, options);
  expect(preview.blockers).toEqual([]);
  const installOptions = {
    ...options,
    expectedPackageHash: preview.packageHash,
    expectedInstalledHash: preview.installedHash
  };
  const installed = product === 'codex' ? installCodexConnectInstallation(f.root, installOptions) : installClaudeConnectInstallation(f.root, installOptions);
  expect(installed.state).toBe('installed');
  const script =
    product === 'codex'
      ? join(f.root, '.harness-delta/codex-connect/session-binding-codex-promoted-hook.mjs')
      : join(f.root, '.claude/skills/harness-connect/scripts/claude-promoted-session-hook.mjs');
  const config = join(f.root, '.claude/skills/harness-connect/scripts/claude-promoted-connect-config.mjs');
  const invocation = {
    script,
    args: product === 'codex' ? f.args : [],
    codeFiles: product === 'codex' ? [] : [config],
    input: {
      ...f.input,
      hook_event_name: 'SubagentStart',
      agent_id: 'synthetic-denied-child',
      transcript_path: join(f.native, 'unreadable-child.jsonl')
    }
  };
  control(f, { ...f.control, state: 'closed' });
  const closed = await invoke(f, invocation);
  requireNoAccess(closed);
  expect(closed.code).toBe(0);
  expect(receipts(f)).toEqual([]);
  control(f);

  const stale = await invoke(f, invocation);

  requireNoAccess(stale);
  expect(stale.code).toBe(0);
  expect(receipts(f)).toEqual([
    expect.objectContaining({
      event: 'subagent_start',
      agentId: 'synthetic-denied-child',
      sourceRef: invocation.input.transcript_path
    })
  ]);
});
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

test.each(
  products.flatMap(product =>
    [
      {
        module: 'node:fs',
        call: '(await nativeFs.openAsBlob(nativePath)).text()',
        operation: 'openAsBlob'
      },
      {
        module: 'fs',
        call: 'nativeFs.openAsBlobSync(nativePath).text()',
        operation: 'openAsBlobSync'
      },
      {
        module: 'node:fs',
        call: 'nativeFs.promises.readFile(nativePath)',
        operation: 'promises.readFile'
      },
      {
        module: 'fs/promises',
        call: 'nativeFs.readFile(nativePath)',
        operation: 'promises.readFile'
      },
      {
        module: 'node:fs/promises',
        call: 'nativeFs.readFile(nativePath)',
        operation: 'promises.readFile'
      }
    ]
      .filter(({ operation }) => operation !== 'openAsBlobSync' || 'openAsBlobSync' in nativeFs)
      .map(mutation => ({ product, ...mutation }))
  )
)('$product whole-file access oracle rejects $module $operation', async ({ product, module, call, operation }) => {
  const f = fixture(product);
  control(f);
  const mutated = join(f.root, 'mutated.mjs');
  writeFileSync(
    mutated,
    `import * as nativeFs from '${module}';\nconst nativePath = ${JSON.stringify(f.input.transcript_path)};\nawait ${call};\n` +
      readFileSync(f.script, 'utf8').replace(/^#![^\n]*\n/, '')
  );
  const result = await invoke(f, { script: mutated });
  expect(result.effects).toEqual({
    unauthorizedCalls: 1,
    nativeCalls: 1,
    processCalls: 0,
    metadataWrites: 0,
    operations: [operation]
  });
  expect(result.code).toBe(1);
  expect(receipts(f)).toEqual([]);
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
  const server = await promotedTransportServer(product, 'missing');
  const args = ['connect', '--origin', server.origin, '--project', 'synthetic-project', '--task', 'synthetic-task'];
  try {
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
  } finally {
    await server.close();
  }
});

async function promotedTransportServer(
  product: Product,
  mode: 'allow' | 'deny' | 'readback' | 'missing',
  redirect?: { readonly origin: string; readonly status: number }
) {
  let connected = false;
  const selected = 'synthetic-session';
  const bodies: unknown[] = [];
  const assigned = product === 'codex' ? 'synthetic-variant' : null;
  const server = createServer((request, response) => {
    const reply = (value: unknown, status = 200) => {
      response.writeHead(status, {
        'Content-Type': 'application/json',
        Connection: 'close'
      });
      response.end(JSON.stringify(value));
    };
    if (request.url === '/api/bootstrap') {
      if (mode === 'missing') {
        reply({ error: 'promoted_provider_unavailable' }, 409);
        return;
      }
      reply({
        csrf: 'c'.repeat(64),
        data: {
          projects: [{ id: 'synthetic-project' }],
          tasks: [
            {
              id: 'synthetic-task',
              project_id: 'synthetic-project'
            }
          ]
        }
      });
    } else if (request.url === '/api/tasks/synthetic-task' && request.method === 'GET') {
      reply({
        id: 'synthetic-task',
        project_id: 'synthetic-project',
        version: `"${'a'.repeat(64)}"`,
        state: 'active',
        preparation: {
          state: 'connected',
          assigned_variant_id: assigned
        },
        actions: [
          {
            code: 'session-connect',
            enabled: true,
            reason: null
          }
        ],
        binding: {
          state: connected ? 'observing' : 'unlinked',
          sessions:
            connected && mode !== 'readback'
              ? [
                  {
                    session_id: selected,
                    identity_basis: 'native_metadata_receipt'
                  }
                ]
              : []
        }
      });
    } else if (request.url === '/api/tasks/synthetic-task/session-connect' && request.method === 'POST') {
      let body = '';
      request.on('data', chunk => {
        body += String(chunk);
      });
      request.on('end', () => {
        const value: unknown = JSON.parse(body);
        bodies.push(value);
        if (
          request.headers['x-harness-csrf'] !== 'c'.repeat(64) ||
          request.headers['if-match'] !== `"${'a'.repeat(64)}"` ||
          request.headers.origin !== `http://127.0.0.1:${port}` ||
          !request.headers['idempotency-key']
        ) {
          reply({ error: 'ui_state_changed' }, 409);
          return;
        }
        if (mode === 'deny') {
          reply({ error: 'promotion_authority_denied' }, 409);
          return;
        }
        connected = true;
        if (redirect) {
          response.writeHead(redirect.status, {
            Location: redirect.origin + '/sink',
            Connection: 'close'
          });
          response.end();
          return;
        }
        reply({
          connection: {
            status: 'connected',
            project_id: 'synthetic-project',
            task_id: 'synthetic-task',
            session_id: selected,
            assigned_variant_id: assigned,
            identity_basis: 'native_metadata_receipt',
            evidence: 'server_verified_identity_source_and_relations',
            collection_active: true,
            automatic_children: false,
            cost_coverage: 'partial'
          }
        });
      });
    } else reply({ error: 'unsupported_ui_contract' }, 404);
  });
  await new Promise<void>(resolveListening => server.listen(0, '127.0.0.1', resolveListening));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('synthetic_server_address_missing');
  }
  const port = address.port;
  return {
    origin: `http://127.0.0.1:${port}`,
    bodies,
    close: () => new Promise<void>((resolveClose, reject) => server.close(error => (error ? reject(error) : resolveClose())))
  };
}

test.each(products)('%s promoted helper reaches the authorized callback without reading native hints', async product => {
  const f = fixture(product);
  const server = await promotedTransportServer(product, 'allow');
  try {
    const result = await invoke(f, {
      script: resolve(`skills/harness-connect-promoted-${product === 'codex' ? 'codex' : 'claude'}/scripts/connect.mjs`),
      args: ['connect', '--origin', server.origin, '--project', 'synthetic-project', '--task', 'synthetic-task', '--receipt', f.input.session_id]
    });
    requireNoAccess(result);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: 'connected',
      producer_contract: contract,
      collection_active: true,
      session_id: 'synthetic-session',
      automatic_children: false
    });
    expect(server.bodies).toEqual([
      {
        product,
        receipt: f.input.session_id
      }
    ]);
    expect(receipts(f)).toEqual([]);
  } finally {
    await server.close();
  }
});

test.each(products.flatMap(product => [307, 308].map(status => ({ product, status }))))(
  '$product promoted helper rejects $status redirects without contacting the target',
  async ({ product, status }) => {
    const f = fixture(product);
    let targetRequests = 0;
    const target = createServer((_request, response) => {
      targetRequests += 1;
      response.writeHead(200, {
        'Content-Type': 'application/json',
        Connection: 'close'
      });
      response.end(
        JSON.stringify({
          connection: {
            status: 'connected',
            project_id: 'synthetic-project',
            task_id: 'synthetic-task',
            session_id: 'synthetic-session',
            identity_basis: 'native_metadata_receipt',
            evidence: 'server_verified_identity_source_and_relations',
            collection_active: true,
            automatic_children: false,
            cost_coverage: 'partial'
          }
        })
      );
    });
    await new Promise<void>(resolveListening => target.listen(0, '127.0.0.1', resolveListening));
    const address = target.address();
    if (!address || typeof address === 'string') {
      throw new Error('synthetic_server_address_missing');
    }
    try {
      const server = await promotedTransportServer(product, 'allow', {
        origin: `http://127.0.0.1:${address.port}`,
        status
      });
      try {
        const result = await invoke(f, {
          script: resolve(`skills/harness-connect-promoted-${product === 'codex' ? 'codex' : 'claude'}/scripts/connect.mjs`),
          args: ['connect', '--origin', server.origin, '--project', 'synthetic-project', '--task', 'synthetic-task', '--receipt', f.input.session_id]
        });
        expect(targetRequests).toBe(0);
        requireNoAccess(result);
        expect(server.bodies).toEqual([
          {
            product,
            receipt: f.input.session_id
          }
        ]);
        expect(result.code).toBe(1);
        expect(JSON.parse(result.stdout)).toEqual({
          status: 'blocked',
          producer_contract: contract,
          product,
          reason_code: 'promoted_provider_unavailable',
          verified: false,
          collection_active: false
        });
      } finally {
        await server.close();
      }
    } finally {
      await new Promise<void>((resolveClose, reject) => target.close(error => (error ? reject(error) : resolveClose())));
    }
  }
);

test.each(
  products.flatMap(product =>
    [
      'http://localhost',
      'http://localhost:12345',
      'http://[::1]',
      'http://[::1]:12345',
      'http://127.0.0.1',
      'http://127.0.0.1:80',
      'https://127.0.0.1:12345',
      'http://192.0.2.1:12345',
      'http://user:password@127.0.0.1:12345',
      'http://127.0.0.1:12345/path',
      'http://127.0.0.1:12345?query',
      'http://127.0.0.1:12345#fragment'
    ].map(origin => ({ product, origin }))
  )
)('$product promoted helper rejects origin $origin outside explicit IPv4 loopback ports', async ({ product, origin }) => {
  const f = fixture(product);
  const result = await invoke(f, {
    script: resolve(`skills/harness-connect-promoted-${product === 'codex' ? 'codex' : 'claude'}/scripts/connect.mjs`),
    args: ['inspect', '--origin', origin, '--project', 'synthetic-project', '--task', 'synthetic-task']
  });
  requireNoAccess(result);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout)).toEqual({
    status: 'blocked',
    producer_contract: contract,
    product,
    reason_code: 'invalid_origin',
    verified: false,
    collection_active: false
  });
});

test.each(products.flatMap(product => (['deny', 'readback'] as const).map(mode => ({ product, mode }))))(
  '$product promoted helper refuses $mode rather than claiming collection',
  async ({ product, mode }) => {
    const f = fixture(product);
    const server = await promotedTransportServer(product, mode);
    try {
      const result = await invoke(f, {
        script: resolve(`skills/harness-connect-promoted-${product === 'codex' ? 'codex' : 'claude'}/scripts/connect.mjs`),
        args: ['connect', '--origin', server.origin, '--project', 'synthetic-project', '--task', 'synthetic-task', '--receipt', f.input.session_id]
      });
      requireNoAccess(result);
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        status: 'blocked',
        reason_code: mode === 'deny' ? 'promotion_authority_denied' : 'connection_unverified',
        verified: false,
        collection_active: false
      });
    } finally {
      await server.close();
    }
  }
);
