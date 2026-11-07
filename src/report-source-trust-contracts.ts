import { z } from 'zod';
import { ProductVersionSchema, SourceCompatibilitySchema, TimestampSchema } from './contracts.js';

const sourceObservationFields = {
  event_count: z.number().int().positive(),
  first_observed_at: TimestampSchema.optional(),
  last_observed_at: TimestampSchema.optional()
};
/** Dependency-light report schema: pricing must not participate in schema initialization. */
export const ReportCompatibilitySchema = z.strictObject({
  verified_events: z.number().int().nonnegative(),
  compatibility_unverified_events: z.number().int().nonnegative(),
  legacy_unverified_events: z.number().int().nonnegative(),
  invalidated_events: z.number().int().nonnegative(),
  sources: z.array(
    z.union([
      SourceCompatibilitySchema.extend(sourceObservationFields),
      z.strictObject({
        state: z.enum(['legacy_unverified', 'invalidated']),
        product: z.enum(['codex', 'claude_code']),
        product_version: ProductVersionSchema,
        ...sourceObservationFields
      })
    ])
  )
});
