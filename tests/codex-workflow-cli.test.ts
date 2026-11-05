import { expect, test } from 'vitest';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { codexWorkflowFixture } from './helpers/codex-workflow-fixture.js';
import { compiledWorker } from './helpers/compiled-worker.js';
import type { WorkflowAdapterResult } from '../src/task-workflow.js';

test('real measurement CLI invokes the shared engine for launch, resume, explicit link, collect and durable stop', async () => {
  const f = codexWorkflowFixture();
  try {
    const compiled = compiledWorker(f.root);
    const entry = join(f.root, 'cli.mjs');
    writeFileSync(
      entry,
      `import {main} from ${JSON.stringify(join(compiled, 'cli.js'))};import {createSyntheticCodexWorkflowAdapter} from ${JSON.stringify(join(compiled, 'codex-workflow-adapter.js'))};process.exitCode=await main(process.argv.slice(2),{codexAdapter:(store,input)=>createSyntheticCodexWorkflowAdapter(store,input,${JSON.stringify(f.script)})});`
    );
    const config = join(f.root, 'config.json');
    const runtime = join(f.root, 'runtime.json');
    const execution = join(f.root, 'execution.json');
    writeFileSync(runtime, JSON.stringify({ model: null, effort: null }));
    const call = (args: string[]) =>
      new Promise<{ code: number | null; stdout: string; stderr: string }>((ok, no) => {
        const child = spawn(process.execPath, [entry, '--db', f.database, 'workflow', 'codex', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', chunk => {
          stdout += String(chunk);
        });
        child.stderr.on('data', chunk => {
          stderr += String(chunk);
        });
        child.on('error', no);
        child.on('exit', code => ok({ code, stdout, stderr }));
      });
    const configure = (id: string, operation: 'launch' | 'resume' | 'link' | 'collect', session?: string, source?: string) => {
      writeFileSync(config, JSON.stringify({ ...f.input, confirmation_id: id + '-confirmation' }));
      writeFileSync(execution, JSON.stringify(f.execution(id, operation, session, source)));
      return [operation, '--config', config, '--runtime', runtime, '--execution', execution];
    };
    const first = await call(configure('cli-launch', 'launch'));
    expect(first.code, first.stderr + first.stdout).toBe(0);
    const receipt = JSON.parse(first.stdout) as { adapter_result: WorkflowAdapterResult };
    expect(receipt.adapter_result).toMatchObject({ state: 'completed', observed_requests: 1 });
    const resumed = await call(configure('cli-resume', 'resume', receipt.adapter_result.session_id!));
    expect(resumed.code, resumed.stderr + resumed.stdout).toBe(0);
    expect((JSON.parse(resumed.stdout) as { adapter_result: WorkflowAdapterResult }).adapter_result).toMatchObject({
      state: 'completed',
      observed_requests: 1
    });
    const root = f.newRoot();
    f.appendUsage(root);
    const link = await call(configure('cli-link', 'link', root.id, root.path));
    expect(link.code, link.stderr + link.stdout).toBe(0);
    expect(f.store.eventCount()).toBe(2);
    const collecting = call(configure('cli-collect', 'collect', root.id));
    const deadline = Date.now() + 4000;
    while (!f.store.get("SELECT 1 FROM codex_workflow_runs WHERE id='cli-collect' AND identity_verified=1") && Date.now() < deadline)
      await new Promise(ok => setTimeout(ok, 10));
    expect(f.store.get("SELECT 1 FROM codex_workflow_runs WHERE id='cli-collect' AND identity_verified=1")).toBeDefined();
    f.appendUsage(root);
    while (f.store.eventCount() < 3 && Date.now() < deadline) await new Promise(ok => setTimeout(ok, 10));
    expect(f.store.eventCount()).toBe(3);
    const stopped = await call(['stop', 'cli-collect']);
    expect(stopped.code, stopped.stderr + stopped.stdout).toBe(0);
    const collected = await collecting;
    expect(collected.code, collected.stderr + collected.stdout).toBe(0);
    expect((JSON.parse(collected.stdout) as { adapter_result: WorkflowAdapterResult }).adapter_result).toMatchObject({
      state: 'stopped',
      reason: 'stop_requested',
      observed_requests: 1
    });
    expect(f.store.all('SELECT * FROM sessions')).toHaveLength(2);
    expect(f.store.all('SELECT * FROM comparison_assignments')).toHaveLength(1);
    expect(first.stdout + resumed.stdout + link.stdout + collected.stdout).not.toContain('SYNTHETIC_PRIVATE');
  } finally {
    f.cleanup();
  }
}, 15000);

test('public CLI cannot use the synthetic dependency or bypass native source qualification', async () => {
  const f = codexWorkflowFixture();
  try {
    const compiled = compiledWorker(f.root);
    const config = join(f.root, 'config.json');
    const runtime = join(f.root, 'runtime.json');
    const execution = join(f.root, 'execution.json');
    writeFileSync(config, JSON.stringify(f.input));
    writeFileSync(runtime, JSON.stringify({ model: null, effort: null }));
    writeFileSync(execution, JSON.stringify(f.execution('blocked')));
    const result = await new Promise<{ code: number | null; stdout: string }>((ok, no) => {
      const child = spawn(
        process.execPath,
        [join(compiled, 'cli.js'), '--db', f.database, 'workflow', 'codex', 'launch', '--config', config, '--runtime', runtime, '--execution', execution],
        { stdio: ['ignore', 'pipe', 'ignore'] }
      );
      let stdout = '';
      child.stdout.on('data', chunk => {
        stdout += String(chunk);
      });
      child.on('error', no);
      child.on('exit', code => ok({ code, stdout }));
    });
    expect(result).toEqual({ code: 2, stdout: '' });
    expect(f.store.all('SELECT * FROM codex_workflow_runs')).toHaveLength(0);
    expect(f.store.eventCount()).toBe(0);
  } finally {
    f.cleanup();
  }
}, 10000);
