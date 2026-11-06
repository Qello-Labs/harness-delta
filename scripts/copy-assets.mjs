import { cp, mkdir, rm } from "node:fs/promises";

await cp(
  new URL("../src/migrations/", import.meta.url),
  new URL("../dist/migrations/", import.meta.url),
  { recursive: true, filter: (source) => !source.endsWith(".gitkeep") },
);

await cp(
  new URL("../config/prices/catalogs/", import.meta.url),
  new URL("../dist/catalogs/", import.meta.url),
  { recursive: true },
);

await cp(new URL('../skills/',import.meta.url),new URL('../dist/skills/',import.meta.url),{recursive:true});

await mkdir(new URL('../dist/assets/', import.meta.url), { recursive: true });
await cp(new URL('./session-binding-codex-hook.mjs', import.meta.url), new URL('../dist/assets/session-binding-codex-hook.mjs', import.meta.url));
await cp(new URL('./generated/current-support.json', import.meta.url), new URL('../dist/assets/current-support.json', import.meta.url));

// Remove exclusively retired generated assets when rebuilding an existing checkout.
await rm(new URL('../dist/flexible-candidates.json', import.meta.url), { force: true });
for (const name of ['app-server','approvals','budget','codex','confinement','execution','native-probe','native-profile','owner-journal','receipts','runner']) {
 for (const extension of ['js','js.map','d.ts','d.ts.map']) await rm(new URL(`../dist/harness-application-${name}.${extension}`,import.meta.url),{force:true});
}
await rm(new URL('../dist/native/',import.meta.url),{recursive:true,force:true});

for (const name of ["pricing/price-revaluation","harness/harness-managed-file","qualification/codex-failure-diagnostics","allocation","assignment-contract","binding-readiness-probe","bounded-candidate-invocation","canonical-json","claude-connect-installation","claude-connect-readiness","claude-minimal-run","claude-probe-coordinator","claude-probe-gateway","claude-probe-hook-mediator","claude-trace-candidate-receiver","cli-errors","codex-binding-qualification-versions","codex-connect-installation","codex-failure-diagnostics","codex-qualification","codex-session-binding-qualification","codex-workflow-qualification","comparison-cli","config-confirmation-write","configuration-evidence","coverage","exchange/cli","exchange/contracts","exchange/deletion","exchange/files","exchange/identity","exchange/import","exchange/invalidation","exchange/mapping","exchange/retention","exchange/source","external-session-claude-candidate","external-session-cli","harness-application-cleanup","harness-application-cli","harness-application-contract","harness-application-files","harness-application-launch","harness-application-restoration","harness-application-workspace","harness-config-main","harness-config","harness-managed-file","instrumented-codex-accounting","instrumented-codex-build-identity","instrumented-codex-cli","instrumented-codex-conformance","instrumented-codex-contracts","instrumented-codex-cost","instrumented-codex-descriptor","instrumented-codex-launcher","instrumented-codex-qualification","instrumented-codex-usage","local-web-codex","local-web-domain","local-web-main","local-web-metadata","local-web-ordinary","local-web-profile","local-web-recruitment","local-web-server","local-web-setup-review","local-web-shared-guard","local-web-shared","local-web-task-application","local-web-task-errors","managed-observation","managed-protocol","observed-cost-coverage","otel-launch-settings","otel-projection","otel-receiver","owned-cli-invocation","price-catalog-cli","price-catalog-online","price-catalog-release","price-catalog-task-report","price-catalog","price-revaluation","pricing-cli","protocol-store","reports/comparison-contracts","reports/comparison-invalidation","reports/comparison-readable","reports/comparison-render","reports/comparison-snapshot","reports/comparison-summary","reports/comparison-task","reports/comparison","reports/flexible-comparison","reports/flexible-team","reports/ordinary-task","reports/period","reports/render","reports/team-contracts","reports/team-render","reports/team-snapshot","request-price-evidence","source-compatibility-cli","store-metadata-cleanup","task-workflow-cli"]) {
 for (const extension of ['js','js.map','d.ts','d.ts.map']) await rm(new URL(`../dist/${name}.${extension}`,import.meta.url),{force:true});
}
