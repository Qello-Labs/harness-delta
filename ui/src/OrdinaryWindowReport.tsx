import { useEffect, useState } from 'react';
import type { Locale, OrdinaryWindowReport as Report } from './types.js';
import * as api from './api.js';
import { useLocalePersistence } from './hooks/use-locale-persistence.js';
import { Button } from './components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from './components/ui/card.js';
import { Input } from './components/ui/input.js';
import { Label } from './components/ui/label.js';
import { WindowSessionFamily } from './screens/SessionFamily.js';
import { WindowUsageTable } from './SessionUsageTable.js';
import { OrdinaryWindowNotice } from './OrdinaryWindowNotice.js';
import { windowReportCode } from './window-report-codes.js';

export function OrdinaryWindowReportView({ report, locale }: { report: Report; locale: Locale }) {
  const t = (en: string, ko: string) => (locale === 'ko' ? ko : en);
  return (
    <div
      className="space-y-6"
      data-window-report={windowReportCode(report.report_version, locale).code}
      data-window-collection={windowReportCode(report.collection.state, locale).code}
    >
      <Card>
        <CardHeader>
          <CardTitle>{t('Saved selection — collection disabled', '저장된 선택 — 수집 비활성')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
            <dt>{t('Task', '작업')}</dt>
            <dd className="break-all">{report.task_id}</dd>
            <dt>{t('Declared source version', '선언한 원본 버전')}</dt>
            <dd>{report.selection.declared_version}</dd>
            <dt>{t('Policy', '정책')}</dt>
            <dd className="break-all">{windowReportCode(report.selection.policy.policyId, locale).label}</dd>
            <dt>{t('Exclusive bounds', '양끝 제외 경계')}</dt>
            <dd>
              {report.selection.policy.baseVersion} &lt; v &lt; {report.selection.policy.upperExclusive}
            </dd>
            <dt>{t('Evidence mode', '증거 모드')}</dt>
            <dd className="break-all">{windowReportCode(report.selection.policy.evidenceMode, locale).label}</dd>
            <dt>{t('Collection blocker', '수집 차단 사유')}</dt>
            <dd className="break-all">{windowReportCode(report.collection.reason, locale).label}</dd>
            <dt>{t('Usage cutoff', '사용량 cutoff')}</dt>
            <dd className="break-all">{report.cutoff}</dd>
          </dl>
          <p className="text-sm text-muted-foreground">
            {t(
              'Read-only evidence, not exact admission or launch authority. No assigned comparison, inference or exchange.',
              '읽기 전용 증거이며 exact 승인이나 실행 권한이 아닙니다. 비교 배정·추론·교환은 지원하지 않습니다.'
            )}
          </p>
          {report.coverage.status === 'invalidated' && (
            <p role="status" className="text-sm text-destructive">
              {t(
                'Affected references are invalidated and excluded. Saved evidence is not rewritten or promoted.',
                '영향받은 참고 관측은 무효화되어 제외됩니다. 저장된 증거를 덮어쓰거나 승격하지 않습니다.'
              )}
            </p>
          )}
        </CardContent>
      </Card>
      <WindowSessionFamily report={report} locale={locale} />
      <WindowUsageTable report={report} locale={locale} />
    </div>
  );
}

export function OrdinaryWindowScreen({ route }: { route: string }) {
  const params = new URLSearchParams(route.split('?')[1] ?? '');
  const [locale, setLocale] = useState<Locale>(params.get('locale') === 'en' ? 'en' : 'ko');
  const [taskId, setTaskId] = useState(params.get('task') ?? '');
  const [cutoff, setCutoff] = useState(params.get('cutoff') ?? new Date().toISOString());
  const [request, setRequest] = useState<{ readonly taskId: string; readonly cutoff: string } | null>(
    params.get('task') && params.get('cutoff') ? { taskId: params.get('task') ?? '', cutoff: params.get('cutoff') ?? '' } : null
  );
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const t = (en: string, ko: string) => (locale === 'ko' ? ko : en);
  useLocalePersistence(locale);
  useEffect(() => {
    if (request === null) return;
    const controller = new AbortController();
    setReport(null);
    setError(null);
    setLoading(true);
    void api
      .ordinaryWindowReport(request.taskId, request.cutoff, controller.signal)
      .then(value => {
        if (!controller.signal.aborted) setReport(value);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) {
          setError(failure instanceof api.LocalApiError ? failure.code : 'local_operation_failed');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [request]);
  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 p-4 sm:p-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <a href="#tasks" className="inline-block min-h-11 py-3 text-sm underline underline-offset-4">
            {t('Tasks', '작업 목록')}
          </a>
          <h1 className="text-2xl font-semibold">{t('Ordinary root-reference report', '일반 root 참고 관측 보고서')}</h1>
        </div>
        <label className="space-y-1 text-sm">
          <span className="block">{t('Language', '언어')}</span>
          <select className="native-select min-h-11" value={locale} onChange={event => setLocale(event.target.value === 'en' ? 'en' : 'ko')}>
            <option value="ko">한국어</option>
            <option value="en">English</option>
          </select>
        </label>
      </header>
      <OrdinaryWindowNotice product={report?.selection.policy.product === 'claude_code' ? 'claude_code' : 'codex'} locale={locale} withReportLink={false} />
      <form
        className="grid items-end gap-4 sm:grid-cols-2"
        onSubmit={event => {
          event.preventDefault();
          const id = taskId.trim();
          const query = new URLSearchParams({ task: id, cutoff, locale });
          history.replaceState(null, '', `#ordinary-window-task-v1?${query}`);
          setRequest({ taskId: id, cutoff });
        }}
      >
        <div className="space-y-2">
          <Label htmlFor="window-report-task">{t('Task ID', '작업 ID')}</Label>
          <Input className="min-h-11" id="window-report-task" required value={taskId} onChange={event => setTaskId(event.target.value)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="window-report-cutoff">{t('UTC cutoff', 'UTC cutoff')}</Label>
          <Input className="min-h-11" id="window-report-cutoff" required value={cutoff} onChange={event => setCutoff(event.target.value)} />
        </div>
        <Button className="min-h-11 justify-self-start" type="submit" disabled={loading || !taskId.trim()}>
          {t('Read saved evidence', '저장된 증거 읽기')}
        </Button>
      </form>
      {loading && <p role="status">{t('Reading saved evidence…', '저장된 증거를 읽는 중…')}</p>}
      {error && (
        <p role="alert" className="break-all text-sm text-destructive">
          {t('Could not read saved evidence:', '저장된 증거를 읽지 못했습니다:')} {windowReportCode(error, locale).label}
        </p>
      )}
      {report && <OrdinaryWindowReportView report={report} locale={locale} />}
    </main>
  );
}
