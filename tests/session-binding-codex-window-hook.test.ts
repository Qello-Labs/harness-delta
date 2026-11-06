import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { codexWindowControl, runCodexWindowHook } from './helpers/codex-window-hook-fixture.js';

const cleanup: string[] = [];
afterEach(() => {
  for (const directory of cleanup.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'codex-window-synthetic-')));
  cleanup.push(projectRoot);
  const receiptDirectory = join(projectRoot, 'metadata');
  const native = join(projectRoot, 'native');
  const assets = join(projectRoot, 'vendor-assets');
  for (const directory of [receiptDirectory, native, assets]) {
    mkdirSync(directory, { mode: 0o700 });
  }
  const controlPath = join(receiptDirectory, 'ordinary-window-control.json');
  const control = codexWindowControl(projectRoot);
  const setControl = (value: unknown) => writeFileSync(controlPath, JSON.stringify(value), { mode: 0o600 });
  setControl(control);
  const input = {
    hook_event_name: 'SessionStart',
    source: 'startup',
    session_id: 'synthetic-root',
    cwd: `${native}/raw/../cwd`,
    transcript_path: `${native}/raw/../root.jsonl`,
    prompt: 'SYNTHETIC_PRIVATE_SENTINEL',
    response: 'SYNTHETIC_PRIVATE_SENTINEL',
    productVersion: '99.99.99',
    sourceIdentity: 'FORGED',
    processId: 123,
    proof: 'FORGED',
    arbitrary: { secret: 'SYNTHETIC_PRIVATE_SENTINEL', path: assets }
  };
  const run = (overrides: Partial<Parameters<typeof runCodexWindowHook>[0]> = {}) =>
    runCodexWindowHook({
      receiptDirectory,
      projectRoot,
      nativePrefixes: [native, assets, '/proc', '/dev/fd'],
      input,
      ...overrides
    });
  return {
    projectRoot,
    receiptDirectory,
    native,
    assets,
    controlPath,
    control,
    input,
    setControl,
    run
  };
}

function zeroEffects(result: Awaited<ReturnType<typeof runCodexWindowHook>>) {
  expect(result.effects.nativeCalls, JSON.stringify(result.effects)).toBe(0);
  expect(result.effects.processCalls, JSON.stringify(result.effects)).toBe(0);
  expect(result.effects.operations).toEqual([]);
}

test.each(['startup', 'resume', 'clear', 'compact', 'unknown-private-kind', null, undefined])(
  'retains root lifecycle %s as pending metadata without native authority under stale active control',
  async source => {
    const f = fixture();
    const result = await f.run({
      receiptDirectory: f.receiptDirectory,
      projectRoot: f.projectRoot,
      input: { ...f.input, source }
    });
    zeroEffects(result);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    const receiptId: unknown = expect.stringMatching(/^[0-9a-f-]{36}$/);
    const recordedAt: unknown = expect.stringMatching(/^\d{4}-\d\d-\d\dT.*Z$/);
    expect(result.receipts).toEqual([
      {
        schemaVersion: 2,
        kind: 'codex_window_pending',
        receipt: receiptId,
        product: 'codex',
        event: 'SessionStart',
        lifecycle: source === 'unknown-private-kind' ? 'unsupported' : (source ?? null),
        nativeSessionId: 'synthetic-root',
        nativeRootSessionId: 'synthetic-root',
        agentId: null,
        turnId: null,
        cwd: f.input.cwd,
        sourceRef: f.input.transcript_path,
        recordedAt
      }
    ]);
    const files = readdirSync(f.receiptDirectory).filter(name => name !== 'ordinary-window-control.json');
    expect(files).toHaveLength(1);
    for (const name of files) {
      expect(statSync(join(f.receiptDirectory, name)).mode & 0o777).toBe(0o600);
      expect(readFileSync(join(f.receiptDirectory, name), 'utf8')).not.toContain('SYNTHETIC_PRIVATE_SENTINEL');
    }
    expect(result.stdout).not.toContain(f.native);
    expect(result.stdout).not.toContain('unknown-private-kind');
    expect(result.stdout).not.toContain('FORGED');
  }
);

test.each([null, undefined])('preserves null or absent transcript as root fence without native lookup: %s', async transcript_path => {
  const f = fixture();
  const result = await f.run({
    receiptDirectory: f.receiptDirectory,
    projectRoot: f.projectRoot,
    input: { ...f.input, source: 'resume', transcript_path }
  });
  zeroEffects(result);
  expect(result.code).toBe(0);
  expect(result.receipts).toEqual([
    expect.objectContaining({
      event: 'SessionStart',
      lifecycle: 'resume',
      sourceRef: null
    })
  ]);
});

