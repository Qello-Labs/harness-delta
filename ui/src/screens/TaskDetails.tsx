import { TaskAssignment } from '../OrdinaryObservationSetup';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import type { AppModel } from '../hooks/use-app-model';
import type { Task } from '../types';

export function TaskDetails({ model, selected }: { model: AppModel; selected: Task }) {
  const { t, action, busy, online, setConfirm, locale } = model;
  return (
    <Card>
      <CardContent className="p-6">
        <details>
          <summary className="cursor-pointer font-medium">{t('Connection and task details', '연결·작업 상세')}</summary>
          {action('release')?.enabled && (
            <Button
              className="mt-3"
              variant="outline"
              disabled={busy || !online}
              onClick={() =>
                setConfirm({
                  action: 'release',
                  title: t('Release project preparation', '프로젝트 준비 해제'),
                  description: t(
                    'Confirm that you have stopped the external AI session yourself. This only releases ownership of the managed configuration.',
                    '외부 AI 세션을 직접 종료했음을 확인하세요. 이 동작은 관리 구성의 사용권만 해제합니다.'
                  )
                })
              }
            >
              {t('Release preparation', '준비 해제')}
            </Button>
          )}
          {action('revoke-collection')?.enabled && (
            <Button
              className="mt-3 ml-3"
              variant="outline"
              disabled={busy || !online}
              onClick={() =>
                setConfirm({
                  action: 'revoke-collection',
                  title: t('Revoke collection', '관측 권한 철회'),
                  description: t(
                    'Collection stops permanently for this task. The external agent continues running.',
                    '이 작업의 수집을 영구 중단합니다. 외부 에이전트는 계속 실행됩니다.'
                  )
                })
              }
            >
              {t('Revoke collection', '관측 권한 철회')}
            </Button>
          )}
          <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
            <TaskAssignment task={selected} locale={locale} />
            {[
              [t('Configuration preparation', '설정 파일 준비'), selected.preparation.configuration_evidence],
              [t('Native context evidence', '세션 입력 전달 근거'), selected.preparation.native_context_evidence],
              [t('Fresh session evidence', '새 세션 근거'), selected.preparation.freshness_evidence],
              [t('Actual tool use', '도구 실제 사용'), selected.preparation.tool_use_evidence],
              [t('Task ID', '작업 ID'), selected.id],
              [t('Attempt', '시도'), String(selected.attempt)],
              [
                t('Collection ends', '수집 종료 조건'),
                selected.measurement.end_condition === 'explicit_stop'
                  ? t('Until pause, completion or revocation', '일시정지·완료·권한 철회까지')
                  : (selected.measurement.window.ends_at ?? t('Starts at first verified connection', '최초 확인된 연결 시 시작'))
              ]
            ].map(([label, value]) => (
              <div key={label}>
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="mt-1 break-all">{value ?? '—'}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-4 text-sm text-muted-foreground">
            {t(
              'File preparation, input delivery and actual tool use are separate evidence. Unknown never means verified or zero.',
              '파일 준비·입력 전달·도구 실제 사용은 서로 다른 근거입니다. 미확인은 확인 완료나 0이 아닙니다.'
            )}
          </p>
        </details>
      </CardContent>
    </Card>
  );
}
