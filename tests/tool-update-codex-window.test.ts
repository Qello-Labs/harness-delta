import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { createWindowBudget, prepareWindowCase } from '../scripts/tool-update/codex-window-conformance.mjs';

const directories: string[] = [];
test('an expired case cannot admit more work after otherwise positive cleanup', () => {
  const budget = createWindowBudget(0);
  const work = budget.reserve('normal', 0, 100);
  expect(() => work.remaining(100)).toThrow('deadline_exceeded');
  work.stop(100);
  work.verifyCleanup(101, {
    identitiesGone: true,
    resourcesClosed: true,
    terminalRestored: true
  });
  expect(() => budget.reserve('sigint', 102, 1200000)).toThrow('batch_stopped');
});

test('insufficient reserve ends admission rather than allowing a backdated retry', () => {
  const budget = createWindowBudget(0);
  expect(() => budget.reserve('normal', 1065001, 1200000)).toThrow('admission_reserve');
  expect(() => budget.reserve('normal', 1065000, 1200000)).toThrow('batch_stopped');
});
afterEach(() => {
  for (const root of directories.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});
function planFixture(overrides: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'window-plan-'));
  directories.push(root);
  const out = join(root, 'case');
  mkdirSync(out, { mode: 0o700 });
  const planFile = join(root, 'plan.json');
  const plan = {
    schema_version: 1,
    product: 'codex',
    version: '0.167.0',
    commit: '086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a',
    route: 'codex_binding',
    policy_id: 'codex-binding-root-window-v1',
    operation: 'collect',
    topology: 'root',
    runtime: 'node24',
    platform: 'darwin_arm64',
    model: 'gpt-6.1-sol',
    effort: 'high',
    pins: Object.fromEntries(
      ['native', 'host', 'source', 'build', 'instrument', 'runtime', 'lockfile', 'config', 'environment', 'egress', 'quota'].map(name => [name, 'a'.repeat(64)])
    ),
    ...overrides
  };
  writeFileSync(planFile, JSON.stringify(plan), { mode: 0o600 });
  return { planFile, out, caseId: 'normal' as const };
}

test('preparation writes a non-authorizing disabled intent without inspecting claimed native pins', () => {
  const fixture = planFixture();
  expect(prepareWindowCase(fixture)).toEqual({
    status: 'prepared_execution_disabled',
    authority: 'none',
    actual_qualification: false
  });
  expect(JSON.parse(readFileSync(join(fixture.out, 'intent.json'), 'utf8'))).toMatchObject({
    kind: 'codex_window_disabled_intent',
    authority: 'none',
    execution_enabled: false,
    actual_qualification: false,
    containment_qualified: false
  });
  expect(() => prepareWindowCase(fixture)).toThrow();
});

test.each([
  { topology: 'bounded_family' },
  { operation: 'link' },
  { version: '0.168.0' },
  { model: 'wrong' },
  { effort: 'low' },
  { runtime: 'node26' },
  { platform: 'linux' },
  { approved: true }
])('preparation refuses out-of-scope input %j', overrides => {
  expect(() => prepareWindowCase(planFixture(overrides))).toThrow('plan_invalid');
});

test('preparation refuses a nonempty case without changing historical bytes', () => {
  const fixture = planFixture();
  const path = join(fixture.out, 'historical.json');
  writeFileSync(path, '{"synthetic":1}', { mode: 0o600 });
  expect(() => prepareWindowCase(fixture)).toThrow('case_not_fresh');
  expect(readFileSync(path, 'utf8')).toBe('{"synthetic":1}');
});

test.each(
  [
    [],
    ['--intent', '/nonexistent/intent', '--consent', '/nonexistent/consent'],
    ['--approved', 'true'],
    ['--consent', '{"approved":true}'],
    ['--consent', 'expired'],
    ['--consent', 'reused']
  ].map(args => ({ args }))
)('execute remains disabled before opening any supplied input: $args', ({ args }) => {
  const result = spawnSync(process.execPath, [resolve('scripts/tool-update/codex-window-conformance.mjs'), 'execute', ...args], {
    encoding: 'utf8',
    timeout: 5000,
    env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }
  });
  expect(result.status).toBe(2);
  expect(JSON.parse(result.stdout)).toEqual({
    status: 'refused',
    code: 'b1_execution_disabled',
    execution_attempted: false,
    actual_qualification: false
  });
  expect(result.stderr).toBe('');
});

