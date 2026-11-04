const areas: readonly (readonly [string, RegExp])[] = [
  ['ops', /^src\/(deletion|readiness|readiness-store)\.ts$/],
  [
    'core',
    /^src\/(canonical-json|protocol-store|assignment-contract|configuration-evidence|comparison-contracts|report-source-trust-contracts|external-session-contract|session-binding-contract|source-errors|source-compatibility|runtime-history|coverage|package-paths)\.ts$/
  ],
  ['entry', /^src\/(cli|cli-errors|index|.*-cli|.*-main)\.ts$/],
  ['web', /^src\/local-web-/],
  ['instrumented', /^src\/(?:instrumented-codex\/)?instrumented-codex-/],
  [
    'qualification',
    /^src\/(codex-qualification|codex-session-binding-qualification|codex-binding-qualification-versions|codex-workflow-qualification|claude-native-probe|claude-probe-|claude-minimal-run|claude-trace-candidate|binding-readiness-probe|codex-failure-diagnostics|external-session-claude-candidate)/
  ],
  ['harness', /^src\/harness-/],
  ['workflow', /^src\/config-confirmation-write\.ts$/],
  ['comparison', /^src\/(comparison|allocation|config-confirmation|reports\/|exchange\/)/],
  ['pricing', /^src\/(price|pricing|cost-coverage|catalog-cost|observed-cost|request-price|report-source-trust|metrics)/],
  ['connect', /^src\/(codex-connect|claude-connect|claude-process-binary|owned-cli-invocation)/],
  [
    'workflow',
    /^src\/(task-workflow|external-session-|codex-workflow-|claude-workflow-|nested-candidate|bounded-candidate|codex-candidate-|codex-continuation)/
  ],
  ['binding', /^src\/(session-binding-|ordinary-|binding-|codex-binding-admission|claude-binding-admission)/],
  ['sources', /^src\/(adapters|adapter-profiles|collection|codex-rollout-policy|otel-|managed-|source-compatibility|agent-metadata|cache-write-ttl)/],
  ['core', /^src\/(contracts|flexible-contracts|lifecycle|runtime-history|deletion|source-errors|readiness|store)/]
];

export const ranks: Readonly<Record<string, number>> = {
  ops: 6.5,
  core: 0,
  sources: 1,
  pricing: 2,
  binding: 3,
  connect: 3,
  workflow: 4,
  comparison: 5,
  harness: 5,
  instrumented: 5,
  qualification: 6,
  web: 7,
  entry: 8
};

export function area(path: string): string {
  return areas.find(([, pattern]) => pattern.test(path))?.[0] ?? 'UNMAPPED';
}
