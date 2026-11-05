import { useContext } from 'react';
import type { Task } from '../types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { SessionUsageTable } from '../SessionUsageTable';
import { SupportGuidance } from '../SupportGuidance';
import { ActionContext, LocaleContext, Action } from '../app-controls';
export function SessionFamily({ task }: { task: Task }) {
  const controls = useContext(ActionContext);
  const locale = useContext(LocaleContext);
  const t = (en: string, ko: string) => (locale === 'ko' ? ko : en);
  const binding = task.binding;
  if (!binding) return null;
  if (task.support_details?.context === 'synthetic_validation_only')
    return (
      <Card>
        <CardContent className="p-5">
          <SupportGuidance support={task.support_details} locale={locale} compact />
        </CardContent>
      </Card>
    );
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
