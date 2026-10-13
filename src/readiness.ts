import { z } from 'zod';
import { createHash } from 'node:crypto';
import { IdSchema } from './contracts.js';
import { parseComparison } from './comparison-contracts.js';
import { FlexibleProtocolSchema,CostCoverageEvidenceSchema,CostCoverageDecisionSchema,type FlexibleProtocol,type CostCoverageEvidence,type CostCoverageDecision } from './flexible-contracts.js';
import { evaluateCostCoverage } from './cost-coverage.js';
export interface ReadinessInput {protocol:FlexibleProtocol;source_evidence_ids:string[];coverage:{evidence:CostCoverageEvidence;decision:CostCoverageDecision}[];analysis_evidence_id:string|null;invalidated:boolean;followup_complete:boolean;}
export interface SourceReadinessEvidence {id:string;product:'synthetic'|'codex'|'claude_code';product_version:string;profile_id:string;semantics_digest:string;validation_kind:'synthetic'|'real_operations';complete_cost:boolean;}
// Registries are code-owned evidence, never writable protocol flags or imported claims.
// Exact root workflow operational evidence; see validation/codex-workflow-01600-source-readiness.md.
// Separate exact root/direct-child partial sources; never complete cost or inference.
export const productionSourceEvidence:readonly SourceReadinessEvidence[]=Object.freeze([Object.freeze({
  id:'codex-workflow-01600-root-native-v1',product:'codex',product_version:'0.160.0',profile_id:'codex-workflow-own-response-v1',
  semantics_digest:'f97979e1c7878fc8b54a9ab004f7cf69ddd9df39f409f357104f72317937aa8b',validation_kind:'real_operations',complete_cost:false,
}),Object.freeze({
  id:'codex-workflow-01600-direct-child-native-v1',product:'codex',product_version:'0.160.0',profile_id:'codex-workflow-direct-child-v1',
  semantics_digest:'f60bfac70ddc3c4054d0f104386a07d438dab5d2bc4a1ebbfb297a9fbc6a839b',validation_kind:'real_operations',complete_cost:false,
}),Object.freeze({
  // Parent-only fresh launch. Replaces claude-workflow-02191-root-native-v1 (2.1.291, retired from
  // the workflow on 2026-10-13); see validation/claude-workflow-02196-source-readiness.md.
  id:'claude-workflow-02196-root-native-v1',product:'claude_code',product_version:'2.1.296',profile_id:'claude-workflow-own-trace-v1',
  semantics_digest:'27298b4ecb2fc8c2982afc6307268a19ccf2652db787c96dff4b52321526333a',validation_kind:'real_operations',complete_cost:false,
}),Object.freeze({
  // Separate exact profile: a fresh read-only root with one fresh direct child;
  // see validation/claude-workflow-02196-direct-child-source-readiness.md.
  id:'claude-workflow-02196-direct-child-native-v1',product:'claude_code',product_version:'2.1.296',profile_id:'claude-workflow-direct-child-v1',
  semantics_digest:'dfe01a0be5489858a2d60cf2dc0076073296e2f34d11ca62f5b184e4b37690d8',validation_kind:'real_operations',complete_cost:false,
})]);
export const productionAnalysisEvidence:readonly string[]=Object.freeze([]);
export const syntheticSourceEvidence:readonly SourceReadinessEvidence[]=Object.freeze([Object.freeze({id:'synthetic-flexible-v1',product:'synthetic',product_version:'1.0.0',profile_id:'synthetic-flexible-v1',
  semantics_digest:createHash('sha256').update('synthetic-flexible-v1:disjoint-components:request-boundaries').digest('hex'),validation_kind:'synthetic',complete_cost:true})]);
const schema=z.strictObject({protocol:FlexibleProtocolSchema,source_evidence_ids:z.array(IdSchema).max(256).refine(a=>new Set(a).size===a.length),coverage:z.array(z.strictObject({evidence:CostCoverageEvidenceSchema,decision:CostCoverageDecisionSchema})).max(10000),
  analysis_evidence_id:IdSchema.nullable(),invalidated:z.boolean(),followup_complete:z.boolean()});
export function evaluateReadiness(input:ReadinessInput){
  const i=parseComparison(schema,input,'invalid_readiness');const reasons:string[]=[];
  const registry=i.protocol.purpose==='synthetic_validation'?syntheticSourceEvidence:productionSourceEvidence;
  const sources=i.source_evidence_ids.map(id=>registry.find(e=>e.id===id));
  const sourceReady=sources.length>0&&sources.every(e=>e!==undefined&&/^[a-f0-9]{64}$/.test(e.semantics_digest))&&
    i.protocol.source_profiles.every(p=>sources.some(e=>e?.product===p.product&&e.product_version===p.product_version&&e.profile_id===p.profile_id))&&
    sources.every(e=>i.protocol.source_profiles.some(p=>p.product===e?.product&&p.product_version===e.product_version&&p.profile_id===e.profile_id));
  const real=i.protocol.purpose!=='synthetic_validation'&&sourceReady&&sources.every(e=>e?.validation_kind==='real_operations')&&!i.invalidated;
  if(i.protocol.purpose==='functional_pilot')reasons.push('functional_pilot_only');
  if(!sourceReady)reasons.push('source_unverified');if(i.protocol.purpose==='synthetic_validation')reasons.push('synthetic_only');
  const windows=i.coverage.length>0&&new Set(i.coverage.map(c=>c.evidence.task_id)).size===i.coverage.length&&i.coverage.every(c=>Date.parse(c.evidence.window_end)-Date.parse(c.evidence.window_start)===i.protocol.followup_seconds*1000);
  const coverageReady=windows&&i.coverage.every(c=>{const decision=evaluateCostCoverage(c.evidence);return decision.eligible&&c.decision.eligible&&c.decision.reasons.length===0;});
  const complete=sourceReady&&sources.every(e=>e?.complete_cost)&&coverageReady&&i.followup_complete&&!i.invalidated;
  if(!windows)reasons.push('coverage_scope_unverified');if(!coverageReady||sourceReady&&!sources.every(e=>e?.complete_cost))reasons.push('cost_incomplete');if(!i.followup_complete)reasons.push('followup_pending');if(i.invalidated)reasons.push('invalidated');
  // No continuous-money/repeated-assignee method has production validation.
  const analysis=i.analysis_evidence_id!==null&&productionAnalysisEvidence.includes(i.analysis_evidence_id);
  if(!analysis)reasons.push('analysis_unverified');
  return {real_allocation:real,complete_cost:complete,inference:i.protocol.purpose==='real_experiment'&&real&&complete&&analysis,reasons:[...new Set(reasons)].sort()};
}
