import type { PromotionEvidenceClass, PromotionGateId, PromotionReason, PromotionState } from './promotion-records.mjs';
export type PromotionCapabilityState = Exclude<PromotionState, 'review_needed'> | 'not_requested';
export interface PromotionGateResult {
  readonly gate_id: PromotionGateId;
  readonly result: 'pass' | 'fail' | 'unknown';
  readonly state: Exclude<PromotionState, 'review_needed'>;
  readonly pending_classes: readonly PromotionEvidenceClass[];
}
export interface PromotionGateReduction {
  readonly authority: 'none';
  readonly state: PromotionState;
  readonly admission: PromotionCapabilityState;
  readonly qualification: PromotionCapabilityState;
  readonly children: PromotionCapabilityState;
  readonly gates: readonly PromotionGateResult[];
  readonly reasons: readonly PromotionReason[];
}
export function reducePromotionGates(input: unknown): PromotionGateReduction;
