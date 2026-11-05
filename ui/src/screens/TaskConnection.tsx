import { Action } from '../app-controls';
import { GitBranch, Link } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { AppModel } from '../hooks/use-app-model';
import type { Task } from '../types';

export function TaskConnection({ model, selected }: { model: AppModel; selected: Task }) {
  const { t, action, setNotice, busy, online, perform, taskAction, reason } = model;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('Prepare and connect', '준비와 연결')}</CardTitle>
        <CardDescription>
          {t(
            'Start a fresh session after preparation. Your model and effort choices remain in the native agent.',
            '준비 후 새 세션을 여세요. 모델과 effort는 네이티브 에이전트에서 선택합니다.'
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-3">
          {selected.status === 'blocked_configuration' && (
            <Action code="prepare" variant="outline">
              {t('Retry same task preparation', '같은 작업 준비 재시도')}
            </Action>
          )}
          {action('apply') && (
            <Action code="apply">
              <GitBranch />
              {t('Apply prepared configuration', '준비한 구성 적용')}
            </Action>
          )}
          {action('ticket') && (
            <Action code="ticket" variant="outline">
              {t('Get new-session instructions', '새 세션 안내 받기')}
            </Action>
          )}
        </div>
        {selected.startup && (
          <div className="space-y-3 rounded-lg border bg-muted p-4">
            <h3 className="font-medium">{t('Open a new session yourself', '새 세션을 직접 여세요')}</h3>
            <p className="text-sm text-muted-foreground">
              {t(
                'Copy these instructions to your usual terminal. This passes the selected harness; it does not prove tool use.',
                '시작 안내를 평소 터미널에 복사하세요. 선택된 하네스를 전달하며 도구 실제 사용을 증명하지는 않습니다.'
              )}
            </p>
            <textarea
              className="w-full rounded-md border bg-background p-3 font-mono text-xs"
              aria-label={t('Session start command', '세션 시작 명령')}
              readOnly
              rows={4}
              value={selected.startup.start_command}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void navigator.clipboard
                  .writeText(selected.startup!.start_command)
                  .then(() => setNotice(t('Copied. Open a new session yourself, then connect.', '복사했습니다. 새 세션을 직접 연 뒤 연결하세요.')))
                  .catch(() => setNotice(t('Select and copy the instructions manually.', '안내를 선택해 직접 복사하세요.')));
              }}
            >
              {t('Copy instructions', '시작 안내 복사')}
            </Button>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="outline"
            disabled={busy || !online || !action('connect')?.enabled}
            onClick={() => {
              void perform<{ selection: { handle: string; label: string } | null }>(`/api/tasks/${selected.id}/session-picker`, {}, selected.version).then(
                value => {
                  if (value?.selection) void taskAction('connect', { source_handle: value.selection.handle });
                }
              );
            }}
          >
            <Link />
            {t('Choose session and connect', '세션 선택 후 연결')}
          </Button>
          {selected.source && <span className="text-sm text-muted-foreground">{selected.source.label}</span>}
        </div>
        {action('connect')?.reason && !action('connect')?.enabled && <p className="text-sm text-muted-foreground">{reason(action('connect')!.reason!)}</p>}
        <p className="text-sm text-muted-foreground">
          {t(
            'Wait for Measuring before starting actual work. Prior usage is excluded; already-open sessions are not converted.',
            '측정 중 확인 후 실제 작업을 시작하세요. 이전 사용량은 제외하며 이미 열린 세션을 전환하지 않습니다.'
          )}
        </p>
      </CardContent>
    </Card>
  );
}
