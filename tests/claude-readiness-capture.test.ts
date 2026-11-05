import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import { createReadinessProbeSink } from '../src/qualification/binding-readiness-probe.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'hd-synthetic-readiness-wrapper-'));
  const database = join(root, 'scope.sqlite');
  const projectRoot = join(root, 'project');
  const receipts = join(root, 'receipts');
  const channel = join(root, 'channel');
  for (const dir of [projectRoot, receipts, join(receipts, 'connect'), channel]) mkdirSync(dir, { mode: 0o700 });
  const sessionId = randomUUID(),
    taskId = randomUUID(),
    projectId = randomUUID(),
    instanceId = randomUUID();
  const agent = 'synthetic';
  const source = join(projectRoot, sessionId + '.jsonl');
  const metadata = execFileSync('/bin/ps', ['-o', 'uid=', '-o', 'lstart=', '-p', String(process.pid)], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' }
  }).trim();
  const identity = {
    product: 'claude_code',
    sessionId,
    cwd: projectRoot,
    parentSessionId: null,
    nativeMapping: {
      nativeSessionId: sessionId,
      agentId: null,
      processId: `claude-process:${process.pid}:${createHash('sha256')
        .update(JSON.stringify([process.pid, metadata]))
        .digest('hex')}`
    }
  };
  const db = new Database(database);
  db.exec(
    'CREATE TABLE projects(id TEXT, local_root TEXT); CREATE TABLE tasks(id TEXT,project_id TEXT,state TEXT,generation INTEGER); CREATE TABLE session_bindings(task_id TEXT,session_id TEXT,root_id TEXT,state TEXT,identity TEXT,generation INTEGER)'
  );
  db.prepare('INSERT INTO projects VALUES (?,?)').run(projectId, projectRoot);
  db.prepare('INSERT INTO tasks VALUES (?,?,?,?)').run(taskId, projectId, 'active', 1);
  db.prepare('INSERT INTO session_bindings VALUES (?,?,?,?,?,?)').run(taskId, sessionId, sessionId, 'observing', JSON.stringify(identity), 1);
  const audit = join(root, 'audit.jsonl');
  writeFileSync(audit, '', { mode: 0o600 });
  const configPath = join(root, 'config.json');
  const module = resolve('dist/qualification/binding-readiness-probe.js');
  const config = {
    database,
    databaseModule: resolve('node_modules/better-sqlite3/lib/index.js'),
    node: process.execPath,
    hook: resolve('scripts/claude-session-hook.mjs'),
    projectRoot,
    taskId,
    projectId,
    sessionId,
    receipts,
    audit,
    readinessProbe: {
      directory: channel,
      instanceId,
      generation: 1,
      module,
      moduleHash: existsSync(module) ? createHash('sha256').update(readFileSync(module)).digest('hex') : 'unbuilt'
    }
  };
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  const input = {
    session_id: sessionId,
    cwd: projectRoot,
    transcript_path: source,
    hook_event_name: 'SubagentStart',
    agent_id: agent,
    agent_type: 'Explore',
    last_assistant_message: 'SYNTHETIC_PRIVATE_SENTINEL'
  };
  const start = (sendInput = true) => {
    const child = spawn(process.execPath, [resolve('scripts/claude-readiness-capture.mjs'), configPath, 'SubagentStart'], {
      env: { ...process.env, CLAUDE_PID: String(process.pid) },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (bytes: Buffer) => {
      stdout += bytes.toString();
    });
    child.stderr.on('data', (bytes: Buffer) => {
      stderr += bytes.toString();
    });
    child.stdin.on('error', () => {});
    const endInput = () => child.stdin.end(JSON.stringify(input));
    if (sendInput) endInput();
    const done = new Promise<{ code: number | null; stdout: string; stderr: string }>(resolveResult => {
      child.on('close', code => {
        resolveResult({ code, stdout, stderr });
      });
    });
    return { child, done, endInput };
  };
  return {
    root,
    db,
    config,
    configPath,
    channel,
    input,
    start,
    receiptPath: join(receipts, 'sessions', sessionId, 'agents', agent + '.subagent_start.json'),
    cleanup: () => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  };
}

