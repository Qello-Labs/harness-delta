import type { ComparisonReport } from './comparison.js';
import type { InvalidatedReport } from './comparison-contracts.js';
import type { TeamReport, InvalidatedTeamReport } from './team-snapshot.js';

type Report = ComparisonReport | TeamReport;
type Invalidated = InvalidatedReport | InvalidatedTeamReport;
type Cell = string | number | boolean | null;

/** Escape metadata before placing it in Markdown text or a table cell. */
function cell(value: Cell): string {
  if (value === null) return 'unavailable';
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/[\\|`*_{}[\]#!()~]/g, '\\$&');
}
function list(values: readonly Cell[]): string {
  return values.length ? values.map(cell).join(', ') : 'none';
}
function table(headers: string[], rows: Cell[][]): string {
  return [headers, headers.map(() => '---'), ...rows].map(row => '| ' + row.map(cell).join(' | ') + ' |').join('\n') + '\n\n';
}
function counts(values: Record<string, number | undefined>): string {
  const entries = Object.entries(values).filter((entry): entry is [string, number] => entry[1] !== undefined);
  return entries.length ? entries.map(([key, value]) => `${key}: ${value}`).join(', ') : 'none';
}

/** Presentation only: every number, population and rate comes from the frozen report. */
export function renderReadableComparison(report: Report | Invalidated): string {
  const team = 'snapshot_id' in report;
  const id = team ? report.snapshot_id : report.report_id;
  let text = team ? '# Synthetic team comparison — readable\n\n' : '# Synthetic assignment comparison — readable\n\n';
  text += `Report ID: ${cell(id)}\n\n`;
  if ('original_cohort' in report) {
    return (
      text +
      `Validity: invalidated\n\nReason: ${cell(report.reason)}\n\nOriginal cohort: ${cell(report.original_cohort)}\n\n` +
      `Adoption: ${cell(report.adoption.status)} (${cell(report.adoption.reason)})\n`
    );
  }
  const cohort = team ? 'Imported cohort' : 'Assigned cohort';
  text += `Protocol: ${cell(report.protocol_id)}\n\nSnapshot hash: ${cell(report.snapshot_hash)}\n\n`;
  text += `Descriptive version: ${cell(report.descriptive_version)}\n\nCutoff: ${cell(report.cutoff)}\n\nProvisional: ${cell(report.provisional)}\n\n`;
  text += `Recruitment: ${cell(report.settings.recruitment_start)} to ${cell(report.settings.recruitment_end)}\n\nFollow-up seconds: ${cell(report.settings.followup_seconds)}\n\n`;
  if ('source_vector' in report) {
    text += `As of (coordinator receipt boundary): ${cell(report.as_of)}\n\nCreated at: ${cell(report.created_at)}\n\n`;
    text += `Team completeness: ${cell(report.team_completeness)}. Team assignment denominator: ${cell(report.team_assignment_denominator)}.\n\n`;
    text += `Declared writer coverage: ${cell(report.declared_writer_coverage)}. This is not task or token collection completeness.\n\n`;
    text += `Required namespaces: ${list(report.required_namespaces)}\n\nMissing namespaces: ${list(report.missing_namespaces)}\n\n`;
    text += 'Imported tasks describe received contributions; full-team and eligibility denominators remain unknown. Registration activity is not shared.\n\n';
    text += table(
      ['Namespace', 'Export revision', 'Source snapshot sequence', 'Source evaluated at', 'Identity captured at', 'Produced at', 'Received at'],
      report.source_vector.map(v => [
        v.namespace_id,
        v.export_revision,
        v.source_snapshot_sequence,
        v.source_evaluated_at,
        v.identity_captured_at,
        v.produced_at,
        v.received_at
      ])
    );
  } else {
    text += `Evaluated at: ${cell(report.evaluated_at)}\n\nData revision: ${cell(report.data_revision)}\n\n`;
    const context = report.recruitment_context;
    text += `Unassigned eligibility: ${cell(context.unassigned_eligibility)}. Project registration activity is context, not an eligible-task denominator.\n\n`;
    text += table(
      ['Registered tasks', 'Assigned this protocol', 'Assigned other protocol', 'Unassigned'],
      [[context.registered_tasks, context.assigned_this_protocol, context.assigned_other_protocol, context.unassigned]]
    );
  }
  text += `Snapshot sequence: ${cell(report.snapshot_sequence)}\n\n`;
  text +=
    '## Cohort and observed subsets\n\nOriginal assignment defines the comparison. Failed, aborted, never-started and missing-outcome tasks remain in the cohort. Partial-usage tasks may have no combined token value.\n\n';
  const populations: { name: string; summary: ComparisonReport['total'] }[] = [
    { name: cohort, summary: report.total },
    ...report.arms.map(arm => ({ name: arm.original_variant_id, summary: arm }))
  ];
  text += table(
    ['Population', 'Original assigned tasks', 'Partial-usage tasks', 'Missing-usage tasks', 'Complete-usage tasks'],
    populations.map(({ name, summary: s }) => [name, s.assigned_tasks, s.usage.partial_tasks, s.usage.missing_tasks, s.usage.complete_tasks])
  );
  text +=
    'Each n below is the number of tasks with an observed value for that component, not a collection rate. Component subsets may differ. Partial distributions cannot establish full-task efficiency or savings. Cached input and reasoning are displayed separately, never added again.\n\n';
  text += table(
    ['Population', 'Metric', 'Observed task n', 'Mean', 'Median', 'Distribution'],
    populations.flatMap(({ name, summary: s }) =>
      (
        [
          ['Partial combined tokens', s.usage.partial_tokens],
          ['Partial input tokens', s.usage.partial_input_total],
          ['Partial output tokens', s.usage.partial_output_total]
        ] as const
      ).map(([metric, d]) => [name, metric, d.task_denominator, d.mean, d.median, d.distribution.length ? d.distribution.join(', ') : 'none'])
    )
  );
  text += `Complete token mean: ${cell(report.total.usage.complete_tokens_mean)}. Cost: ${cell(report.total.usage.cost)}. Change rate: ${cell(report.total.usage.change_rate)}. Tokens per success: ${cell(report.total.usage.tokens_per_success)}.\n\n`;
  text +=
    '## Outcomes, follow-up and rework\n\nDeadline success uses the original assigned cohort and stays unavailable while follow-up is pending. First-attempt success uses assessed tasks; criterion fulfillment uses assessed criteria. These denominators are different.\n\n';
  text += table(
    ['Population', 'Success', 'Failed', 'Aborted', 'Not started', 'Outcome missing', 'Pending follow-up'],
    populations.map(({ name, summary: s }) => [
      name,
      s.deadline_counts.success,
      s.deadline_counts.failed,
      s.deadline_counts.aborted,
      s.deadline_counts.not_started,
      s.deadline_counts.outcome_missing,
      s.deadline_counts.pending_followup
    ])
  );
  text += table(
    ['Population', 'Metric', 'Numerator', 'Denominator', 'Value', 'Unavailable reason'],
    populations.flatMap(({ name, summary: s }) =>
      (
        [
          ['Deadline success', s.deadline_success],
          ['First-attempt success', s.first_attempt.success],
          ['Criterion fulfillment', s.criteria.fulfillment],
          ['Tasks with rework', s.rework.task_rate],
          ['Missing usage tasks', s.usage.missing_rate],
          ['Outcome missing or not started', s.outcome_missing_rate]
        ] as const
      ).map(([metric, r]) => [name, metric, r.numerator, r.denominator, r.value, r.reason ?? 'none'])
    )
  );
  text += table(
    ['Population', 'First-assessed tasks', 'First-unassessed tasks', 'Outcome-assessed tasks', 'Outcome-unassessed tasks', 'Rework attempts'],
    populations.map(({ name, summary: s }) => [
      name,
      s.first_attempt.assessed_tasks,
      s.first_attempt.unassessed_tasks,
      s.criteria.assessed_tasks,
      s.criteria.unassessed_tasks,
      s.rework.attempts
    ])
  );
  text +=
    '## Composition and allocation blocks\n\nComposition counts describe the original cohort; differing task mix is not controlled away by this presentation.\n\n';
  text += table(
    ['Dimension', 'Value', 'Assigned tasks'],
    report.composition.map(c => [c.dimension, c.value, c.assigned_tasks])
  );
  text += table(
    ['Stratum', 'Block', 'Assigned tasks', 'First variant tasks', 'Second variant tasks', 'Planned size', 'Status'],
    report.blocks.map(b => [b.stratum_id, b.block_id, b.assigned_tasks, b.a, b.b, b.planned_size, b.status])
  );
  text +=
    '## Declared configuration and deviations\n\nActual-configuration histories are supplementary declarations. Unknown runtime, crossover and drift do not change original assignment or prove isolation.\n\n';
  text += table(
    ['Variant', 'Harness', 'Product', 'Product version', 'Model', 'Reasoning', 'Policy', 'Policy status', 'Instruction manifest'],
    report.variants.map(v => [
      v.id,
      v.harness_version,
      v.product,
      v.product_version,
      v.model,
      v.reasoning_setting,
      v.policy_version,
      v.policy_status,
      v.instruction_manifest_hash
    ])
  );
  text += table(
    ['Supplementary category', 'Tasks'],
    report.actual_configuration_summary.map(c => [c.category, c.assigned_tasks])
  );
  text += table(
    [
      'Task',
      'Original variant',
      'Declared category',
      'Known variants',
      'Unknown variant',
      'Unknown runtime',
      'Runtime drift',
      'Self-attested records',
      'Artifact-hash records'
    ],
    report.tasks.map(t => [
      t.task_id,
      t.original_variant_id,
      t.actual_configuration.category,
      t.actual_configuration.known_variant_ids.join(', ') || 'none',
      t.actual_configuration.has_unknown_variant,
      t.actual_configuration.has_unknown_runtime,
      t.actual_configuration.has_runtime_drift,
      t.actual_configuration.self_attested,
      t.actual_configuration.selected_artifact_hash
    ])
  );
  text += table(
    ['Task', 'Deviation', 'Occurred at', 'Recorded at'],
    report.tasks.flatMap(t => t.deviations.map(d => [t.task_id, d.reason_code, d.occurred_at, d.recorded_at]))
  );
  text +=
    '## Task observations\n\nUnavailable is distinct from observed zero. Reading states below count events, not tasks. No reading events does not prove zero usage.\n\n';
  text += table(
    ['Task', 'Original variant', 'Usage state', 'Partial combined tokens', 'Input tokens', 'Output tokens'],
    report.tasks.map(t => [
      t.task_id,
      t.original_variant_id,
      t.usage.status,
      t.usage.partial_tokens,
      t.usage.input_total.observed_sum,
      t.usage.output_total.observed_sum
    ])
  );
  text += table(
    [
      'Task',
      'Component',
      'Observed sum',
      'Observed events',
      'Missing events',
      'Error events',
      'Excluded events',
      'Unmeasurable events',
      'Reasons (event counts)'
    ],
    report.tasks.flatMap(t =>
      (['input_total', 'output_total', 'cached_input', 'reasoning_output'] as const).map(component => {
        const r = t.usage[component];
        return [
          t.task_id,
          component,
          r.observed_sum,
          r.status_counts.observed,
          r.status_counts.missing,
          r.status_counts.error,
          r.status_counts.excluded,
          r.status_counts.unmeasurable,
          counts(r.reason_counts)
        ];
      })
    )
  );
  text +=
    'Task elapsed and active milliseconds are not human labor or model runtime. Observation windows describe retained evidence, not whole-task coverage.\n\n';
  text += table(
    ['Task', 'Deadline state', 'Current human outcome', 'Follow-up ends at', 'Endpoint end', 'Elapsed ms', 'Active ms'],
    report.tasks.map(t => [t.task_id, t.deadline_status, t.current_outcome, t.followup_ends_at, t.endpoint_end, t.time.elapsed_ms, t.time.active_ms])
  );
  text += table(
    ['Task', 'Observation starts', 'Observation ends', 'State', 'Reason'],
    report.tasks.flatMap(t => t.observations.map(o => [t.task_id, o.started_at, o.ended_at, o.status, o.reason]))
  );
  text +=
    '## Decision limits\n\nSynthetic descriptions only. No causal, practical-equivalence or adoption conclusion follows from these partial observations.\n\n';
  text += `Adoption: ${cell(report.adoption.status)} (${cell(report.adoption.reason)}). Confidence interval: ${cell(report.confidence_interval)}. P-value: ${cell(report.p_value)}.\n\n`;
  text += report.limitations.map(reason => '- ' + cell(reason)).join('\n') + '\n';
  return text;
}
