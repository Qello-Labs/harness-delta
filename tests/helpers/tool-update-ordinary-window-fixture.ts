import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assessmentSchema, consumedContracts } from '../../scripts/tool-update/assessment.mjs';
import type { ContractReview } from '../../scripts/tool-update/assessment.mjs';
import type { Candidate, Observation, Product } from '../../scripts/tool-update/discovery.mjs';
import { digest } from '../../scripts/tool-update/manifest.mjs';
import { legacySourcePathAllowlist, policySourcePathAllowlist } from '../../scripts/tool-update/source-snapshot.mjs';

export const assessmentRoot = realpathSync(fileURLToPath(new URL('../..', import.meta.url)));

export function frozenAssessmentFixture(product: Product, reviewed = false, rootPolicy = false) {
  const codex = product === 'codex';
  const base = rootPolicy ? (codex ? '0.163.0' : '2.1.306') : '0.158.0';
  const target = codex ? '0.166.0' : '2.1.307';
  const profile = `${codex ? 'codex' : 'claude'}-binding-root-window-v1`;
  const revision = `${codex ? 'codex' : 'claude'}-ordinary-root-window-v1`;
  const route = codex ? 'codex_binding' : 'claude_binding';
  return assessmentSchema.parse({
    schema_version: rootPolicy ? (reviewed ? 6 : 5) : 1,
    kind: 'assessment',
    candidate_id: 'a'.repeat(64),
    observation_id: 'b'.repeat(64),
    baseline_digest: null,
    source_digest: 'c'.repeat(64),
    source_paths: rootPolicy ? policySourcePathAllowlist : legacySourcePathAllowlist,
    rule_revision: rootPolicy ? 'static-assessment-v3' : 'static-assessment-v1',
    ...(rootPolicy ? { inventory_scope: 'legacy_full_inventory' } : {}),
    ...(reviewed ? { review_ids: ['d'.repeat(64)], unused_review_ids: ['d'.repeat(64)] } : {}),
    review_sources: [
      { version: base, commit: 'e'.repeat(40), path: codex ? 'codex-rs/protocol/src/protocol.rs' : 'CHANGELOG.md', availability: 'not_assessed' }
    ],
    lanes: [
      {
        product,
        route: rootPolicy ? route : 'file',
        profile_id: rootPolicy ? profile : 'codex-file-checkpoint-v1',
        operation: 'collect',
        topology: 'root',
        static_selection: rootPolicy ? 'inherited' : 'exact',
        compatibility: rootPolicy
          ? {
              state: 'compatibility_unverified',
              product,
              product_version: target,
              source: route,
              parser_version: base,
              parser_revision: profile,
              profile_id: profile,
              rule_revision: revision
            }
          : null,
        parser_base: base,
        window: rootPolicy ? { base, upper_exclusive: codex ? '0.170.0' : '2.2.0' } : null,
        rule_revision: rootPolicy ? revision : 'forward-version-v1',
        declared_scope: { max_depth: 0, max_members: 1, read_only: rootPolicy, exact_only: false },
        reasons: ['baseline_missing', 'contracts_unknown', ...(rootPolicy ? ['exact_qualification_required', ...(codex ? ['minor_transition'] : [])] : [])],
        review: {
          coverage: 'baseline_missing',
          baseline_version: null,
          releases: [],
          edges: [],
          parser_comparison: null,
          contracts: consumedContracts.map(contract_id => ({ contract_id, judgment: 'unknown' }))
        },
        live: { invalidation: 'not_assessed', binary: 'not_assessed', permissions: 'not_assessed', config: 'not_assessed', authentication: 'not_assessed' },
        gates: {
          contracts_reviewed: 'unknown',
          conformance: 'not_assessed',
          regression: 'not_assessed',
          implementation_review: 'not_assessed',
          admission: 'not_assessed',
          default_promotion: 'not_assessed'
        },
        ...(reviewed ? { selection_policy: { parser_base_transition: codex ? 'minor' : 'none', baseline_transition: null, next_step: 'selected_window' } } : {})
      }
    ]
  });
}

export function ordinaryAssessmentFixture(product: Product, target: string, reviewed = false) {
  const identity = {
    release_id: 1,
    tag: `${product === 'codex' ? 'rust-v' : 'v'}${target}`,
    commit: '1'.repeat(40),
    npm_integrity: `sha512-${Buffer.alloc(64).toString('base64')}`
  };
  const candidate: Candidate = {
    schema_version: 1,
    kind: 'candidate',
    product,
    target,
    ...identity
  };
  const observation: Observation = {
    schema_version: 1,
    kind: 'observation',
    product,
    checked_at: '2026-11-02T00:00:00.000Z',
    result: 'metadata_reconciled',
    reasons: ['baseline_missing'],
    heads: { github: target, npm_latest: target, npm_stable: target },
    checks: [],
    releases: [{ version: target, ...identity }],
    candidate_id: digest(candidate)
  };
  const unusedReview: ContractReview = {
    schema_version: 1,
    kind: 'contract_review',
    product: 'codex',
    route: 'file',
    profile_id: 'codex-file-checkpoint-v1',
    operation: 'collect',
    topology: 'root',
    contract_revision: 'consumed-v1',
    from: { version: '0.150.0', commit: '2'.repeat(40) },
    to: { version: '0.151.0', commit: '3'.repeat(40) },
    contracts: consumedContracts.map(contract_id => ({
      contract_id,
      judgment: 'unaffected'
    })),
    evidence_ids: ['a'.repeat(64)],
    source_digest: 'b'.repeat(64)
  };
  return {
    root: assessmentRoot,
    candidate,
    observation,
    reviews: reviewed ? [unusedReview] : null
  };
}
