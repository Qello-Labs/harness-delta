import { EventEmitter, once } from 'node:events';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, test, vi } from 'vitest';
import { z } from 'zod';
import { CodexWorkflowExecutionSchema, createSyntheticCodexWorkflowAdapter } from '../../src/codex-workflow-adapter.js';
import { Lifecycle } from '../../src/lifecycle.js';
import { createLocalWebDomain } from '../../src/web/local-web-domain.js';
import type { LocalWebDomain } from '../../src/web/local-web-server.js';
import { localWebFixture } from '../helpers/local-web-fixture.js';

type Fixture = ReturnType<typeof localWebFixture>;
const identity = z.object({ id: z.string() });
const selection = z.object({ handle: z.string(), label: z.string() });
const actionList = z.object({
  actions: z.array(
    z.object({
      code: z.string(),
      enabled: z.boolean(),
      reason: z.string().nullable()
    })
  )
});

async function comparisonTask(f: Fixture, domain: LocalWebDomain) {
  return identity.parse(
    await domain.createTask({
      name: 'Synthetic characterization',
      project_id: 'project-1',
      setup_id: f.profile.id
    })
  );
}

async function connectedTask(f: Fixture, domain: LocalWebDomain) {
  const { id } = await comparisonTask(f, domain);
  await domain.taskAction(id, 'apply', {});
  await domain.taskAction(id, 'ticket', {});
  const startup = z.object({ startup: z.object({ ticket_id: z.string() }) }).parse(domain.task(id));
  const source = f.sourceFor(startup.startup.ticket_id);
  f.pick(source.path);
  const picked = selection.parse(await domain.chooseSession(id));
  await domain.taskAction(id, 'connect', { source_handle: picked.handle });
  return { id, source, picked };
}

async function ordinaryTask(f: Fixture, domain: LocalWebDomain) {
  if (!domain.ordinaryProjectAction) {
    throw new Error('ordinary_setup_unavailable');
  }
  await domain.ordinaryProjectAction('project-1', {
    operation: 'configure',
    product_version: '2.1.296',
    claude_projects_directory: join(f.root, 'synthetic-claude-projects')
  });
  return identity.parse(
    await domain.createTask({
      mode: 'ordinary',
      name: 'Synthetic ordinary characterization',
      project_id: 'project-1',
      criterion_ids: ['accepted']
    })
  );
}

test('project registration canonicalizes a symlink and reuses the registered identity without copying setup membership', async () => {
  const f = localWebFixture();
  const domain = f.create();
  const alias = join(f.root, 'project-alias');
  symlinkSync(f.project, alias);
  try {
    expect(await domain.registerProject(alias)).toEqual({
      id: 'project-1'
    });
    expect(await domain.registerProject(join(alias, '.'))).toEqual({
      id: 'project-1'
    });
    expect(f.store.all('SELECT id,local_root FROM projects')).toEqual([
      {
        id: 'project-1',
        local_root: f.project
      }
    ]);
    expect(await domain.bootstrap()).toMatchObject({
      projects: [{ id: 'project-1', setup_ids: [f.profile.id] }],
      tasks: []
    });
  } finally {
    await domain.close?.();
    f.cleanup();
  }
});

test('project registration rejects a directory without HEAD before recording a project', async () => {
  const f = localWebFixture();
  const domain = f.create();
  const directory = join(f.root, 'unversioned');
  mkdirSync(directory);
  for (const key of Object.keys(process.env).filter(key => key.startsWith('GIT_'))) vi.stubEnv(key, undefined);
  try {
    expect(() => domain.registerProject(directory)).toThrow('git_baseline_unavailable');
    expect(f.store.all('SELECT id FROM projects')).toEqual([
      {
        id: 'project-1'
      }
    ]);
  } finally {
    vi.unstubAllEnvs();
    await domain.close?.();
    f.cleanup();
  }
});

test.each([
  ['missing-setup', 'missing-project', 'unknown_setup'],
  ['reviewed-setup', 'missing-project', 'unknown_project']
] as const)('creation resolves setup %s before project %s and reports %s without allocation', async (setupId, projectId, error) => {
  const f = localWebFixture();
  const domain = f.create();
  try {
    expect(() =>
      domain.createTask({
        name: 'Synthetic missing reference',
        project_id: projectId,
        setup_id: setupId
      })
    ).toThrow(error);
    expect(f.store.all('SELECT id FROM tasks')).toEqual([]);
    expect(f.store.all('SELECT task_id FROM comparison_assignments')).toEqual([]);
  } finally {
    await domain.close?.();
    f.cleanup();
  }
});

