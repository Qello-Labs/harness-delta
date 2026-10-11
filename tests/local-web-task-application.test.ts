import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import { z } from 'zod';
import { setupReviewFixture } from './helpers/setup-review-fixture.js';
import { localWebFixture } from './helpers/local-web-fixture.js';
import { applicationRequired } from '../src/harness-application.js';
import { ExternalTaskSetupSchema, prepareExternalTask } from '../src/external-session-service.js';
import { hashBytes } from '../src/harness-config.js';
import { createLocalWebServer } from '../src/local-web-server.js';
import { assertSharedTask } from '../src/local-web-shared-guard.js';

type Fixture = ReturnType<typeof setupReviewFixture>;
async function sharedTask(f: Fixture) {
  if (!f.domain.reviewSetup || !f.domain.saveReviewedSetup) throw new Error('Review unavailable');
  const review = await f.domain.reviewSetup(f.input);
  if (!review.ready) throw new Error('Synthetic review failed');
  const saved = await f.domain.saveReviewedSetup(review.token);
  const task = z.object({ id: z.string() }).parse(await f.domain.createTask({ name: 'Synthetic mode change', project_id: 'project-1', setup_id: saved.profile_id }));
  return { id: task.id, setupPath: join(f.project, saved.local_setup_path) };
}
function pins(f: Fixture, task: { id: string; setupPath: string }) {
  return {
    assignment: f.store.get('SELECT * FROM comparison_assignments WHERE task_id=?', [task.id]),
    protocol: f.store.get('SELECT * FROM comparison_protocols WHERE id=?', [f.input.protocol.id]),
    variants: f.store.all('SELECT * FROM comparison_variants ORDER BY id'),
    shared: f.store.get('SELECT * FROM shared_configuration_tasks WHERE task_id=?', [task.id]),
    comparison: readFileSync(f.input.comparison_path, 'utf8'),
    setup: readFileSync(task.setupPath, 'utf8'),
    journal: readFileSync(join(f.project, `.harness-delta/setup/tasks/${task.id}.json`), 'utf8'),
    managed: readFileSync(join(f.project, '.harness-delta-managed/active-instructions.md'), 'utf8'),
  };
}
const agentMode = { mode: 'agent_applied' };

test('an unused instruction-only task gains agent application without changing its assignment or pinned records', async () => {
  const f = setupReviewFixture();
  try {
    const task = await sharedTask(f);
    await f.domain.taskAction(task.id, 'apply', {});
    const assignment = z.object({ variant_id: z.string() }).parse(f.store.get('SELECT variant_id FROM comparison_assignments WHERE task_id=?', [task.id]));
    const arm = f.input.protocol.variant_ids.indexOf(assignment.variant_id) === 0 ? 'A' : 'B';
    const version = f.input.variants.find(variant => variant.id === assignment.variant_id)?.harness_version;
    expect(f.domain.task(task.id)).toMatchObject({
      harness: { arm, variant_id: assignment.variant_id, version, application_mode: 'selected_markdown_only' },
      preparation: { configuration_evidence: 'verified_at_preparation' },
    });
    expect(f.domain.task(task.id)).not.toHaveProperty('application');
    const before = pins(f, task);

    const converted = await f.domain.taskAction(task.id, 'application-mode', agentMode);

    expect(converted).toMatchObject({
      id: task.id, harness: { arm, variant_id: assignment.variant_id, version, application_mode: 'agent_applied' },
      application: { state: 'awaiting_application' }, preparation: { configuration_evidence: 'unverified', assigned_variant_id: assignment.variant_id },
    });
    expect(z.object({ actions: z.array(z.object({ code: z.string(), enabled: z.boolean() })) }).parse(converted).actions
      .filter(action => ['application-prepare', 'apply', 'ticket', 'connect', 'session-connect', 'observe'].includes(action.code) && action.enabled)
      .map(action => action.code)).toEqual(['application-prepare']);
    expect(pins(f, task)).toEqual(before);
    expect(JSON.parse(readFileSync(join(f.project, `.harness-delta/applications/${task.id}/mode-change.json`), 'utf8'))).toMatchObject({
      task_id: task.id, from: 'selected_markdown_only', to: 'agent_applied', variant_id: assignment.variant_id,
    });
    await expect(f.domain.taskAction(task.id, 'apply', {})).rejects.toThrow('application_required');
    await expect(f.domain.taskAction(task.id, 'ticket', {})).rejects.toThrow('application_required');
    expect(f.store.all('SELECT id FROM tasks')).toHaveLength(1);
    expect(f.store.eventCount()).toBe(0);
    expect(f.store.all('SELECT * FROM active_intervals')).toHaveLength(0);
  } finally { await f.domain.close?.(); f.cleanup(); }
});

