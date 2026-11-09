import { z } from 'zod';

export const routes = ['file', 'codex_workflow', 'claude_workflow', 'codex_binding', 'claude_binding'];
export const operations = ['launch', 'link', 'collect', 'restart', 'resume'];
export const topologies = ['root', 'root_direct_child', 'bounded_family'];
// Imperative operation fences have no exported descriptor. Drift requires a fresh rule review.
export const scopeSourceDigests = Object.freeze({
  'src/codex-workflow-adapter.ts': '14044d27e6db4c930cf3ece93b14a77051c1b305be636fa90cbf9b8b68378041',
  'src/claude-workflow-adapter.ts': '344a6483aba255249ae59a7f53e0f8937ed60c79ce3767b85df1c188f5928ac4',
  'src/session-binding-contract.ts': 'e03e22939662cf03e85f7db126718d622adba3ea2d3d7047651ab61a5f437fb5',
  'src/ordinary-session-binding.ts': '8c617249257ebb584ba359dc812e23475c04f07a4f421a89bf4660ac50f8f12c',
  'src/session-binding-service.ts': '55cad8fa77f8ab59df50cab1458cdbb91ad1189aa9f9d4ac8f464ffe740e5148',
  'src/claude-workflow-versions.ts': '3a85ae4d57edd2897954502420e000d41fedcdf2b475e502c6453a50a8218937',
  'src/session-binding-codex.ts': '9f919685c6cbc4ad1654aed9e4c730b4109c7f5507b1981e1c564477f0c22d53',
  'src/session-binding-claude.ts': '39470353953fae64ad244f21cf4cc8e82c34b5574e62589ae06c291594a0f1a3',
});
export const laneSchema = z.strictObject({
  product: z.enum(['codex', 'claude_code']),
  route: z.enum(routes),
  profile_id: z.string().max(128).regex(/^(?:codex-file-(?:legacy|checkpoint)-v1|claude-file-message-components-v1|codex-workflow-(?:own-response|direct-child)-v1|claude-workflow-(?:own-trace|direct-child)-v1|codex-binding-[0-9]{5,27}-direct-family-v1|claude-binding-(?:[0-9]{5,27}|[0-9]{1,9}-[0-9]{1,9}-[0-9]{1,9})-family-v1|(?:codex|claude)-binding-root-window-v1)$/),
  operation: z.enum(operations),
  topology: z.enum(topologies),
});
export const laneKey = row => [row.product, row.route, row.profile_id, row.operation, row.topology].join(':');

export function sourceLanes({ windows, files, evidence, codexAdmissions, claudeAdmissions, ordinaryWindows = [] }) {
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
  for (const policy of ordinaryWindows)
    for (const operation of policy.operations)
      lanes.push(laneSchema.parse({ product: policy.product, route: policy.source, profile_id: policy.policyId, operation, topology: 'root' }));
  return lanes.sort((a, b) => laneKey(a).localeCompare(laneKey(b), 'en'));
}
