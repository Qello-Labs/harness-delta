import type { z } from 'zod';
export const routes: readonly ['file', 'codex_workflow', 'claude_workflow', 'codex_binding', 'claude_binding'];
export const operations: readonly ['launch', 'link', 'collect', 'restart', 'resume'];
export const topologies: readonly ['root', 'root_direct_child', 'bounded_family'];
export const scopeSourceDigests: Readonly<Record<string, string>>;
export const retiredClaudeWorkflowVersions: readonly ['2.1.288', '2.1.291'];
export const laneSchema: z.ZodObject<{
  product: z.ZodEnum<{ codex: 'codex'; claude_code: 'claude_code' }>;
  route: z.ZodEnum<{ file: 'file'; codex_workflow: 'codex_workflow'; claude_workflow: 'claude_workflow'; codex_binding: 'codex_binding'; claude_binding: 'claude_binding' }>;
  profile_id: z.ZodString;
  operation: z.ZodEnum<{ launch: 'launch'; link: 'link'; collect: 'collect'; restart: 'restart'; resume: 'resume' }>;
  topology: z.ZodEnum<{ root: 'root'; root_direct_child: 'root_direct_child'; bounded_family: 'bounded_family' }>;
}, z.core.$strict>;
export type Lane = z.infer<typeof laneSchema>;
export function laneKey(row: Lane): string;
export function sourceLanes(source: import('./source-snapshot.mjs').SourceRegistry): Lane[];
