import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { codexRolloutPolicy } from '../../src/codex-rollout-policy.js';
import type { ConformanceCandidate } from './candidate.js';
import type { EvidenceIdentity } from './admission.js';

// Application implementation only. Never hash a rollout, native content, or user configuration.
// Registration data is excluded so adding a passing admission cannot invalidate itself.
export const evidenceSources = [
	"src/core/tool-version-profiles.ts",
	"src/core/tool-version-profiles.json",
	"src/core/tool-version-recipes.json",
	"src/core/tool-version-identities.json",
	"src/core/tool-version-promotion.ts",
	"src/core/tool-version-promotion-store.ts",
	"src/core/tool-version-promotions.json",
	"src/core/tool-version-promotion-result.json",
	"src/adapter-profiles.ts",
	"src/sources/collection.ts",
	"src/core/lifecycle.ts",
	"src/pricing/metrics.ts",
	"src/store.ts",
	"src/source-compatibility.ts",
	"src/core/ordinary-window-policy.ts",
	"src/migrations/036_ordinary_window_observation.sql",
	"src/migrations/037_ordinary_window_decisions.sql",
	"src/migrations/038_tool_version_promotion_denials.sql",
	"src/pricing/catalog-cost-report.ts",
	"src/workflow/codex-workflow-journal.ts",
	"src/core/canonical-json.ts",
	"src/core/ordinary-window-activation.ts",
	"src/core/ordinary-window-decision.ts",
	"src/core/ordinary-window-evidence.ts",
	"src/core/ordinary-window-store.ts",
	"src/core/ordinary-window-trial.ts",
	"src/pricing/observed-cost-report.ts",
	"src/pricing/price-catalog-store.ts",
	"src/pricing/metrics-ordinary-window.ts",
	"src/pricing/observed-cost-coverage.ts",
	"src/pricing/price-catalog.ts",
	"scripts/conformance/register.ts",
	"scripts/conformance-command.mjs",
	"scripts/conformance/tsconfig.json",
	"src/sources/adapters.ts",
	"src/codex-rollout-policy.ts",
	"src/contracts.ts",
	"scripts/conformance/candidate.ts",
	"scripts/conformance/parse-candidate.ts",
	"scripts/conformance/catalog.ts",
	"scripts/conformance/checks.ts",
	"scripts/conformance/report.ts",
	"scripts/conformance/investigate.ts",
	"scripts/conformance/admission.ts",
	"scripts/conformance/evidence.ts",
	"scripts/conformance/live.ts",
	"scripts/conformance/runner.ts",
	"scripts/conformance/confirm.ts",
	"scripts/conformance/exec-stream.ts",
	"scripts/conformance/filename.ts",
	"scripts/conformance/hook.ts",
	"scripts/conformance/hook-listener.ts",
	"scripts/conformance/session-start-recorder.mjs",
] as const;
export function evidenceIdentity(root: string, candidate: ConformanceCandidate): EvidenceIdentity {
  const hash = createHash('sha256');
  for (const path of evidenceSources) hash.update(path).update('\0').update(readFileSync(join(root, path))).update('\0');
  return { policyRevision: codexRolloutPolicy.revision, implementationDigest: hash.digest('hex'), sourceRef: candidate.sourceRef, previousVersion: candidate.previousVersion };
}