test('repeating the mode change keeps one authority record and the same task state', async () => {
  const f = setupReviewFixture();
  try {
    const task = await sharedTask(f);
    const first = await f.domain.taskAction(task.id, 'application-mode', agentMode);
    const record = readFileSync(join(f.project, `.harness-delta/applications/${task.id}/mode-change.json`), 'utf8');
    const second = await f.domain.taskAction(task.id, 'application-mode', agentMode);
    expect(second).toEqual(first);
    expect(f.store.all('SELECT * FROM harness_application_tasks')).toHaveLength(1);
    expect(readFileSync(join(f.project, `.harness-delta/applications/${task.id}/mode-change.json`), 'utf8')).toBe(record);
  } finally { await f.domain.close?.(); f.cleanup(); }
});

test('a converted task verifies through its reported application even though the comparison stays instruction-only', async () => {
  const f = setupReviewFixture();
  try {
    const task = await sharedTask(f);
    await f.domain.taskAction(task.id, 'application-mode', agentMode);
    expect(() => assertSharedTask(f.store, task.id)).toThrow('application_required');
    const workspace = z.object({ digest: z.string() }).parse(f.domain.applicationWorkspace?.(task.id, f.project));
    await f.domain.taskAction(task.id, 'application-prepare', { workspace: f.project, workspaceDigest: workspace.digest, product: 'codex' });
    const attempt = z.object({ application: z.object({ jobId: z.string() }) }).parse(f.domain.task(task.id)).application.jobId;
    const context = z.object({ bundle_hash: z.string() }).parse(f.domain.applicationContext?.(task.id, attempt));
    const checkpoint = z.array(z.object({ checkpoint_id: z.string() })).parse(await f.domain.taskAction(task.id, 'application-checkpoint', { attempt_id: attempt, paths: ['AGENTS.md'] }))[0];
    writeFileSync(join(f.project, 'AGENTS.md'), 'SYNTHETIC_APPLIED_RULES');
    await f.domain.taskAction(task.id, 'application-report', { attempt_id: attempt, bundle_hash: context.bundle_hash,
      outputs: [{ path: 'AGENTS.md', checkpoint_id: checkpoint?.checkpoint_id, sha256: hashBytes('SYNTHETIC_APPLIED_RULES') }],
      checks: [{ check_id: 'synthetic_check', outcome: 'passed' }] });
    const applied = f.domain.task(task.id);
    expect(applied).toMatchObject({ application: { state: 'applied' }, harness: { application_mode: 'agent_applied' } });
    expect(z.object({ actions: z.array(z.object({ code: z.string(), enabled: z.boolean() })) }).parse(applied).actions
      .filter(action => ['apply', 'ticket', 'connect', 'observe'].includes(action.code) && action.enabled)).toEqual([]);
    await expect(f.domain.taskAction(task.id, 'apply', {})).rejects.toThrow('application_required');
    await expect(f.domain.taskAction(task.id, 'ticket', {})).rejects.toThrow('application_native_loading_unqualified');
    expect(() => assertSharedTask(f.store, task.id)).not.toThrow();
    expect(z.object({ guidance: z.string(), connect_context: z.object({ task_id: z.string() }) }).parse(f.domain.applicationHandoff?.(task.id, 'http://127.0.0.1:4318')).connect_context.task_id).toBe(task.id);
    writeFileSync(join(f.project, 'AGENTS.md'), 'SYNTHETIC_DRIFT');
    expect(() => assertSharedTask(f.store, task.id)).toThrow('application_output_changed');
    expect(f.store.eventCount()).toBe(0);
  } finally { await f.domain.close?.(); f.cleanup(); }
});

test('re-preparing a converted task from its original setup cannot restore instruction-only delivery', async () => {
  const f = setupReviewFixture();
  try {
    const task = await sharedTask(f);
    await f.domain.taskAction(task.id, 'application-mode', agentMode);
    const privateDb = new Database(f.metadataFile, { readonly: true });
    let setup: z.infer<typeof ExternalTaskSetupSchema>;
    try { setup = ExternalTaskSetupSchema.parse(JSON.parse(z.object({ setup: z.string() }).parse(privateDb.prepare('SELECT setup FROM web_tasks WHERE id=?').get(task.id)).setup)); }
    finally { privateDb.close(); }
    expect(setup.workflow.application).toBeUndefined();
    expect(() => prepareExternalTask(f.store, setup, true)).toThrow('application_required');
    expect(prepareExternalTask(f.store, setup, false)).toMatchObject({ state: 'preparation_needed', configuration_evidence: 'unverified' });
    expect(existsSync(join(f.project, '.harness-delta-managed/active-instructions.md'))).toBe(false);
    expect(applicationRequired(f.store, task.id)).toBe(true);
    expect(f.domain.task(task.id)).toMatchObject({ application: { state: 'awaiting_application' }, harness: { application_mode: 'agent_applied' } });
  } finally { await f.domain.close?.(); f.cleanup(); }
});

test('a task with issued start instructions keeps its instruction-only mode', async () => {
  const f = setupReviewFixture();
  try {
    const task = await sharedTask(f);
    await f.domain.taskAction(task.id, 'apply', {});
    await f.domain.taskAction(task.id, 'ticket', {});
    await expect(f.domain.taskAction(task.id, 'application-mode', agentMode)).rejects.toThrow('application_mode_locked');
    expect(applicationRequired(f.store, task.id)).toBe(false);
    expect(f.domain.task(task.id)).toMatchObject({ harness: { application_mode: 'selected_markdown_only' } });
  } finally { await f.domain.close?.(); f.cleanup(); }
});