test('prepared wrapper records the real synthetic Start before waiting and retains no raw input', async () => {
  const f = fixture();
  const run = f.start();
  try {
    await expect.poll(() => existsSync(f.receiptPath), { timeout: 1500 }).toBe(true);
    const receipt = JSON.parse(readFileSync(f.receiptPath, 'utf8')) as { receipt_id: string; recorded_at: string };
    await delay(40);
    const sink = createReadinessProbeSink({
      directory: f.channel,
      instanceId: f.config.readinessProbe.instanceId,
      selection: { taskId: f.config.taskId, rootSessionId: f.config.sessionId, generation: 1 },
      currentScope: () => true
    });
    sink({
      phase: 'hold_entered',
      attemptId: randomUUID(),
      taskId: f.config.taskId,
      rootSessionId: f.config.sessionId,
      generation: 1,
      starts: [{ receiptId: receipt.receipt_id, agentId: 'synthetic', recordedAt: receipt.recorded_at }],
      elapsedMs: 0,
      deadline: new Date(Date.parse(receipt.recorded_at) + 2000).toISOString(),
      boundary: null
    });
    expect(await run.done).toEqual({ code: 0, stdout: '', stderr: '' });
    const audit = readFileSync(f.config.audit, 'utf8');
    expect(audit).toContain('hold_acknowledged');
    expect(audit).not.toContain('SYNTHETIC_PRIVATE_SENTINEL');
    expect(readFileSync(f.receiptPath, 'utf8')).not.toContain('SYNTHETIC_PRIVATE_SENTINEL');
  } finally {
    await run.done;
    f.cleanup();
  }
});

test('inactive selected scope exits silently before recording or waiting', async () => {
  const f = fixture();
  f.db.prepare("UPDATE tasks SET state='paused'").run();
  try {
    expect(await f.start().done).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(existsSync(f.receiptPath)).toBe(false);
    expect(readFileSync(f.config.audit, 'utf8')).toBe('');
  } finally {
    f.cleanup();
  }
});

test('a missing acknowledgment releases with an inconclusive audit and duplicate Start does not wait again', async () => {
  const f = fixture();
  try {
    expect(await f.start().done).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(readFileSync(f.config.audit, 'utf8')).toContain('hold_unverified');
    expect(existsSync(f.receiptPath)).toBe(true);
    const first = readFileSync(f.receiptPath);
    writeFileSync(f.config.audit, '');
    expect(await f.start().done).toEqual({ code: 0, stdout: '', stderr: '' });
    const second = readFileSync(f.config.audit, 'utf8');
    expect(second).toContain('receipt_exists');
    expect(second).not.toContain('readiness_probe');
    expect(readFileSync(f.receiptPath)).toEqual(first);
  } finally {
    f.cleanup();
  }
});

test('pause or generation change during the wait rejects even a matching held marker', async () => {
  const f = fixture();
  const run = f.start();
  try {
    await expect.poll(() => existsSync(f.receiptPath), { timeout: 1500 }).toBe(true);
    const receipt = JSON.parse(readFileSync(f.receiptPath, 'utf8')) as { receipt_id: string; recorded_at: string };
    f.db.prepare("UPDATE tasks SET state='paused',generation=2").run();
    const sink = createReadinessProbeSink({
      directory: f.channel,
      instanceId: f.config.readinessProbe.instanceId,
      selection: { taskId: f.config.taskId, rootSessionId: f.config.sessionId, generation: 1 },
      currentScope: () => true
    });
    sink({
      phase: 'hold_entered',
      attemptId: randomUUID(),
      taskId: f.config.taskId,
      rootSessionId: f.config.sessionId,
      generation: 1,
      starts: [{ receiptId: receipt.receipt_id, agentId: 'synthetic', recordedAt: receipt.recorded_at }],
      elapsedMs: 0,
      deadline: new Date(Date.parse(receipt.recorded_at) + 2000).toISOString(),
      boundary: null
    });
    expect(await run.done).toEqual({ code: 0, stdout: '', stderr: '' });
    const audit = readFileSync(f.config.audit, 'utf8');
    expect(audit).toContain('hold_unverified');
    expect(audit).not.toContain('hold_acknowledged');
  } finally {
    await run.done;
    f.cleanup();
  }
});