test.each([
  ['version_probe', 1175000, 1185000],
  ['normal', 1065000, 1185000],
  ['correlation', 1005000, 1185000]
] as const)('admits %s at exact reserve equality and refuses one millisecond later', (caseId, reservation, deadline) => {
  const budget = createWindowBudget(0);
  const admitted = budget.reserve(caseId, reservation, 1200000);
  expect(admitted.deadline).toBe(deadline);
  expect(admitted.remaining(reservation + 6000)).toBe(deadline - reservation - 6000);
  expect(() => createWindowBudget(0).reserve(caseId, reservation + 1, 1200000)).toThrow('admission_reserve');
});

test('preflight delays and trial expiry only shorten the original work deadline', () => {
  const budget = createWindowBudget(0);
  const work = budget.reserve('normal', 1000, 100000);
  expect(work.remaining(61000)).toBe(39000);
  work.bindTrialExpiry(80000);
  expect(work.remaining(61000)).toBe(19000);
  expect(() => work.bindTrialExpiry(90000)).toThrow('deadline_extension');
  expect(() => work.remaining(80000)).toThrow('deadline_exceeded');
  expect(() => budget.reserve('normal', 1001, 100000)).toThrow('reservation_reused');
});

test('KILL acknowledgement cannot substitute for disappearance and closed resources', () => {
  const budget = createWindowBudget(0);
  const work = budget.reserve('normal', 0, 1200000);
  work.stop(100);
  expect(() =>
    work.verifyCleanup(101, {
      identitiesGone: false,
      resourcesClosed: true,
      terminalRestored: true
    })
  ).toThrow('cleanup_unverified');
  expect(() => budget.reserve('sigint', 102, 1200000)).toThrow('batch_stopped');
});

test('the final audit uses its existing reserve without another teardown window', () => {
  const budget = createWindowBudget(0);
  const work = budget.reserve('normal', 1065000, 1200000);
  work.stop(1185000);
  work.verifyCleanup(1190000, {
    identitiesGone: true,
    resourcesClosed: true,
    terminalRestored: true
  });
  expect(budget.auditDeadline(1190000, 1201000)).toBe(1200000);
  expect(budget.auditDeadline(1190000, 1190500)).toBe(1190500);
  expect(() => budget.auditDeadline(1190001, 1201000)).toThrow('audit_deadline');
  expect(() => budget.auditDeadline(1190000, 1190000)).toThrow('audit_deadline');
});

test.each(['observer', 'owner', 'guardian', 'containment', 'suspension'] as const)('unexpected %s loss prevents later work and final success', loss => {
  const budget = createWindowBudget(0);
  const work = budget.reserve('termination', 0, 1200000);
  work.loss(loss, 10);
  expect(() => work.remaining(11)).toThrow('case_stopped');
  expect(() => budget.reserve('replacement', 12, 1200000)).toThrow('batch_stopped');
  expect(() => budget.auditDeadline(13, 1200000)).toThrow('cleanup_unverified');
});

test('only the scheduled termination fault can continue after positive cleanup', () => {
  const budget = createWindowBudget(0);
  const work = budget.reserve('termination', 0, 1200000);
  expect(() => work.scheduleNegative('wrong', 'request-start', 1)).toThrow('fault_mismatch');
  work.scheduleNegative('termination-control-eof', 'request-start', 2);
  work.stop(3, 'scheduled');
  expect(() => work.remaining(4)).toThrow('case_stopped');
  work.verifyCleanup(5, {
    identitiesGone: true,
    resourcesClosed: true,
    terminalRestored: true
  });
  expect(budget.reserve('replacement', 6, 1200000).remaining(7)).toBe(119999);
});
