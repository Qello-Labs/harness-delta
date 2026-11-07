import { useContext } from 'react';
import type { Locale, OrdinaryWindowReport, Task } from '../types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { SessionUsageTable } from '../SessionUsageTable';
import { SupportGuidance } from '../SupportGuidance';
import { Action, ActionContext, LocaleContext } from '../app-controls';
import { windowReportCode } from '../window-report-codes.js';
export function SessionFamily({ task }: { task: Task }) {
  const controls = useContext(ActionContext);
  const locale = useContext(LocaleContext);
  const t = (en: string, ko: string) => (locale === 'ko' ? ko : en);
  const binding = task.binding;
  if (!binding) return null;
  if (task.support_details?.context === 'synthetic_validation_only') {
    return (
      <Card>
        <CardContent className="p-5">
          <SupportGuidance support={task.support_details} locale={locale} compact />
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle>{t('Connected sessions', '연결된 세션')}</CardTitle>
          <div className="flex gap-2">
            <Badge variant="secondary">
              {t('Parents', '부모')} {binding.roots}
            </Badge>
            <Badge variant="outline">
              {t('Children', '자식')} {binding.children}
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {binding.sessions.length === 0 && (
          <p className="rounded-lg bg-muted/40 p-3 text-sm text-muted-foreground">{t('No sessions connected yet.', '아직 연결된 세션이 없습니다.')}</p>
        )}
        <p className="text-sm text-muted-foreground">
          {task.mode === 'ordinary' ? (
            <>
              {t('All Claude-family models at observed effort · family limit ', '모든 Claude 계열 모델과 관측된 effort 허용 · 가족 한도 ')}
              <span data-family-limit={binding.max_family_members}>{binding.max_family_members}</span>
              {t('.', '개.')}
            </>
          ) : task.support_details?.family === 'candidate_root_pilot' ? (
            t('One fresh root only · child sessions unsupported.', '새 root 1개 전용 · 자식 세션 미지원')
          ) : (
            t('Connect in the parent; verified children are linked automatically.', '부모 세션에서 연결하면 확인된 자식은 자동 연결합니다.')
          )}
        </p>
        {binding.sessions.length > 0 && <SessionUsageTable sessions={binding.sessions} summary={binding.summary} locale={locale} />}
        {binding.support === 'verified_bounded_family' && controls?.action('emergency-stop')?.enabled && (
          <div className="flex flex-wrap gap-3">
            <Action code="emergency-stop" variant="destructive">
              {t('Emergency stop owned AI', '소유 AI 긴급 중단')}
            </Action>
          </div>
        )}
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">{t('Usage counting rules', '사용량 집계 기준')}</summary>
          <ul className="mt-3 list-disc space-y-1 pl-5 text-muted-foreground">
            <li>{t('Only eligible observed requests are added.', '관측 가능 구간의 요청만 합산합니다.')}</li>
            <li>{t('Cached and reasoning subsets are not added again.', '캐시·추론 부분은 중복 가산하지 않습니다.')}</li>
            <li>
              {t(
                'Paused intervals remain missing; missing or unpriced usage is not zero. Cost is partial.',
                '일시중단 구간은 누락으로 유지합니다. 누락·단가 없음은 0이 아니며 비용은 부분 추정입니다.'
              )}
            </li>
          </ul>
        </details>
        {binding.support === 'native_qualification_only' && (
          <>
            <div className="flex flex-wrap gap-3">
              <Action code="emergency-stop" variant="destructive">
                {t('Emergency stop owned AI', '소유 AI 긴급 중단')}
              </Action>
            </div>
            <p className="text-sm text-muted-foreground">
              {t(
                'Pause stops measurement reads while the owned AI remains alive. Resume retains the same task, assignment, price and safety deadline. Emergency stop terminates the owned process. Source-based safety counters are unverified while paused.',
                '일시중단은 측정 읽기만 멈추며 소유 AI는 계속 실행됩니다. 재개해도 작업·배정·가격·안전 기한은 유지됩니다. 긴급 중단은 소유 프로세스를 종료합니다. 중단 중 원본 기반 안전 카운터는 미확인입니다.'
              )}
            </p>
          </>
        )}
        {['native_unverified_pilot', 'native_pilot_preparation_only'].includes(binding.support) && (
          <p role="status" className="text-sm">
            {binding.support === 'native_pilot_preparation_only'
              ? t(
                  'Native unverified pilot: preparation only. Source observation requires the reviewed local command.',
                  '네이티브 미검증 pilot: 준비만 완료합니다. 원본 관측은 검토된 로컬 명령으로 시작해야 합니다.'
                )
              : t(
                  'Native unverified pilot. You own agent startup, input and exit. Pause stops collection only; source usage is unknown while paused. Production admission and complete cost remain unverified.',
                  '네이티브 미검증 pilot입니다. 사용자가 에이전트 실행·입력·종료를 직접 합니다. 일시중단은 수집만 멈추며 중단 중 원본 사용량은 미확인입니다. 제품 지원과 전체 비용 검증은 아직 완료되지 않았습니다.'
                )}
          </p>
        )}
        {binding.support === 'verified_bounded_family' && (
          <p role="status" className="text-sm">
            {t(
              `Codex ${task.support_details?.product_version} family · one fresh parent and up to two direct children · all GPT-family models at observed effort. Cost remains partial.`,
              `Codex ${task.support_details?.product_version} 가족 · 새 부모 1개와 직접 자식 최대 2개 · 모든 GPT 계열 모델과 관측된 effort를 허용합니다. 비용은 부분 관측입니다.`
            )}
          </p>
        )}
        {![
          'synthetic_validation_only',
          'native_unverified_pilot',
          'native_pilot_preparation_only',
          'verified_bounded_family',
          'claude_family',
          'verified_claude_family',
          'ordinary_qualification_pending'
        ].includes(binding.support) && (
          <p className="text-sm text-muted-foreground">
            {binding.support === 'instrumentation_required'
              ? t('Instrumentation requires installation review and a new session boundary.', '세션 계측은 설치 검토와 새 세션 경계가 필요합니다.')
              : t(
                  'Ordinary-session production collection awaits native source qualification.',
                  '일반 세션의 제품 수집은 네이티브 원본 지원 검증을 기다리고 있습니다.'
                )}
          </p>
        )}
        {binding.product === 'claude_code' && (
          <p className="text-sm text-muted-foreground">
            {t(
              'Claude family members are shown under the parent. Nested direct parents remain unverified.',
              'Claude 가족 구성원은 부모 아래에 표시합니다. 중첩 구성원의 직접 부모 관계는 미확인입니다.'
            )}
          </p>
        )}
        {binding.gaps.length > 0 && (
          <p role="status" className="text-sm">
            {t(
              'Some family usage is missing or unsupported. All shown cost remains partial.',
              '일부 가족 사용량이 누락되었거나 미지원입니다. 표시 비용은 모두 부분 관측입니다.'
            )}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export function WindowSessionFamily({ report, locale }: { report: OrdinaryWindowReport; locale: Locale }) {
  const t = (en: string, ko: string) => (locale === 'ko' ? ko : en);
  const unobserved = t('Unobserved', '미관측');
  return (
    <Card data-window-coverage={windowReportCode(report.coverage.status, locale).code}>
      <CardHeader>
        <CardTitle>{t('Root-source coverage', 'Root 원본 관측 범위')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="max-w-prose text-sm">
          {t(
            'Root-source references are not independently attributable root-own usage. Root ownership is unverified; possible child contribution and detection completeness remain unknown.',
            'Root 원본 참고 관측은 root 자체 사용량으로 독립 귀속할 수 없습니다. Root 소유권은 미확인이며 자식 기여 가능성과 탐지 완전성은 알 수 없습니다.'
          )}
        </p>
        <p className="text-sm text-muted-foreground">
          {t('Coverage reflects the current Store, independently of the usage cutoff.', '관측 범위는 사용량 cutoff와 별개인 현재 Store 상태입니다.')}
        </p>
        {report.coverage.segments.length === 0 && <p data-window-root="unobserved">{t('Root coverage: Unobserved', 'Root 관측 범위: 미관측')}</p>}
        {report.coverage.segments.map(segment => (
          <div key={segment.root_session_id} className="space-y-2 border-t pt-3" data-window-root={windowReportCode(segment.coverage.status, locale).code}>
            <p className="break-all text-sm font-medium">{segment.root_session_id}</p>
            <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
              <dt>{t('Coverage', '관측 범위')}</dt>
              <dd>{windowReportCode(segment.coverage.status, locale).label}</dd>
              <dt>{t('Actual source version', '실제 원본 버전')}</dt>
              <dd>{segment.actual_source_version ?? unobserved}</dd>
              <dt>{t('Version evidence', '버전 증거')}</dt>
              <dd className="break-all">{windowReportCode(segment.source_version_basis, locale).label}</dd>
              <dt>{t('Publisher proof', '배포자 증명')}</dt>
              <dd className="break-all">{windowReportCode(segment.publisher_proof, locale).label}</dd>
              <dt>{t('Mapped-image proof', '메모리 매핑 이미지 증명')}</dt>
              <dd>{windowReportCode(segment.mapped_image_proof, locale).label}</dd>
              <dt>{t('Writer version', '기록 프로세스 버전')}</dt>
              <dd>{windowReportCode(segment.writer_version, locale).label}</dd>
            </dl>
            {segment.coverage.detectedChildren.map(child => (
              <p key={child.identity} className="break-all text-sm" data-window-child="unobserved">
                {child.identity} — {unobserved} · {t('usage and cost unavailable', '사용량·비용 미확정')}
              </p>
            ))}
          </div>
        ))}
        <p className="text-sm" data-window-child="unobserved">
          {t(
            'Other children: Unobserved. Metadata detection is incomplete; no child tokens or cost are inferred.',
            '그 외 자식: 미관측. 메타데이터 탐지는 불완전하며 자식 토큰·비용을 추정하지 않습니다.'
          )}
        </p>
        <p className="max-w-prose text-sm text-muted-foreground">
          {report.selection.policy.evidenceMode === 'source_only'
            ? t(
                'Codex version evidence is a root-creation header, not the current writer. Executable, publisher and process proof are unavailable.',
                'Codex 버전 증거는 root 생성 헤더이며 현재 기록 프로세스의 버전이 아닙니다. 실행 파일·배포자·프로세스 증명은 미확정입니다.'
              )
            : report.selection.policy.evidenceMode === 'publisher_verified_local_pin'
              ? t(
                  'Claude PID, publisher and disk-asset pins are required by its policy; disk identity does not prove the mapped process image. Native acceptance remains pending.',
                  'Claude 정책은 PID·배포자·디스크 자산 pin을 요구합니다. 디스크 신원은 실행 중 매핑 이미지를 증명하지 않으며 네이티브 수용 검증은 대기 중입니다.'
                )
              : windowReportCode(report.selection.policy.evidenceMode, locale).label}
        </p>
      </CardContent>
    </Card>
  );
}
