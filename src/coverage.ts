import { z } from 'zod';

const evidenceStateSchema = z.enum(['verified', 'unknown', 'violated']);
const factsSchema = z.strictObject({
  scopeBeforeAccess: evidenceStateSchema,
  freshSession: evidenceStateSchema,
  readyBeforeFirstRequest: evidenceStateSchema,
  continuousObservation: evidenceStateSchema,
  fixedModel: evidenceStateSchema,
  boundedTopology: evidenceStateSchema,
  requestUniverse: evidenceStateSchema,
  terminalAccounting: evidenceStateSchema,
  immutableIdentity: evidenceStateSchema,
  durableFlush: evidenceStateSchema,
  counterSemantics: evidenceStateSchema
});
const evidenceSchema = z.strictObject({
  profileId: z.literal('synthetic-coverage-v1'),
  metric: z.enum(['input_total', 'output_total']),
  facts: factsSchema,
  hasObservedValue: z.boolean()
});

export type EvidenceState = z.infer<typeof evidenceStateSchema>;
export type CoverageEvidence = z.infer<typeof evidenceSchema>;
export type CoverageMetric = CoverageEvidence['metric'];
export type CoverageFact = keyof CoverageEvidence['facts'];
export interface CoverageDecision {
  eligible: boolean;
  reasons: (CoverageFact | 'missing_value')[];
}
const factNames = Object.keys(factsSchema.shape) as CoverageFact[];

/** Internal synthetic policy only; does not establish facts or enable complete reports. */
export function evaluateCoverage(input: unknown): CoverageDecision {
  const parsed = evidenceSchema.safeParse(input);
  if (!parsed.success) throw new Error('invalid_coverage_input');
  const evidence = parsed.data;
  const reasons: CoverageDecision['reasons'] = factNames.filter(fact => evidence.facts[fact] !== 'verified');
  if (!evidence.hasObservedValue) reasons.push('missing_value');
  return { eligible: reasons.length === 0, reasons: reasons.sort() };
}

/** Merge completed intervals only. Unknown/violated evidence cannot be repaired by a later interval. */
export function mergeCoverageFacts(
  previous: Record<CoverageFact, EvidenceState>,
  next: Record<CoverageFact, EvidenceState>
): Record<CoverageFact, EvidenceState> {
  const before = factsSchema.safeParse(previous);
  const after = factsSchema.safeParse(next);
  if (!before.success || !after.success) throw new Error('invalid_coverage_input');
  const merged = before.data;
  for (const fact of factNames) {
    const a = before.data[fact];
    const b = after.data[fact];
    merged[fact] = a === 'violated' || b === 'violated' ? 'violated' : a === 'unknown' || b === 'unknown' ? 'unknown' : 'verified';
  }
  return merged;
}
