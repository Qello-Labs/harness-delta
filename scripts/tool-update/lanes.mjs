import { z } from 'zod';

export const routes = ['file', 'codex_workflow', 'claude_workflow', 'codex_binding', 'claude_binding'];
export const operations = ['launch', 'link', 'collect', 'restart', 'resume'];
export const topologies = ['root', 'root_direct_child', 'bounded_family'];
// Imperative operation fences have no exported descriptor. Drift requires a fresh rule review.
export const scopeSourceDigests = Object.freeze({
  'src/codex-workflow-adapter.ts': '1dc6552eb9d59f176bfbff3252d8902d63b92599c56c8aa23ba1c10dab3508d7',
  'src/claude-workflow-adapter.ts': '0d8314a3ae76357ab9b585fae4ad1f20b540666c478c1d0dac7bf0fc6b9ef93b',
  'src/session-binding-contract.ts': '4d21a5f6668d7d1356a45928386908921dc65d78fc81901036914e5ad42704a1',
  'src/ordinary-session-binding.ts': '02c56277732a0472d8a57c5d52131b8c4d6aa2fd93be4c9f24f79ecdc5b77fca',
  'src/session-binding-service.ts': '0254dd5e64832b5629244c16c86e6452ec9f20b8793561f5d3c05512930a0cfb',
  'src/claude-workflow-versions.ts': '2fdf54d333aa7d9ca8f298ad0757e85a2c2eed10472106a07387d36d7511bd3b',
  'src/session-binding-codex.ts': '02aa7a37de315e91fa401498f5075eb01a05ecea2e55ad2182014a426dd24c32',
  'src/session-binding-claude.ts': '79c9c7d25164bd225cb53330e27c5c8684fcc9ce182f8699b473353c03dc6957',
});
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
