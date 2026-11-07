import type { Locale } from './types.js';

const codes = [
  ['not_available', 'Not available', '제공되지 않음'],
  ['unsupported', 'Unsupported', '지원되지 않음'],
  ['source_error', 'Source error', '원본 오류'],
  ['paused', 'Paused', '일시 정지'],
  ['offline', 'Offline', '오프라인'],
  ['counter_reset', 'Counter reset', '카운터 초기화'],
  ['scope_mismatch', 'Scope mismatch', '범위 불일치'],
  ['unknown_parent', 'Unknown parent', '부모 미확인'],
  ['incomplete', 'Incomplete coverage', '불완전한 관측 범위'],
  ['overflow', 'Counter overflow', '카운터 범위 초과'],
  ['excluded_intervals', 'Excluded intervals', '제외 구간'],
  ['unsupported_profile', 'Unsupported complete-cost profile', '전체 비용 프로필 미지원'],
  ['missing_value', 'Missing reading', '누락된 읽기'],
  ['source_unverified', 'Unverified source', '미검증 원본'],
  ['unknown_components', 'Unknown billing components', '과금 구성 요소 미확인'],
  ['unknown_model', 'Unknown model', '모델 미확인'],
  ['unknown_attribution', 'Unknown attribution', '귀속 미확인'],
  ['unpriced_component', 'Unpriced component', '단가 없는 구성 요소'],
  ['binding_scope_revoked', 'Collection scope revoked', '수집 범위 철회'],
  ['binding_scope_mismatch', 'Collection scope mismatch', '수집 범위 불일치'],
  ['compatibility_invalidated', 'Compatibility invalidated', '호환성 무효화'],
  ['binding_window_unavailable', 'Window collection unavailable', 'Window 수집 사용 불가'],
  ['binding_window_activation_required', 'Separate activation required', '별도 활성화 필요'],
  ['binding_window_trial_expired', 'Trial expired', '시험 유효기간 만료'],
  ['binding_window_trial_budget_exhausted', 'Trial budget exhausted', '시험 예산 소진'],
  ['source_only', 'Source-only evidence', '원본 기반 증거'],
  ['publisher_verified_local_pin', 'Publisher-verified local pin', '배포자 검증 로컬 pin'],
  ['codex-binding-root-window-v1', 'Codex root reference (codex-binding-root-window-v1)', 'Codex root 참고 관측 (codex-binding-root-window-v1)'],
  ['claude-binding-root-window-v1', 'Claude root reference (claude-binding-root-window-v1)', 'Claude root 참고 관측 (claude-binding-root-window-v1)'],
  ['root_creation_header', 'Root-creation header', 'Root 생성 헤더'],
  ['scoped_source', 'Scoped source', '범위가 확인된 원본'],
  ['verified_disk_assets', 'Verified disk assets', '검증된 디스크 자산'],
  ['unavailable', 'Unavailable', '미확정'],
  ['unverified', 'Unverified', '미검증'],
  ['missing', 'Unobserved', '미관측'],
  ['partial', 'Partial', '부분'],
  ['invalidated', 'Excluded', '제외'],
  ['disabled', 'Collection disabled', '수집 비활성'],
  ['ordinary-window-task-v1', 'Root-reference report', 'Root 참고 관측 보고서'],
  ['USD', 'USD', 'USD'],
  ['invalid_cutoff', 'Invalid cutoff', '잘못된 cutoff'],
  ['unknown_task', 'Unknown task', '알 수 없는 작업'],
  ['invalid_ui_request', 'Invalid report request', '잘못된 보고서 요청'],
  ['local_authorization_required', 'Local authorization required', '로컬 권한 필요'],
  ['local_operation_failed', 'Could not read saved evidence', '저장된 증거 읽기 실패']
] as const;

export function windowReportCode(value: string, locale: Locale): { readonly code: string; readonly label: string } {
  const entry = codes.find(row => row[0] === value);
  return entry
    ? { code: entry[0], label: entry[locale === 'ko' ? 2 : 1] }
    : { code: 'unknown', label: locale === 'ko' ? '기타 또는 알 수 없는 코드' : 'Other or unknown code' };
}