test.each(['synthetic-turn', null, undefined])('projects child hints without opening child sources: %s', async turn_id => {
  const f = fixture();
  const result = await f.run({
    receiptDirectory: f.receiptDirectory,
    projectRoot: f.projectRoot,
    input: {
      ...f.input,
      hook_event_name: 'SubagentStart',
      agent_id: 'synthetic-child',
      turn_id,
      source: undefined
    }
  });
  zeroEffects(result);
  expect(result.code).toBe(0);
  expect(result.receipts).toEqual([
    expect.objectContaining({
      event: 'SubagentStart',
      lifecycle: null,
      nativeSessionId: 'synthetic-child',
      nativeRootSessionId: 'synthetic-root',
      agentId: 'synthetic-child',
      turnId: turn_id ?? null
    })
  ]);
});

test.each(['missing', 'closed', 'malformed', 'projectRoot', 'product', 'policyId', 'policyRevision', 'evidenceMode', 'schemaVersion', 'extra'])(
  'suppresses all emission and native effects with %s control',
  async kind => {
    const f = fixture();
    if (kind === 'missing') rmSync(f.controlPath);
    else if (kind === 'closed') {
      f.setControl({ ...f.control, state: 'closed' });
    } else if (kind === 'malformed') {
      writeFileSync(f.controlPath, '{SYNTHETIC_PRIVATE_SENTINEL', {
        mode: 0o600
      });
    } else f.setControl({ ...f.control, [kind]: 'mismatched' });
    const result = await f.run();
    zeroEffects(result);
    expect(result.receipts).toEqual([]);
    expect(result.stdout).toBe('');
    expect(result.stderr === '' || result.stderr === 'binding_window_hook_metadata_unavailable\n').toBe(true);
  }
);

test.each([
  { session_id: 'x'.repeat(129) },
  { cwd: 'relative' },
  { cwd: '/x\0private' },
  { transcript_path: '/x'.repeat(4097) },
  { source: 'x'.repeat(129) },
  { hook_event_name: 'Other' },
  { hook_event_name: 'SubagentStart', agent_id: 'synthetic-root' },
  { hook_event_name: 'SubagentStart', agent_id: 'child', turn_id: '!' }
])('bounds malformed metadata without losing scoped source-hint fences: %j', async fields => {
  const f = fixture();
  const result = await f.run({
    receiptDirectory: f.receiptDirectory,
    projectRoot: f.projectRoot,
    input: { ...f.input, ...fields }
  });
  zeroEffects(result);
  if ('transcript_path' in fields || 'source' in fields) {
    expect(result.code).toBe(0);
    expect(result.receipts).toHaveLength(1);
    expect(result.receipts[0]).toMatchObject({
      schemaVersion: 2,
      kind: 'codex_window_pending',
      event: 'SessionStart',
      lifecycle: 'source' in fields ? 'unsupported' : 'startup',
      sourceRef: 'transcript_path' in fields ? null : f.input.transcript_path
    });
    expect(JSON.stringify(result.receipts)).not.toContain(String('source' in fields ? fields.source : fields.transcript_path));
    expect(result.stderr).toBe('');
  } else {
    expect(result.code).toBe(1);
    expect(result.receipts).toEqual([]);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('binding_window_hook_metadata_unavailable\n');
  }
});

test.each(['stdin', 'control', 'storage', 'control-symlink', 'directory-mode', 'control-mode', 'directory-symlink'])(
  'enforces bounded owned storage and nofollow policy: %s',
  async kind => {
    const f = fixture();
    if (kind === 'control') writeFileSync(f.controlPath, ' '.repeat(4097));
    if (kind === 'storage') {
      for (let n = 0; n < 1023; n++) {
        writeFileSync(join(f.receiptDirectory, `filler-${n}`), '');
      }
    }
    if (kind === 'control-symlink') {
      rmSync(f.controlPath);
      symlinkSync(join(f.native, 'control'), f.controlPath);
    }
    if (kind === 'directory-mode') chmodSync(f.receiptDirectory, 0o755);
    if (kind === 'control-mode') chmodSync(f.controlPath, 0o644);
    let receiptDirectory = f.receiptDirectory;
    if (kind === 'directory-symlink') {
      receiptDirectory = join(f.projectRoot, 'alias');
      symlinkSync(f.receiptDirectory, receiptDirectory);
    }
    const result = await f.run({
      receiptDirectory,
      projectRoot: f.projectRoot,
      ...(kind === 'stdin' ? { stdin: 'x'.repeat(65537) } : {})
    });
    zeroEffects(result);
    expect(result.code).toBe(1);
    expect(result.receipts).toEqual([]);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('binding_window_hook_metadata_unavailable\n');
  }
);

test.each([
  { args: [] },
  { args: ['--control', '/synthetic/native'] },
  {
    args: ['--receipt-directory', '/outside', '--project-root', '/project']
  }
])('rejects missing or unowned CLI configuration without native effects: %j', async ({ args }) => {
  const f = fixture();
  const result = await f.run({
    receiptDirectory: f.receiptDirectory,
    projectRoot: f.projectRoot,
    args
  });
  zeroEffects(result);
  expect(result.code).toBe(1);
  expect(result.receipts).toEqual([]);
  expect(result.stdout).toBe('');
});
