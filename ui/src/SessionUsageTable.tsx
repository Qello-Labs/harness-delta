import type { BindingSummary, Locale, Task } from './types.js';
import { sessionDisplayLabels } from './session-labels.js';
import { CostAmounts } from './CostAmounts.js';

export function SessionUsageTable({ sessions, summary, locale }: {
  sessions: NonNullable<Task['binding']>['sessions']; summary: BindingSummary; locale: Locale;
}) {
  const t = (en: string, ko: string) => locale === 'ko' ? ko : en;
  const labels = sessionDisplayLabels(sessions, locale);
  const reading = (value: BindingSummary['input_total']) => value.value === null ? t('Missing', '누락')
    : `${value.value.toLocaleString()}${value.status === 'partial' ? t(' (partial)', ' (부분)') : ''}`;
  const cells = (value: BindingSummary) => <>
    <td>{value.requests ?? '—'}</td>
    <td title={value.input_total.statuses.join(', ')}>{reading(value.input_total)}</td>
    <td title={value.output_total.statuses.join(', ')}>{reading(value.output_total)}</td>
    <td><CostAmounts value={value} locale={locale} />
      {value.unpriced_events > 0 && <span className="block text-xs text-muted-foreground">{t(`${value.unpriced_events} unpriced`, `단가 없음 ${value.unpriced_events}개`)}</span>}
    </td>
  </>;
  return <div className="overflow-x-auto">
    <table aria-label={t('Per-session observed usage', '세션별 관측 사용량')} className="w-full text-left text-sm [&_td]:px-3 [&_td]:py-2 [&_th]:px-3 [&_th]:py-2">
      <thead><tr><th>{t('Agent', '에이전트')}</th><th>{t('Model', '모델')}</th><th>{t('Requests', '요청')}</th><th>{t('Input', '입력')}</th><th>{t('Output', '출력')}</th><th>{t('Partial estimated cost', '부분 추정 비용')}</th></tr></thead>
      <tbody>{sessions.map((session, index) => <tr key={session.session_id}>
        <th scope="row"><span>{labels[index]}</span><details className="mt-1 font-normal"><summary className="cursor-pointer text-xs text-muted-foreground">{t('Session diagnostics', '세션 진단')}</summary><dl className="mt-2 text-xs"><dt>{t('Session ID', '세션 ID')}</dt><dd className="break-all font-mono">{session.session_id}</dd><dt className="mt-2">{t('Parent session ID', '부모 세션 ID')}</dt><dd className="break-all font-mono">{session.parent_session_id ?? '—'}</dd></dl></details></th>
        <td>{session.models?.length ? session.models.join(', ') : t('Unknown', '알 수 없음')}</td>{cells(session)}
      </tr>)}<tr className="border-t font-medium"><th colSpan={2}>{t('Observed sum', '관측 합계')}</th>{cells(summary)}</tr></tbody>
    </table>
  </div>;
}
