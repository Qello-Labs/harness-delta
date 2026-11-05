import { Help } from '../app-controls';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { AppModel } from '../hooks/use-app-model';

export function SetupPrices({ model }: { model: AppModel }) {
  const { t, snapshot, busy, online, perform, setNotice, reason } = model;
  return (
    <Card className="h-fit">
      <CardHeader>
        <CardTitle>
          <span className="inline-flex items-center gap-1">
            {t('Reference prices', '기준 가격')}
            <Help label={t('Reference prices', '기준 가격')}>
              {t(
                'The fixed provider verifies price data. Refresh does not change a running task’s pinned basis.',
                '정해진 제공자가 가격을 확인합니다. 갱신해도 진행 중 작업의 고정된 기준은 바꾸지 않습니다.'
              )}
            </Help>
          </span>
        </CardTitle>
        <CardDescription>{t('Supplied by the tool. No effort-by-effort price entry.', '도구가 제공합니다. effort별 단가 입력은 없습니다.')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm">
          {snapshot.catalog?.online_source?.status === 'configured'
            ? t('Update source configured; availability is checked on refresh.', '갱신 출처 설정됨 · 갱신 시 제공 여부를 확인합니다.')
            : t(
                'Online update source is not configured. Bundled verified prices remain available.',
                '온라인 갱신 출처가 설정되지 않았습니다. 내장된 검증 가격은 사용할 수 있습니다.'
              )}
        </p>
        <Button
          variant="outline"
          disabled={busy || !online}
          onClick={() => {
            void perform<{ status: string; reason?: string }>('/api/catalog/refresh', {}).then(value => {
              if (value)
                setNotice(
                  value.status === 'failed'
                    ? reason(value.reason ?? 'catalog_unavailable')
                    : t(
                        'Price information checked. Existing comparisons retain their basis.',
                        '가격 정보를 확인했습니다. 진행 중 비교는 기존 기준을 유지합니다.'
                      )
                );
            });
          }}
        >
          <RefreshCw />
          {t('Refresh prices', '가격 정보 갱신')}
        </Button>
        <details className="text-sm">
          <summary>{t('Price basis details', '가격 기준 상세')}</summary>
          <dl className="mt-3 space-y-2">
            <div>
              <dt>{t('Catalog version', '카탈로그 버전')}</dt>
              <dd>{snapshot.catalog?.catalog_version ?? '—'}</dd>
            </div>
            <div>
              <dt>{t('Provider verification date', '제공자 가격 확인일')}</dt>
              <dd>{snapshot.catalog?.verified_at ?? '—'}</dd>
            </div>
          </dl>
          <p className="mt-3 text-muted-foreground">
            {t(
              'Updates apply to future comparisons. Unknown prices retain token observations; prices are reference rates, not bills.',
              '갱신은 새 비교에 적용합니다. 단가 미확정에도 관측 토큰을 유지하며 기준 요금은 청구액이 아닙니다.'
            )}
          </p>
        </details>
      </CardContent>
    </Card>
  );
}