test.each([
  ["UPDATE tasks SET started_at='2026-01-01T00:00:00.000Z' WHERE id=?", 'SELECT 1 FROM tasks WHERE id=? AND started_at IS NOT NULL'],
  ["INSERT INTO binding_collection_controls(task_id,end_condition,authorized_at,revoked_at) VALUES (?,'explicit_stop','2026-01-01T00:00:00.000Z','2026-01-01T00:00:01.000Z')", 'SELECT 1 FROM binding_collection_controls WHERE task_id=? AND revoked_at IS NOT NULL'],
])('a task that is no longer unused keeps its instruction-only mode: %s', async (sql, recorded) => {
  const f = setupReviewFixture();
  try {
    const task = await sharedTask(f);
    f.store.execute(sql, [task.id]);
    expect(f.store.get(recorded, [task.id])).toBeDefined();
    await expect(f.domain.taskAction(task.id, 'application-mode', agentMode)).rejects.toThrow('application_mode_locked');
    expect(applicationRequired(f.store, task.id)).toBe(false);
  } finally { await f.domain.close?.(); f.cleanup(); }
});

test('repeating an interrupted mode change finishes it instead of leaving the task stuck', async () => {
  const f = setupReviewFixture();
  try {
    const task = await sharedTask(f);
    await f.domain.taskAction(task.id, 'apply', {});
    const blocked = join(f.project, '.harness-delta/applications');
    writeFileSync(blocked, '');
    await expect(f.domain.taskAction(task.id, 'application-mode', agentMode)).rejects.toThrow();
    expect(applicationRequired(f.store, task.id)).toBe(true);
    expect(existsSync(join(f.project, `.harness-delta/applications/${task.id}/procedure.json`))).toBe(false);
    rmSync(blocked);

    expect(await f.domain.taskAction(task.id, 'application-mode', agentMode)).toMatchObject({
      application: { state: 'awaiting_application' }, preparation: { configuration_evidence: 'unverified' }, harness: { application_mode: 'agent_applied' },
    });
    expect(existsSync(join(f.project, `.harness-delta/applications/${task.id}/procedure.json`))).toBe(true);
    expect(existsSync(join(f.project, `.harness-delta/applications/${task.id}/mode-change.json`))).toBe(true);
    expect(f.store.all('SELECT * FROM harness_application_tasks')).toHaveLength(1);
  } finally { await f.domain.close?.(); f.cleanup(); }
});

test('changed pinned harness content blocks the mode change before any authority is issued', async () => {
  const f = setupReviewFixture();
  try {
    const task = await sharedTask(f);
    for (const version of ['baseline', 'modified']) writeFileSync(join(f.project, `harness-config/${version}/harness.md`), 'Synthetic tampered instruction\n');
    await expect(f.domain.taskAction(task.id, 'application-mode', agentMode)).rejects.toThrow('shared_content_mismatch');
    expect(applicationRequired(f.store, task.id)).toBe(false);
    expect(existsSync(join(f.project, `.harness-delta/applications/${task.id}`))).toBe(false);
  } finally { await f.domain.close?.(); f.cleanup(); }
});

test('a task without a pinned shared comparison cannot change mode', async () => {
  const f = localWebFixture(); const domain = f.create();
  try {
    const task = z.object({ id: z.string() }).parse(await domain.createTask({ name: 'Synthetic local task', project_id: 'project-1', setup_id: f.profile.id }));
    await expect(domain.taskAction(task.id, 'application-mode', agentMode)).rejects.toThrow('application_mode_unsupported');
    expect(applicationRequired(f.store, task.id)).toBe(false);
  } finally { await domain.close?.(); f.cleanup(); }
});

test('the mode-change route requires the current task version and accepts only agent application', async () => {
  const f = setupReviewFixture(); const origin = 'http://127.0.0.1:4338';
  const app = createLocalWebServer({ origin, domain: f.domain, metadataFile: f.metadataFile });
  try {
    const task = await sharedTask(f);
    const csrf = (await app.inject({ url: '/api/bootstrap', headers: { host: '127.0.0.1:4338' } })).json<{ csrf: string }>().csrf;
    const post = (payload: unknown, version: string) => app.inject({ method: 'POST', url: `/api/tasks/${task.id}/application-mode`,
      headers: { host: '127.0.0.1:4338', origin, 'x-harness-csrf': csrf, 'idempotency-key': randomUUID(), 'if-match': version }, payload: payload as object });
    const version = f.domain.task(task.id).version;
    expect((await post({ mode: 'selected_markdown_only' }, version)).statusCode).toBe(400);
    expect((await post(agentMode, '"stale"')).statusCode).not.toBe(200);
    expect(applicationRequired(f.store, task.id)).toBe(false);
    const accepted = await post(agentMode, version);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ id: task.id, harness: { application_mode: 'agent_applied' }, application: { state: 'awaiting_application' } });
  } finally { await app.close(); f.cleanup(); }
});
