import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { createLocalWebServer } from '../src/local-web-server.js';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { localWebFixture } from './helpers/local-web-fixture.js';
import { createLocalWebDomain } from '../src/local-web-domain.js';
import { registerHarness, generateComparison, hashBytes } from '../src/harness-config.js';
import { comparisonVariant } from '../src/protocol-store.js';
import { assertSharedTask } from '../src/local-web-shared-guard.js';
import { applicationRequired } from '../src/harness-application.js';
test('agent comparison preparation persists assignment but neither applies files nor permits legacy apply or connect', async () => {
  const f = localWebFixture();
  writeFileSync(join(f.project, 'README.md'), 'Synthetic prerequisites');
  for (const [index, version] of ['v1', 'v2'].entries()) {
    writeFileSync(join(f.project, 'procedure.md'), readFileSync(f.input.artifacts[index]!.selected_artifacts[0]!.path));
    registerHarness(f.project, {
      schema_version: 1,
      harness_id: 'synthetic',
      version,
      policy_version: comparisonVariant(f.store, f.input.artifacts[index]!.variant_id).policy_version,
      readme_path: 'README.md',
      artifacts: [{ artifact_id: 'instruction', role: 'instruction', source_path: 'procedure.md', target_path: 'harness.md' }]
    });
  }
  generateComparison(f.project, { schema_version: 2, id: 'agent', name: 'Agent', arm_a: 'v1', arm_b: 'v2', application: 'agent_applied' });
  const domain = createLocalWebDomain({
    store: f.store,
    metadataFile: f.metadataFile,
    profiles: [f.profile],
    picker: () => Promise.resolve(join(f.project, 'harness-config/comparisons/agent.json'))
  });
  try {
    const preview = (await domain.importSetup!()) as { token: string };
    const bound = (await domain.bindSetup!({ token: preview.token, project_id: 'project-1', template_id: f.profile.id })) as { profile_id: string };
    const task = (await domain.createTask({ name: 'Synthetic apply', project_id: 'project-1', setup_id: bound.profile_id })) as {
      id: string;
      application?: { state: string };
      actions: { code: string; enabled: boolean }[];
    };
    expect(task.actions.find(a => a.code === 'application-prepare')).toMatchObject({ enabled: true });
    expect(applicationRequired(f.store, task.id)).toBe(true);
    expect(task.application?.state).toBe('awaiting_application');
    expect(f.store.all('SELECT * FROM comparison_assignments')).toHaveLength(1);
    expect(existsSync(join(f.project, '.harness-delta-managed/active-instructions.md'))).toBe(false);
    await expect(domain.taskAction(task.id, 'apply', {})).rejects.toThrow('application_required');
    await expect(domain.taskAction(task.id, 'ticket', {})).rejects.toThrow('application_required');
    expect(() => assertSharedTask(f.store, task.id)).toThrow('application_required');
    unlinkSync(join(f.project, `.harness-delta/applications/${task.id}/procedure.json`));
    expect(domain.task(task.id)).toMatchObject({ id: task.id, application: { state: 'failed' } });
    f.store.execute('DELETE FROM harness_application_tasks WHERE task_id=?', [task.id]);
    expect(applicationRequired(f.store, task.id)).toBe(true);
    expect(domain.task(task.id)).toMatchObject({ id: task.id, application: { state: 'failed' } });
  } finally {
    await domain.close?.();
    f.cleanup();
  }
});
test('HTTP direct application reviews dirty files, keeps assignment, and fences report replay after abandonment', async () => {
  const f = localWebFixture();
  writeFileSync(join(f.project, 'README.md'), 'Synthetic prerequisites');
  for (const [index, version] of ['v1', 'v2'].entries()) {
    writeFileSync(join(f.project, 'procedure.md'), readFileSync(f.input.artifacts[index]!.selected_artifacts[0]!.path));
    registerHarness(f.project, {
      schema_version: 1,
      harness_id: 'synthetic',
      version,
      policy_version: comparisonVariant(f.store, f.input.artifacts[index]!.variant_id).policy_version,
      readme_path: 'README.md',
      artifacts: [{ artifact_id: 'instruction', role: 'instruction', source_path: 'procedure.md', target_path: 'harness.md' }]
    });
  }
  generateComparison(f.project, { schema_version: 2, id: 'agent', name: 'Synthetic direct apply', arm_a: 'v1', arm_b: 'v2', application: 'agent_applied' });
  const domain = createLocalWebDomain({
    store: f.store,
    metadataFile: f.metadataFile,
    profiles: [f.profile],
    picker: () => Promise.resolve(join(f.project, 'harness-config/comparisons/agent.json'))
  });
  const origin = 'http://127.0.0.1:4318';
  const app = createLocalWebServer({ origin, domain, metadataFile: f.metadataFile });
  try {
    const preview = (await domain.importSetup!()) as { token: string };
    const bound = (await domain.bindSetup!({ token: preview.token, project_id: 'project-1', template_id: f.profile.id })) as { profile_id: string };
    const task = (await domain.createTask({ name: 'Synthetic direct apply', project_id: 'project-1', setup_id: bound.profile_id })) as { id: string };
    const bootstrap = (await app.inject({ url: '/api/bootstrap', headers: { host: '127.0.0.1:4318' } })).json<{ csrf: string }>();
    const headers = () => ({
      host: '127.0.0.1:4318',
      origin,
      'x-harness-csrf': bootstrap.csrf,
      'idempotency-key': randomUUID(),
      'if-match': domain.task(task.id).version
    });
    const post = (action: string, payload: unknown) =>
      app.inject({
        method: 'POST',
        url: `/api/tasks/${task.id}/${action}`,
        headers: { ...headers(), 'content-type': 'application/json' },
        payload: JSON.stringify(payload)
      });
    const largeReport = {
      attempt_id: randomUUID(),
      bundle_hash: 'a'.repeat(64),
      outputs: Array.from({ length: 256 }, (_, i) => ({
        path: `domain-${i}/${Array.from({ length: 10 }, () => 's'.repeat(190)).join('/')}/AGENTS.md`,
        checkpoint_id: randomUUID(),
        sha256: 'b'.repeat(64)
      })),
      checks: [{ check_id: 'synthetic', outcome: 'passed' }]
    };
    const originalAction = domain.taskAction.bind(domain);
    domain.taskAction = (id, action, input) =>
      action === 'application-report' ? Promise.resolve({ accepted_outputs: (input.outputs as unknown[]).length }) : originalAction(id, action, input);
    const largeReply = await post('application-report', largeReport);
    expect(largeReply.statusCode).toBe(200);
    expect(largeReply.json()).toEqual({ accepted_outputs: 256 });
    domain.taskAction = originalAction;
    const assignment = f.store.get('SELECT * FROM comparison_assignments WHERE task_id=?', [task.id]);
    const workspace = domain.applicationWorkspace!(task.id, f.project) as { digest: string };
    expect((await post('application-prepare', { workspace: f.project, workspaceDigest: workspace.digest, product: 'codex' })).statusCode).toBe(200);
    const status = domain.task(task.id).application as { jobId: string };
    const attempt = status.jobId;
    const context = (await app.inject({ url: `/api/tasks/${task.id}/application-context?attempt=${attempt}`, headers: { host: '127.0.0.1:4318' } })).json<{
      bundle_hash: string;
    }>();
    writeFileSync(join(f.project, 'AGENTS.md'), 'SYNTHETIC_DIRTY_PREIMAGE');
    const checkpoint = (await post('application-checkpoint', { attempt_id: attempt, paths: ['AGENTS.md'] })).json<{ checkpoint_id: string }[]>()[0]!;
    writeFileSync(join(f.project, 'AGENTS.md'), 'SYNTHETIC_ADAPTED_FILE');
    const report = {
      attempt_id: attempt,
      bundle_hash: context.bundle_hash,
      outputs: [{ path: 'AGENTS.md', checkpoint_id: checkpoint.checkpoint_id, sha256: hashBytes('SYNTHETIC_ADAPTED_FILE') }],
      checks: [{ check_id: 'synthetic_script', outcome: 'passed' }]
    };
    expect((await post('application-report', report)).statusCode).toBe(200);
    expect((await post('application-report', report)).statusCode).toBe(200);
    const review = await app.inject({ url: `/api/tasks/${task.id}/application-review`, headers: { host: '127.0.0.1:4318' } });
    expect(review.headers['cache-control']).toBe('no-store');
    expect(review.body).toContain('SYNTHETIC_DIRTY_PREIMAGE');
    expect((await post('application-publish', { approvalDigest: 'a'.repeat(64) })).json()).toEqual({ error: 'application_managed_retired' });
    expect((await app.inject({ url: `/api/tasks/${task.id}/application-handoff`, headers: { host: '127.0.0.1:4318' } })).body).toContain('harness-connect');
    expect(f.store.get('SELECT * FROM comparison_assignments WHERE task_id=?', [task.id])).toEqual(assignment);
    expect((await post('application-cancel', {})).statusCode).toBe(200);
    expect((await post('application-report', report)).json()).toEqual({ error: 'application_attempt_stale' });
    expect(readFileSync(join(f.project, 'AGENTS.md'), 'utf8')).toBe('SYNTHETIC_ADAPTED_FILE');
    const db = new Database(f.metadataFile);
    try {
      expect(JSON.stringify(db.prepare('SELECT * FROM web_actions').all())).not.toContain('SYNTHETIC_DIRTY_PREIMAGE');
      expect(JSON.stringify(db.prepare('SELECT * FROM web_actions').all())).not.toContain('SYNTHETIC_ADAPTED_FILE');
    } finally {
      db.close();
    }
    expect(f.store.eventCount()).toBe(0);
  } finally {
    await app.close();
    f.cleanup();
  }
}, 30000);

