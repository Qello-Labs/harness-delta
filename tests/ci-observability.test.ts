import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { afterEach, expect, test } from 'vitest';

const phase = resolve('scripts/ci-phase.mjs');
const reporter = resolve('scripts/ci-reporter.mjs');
const vitest = resolve('node_modules/vitest/vitest.mjs');
const vitestImport = resolve('node_modules/vitest/dist/index.js');
const directories: string[] = [];
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'ci-observability-'));
  directories.push(directory);
  return directory;
}
function records(directory: string, file: string): Record<string, unknown>[] {
  return readFileSync(join(directory, '.harness-delta/ci-results/default', file), 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as Record<string, unknown>);
}
async function within<T>(work: Promise<T>, milliseconds: number, reason: string): Promise<T> {
  const timer = new AbortController();
  try {
    return await Promise.race([
      work,
      setTimeout(milliseconds, undefined, { signal: timer.signal }).then(() => {
        throw new Error(reason);
      })
    ]);
  } finally {
    timer.abort();
  }
}
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test('phase timing preserves successful and failing child exit codes without storing child output', () => {
  const directory = fixture();
  for (const code of [0, 7]) {
    const run = spawnSync(
      process.execPath,
      [phase, 'default', 'build', process.execPath, '-e', `console.error('synthetic-private-marker'); process.exit(${code})`],
      { cwd: directory, encoding: 'utf8' }
    );
    expect(run.status).toBe(code);
  }
  const phases = records(directory, 'phases.jsonl');
  expect(phases.map(row => row.status)).toEqual(['running', 'passed', 'running', 'failed']);
  expect(phases.filter(row => row.status !== 'running').map(row => row.exitCode)).toEqual([0, 7]);
  expect(phases[1]?.durationMs).toEqual(expect.any(Number));
  expect(JSON.stringify(phases)).not.toContain('synthetic-private-marker');
});

test('phase timing reports launch errors and signal termination as failures', () => {
  const directory = fixture();
  const missing = spawnSync(process.execPath, [phase, 'default', 'build', './missing-ci-command'], { cwd: directory });
  expect(missing.status).toBe(1);
  const signal = spawnSync(process.execPath, [phase, 'default', 'build', process.execPath, '-e', "process.kill(process.pid, 'SIGTERM')"], { cwd: directory });
  expect(signal.status).not.toBe(0);
  expect(records(directory, 'phases.jsonl').map(row => row.status)).toEqual(['running', 'failed', 'running', 'failed']);
});

test('reporter persists only identities statuses durations and runner metadata on assertion failure', () => {
  const directory = fixture();
  writeFileSync(join(directory, 'vitest.config.mjs'), 'export default { test: { include: ["*.test.mjs"] } };');
  writeFileSync(
    join(directory, 'synthetic.test.mjs'),
    `
    import { test, expect } from ${JSON.stringify(vitestImport)};
    test('synthetic pass', () => { console.log('synthetic-console-secret'); expect(1).toBe(1); });
    test('synthetic failure', () => { expect('synthetic-response-body').toBe('synthetic-expected'); });
  `
  );
  const run = spawnSync(
    process.execPath,
    [phase, 'default', 'tests', process.execPath, vitest, 'run', '--config', join(directory, 'vitest.config.mjs'), '--reporter', reporter],
    { cwd: directory, encoding: 'utf8' }
  );
  expect(run.status).toBe(1);
  const results = records(directory, 'tests.jsonl');
  const cases = results.filter(row => row.type === 'test');
  expect(cases.map(row => [row.file, row.name, row.status])).toEqual([
    ['synthetic.test.mjs', 'synthetic pass', 'passed'],
    ['synthetic.test.mjs', 'synthetic failure', 'failed']
  ]);
  for (const row of cases) {
    expect(Object.keys(row).sort()).toEqual(['durationMs', 'file', 'id', 'name', 'project', 'status', 'type']);
    expect(row.durationMs).toEqual(expect.any(Number));
  }
  expect(results.at(-1)).toEqual({ type: 'run', status: 'failed' });
  expect(JSON.stringify(results)).not.toMatch(/synthetic-console-secret|synthetic-response-body|synthetic-expected|stack|errors/);
}, 15000);

test('reporter captures collection failure without serializing its error', () => {
  const directory = fixture();
  writeFileSync(join(directory, 'vitest.config.mjs'), 'export default { test: { include: ["*.test.mjs"] } };');
  writeFileSync(join(directory, 'synthetic.test.mjs'), "throw new Error('synthetic-import-secret');");
  const run = spawnSync(
    process.execPath,
    [phase, 'default', 'tests', process.execPath, vitest, 'run', '--config', join(directory, 'vitest.config.mjs'), '--reporter', reporter],
    { cwd: directory, encoding: 'utf8' }
  );
  expect(run.status).toBe(1);
  const results = records(directory, 'tests.jsonl');
  expect(results.some(row => row.type === 'file' && row.file === 'synthetic.test.mjs' && row.status === 'failed')).toBe(true);
  expect(results.at(-1)).toEqual({ type: 'run', status: 'failed' });
  expect(JSON.stringify(results)).not.toContain('synthetic-import-secret');
}, 15000);

