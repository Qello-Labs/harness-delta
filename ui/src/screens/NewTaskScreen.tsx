import { ordinaryTaskInput } from '../ordinary-task-input';
import type { Task } from '../types';
import { Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { AppModel } from '../hooks/use-app-model';
import { TaskDraftFields } from './TaskDraftFields';
import { NewTaskOptions } from './NewTaskOptions';

export function NewTaskScreen({ model }: { model: AppModel }) {
  const { t, taskMode, setupData, kind, size, busy, online, name, projectData, ordinaryCriteria, project, setup, perform, setName, navigate } = model;
  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold">{t('New task', '새 작업')}</h1>
        <p className="mt-2 text-muted-foreground">
          {t(
            'Choose measurement criteria and prepare here. Open the agent yourself.',
            '작업에 적용할 측정 기준을 선택하고 준비하세요. 에이전트는 직접 여세요.'
          )}
        </p>
      </div>
      <div className="grid gap-6 md:grid-cols-3">
        <Card className="md:col-span-2">
          <CardContent className="space-y-5 p-6">
            <TaskDraftFields model={model} />
            <NewTaskOptions model={model} />
            {taskMode === 'comparison' && setupData && (!setupData.types.includes(kind) || !setupData.sizes.includes(size)) && (
              <p className="text-sm text-destructive">
                {t('Choose a type and size allowed by these measurement criteria.', '이 측정 기준에서 허용한 유형과 크기를 선택하세요.')}
              </p>
            )}
            <div className="flex justify-end">
              <Button
                disabled={
                  busy ||
                  !online ||
                  !name.trim() ||
                  (taskMode === 'ordinary'
                    ? !projectData?.ordinary?.configured || ordinaryCriteria.length === 0
                    : !setupData || setupData.project_id !== project || !setupData.types.includes(kind) || !setupData.sizes.includes(size))
                }
                onClick={() => {
                  const input =
                    taskMode === 'ordinary'
                      ? ordinaryTaskInput({ name, projectId: project, type: kind, size, criterionIds: ordinaryCriteria })
                      : { name, project_id: project, setup_id: setup, type: kind, size };
                  if (!input) return;
                  void perform<Task>('/api/tasks', input).then(value => {
                    if (value) {
                      setName('');
                      navigate('detail', value);
                    }
                  });
                }}
              >
                <Play />
                {t('Prepare measurement', '측정 준비')}
              </Button>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t('What happens next?', '다음 흐름')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="text-sm text-muted-foreground">
              {taskMode === 'ordinary' ? (
                <p>
                  {t(
                    'Configure project → review package installation → connect native Claude → observe → confirm result. No A/B assignment. Native settings remain yours; no backfill and partial cost only.',
                    '프로젝트 설정 → 패키지 설치 검토 → 네이티브 Claude 연결 → 관측 → 결과 확인. A/B 배정은 없습니다. 네이티브 설정은 유지하며 소급 수집 없이 부분 비용만 관측합니다.'
                  )}
                </p>
              ) : (
                <>
                  <p>
                    {t(
                      'Automatic assignment → prepare configuration → get fresh session instructions → connect → observe',
                      '자동 배정 → 구성 준비 → 새 세션 안내 → 연결 → 관측'
                    )}
                  </p>
                  <p>
                    {t(
                      'A/B is assigned automatically and retained across rework. No agent is launched here.',
                      'A/B는 자동 배정되며 재작업에서도 유지됩니다. 여기서 에이전트를 실행하지 않습니다.'
                    )}
                  </p>
                </>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
