import { expect, test } from 'vitest';
import { buildApplicationLaunch, getApplicationLaunchCapability, openApplicationSession } from '../src/harness-application-launch.js';
const context = { workspace: "/tmp/synthetic path's repo", product: 'codex' as const, prompt: "literal $(touch nope) `echo nope` ' context" };
test('interactive commands preserve literal context and workspace, with native permissions', () => {
  const plan = buildApplicationLaunch(context, '/bin/synthetic-codex');
  expect(plan.cwd).toBe(context.workspace);
  expect(plan.args).toEqual([context.prompt]);
  expect(plan.script).toContain("'\"'\"'");
  expect(plan.script).not.toContain('--yolo');
  expect(buildApplicationLaunch({ ...context, product: 'claude_code' }, '/bin/synthetic-claude').args).toEqual([context.prompt]);
});
test('unsupported platform is explicit and does not invoke opener', async () => {
  expect(getApplicationLaunchCapability('codex', { platform: 'linux', executable: '/bin/synthetic' }).available).toBe(false);
  let calls = 0;
  await expect(
    openApplicationSession(
      { ...context, attemptId: 'synthetic' },
      {
        platform: 'linux',
        executable: '/bin/synthetic',
        directory: '/tmp',
        open: () => {
          calls++;
          return Promise.resolve();
        }
      }
    )
  ).rejects.toThrow('application_launch_unavailable');
  expect(calls).toBe(0);
});
test('failed opener and duplicate clicks never create an owned agent runner', async () => {
  let calls = 0;
  const open = () => {
    calls++;
    return Promise.reject(new Error('synthetic failure'));
  };
  const options = { platform: 'darwin', executable: '/bin/synthetic', directory: '/tmp', open };
  const result = await openApplicationSession({ ...context, attemptId: 'synthetic' }, options);
  expect(result.state).toBe('open_failed');
  expect(calls).toBe(1);
  expect(await openApplicationSession({ ...context, attemptId: 'synthetic' }, options)).toEqual(result);
  expect(calls).toBe(1);
});
