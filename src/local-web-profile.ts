import { z } from 'zod';
import { CodexWorkflowExecutionSchema } from './codex-workflow-adapter.js';
import { ExternalTaskSetupSchema } from './external-session-service.js';
import { SharedBindingSchema } from './local-web-shared-guard.js';

const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/);
const executionFields = CodexWorkflowExecutionSchema.shape;
/** Existing reviewed inputs only. No protocol, pricing or criterion defaults are invented here. */
export const LocalWebProfileSchema = z.strictObject({
  id: identifier,
  name: z.string().trim().min(1).max(200),
  setup: ExternalTaskSetupSchema,
  execution: z.strictObject({
    binary: executionFields.binary,
    codex_home: executionFields.codex_home,
    hook_recorder: executionFields.hook_recorder,
    sandbox: executionFields.sandbox,
    timeout_ms: executionFields.timeout_ms,
    poll_ms: executionFields.poll_ms
  }),
  shared_binding: SharedBindingSchema.optional(),
  session_binding: z
    .discriminatedUnion('product', [
      z.strictObject({
        product: z.literal('codex'),
        receipt_directory: z.string().min(1),
        source_roots: z.array(z.string().min(1)).min(1).max(16),
        project_root: z.string().min(1)
      }),
      z.strictObject({ product: z.literal('claude_code'), receipt_directory: z.string().min(1), claude_projects_directory: z.string().min(1) })
    ])
    .optional()
});
export const LocalWebManifestSchema = z.strictObject({ schema_version: z.literal(1), profiles: z.array(LocalWebProfileSchema).max(64) });
export type LocalWebProfile = z.infer<typeof LocalWebProfileSchema>;
