import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { applicationModeText } from './application-mode';
import type { Locale, Task } from './types';

export type ConnectionRoute = 'synthetic' | 'agent' | 'family' | 'ticket' | 'unsupported';
export function connectionRoute(task: Task): ConnectionRoute {
  if (task.support_details?.context === 'synthetic_validation_only') return 'synthetic';
  if (task.harness?.application_mode === 'agent_applied') return 'agent';
  if (task.support_details?.connection_route === 'family') return 'family';
  return task.support_details?.ticket === 'unsupported' ? 'unsupported' : 'ticket';
}

export function AssignedHarness({ task, locale, origin, connectBlocker }: {
  task: Task; locale: Locale; origin: string; connectBlocker: string | null;
}) {
  const t = (en: string, ko: string) => locale === 'ko' ? ko : en;
  const [copied, setCopied] = useState(false);
  const harness = task.harness;
  if (!harness) return null;
  const route = connectionRoute(task);
  const mode = applicationModeText(harness.application_mode, locale);
  const product = task.support_details?.product ?? '';
  const steps: Record<ConnectionRoute, string[]> = {
    synthetic: [t('This validation fixture needs no native connection. Review the prepared configuration only.', '합성 검증 작업은 네이티브 연결이 필요하지 않습니다. 준비된 구성만 확인하세요.')],
    agent: [
      t('In “Apply harness” below, check the checkout or worktree to change and approve the application.', '아래 ‘하네스 적용’에서 변경할 checkout/worktree를 확인하고 적용을 승인하세요.'),
      t('A separate application session applies it with harness-apply. Review the reported file changes and checks when it finishes.', '별도 적용 세션이 harness-apply로 적용합니다. 끝나면 보고된 파일 변경과 검사 결과를 확인하세요.'),
      t('Once the application is verified and this setup allows connection, open a new working session and connect it with harness-connect. Never connect the session that applied the harness.', '적용이 확인되고 이 설정에서 연결이 허용되면, 새 작업 세션을 열어 harness-connect로 연결하세요. 적용에 사용한 세션은 연결하지 않습니다.'),
    ],
    family: [
      t('Finish the preparation shown under “Next action” first. It writes the assigned instructions to one managed file in the project (.harness-delta-managed/); no other project file is changed.', '먼저 ‘지금 할 일’에 표시된 준비를 마치세요. 준비는 배정된 지침을 프로젝트의 관리 파일(.harness-delta-managed/) 하나에 기록하며, 그 밖의 프로젝트 파일은 바꾸지 않습니다.'),
      t('Open a new agent session in the project.', '프로젝트에서 새 에이전트 세션을 여세요.'),
      t('As its first request, connect with harness-connect using the request below. Start the actual work after this page shows measurement as active.', '첫 요청으로 아래 연결 요청문을 보내 harness-connect로 연결하세요. 이 화면이 측정 중으로 바뀐 뒤 실제 작업을 시작하세요.'),
    ],
    ticket: [
      t('Apply the prepared configuration in “Prepare and connect” below.', '아래 ‘준비와 연결’에서 준비한 구성을 적용하세요.'),
      t('Get new-session instructions and open that session yourself.', '새 세션 안내를 받아 세션을 직접 여세요.'),
      t('Choose the session file and connect it before starting work.', '세션 파일을 선택해 연결한 뒤 작업을 시작하세요.'),
    ],
    unsupported: [t('This configured agent version has no supported connection route. Review the measurement support status before starting work.', '이 설정의 에이전트 버전에는 지원되는 연결 경로가 없습니다. 작업 전에 측정 지원 상태를 확인하세요.')],
  };
  const request = t(
    `Use harness-connect to connect this session to a Harness Delta task. origin: ${origin}, project: ${task.project_id}, task: ${task.id}, product: ${product}. Do not start other work until the connection is confirmed.`,
    `harness-connect로 이 세션을 Harness Delta 작업에 연결해줘. origin: ${origin}, project: ${task.project_id}, task: ${task.id}, product: ${product}. 연결이 확인되기 전에는 다른 작업을 시작하지 마.`,
  );
  return <Card className="break-keep" data-assigned-harness="" data-harness-arm={harness.arm ?? 'unassigned'} data-application-mode={harness.application_mode} data-connection-route={route}>
    <CardHeader><div className="flex flex-wrap items-center justify-between gap-3"><CardTitle>{t('Assigned harness', '배정된 하네스')}</CardTitle>
      <Badge variant="secondary">{harness.arm === null ? t('Assignment pending', '배정 대기') : harness.arm === 'A' ? t('A · Baseline', 'A · 기준') : t('B · Candidate', 'B · 개선 후보')}</Badge></div></CardHeader>
    <CardContent className="space-y-5">
      <dl className="grid gap-4 sm:grid-cols-2">
        <div className="min-w-0"><dt className="text-sm text-muted-foreground">{t('Harness version', '하네스 버전')}</dt><dd className="mt-1 break-all text-lg font-semibold">{harness.version ?? '—'}</dd></div>
        <div className="min-w-0"><dt className="text-sm text-muted-foreground">{t('How it is applied', '적용 방식')}</dt><dd className="mt-1 font-medium">{mode.title}</dd><dd className="mt-1 text-sm text-muted-foreground">{mode.description}</dd></div>
      </dl>
      {harness.arm !== null && <p className="text-sm text-muted-foreground">{t('The assignment was made automatically and stays fixed for this task, including rework.', '배정은 자동으로 정해졌으며 재작업을 포함해 이 작업에서 바뀌지 않습니다.')}</p>}
      {!task.outcome && <div className="space-y-3 border-t pt-4"><h3 className="font-medium">{t('How to connect', '연결 방법')}</h3>
        <ol className="list-decimal space-y-2 pl-5 text-sm">{steps[route].map(step => <li key={step}>{step}</li>)}</ol>
        {(route === 'family' || route === 'agent') && <div className="space-y-2 rounded-lg bg-muted/40 p-3">
          <p className="text-sm font-medium">{t('Connection request for the new working session', '새 작업 세션에 보낼 연결 요청문')}</p>
          <textarea readOnly rows={3} aria-label={t('Connection request', '연결 요청문')} value={request} onFocus={event => event.currentTarget.select()} className="w-full rounded border bg-background p-3 text-xs" />
          <Button variant="outline" size="sm" data-copy-connect="" onClick={() => { void navigator.clipboard.writeText(request).then(() => setCopied(true)).catch(() => setCopied(false)); }}>{copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}{copied ? t('Copied', '복사됨') : t('Copy connection request', '연결 요청문 복사')}</Button>
          {connectBlocker && <p role="status" data-connect-blocked="" className="text-sm">{t('Connection is currently unavailable: ', '현재 연결할 수 없습니다: ')}{connectBlocker}</p>}
        </div>}
      </div>}
      <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">{t('Assignment identifier', '배정 식별자')}</summary><code className="mt-2 block break-all">{harness.variant_id ?? '—'}</code></details>
    </CardContent>
  </Card>;
}
