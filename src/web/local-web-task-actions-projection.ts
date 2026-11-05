import type { ExternalTaskData, OrdinaryTaskData } from './local-web-task-projection.js';

function action(code: string, enabled: boolean, why: string | null = null) {
  return { code, enabled, reason: enabled ? null : why };
}
function observationReason(data: ExternalTaskData) {
  const { ownedNativeLive, finalized, active, connected } = data;
  return ownedNativeLive
    ? 'owned_native_running'
    : finalized
      ? 'finalized'
      : active
        ? 'observation_running'
        : !connected
          ? 'external_connection_required'
          : null;
}

function applicationActions(data: ExternalTaskData) {
  const { application, finalized, active } = data;
  return [
    ...(application
      ? [
          action(
            'application-prepare',
            !finalized && !active && ['awaiting_application', 'failed', 'abandoned'].includes(application.state),
            'application_required'
          ),
          action('application-open', !finalized && !active && application.state === 'awaiting_session', 'application_required'),
          action(
            'application-cancel',
            !finalized && !active && !!application.jobId && ['awaiting_session', 'applying', 'applied', 'failed'].includes(application.state),
            'application_required'
          )
        ]
      : [])
  ];
}

function configurationActions(data: ExternalTaskData) {
  const { finalized, active, ready, state, supported, startup } = data;
  return [
    action('apply', !finalized && !active && !ready, finalized ? 'finalized' : active ? 'workflow_run_active' : 'configuration_ready'),
    action(
      'ticket',
      !finalized && !active && ready && state.window_status !== 'closed' && supported,
      !supported ? 'external_collection_unsupported' : finalized ? 'finalized' : active ? 'workflow_run_active' : 'external_preparation_required'
    ),
    action(
      'connect',
      !finalized && !active && startup !== null && ready && state.window_status !== 'closed' && supported,
      !supported ? 'external_collection_unsupported' : active ? 'workflow_run_active' : 'external_ticket_required'
    )
  ];
}

function connectionActions(data: ExternalTaskData) {
  const { finalized, ready, state, bindingAvailable, bindingAuthorized, bindingUnavailableReason } = data;
  return [
    action(
      'session-connect',
      !finalized && ready && state.window_status !== 'closed' && bindingAvailable && bindingAuthorized,
      !bindingAvailable
        ? bindingUnavailableReason
        : !bindingAuthorized
          ? 'binding_source_unqualified'
          : finalized
            ? 'finalized'
            : !ready
              ? 'external_preparation_required'
              : 'external_window_closed'
    )
  ];
}

function observationActions(data: ExternalTaskData) {
  const { binding, finalized, active, ownedNativeLive, connected, source, ready, state, supported, bindingAuthorized, task, resumeAvailable } = data;
  const reason = observationReason(data);
  return [
    action(
      'observe',
      binding.roots === 0 &&
        !finalized &&
        !active &&
        !ownedNativeLive &&
        connected &&
        source !== null &&
        ready &&
        state.window_status !== 'closed' &&
        supported,
      binding.roots > 0
        ? 'binding_reconnect_required'
        : (reason ?? (state.window_status === 'closed' ? 'external_window_closed' : 'external_connection_required'))
    ),
    action(
      'resume-binding',
      resumeAvailable,
      !bindingAuthorized
        ? 'binding_source_unqualified'
        : task.state === 'active'
          ? 'observation_running'
          : task.state === 'finalized'
            ? 'finalized'
            : 'binding_reconnect_required'
    )
  ];
}

function lifecycleActions(data: ExternalTaskData) {
  const { ownedNativeLive, explicitStop, finalized, collectionRevoked, active, task, connected, state, recoverAvailable, binding } = data;
  const reason = observationReason(data);
  const canFinish = !finalized && (!active || (explicitStop && binding.roots > 0)) && !ownedNativeLive && connected;
  return [
    action('emergency-stop', ownedNativeLive, 'owned_native_inactive'),
    action('revoke-collection', explicitStop && !finalized && !collectionRevoked, 'binding_scope_revoked'),
    action('pause', !finalized && (active || task.state === 'active'), 'inactive_observation'),
    action('rework', !finalized && !active && !ownedNativeLive && connected && state.window_status !== 'closed', reason ?? 'external_window_closed'),
    action('finish-success', canFinish, reason),
    action('finish-failed', canFinish, reason),
    action('finish-abandoned', canFinish, reason),
    action('recover', recoverAvailable, 'inactive_observation'),
    action('release', !active && state.state !== 'released', 'workflow_run_active')
  ];
}

export function projectExternalActions(data: ExternalTaskData) {
  const { application, qualification, nativePilotTaskId, id } = data;
  const qualificationActions = new Set(['session-connect', 'pause', 'resume-binding', 'emergency-stop']);
  return [...applicationActions(data), ...configurationActions(data), ...connectionActions(data), ...observationActions(data), ...lifecycleActions(data)]
    .map(a => (application && ['apply', 'ticket', 'connect'].includes(a.code) ? { ...a, enabled: false, reason: 'application_native_loading_unqualified' } : a))
    .map(a =>
      qualification && !qualificationActions.has(a.code)
        ? { ...a, enabled: false, reason: 'binding_qualification_control_only' }
        : nativePilotTaskId !== undefined &&
            (id !== nativePilotTaskId ||
              ![
                'apply',
                'pause',
                'revoke-collection',
                'session-connect',
                'resume-binding',
                'finish-success',
                'finish-failed',
                'finish-abandoned',
                'release'
              ].includes(a.code))
          ? { ...a, enabled: false, reason: 'binding_pilot_control_only' }
          : a
    );
}

export function projectOrdinaryActions(data: OrdinaryTaskData) {
  const { finalized, revoked, supported, supportReason, active, resumeAvailable, binding, connected } = data;
  return [
    action('session-connect', !finalized && !revoked && supported, !supported ? supportReason : 'binding_scope_revoked'),
    action('pause', !finalized && active, 'inactive_observation'),
    action('resume-binding', resumeAvailable, 'binding_reconnect_required'),
    action(
      'stop-observation',
      !finalized && !!binding.selected_root_id && binding.segment_state !== null && binding.segment_state !== 'closed',
      'inactive_observation'
    ),
    action('revoke-collection', !finalized && !revoked, 'binding_scope_revoked'),
    action('finish-success', !finalized && connected, 'external_connection_required'),
    action('finish-failed', !finalized && connected, 'external_connection_required'),
    action('finish-abandoned', !finalized, 'finalized')
  ];
}
