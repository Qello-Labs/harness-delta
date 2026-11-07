import { z } from 'zod';

// Display metadata is optional and never an identity or usage attribution key.
const nameSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[^\p{Cc}\p{Cf}]+$/u);
export const AgentMetadataSchema = z.discriminatedUnion('source', [
  z.strictObject({ source: z.literal('codex_session_meta'), nickname: nameSchema.nullable(), role: nameSchema.nullable() }),
  z.strictObject({ source: z.literal('claude_hook'), agentType: nameSchema })
]);
export type AgentMetadata = z.infer<typeof AgentMetadataSchema>;
export function metadataName(value: unknown): string | null {
  const parsed = nameSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
export function claudeAgentMetadata(value: unknown): AgentMetadata | undefined {
  const agentType = metadataName(value);
  return agentType === null ? undefined : { source: 'claude_hook', agentType };
}
