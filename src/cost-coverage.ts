import { parseComparison } from './comparison-contracts.js';
import { CostCoverageEvidenceSchema, CostFactsSchema, type CostCoverageEvidence, type CostCoverageDecision } from './flexible-contracts.js';
export const syntheticCostProfileId = 'synthetic-cost-coverage-v1';
export const productionCostProfiles: readonly string[] = Object.freeze([]);
export function evaluateCostCoverage(input: CostCoverageEvidence): CostCoverageDecision {
  const evidence = parseComparison(CostCoverageEvidenceSchema, input, 'invalid_cost_coverage');
  const reasons: CostCoverageDecision['reasons'] = [];
  if (evidence.profile_id !== syntheticCostProfileId) reasons.push('unsupported_profile');
  for (const fact of CostFactsSchema.keyof().options) if (evidence.facts[fact] !== 'verified') reasons.push(fact);
  if (!evidence.has_observed_value) reasons.push('missing_value');
  return { eligible: reasons.length === 0, reasons: reasons.sort() };
}
export function mergeCostFacts(previous: CostCoverageEvidence['facts'], next: CostCoverageEvidence['facts']): CostCoverageEvidence['facts'] {
  const before = parseComparison(CostFactsSchema, previous, 'invalid_cost_coverage');
  const after = parseComparison(CostFactsSchema, next, 'invalid_cost_coverage');
  for (const fact of CostFactsSchema.keyof().options)
    before[fact] =
      before[fact] === 'violated' || after[fact] === 'violated' ? 'violated' : before[fact] === 'unknown' || after[fact] === 'unknown' ? 'unknown' : 'verified';
  return before;
}
