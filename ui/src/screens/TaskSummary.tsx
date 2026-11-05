import { CostAmounts } from '../CostAmounts.js';
import { Card, CardContent } from '@/components/ui/card';
import type { AppModel } from '../hooks/use-app-model';
import type { Task } from '../types';

export function TaskSummary({ model, selected }: { model: AppModel; selected: Task }) {
  const { t, stateLabel, locale } = model;
  return (
    <Card>
      <CardContent className="grid gap-6 p-6 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <p className="text-sm text-muted-foreground">{t('Measurement', '측정')}</p>
          <p className="mt-1 font-medium">
            {stateLabel(
              selected.support_details?.context === 'synthetic_validation_only' && selected.measurement.state === 'waiting_connection'
                ? selected.status
                : selected.measurement.state
            )}
          </p>
        </div>
        <div>
          <p className="text-sm text-muted-foreground">{t('Result', '결과')}</p>
          <p className="mt-1 font-medium">{selected.outcome ? stateLabel(selected.outcome.status) : t('Awaiting user decision', '사용자 판정 전')}</p>
        </div>
        <div>
          <p className="text-sm text-muted-foreground">{t('Active measurement time', '측정 활성 시간')}</p>
          <p className="mt-1 text-xl font-semibold">
            {selected.measurement.active_ms === null
              ? '—'
              : `${Math.floor(selected.measurement.active_ms / 60000)}${t('m', '분')} ${Math.floor(selected.measurement.active_ms / 1000) % 60}${t('s', '초')}`}
          </p>
        </div>
        <div>
          <p className="text-sm text-muted-foreground">{t('Observed cost', '관측 비용')}</p>
          <p className="mt-1 text-xl font-semibold">
            <CostAmounts value={selected.price} locale={locale} />
            <span className="mt-1 block text-xs font-normal text-muted-foreground">{t('Partial estimate', '부분 추정')}</span>
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
