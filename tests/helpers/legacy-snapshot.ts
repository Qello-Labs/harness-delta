import { createComparisonSnapshot as create, readComparisonSnapshot as read } from '../../src/reports/comparison-snapshot.js';
/** Explicitly assert the v1 branch while exercising the shared versioned API. */
export const createComparisonSnapshot = (...args: Parameters<typeof create>) => {
  const report = create(...args);
  if (report.schema_version !== 1) throw new Error('expected_legacy_report');
  return report;
};
export const readComparisonSnapshot = (...args: Parameters<typeof read>) => {
  const report = read(...args);
  if (report.schema_version !== 1) throw new Error('expected_legacy_report');
  return report;
};
