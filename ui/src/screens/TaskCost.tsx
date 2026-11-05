import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { AppModel } from '../hooks/use-app-model';
import type { Task } from '../types';

export function TaskCost({ model, selected }: { model: AppModel; selected: Task }) {
  const { t } = model;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('Cost information', '비용 안내')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="text-sm text-muted-foreground">
          <p>
            {t(
              'Shown cost covers only observed, priced usage. It is not a complete task total or bill.',
              '표시 비용은 관측되고 단가가 있는 사용량만 포함합니다. 전체 작업 비용이나 청구액이 아닙니다.'
            )}
          </p>
          {selected.price.unpriced_events > 0 && (
            <p>
              {t(
                'Some observed usage has no matched price. Cache writes can be excluded when their duration is missing or unsupported by the selected price basis; their observed tokens remain counted.',
                '일부 관측 사용량에 일치하는 단가가 없습니다. 캐시 기간이 누락되거나 선택한 가격 기준이 해당 기간을 지원하지 않으면 쓰기 비용에서 제외할 수 있습니다. 관측된 토큰은 계속 합산합니다.'
              )}
            </p>
          )}
          <details>
            <summary>{t('Cost calculation details', '비용 계산 상세')}</summary>
            <p className="mt-3 break-all">{selected.price.basis ?? t('Basis not selected', '가격 기준 선택 전')}</p>
            <p>
              {selected.measurement.requests === null
                ? t('No observation yet', '아직 관측 전')
                : t(`${selected.measurement.requests} observed requests`, `관측 요청 ${selected.measurement.requests}개`)}
            </p>
          </details>
        </div>
      </CardContent>
    </Card>
  );
}
