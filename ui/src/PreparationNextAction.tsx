import { Button } from './components/ui/button.js';
import type { Locale, Task } from './types.js';
import { claudeConnectionStage } from './claude-connection-state.js';

export function preparationAction(task: Task): string | null {
  if (task.outcome || task.measurement.state !== 'waiting_connection' || task.application) return null;
  if (task.actions.some(a => a.code === 'prepare' && a.enabled)) return 'prepare';
  if (task.actions.some(a => a.code === 'apply' && a.enabled)) return 'apply';
  if (task.support_details?.context === 'synthetic_validation_only') return null;
  if (task.support_details?.connection_route === 'family') return 'session-connect';
  if (task.support_details?.ticket === 'unsupported') return null;
  if (task.actions.some(a => a.code === 'session-connect' && a.enabled)) return 'session-connect';
  if (!task.startup && task.actions.some(a => a.code === 'ticket' && a.enabled)) return 'ticket';
  if (task.actions.some(a => a.code === 'connect' && a.enabled)) return 'connect';
  return null;
}

export function PreparationNextAction({ task, locale, disabled, onAction, onConnect }: {
  task: Task; locale: Locale; disabled: boolean; onAction: (code: string) => void; onConnect: () => void;
}) {
  const code = preparationAction(task);
  const t = (en: string, ko: string) => locale === 'ko' ? ko : en;
  if (claudeConnectionStage(task)) return null;
  if (!code) {
    if (!task.outcome && task.measurement.state === 'waiting_connection' && task.support_details?.context === 'synthetic_validation_only') return <p role="status" data-preparation-action="validation-ready">{t('Configuration is prepared. Review this validation fixture only; use a separately reviewed real setup for actual work. No native connection is needed here.', '구성 준비를 마쳤습니다. 검증 fixture만 확인하세요. 실제 작업에는 별도로 검토된 실측 설정을 사용하세요. 여기서는 네이티브 연결이 필요하지 않습니다.')}</p>;
    if (!task.outcome && task.measurement.state === 'waiting_connection' && task.support_details?.ticket === 'unsupported' && !task.application) return <p role="status" data-preparation-action="unsupported-route">{t('This configured version has no ticket connection route. Review the separate launch or family route and its required inputs before starting real work.', '이 설정 버전에는 ticket 연결 경로가 없습니다. 실제 작업 전에 별도 launch·가족 경로와 필요한 입력을 검토하세요.')}</p>;
    return null;
  }
  if (code === 'session-connect') return <p role="status">{task.actions.some(a => a.code === 'session-connect' && a.enabled) ? t('Use harness-connect in the authorized fresh parent session.', '관측을 허용한 새 부모 세션에서 harness-connect를 사용하세요.') : t('Review instrumentation and exact source scope first. The reviewed local pilot command must authorize observation before connecting; no ticket can authorize this family route.', '계측과 정확한 원본 범위를 먼저 검토하세요. 연결 전에 검토된 로컬 pilot 명령으로 관측 권한을 지정해야 합니다. ticket으로 이 가족 경로를 허용할 수는 없습니다.')}</p>;
  const labels: Record<string, string> = {
    prepare: t('Retry preparation', '준비 재시도'),
    apply: t('Apply prepared configuration', '준비한 구성 적용'),
    ticket: t('Get new-session instructions', '새 세션 안내 받기'),
    connect: t('Choose session and connect', '세션 선택 후 연결'),
  };
  return <Button data-preparation-action={code} disabled={disabled} onClick={() => code === 'connect' ? onConnect() : onAction(code)}>{labels[code]}</Button>;
}
