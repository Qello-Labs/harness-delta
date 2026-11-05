import { taskErrorGuidance } from './task-error-guidance';
import type { Locale, Task } from './types';
const messages: Record<string, [string, string]> = {
  registration_too_late: [
    'Recruitment has already started. Review new recruitment dates with your agent and reload the revised setup bundle. No new setting was saved.',
    '모집 시작일이 이미 지났습니다. 에이전트와 새 모집 날짜를 확인한 뒤 수정한 설정 묶음을 불러오세요. 새 설정은 저장하지 않았습니다.'
  ],
  shared_import_expired: [
    'This review expired. Review the same inputs again before saving.',
    '검토 유효 시간이 지났습니다. 같은 입력을 다시 검토한 뒤 저장하세요.'
  ],
  shared_preview_changed: ['The selected configuration changed. Import and review it again.', '선택한 구성이 바뀌었습니다. 다시 불러와 확인하세요.'],
  shared_tool_mismatch: [
    'Selected original tools differ. Correct the files and retry the same assigned task.',
    '배정된 원본 도구가 다릅니다. 파일을 확인하고 같은 작업을 다시 준비하세요.'
  ],
  shared_binding_changed: [
    'Private connection changed or is missing. Reconnect the reviewed settings; existing task pins remain fixed.',
    '로컬 연결 정보가 바뀌었거나 없습니다. 검토된 설정을 다시 연결하세요. 기존 작업의 고정 기준은 유지합니다.'
  ],
  shared_content_mismatch: [
    'Pinned harness files changed. Review a new version rather than overwriting this pair.',
    '고정된 하네스 파일이 변경됐습니다. 이 쌍을 덮어쓰지 말고 새 버전을 검토하세요.'
  ],
  shared_project_required: ['Select the comparison file inside its registered project checkout.', '등록된 프로젝트 checkout 안의 비교 파일을 선택하세요.'],
  shared_registration_required: [
    'A reviewed local project, pair and frozen protocol are required.',
    '검토된 로컬 프로젝트·하네스 쌍·동결 protocol이 필요합니다.'
  ],
  shared_registration_mismatch: ['The shared pair does not match the frozen local settings.', '공유 하네스 쌍이 동결된 로컬 기준과 일치하지 않습니다.'],
  shared_settings_conflict: [
    'This comparison ID already has different content. Use a new ID.',
    '같은 비교 ID에 다른 내용이 연결돼 있습니다. 새 ID를 사용하세요.'
  ],
  local_operation_failed: [
    'The operation could not be completed. Refresh the current state and check setup.',
    '처리하지 못했습니다. 현재 상태를 새로 확인하고 설정을 점검하세요.'
  ],
  ui_setup_conflict: [
    'A setup with the same ID has different contents. Existing settings were kept; no settings from this file were connected.',
    '같은 ID의 설정 내용이 다릅니다. 기존 설정을 유지했으며 이 파일의 설정은 연결하지 않았습니다.'
  ],
  ui_state_changed: [
    'The task changed in another window or the CLI. Review the updated state before retrying.',
    '다른 창이나 CLI에서 작업이 변경됐습니다. 최신 상태를 확인한 뒤 다시 진행하세요.'
  ],
  ui_action_uncertain: [
    'A previous action has an uncertain result. Check the saved state before retrying.',
    '이전 동작의 결과가 불확실합니다. 저장된 상태를 먼저 확인하세요.'
  ],
  binding_provider_unavailable: [
    'Session instrumentation has not been configured. Review the project hook proposal before installing it.',
    '세션 계측 설정이 없습니다. 설치 전에 프로젝트 hook 제안을 검토하세요.'
  ],
  binding_source_unqualified: [
    'Ordinary session and family sources need qualification before real collection.',
    '일반 세션과 가족 원본은 실측 전에 지원 검증이 필요합니다.'
  ],
  binding_scope_revoked: [
    'Observation authority for this task was revoked. Collection is stopped; it cannot be restored here.',
    '이 작업의 관측 권한이 철회됐습니다. 수집을 중단했으며 이 화면에서는 복구할 수 없습니다.'
  ],
  binding_identity_unavailable: [
    'No session hook evidence was confirmed. Invoke harness-connect in the parent and check again.',
    '세션 hook 기록을 확인하지 못했습니다. 부모 세션에서 harness-connect를 호출한 뒤 다시 확인하세요.'
  ],
  binding_identity_ambiguous: [
    'More than one session identity was found. Use a separate fresh parent session and reconnect.',
    '세션 신원을 하나로 확인하지 못했습니다. 별도의 새 부모 세션에서 다시 연결하세요.'
  ],
  binding_session_conflict: [
    'This session belongs to another task. Check the selected task before reconnecting.',
    '이 세션이 다른 작업에 연결돼 있습니다. 연결할 작업을 확인하세요.'
  ],
  binding_scope_mismatch: [
    'The session does not belong to this registered project. Open the selected project before connecting.',
    '세션이 등록된 프로젝트와 일치하지 않습니다. 선택한 프로젝트에서 연결하세요.'
  ],
  claude_receipt_missing: [
    'No session hook record was found after invocation. Check the project skill and workspace trust, then invoke again in the parent.',
    '호출 후 세션 hook 기록이 없습니다. 프로젝트 스킬과 작업 공간 신뢰 설정을 확인한 뒤 부모 세션에서 다시 호출하세요.'
  ],
  claude_receipt_expired: [
    'The session hook record is no longer fresh. Invoke harness-connect again in the current parent.',
    '세션 hook 기록이 오래됐습니다. 현재 부모 세션에서 harness-connect를 다시 호출하세요.'
  ],
  claude_source_version_unsupported: [
    'The observed Claude version is unsupported for this connection route. Review exact source support before retrying.',
    '관측된 Claude 버전은 이 연결 경로에서 미지원입니다. 정확한 원본 지원 조건을 확인하세요.'
  ],
  claude_source_version_unobserved: [
    'The session record does not establish a Claude version. Review the source; do not substitute the configured version.',
    '세션 기록에서 Claude 버전을 확인하지 못했습니다. 원본을 검토하세요. 설정 버전으로 대신 확인 처리하지 않습니다.'
  ],
  claude_project_mismatch: [
    'Open a fresh working session in the selected project, not another checkout or application session.',
    '다른 checkout이나 적용 세션이 아닌 선택한 프로젝트의 새 작업 세션에서 연결하세요.'
  ],
  claude_baseline_limit: [
    'The session baseline exceeds the reviewed bound. Use a fresh working session within the approved scope.',
    '세션 기준점이 검토된 범위를 초과했습니다. 승인된 범위의 새 작업 세션을 사용하세요.'
  ],
  claude_baseline_incomplete: [
    'The baseline is incomplete. Collection has not started; review the native source before reconnecting.',
    '세션 기준점을 완전히 확인하지 못해 수집을 시작하지 않았습니다. 원본을 확인한 뒤 다시 연결하세요.'
  ],
  compatibility_invalidated: [
    'This source compatibility was invalidated. Collection is blocked until the source is reviewed.',
    '이 원본의 호환성이 무효화됐습니다. 원본을 검토할 때까지 수집을 차단합니다.'
  ],
  observation_running: ['Measurement is already active.', '측정이 이미 진행 중입니다.'],
  binding_reconnect_required: [
    'Invoke harness-connect once in the current parent session to resume from a fresh baseline.',
    '현재 부모 세션에서 harness-connect를 한 번 호출해 새 기준점부터 재개하세요.'
  ],
  external_preparation_required: ['Prepare the assigned configuration first.', '배정된 구성을 먼저 준비하세요.'],
  external_surface_busy: [
    'Another task owns this project configuration. Finish or release that task first.',
    '다른 작업이 이 프로젝트의 구성을 사용 중입니다. 해당 작업을 종료하거나 준비를 해제하세요.'
  ],
  external_configuration_drift: [
    'Configuration changed. Earlier observations remain; inspect and prepare again.',
    '구성이 변경됐습니다. 기존 관측은 유지됩니다. 내용을 확인하고 다시 준비하세요.'
  ],
  external_preimage_unapproved: [
    'Existing files differ from approved contents. Your edits are preserved.',
    '기존 파일이 허용된 내용과 다릅니다. 사용자 변경을 보존했습니다.'
  ],
  external_ticket_required: ['Get fresh session instructions before connecting.', '연결 전에 새 세션 시작 안내를 받으세요.'],
  external_ticket_mismatch: ['This session does not match the current start instructions.', '이 세션은 현재 시작 안내와 일치하지 않습니다.'],
  external_native_context_unverified: [
    'The session configuration has not been verified. Measurement cannot start.',
    '세션에 전달된 설정을 확인하지 못해 측정을 시작할 수 없습니다.'
  ],
  external_collection_unsupported: ['This external session is not supported for collection.', '이 외부 세션은 관측을 지원하지 않습니다.'],
  external_source_unsupported: [
    'This source is not admitted. Tool-launched Claude CLI support is a separate path.',
    '이 원본은 연결 미지원입니다. 도구 실행 Claude CLI 지원과는 별개입니다.'
  ],
  external_stop_acknowledgement_required: [
    'Stop the external agent yourself before changing its preparation.',
    '준비를 변경하기 전에 외부 에이전트를 직접 종료하세요.'
  ],
  workflow_run_active: ['An observer is already running. Pause and wait for settlement.', '관측기가 실행 중입니다. 일시중단 후 종료 확인을 기다리세요.'],
  catalog_source_not_configured: [
    'No verified online update source is configured. Existing prices are retained.',
    '검증된 온라인 갱신 출처가 설정되지 않았습니다. 기존 가격을 유지합니다.'
  ],
  picker_unavailable: [
    'The local picker is unavailable. Enter an explicit directory below.',
    '로컬 선택기를 사용할 수 없습니다. 아래에 디렉토리를 입력하세요.'
  ],
  git_baseline_unavailable: ['Select a Git project with an existing HEAD commit.', '기존 HEAD 커밋이 있는 Git 프로젝트를 선택하세요.'],
  invalid_transition: ['This action is unavailable in the current state.', '현재 상태에서는 이 동작을 할 수 없습니다.'],
  inactive_observation: ['There is no active observation interval.', '활성 관측 구간이 없습니다.'],
  finalized: ['The result is final. Start a new task for additional work.', '확정된 결과입니다. 추가 작업은 새 작업으로 시작하세요.'],
  external_connection_required: ['Connect a verified fresh session first.', '먼저 확인된 새 세션을 연결하세요.'],
  external_window_closed: ['The observation window has ended. Assess the result.', '관찰 기한이 종료됐습니다. 결과를 판정하세요.'],
  configuration_ready: ['Configuration is already prepared.', '구성 준비를 마쳤습니다.'],
  external_connection_unverified: [
    'The selected session does not prove the current startup context. No measurement window was started.',
    '선택한 세션에서 현재 시작 설정을 확인하지 못했습니다. 관측 기한을 시작하지 않았습니다.'
  ],
  external_ticket_used: ['This start ticket was already used. Get new-session instructions.', '이미 사용한 시작 안내입니다. 새 세션 안내를 받으세요.'],
  invalid_criteria: ['Confirm the registered criteria in optional details.', '선택 항목에서 등록된 기준을 확인하세요.'],
  criteria_required: ['Assess all fixed criteria in the optional details.', '선택 항목에서 모든 고정 기준을 평가하세요.'],
  receipt_directory_missing: [
    'The private receipt directory does not exist. Preview and install from Agent connection setup to create it.',
    'Receipt 디렉토리가 없습니다. 에이전트 연결 설정의 미리보기와 설치로 생성하세요.'
  ],
  receipt_directory_unsafe: [
    'The receipt directory has unsafe permissions. Correct its ownership before connecting.',
    'Receipt 디렉토리 권한이 안전하지 않습니다. 연결 전에 소유권을 수정하세요.'
  ]
};
export function taskReason(code: string, locale: Locale, errorRecruitment: Task['recruitment'], selected: Task | null) {
  const t = (en: string, ko: string) => (locale === 'ko' ? ko : en);
  if (
    selected?.support_details?.context === 'synthetic_validation_only' &&
    ['external_connection_required', 'external_ticket_required', 'binding_provider_unavailable', 'binding_source_unqualified'].includes(code)
  )
    return t(
      'This fixture validates preparation only. It does not require a native connection or enable real measurement.',
      '이 fixture는 준비 상태만 검증합니다. 네이티브 연결은 필요하지 않으며 실측을 허용하지 않습니다.'
    );
  const guidance = taskErrorGuidance(code, locale, errorRecruitment);
  if (guidance) return guidance.message;
  const pair = messages[code];
  return pair ? t(pair[0], pair[1]) : t('Check the setup or connection details before continuing.', '계속하기 전에 설정이나 연결 상세를 확인하세요.');
}
