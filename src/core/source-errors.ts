/** Fixed metadata only; never construct these categories from source/error text. */
export const sourceDiagnosticCategories = [
  'read_failed',
  'short_read',
  'unstable_read',
  'unsupported_source',
  'scope_mismatch',
  'invalid_json',
  'record_conflict',
  'parse_failed',
  'identity_changed',
  'source_truncated',
  'same_size_modified',
  'clock_regressed',
  'model_mismatch',
  'record_changed',
  'compatibility_invalidated'
] as const;
export type SourceDiagnosticCategory = (typeof sourceDiagnosticCategories)[number];
export class SourceFailure extends Error {
  constructor(
    readonly category: SourceDiagnosticCategory,
    reason = 'source_error'
  ) {
    super(reason);
  }
}
export function sourceCategory(error: unknown, fallback: SourceDiagnosticCategory): SourceDiagnosticCategory {
  return error instanceof SourceFailure && sourceDiagnosticCategories.includes(error.category) ? error.category : fallback;
}
