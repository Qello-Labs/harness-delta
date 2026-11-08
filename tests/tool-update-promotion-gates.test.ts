import { expect, test } from 'vitest';
import { reducePromotionGates } from '../scripts/tool-update/promotion-gates.mjs';
import { promotionEvidenceClasses, promotionGateIds } from '../scripts/tool-update/promotion-records.mjs';
import type { PromotionGateInput } from '../scripts/tool-update/promotion-records.mjs';
import { consumedContracts, requiredFacets } from '../scripts/tool-update/difference-contracts.mjs';
import { requiredDifferenceCoverage } from '../scripts/tool-update/difference-records.mjs';
import { digest } from '../scripts/tool-update/manifest.mjs';
import { differenceJob } from './helpers/tool-update-difference-fixture.js';

function completeInput(): PromotionGateInput {
  const job = differenceJob();
  const scope = {
    target: job.target,
    lane: job.lane,
    platform: 'darwin_arm64',
    runtime: 'node24'
  } as const;
  return {
    scope,
    requested_grants: ['admission', 'qualification'],
    required_validation: [],
    coverage: {
      baseline_status: 'present',
      baseline_digest: job.baseline_digest,
      baseline_ref: { version: '0.163.0', commit: '1'.repeat(40) },
      parser_base: { version: '0.163.0', commit: '1'.repeat(40) },
      releases: job.inventory.releases,
      complete: true,
      comparisons: requiredDifferenceCoverage(job).comparisons
    },
    contracts: consumedContracts.map(contract_id => ({
      contract_id,
      facets: requiredFacets(contract_id, job.lane).map(facet => ({
        facet,
        result: 'unaffected',
        required_classes: []
      }))
    })),
    gate_matrix: promotionGateIds.map(gate_id => ({
      gate_id,
      required_classes: [],
      evidence: [...promotionEvidenceClasses]
        .sort()
        .map(evidence_class => ({
          evidence_id: digest({ gate_id, evidence_class }),
          evidence_class,
          scope_digest: digest(scope),
          result: 'pass' as const,
          freshness: 'current' as const,
          contract_id: null,
          facet: null
        }))
        .sort((a, b) => a.evidence_id.localeCompare(b.evidence_id, 'en'))
    })),
    unresolved_finding_ids: []
  };
}
test('complete evidence reaches decision readiness but never issues authority or changes external decision gates', () => {
  const input = completeInput();
  const before = JSON.stringify(input);
  const result = reducePromotionGates(input);
  expect(result.state).toBe('ready_for_decision');
  expect(result.admission).toBe('ready_for_decision');
  expect(result.qualification).toBe('ready_for_decision');
  expect(result.children).toBe('not_requested');
  expect(result.authority).toBe('none');
  expect(JSON.stringify(input)).toBe(before);
  const undecided = {
    ...input,
    gate_matrix: input.gate_matrix.map(row => (['G11', 'G12'].includes(row.gate_id) ? { ...row, evidence: [] } : row))
  };
  expect(reducePromotionGates(undecided).state).toBe('ready_for_decision');
  expect(
    reducePromotionGates(undecided)
      .gates.filter(row => ['G11', 'G12'].includes(row.gate_id))
      .map(row => row.result)
  ).toEqual(['unknown', 'unknown']);
});
test.each(['native_only', 'synthetic_only', 'gate_real_session', 'proposal_real_session'] as const)(
  'G07 actual alternatives preserve the %s evidence boundary',
  scenario => {
    const input = completeInput();
    const gate_matrix = input.gate_matrix.map(row => {
      const evidence = scenario === 'proposal_real_session' ? row.evidence.filter(proof => proof.evidence_class !== 'real_session') : row.evidence;
      if (row.gate_id === 'G12') return { ...row, evidence: [] };
      if (row.gate_id !== 'G07') return { ...row, evidence };
      return {
        ...row,
        required_classes: scenario === 'gate_real_session' ? ['real_session'] : [],
        evidence: evidence.filter(proof => proof.evidence_class === 'synthetic' || (scenario !== 'synthetic_only' && proof.evidence_class === 'native_trial'))
      };
    });
    const result = reducePromotionGates({
      ...input,
      gate_matrix,
      required_validation: scenario === 'proposal_real_session' ? ['real_session'] : []
    });
    expect(result.state).toBe(scenario === 'native_only' ? 'ready_for_decision' : 'pending_pre_release');
    expect(result.gates.find(row => row.gate_id === 'G07')?.result).toBe(['native_only', 'proposal_real_session'].includes(scenario) ? 'pass' : 'unknown');
    expect(result.gates.find(row => row.gate_id === 'G12')?.result).toBe('unknown');
    expect(result.authority).toBe('none');
  }
);
test('unknown proof never counts as pass even when a same-class passing proof exists', () => {
  const input = completeInput();
  const gates = input.gate_matrix.map(row =>
    row.gate_id !== 'G04'
      ? row
      : {
          ...row,
          evidence: [
            ...row.evidence.map(proof => (proof.evidence_class === 'synthetic' ? { ...proof, result: 'unknown' as const } : proof)),
            {
              evidence_id: 'f'.repeat(64),
              evidence_class: 'synthetic' as const,
              scope_digest: digest(input.scope),
              result: 'pass' as const,
              freshness: 'current' as const,
              contract_id: null,
              facet: null
            }
          ].sort((a, b) => a.evidence_id.localeCompare(b.evidence_id, 'en'))
        }
  );
  expect(reducePromotionGates({ ...input, gate_matrix: gates }).state).toBe('blocked');
});
test.each(['static', 'synthetic', 'pinned_upstream_comparison'] as const)('missing %s preparation proof cannot be deferred as a native gate', evidenceClass => {
  const input = completeInput();
  const gate_matrix = input.gate_matrix.map(row => ({
    ...row,
    evidence: row.evidence.filter(proof => proof.evidence_class !== evidenceClass)
  }));
  expect(reducePromotionGates({ ...input, gate_matrix }).state).toBe('blocked');
});
test('synthetic-only evidence leaves actual-binary, native and real-session obligations pending', () => {
  const input = completeInput();
  const gate_matrix = input.gate_matrix.map(row => ({
    ...row,
    evidence: row.evidence.filter(proof => ['static', 'synthetic', 'pinned_upstream_comparison'].includes(proof.evidence_class))
  }));
  const result = reducePromotionGates({ ...input, gate_matrix });
  expect(result.state).toBe('pending_pre_release');
  expect(result.gates.find(row => row.gate_id === 'G05')?.result).toBe('unknown');
  expect(result.gates.find(row => row.gate_id === 'G06')?.result).toBe('unknown');
  expect(result.gates.find(row => row.gate_id === 'G07')?.result).toBe('unknown');
});
test('undocumented facets stay pending when an actual-evidence alternative can close them', () => {
  const input = completeInput();
  const contracts = input.contracts.map(group => ({ ...group, facets: group.facets.map(row => ({ ...row, result: 'unknown' })) }));
  const gate_matrix = input.gate_matrix.map(row => ({
    ...row,
    evidence: row.evidence.filter(proof => ['static', 'synthetic', 'pinned_upstream_comparison'].includes(proof.evidence_class))
  }));
  expect(reducePromotionGates({ ...input, contracts, gate_matrix }).state).toBe('pending_pre_release');
});
test.each(['baseline', 'parser', 'edge', 'inventory'] as const)('missing %s coverage blocks despite all passing gate proofs', problem => {
  const input = completeInput();
  const coverage = {
    ...input.coverage,
    ...(problem === 'baseline'
      ? {
          baseline_status: 'missing' as const,
          baseline_digest: null,
          baseline_ref: null
        }
      : {}),
    ...(problem === 'parser' ? { parser_base: null } : {}),
    ...(problem === 'edge'
      ? {
          comparisons: input.coverage.comparisons.filter(row => row.comparison_kind === 'parser_base')
        }
      : {}),
    ...(problem === 'inventory' ? { complete: false } : {})
  };
  expect(reducePromotionGates({ ...input, coverage }).state).toBe('blocked');
});
test('cross-lane and wrong-version proof is rejected instead of improving readiness', () => {
  const input = completeInput();
  const gate_matrix = input.gate_matrix.map(row => ({
    ...row,
    evidence: row.evidence.map(proof => ({
      ...proof,
      scope_digest: digest({
        ...input.scope,
        lane: { ...input.scope.lane, operation: 'resume' }
      })
    }))
  }));
  expect(() => reducePromotionGates({ ...input, gate_matrix })).toThrow('invalid_record');
});
test('admission, qualification and child evidence have distinct readiness states', () => {
  const input = completeInput();
  const gate_matrix = input.gate_matrix.map(row => (row.gate_id === 'G06' ? { ...row, evidence: [] } : row));
  const result = reducePromotionGates({ ...input, gate_matrix });
  expect(result.admission).toBe('ready_for_decision');
  expect(result.qualification).toBe('pending_pre_release');
  expect(result.children).toBe('not_requested');
  expect(() =>
    reducePromotionGates({
      ...input,
      requested_grants: ['admission', 'children']
    })
  ).toThrow('invalid_record');
});
test('child scope needs independent child-lane evidence and never inherits root proofs', () => {
  const input = completeInput();
  const scope = {
    ...input.scope,
    lane: {
      ...input.scope.lane,
      profile_id: 'codex-binding-01630-direct-family-v1',
      topology: 'bounded_family'
    }
  } as const;
  const child = {
    ...input,
    scope,
    requested_grants: ['children'],
    contracts: consumedContracts.map(contract_id => ({
      contract_id,
      facets: requiredFacets(contract_id, scope.lane).map(facet => ({
        facet,
        result: 'unaffected',
        required_classes: []
      }))
    })),
    gate_matrix: input.gate_matrix.map(row => ({
      ...row,
      evidence:
        row.gate_id === 'G08'
          ? row.evidence
              .filter(proof => ['static', 'synthetic', 'pinned_upstream_comparison'].includes(proof.evidence_class))
              .map(proof => ({ ...proof, scope_digest: digest(scope) }))
          : row.evidence.map(proof => ({
              ...proof,
              scope_digest: digest(scope)
            }))
    }))
  };
  expect(reducePromotionGates(child).children).toBe('pending_pre_release');
  expect(() => reducePromotionGates({ ...child, gate_matrix: input.gate_matrix })).toThrow('invalid_record');
});
test.each(['affected', 'unknown'] as const)('unresolved %s consumed contracts cannot be erased by unrelated passing gates', result => {
  const input = completeInput();
  const contracts = input.contracts.map(group => ({
    ...group,
    facets: group.facets.map(row => (row.facet === 'client_transformation' ? { ...row, result } : row))
  }));
  expect(reducePromotionGates({ ...input, contracts }).state).toBe(result === 'affected' ? 'blocked' : 'pending_pre_release');
});
test('stale proof and preserved unresolved findings cannot return a proposal to readiness', () => {
  const input = completeInput();
  const stale = input.gate_matrix.map(row => ({
    ...row,
    evidence: row.evidence.map(proof => ({
      ...proof,
      freshness: 'stale' as const
    }))
  }));
  expect(reducePromotionGates({ ...input, gate_matrix: stale }).state).toBe('blocked');
  expect(
    reducePromotionGates({
      ...input,
      unresolved_finding_ids: ['1'.repeat(64)]
    }).state
  ).toBe('review_needed');
});
test('a declared facet validation obligation is retained even when a structural finding is unaffected', () => {
  const input = completeInput();
  const contracts = input.contracts.map(group => ({
    ...group,
    facets: group.facets.map(row => ({ ...row, required_classes: ['actual_target_binary_conformance'] }))
  }));
  expect(reducePromotionGates({ ...input, contracts }).state).toBe('pending_pre_release');
});
test('unsupported methods, duplicate gates and oversized evidence lists are rejected before reduction', () => {
  const input = completeInput();
  const first = input.gate_matrix[0];
  if (!first) throw new Error('missing_synthetic_gate');
  for (const gate_matrix of [
    [first, ...input.gate_matrix.slice(0, -1)],
    input.gate_matrix.map(row => ({ ...row, required_classes: ['unknown_method'] })),
    input.gate_matrix.map((row, index) =>
      index > 0
        ? row
        : {
            ...row,
            evidence: Array.from({ length: 257 }, (_, n) => ({
              evidence_id: n.toString(16).padStart(64, '0'),
              scope_digest: digest(input.scope),
              evidence_class: 'synthetic',
              result: 'pass',
              freshness: 'current',
              contract_id: null,
              facet: null
            }))
          }
    )
  ])
    expect(() => reducePromotionGates({ ...input, gate_matrix })).toThrow('invalid_record');
});
test.each(['0.170.0', '0.171.0'])('a passing packet cannot evade the retained Codex cap at %s', version => {
  const input = completeInput();
  const scope = { ...input.scope, target: { ...input.scope.target, version } };
  const gate_matrix = input.gate_matrix.map(row => ({ ...row, evidence: row.evidence.map(proof => ({ ...proof, scope_digest: digest(scope) })) }));
  const result = reducePromotionGates({ ...input, scope, gate_matrix });
  expect(result.state).toBe('blocked');
  expect(result.reasons).toContain('target_refused');
});
