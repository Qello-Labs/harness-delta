import { TaskErrorNotice } from '../TaskErrorNotice';
import { LoaderCircle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import type { AppModel } from '../hooks/use-app-model';

export function AppFeedback({ model }: { model: AppModel }) {
  const { loading, t, online, reload, error, locale, errorRecruitment, reason, notice } = model;
  return (
    <>
      {loading && (
        <div role="status" data-bootstrap="loading" className="flex items-center gap-2 py-12">
          <LoaderCircle className="size-5 animate-spin" />
          {t('Loading saved local state…', '저장된 로컬 상태를 불러오는 중…')}
        </div>
      )}
      {!loading && !online && (
        <Alert data-bootstrap="unavailable">
          <AlertTitle>{t('Local service unavailable', '로컬 서비스 연결을 확인하세요')}</AlertTitle>
          <AlertDescription>
            {t(
              'The last displayed values may be stale. Actions remain disabled until current state is read.',
              '마지막 표시가 오래된 상태일 수 있습니다. 최신 상태를 읽기 전까지 동작을 비활성화합니다.'
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void reload();
              }}
            >
              <RefreshCw />
              {t('Reconnect', '다시 확인')}
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {error && <TaskErrorNotice code={error} locale={locale} recruitment={errorRecruitment} fallback={reason(error)} />}
      {notice && (
        <Alert>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}
    </>
  );
}
