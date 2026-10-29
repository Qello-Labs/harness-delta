import { z } from 'zod';

export const routes = ['file', 'codex_workflow', 'claude_workflow', 'codex_binding', 'claude_binding'];
export const operations = ['launch', 'link', 'collect', 'restart', 'resume'];
export const topologies = ['root', 'root_direct_child', 'bounded_family'];
// Imperative operation fences have no exported descriptor. Drift requires a fresh rule review.
export const scopeSourceDigests = Object.freeze({
  'src/codex-workflow-adapter.ts': '7f52a234a3a5ddb462c98e39c3335d2981744d954c75f89d9977db447df48104',
  'src/claude-workflow-adapter.ts': '8dbd7aa4f64f277c5b6372cf0f596cc88e10093a2bf6b4a8cd773701e272bf2a',
  'src/session-binding-contract.ts': '003d15592f34aa377d777fd730986e74ceff37b9db529f53c57a99af653c3b13',
  'src/ordinary-session-binding.ts': '850b5144be17b0327b5f2c4cd04f348cd6cf90cc6ddbe54239de6c554bda0099',
  'src/session-binding-service.ts': 'b17352f8936406f76e45e8a9be028fd0f14b66055d4a3cb9813f56a16bd71c85',
  'src/claude-workflow-versions.ts': 'bfb41c173c161823ce8b851bf38807e0c27fb177023dac6b41838534d68c5239',
  'src/session-binding-codex.ts': '9f3c955912b7b75b5d4bfaea453d84f004cc7090d9818b3bf180f930a764f8f8',
  'src/session-binding-claude.ts': '5165b416cc6e58010b1cbbb39ff9d07fc7b5870418b1e7f8025e1ddea3898729',
});
export const retiredClaudeWorkflowVersions = ['2.1.288', '2.1.291'];
export const laneSchema = z.strictObject({
  product: z.enum(['codex', 'claude_code']),
  route: z.enum(routes),
  profile_id: z.string().max(128).regex(/^(?:codex-file-(?:legacy|checkpoint)-v1|claude-file-message-components-v1|codex-workflow-(?:own-response|direct-child)-v1|claude-workflow-(?:own-trace|direct-child)-v1|codex-binding-[0-9]{5,27}-direct-family-v1|claude-binding-(?:[0-9]{5,27}|[0-9]{1,9}-[0-9]{1,9}-[0-9]{1,9})-family-v1)$/),
  operation: z.enum(operations),
  topology: z.enum(topologies),
});
export const laneKey = row => [row.product, row.route, row.profile_id, row.operation, row.topology].join(':');

export function sourceLanes({ windows, files, evidence, codexAdmissions, claudeAdmissions }) {
  const profiles = new Map();
  const add = (product, route, profile_id) => profiles.set(`${product}:${route}:${profile_id}`, { product, route, profile_id });
  for (const row of windows) add(row.product, row.source, row.profile_id);
  for (const row of files) add(row.product, 'file', row.product === 'codex'
    ? `codex-file-${row.boundaryMode === 'legacy' ? 'legacy' : 'checkpoint'}-v1` : 'claude-file-message-components-v1');
  for (const row of evidence.filter(row => row.profile_id.includes('-workflow-')))
    add(row.product, row.product === 'codex' ? 'codex_workflow' : 'claude_workflow', row.profile_id);
  for (const row of codexAdmissions) add('codex', 'codex_binding', row.profileId);
  for (const row of claudeAdmissions) add('claude_code', 'claude_binding', row.profileId);
  const lanes = [];
  for (const row of profiles.values()) {
    const binding = row.route.endsWith('_binding');
    const child = row.profile_id.includes('-direct-child-');
    const ops = row.route === 'file' ? ['collect', 'restart'] : binding ? ['link', 'collect', 'restart', 'resume']
      : row.route === 'codex_workflow' ? ['launch', 'link', 'collect', 'resume'] : ['launch', 'resume'];
    for (const topology of binding ? ['root', 'bounded_family'] : [child ? 'root_direct_child' : 'root'])
      for (const operation of ops) lanes.push(laneSchema.parse({ ...row, topology, operation }));
  }
  return lanes.sort((a, b) => laneKey(a).localeCompare(laneKey(b), 'en'));
}
