import { z } from 'zod';

export const routes = ['file', 'codex_workflow', 'claude_workflow', 'codex_binding', 'claude_binding'];
export const operations = ['launch', 'link', 'collect', 'restart', 'resume'];
export const topologies = ['root', 'root_direct_child', 'bounded_family'];
// Imperative operation fences have no exported descriptor. Drift requires a fresh rule review.
export const scopeSourceDigests = Object.freeze({
  'src/codex-workflow-adapter.ts': '14044d27e6db4c930cf3ece93b14a77051c1b305be636fa90cbf9b8b68378041',
  'src/claude-workflow-adapter.ts': '344a6483aba255249ae59a7f53e0f8937ed60c79ce3767b85df1c188f5928ac4',
  'src/session-binding-contract.ts': 'c01de8b3c48c6a7db75247771031160a5f06745ad53c29323a658e9ef10e1454',
  'src/ordinary-session-binding.ts': '34f59f9b76ebaa37eab0ecbdfd3fae5247e29739b2132758561cf1526b974085',
  'src/session-binding-service.ts': '4b49f8e7dc1c4a7554493577bff35331d2b634d1c6d62e631722462c475c1176',
  'src/claude-workflow-versions.ts': '3a85ae4d57edd2897954502420e000d41fedcdf2b475e502c6453a50a8218937',
  'src/session-binding-codex.ts': '02ea06202c7d63a7819e0c6a4ebdd3137bf4886bcaab34c6e36a137b4feb5ef3',
  'src/session-binding-claude.ts': '12f4e061999ec344629d9fdd3a91853f987332949284f33cfb3de1f6030c68b0',
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
