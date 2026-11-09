import { z } from 'zod';
import { assertPromotionPins, promotedInputs, requireCondition } from './fixtures.mjs';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const fields = {
  kind: z.literal('promotion_execution_pins'),
  schema_version: z.literal(1),
  pin_scheme_revision: z.literal('promotion-execution-v1'),
  execution_mode: z.enum(['source', 'built']),
  pins: z.strictObject({
    runtime: digest,
    source: digest,
    build: digest,
    instrument: digest,
    skill: digest,
    producer: digest,
    built_skill: digest,
    built_producer: digest,
    lockfile: digest,
    package: digest
  })
};
export const promotionExecutionPinsSchema = z.discriminatedUnion('product', [
  z.strictObject({
    ...fields,
    product: z.literal('codex'),
    bundle_revision: z.literal(promotedInputs.codex.bundleRevision)
  }),
  z.strictObject({
    ...fields,
    product: z.literal('claude_code'),
    bundle_revision: z.literal(promotedInputs.claude_code.bundleRevision)
  })
]);

// Equality pins do not grant permission to install, execute, or collect.
export function validatePromotionExecutionPins(input, options = {}) {
  const parsed = promotionExecutionPinsSchema.safeParse(input);
  requireCondition(parsed.success, 'approval_invalid');
  const packet = parsed.data;
  assertPromotionPins(
    packet.pins,
    {
      product: packet.product,
      executionMode: packet.execution_mode,
      pinSchemeRevision: packet.pin_scheme_revision,
      bundleRevision: packet.bundle_revision
    },
    options
  );
  return packet;
}
