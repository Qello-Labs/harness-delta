import { join } from 'node:path';
import { expect, test } from 'vitest';
import { z } from 'zod';
import { localWebFixture } from '../helpers/local-web-fixture.js';

test.each([
  ['ordinary', 'ticket'],
  ['comparison', 'ticket'],
  ['comparison', 'observe'],
  ['comparison', 'release'],
  ['comparison', 'stop-observation']
] as const)('%s %s rejection ordering through the domain seam', async (mode, action) => {
  const f = localWebFixture();
  const domain = f.create();
  try {
    if (mode === 'ordinary') {
      if (!domain.ordinaryProjectAction) {
        throw new Error('missing_ordinary_setup');
      }
      await domain.ordinaryProjectAction('project-1', {
        operation: 'configure',
        product_version: '2.1.296',
        claude_projects_directory: join(f.root, 'claude')
      });
    }
    const { id } = z.object({ id: z.string() }).parse(
      await domain.createTask(
        mode === 'ordinary'
          ? {
              mode: 'ordinary',
              name: 'Synthetic timing',
              project_id: 'project-1',
              criterion_ids: ['accepted']
            }
          : {
              name: 'Synthetic timing',
              project_id: 'project-1',
              setup_id: f.profile.id
            }
      )
    );
    const trace: string[] = [];
    const result = domain.taskAction(id, action, {}).then(
      () => {
        throw new Error('unexpected_success');
      },
      (error: unknown) => {
        expect(error).toBeInstanceOf(Error);
        trace.push('rejected');
      }
    );
    queueMicrotask(() => trace.push('sibling'));
    await result;
    expect(trace).toEqual(mode === 'ordinary' ? ['rejected', 'sibling'] : ['sibling', 'rejected']);
  } finally {
    await domain.close?.();
    f.cleanup();
  }
});

test.each([
  'application-prepare',
  'application-open',
  'application-checkpoint',
  'application-report',
  'application-identity',
  'application-cancel',
  'application-mode'
])('%s rejects before a queued caller sibling', async action => {
  const f = localWebFixture();
  const domain = f.create();
  try {
    const { id } = z.object({ id: z.string() }).parse(
      await domain.createTask({
        name: 'Synthetic application ordering',
        project_id: 'project-1',
        setup_id: f.profile.id
      })
    );
    const trace: string[] = [];
    const result = domain.taskAction(id, action, {}).then(
      () => {
        throw new Error('unexpected_application_success');
      },
      (error: unknown) => {
        expect(error).toBeInstanceOf(Error);
        trace.push('rejected');
      }
    );
    queueMicrotask(() => trace.push('sibling'));
    await result;
    expect(trace).toEqual(['rejected', 'sibling']);
    expect(f.store.eventCount()).toBe(0);
  } finally {
    await domain.close?.();
    f.cleanup();
  }
});

test('task preflight rejects asynchronously before a queued caller sibling', async () => {
  const f = localWebFixture();
  const domain = f.create();
  try {
    const trace: string[] = [];
    const result = domain.taskAction('missing-task', 'ticket', {}).then(
      () => {
        throw new Error('unexpected_success');
      },
      (error: unknown) => {
        expect(error).toBeInstanceOf(Error);
        trace.push('rejected');
      }
    );
    queueMicrotask(() => trace.push('sibling'));
    await result;
    expect(trace).toEqual(['rejected', 'sibling']);
  } finally {
    await domain.close?.();
    f.cleanup();
  }
});
