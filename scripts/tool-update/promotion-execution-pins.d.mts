import type { z } from 'zod';
import type { PromotionPinOptions, PromotionPins } from './fixtures.mjs';

interface PromotionExecutionPinFields {
  readonly kind: 'promotion_execution_pins';
  readonly schema_version: 1;
  readonly pin_scheme_revision: 'promotion-execution-v1';
  readonly execution_mode: 'source' | 'built';
  readonly pins: PromotionPins;
}
export type PromotionExecutionPins = PromotionExecutionPinFields &
  (
    | { readonly product: 'codex'; readonly bundle_revision: 'codex-promoted-bundle-v1' }
    | { readonly product: 'claude_code'; readonly bundle_revision: 'claude-promoted-bundle-v1' }
  );
export const promotionExecutionPinsSchema: z.ZodType<PromotionExecutionPins>;
export function validatePromotionExecutionPins(input: unknown, options?: PromotionPinOptions): PromotionExecutionPins;
