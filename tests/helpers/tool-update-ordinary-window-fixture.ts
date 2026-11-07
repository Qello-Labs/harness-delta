import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { consumedContracts } from '../../scripts/tool-update/assessment.mjs';
import type { ContractReview } from '../../scripts/tool-update/assessment.mjs';
import type { Candidate, Observation, Product } from '../../scripts/tool-update/discovery.mjs';
import { digest } from '../../scripts/tool-update/manifest.mjs';

export const assessmentRoot = realpathSync(fileURLToPath(new URL('../..', import.meta.url)));

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
