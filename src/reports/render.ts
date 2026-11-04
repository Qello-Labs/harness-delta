/** JSON is the canonical snapshot; Markdown carries the same values verbatim. */
export function renderReport(report: unknown, format: string): string {
  if (format === 'json') return JSON.stringify(report, null, 2) + '\n';
  if (format === 'markdown')
    return (
      '# Local measurement report\n\nPartial observations are not complete task totals. Period differences are observational.\n\n```json\n' +
      JSON.stringify(report, null, 2) +
      '\n```\n'
    );
  throw new Error('invalid_format');
}
