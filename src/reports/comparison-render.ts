import type { FlexibleComparisonReport } from './flexible-comparison.js';
import { renderReadableComparison } from './comparison-readable.js';
import type { ComparisonReport } from './comparison.js';
import type { InvalidatedReport } from './comparison-contracts.js';

export function renderComparisonReport(report: ComparisonReport | FlexibleComparisonReport | InvalidatedReport, format: string): string {
  const json = JSON.stringify(report, null, 2) + '\n';
  if (format === 'json') return json;
  if (report.schema_version === 2) {
    if (!['markdown', 'markdown-readable'].includes(format)) throw new Error('invalid_format');
    const late = report.tasks.filter(t => t.late_outcome).length;
    const lateNote = late
      ? `${late} ${late === 1 ? 'outcome was' : 'outcomes were'} assessed after the follow-up deadline; see late_outcome. Late outcomes are excluded from deadline status and rates.\n\n`
      : '';
    return (
      (report.purpose === 'functional_pilot'
        ? '# Functional pilot report\n\nFunctional checks only; effectiveness evaluation and adoption are not applicable.\n\n'
        : '# Flexible comparison report\n\n') +
      lateNote +
      'Standardized estimated cost. Whole task cost unconfirmed without coverage. Elapsed time is not human labor.\n\n```json\n' +
      json +
      '```\n'
    );
  }
  if (format === 'markdown')
    return (
      '# Assignment comparison report\n\nSynthetic descriptions only. Partial observations are not complete task totals. No inferential adoption decision.\n\n```json\n' +
      json +
      '```\n'
    );
  if (format === 'markdown-readable') return renderReadableComparison(report);
  throw new Error('invalid_format');
}
