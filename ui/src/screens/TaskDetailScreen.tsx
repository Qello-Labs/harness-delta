import { OrdinaryObservationSetup } from '../OrdinaryObservationSetup';
import { ClaudeConnection } from '../ClaudeConnection.js';
import { HarnessApplication } from '../HarnessApplication';
import { TaskErrorNotice } from '../TaskErrorNotice';
import { AssignedHarness } from '../AssignedHarness';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { SupportGuidance } from '../SupportGuidance';
import type { AppModel } from '../hooks/use-app-model';
import type { Task } from '../types';
import { TaskSummary } from './TaskSummary';
import { TaskConnection } from './TaskConnection';
import { TaskOutcome } from './TaskOutcome';
import { TaskDetails } from './TaskDetails';
import { TaskMeasurement } from './TaskMeasurement';
import { TaskCost } from './TaskCost';
import { SessionFamily } from './SessionFamily';

export function TaskDetailScreen({ model, selected }: { model: AppModel; selected: Task }) {
  const {
    navigate,
    t,
    stateLabel,
    error,
    locale,
    errorRecruitment,
    reason,
    action,
    busy,
    online,
    taskAction,
    applySelectedHarness,
    shownHandoffs,
    snapshot,
    perform,
    setConfirm
  } = model;
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <button className="text-sm text-muted-foreground" onClick={() => navigate('tasks')}>
            {t('← Tasks', '← 작업 목록')}
          </button>
          <h1 className="mt-2 text-2xl font-semibold">{selected.name}</h1>
        </div>
        <Badge variant="secondary">{stateLabel(selected.status)}</Badge>
      </div>
      <TaskSummary model={model} selected={selected} />
      <div className="grid gap-6 md:grid-cols-3">
        <div className="space-y-6 md:col-span-2">
          {selected.reason && selected.reason !== error && (
            <TaskErrorNotice code={selected.reason} locale={locale} recruitment={errorRecruitment} fallback={reason(selected.reason)} />
          )}
          {selected.mode !== 'ordinary' && (
            <AssignedHarness
              task={selected}
              locale={locale}
              origin={location.origin}
              connectBlocker={(() => {
                const connect = action('session-connect');
                return connect?.enabled
                  ? null
                  : connect?.reason
                    ? reason(connect.reason)
                    : t('This task cannot be connected in its current state.', '현재 상태에서는 이 작업을 연결할 수 없습니다.');
              })()}
            />
          )}
          {selected.mode !== 'ordinary' && !selected.outcome && selected.application && (
            <HarnessApplication
              key={`application:${selected.id}`}
              task={selected}
              locale={locale}
              busy={busy || !online}
              onAction={taskAction}
              onApply={applySelectedHarness}
              shownHandoffs={shownHandoffs.current}
            />
          )}
          {selected.mode !== 'ordinary' &&
            !selected.outcome &&
            !selected.application &&
            selected.support_details?.context !== 'synthetic_validation_only' &&
            selected.support_details?.connection_route !== 'family' &&
            selected.support_details?.ticket !== 'unsupported' && <TaskConnection model={model} selected={selected} />}
          <ClaudeConnection
            key={`connection:${selected.id}`}
            task={selected}
            projectName={snapshot.projects.find(project => project.id === selected.project_id)?.name ?? selected.project_id}
            origin={location.origin}
            locale={locale}
            busy={busy}
            online={online}
            onAction={code => {
              void taskAction(code);
            }}
            reason={reason}
            installation={
              selected.mode === 'ordinary' ? (
                <OrdinaryObservationSetup projectId={selected.project_id} locale={locale} busy={busy || !online} perform={perform} />
              ) : undefined
            }
          />
          <SessionFamily task={selected} />
          <TaskOutcome model={model} selected={selected} />
          <TaskDetails model={model} selected={selected} />
        </div>
        <aside className="space-y-6">
          {selected.mode !== 'ordinary' && !selected.outcome && <TaskMeasurement model={model} selected={selected} />}
          {selected.outcome && action('release')?.enabled && (
            <Card>
              <CardHeader>
                <CardTitle>{t('Prepare for the next task', '다음 작업 준비')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  {t(
                    'Stop the external AI yourself before preparing another task in this project.',
                    '이 프로젝트의 다음 작업을 준비하려면 외부 AI를 먼저 직접 종료하세요.'
                  )}
                </p>
                <Button
                  variant="outline"
                  disabled={busy || !online}
                  onClick={() =>
                    setConfirm({
                      action: 'release',
                      title: t('Confirm external session stopped', '외부 세션 종료 확인'),
                      description: t(
                        'Confirm that you stopped the external AI yourself. This allows preparing another task; it does not stop the AI for you.',
                        '외부 AI를 직접 종료했음을 확인하세요. 다음 작업을 준비할 수 있게 하며 AI를 대신 종료하지는 않습니다.'
                      )
                    })
                  }
                >
                  {t('Confirm AI stopped', '외부 AI 종료 확인')}
                </Button>
              </CardContent>
            </Card>
          )}
          {selected.support_details && selected.support_details.context !== 'synthetic_validation_only' && (
            <Card>
              <CardContent className="p-5">
                <SupportGuidance support={selected.support_details} locale={locale} compact />
              </CardContent>
            </Card>
          )}
          <TaskCost model={model} selected={selected} />
        </aside>
      </div>
    </>
  );
}
