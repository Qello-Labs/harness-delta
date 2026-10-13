import type { Locale, Setup } from './types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SupportGuidance } from './SupportGuidance';
import { applicationModeText } from './application-mode';

export function SetupSummary({ setup, projectName, locale, busy, onUse }: {
  setup: Setup; projectName: string | undefined; locale: Locale; busy: boolean; onUse: () => void;
}) {
  const t = (en: string, ko: string) => locale === 'ko' ? ko : en;
  return <article data-setup-id={setup.id} className="min-w-0 space-y-4 rounded-lg border p-4">
    <header className="flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0 space-y-1"><h3 className="break-words font-medium">{setup.name}</h3>
        <p className="break-all text-sm text-muted-foreground">{projectName ?? setup.project_id}</p></div>
      <Badge variant="secondary">{t('Saved', '저장됨')}</Badge>
    </header>
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="min-w-0 rounded-md bg-muted/40 p-3">
        <p className="mb-1 text-xs font-medium text-muted-foreground">{t('A · Baseline for this comparison', 'A · 이 비교의 기준')}</p>
        <p className="break-all text-sm">{setup.arm_a}</p>
      </div>
      <div className="min-w-0 rounded-md bg-muted/40 p-3">
        <p className="mb-1 text-xs font-medium text-muted-foreground">{t('B · Candidate for this comparison', 'B · 이 비교의 개선 후보')}</p>
        <p className="break-all text-sm">{setup.arm_b}</p>
      </div>
    </div>
    <p className="text-sm text-muted-foreground">{t('This pair stays fixed. Later adoption does not overwrite an earlier comparison.', '이 설정의 A/B는 고정됩니다. 이후 채택한 현재 구성이 바뀌어도 과거 설정을 덮어쓰지 않습니다.')}</p>
    {setup.application_mode && <p className="text-sm" data-application-mode={setup.application_mode}><span className="text-muted-foreground">{t('How the harness is applied: ', '하네스 적용 방식: ')}</span>{applicationModeText(setup.application_mode, locale).title}</p>}
    {setup.support_details && <SupportGuidance support={setup.support_details} locale={locale} compact />}
    <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-muted-foreground">{t('The saved criteria, comparison recruitment period and price basis apply to new tasks.', '새 작업에는 저장된 완료 기준·비교 모집 기간·가격 기준이 적용됩니다.')}</p>
      <Button disabled={busy} onClick={onUse}>{t('New task with this setting', '이 설정으로 새 작업')}</Button></div>
    <details className="text-sm"><summary className="cursor-pointer font-medium">{t('Review saved conditions', '저장된 조건 확인')}</summary>
      <dl className="mt-3 grid gap-3 sm:grid-cols-2">
        <div>
          <dt className="mb-1 text-muted-foreground">{t('Task types', '작업 유형')}</dt>
          <dd className="flex flex-wrap gap-1">{setup.types.length ? setup.types.map(type => <Badge key={type} variant="secondary">{type}</Badge>) : t('None', '없음')}</dd>
        </div>
        <div>
          <dt className="mb-1 text-muted-foreground">{t('Task sizes', '작업 크기')}</dt>
          <dd className="flex flex-wrap gap-1">{setup.sizes.length ? setup.sizes.map(size => <Badge key={size} variant="secondary">{size}</Badge>) : t('None', '없음')}</dd>
        </div>
        {setup.shared && <>
          <div><dt className="text-muted-foreground">{t('Model', '모델')}</dt><dd className="mt-1 break-all">{setup.shared.runtime.model ?? t('Native agent choice', '네이티브 에이전트 선택')}</dd></div>
          <div><dt className="text-muted-foreground">effort</dt><dd className="mt-1 break-all">{setup.shared.runtime.effort ?? t('Native agent choice', '네이티브 에이전트 선택')}</dd></div>
        </>}
      </dl>
      <details className="mt-3 text-sm">
        <summary className="cursor-pointer text-muted-foreground">{t('Configuration IDs', '설정 식별자')}</summary>
        <dl className="mt-3 space-y-2">
          <div><dt className="text-muted-foreground">{t('Setup ID', '설정 ID')}</dt><dd className="break-all font-mono text-xs">{setup.id}</dd></div>
          <div><dt className="text-muted-foreground">{t('Project ID', '프로젝트 ID')}</dt><dd className="break-all font-mono text-xs">{setup.project_id}</dd></div>
          {setup.shared && <div><dt className="text-muted-foreground">template</dt><dd className="break-all">{setup.shared.template_name}<br /><code className="text-xs">{setup.shared.template_id}</code></dd></div>}
        </dl>
      </details>
    </details>
  </article>;
}
