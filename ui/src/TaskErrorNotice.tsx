import type { RecruitmentWindow } from '../../src/local-web-recruitment.js';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { taskErrorGuidance } from './task-error-guidance';
import type { Locale } from './types';

export function TaskErrorNotice({ code, locale, recruitment, fallback }: {
  code: string; locale: Locale; recruitment?: RecruitmentWindow | undefined; fallback: string;
}) {
  const t = (en: string, ko: string) => locale === 'ko' ? ko : en;
  const guidance = taskErrorGuidance(code, locale, recruitment);
  const dates = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'long' });
  return <Alert className="break-keep" data-error-code={code} data-error-kind={guidance?.kind ?? 'generic'}>
    <AlertTitle>{guidance?.title ?? t('Check before continuing', '계속하기 전에 확인하세요')}</AlertTitle>
    <AlertDescription>
      <p>{guidance?.message ?? fallback}</p>
      {code === 'outside_recruitment' && recruitment && <dl className="mt-2 space-y-1 text-sm" data-recruitment-state={recruitment.state}>
        <div><dt className="inline">{t('Recruitment starts: ', '모집 시작: ')}</dt><dd className="inline"><time dateTime={recruitment.starts_at}>{dates.format(new Date(recruitment.starts_at))}</time></dd></div>
        <div><dt className="inline">{t('Recruitment ends: ', '모집 종료: ')}</dt><dd className="inline"><time dateTime={recruitment.ends_at}>{dates.format(new Date(recruitment.ends_at))}</time></dd></div>
        <div><dt className="inline">{t('Displayed timezone: ', '표시 시간대: ')}</dt><dd className="inline">{dates.resolvedOptions().timeZone}</dd></div>
      </dl>}
      <details className="mt-2 text-xs"><summary>{t('Technical error code', '기술 오류 코드')}</summary>{code}</details>
    </AlertDescription>
  </Alert>;
}
