import { randomUUID } from 'node:crypto';
import { expect, test, vi } from 'vitest';
import { localWebFixture } from './helpers/local-web-fixture.js';
import { createLocalWebServer, localWebError } from '../src/local-web-server.js';
import { comparisonProtocol, protocolRow } from '../src/comparison.js';
import { setupReviewFixture } from './helpers/setup-review-fixture.js';
import { localWebRecruitment } from '../src/local-web-recruitment.js';
import { localWebTaskErrorCodes } from '../src/local-web-task-errors.js';
import { z } from 'zod';

test.each(['before_start', 'ended'] as const)('task creation retains the recruitment failure code %s', async phase => {
  const fixture = localWebFixture();
  const domain = fixture.create();
  const origin = 'http://127.0.0.1:4339';
  const app = createLocalWebServer({ origin, domain, metadataFile: fixture.metadataFile });
  try {
    const protocol = comparisonProtocol(fixture.store, protocolRow(fixture.store, fixture.profile.setup.workflow.assignment.protocol_id));
    const now = phase === 'before_start' ? Date.parse(protocol.recruitment_start) - 1 : Date.parse(protocol.recruitment_end);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    const bootstrap = await app.inject({ url: '/api/bootstrap', headers: { host: '127.0.0.1:4339' } });
    const csrf = bootstrap.json<{ csrf: string }>().csrf;
    expect(bootstrap.json()).toMatchObject({ data: { setups: [{ recruitment: {
      starts_at: protocol.recruitment_start, ends_at: protocol.recruitment_end, state: phase,
    } }] } });
    const response = await app.inject({
      method: 'POST', url: '/api/tasks',
      headers: { host: '127.0.0.1:4339', origin, 'x-harness-csrf': csrf, 'idempotency-key': randomUUID() },
      payload: { name: 'Synthetic date boundary', project_id: 'project-1', setup_id: fixture.profile.id },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'outside_recruitment' });
    expect(fixture.store.all('SELECT id FROM comparison_assignments')).toHaveLength(0);
    expect(fixture.store.eventCount()).toBe(0);
  } finally { vi.useRealTimers(); await app.close(); fixture.cleanup(); }
});

test('unrecognized errors do not disclose arbitrary messages', () => {
  expect(localWebError(new Error('private path or source contents'))).toBe('local_operation_failed');
});

test.each(localWebTaskErrorCodes)('recognized task error %s remains available to the UI', code => {
  expect(localWebError(new Error(code))).toBe(code);
});

const recruitment = { recruitment_start: '2099-01-01T00:00:00Z', recruitment_end: '2099-01-02T00:00:00Z' };
test.each([
  ['2098-12-31T23:59:59.999Z', 'before_start'],
  ['2099-01-01T00:00:00Z', 'open'],
  ['2099-01-01T23:59:59.999Z', 'open'],
  ['2099-01-02T00:00:00Z', 'ended'],
] as const)('recruitment state uses the allocation boundary at %s', (now, state) => {
  expect(localWebRecruitment(recruitment, now)).toEqual({
    starts_at: recruitment.recruitment_start, ends_at: recruitment.recruitment_end, state,
  });
});

test('shared task records the cause and allows the same task to be prepared when recruitment opens', async () => {
  const fixture = setupReviewFixture();
  try {
    if (!fixture.domain.reviewSetup || !fixture.domain.saveReviewedSetup) throw new Error('Review unavailable');
    const review = await fixture.domain.reviewSetup(fixture.input);
    if (!review.ready) throw new Error('Synthetic review failed');
    const saved = await fixture.domain.saveReviewedSetup(review.token);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse(fixture.input.protocol.recruitment_start) - 1);
    const task = z.object({ id: z.string() }).passthrough().parse(await fixture.domain.createTask({
      name: 'Synthetic early task', project_id: 'project-1', setup_id: saved.profile_id,
    }));
    expect(task).toMatchObject({ reason: 'outside_recruitment', status: 'blocked_configuration',
      recruitment: { state: 'before_start', starts_at: fixture.input.protocol.recruitment_start, ends_at: fixture.input.protocol.recruitment_end } });
    expect(fixture.store.all('SELECT id FROM comparison_assignments')).toHaveLength(0);
    vi.setSystemTime(Date.parse(fixture.input.protocol.recruitment_start));
    expect(fixture.domain.task(task.id)).toMatchObject({ recruitment: { state: 'open' }, reason: 'outside_recruitment' });
    const prepared = await fixture.domain.taskAction(task.id, 'prepare', {});
    expect(prepared).toMatchObject({ id: task.id, reason: null, recruitment: { state: 'open' } });
    expect(fixture.store.all('SELECT id FROM comparison_assignments')).toHaveLength(1);
    expect(fixture.store.all('SELECT id FROM tasks')).toHaveLength(1);
    expect(fixture.store.eventCount()).toBe(0);
    expect(fixture.store.all('SELECT * FROM active_intervals')).toHaveLength(0);
  } finally { vi.useRealTimers(); await fixture.domain.close?.(); fixture.cleanup(); }
});
