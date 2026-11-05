import { ArrowRight, ListTodo, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type { AppModel } from '../hooks/use-app-model';

export function TasksScreen({ model }: { model: AppModel }) {
  const { t, online, busy, navigate, snapshot, stateLabel } = model;
  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{t('Tasks', '작업')}</h1>
          <p className="mt-2 text-muted-foreground">
            {t('Prepare, connect, measure, then decide the result.', '준비하고 연결해 측정한 뒤 결과를 판정하세요.')}
          </p>
        </div>
        <Button disabled={!online || busy} onClick={() => navigate(snapshot.projects.length ? 'new' : 'setup')}>
          <Play />
          {t('New task', '새 작업')}
        </Button>
      </div>
      <Card>
        <CardContent className="p-6">
          {!snapshot.tasks.length ? (
            online ? (
              <div data-tasks="empty" className="space-y-4 py-12 text-center">
                <ListTodo className="mx-auto size-10 text-muted-foreground" />
                <h2 className="text-lg font-semibold">{t('Start your first task', '첫 작업을 시작하세요')}</h2>
                <p className="text-muted-foreground">
                  {t(
                    'Connect a project to observe ordinary Claude work without comparison settings, or choose a harness comparison.',
                    '프로젝트를 연결해 비교 설정 없이 일반 Claude 작업을 관측하거나 하네스 비교를 선택하세요.'
                  )}
                </p>
                <Button variant="outline" disabled={busy} onClick={() => navigate(snapshot.projects.length ? 'new' : 'setup')}>
                  {snapshot.projects.length ? t('Choose task mode', '작업 모드 선택') : t('Connect project', '프로젝트 연결')}
                </Button>
              </div>
            ) : null
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="py-3">{t('Task', '작업')}</th>
                    <th>{t('Status', '상태')}</th>
                    <th>{t('Project', '프로젝트')}</th>
                    <th>
                      <span className="sr-only">{t('Details', '상세 보기')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.tasks.map(item => (
                    <tr key={item.id} className="border-b last:border-0">
                      <td className="py-4 font-medium">
                        {item.name}
                        {item.attempt > 1 && (
                          <p className="text-xs text-muted-foreground">{t(`${item.attempt - 1} reworks`, `재작업 ${item.attempt - 1}회`)}</p>
                        )}
                      </td>
                      <td>
                        <Badge variant="secondary">{stateLabel(item.status)}</Badge>
                        {!item.outcome && item.measurement.window.started_at && (
                          <p className="mt-1 text-xs text-muted-foreground">{t('Awaiting user review', '결과 확인 전')}</p>
                        )}
                      </td>
                      <td>{snapshot.projects.find(p => p.id === item.project_id)?.name ?? t('Project', '프로젝트')}</td>
                      <td className="text-right">
                        <Button variant="ghost" size="sm" onClick={() => navigate('detail', item)}>
                          {t('Details', '상세 보기')}
                          <ArrowRight />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}