test('configuration-blocked agent application retains native mode and cannot expose legacy apply', async () => {
  const f = localWebFixture();
  writeFileSync(join(f.project, 'README.md'), 'Synthetic prerequisites');
  for (const [index, version] of ['v1', 'v2'].entries()) {
    writeFileSync(join(f.project, 'procedure.md'), readFileSync(f.input.artifacts[index]!.selected_artifacts[0]!.path));
    registerHarness(f.project, {
      schema_version: 1,
      harness_id: 'synthetic',
      version,
      policy_version: comparisonVariant(f.store, f.input.artifacts[index]!.variant_id).policy_version,
      readme_path: 'README.md',
      artifacts: [{ artifact_id: 'instruction', role: 'instruction', source_path: 'procedure.md', target_path: 'harness.md' }]
    });
  }
  generateComparison(f.project, { schema_version: 2, id: 'agent', name: 'Synthetic agent comparison', arm_a: 'v1', arm_b: 'v2', application: 'agent_applied' });
  const domain = createLocalWebDomain({
    store: f.store,
    metadataFile: f.metadataFile,
    profiles: [f.profile],
    picker: () => Promise.resolve(join(f.project, 'harness-config/comparisons/agent.json'))
  });
  try {
    const preview = (await domain.importSetup!()) as { token: string };
    const bound = (await domain.bindSetup!({ token: preview.token, project_id: 'project-1', template_id: f.profile.id })) as { profile_id: string };
    const owner = (await domain.createTask({ name: 'Synthetic lease owner', project_id: 'project-1', setup_id: bound.profile_id })) as { id: string };
    const blocked = (await domain.createTask({ name: 'Synthetic blocked application', project_id: 'project-1', setup_id: bound.profile_id })) as {
      id: string;
      status: string;
      reason: string;
      application?: { state: string; jobId: string | null };
      actions: { code: string; enabled: boolean }[];
    };
    expect(blocked).toMatchObject({
      status: 'blocked_configuration',
      reason: 'external_surface_busy',
      application: { state: 'blocked_configuration', jobId: null }
    });
    expect(blocked.actions.find(a => a.code === 'apply')?.enabled).not.toBe(true);
    expect(blocked.actions.find(a => a.code === 'prepare')?.enabled).toBe(true);
    await expect(domain.taskAction(blocked.id, 'apply', {})).rejects.toThrow('application_required');
    const before = f.store.all<{ task_id: string }>('SELECT * FROM comparison_assignments');
    await expect(domain.taskAction(blocked.id, 'prepare', {})).rejects.toThrow('external_surface_busy');
    expect(f.store.all('SELECT * FROM comparison_assignments')).toEqual(before);
    expect(domain.task(blocked.id)).toMatchObject({ application: { state: 'blocked_configuration' } });
    await domain.taskAction(owner.id, 'release', { external_session_stopped: true });
    const retried = await domain.taskAction(blocked.id, 'prepare', {});
    expect(retried).toMatchObject({ id: blocked.id, reason: null, application: { state: 'awaiting_application' } });
    expect(f.store.get('SELECT * FROM comparison_assignments WHERE task_id=?', [owner.id])).toEqual(before.find(row => row.task_id === owner.id));
    expect(f.store.all('SELECT * FROM comparison_assignments WHERE task_id=?', [blocked.id])).toHaveLength(1);
  } finally {
    await domain.close?.();
    f.cleanup();
  }
});
