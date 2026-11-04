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

for (const name of ["harness-application-cleanup","harness-application-contract","harness-application-files","harness-application-launch","harness-application-restoration","harness-application-workspace","harness-config","harness-managed-file","instrumented-codex-accounting","instrumented-codex-build-identity","instrumented-codex-conformance","instrumented-codex-contracts","instrumented-codex-cost","instrumented-codex-descriptor","instrumented-codex-launcher","instrumented-codex-qualification","instrumented-codex-usage","observed-cost-coverage","price-catalog-online","price-catalog-release","price-catalog-task-report","price-catalog","price-revaluation","request-price-evidence"]) {
 for (const extension of ['js','js.map','d.ts','d.ts.map']) await rm(new URL(`../dist/${name}.${extension}`,import.meta.url),{force:true});
}
