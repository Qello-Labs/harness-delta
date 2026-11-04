import type { Store } from '../store.js';
import type { LocalWebProfile } from './local-web-profile.js';
import { protocolRow } from '../core/protocol-store.js';
import { resolveSourceCompatibility, effectiveSourceCompatibility } from '../source-compatibility.js';
import { functionalWorkflowEligible, comparisonReadiness } from '../readiness-store.js';
import { parseProtocol } from '../flexible-contracts.js';
import { isHumanPilotProtocol, codexRootHumanPilotProfileId } from '../session-binding-human-pilot.js';
import { getCodexBindingAdmission, isAdmittedCodexBindingProtocol } from '../codex-binding-admission.js';
export function localWebSupport(store: Store, profile: LocalWebProfile) {
  const workflow = profile.setup.workflow;
  const protocolRecord = protocolRow(store, workflow.assignment.protocol_id);
  const protocol = parseProtocol(JSON.parse(protocolRecord.settings) as unknown);
  const synthetic = workflow.assignment.metadata.product === 'synthetic' || (protocol.schema_version === 2 && protocol.purpose === 'synthetic_validation');
  const familyPilot = protocol.schema_version === 2 && isHumanPilotProtocol(protocol);
  const rootPilot = familyPilot && protocol.schema_version === 2 && protocol.source_profiles[0]?.profile_id === codexRootHumanPilotProfileId;
  const ordinaryFamily = protocol.schema_version === 2 && isAdmittedCodexBindingProtocol(protocol);
  const parserCompatibility = ordinaryFamily
    ? resolveSourceCompatibility('codex', workflow.product_version, 'codex_binding', getCodexBindingAdmission(workflow.product_version)?.profileId)
    : rootPilot
      ? resolveSourceCompatibility('codex', workflow.product_version, 'codex_workflow', 'codex-workflow-own-response-v1')
      : null;
  const parserState = parserCompatibility ? effectiveSourceCompatibility(store, parserCompatibility) : null;
  const launchAllowed =
    !ordinaryFamily &&
    protocolRecord.status === 'frozen' &&
    protocol.schema_version === 2 &&
    (functionalWorkflowEligible(store, protocol) || comparisonReadiness(store, protocol.id).real_allocation);
  const launch =
    protocol.schema_version === 2
      ? protocol.source_profiles.map(source => {
          const compatibility =
            source.product === 'synthetic' || ordinaryFamily
              ? null
              : resolveSourceCompatibility(
                  source.product,
                  source.product_version,
                  source.product === 'codex' ? 'codex_workflow' : 'claude_workflow',
                  source.profile_id
                );
          return {
            profile_id: source.profile_id,
            state: !synthetic && launchAllowed && compatibility ? effectiveSourceCompatibility(store, compatibility).state : 'unsupported'
          };
        })
      : [];
  function familySupport(): string {
    return synthetic
      ? 'synthetic_validation_only'
      : protocolRecord.status === 'frozen' && ordinaryFamily && parserState && parserState.state !== 'invalidated'
        ? parserState.state === 'verified'
          ? 'verified_bounded_family'
          : 'candidate_pilot'
        : protocolRecord.status === 'frozen' && familyPilot
          ? rootPilot
            ? 'candidate_root_pilot'
            : 'candidate_pilot'
          : 'qualification_required';
  }
  return {
    context: synthetic ? 'synthetic_validation_only' : 'real',
    connection_route: synthetic ? 'synthetic' : profile.session_binding || familyPilot ? 'family' : 'ticket',
    product: workflow.assignment.metadata.product,
    product_version: workflow.product_version,
    launch,
    ticket: synthetic
      ? 'synthetic_validation_only'
      : workflow.assignment.metadata.product === 'codex' && workflow.product_version === '0.160.0'
        ? 'exact_version_only'
        : 'unsupported',
    family: familySupport(),
    ...(parserState ? { family_parser_compatibility: parserState } : {}),
    complete_cost: false,
    inference: false
  };
}
