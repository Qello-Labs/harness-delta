import { expect, test } from 'vitest';
import { createSyntheticCodexWorkflowAdapter } from '../../src/codex-workflow-adapter.js';
import { readObservedCostReport } from '../../src/observed-cost-report.js';
import { runAssignedWorkflow } from '../../src/task-workflow.js';
import { codexWorkflowFixture } from '../helpers/codex-workflow-fixture.js';

async function fixture() {
  const f = codexWorkflowFixture();
  const root = f.newRoot();
  await runAssignedWorkflow(
    f.store,
    f.input,
    createSyntheticCodexWorkflowAdapter(f.store, f.execution('coverage-link', 'link', root.id, root.path), f.script),
    { model: null, effort: null }
  );
  const tableId = f.store.get<{ id: string }>('SELECT id FROM price_tables')!.id;
  const report = (cutoff = new Date(Date.now() + 1000).toISOString()) => readObservedCostReport(f.store, 'task-1', tableId, cutoff, 'output-only-v1');
  return { ...f, report };
}
test('observed cost exposes guarded source facts but withholds request universe and complete amount', async () => {
  const f = await fixture();
  try {
    expect(f.report()).toMatchObject({
      complete_amount: null,
      partial_amount: null,
      coverage: {
        evidence: {
          task_id: 'task-1',
          has_observed_value: false,
          facts: {
            scope_before_access: 'verified',
            immutable_identity: 'verified',
            request_universe: 'unknown',
            price_coverage: 'unknown',
            continuous_observation: 'unknown'
          }
        },
        decision: { eligible: false },
        observed_components_priced: false
      }
    });
    expect(JSON.stringify(f.report())).not.toContain(f.project);
  } finally {
    f.cleanup();
  }
});
test('a past cutoff cannot use a future successful journal as verified cost coverage', async () => {
  const f = await fixture();
  try {
    const cutoff = new Date(Date.now() + 1000).toISOString();
    const later = new Date(Date.parse(cutoff) + 1000).toISOString();
    f.store.execute('UPDATE codex_workflow_runs SET started_at=?,ended_at=?', [later, later]);
    expect(f.report(cutoff)).toMatchObject({
      coverage: { evidence: { facts: { scope_before_access: 'unknown', immutable_identity: 'unknown' } }, workflow_run_count: 0 }
    });
  } finally {
    f.cleanup();
  }
});
test('changed source evidence is a violation and never upgraded by a later successful link', async () => {
  const f = await fixture();
  try {
    f.store.execute("UPDATE codex_workflow_runs SET state='failed',reason='source_changed',diagnostic_code='source_changed'", []);
    const root = f.newRoot();
    await runAssignedWorkflow(
      f.store,
      { ...f.input, confirmation_id: 'later-confirmation' },
      createSyntheticCodexWorkflowAdapter(f.store, f.execution('later-link', 'link', root.id, root.path), f.script),
      { model: null, effort: null }
    );
    expect(f.report()).toMatchObject({
      coverage: { evidence: { facts: { immutable_identity: 'violated' } }, decision: { eligible: false } },
      complete_amount: null
    });
  } finally {
    f.cleanup();
  }
});
