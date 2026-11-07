import type { Locale } from './types.js';
import { Label } from './components/ui/label.js';

export function OrdinaryWindowNotice({
  product,
  locale,
  withReportLink = true
}: {
  product: 'codex' | 'claude_code';
  locale: Locale;
  withReportLink?: boolean;
}) {
  const t = (en: string, ko: string) => (locale === 'ko' ? ko : en);
  const id = `ordinary-window-${product}`;
  return (
    <div className="space-y-2" data-window-setup="disabled">
      <Label htmlFor={id}>{t('Ordinary root-reference window', '일반 root 참고 관측 window')}</Label>
      <select id={id} className="native-select" disabled value="closed" aria-describedby={`${id}-reason`}>
        <option value="closed">{t('Unavailable — collection disabled', '사용 불가 — 수집 비활성')}</option>
      </select>
      <p id={`${id}-reason`} className="max-w-prose text-sm text-muted-foreground">
        {t(
          'Implemented for offline acceptance, ordinary-window collection disabled pending separate product activation and native acceptance. Existing exact settings are not migrated.',
          '오프라인 수용 검증용으로 구현되었습니다. 제품별 활성화와 네이티브 수용 검증이 별도로 완료될 때까지 ordinary-window 수집은 비활성입니다. 기존 exact 설정은 이전하지 않습니다.'
        )}
      </p>
      {withReportLink && (
        <a className="inline-block min-h-11 py-3 text-sm underline underline-offset-4" href="#ordinary-window-task-v1">
          {t('Read saved window evidence', '저장된 window 증거 읽기')}
        </a>
      )}
    </div>
  );
}
