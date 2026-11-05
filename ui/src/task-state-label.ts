import type { Locale } from './types';
export function taskStateLabel(value: string, locale: Locale) {
  const t = (en: string, ko: string) => (locale === 'ko' ? ko : en);
  const states: Record<string, [string, string]> = {
    validation_ready: ['Validation configuration ready', '검증 구성 준비 완료'],
    blocked_configuration: ['Configuration blocked', '구성 확인 필요'],
    measurement_ended: ['Measurement ended', '측정 종료'],
    draft: ['Draft', '초안'],
    waiting_connection: ['Waiting for connection', '연결 대기'],
    connected: ['Connected / ready to observe', '연결 완료 · 관측 대기'],
    starting: ['Starting observation', '관측 시작 중'],
    preparation_needed: ['Preparation needed', '준비 필요'],
    registered: ['Prepared / waiting', '준비·연결 대기'],
    waiting_for_session: ['Waiting for session', '세션 연결 대기'],
    configuration_verified: ['Waiting for session', '세션 연결 대기'],
    observing: ['In progress', '진행 중'],
    measuring: ['In progress', '진행 중'],
    active: ['In progress', '진행 중'],
    paused: ['Paused', '일시정지'],
    stopped: ['Awaiting review', '결과 확인 전'],
    ended: ['Awaiting review', '결과 확인 전'],
    success: ['Success', '성공'],
    failed: ['Failed', '실패'],
    aborted: ['Abandoned', '포기'],
    finalized: ['Final result', '결과 확정']
  };
  const pair = states[value];
  return pair ? t(pair[0], pair[1]) : t('Check connection', '연결 확인 필요');
}
