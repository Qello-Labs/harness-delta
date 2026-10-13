import { Pause, Play } from 'lucide-react';
import { Button } from './components/ui/button.js';
import type { Locale, Task } from './types.js';
import { claudeConnectionStage } from './claude-connection-state.js';

/** Choose by the linked collection route, never by the native product name. */
export function measurementActionCode(task: Task): 'pause' | 'resume-binding' | 'observe' {
  if (['active', 'starting'].includes(task.measurement.state)) return 'pause';
  return (task.binding?.roots ?? 0) > 0 ? 'resume-binding' : 'observe';
}
export function MeasurementControls({ task, locale, busy, online, onAction, reason }: {
  task: Task; locale: Locale; busy: boolean; online: boolean; onAction: (code: string) => void; reason: (code: string) => string;
}) {
  const t = (en: string, ko: string) => locale === 'ko' ? ko : en;
  if (task.outcome || task.state === 'finalized' || task.measurement.state === 'measurement_ended' || claudeConnectionStage(task)) return null;
  const code = measurementActionCode(task);
  const option = task.actions.find(action => action.code === code);
  const paused = task.measurement.state === 'paused';
  const family = (task.binding?.roots ?? 0) > 0;
  const label = code === 'pause' ? t('Pause measurement', '측정 일시중단') : paused ? t('Resume measurement', '측정 재개') : t('Start measurement', '측정 시작');
  return <div className="space-y-3">
    <p role="status">{task.measurement.state === 'starting' ? t('Starting measurement', '측정 시작 중') : code === 'pause' ? t('Measuring', '측정 중') : paused ? t('Measurement paused', '측정 일시중단') : t('Waiting for measurement', '측정 대기')}</p>
    {family ? <p className="text-sm text-muted-foreground">{t(`Linked sessions · ${task.binding!.roots} parent sessions, ${task.binding!.children} children`, `연결된 세션 · 부모 ${task.binding!.roots}개, 자식 ${task.binding!.children}개`)}</p>
      : task.source && <p className="text-sm text-muted-foreground">{t('Selected session record', '연결된 세션 · 직접 선택한 기록 1개')}</p>}
    <Button className="w-full" disabled={busy || !online || !option?.enabled} onClick={() => onAction(code)}>{code === 'pause' ? <Pause /> : <Play />}{label}</Button>
    {option && !option.enabled && option.reason && <p className="text-sm text-muted-foreground">{reason(option.reason)}</p>}
    <p className="text-sm text-muted-foreground">{code === 'pause'
      ? t('New usage is measured. Pausing measurement leaves the AI running.', '새로 발생한 사용량을 측정합니다. 일시중단해도 AI는 계속 실행됩니다.')
      : paused
        ? family ? t('Resume usage measurement for the linked parent and children. Usage during pauses is excluded.', '연결된 부모와 자식의 사용량 측정을 이어갑니다. 일시중단 중 사용량은 포함하지 않습니다.')
          : t('Resume usage measurement for the selected session record. Usage during pauses is excluded.', '선택한 세션 기록의 사용량 측정을 이어갑니다. 일시중단 중 사용량은 포함하지 않습니다.')
        : t('Connect a session, then start measuring new usage.', '세션을 연결한 뒤 새로 발생하는 사용량 측정을 시작하세요.')}</p>
    <div className="border-t pt-3"><p className="text-sm text-muted-foreground">{t('Control AI startup and exit yourself in your terminal or IDE.', 'AI 실행과 종료는 터미널·IDE에서 직접 제어합니다.')}</p></div>
  </div>;
}