test('unhandled rejection fails the terminal report even when every test passes without serializing errors', () => {
  const directory = fixture();
  writeFileSync(join(directory, 'vitest.config.mjs'), 'export default { test: { include: ["*.test.mjs"] } };');
  writeFileSync(
    join(directory, 'synthetic.test.mjs'),
    `
    import { test, expect } from ${JSON.stringify(vitestImport)};
    test('synthetic passing assertion', async () => {
      void Promise.reject(new Error('synthetic-unhandled-secret'));
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(1).toBe(1);
    });
  `
  );
  const run = spawnSync(
    process.execPath,
    [phase, 'default', 'tests', process.execPath, vitest, 'run', '--config', join(directory, 'vitest.config.mjs'), '--reporter', reporter],
    { cwd: directory, encoding: 'utf8' }
  );
  expect(run.status).toBe(1);
  const results = records(directory, 'tests.jsonl');
  expect(results).toContainEqual(expect.objectContaining({ type: 'test', status: 'passed' }));
  expect(results.at(-1)).toEqual({ type: 'run', status: 'failed' });
  expect(JSON.stringify(results)).not.toContain('synthetic-unhandled-secret');
}, 15000);

test('terminal interruption takes precedence over unhandled errors', () => {
  const directory = fixture();
  const run = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import Reporter from ${JSON.stringify(reporter)};
    new Reporter().onTestRunEnd([], [new Error('synthetic-interrupted-secret')], 'interrupted');
  `
    ],
    { cwd: directory, encoding: 'utf8', env: { ...process.env, CI_RESULTS_JOB: 'default' } }
  );
  expect(run.status).toBe(0);
  expect(records(directory, 'tests.jsonl')).toEqual([{ type: 'run', status: 'interrupted' }]);
});

test('completed test records survive an interrupted run and phase cancellation remains nonzero', async () => {
  const directory = fixture();
  // A short fixture deadline makes a naturally completing child fail the delayed-observer regression.
  writeFileSync(join(directory, 'vitest.config.mjs'), 'export default { test: { include: ["*.test.mjs"], testTimeout: 100 } };');
  const readyMarker = 'ci-fixture-record-ready\n';
  const interruptionReporter = join(directory, 'interruption-reporter.mjs');
  writeFileSync(
    interruptionReporter,
    `
    import Reporter from ${JSON.stringify(reporter)};
    export default class extends Reporter {
      onTestCaseResult(test) {
        super.onTestCaseResult(test);
        if (test.fullName === 'completed before interruption') process.stdout.write(${JSON.stringify(readyMarker)});
      }
    }
  `
  );
  writeFileSync(
    join(directory, 'synthetic.test.mjs'),
    `
    import { test, expect } from ${JSON.stringify(vitestImport)};
    test('completed before interruption', () => { expect(1).toBe(1); });
    // This synthetic test must remain pending until the parent interrupts it.
    test('waiting at interruption', { timeout: 0 }, async () => { await new Promise(() => {}); });
  `
  );
  const child = spawn(
    process.execPath,
    [phase, 'default', 'tests', process.execPath, vitest, 'run', '--config', join(directory, 'vitest.config.mjs'), '--reporter', interruptionReporter],
    { cwd: directory, detached: true, stdio: ['ignore', 'pipe', 'ignore'] }
  );
  let ended = false;
  const closed = new Promise<number | null>((done, reject) => {
    child.once('error', reject);
    child.once('close', code => {
      ended = true;
      done(code);
    });
  });
  const ready = new Promise<void>((done, reject) => {
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-1024);
      if (output.includes(readyMarker)) done();
    });
    child.once('error', reject);
    child.once('exit', () => {
      reject(new Error('ci_fixture_exited_before_ready'));
    });
  });
  try {
    await within(ready, 10000, 'ci_fixture_readiness_timeout');
    // Model a delayed observer after readiness, longer than the synthetic fixture's deadline.
    await setTimeout(400);
    expect(ended).toBe(false);
    expect(records(directory, 'phases.jsonl').at(-1)?.status).toBe('running');
  } finally {
    child.kill('SIGTERM');
    try {
      expect(await within(closed, 2000, 'ci_fixture_termination_timeout')).not.toBe(0);
    } finally {
      // The fixture owns its fresh process group; reclaim workers even if graceful shutdown fails.
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* The fixture group is already gone. */
        }
      }
      await within(closed, 2000, 'ci_fixture_reap_timeout');
    }
  }
  expect(records(directory, 'tests.jsonl')).toContainEqual(
    expect.objectContaining({
      type: 'test',
      name: 'completed before interruption',
      status: 'passed'
    })
  );
  expect(records(directory, 'phases.jsonl').at(-1)?.status).toBe('interrupted');
}, 15000);