test.each(['session-connect', 'application-start', 'not-an-action'])('unknown task wins over %s dispatch and body validation', async action => {
  const f = localWebFixture();
  const domain = f.create();
  try {
    await expect(
      domain.taskAction('missing-task', action, {
        product: 'invalid',
        receipt: 'invalid'
      })
    ).rejects.toThrow('unknown_task');
    expect(f.store.all('SELECT id FROM tasks')).toEqual([]);
  } finally {
    await domain.close?.();
    f.cleanup();
  }
});

const applicationReads = [
  ['workspace', (domain: LocalWebDomain) => domain.applicationWorkspace?.('missing-task', '/synthetic/unavailable')],
  ['context', (domain: LocalWebDomain) => domain.applicationContext?.('missing-task', 'missing-attempt')],
  ['launch', (domain: LocalWebDomain) => domain.applicationLaunchContext?.('missing-task', 'not-an-origin')],
  ['handoff', (domain: LocalWebDomain) => domain.applicationHandoff?.('missing-task', 'not-an-origin')],
  ['review', (domain: LocalWebDomain) => domain.applicationReview?.('missing-task')]
] as const;

test.each(applicationReads)('application %s rejects an unknown task before inspecting its other references', async (_name, read) => {
  const f = localWebFixture();
  const domain = f.create();
  try {
    expect(() => read(domain)).toThrow('unknown_task');
    expect(f.store.all('SELECT * FROM harness_application_tasks')).toEqual([]);
  } finally {
    await domain.close?.();
    f.cleanup();
  }
});

test('an unknown session-picker task is rejected before invoking the native boundary', async () => {
  const f = localWebFixture();
  const picker = vi.fn(() => Promise.resolve(null));
  const domain = createLocalWebDomain({
    store: f.store,
    metadataFile: f.metadataFile,
    profiles: [f.profile],
    picker
  });
  try {
    await expect(domain.chooseSession('missing-task')).rejects.toThrow('unknown_task');
    expect(picker).not.toHaveBeenCalled();
  } finally {
    await domain.close?.();
    f.cleanup();
  }
});

test.each(['project', 'session'] as const)('%s picker cancellation returns null without changing task controls or metadata', async kind => {
  const f = localWebFixture();
  const domain = f.create();
  try {
    const { id } = await comparisonTask(f, domain);
    const before = await domain.bootstrap();
    const result = kind === 'project' ? await domain.chooseDirectory() : await domain.chooseSession(id);
    expect(result).toBeNull();
    expect(await domain.bootstrap()).toEqual(before);
    const metadata = new Database(f.metadataFile, { readonly: true });
    try {
      expect(metadata.prepare('SELECT * FROM web_sources').all()).toEqual([]);
    } finally {
      metadata.close();
    }
  } finally {
    await domain.close?.();
    f.cleanup();
  }
});

test.each([false, true])('setup import rolls back a valid entry when another entry references an unknown project (invalid first=%s)', async invalidFirst => {
  const f = localWebFixture();
  const domain = f.create();
  try {
    const valid = { ...f.profile, id: 'synthetic-new-setup' };
    const invalid = {
      ...f.profile,
      id: 'synthetic-unknown-project',
      setup: {
        ...f.profile.setup,
        workflow: {
          ...f.input,
          assignment: {
            ...f.input.assignment,
            project_id: 'missing-project'
          }
        }
      }
    };
    const path = join(f.root, 'synthetic-import.json');
    writeFileSync(
      path,
      JSON.stringify({
        schema_version: 1,
        profiles: invalidFirst ? [invalid, valid] : [valid, invalid]
      })
    );
    f.pick(path);
    const before = await domain.bootstrap();

    await expect(domain.importSetup?.()).rejects.toThrow('deleted_identifier');

    expect(await domain.bootstrap()).toEqual(before);
    const metadata = new Database(f.metadataFile, { readonly: true });
    try {
      expect(metadata.prepare('SELECT id FROM web_profiles ORDER BY id').all()).toEqual([{ id: f.profile.id }]);
    } finally {
      metadata.close();
    }
  } finally {
    await domain.close?.();
    f.cleanup();
  }
});

