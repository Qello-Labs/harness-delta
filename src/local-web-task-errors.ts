export const localWebTaskErrorCodes = [
  'outside_recruitment', 'ineligible_task', 'allocator_conflict', 'task_already_started',
  'preregistration_conflict', 'identity_conflict', 'project_mismatch', 'protocol_not_active',
  'real_experiment_disabled', 'separate_store_required', 'synthetic_store_required',
  'clock_regression', 'workflow_configuration_mismatch', 'workflow_protocol_mismatch',
  'workflow_manifest_mismatch', 'unknown_setup', 'unknown_task', 'unknown_project',
  'preparation_failed', 'application_mode_mismatch', 'application_mode_locked', 'application_mode_unsupported',
] as const;

export type LocalWebTaskErrorCode = typeof localWebTaskErrorCodes[number];
export function isLocalWebTaskErrorCode(code: string): code is LocalWebTaskErrorCode {
  return localWebTaskErrorCodes.some(value => value === code);
}
