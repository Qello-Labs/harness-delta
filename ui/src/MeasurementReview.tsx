import type { SetupReviewResult } from '../../src/local-web-setup-review.js';
import { applicationModeText } from './application-mode';
import type { Locale } from './types';

export function MeasurementReview({ review, projectName, locale }: {
  review: Extract<SetupReviewResult, { ready: true }>; projectName: string; locale: Locale;
}) {
  const t = (en: string, ko: string) => locale === 'ko' ? ko : en;
  const { protocol, profile, price_table: prices } = review;
  const pair = review.preview.projects.find(project => project.project_id === protocol.project_id)?.pair;
  const date = (value: string) => new Date(value).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
  const percent = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 20 });
  const types: Record<string, string> = { feature: '기능', fix: '수정', infra: '인프라', chore: '유지보수', docs: '문서', ci: 'CI' };
  const sizes: Record<string, string> = { small: '작음', medium: '보통', large: '큼' };
  return <div className="space-y-4 break-keep" data-measurement-summary="">
    <div><h3 className="text-lg font-semibold">{t('Confirm measurement settings', '측정 설정을 확인하세요')}</h3>
      <p className="mt-1 break-words text-sm text-muted-foreground">{projectName} · {profile.name}</p></div>
    <div className="grid gap-3 sm:grid-cols-2">
      {([['A', pair?.arm_a.version ?? protocol.variant_ids[0]], ['B', pair?.arm_b.version ?? protocol.variant_ids[1]]] as const).map(([arm, version]) =>
        <div key={arm} className="min-w-0 rounded-md bg-muted/40 p-3"><p className="text-sm text-muted-foreground">{arm === 'A' ? t('A · Baseline', 'A · 기준') : t('B · Candidate', 'B · 개선 후보')}</p><p className="mt-1 break-all font-medium">{version}</p></div>)}
    </div>
    <dl className="grid gap-4 text-sm sm:grid-cols-2 [&_dt]:text-muted-foreground [&_dd]:mt-1 [&_dd]:break-words">
      <div className="sm:col-span-2"><dt>{t('How the harness is applied', '하네스 적용 방식')}</dt><dd data-application-mode={review.application_mode}>{applicationModeText(review.application_mode, locale).title}<br /><span className="text-muted-foreground">{applicationModeText(review.application_mode, locale).description}</span></dd></div>
      <div><dt>{t('Purpose', '측정 목적')}</dt><dd>{protocol.purpose === 'functional_pilot' ? t('Check assignment, collection and reporting', '배정·수집·보고 흐름 확인') : protocol.purpose === 'real_experiment' ? t('Compare effectiveness', '효과 비교') : t('Synthetic validation', '합성 검증')}</dd></div>
      <div><dt>{t('Participants', '참가자')}</dt><dd>{protocol.participants.length}{t(' people', '명')} · {protocol.participants.join(', ')}</dd></div>
      <div><dt>{t('Recruitment (your local time)', '작업 모집 기간 (현재 시간대)')}</dt><dd><time dateTime={protocol.recruitment_start}>{date(protocol.recruitment_start)}</time><br />~ <time dateTime={protocol.recruitment_end}>{date(protocol.recruitment_end)}</time></dd></div>
      <div><dt>{t('Sample and assignment', '작업 수와 배정')}</dt><dd>{protocol.sample_plan.target_tasks}{t(' tasks in total', '건 전체')} · A:B 1:1<br />{t('Balanced blocks of ', '균형 블록 크기 ')}{protocol.block_size}</dd></div>
      {protocol.purpose === 'real_experiment' && <>
        <div><dt>{t('Minimum effect', '최소 효과')}</dt><dd data-metric="minimum_effect">{protocol.minimum_effect}</dd></div>
        <div><dt>{t('Quality margin', '품질 허용 마진')}</dt><dd data-metric="quality_margin">{protocol.quality_margin}</dd></div>
        <div><dt>{t('Confidence level', '신뢰수준')}</dt><dd data-metric="confidence_level">{protocol.confidence_level}</dd></div>
      </>}
      <div><dt>{t('Allowed work', '대상 작업')}</dt><dd>{[...new Set(protocol.strata.flatMap(stratum => stratum.types))].map(value => locale === 'ko' ? types[value] ?? value : value).join(', ')}<br />{[...new Set(protocol.strata.flatMap(stratum => stratum.sizes))].map(value => locale === 'ko' ? sizes[value] ?? value : value).join(', ')}</dd></div>
      <div><dt>{t('Completion criteria', '완료 기준')}</dt><dd>{profile.setup.workflow.assignment.metadata.criterion_ids.join(', ')}</dd></div>
      <div><dt>{t('Follow-up per task', '작업별 판정 기간')}</dt><dd>{protocol.followup_seconds / 3600}{t(' hours', '시간')}</dd></div>
      <div><dt>{t('Stopping rule', '모집 중단 규칙')}</dt><dd>{t('Fixed recruitment period', '합의한 모집 기간 고정')}</dd></div>
      <div><dt>{t('Allowed missing data', '허용 누락률')}</dt><dd>{t('Usage ', '사용량 ')}{percent.format(protocol.missingness_policy.max_usage_missing_rate)} · {t('Outcomes ', '결과 ')}{percent.format(protocol.missingness_policy.max_outcome_missing_rate)}</dd></div>
      <div><dt>{t('Price basis', '가격 기준')}</dt><dd>{prices.id} · {prices.currency}<br />{t('Reference rates as of ', '기준 요금 확인일 ')}{date(prices.as_of)}</dd></div>
      <div className="sm:col-span-2"><dt>{t('Agent and observation scope', '에이전트와 관측 범위')}</dt><dd>{protocol.source_profiles.map(source => <p key={`${source.product}:${source.product_version}`} className="break-all">{source.product === 'claude_code' ? 'Claude Code' : `${source.product === 'codex' ? 'Codex' : source.product} ${source.product_version}`} · {source.profile_id}</p>)}</dd></div>
    </dl>
    <p className="text-sm text-muted-foreground">{review.registrations.freeze_at
      ? t('The explicit confirmation time is shown in technical details.', '직접 지정한 확정 시각은 기술 상세에서 확인할 수 있습니다.')
      : t('Any unfrozen conditions are fixed at the server time when you confirm and save, before recruitment begins.', '미확정 조건은 아래에서 확정하고 저장하는 서버 시각에 고정됩니다. 모집 시작 전이어야 합니다.')}</p>
    <p className="text-sm text-muted-foreground">{t('Saving also connects this comparison for new tasks. It does not start a task, an agent or measurement.', '저장하면 새 작업에서 사용할 비교 설정까지 연결됩니다. 작업·에이전트·측정은 시작하지 않습니다.')}</p>
    <details className="text-sm"><summary className="cursor-pointer text-muted-foreground">{t('Technical details and complete conditions', '기술 상세와 전체 조건')}</summary>
      <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify({ registrations: review.registrations, protocol, price_table: prices, profile }, null, 2)}</pre>
    </details>
  </div>;
}
