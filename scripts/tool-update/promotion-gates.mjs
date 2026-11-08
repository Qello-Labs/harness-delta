import { boundedParse, canonical, compareVersions } from './manifest.mjs';
import { promotionGateInputSchema } from './promotion-records.mjs';

const actualClasses = ['actual_target_binary_conformance', 'native_trial', 'real_session'];
const gateRequirements = {
  G01: [['static'], ['pinned_upstream_comparison']],
  G02: [['static'], ['pinned_upstream_comparison']],
  G03: [['synthetic'], ['pinned_upstream_comparison', 'actual_target_binary_conformance']],
  G04: [['static'], ['synthetic']],
  G05: [['actual_target_binary_conformance']],
  G06: [['native_trial', 'real_session']],
  G07: [['synthetic'], ['real_session']],
  G08: [['pinned_upstream_comparison'], ['synthetic'], ['actual_target_binary_conformance'], ['native_trial', 'real_session']],
  G09: [['static'], ['synthetic']],
  G10: [['static'], ['synthetic']],
  G11: [['static']],
  G12: [['real_session']]
};
const commonGates = ['G01', 'G02', 'G03', 'G04', 'G05', 'G07', 'G09', 'G10'];
const reduceState = states => (states.includes('blocked') ? 'blocked' : states.includes('pending_pre_release') ? 'pending_pre_release' : 'ready_for_decision');
function classResult(evidence, evidenceClass) {
  const proofs = evidence.filter(row => row.evidence_class === evidenceClass);
  if (proofs.some(row => row.result === 'fail')) return 'fail';
  if (proofs.length === 0 || proofs.some(row => row.result === 'unknown' || row.freshness !== 'current')) return 'unknown';
  return 'pass';
}
function requirementResult(evidence, classes) {
  const results = classes.map(evidenceClass => classResult(evidence, evidenceClass));
  return results.includes('fail') ? 'fail' : results.includes('pass') ? 'pass' : 'unknown';
}
function evaluateGate(row) {
  const requirements = [...gateRequirements[row.gate_id], ...row.required_classes.map(value => [value])];
  const evaluated = requirements.map(classes => ({
    classes,
    result: requirementResult(row.evidence, classes)
  }));
  const failed = evaluated.some(row => row.result === 'fail');
  const unknown = evaluated.filter(row => row.result === 'unknown');
  return {
    gate_id: row.gate_id,
    result: failed ? 'fail' : unknown.length ? 'unknown' : 'pass',
    state:
      failed || unknown.some(row => !row.classes.some(value => actualClasses.includes(value)))
        ? 'blocked'
        : unknown.length
          ? 'pending_pre_release'
          : 'ready_for_decision',
    pending_classes: [...new Set(unknown.flatMap(row => row.classes))].sort()
  };
}
function coverageReasons(input) {
  const { coverage, scope } = input;
  const reasons = [];
  const cap = scope.lane.product === 'codex' ? '0.170.0' : '2.2.0';
  if (compareVersions(scope.target.version, cap) >= 0) reasons.push('target_refused');
  if (coverage.baseline_status === 'missing') {
    reasons.push('baseline_missing');
  }
  if (coverage.parser_base === null) reasons.push('parser_base_missing');
  if (!coverage.complete) reasons.push('coverage_incomplete');
  const comparisons = new Set(coverage.comparisons.map(canonical));
  const target = scope.target;
  for (const from of [coverage.baseline_ref, coverage.parser_base].filter(Boolean)) {
    const releases = coverage.releases.filter(ref => compareVersions(ref.version, from.version) >= 0 && compareVersions(ref.version, target.version) <= 0);
    if (canonical(releases[0]) !== canonical(from) || canonical(releases.at(-1)) !== canonical(target)) reasons.push('coverage_incomplete');
    for (let i = 1; i < releases.length; i++) {
      if (
        !comparisons.has(
          canonical({
            comparison_kind: 'adjacent_release',
            from: releases[i - 1],
            to: releases[i]
          })
        )
      )
        reasons.push('edge_missing');
    }
  }
  if (
    coverage.parser_base &&
    !comparisons.has(
      canonical({
        comparison_kind: 'parser_base',
        from: coverage.parser_base,
        to: target
      })
    )
  )
    reasons.push('edge_missing');
  return reasons;
}
function evaluateContracts(input) {
  const states = [];
  const reasons = [];
  for (const group of input.contracts) {
    for (const facet of group.facets) {
      if (facet.result === 'affected') {
        states.push('blocked');
        reasons.push('affected_contract');
        continue;
      }
      if (facet.result === 'unaffected' && facet.required_classes.length === 0) continue;
      const proofs = input.gate_matrix.flatMap(row => row.evidence).filter(row => row.contract_id === group.contract_id && row.facet === facet.facet);
      const floor =
        facet.facet === 'backend_counter_meaning'
          ? ['native_trial', 'real_session']
          : facet.facet === 'serialized_shape'
            ? ['pinned_upstream_comparison', 'actual_target_binary_conformance']
            : ['actual_target_binary_conformance'];
      const requirements = [...(facet.result === 'unknown' ? [floor] : []), ...facet.required_classes.map(value => [value])];
      const evaluated = requirements.map(classes => ({
        classes,
        result: requirementResult(proofs, classes)
      }));
      const unknown = evaluated.filter(row => row.result === 'unknown');
      states.push(
        evaluated.some(row => row.result === 'fail') || unknown.some(row => !row.classes.some(value => actualClasses.includes(value)))
          ? 'blocked'
          : unknown.length
            ? 'pending_pre_release'
            : 'ready_for_decision'
      );
      if (unknown.length) reasons.push('unknown_contract');
    }
  }
  return { state: reduceState(states), reasons };
}
export function reducePromotionGates(input) {
  const parsed = boundedParse(input, promotionGateInputSchema);
  const gates = parsed.gate_matrix.map(evaluateGate);
  const coverage = coverageReasons(parsed);
  const contracts = evaluateContracts(parsed);
  const capability = grant => {
    if (!parsed.requested_grants.includes(grant)) return 'not_requested';
    const required = [...commonGates, ...(grant === 'qualification' ? ['G06'] : []), ...(grant === 'children' ? ['G06', 'G08'] : [])];
    return reduceState([
      coverage.length ? 'blocked' : 'ready_for_decision',
      contracts.state,
      ...gates.filter(row => required.includes(row.gate_id)).map(row => row.state)
    ]);
  };
  const admission = capability('admission');
  const qualification = capability('qualification');
  const children = capability('children');
  const state = parsed.unresolved_finding_ids.length
    ? 'review_needed'
    : reduceState([admission, qualification, children].filter(value => value !== 'not_requested'));
  return {
    authority: 'none',
    state,
    admission,
    qualification,
    children,
    gates,
    reasons: [...new Set([...coverage, ...contracts.reasons, ...(parsed.unresolved_finding_ids.length ? ['review_required'] : [])])].sort()
  };
}
