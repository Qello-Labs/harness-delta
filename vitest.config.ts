import { defineConfig } from "vitest/config";

const processBudgetTests = [
  "tests/owned-cli-invocation.test.ts",
  "tests/codex-session-binding-qualification.test.ts",
  "tests/codex-workflow-adapter.test.ts",
  "tests/codex-workflow-native-child.test.ts",
  "tests/minimal-diagnostic-runner.test.ts",
  "tests/claude-minimal-run.test.ts",
  "tests/harness/harness-application-results.test.ts",
  "tests/harness/harness-application-restoration.test.ts",
  "tests/harness/harness-application-restoration-cli.test.ts",
  "tests/harness/harness-application-restoration-safety.test.ts",
  "tests/instrumented-codex/instrumented-codex-qualification.test.ts",
  "tests/tool-update-conformance.test.ts",
  "tests/tool-update-conformance-lifecycle.test.ts"
];

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    projects: [
      {
        extends: false,
        test: {
          name: "process-budget",
          environment: "node",
          include: processBudgetTests,
          fileParallelism: false,
          sequence: { groupOrder: 1 }
        }
      },
      {
        extends: false,
        resolve: { alias: { "@": new URL("./ui/src", import.meta.url).pathname } },
        test: {
          name: "default",
          environment: "node",
          include: ["tests/**/*.test.ts", "ui/src/**/*.test.ts"],
          exclude: processBudgetTests,
          sequence: { groupOrder: 2 }
        }
      }
    ]
  }
});