test('session selection uses filename identity without reading the body or activating measurement', async () => {
  const f = localWebFixture();
  const domain = f.create();
  try {
    const { id } = await comparisonTask(f, domain);
    const source = f.newRoot();
    writeFileSync(source.path, 'SYNTHETIC_UNPARSED_SESSION');
    f.pick(source.path);
    const before = domain.task(id);

    const picked = selection.parse(await domain.chooseSession(id));

    expect(z.uuid().safeParse(picked.handle).success).toBe(true);
    expect(picked.label).toBe(basename(source.path));
    expect(domain.task(id)).toEqual(before);
    expect(f.store.all('SELECT id FROM sessions')).toEqual([]);
    expect(f.store.all('SELECT * FROM active_intervals')).toEqual([]);
    expect(f.store.eventCount()).toBe(0);
  } finally {
    await domain.close?.();
    f.cleanup();
  }
});

test.each(['missing-handle', 'foreign-handle'] as const)('connect rejects a %s before adapter execution even with a valid ticket', async kind => {
  const f = localWebFixture();
  const domain = f.create();
  try {
    const owner = await comparisonTask(f, domain);
    f.pick(f.newRoot().path);
    const foreign = selection.parse(await domain.chooseSession(owner.id));
    await domain.taskAction(owner.id, 'release', {
      external_session_stopped: true
    });
    const target = await comparisonTask(f, domain);
    await domain.taskAction(target.id, 'apply', {});
    await domain.taskAction(target.id, 'ticket', {});
    const before = domain.task(target.id);

    await expect(
      domain.taskAction(target.id, 'connect', {
        source_handle: kind === 'foreign-handle' ? foreign.handle : 'missing'
      })
    ).rejects.toThrow('external_ticket_required');

    expect(domain.task(target.id)).toEqual(before);
    expect(f.store.all('SELECT id FROM sessions')).toEqual([]);
    expect(f.store.all('SELECT id FROM codex_workflow_runs')).toEqual([]);
  } finally {
    await domain.close?.();
    f.cleanup();
  }
});

test.each([
  ['observe', {}, 'external_connection_required'],
  ['finish-failed', {}, 'external_connection_required'],
  ['finish-success', { criteria: [] }, 'external_connection_required'],
  ['finish-unknown', {}, 'invalid_ui_request'],
  ['application-start', {}, 'application_managed_retired']
] as const)('unconnected comparison action %s preserves its specific failure %s', async (action, input, error) => {
  const f = localWebFixture();
  const domain = f.create();
  try {
    const { id } = await comparisonTask(f, domain);
    const before = domain.task(id);
    await expect(domain.taskAction(id, action, input)).rejects.toThrow(error);
    expect(domain.task(id)).toEqual(before);
    expect(f.store.all('SELECT * FROM outcomes')).toEqual([]);
  } finally {
    await domain.close?.();
    f.cleanup();
  }
});

test('a connected comparison distinguishes observed zero requests from missing cost and hides the selected source path', async () => {
  const f = localWebFixture();
  const domain = f.create();
  try {
    const { id, source, picked } = await connectedTask(f, domain);
    const snapshot = domain.task(id);
    expect(snapshot).toMatchObject({
      state: 'active',
      status: 'connected',
      source: picked,
      startup: null,
      outcome: null,
      measurement: { state: 'connected', requests: 0 },
      price: { partial_amount: null, unpriced_events: 0 },
      preparation: {
        native_context_evidence: 'native_developer_context_observed',
        freshness_evidence: 'fresh_root_after_ticket'
      }
    });
    expect(snapshot.source).toEqual(picked);
    expect(JSON.stringify(snapshot)).not.toContain(source.path);
    expect(JSON.stringify(snapshot)).not.toContain(f.home);
    expect(f.store.eventCount()).toBe(0);
  } finally {
    await domain.close?.();
    f.cleanup();
  }
});

