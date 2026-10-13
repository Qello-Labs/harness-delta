import { z } from 'zod';

// The server validates each document against its production schema during review.
const document = z.record(z.string(), z.unknown());
export const SetupBundleSchema = z.strictObject({
  kind: z.literal('harness-delta.measurement-setup'),
  schema_version: z.literal(1),
  input: z.strictObject({
    comparison_path: z.string().min(1).max(4096),
    project_id: z.string().min(1),
    template_id: z.string().min(1).optional(),
    profile: document.optional(),
    protocol: document.optional(),
    variants: z.array(document).max(2).optional(),
    policy_status: z.strictObject({
      arm_a: z.enum(['eligible', 'ineligible']),
      arm_b: z.enum(['eligible', 'ineligible']),
    }).optional(),
    price_table: document.optional(),
    application_mode: z.enum(['selected_markdown_only', 'agent_applied']).optional(),
  }),
});
