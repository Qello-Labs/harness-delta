import { expect, test } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CodexWorkflowExecutionSchema, createSyntheticCodexWorkflowAdapter } from '../src/codex-workflow-adapter.js';
import { runAssignedWorkflow } from '../src/workflow/task-workflow.js';
import { codexWorkflowFixture } from './helpers/codex-workflow-fixture.js';

test('explicit per-invocation untrusted launch forwards the scoped setting and preserves the collection hook', async () => {
  const f = codexWorkflowFixture();
  try {
    const argumentsPath = join(f.root, 'arguments.json');
    writeFileSync(
      f.script,
      `import {writeFileSync as capture} from 'node:fs';capture(${JSON.stringify(argumentsPath)},JSON.stringify(process.argv.slice(2)));\n` +
        readFileSync(f.script, 'utf8')
    );
    const result = await runAssignedWorkflow(
      f.store,
      f.input,
      createSyntheticCodexWorkflowAdapter(f.store, { ...f.execution('untrusted-launch'), project_trust: 'untrusted' }, f.script),
      { model: 'user-selected-model', effort: 'high' }
    );
    expect(result.adapter_result, JSON.stringify(result.adapter_result)).toMatchObject({
      state: 'completed',
      observed_requests: 1,
      harness_application: 'invocation_settings_verified'
    });
    const args = JSON.parse(readFileSync(argumentsPath, 'utf8')) as string[];
    expect(args).toContain(`projects={${JSON.stringify(f.project)}={trust_level="untrusted"}}`);
    // Quoting a dotted left-hand path does not work in the pinned native parser.
    expect(args.some(arg => arg.startsWith('projects.'))).toBe(false);
    expect(args).toContain('approval_policy="on-request"');
    expect(args).toContain('approvals_reviewer="auto_review"');
    expect(args.some(arg => arg.startsWith('hooks.SessionStart='))).toBe(true);
    expect(args.some(arg => arg.startsWith('hooks.state='))).toBe(true);
    expect(args).not.toContain('--ignore-user-config');
    expect(args).not.toContain('--ephemeral');
    expect(f.store.eventCount()).toBe(1);
    expect(f.store.all('SELECT * FROM runtime_evidence')).toHaveLength(1);
    expect(existsSync(join(f.home, 'config.toml'))).toBe(false);
  } finally {
    f.cleanup();
  }
});

test('untrusted verification option cannot select trusted or silently change resume/link/collect/child behavior', () => {
  const f = codexWorkflowFixture();
  try {
    expect(CodexWorkflowExecutionSchema.safeParse({ ...f.execution('trusted'), project_trust: 'trusted' }).success).toBe(false);
    for (const operation of ['resume', 'link', 'collect'] as const) {
      expect(
        CodexWorkflowExecutionSchema.safeParse({
          ...f.execution(operation, operation, '00000000-0000-4000-8000-000000000001', '/synthetic/source'),
          project_trust: 'untrusted'
        }).success
      ).toBe(false);
    }
    expect(
      CodexWorkflowExecutionSchema.safeParse({
        ...f.execution('child'),
        sandbox: 'read-only',
        child_runtime: { model: 'child-model', effort: 'high' },
        project_trust: 'untrusted'
      }).success
    ).toBe(false);
    expect(CodexWorkflowExecutionSchema.safeParse(f.execution('unchanged')).success).toBe(true);
  } finally {
    f.cleanup();
  }
});