test.each([
  ['finish-failed', 'failed'],
  ['finish-abandoned', 'aborted']
] as const)('%s keeps the comparison window and source but records no success criteria', async (action, status) => {
  const f = localWebFixture();
  const domain = f.create();
  try {
    const { id, picked } = await connectedTask(f, domain);
    const before = z
      .object({
        measurement: z.object({ window: z.unknown() }),
        preparation: z.object({ assigned_variant_id: z.string() })
      })
      .parse(domain.task(id));

    const finalized = await domain.taskAction(id, action, {
      criteria: ['not-a-selected-criterion']
    });

    expect(finalized).toMatchObject({
      id,
      state: 'finalized',
      status,
      outcome: { status },
      measurement: {
        state: 'measurement_ended',
        requests: 0,
        window: before.measurement.window
      },
      preparation: {
        assigned_variant_id: before.preparation.assigned_variant_id
      },
      source: picked,
      attempt: 1
    });
    expect(z.object({ outcome: z.object({ assessed_at: z.iso.datetime() }) }).safeParse(finalized).success).toBe(true);
    expect(f.store.get('SELECT status,criteria_met FROM outcomes WHERE task_id=?', [id])).toEqual({ status, criteria_met: '[]' });
    expect(actionList.parse(finalized).actions.find(item => item.code === 'finish-success')).toEqual({
      code: 'finish-success',
      enabled: false,
      reason: 'finalized'
    });
    expect(f.store.eventCount()).toBe(0);
  } finally {
    await domain.close?.();
    f.cleanup();
  }
});

test('unconnected ordinary DTO retains zero request count but missing usage totals and private configuration stays out', async () => {
  const f = localWebFixture();
  const domain = f.create();
  try {
    const { id } = await ordinaryTask(f, domain);
    const snapshot = domain.task(id);
    expect(snapshot).toMatchObject({
      mode: 'ordinary',
      state: 'registered',
      status: 'waiting_for_session',
      measurement: {
        state: 'waiting_connection',
        requests: 0,
        active_ms: null,
        end_condition: 'explicit_stop'
      },
      outcome: null,
      source: null,
      startup: null,
      price: { partial_amount: null, unpriced_events: 0 },
      binding: {
        roots: 0,
        requests: 0,
        summary: {
          requests: null,
          input_total: {
            status: 'missing',
            value: null,
            statuses: [],
            reasons: []
          },
          output_total: {
            status: 'missing',
            value: null,
            statuses: [],
            reasons: []
          },
          complete_cost: null
        }
      }
    });
    expect(snapshot).not.toHaveProperty('harness');
    expect(snapshot.preparation).not.toHaveProperty('assigned_variant_id');
    expect(JSON.stringify(snapshot)).not.toContain(f.root);
    expect(JSON.stringify(snapshot)).not.toContain('receipt_directory');
    expect(JSON.stringify(snapshot)).not.toContain('claude_projects_directory');
  } finally {
    await domain.close?.();
    f.cleanup();
  }
});

test.each(['apply', 'ticket', 'application-start', 'finish-unknown'])(
  'ordinary dispatch rejects comparison-only or unknown action %s without state changes',
  async action => {
    const f = localWebFixture();
    const domain = f.create();
    try {
      const { id } = await ordinaryTask(f, domain);
      const before = domain.task(id);
      await expect(domain.taskAction(id, action, {})).rejects.toThrow('invalid_ui_request');
      expect(domain.task(id)).toEqual(before);
      expect(f.store.all('SELECT * FROM outcomes')).toEqual([]);
    } finally {
      await domain.close?.();
      f.cleanup();
    }
  }
);

test.each(['revoked', 'finalized'] as const)('%s ordinary scope wins over malformed connection input', async state => {
  const f = localWebFixture();
  const domain = f.create();
  try {
    const { id } = await ordinaryTask(f, domain);
    await domain.taskAction(id, state === 'revoked' ? 'revoke-collection' : 'finish-abandoned', {});
    const before = domain.task(id);

    await expect(
      domain.taskAction(id, 'session-connect', {
        product: 'invalid',
        receipt: 'invalid'
      })
    ).rejects.toThrow('binding_scope_revoked');

    expect(domain.task(id)).toEqual(before);
    expect(f.store.all('SELECT id FROM sessions')).toEqual([]);
    expect(f.store.all('SELECT * FROM active_intervals')).toEqual([]);
  } finally {
    await domain.close?.();
    f.cleanup();
  }
});

