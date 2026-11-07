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
  "src/sources/adapters-flexible.ts": 93,
  "src/sources/adapters.ts": 97,
  "src/comparison/allocation.ts": 63,
  "src/connect/claude-connect-installation.ts": 48,
  "src/qualification/claude-native-probe.ts": 73,
  "src/qualification/claude-probe-coordinator.ts": 52,
  "src/qualification/claude-trace-candidate.ts": 49,
  "src/codex-candidate-rollout.ts": 57,
  "src/connect/codex-connect-installation.ts": 64,
  "src/qualification/codex-qualification.ts": 69,
  "src/qualification/codex-session-binding-qualification.ts": 76,
  "src/codex-workflow-adapter.ts": 186,
  "src/qualification/codex-workflow-qualification.ts": 58,
  "src/sources/collection.ts": 72,
  "src/comparison/comparison.ts": 31,
  "src/comparison/exchange/identity.ts": 67,
  "src/comparison/exchange/import.ts": 42,
  "src/instrumented-codex/instrumented-codex-accounting.ts": 60,
  "src/instrumented-codex/instrumented-codex-conformance.ts": 33,
  "src/instrumented-codex/instrumented-codex-cost.ts": 78,
  "src/instrumented-codex/instrumented-codex-launcher.ts": 40,
  "src/web/local-web-server.ts": 38,
  "src/web/local-web-setup-review.ts": 31,
  "src/pricing/metrics.ts": 37,
  "src/nested-candidate.ts": 51,
  "src/ordinary-session-binding.ts": 48,
  "src/sources/otel-journal.ts": 37,
  "src/sources/otel-projection.ts": 33,
  "src/pricing/price-catalog.ts": 50,
  "src/pricing/pricing.ts": 55,
  "src/comparison/reports/comparison-task.ts": 33,
  "src/comparison/reports/flexible-comparison.ts": 41,
  "src/session-binding-claude.ts": 96,
  "src/session-binding-codex.ts": 76,
  "src/session-binding-service.ts": 48,
  "src/store.ts": 37,
  "src/workflow/task-workflow.ts": 33,
  "tests/qualification/codex-session-binding-qualification.test.ts": 51,
  "tests/helpers/analysis-oracle.ts": 32
};

// Keep existing functions bounded while new files use 150 normalized lines.
const functionLineLimits = {
  "scripts/tool-update/claude-localhost.mjs": 189,
  "src/sources/adapters-flexible.ts": 172,
  "src/sources/adapters.ts": 162,
  "src/sources/collection.ts": 154,
  "src/pricing/metrics.ts": 154,
  "src/qualification/claude-native-probe.ts": 225,
  "src/qualification/claude-probe-gateway.ts": 186,
  "src/qualification/claude-probe-supervisor.ts": 213,
  "src/qualification/claude-trace-candidate.ts": 158,
  "src/cli.ts": 195,
  "src/claude-workflow-adapter.ts": 256,
  "src/session-binding-claude.ts": 207,
  "src/connect/codex-connect-installation.ts": 158,
  "src/qualification/codex-qualification.ts": 585,
  "src/qualification/codex-session-binding-qualification.ts": 464,
  "src/codex-workflow-adapter.ts": 998,
  "src/qualification/codex-workflow-qualification.ts": 218,
  "src/comparison/exchange/source.ts": 239,
  "src/instrumented-codex/instrumented-codex-accounting.ts": 186,
  "src/instrumented-codex/instrumented-codex-conformance.ts": 429,
  "src/instrumented-codex/instrumented-codex-cost.ts": 200,
  "src/instrumented-codex/instrumented-codex-launcher.ts": 252,
  "src/instrumented-codex/instrumented-codex-qualification.ts": 164,
  "src/web/local-web-codex.ts": 165,
  "src/web/local-web-server.ts": 276,
  "src/web/local-web-setup-review.ts": 208,
  "src/web/local-web-shared.ts": 237,
  "src/ordinary-session-binding.ts": 871,
  "src/comparison/reports/comparison-readable.ts": 225,
  "src/comparison/reports/flexible-comparison.ts": 201,
  "src/session-binding-service.ts": 834,
  "tests/claude-human-pilot.test.ts": 158,
  "tests/claude-ordinary-provider.test.ts": 445,
  "tests/codex-connection-setup-http.test.ts": 253,
  "tests/qualification/codex-session-binding-qualification.test.ts": 300,
  "tests/helpers/codex-qualification-fixture.ts": 243,
  "tests/helpers/collection-fixture.ts": 160,
  "tests/helpers/ordinary-session-binding-fixture.ts": 240,
  "tests/helpers/team-fixture.ts": 154,
  "tests/web/local-web-domain.test.ts": 201,
  "tests/minimal-diagnostic-runner.test.ts": 229,
  "tests/minimal-diagnostic.test.ts": 168,
  "tests/ordinary-observation-http.test.ts": 445,
  "tests/session-binding-api.test.ts": 161,
  "tests/session-binding-application-pilot.test.ts": 213,
  "tests/session-binding-claude-api.test.ts": 164,
  "tests/session-binding-claude.test.ts": 324,
  "tests/session-continuation-cli.test.ts": 155,
  "tests/tool-update-conformance-lifecycle.test.ts": 232
};

export default defineConfig(
  globalIgnores(["node_modules/", "dist/", "coverage/", ".harness-delta/", ".superpowers/", ".husky/_/", ".agents/skills/", "ui/"]),
  {
    rules: {
      complexity: ["error", 30],
      "max-lines-per-function": ["error", { max: 150, skipBlankLines: true, skipComments: true, IIFEs: true }]
    }
  },
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
  })),
  ...Object.entries(functionLineLimits).map(([file, maximum]) => ({
    files: [file],
    rules: { "max-lines-per-function": ["error", { max: maximum, skipBlankLines: true, skipComments: true, IIFEs: true }] }
  }))
);
