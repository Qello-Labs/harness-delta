import type { CostAmounts as Amounts, Locale } from './types.js';

/** Reference partitions are displayed independently, never added to verified cost. */
export function CostAmounts({ value, locale }: { value: Amounts; locale: Locale }) {
  const t = (en: string, ko: string) => (locale === 'ko' ? ko : en);
  const amount = (reading: string) => `${value.currency ?? 'USD'} ${reading}`;
  const references = [
    { value: value.compatibility_unverified_partial_amount, label: t('Compatibility unverified reference', '호환성 미검증 참고 비용') },
    { value: value.legacy_unverified_partial_amount, label: t('Source unverified reference', '원본 미검증 참고 비용') }
  ];
  const invalidated = value.compatibility?.invalidated_events ?? 0;
  return (
    <>
      {value.partial_amount !== null && (
        <span className="block">
          {amount(value.partial_amount)}
          {value.compatibility && (
            <span className="block text-xs font-normal text-muted-foreground">{t('Verified partial estimate', '검증된 부분 추정 비용')}</span>
          )}
        </span>
      )}
      {references
        .filter(row => row.value != null)
        .map(row => (
          <span className="block" key={row.label}>
            {amount(row.value!)}
            <span className="block text-xs font-normal text-muted-foreground">{row.label}</span>
          </span>
        ))}
      {value.partial_amount === null && references.every(row => row.value == null) && t('Unavailable', '미확정')}
      {invalidated > 0 && (
        <span className="block text-xs font-normal text-muted-foreground">
          {t(`${invalidated} invalidated observations excluded`, `무효 관측 ${invalidated}개 제외`)}
        </span>
      )}
    </>
  );
}
