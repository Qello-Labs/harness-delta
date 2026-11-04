import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { BoundedCandidateInvocation, MAX_CANDIDATE_DURATION_MS } from '../src/bounded-candidate-invocation.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'bounded-node-synthetic-'));
  const expected = { rootSessionId: 'synthetic-root', childModel: 'synthetic-child-model', childEffort: 'high' };
  const create = () => new BoundedCandidateInvocation(dir, expected);
  const request = { callerSessionId: 'synthetic-root', parentSessionId: 'synthetic-root', depth: 1, model: 'synthetic-child-model', effort: 'high' };
  return { dir, create, request, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
function cleanupOwnedPid(path: string): void {
  try {
    const pid = Number(readFileSync(path, 'utf8'));
    if (Number.isSafeInteger(pid) && pid > 0) process.kill(pid, 'SIGKILL');
  } catch {
    /* Missing fixture PID or already exited. */
  }
}
async function waitDead(pid: number): Promise<void> {
  for (let i = 0; i < 30 && alive(pid); i++) await new Promise(resolve => setTimeout(resolve, 20));
  expect(alive(pid)).toBe(false);
}

test('atomic one direct-child reservation refuses nested/foreign/wrong settings and simultaneous second calls', async () => {
  const f = fixture();
  try {
    const invocation = f.create();
    for (const patch of [{ callerSessionId: 'child' }, { parentSessionId: 'foreign' }, { depth: 2 }, { model: 'wrong' }, { effort: 'low' }])
      expect(() => invocation.reserveDirectChild({ ...f.request, ...patch })).toThrow('candidate_child_scope_mismatch');
    const results = await Promise.allSettled([
      Promise.resolve().then(() => invocation.reserveDirectChild(f.request)),
      Promise.resolve().then(() => f.create().reserveDirectChild(f.request))
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
    expect(() => invocation.reserveDirectChild(f.request)).toThrow('candidate_child_already_reserved');
  } finally {
    f.cleanup();
  }
});

test('root invocation is durable one-use with no retry after completion or launch failure', async () => {
  const f = fixture();
  try {
    const result = await f.create().run(process.execPath, ['-e', "process.stdout.write('PRIVATE_SENTINEL');process.stderr.write('PRIVATE_SENTINEL')"], 1000);
    expect(result).toMatchObject({ status: 'completed', exitCode: 0 });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_SENTINEL');
    await expect(f.create().run(process.execPath, ['-e', 'process.exit(0)'], 1000)).rejects.toThrow('candidate_root_already_started');
  } finally {
    f.cleanup();
  }
  const failed = fixture();
  try {
    expect(await failed.create().run(join(failed.dir, 'missing-binary'), [], 1000)).toMatchObject({ status: 'launch_failed', exitCode: null });
    await expect(failed.create().run(process.execPath, ['-e', 'process.exit(0)'], 1000)).rejects.toThrow('candidate_root_already_started');
  } finally {
    failed.cleanup();
  }
});

test('duration ceiling is 180 seconds and invalid durations never start a process', async () => {
  const f = fixture();
  try {
    expect(MAX_CANDIDATE_DURATION_MS).toBe(180_000);
    for (const value of [0, -1, 180_001, 1.5, NaN])
      await expect(f.create().run(process.execPath, ['-e', 'process.exit(0)'], value)).rejects.toThrow('candidate_invalid_invocation');
    expect(await f.create().run(process.execPath, ['-e', 'process.exit(0)'], 1000)).toMatchObject({ status: 'completed' });
  } finally {
    f.cleanup();
  }
});

test('deadline kills the root process group including a descendant that ignores SIGTERM', async () => {
  const f = fixture();
  const pidFile = join(f.dir, 'pid');
  const childScript = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
  const script = `const {spawn}=require('node:child_process');const fs=require('node:fs');const c=spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(()=>{},1000)`;
  try {
    const started = Date.now();
    expect(await f.create().run(process.execPath, ['-e', script], 250)).toMatchObject({ status: 'timed_out' });
    expect(Date.now() - started).toBeLessThan(1500);
    await waitDead(Number(readFileSync(pidFile, 'utf8')));
    await expect(f.create().run(process.execPath, ['-e', 'process.exit(0)'], 1000)).rejects.toThrow('candidate_root_already_started');
  } finally {
    cleanupOwnedPid(pidFile);
    f.cleanup();
  }
});

test.each([0, 7])('root exit %i tears down descendants even with ignored stdio', async exitCode => {
  const f = fixture();
  const pidFile = join(f.dir, 'pid');
  const childScript = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
  const script = `const {spawn}=require('node:child_process');const fs=require('node:fs');const c=spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid));c.unref();setTimeout(()=>process.exit(${String(exitCode)}),100)`;
  try {
    const started = Date.now();
    expect(await f.create().run(process.execPath, ['-e', script], 1000)).toMatchObject({ status: exitCode === 0 ? 'completed' : 'failed', exitCode });
    expect(Date.now() - started).toBeLessThan(1500);
    await waitDead(Number(readFileSync(pidFile, 'utf8')));
  } finally {
    cleanupOwnedPid(pidFile);
    f.cleanup();
  }
});

test('opt-in failure diagnostics classify known errors without retaining private stdout/stderr', async () => {
  const f = fixture();
  try {
    const script =
      "process.stdout.write('PRIVATE_STDOUT');process.stderr.write('ERROR: Missing bearer or basic authentication in header PRIVATE_SECRET\\n');process.exitCode=1";
    const result = await f.create().run(process.execPath, ['-e', script], 3000, { codexFailureDiagnostics: true });
    expect(result).toMatchObject({
      status: 'failed',
      exitCode: 1,
      failureDiagnostics: {
        channel: 'stderr',
        signals: [{ category: 'auth_missing', code: 'missing_authentication' }],
        unknownErrorObserved: false,
        truncated: false
      }
    });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  } finally {
    f.cleanup();
  }
});

test('opt-in stderr drain stays bounded under a flood and does not retain late raw output', async () => {
  const f = fixture();
  try {
    const script =
      "process.stdout.write('PRIVATE_STDOUT');process.stderr.write('PRIVATE'.repeat(100000)+'\\nERROR: unexpected status 401 PRIVATE_SECRET\\n');process.exitCode=1";
    const result = await f.create().run(process.execPath, ['-e', script], 3000, { codexFailureDiagnostics: true });
    expect(result).toMatchObject({ status: 'failed', exitCode: 1, failureDiagnostics: { signals: [], truncated: true } });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  } finally {
    f.cleanup();
  }
});

test('opt-in inherited stderr never blocks root exit or forced descendant teardown', async () => {
  const f = fixture();
  const pidFile = join(f.dir, 'pid');
  const childScript = "process.on('SIGTERM',()=>{});process.stderr.write('ERROR: ENOTFOUND PRIVATE_URL\\n');setInterval(()=>{},1000)";
  const script = `const {spawn}=require('node:child_process');const fs=require('node:fs');const c=spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{stdio:['ignore','ignore',2]});fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid));c.unref();setTimeout(()=>process.exit(7),200)`;
  try {
    const started = Date.now();
    const result = await f.create().run(process.execPath, ['-e', script], 3000, { codexFailureDiagnostics: true });
    expect(result).toMatchObject({ status: 'failed', exitCode: 7, failureDiagnostics: { signals: [{ category: 'network', code: 'enotfound' }] } });
    expect(Date.now() - started).toBeLessThan(1500);
    await waitDead(Number(readFileSync(pidFile, 'utf8')));
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  } finally {
    cleanupOwnedPid(pidFile);
    f.cleanup();
  }
});

test('opt-in launch failure and deadline retain fixed-only summaries and durable one-use guard', async () => {
  for (const mode of ['launch', 'timeout'] as const) {
    const f = fixture();
    try {
      const result =
        mode === 'launch'
          ? await f.create().run(join(f.dir, 'missing-binary'), [], 1000, { codexFailureDiagnostics: true })
          : await f.create().run(process.execPath, ['-e', "process.stderr.write('ERROR: ENOTFOUND PRIVATE_URL\\n');setInterval(()=>{},1000)"], 250, {
              codexFailureDiagnostics: true
            });
      expect(result.status).toBe(mode === 'launch' ? 'launch_failed' : 'timed_out');
      expect(result.failureDiagnostics?.channel).toBe('stderr');
      expect(JSON.stringify(result)).not.toContain('PRIVATE');
      await expect(f.create().run(process.execPath, ['-e', 'process.exit(0)'], 1000, { codexFailureDiagnostics: true })).rejects.toThrow(
        'candidate_root_already_started'
      );
    } finally {
      f.cleanup();
    }
  }
});
