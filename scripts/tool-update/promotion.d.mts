import type { z } from 'zod';
import type { PromotionProposal, PromotionScope } from './promotion-records.mjs';
import type { laneSchema } from './lanes.mjs';
import type { ContractId, Facet } from './difference-contracts.mjs';
import type { ToolUpdateResult } from '../tool-update.mjs';

export interface PromotionCoverageMapping {
  readonly schema_version: 1;
  readonly kind: 'promotion_coverage_mapping';
  readonly original_lane: z.infer<typeof laneSchema>;
  readonly scope: PromotionScope;
  readonly descriptor_digest: string;
  readonly review_reference: string;
  readonly contracts: readonly ContractId[];
  readonly facets: readonly Facet[];
}
export interface PromotionDescriptorSuccessor {
  readonly schema_version: 1;
  readonly kind: 'promotion_descriptor_successor';
  readonly predecessor_descriptor_digest: string;
  readonly successor_descriptor_digest: string;
  readonly predecessor_proposal_id: string;
  readonly successor_proposal_id: string;
  readonly coverage_mapping_ids: readonly string[];
  readonly review_reference: string;
}
export const promotionCoverageMappingSchema: z.ZodType<PromotionCoverageMapping>;
export const promotionDescriptorSuccessorSchema: z.ZodType<PromotionDescriptorSuccessor>;
export function preparePromotion(path: string, root: string): Promise<PromotionProposal>;
export function reconcilePromotion(path: string, root: string): Promise<{
  readonly proposals: readonly PromotionProposal[];
  readonly input_ids: readonly string[];
  readonly unused_ids: readonly string[];
}>;
export function runPromotionCommand(
  name: string, flags: { readonly input: string; readonly out: string }, root: string
): Promise<ToolUpdateResult>;
