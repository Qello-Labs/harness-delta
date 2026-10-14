import type { Locale, Task } from './types';
import { claudeConnectionStage } from './claude-connection-state.js';

export function TaskNextStep({ task, locale }: { task: Task; locale: Locale }) {
  const t = (en: string, ko: string) => locale === 'ko' ? ko : en;
  if (task.support_details?.context === 'synthetic_validation_only') return <p className="text-sm">
    {t('Review this synthetic fixture only. It does not enable real measurement.', '합성 검증 설정만 확인하세요. 실제 측정은 허용하지 않습니다.')}
  </p>;
  const applicationSteps: Record<string, string> = {
    awaiting_application: t('Choose the application workspace, then prepare a fresh application session.', '본문에서 적용할 작업 공간을 확인하고 새 적용 세션을 준비하세요.'),
    awaiting_session: t('Continue application in the agent window. If it did not open, copy the context and open it yourself.', '에이전트 창에서 적용을 진행하세요. 창이 열리지 않았다면 문맥을 복사해 직접 여세요.'),
    applying: t('Review the application session and reported file changes. Do not connect it for measurement.', '적용 세션과 보고된 파일 변경을 확인하세요. 이 세션은 측정에 연결하지 마세요.'),
    blocked_configuration: t('Resolve the configuration issue, then retry preparation for this task.', '구성 문제를 해결한 뒤 같은 작업의 준비를 재시도하세요.'),
    abandoned: t('Inspect the workspace and prepare a new application context. Previous edits remain.', '작업 공간을 확인하고 새 적용 문맥을 준비하세요. 기존 변경은 유지됩니다.'),
    failed: t('Review the application failure and file changes before continuing.', '적용 실패 원인과 파일 변경을 먼저 확인하세요.'),
  };
  if (task.application && task.application.state !== 'applied') return <p className="text-sm">
    {applicationSteps[task.application.state] ?? t('Check the application state before proceeding.', '하네스 적용 상태를 확인한 뒤 진행하세요.')}
  </p>;
  if (claudeConnectionStage(task)) return <p className="text-sm">{t('Follow the Claude connection card. It shows the next available action and confirms measurement separately.',
    '본문의 Claude 연결 안내를 따르세요. 다음 동작과 측정 상태를 확인할 수 있습니다.')}</p>;
  const measurementSteps: Record<string, string> = {
    waiting_connection: task.application
      ? t('Use the working-session guidance to connect a separate fresh session after source authorization.', '원본 관측 권한을 확인한 뒤 작업 세션 안내로 별도의 새 세션을 연결하세요.')
      : t('Complete preparation and review connection requirements before starting work.', '준비와 세션 연결 조건을 확인한 뒤 실제 작업을 시작하세요.'),
    starting: t('Wait for measurement to become active before starting work.', '측정 중으로 바뀐 것을 확인한 뒤 작업을 시작하세요.'),
    active: t('Continue work in the connected session. Review the result when finished.', '연결된 세션에서 작업하세요. 작업을 마치면 결과를 검토하세요.'),
    paused: t('Measurement is paused. Paused usage is excluded; the AI may still be running.', '측정이 일시중단됐습니다. 중단 구간은 제외되며 AI는 계속 실행될 수 있습니다.'),
    measurement_ended: t('Review the result and record your decision below.', '아래에서 작업 결과를 검토하고 판정하세요.'),
  };
  return <p className="text-sm">{measurementSteps[task.measurement.state]
    ?? t('Check the measurement state and review the task result.', '측정 상태와 작업 결과를 확인하세요.')}</p>;
}
