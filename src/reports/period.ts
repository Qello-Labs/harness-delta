import { z } from 'zod';
import { createHash } from 'node:crypto';
import { addTokens, IdSchema, ModelSchema, TimestampSchema } from '../contracts.js';
import { aggregateTask, type TaskReport } from '../metrics.js';
import { Store } from '../store.js';
import { type TaskRow } from '../lifecycle.js';
const ids = z
  .array(IdSchema)
  .min(1)
  .refine(items => new Set(items).size === items.length);
const windowSchema = z.strictObject({ start: TimestampSchema, end: TimestampSchema }).refine(w => Date.parse(w.start) < Date.parse(w.end));
export const PeriodConfigSchema = z
  .strictObject({
    schema_version: z.literal(1),
    id: IdSchema,
    project_id: IdSchema,
    classification_version: z.literal(1),
    before: windowSchema,
    after: windowSchema,
    followup_hours: z.number().int().positive().max(87600),
    types: ids,
    sizes: ids,
    assignees: ids,
    products: z.array(z.enum(['codex', 'claude_code', 'synthetic'])).min(1),
    models: z.array(ModelSchema).min(1)
  })
  .refine(c => Date.parse(c.before.end) <= Date.parse(c.after.start));
export function freezePeriod(store: Store, input: unknown, now: string): void {
  const config = PeriodConfigSchema.parse(input);
  TimestampSchema.parse(now);
  if (Date.parse(now) >= Date.parse(config.before.start)) throw new Error('registration_too_late');
  store.transaction(() => {
    if (!store.get('SELECT id FROM projects WHERE id=?', [config.project_id])) throw new Error('unknown_project');
    store.execute('INSERT INTO baselines(id,project_id,mode,settings) VALUES (?,?,?,?)', [
      config.id,
      config.project_id,
      'observational_period',
      JSON.stringify({ config, registered_at: new Date(now).toISOString() })
    ]);
  });
}
function summarizeCounts(tasks: TaskReport[]) {
  const outcomes = { success: 0, failed: 0, aborted: 0, pending: 0 };
  for (const task of tasks) outcomes[task.outcome ?? 'pending']++;
  const firstSuccess = tasks.filter(task => task.first_success === true).length;
  const firstFailed = tasks.filter(task => task.first_success === false).length;
  const assessed = tasks.filter(task => task.outcome !== null);
  const criterionTotal = assessed.reduce((total, task) => total + task.metadata.criterion_ids.length, 0);
  const criterionMet = assessed.reduce((total, task) => total + task.criteria_met.length, 0);
  const partial = tasks.flatMap(task => (task.usage.partial_tokens === null ? [] : [task.usage.partial_tokens])).sort((a, b) => a - b);
  const median = partial.length
    ? partial.length % 2
      ? partial[Math.floor(partial.length / 2)]!
      : partial[partial.length / 2 - 1]! / 2 + partial[partial.length / 2]! / 2
    : null;
  const references = (field: 'compatibility_unverified' | 'legacy_unverified') => {
    const values = tasks.flatMap(task => (task.usage[field].partial_tokens === null ? [] : [task.usage[field].partial_tokens])).sort((a, b) => a - b);
    return { partial_tokens_distribution: values, mean_partial_tokens: values.length ? addTokens(values) / values.length : null };
  };
  return {
    compatibility_unverified: references('compatibility_unverified'),
    legacy_unverified: references('legacy_unverified'),
    invalidated_events: tasks.reduce((sum, t) => sum + t.usage.compatibility.invalidated_events, 0),
    outcomes,
    eligible_count: tasks.length,
    complete_usage_count: 0,
    partial_usage_count: tasks.filter(t => t.usage.status === 'partial').length,
    missing_usage_count: tasks.filter(t => t.usage.status === 'missing').length,
    mean_complete_tokens: null,
    median_complete_tokens: null,
    tokens_per_success: null,
    partial_tokens_distribution: partial,
    mean_partial_tokens: partial.length ? addTokens(partial) / partial.length : null,
    median_partial_tokens: median,
    first_attempt: {
      success: firstSuccess,
      failed: firstFailed,
      pending: tasks.length - firstSuccess - firstFailed,
      assessed: firstSuccess + firstFailed,
      success_rate: firstSuccess + firstFailed ? firstSuccess / (firstSuccess + firstFailed) : null
    },
    criteria: {
      assessed_tasks: assessed.length,
      pending_tasks: tasks.length - assessed.length,
      fulfilled: criterionMet,
      assessed_criteria: criterionTotal,
      fulfillment_rate: criterionTotal ? criterionMet / criterionTotal : null
    },
    rework: {
      tasks_with_rework: tasks.filter(task => task.rework_count > 0).length,
      eligible_tasks: tasks.length,
      total_attempts: tasks.reduce((total, task) => total + task.rework_count, 0),
      rate: tasks.length ? tasks.filter(task => task.rework_count > 0).length / tasks.length : null
    },
    missing_reasons: [...new Set(tasks.flatMap(task => task.usage.reasons))].sort()
  };
}
function summarize(tasks: TaskReport[]) {
  const dimensions = ['type', 'expected_size', 'expected_complexity', 'assignee', 'product', 'model'] as const;
  const strata = dimensions.flatMap(dimension => {
    const groups = new Map<string, TaskReport[]>();
    for (const task of tasks) {
      const value = task.metadata[dimension] ?? 'unspecified';
      groups.set(value, [...(groups.get(value) ?? []), task]);
    }
    return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([value, rows]) => ({ dimension, value, ...summarizeCounts(rows) }));
  });
  return { tasks, ...summarizeCounts(tasks), composition: tasks.map(task => ({ task_id: task.task_id, ...task.metadata })), strata };
}
export function periodReport(store: Store, configId: string, cutoff: string) {
  return store.transaction(() => {
    const end = new Date(TimestampSchema.parse(cutoff)).toISOString();
    const row = store.get<{ settings: string; mode: string }>('SELECT settings,mode FROM baselines WHERE id=?', [IdSchema.parse(configId)]);
    if (!row || row.mode !== 'observational_period') throw new Error('unknown_period');
    const stored = z.strictObject({ config: PeriodConfigSchema, registered_at: TimestampSchema }).parse(JSON.parse(row.settings) as unknown);
    const config = stored.config;
    if (Date.parse(end) < Date.parse(stored.registered_at)) throw new Error('invalid_cutoff');
    const tasks = store.all<TaskRow>('SELECT * FROM tasks WHERE project_id=? AND started_at IS NOT NULL ORDER BY id', [config.project_id]);
    const cohort = (window: { start: string; end: string }) =>
      tasks
        .filter(
          task =>
            task.started_at &&
            Date.parse(task.started_at) >= Date.parse(window.start) &&
            Date.parse(task.started_at) < Date.parse(window.end) &&
            Date.parse(task.started_at) <= Date.parse(end)
        )
        .map(task =>
          aggregateTask(store, task.id, new Date(Math.min(Date.parse(end), Date.parse(task.started_at!) + config.followup_hours * 3600000)).toISOString())
        )
        .filter(
          task =>
            config.types.includes(task.metadata.type) &&
            config.sizes.includes(task.metadata.expected_size) &&
            config.assignees.includes(task.metadata.assignee) &&
            config.products.includes(task.metadata.product) &&
            config.models.includes(task.metadata.model)
        );
    const before = summarize(cohort(config.before));
    const after = summarize(cohort(config.after));
    const data = {
      schema_version: 1,
      analysis_version: 'descriptive-1',
      mode: 'observational_period',
      settings: config,
      registered_at: stored.registered_at,
      cutoff: end,
      provisional: Date.parse(end) < Date.parse(config.after.end) + config.followup_hours * 3600000,
      before,
      after,
      change_rate: null,
      limitations: [
        'no_causal_interpretation',
        'complete_usage_unavailable',
        'no_inferential_adoption_decision',
        'deleted_tasks_are_absent_from_current_snapshot'
      ]
    };
    return { ...data, snapshot_hash: createHash('sha256').update(JSON.stringify(data)).digest('hex') };
  });
}
