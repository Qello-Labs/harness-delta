import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

// Lower these limits as existing functions shrink; new files use 30.
const complexityLimits = {
  "scripts/claude-readiness-capture.mjs": 55,
  "scripts/conformance/admission.ts": 33,
  "scripts/conformance/catalog.ts": 31,
  "scripts/conformance/minimal-diagnostic.ts": 46,
  "scripts/conformance/parse-candidate.ts": 72,
  "scripts/tool-update/assessment.mjs": 79,
  "scripts/tool-update/discovery-transport.mjs": 52,
  "scripts/tool-update/discovery.mjs": 39,
  "scripts/tool-update/source-snapshot.mjs": 31,
  "skills/harness-connect/scripts/connect.mjs": 114,
  "src/adapters-flexible.ts": 93,
  "src/adapters.ts": 97,
  "src/allocation.ts": 63,
  "src/claude-connect-installation.ts": 48,
  "src/claude-native-probe.ts": 73,
  "src/claude-probe-coordinator.ts": 52,
  "src/claude-trace-candidate.ts": 49,
  "src/codex-candidate-rollout.ts": 57,
  "src/codex-connect-installation.ts": 64,
  "src/codex-qualification.ts": 69,
  "src/codex-session-binding-qualification.ts": 76,
  "src/codex-workflow-adapter.ts": 186,
  "src/codex-workflow-qualification.ts": 58,
  "src/collection.ts": 72,
  "src/comparison.ts": 31,
  "src/config-confirmation.ts": 45,
  "src/exchange/identity.ts": 67,
  "src/exchange/import.ts": 42,
  "src/instrumented-codex-accounting.ts": 60,
  "src/instrumented-codex-conformance.ts": 33,
  "src/instrumented-codex-cost.ts": 78,
  "src/instrumented-codex-launcher.ts": 40,
  "src/local-web-domain.ts": 165,
  "src/local-web-server.ts": 38,
  "src/local-web-setup-review.ts": 31,
  "src/metrics.ts": 37,
  "src/nested-candidate.ts": 51,
  "src/ordinary-session-binding.ts": 48,
  "src/otel-journal.ts": 37,
  "src/otel-projection.ts": 33,
  "src/price-catalog.ts": 50,
  "src/pricing.ts": 55,
  "src/reports/comparison-task.ts": 33,
  "src/reports/flexible-comparison.ts": 41,
  "src/session-binding-claude.ts": 96,
  "src/session-binding-codex.ts": 76,
  "src/session-binding-service.ts": 48,
  "src/store.ts": 37,
  "src/task-workflow.ts": 33,
  "tests/codex-session-binding-qualification.test.ts": 51,
  "tests/helpers/analysis-oracle.ts": 32
};

export default defineConfig(
  globalIgnores(["node_modules/", "dist/", "coverage/", ".harness-delta/", ".superpowers/", ".husky/_/", ".agents/skills/", "ui/"]),
  { rules: { complexity: ["error", 30] } },
  {
    files: ["**/*.{js,mjs,cjs}"],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node }
  },
  {
    files: ["**/*.ts"],
    extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    }
  },
  ...Object.entries(complexityLimits).map(([file, maximum]) => ({
    files: [file],
    rules: { complexity: ["error", maximum] }
  }))
);
