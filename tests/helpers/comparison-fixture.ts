import type { Store } from '../../src/store.js';

export const variantA = {
  schema_version: 1,
  id: 'variant-a',
  harness_version: 'a-v1',
  instruction_manifest_hash: 'a'.repeat(64),
  product: 'synthetic',
  product_version: '1.0.0',
  model: 'synthetic-model',
  reasoning_setting: 'none',
  policy_version: 'policy-v1',
  policy_status: 'eligible'
};
export const variantB = { ...variantA, id: 'variant-b', harness_version: 'b-v1', instruction_manifest_hash: 'b'.repeat(64) };
export const protocol = {
  schema_version: 1,
  id: 'comparison-1',
  project_id: 'project-1',
  team_id: 'team-1',
  mode: 'randomized_task',
  purpose: 'synthetic_validation',
  protocol_version: 'protocol-v1',
  eligibility_version: 'eligibility-v1',
  classification_version: 'classification-v1',
  participants: ['user-1', 'user-2'],
  environment_ids: ['environment-1', 'environment-2'],
  variant_ids: ['variant-a', 'variant-b'],
  recruitment_start: '2026-01-01T00:00:00Z',
  recruitment_end: '2026-01-02T00:00:00Z',
  allocation_method: 'balanced_blocks',
  allocation_version: 'balanced-blocks-v1',
  allocation_ratio: [1, 1],
  block_size: 4,
  strata: [{ id: 'stratum-1', assignees: ['user-1', 'user-2'], types: ['feature'], sizes: ['small'], allocator_id: 'allocator-1' }],
  primary_metric: 'input_total',
  quality_metric: 'criterion_fulfillment',
  quality_margin: 0.05,
  minimum_effect: 0.1,
  sample_plan: { target_tasks: 8, planning_basis_id: 'synthetic-basis' },
  followup_seconds: 3600,
  stopping_rule: { kind: 'fixed_recruitment', version: 'stopping-v1' },
  missingness_policy: { version: 'missingness-v1', max_usage_missing_rate: 0.1, max_outcome_missing_rate: 0.1 },
  deviation_policy: { mismatch: 'continue', unknown: 'continue', version_drift: 'stop' },
  confidence_level: 0.95,
  analysis_plan_version: 'synthetic-analysis-v1',
  sensitivity_plan_ids: ['synthetic-sensitivity']
};
export const metadata = {
  type: 'feature',
  expected_size: 'small',
  assignee: 'user-1',
  product: 'synthetic',
  model: 'synthetic-model',
  criterion_ids: ['criterion-1']
};
export const assignmentInput = {
  schema_version: 1,
  protocol_id: 'comparison-1',
  project_id: 'project-1',
  logical_task_id: 'logical-1',
  task_id: 'task-1',
  metadata,
  environment_id: 'environment-1',
  code_base_commit: 'c'.repeat(40),
  allocator_id: 'allocator-1'
};
export const beforeRecruitment = '2025-12-31T00:00:00Z';
export const assignmentTime = '2026-01-01T00:00:00Z';

export function seedProject(store: Store): void {
  store.execute('INSERT INTO projects(id) VALUES (?)', ['project-1']);
}
