import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { main } from '../src/cli.js';
import { createSyntheticCodexWorkflowAdapter } from '../src/codex-workflow-adapter.js';
import { codexWorkflowFixture } from './helpers/codex-workflow-fixture.js';
import { externalInstructionFragment } from '../src/external-session-context.js';

test('CLI prepares without activation, explicitly connects and never accepts launch as an external operation', async () => {
  const f = codexWorkflowFixture();
  const out: string[] = [];
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => {
    out.push(String(chunk));
    return true;
  });
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    const config = join(f.root, 'config.json');
    const runtime = join(f.root, 'runtime.json');
    const spec = join(f.root, 'spec.json');
    const execution = join(f.root, 'execution.json');
    writeFileSync(config, JSON.stringify(f.input));
    writeFileSync(runtime, JSON.stringify({ model: null, effort: null }));
    writeFileSync(spec, JSON.stringify({ schema_version: 1, common_artifacts: [], common_manifest_hash: null, allowed_preimage_hashes: [] }));
    const args = ['--db', f.database, 'workflow', 'external'];
    const setup = ['--config', config, '--runtime', runtime, '--spec', spec];
    expect(await main([...args, 'prepare', ...setup, '--apply-managed-file'])).toBe(0);
    expect(f.store.get('SELECT state FROM tasks WHERE id=?', ['task-1'])).toEqual({ state: 'registered' });
    expect(JSON.parse(out.pop()!) as { state: string }).toMatchObject({ state: 'configuration_verified' });
    const source = f.newRoot();
    f.appendUsage(source);
    writeFileSync(execution, JSON.stringify(f.execution('cli-connect', 'link', source.id, source.path)));
    const dependencies = {
      codexAdapter: (store: Parameters<typeof createSyntheticCodexWorkflowAdapter>[0], input: unknown) =>
        createSyntheticCodexWorkflowAdapter(store, input, f.script)
    };
    expect(await main([...args, 'connect', ...setup, '--execution', execution], dependencies)).toBe(0);
    expect(f.store.eventCount()).toBe(0);
    const linked = JSON.parse(out.pop()!) as { adapter_result: { harness_application: string }; preparation: { loading_evidence: string } };
    expect(linked).toMatchObject({ adapter_result: { harness_application: 'external_unverified' }, preparation: { loading_evidence: 'unverified' } });
    writeFileSync(execution, JSON.stringify(f.execution('forbidden-launch', 'launch')));
    expect(await main([...args, 'connect', ...setup, '--execution', execution], dependencies)).toBe(2);
    expect(f.store.get('SELECT id FROM codex_workflow_runs WHERE id=?', ['forbidden-launch'])).toBeUndefined();
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
    f.cleanup();
  }
});

test('CLI opt-in handoff/connect/state/result and four human outcomes share the new first-connection contract', async () => {
  const f = codexWorkflowFixture();
  const out: string[] = [];
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => {
    out.push(String(chunk));
    return true;
  });
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    if (!f.store.get("SELECT 1 FROM sqlite_master WHERE name='external_task_contracts'")) {
      const db = new Database(f.database);
      try {
        db.exec(readFileSync(new URL('../src/migrations/019_external_connection_contract.sql', import.meta.url), 'utf8'));
      } finally {
        db.close();
      }
    }
    const config = join(f.root, 'config.json'),
      runtime = join(f.root, 'runtime.json'),
      spec = join(f.root, 'spec.json'),
      execution = join(f.root, 'execution.json');
    writeFileSync(config, JSON.stringify(f.input));
    writeFileSync(runtime, JSON.stringify({ model: null, effort: null }));
    writeFileSync(spec, JSON.stringify({ schema_version: 1, common_artifacts: [], common_manifest_hash: null, allowed_preimage_hashes: [] }));
    const args = ['--db', f.database, 'workflow', 'external'];
    const setup = ['--config', config, '--runtime', runtime, '--spec', spec];
    expect(await main([...args, 'prepare', ...setup, '--apply-managed-file', '--first-connection-clock'])).toBe(0);
    expect(JSON.parse(out.pop()!) as unknown).toMatchObject({ window: { started_at: null, ends_at: null }, report_contract: 'external-observation-v1' });
    expect(await main([...args, 'start', ...setup])).toBe(0);
    const ticket = JSON.parse(out.pop()!) as { ticket_id: string; start_command: string };
    expect(ticket.start_command).toContain('developer_instructions=');
    const source = f.newRoot(),
      at = new Date().toISOString();
    writeFileSync(
      source.path,
      JSON.stringify({
        timestamp: at,
        type: 'session_meta',
        payload: { id: source.id, session_id: source.id, cwd: f.project, cli_version: '0.160.0', source: 'cli' }
      }) + '\n'
    );
    appendFileSync(
      source.path,
      JSON.stringify({
        timestamp: at,
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'developer',
          content: [
            {
              type: 'input_text',
              text: externalInstructionFragment(ticket.ticket_id, readFileSync(join(f.project, '.harness-delta-managed', 'active-instructions.md'), 'utf8'))
            }
          ]
        }
      }) + '\n'
    );
    writeFileSync(execution, JSON.stringify(f.execution('typed-cli-link', 'link', source.id, source.path)));
    const dependencies = {
      codexAdapter: (db: Parameters<typeof createSyntheticCodexWorkflowAdapter>[0], input: unknown) => createSyntheticCodexWorkflowAdapter(db, input, f.script)
    };
    expect(await main([...args, 'connect', ...setup, '--execution', execution], dependencies)).toBe(2);
    expect(await main([...args, 'connect', ...setup, '--execution', execution, '--ticket', ticket.ticket_id], dependencies)).toBe(0);
    const connected = JSON.parse(out.pop()!) as { state: { window: { started_at: string; ends_at: string } } };
    expect(connected.state.window.started_at).toEqual(expect.any(String));
    expect(await main([...args, 'state', 'task-1'])).toBe(0);
    const state = JSON.parse(out.pop()!) as Record<string, unknown>;
    expect(state).not.toHaveProperty('comparison_followup_ends_at');
    expect(await main([...args, 'pause', 'task-1'])).toBe(0);
    out.pop();
    expect(await main([...args, 'outcome', 'task-1', 'rework'])).toBe(0);
    out.pop();
    expect(await main([...args, 'result', 'task-1'])).toBe(0);
    expect(JSON.parse(out.pop()!) as unknown).toMatchObject({ window: connected.state.window, time: { rework_count: 1 }, complete_cost: null });
    expect(await main([...args, 'outcome', 'task-1', 'failed'])).toBe(0);
    expect(JSON.parse(out.pop()!) as unknown).toMatchObject({ state: { outcome: 'failed' } });
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
    f.cleanup();
  }
});