test('an invalid operator module hash cannot activate the probe or suppress a normal Start receipt', async () => {
  const f = fixture();
  try {
    f.config.readinessProbe.moduleHash = '0'.repeat(64);
    writeFileSync(f.configPath, JSON.stringify(f.config));
    expect(await f.start().done).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(existsSync(f.receiptPath)).toBe(true);
    expect(readFileSync(f.config.audit, 'utf8')).toContain('hold_unverified');
    const receipt = JSON.parse(readFileSync(f.receiptPath, 'utf8')) as { receipt_id: string };
    expect(existsSync(join(f.channel, receipt.receipt_id + '.claim'))).toBe(false);
  } finally {
    f.cleanup();
  }
});

test('a stale observing root generation cannot read input or record Start', async () => {
  const f = fixture();
  f.db.prepare('UPDATE tasks SET generation=2').run();
  try {
    expect(await f.start().done).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(existsSync(f.receiptPath)).toBe(false);
    expect(readFileSync(f.config.audit, 'utf8')).toBe('');
  } finally {
    f.cleanup();
  }
});

test('pause while waiting for hook stdin prevents the subsequent recorder invocation', async () => {
  const f = fixture();
  const run = f.start(false);
  try {
    await expect.poll(() => readFileSync(f.config.audit, 'utf8'), { timeout: 1500 }).toContain('command_entered');
    f.db.prepare("UPDATE tasks SET state='paused',generation=2").run();
    run.endInput();
    expect(await run.done).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(existsSync(f.receiptPath)).toBe(false);
  } finally {
    run.endInput();
    await run.done;
    f.cleanup();
  }
});

test('a stalled optional module is isolated and cannot add its full latency or late success to hook return', async () => {
  const f = fixture();
  const workerPidFile = join(f.root, 'owned-worker.pid');
  const slowModule = join(f.root, 'slow.mjs');
  writeFileSync(
    slowModule,
    `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(workerPidFile)}, String(process.pid), {mode:0o600}); const end=performance.now()+1500; while(performance.now()<end){}; export async function waitForReadinessProbeHold(){return {status:'acknowledged'};}`,
    { mode: 0o600 }
  );
  f.config.readinessProbe.module = slowModule;
  f.config.readinessProbe.moduleHash = createHash('sha256').update(readFileSync(slowModule)).digest('hex');
  writeFileSync(f.configPath, JSON.stringify(f.config));
  const run = f.start();
  try {
    await expect.poll(() => existsSync(f.receiptPath), { timeout: 1500 }).toBe(true);
    const receipt = JSON.parse(readFileSync(f.receiptPath, 'utf8')) as { recorded_at: string };
    expect(await run.done).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(Date.now() - Date.parse(receipt.recorded_at)).toBeLessThan(1100);
    const audit = readFileSync(f.config.audit, 'utf8');
    expect(audit).toContain('hold_unverified');
    expect(audit).not.toContain('hold_acknowledged');
    expect(existsSync(workerPidFile)).toBe(true);
    const pid = Number(readFileSync(workerPidFile, 'utf8'));
    await expect
      .poll(
        () => {
          try {
            process.kill(pid, 0);
            return false;
          } catch {
            return true;
          }
        },
        { timeout: 1000 }
      )
      .toBe(true);
    expect(() => process.kill(process.pid, 0)).not.toThrow();
  } finally {
    await run.done;
    f.cleanup();
  }
});