test('ordinary success defaults to frozen criteria and final DTO time stops advancing', async () => {
  const f = localWebFixture();
  const domain = f.create();
  try {
    const { id } = await ordinaryTask(f, domain);
    const now = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    new Lifecycle(f.store).start(id);
    vi.setSystemTime(now + 1000);

    const finalized = await domain.taskAction(id, 'finish-success', {});

    expect(finalized).toMatchObject({
      mode: 'ordinary',
      state: 'finalized',
      status: 'success',
      outcome: {
        status: 'success',
        assessed_at: new Date(now + 1000).toISOString()
      },
      measurement: {
        state: 'measurement_ended',
        active_ms: 1000,
        requests: 0
      }
    });
    expect(f.store.get('SELECT criteria_met FROM outcomes WHERE task_id=?', [id])).toEqual({ criteria_met: '["accepted"]' });
    vi.setSystemTime(now + 10000);
    expect(domain.task(id)).toEqual(finalized);
    expect(actionList.parse(finalized).actions.filter(item => item.enabled)).toEqual([]);
    expect(f.store.eventCount()).toBe(0);
  } finally {
    vi.useRealTimers();
    await domain.close?.();
    f.cleanup();
  }
});

test('close fences and drains an in-flight collector before closing private metadata while leaving the caller Store open', async () => {
  const f = localWebFixture();
  const signals = new EventEmitter();
  const entered = once(signals, 'entered', {
    signal: AbortSignal.timeout(3000)
  });
  const released = once(signals, 'released', {
    signal: AbortSignal.timeout(3000)
  });
  let picked: string | null = null;
  let drained = false;
  let metadataAvailableDuringDrain = false;
  const domain = createLocalWebDomain({
    store: f.store,
    metadataFile: f.metadataFile,
    profiles: [f.profile],
    picker: () => Promise.resolve(picked),
    adapterFactory: (store, execution) => {
      const adapter = createSyntheticCodexWorkflowAdapter(store, execution, f.script);
      if (CodexWorkflowExecutionSchema.parse(execution).operation !== 'collect') return adapter;
      return {
        ...adapter,
        async run(context) {
          signals.emit('entered');
          try {
            await released;
            metadataAvailableDuringDrain = domain.task(context.taskId).state === 'paused';
            return {
              run_id: 'synthetic-stopped-run',
              session_id: null,
              state: 'stopped',
              reason: 'stop_requested',
              observed_requests: 0,
              harness_application: 'external_unverified'
            };
          } finally {
            drained = true;
          }
        }
      };
    }
  });
  let closing: Promise<void> | undefined;
  try {
    const { id } = await comparisonTask(f, domain);
    await domain.taskAction(id, 'apply', {});
    await domain.taskAction(id, 'ticket', {});
    const startup = z
      .object({
        startup: z.object({ ticket_id: z.string() })
      })
      .parse(domain.task(id));
    picked = f.sourceFor(startup.startup.ticket_id).path;
    const selected = selection.parse(await domain.chooseSession(id));
    await domain.taskAction(id, 'connect', {
      source_handle: selected.handle
    });
    await domain.taskAction(id, 'observe', {});
    await entered;

    closing = domain.close?.();
    expect(new Lifecycle(f.store).state(id)).toBe('paused');
    signals.emit('released');
    await closing;

    expect(drained).toBe(true);
    expect(metadataAvailableDuringDrain).toBe(true);
    expect(() => domain.task(id)).toThrow();
    expect(f.store.all('SELECT * FROM active_intervals WHERE ended_at IS NULL')).toEqual([]);
    expect(f.store.get('SELECT state FROM tasks WHERE id=?', [id])).toEqual({ state: 'paused' });
    expect(f.store.eventCount()).toBe(0);
    const reopened = f.create();
    try {
      expect(reopened.task(id)).toMatchObject({
        state: 'paused',
        status: 'paused',
        reason: null
      });
    } finally {
      await reopened.close?.();
    }
  } finally {
    signals.emit('released');
    try {
      if (closing) await closing;
      else await domain.close?.();
    } finally {
      f.cleanup();
    }
  }
});
