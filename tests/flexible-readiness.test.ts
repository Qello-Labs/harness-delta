import { expect,test } from 'vitest';
import { evaluateReadiness,type ReadinessInput } from '../src/readiness.js';
import { evaluateCostCoverage } from '../src/cost-coverage.js';
import { makeFlexibleFixture } from './helpers/flexible-fixture.js';
import { codexBindingAdmission } from '../src/codex-binding-admission.js';
function input():ReadinessInput{const f=makeFlexibleFixture();return {protocol:f.protocol,source_evidence_ids:['synthetic-flexible-v1'],coverage:[{evidence:f.coverage,decision:evaluateCostCoverage(f.coverage)}],analysis_evidence_id:null,invalidated:false,followup_complete:true};}
test('synthetic_evidence_cannot_enable_real_and_bounded_integer_study_is_not_cost_validation',()=>{
  expect(evaluateReadiness({...input(),analysis_evidence_id:'bounded-confidence-v1'})).toMatchObject({real_allocation:false,inference:false});
});
test('partial_source_can_never_enable_complete_or_inference_even_with_forged_decision',()=>{
  const i=input();i.coverage[0]!.evidence.facts.request_universe='unknown';i.coverage[0]!.decision={eligible:true,reasons:[]};
  expect(evaluateReadiness(i)).toMatchObject({real_allocation:false,complete_cost:false,inference:false});
  expect(evaluateReadiness({...input(),coverage:[]})).toMatchObject({complete_cost:false});
});
test('synthetic_complete_cost_is_independent_of_real_and_inference',()=>{
  expect(evaluateReadiness(input())).toMatchObject({real_allocation:false,complete_cost:true,inference:false});
  for(const changed of [{invalidated:true},{followup_complete:false}])expect(evaluateReadiness({...input(),...changed})).toMatchObject({complete_cost:false,inference:false});
});
test('coverage_requires_unique_task_identity_and_declared_followup_window',()=>{
  const i=input();expect(evaluateReadiness({...i,coverage:[...i.coverage,...i.coverage]}).complete_cost).toBe(false);
  i.coverage[0]!.evidence.window_end='2026-01-01T02:00:00Z';expect(evaluateReadiness(i).complete_cost).toBe(false);
});
test('post_assignment_model_is_not_adjustment_and_unknown_evidence_is_rejected',()=>{
  expect(()=>evaluateReadiness({...input(),protocol:{...input().protocol,realized_model_weights:{x:1}}} as ReadinessInput)).toThrow('invalid_readiness');
  expect(evaluateReadiness({...input(),source_evidence_ids:['untrusted-real'],analysis_evidence_id:'untrusted-analysis'})).toMatchObject({real_allocation:false,complete_cost:false,inference:false});
});

test('ordinary binding evidence cannot enable real experiment allocation or inference',()=>{
  const i=input();
  const protocol={...i.protocol,purpose:'real_experiment' as const,source_profiles:[{
    product:'codex' as const,product_version:'0.162.1',profile_id:codexBindingAdmission.profileId,
  }]};

  const result=evaluateReadiness({...i,protocol,source_evidence_ids:[codexBindingAdmission.evidenceId]});

  expect(result).toMatchObject({real_allocation:false,complete_cost:false,inference:false});
  expect(result.reasons).toContain('source_unverified');
});
