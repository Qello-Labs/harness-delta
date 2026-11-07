import { z } from 'zod';

export const routes = ['file', 'codex_workflow', 'claude_workflow', 'codex_binding', 'claude_binding'];
export const operations = ['launch', 'link', 'collect', 'restart', 'resume'];
export const topologies = ['root', 'root_direct_child', 'bounded_family'];
// Imperative operation fences have no exported descriptor. Drift requires a fresh rule review.
export const scopeSourceDigests = Object.freeze({
  'src/codex-workflow-adapter.ts': '3c4eec6d607642a5f9f7a0e425ec83d1ce77531e4810939b6984b545b53d9bca',
  'src/claude-workflow-adapter.ts': '0d4b01e8c956d796e441ff8a3ab6d75e0de42e3d016160fef84ca985a41c027d',
  'src/session-binding-contract.ts': '03d02bed810f28bea45c0975dd81b1f906aa37b8ba0aef7647b7375f0a1c300b',
  'src/ordinary-session-binding.ts': 'c32a561ece892c2fbe58a5afafd49c00acc0ebdca2d1c26f71cf0c1e89d7160c',
  'src/session-binding-service.ts': '99b403b80e99790c6eaec771c1047a3826f4022e77a560aacec5c84e48deecf8',
  'src/claude-workflow-versions.ts': '2fdf54d333aa7d9ca8f298ad0757e85a2c2eed10472106a07387d36d7511bd3b',
  'src/session-binding-codex.ts': '099ae254af3f0823446140336056504755205ecbb451435dcf8c1db79d2955c4',
  'src/session-binding-claude.ts': 'd4116939cb735f15875e1c55efb852e7ddcd28e63771661312ce1d57b9904a8b',
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
