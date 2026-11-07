import type { BindingSummary, Locale, OrdinaryWindowReport, ReportSourceTrust, Task } from './types.js';
import { sessionDisplayLabels } from './session-labels.js';
import { CostAmounts, WindowCostAmount } from './CostAmounts.js';
import { windowReportCode } from './window-report-codes.js';

export function SessionUsageTable({
  sessions,
  summary,
  locale
}: {
  sessions: NonNullable<Task['binding']>['sessions'];
  summary: BindingSummary;
  locale: Locale;
}) {
  const t = (en: string, ko: string) => (locale === 'ko' ? ko : en);
  const labels = sessionDisplayLabels(sessions, locale);
  const reading = (value: BindingSummary['input_total']) =>
    value.value === null ? t('Missing', '누락') : `${value.value.toLocaleString()}${value.status === 'partial' ? t(' (partial)', ' (부분)') : ''}`;
  const cells = (value: BindingSummary) => (
    <>
      <td>{value.requests ?? '—'}</td>
      <td title={value.input_total.statuses.join(', ')}>{reading(value.input_total)}</td>
      <td title={value.output_total.statuses.join(', ')}>{reading(value.output_total)}</td>
      <td>
        <CostAmounts value={value} locale={locale} />
        {value.unpriced_events > 0 && (
          <span className="block text-xs text-muted-foreground">{t(`${value.unpriced_events} unpriced`, `단가 없음 ${value.unpriced_events}개`)}</span>
        )}
      </td>
    </>
  );
  return (
    <div className="overflow-x-auto">
      <table
        aria-label={t('Per-session observed usage', '세션별 관측 사용량')}
        className="w-full text-left text-sm [&_td]:px-3 [&_td]:py-2 [&_th]:px-3 [&_th]:py-2"
      >
        <thead>
          <tr>
            <th>{t('Agent', '에이전트')}</th>
            <th>{t('Model', '모델')}</th>
            <th>{t('Requests', '요청')}</th>
            <th>{t('Input', '입력')}</th>
            <th>{t('Output', '출력')}</th>
            <th>{t('Partial estimated cost', '부분 추정 비용')}</th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((session, index) => (
            <tr key={session.session_id}>
              <th scope="row">
                <span>{labels[index]}</span>
                <details className="mt-1 font-normal">
                  <summary className="cursor-pointer text-xs text-muted-foreground">{t('Session diagnostics', '세션 진단')}</summary>
                  <dl className="mt-2 text-xs">
                    <dt>{t('Session ID', '세션 ID')}</dt>
                    <dd className="break-all font-mono">{session.session_id}</dd>
                    <dt className="mt-2">{t('Parent session ID', '부모 세션 ID')}</dt>
                    <dd className="break-all font-mono">{session.parent_session_id ?? '—'}</dd>
                  </dl>
                </details>
              </th>
              <td>{session.models?.length ? session.models.join(', ') : t('Unknown', '알 수 없음')}</td>
              {cells(session)}
            </tr>
          ))}
          <tr className="border-t font-medium">
            <th colSpan={2}>{t('Observed sum', '관측 합계')}</th>
            {cells(summary)}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

export function WindowUsageTable({ report, locale }: { report: OrdinaryWindowReport; locale: Locale }) {
  const t = (en: string, ko: string) => (locale === 'ko' ? ko : en);
  const partitions: { trust: ReportSourceTrust; label: string }[] = [
    { trust: 'verified', label: t('Verified partial', '검증된 부분 관측') },
    { trust: 'compatibility_unverified', label: t('Compatibility unverified reference', '호환성 미검증 참고 관측') },
    { trust: 'legacy_unverified', label: t('Source unverified reference', '원본 미검증 참고 관측') },
    { trust: 'invalidated', label: t('Invalidated — excluded', '무효화 — 제외') }
  ];
  const reading = (value: OrdinaryWindowReport['usage']['verified']['input_total']) =>
    value.status === 'invalidated' ? t('Excluded', '제외') : value.observed_sum === null ? t('Missing', '누락') : value.observed_sum.toLocaleString();
  return (
    <div className="space-y-3">
      <h2 className="text-lg font-semibold">{t('Partial usage by trust', '신뢰 구분별 부분 사용량')}</h2>
      <p className="max-w-prose text-sm text-muted-foreground">
        {t(
          'Partitions are not added together. Cached input and reasoning output are subsets, not extra tokens. Complete tokens, complete cost and success denominators are unavailable.',
          '신뢰 구분은 서로 합산하지 않습니다. 캐시 입력·추론 출력은 부분 집합이며 추가 토큰이 아닙니다. 전체 토큰·전체 비용·성공당 분모는 미확정입니다.'
        )}
      </p>
      <dl aria-label={t('Interval-excluded observations', '구간 제외 관측')} className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
        <dt>{t('Interval-excluded observations', '구간 제외 관측')}</dt>
        <dd>{report.cost.excluded_event_count}</dd>
        {report.cost.excluded_event_count > 0 && (
          <>
            <dt>{t('Report and exclusion reasons', '보고서·제외 사유')}</dt>
            <dd className="break-words">{report.cost.reasons.map(reason => windowReportCode(reason, locale).label).join(', ')}</dd>
          </>
        )}
      </dl>
      <div className="overflow-x-auto">
        <table
          className="w-full text-left text-sm [&_td]:px-3 [&_td]:py-2 [&_th]:px-3 [&_th]:py-2"
          aria-label={t('Window trust partitions', 'Window 신뢰 구분')}
        >
          <thead>
            <tr>
              <th>{t('Trust', '신뢰 구분')}</th>
              <th>{t('Observations', '관측 레코드')}</th>
              <th>{t('Input', '입력')}</th>
              <th>{t('Output', '출력')}</th>
              <th>{t('Partial cost', '부분 비용')}</th>
            </tr>
          </thead>
          <tbody>
            {partitions.map(({ trust, label }) => (
              <tr key={trust} data-window-trust={trust}>
                <th scope="row">
                  {label}
                  <details className="mt-1 font-normal">
                    <summary className="cursor-pointer text-xs text-muted-foreground">{t('Subset readings', '부분 집합 읽기')}</summary>
                    <p className="mt-2 text-xs">
                      {t('Cached input', '캐시 입력')}: {reading(report.usage[trust].cached_input)}
                      <br />
                      {t('Reasoning output', '추론 출력')}: {reading(report.usage[trust].reasoning_output)}
                    </p>
                  </details>
                </th>
                <td>{report.usage[trust].event_count}</td>
                <td>{reading(report.usage[trust].input_total)}</td>
                <td>{reading(report.usage[trust].output_total)}</td>
                <td>
                  <WindowCostAmount cost={report.cost} trust={trust} locale={locale} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
