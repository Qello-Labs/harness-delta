import { cp, rm } from "node:fs/promises";

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

// Remove exclusively retired generated assets when rebuilding an existing checkout.
for (const name of ['app-server','approvals','budget','codex','confinement','execution','native-probe','native-profile','owner-journal','receipts','runner']) {
 for (const extension of ['js','js.map','d.ts','d.ts.map']) await rm(new URL(`../dist/harness-application-${name}.${extension}`,import.meta.url),{force:true});
}
await rm(new URL('../dist/native/',import.meta.url),{recursive:true,force:true});

for (const name of ["allocation","binding-readiness-probe","claude-minimal-run","claude-probe-coordinator","claude-probe-gateway","claude-probe-hook-mediator","claude-trace-candidate-receiver","codex-binding-qualification-versions","codex-failure-diagnostics","codex-qualification","codex-session-binding-qualification","codex-workflow-qualification","config-confirmation-write","exchange/cli","exchange/contracts","exchange/deletion","exchange/files","exchange/identity","exchange/import","exchange/invalidation","exchange/mapping","exchange/retention","exchange/source","external-session-claude-candidate","harness-application-cleanup","harness-application-contract","harness-application-files","harness-application-launch","harness-application-restoration","harness-application-workspace","harness-config","harness-managed-file","instrumented-codex-accounting","instrumented-codex-build-identity","instrumented-codex-conformance","instrumented-codex-contracts","instrumented-codex-cost","instrumented-codex-descriptor","instrumented-codex-launcher","instrumented-codex-qualification","instrumented-codex-usage","observed-cost-coverage","price-catalog-online","price-catalog-release","price-catalog-task-report","price-catalog","price-revaluation","reports/comparison-contracts","reports/comparison-invalidation","reports/comparison-readable","reports/comparison-render","reports/comparison-snapshot","reports/comparison-summary","reports/comparison-task","reports/comparison","reports/flexible-comparison","reports/flexible-team","reports/ordinary-task","reports/period","reports/render","reports/team-contracts","reports/team-render","reports/team-snapshot","request-price-evidence"]) {
 for (const extension of ['js','js.map','d.ts','d.ts.map']) await rm(new URL(`../dist/${name}.${extension}`,import.meta.url),{force:true});
}
