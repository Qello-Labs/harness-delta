import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { MeasurementControls } from '../MeasurementControls';
import { PreparationNextAction } from '../PreparationNextAction';
import { TaskNextStep } from '../TaskNextStep';
import type { AppModel } from '../hooks/use-app-model';
import type { Task } from '../types';

export function TaskMeasurement({ model, selected }: { model: AppModel; selected: Task }) {
  const { t, locale, busy, online, taskAction, chooseSession, reason, action, setConfirm } = model;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('Next action', '지금 할 일')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <TaskNextStep task={selected} locale={locale} />
        <PreparationNextAction
          task={selected}
          locale={locale}
          disabled={busy || !online}
          onAction={code => {
            void taskAction(code);
          }}
          onConnect={() => {
            void chooseSession();
          }}
        />
        {selected.measurement.state !== 'waiting_connection' && (
          <MeasurementControls
            task={selected}
            locale={locale}
            busy={busy}
            online={online}
            onAction={code => {
              void taskAction(code);
            }}
            reason={reason}
          />
        )}
        {action('recover')?.enabled && (
          <Button
            variant="outline"
            disabled={busy || !online}
            onClick={() =>
              setConfirm({
                action: 'recover',
                title: t('Recover interrupted observation', '끊긴 관측 복구'),
                description: t(
                  'Confirm that the previous observer is no longer running. A gap is retained; no usage is backfilled.',
                  '이전 관측기가 더 이상 실행되지 않음을 확인하세요. 누락 구간은 유지하며 이전 사용량을 가져오지 않습니다.'
                )
              })
            }
          >
            {t('Recover stopped observer', '중단된 관측기 복구')}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
