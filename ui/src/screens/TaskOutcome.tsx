import { Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import type { AppModel } from '../hooks/use-app-model';
import type { Task } from '../types';

export function TaskOutcome({ model, selected }: { model: AppModel; selected: Task }) {
  const { t, stateLabel, locale, navigate, busy, online, action, setConfirm, taskMenu, setTaskMenu, reason, criteria, setCriteria } = model;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('Task outcome', '작업 결과')}</CardTitle>
        <CardDescription>
          {selected.outcome
            ? t('Recorded by user confirmation.', '사용자 확인으로 기록했습니다.')
            : t('Did the result fulfill the original request?', '결과가 원래 요청한 작업을 충족했나요?')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {selected.outcome ? (
          <>
            <p>
              {stateLabel(selected.outcome.status)} · {new Date(selected.outcome.assessed_at).toLocaleString(locale)}
            </p>
            <p className="text-sm text-muted-foreground">{t('For additional requirements, start a new task.', '추가 요구사항은 새 작업으로 시작하세요.')}</p>
            <Button variant="outline" onClick={() => navigate('new')}>
              {t('New task', '새 작업')}
            </Button>
          </>
        ) : (
          <>
            <div className="flex flex-wrap gap-3">
              <Button
                disabled={busy || !online || !action('finish-success')?.enabled}
                onClick={() =>
                  setConfirm({
                    action: 'finish-success',
                    title: t('Confirm successful completion', '성공 확정 확인'),
                    description: t(
                      'Success records the reviewed criteria as fulfilled. You cannot add rework after confirmation.',
                      '검토된 완료 기준을 충족했다고 기록합니다. 성공으로 확정하면 이 작업에 재작업을 추가할 수 없습니다.'
                    )
                  })
                }
              >
                <Check />
                {t('Complete successfully', '성공으로 완료')}
              </Button>
              <Button
                variant="outline"
                disabled={busy || !online || !action('rework')?.enabled}
                onClick={() =>
                  setConfirm({
                    action: 'rework',
                    title: t('Continue the same request', '같은 요청의 재작업 계속'),
                    description: t(
                      'Keep the assignment and earlier usage. Start a new task if requirements were added.',
                      '배정과 이전 사용량을 유지합니다. 요구사항이 추가됐다면 새 작업으로 시작하세요.'
                    )
                  })
                }
              >
                {t('Continue rework', '재작업 계속')}
              </Button>
              <div className="relative">
                <Button
                  variant="outline"
                  disabled={busy || !online || !(action('finish-failed')?.enabled || action('finish-abandoned')?.enabled)}
                  aria-expanded={taskMenu}
                  onClick={() => setTaskMenu(!taskMenu)}
                >
                  {t('End task ▾', '작업 종료 ▾')}
                </Button>
                {taskMenu && (
                  <div className="absolute right-0 z-10 mt-2 min-w-40 rounded-md border bg-card p-1 shadow-md">
                    {['finish-failed', 'finish-abandoned'].map(code => (
                      <div key={code}>
                        <Button
                          data-task-action={code}
                          variant="ghost"
                          className="w-full"
                          disabled={busy || !online || !action(code)?.enabled}
                          onClick={() => {
                            setTaskMenu(false);
                            setConfirm({
                              action: code,
                              title: t('Confirm final result', '최종 결과 확인'),
                              description: t(
                                'This ends the task. A reason is optional; your external agent is not stopped.',
                                '작업을 종료합니다. 사유는 선택이며 외부 에이전트는 중단하지 않습니다.'
                              )
                            });
                          }}
                        >
                          {code === 'finish-failed' ? t('End as failed', '실패로 종료') : t('Abandon', '포기')}
                        </Button>
                        {!action(code)?.enabled && action(code)?.reason && (
                          <p data-action-blocked={code} className="px-3 pb-2 text-sm text-muted-foreground">
                            {reason(action(code)!.reason!)}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
            {action('finish-success')?.reason && !action('finish-success')?.enabled && (
              <p className="text-sm text-muted-foreground">{reason(action('finish-success')!.reason!)}</p>
            )}
            <p className="text-sm text-muted-foreground">
              {t(
                'Leaving this page keeps the result undecided. Agent exit never marks success.',
                '화면을 나가도 판정 전 상태를 유지합니다. 에이전트 종료는 성공을 확정하지 않습니다.'
              )}
            </p>
            {selected.criteria.length > 1 && (
              <details className="rounded-lg border p-4">
                <summary>{t('Optional details → fixed criteria assessment', '선택 항목 → 세부 기준 평가')}</summary>
                <div className="mt-3 space-y-2">
                  {selected.criteria.map(item => (
                    <Label key={item} className="flex items-center">
                      <input
                        type="checkbox"
                        checked={criteria.includes(item)}
                        onChange={e => setCriteria(values => (e.target.checked ? [...values, item] : values.filter(v => v !== item)))}
                      />
                      {item}
                    </Label>
                  ))}
                </div>
              </details>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
