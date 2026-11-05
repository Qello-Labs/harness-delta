import type { GuidedSetupModel } from '../hooks/use-guided-setup';
import { MeasurementReview } from '../MeasurementReview';
import type { SetupSaveResult } from '../types';
import { Button } from '@/components/ui/button';

type GuidedReviewProps = Pick<
  GuidedSetupModel,
  | 'review'
  | 't'
  | 'inspected'
  | 'project'
  | 'locale'
  | 'mode'
  | 'confirmed'
  | 'busy'
  | 'setConfirmed'
  | 'inputRevision'
  | 'perform'
  | 'active'
  | 'change'
  | 'onSaved'
>;

export function GuidedReview(props: GuidedReviewProps) {
  const { review } = props;
  return (
    <>
      {review && !review.ready && (
        <div role="status" data-setup-review="blocked" className="space-y-2 break-keep rounded-lg bg-muted/40 p-4 text-sm">
          <p className="font-medium">
            {props.inspected
              ? props.t('Review these items before saving', '저장 전에 아래 항목을 확인하세요')
              : props.t('Check the inputs and comparison path', '입력과 비교 경로를 확인하세요')}
          </p>
          {props.inspected && (
            <p>
              {props.t(
                'Reuse an existing registered setting above, or provide reviewed decisions for a new setting. Technical IDs and verified A/B references are suggested automatically.',
                '위에서 등록된 설정을 재사용하거나 새 설정에 필요한 검토된 결정을 제공하세요. 기술 식별자와 확인된 A/B 참조는 자동 제안합니다.'
              )}
            </p>
          )}
          <ul className="list-disc space-y-1 pl-5">
            {review.issues.some(issue => issue.code === 'registration_too_late') && (
              <li>
                {props.t(
                  'Recruitment has already started. Ask your agent to correct the recruitment dates with your approval, then load the revised bundle. Nothing was saved.',
                  '모집 시작일이 이미 지났습니다. 에이전트와 새 모집 날짜를 확인한 뒤 수정한 묶음을 불러오세요. 저장하지 않았습니다.'
                )}
              </li>
            )}
            {review.issues.some(issue => issue.code === 'ineligible_variant') && (
              <li>
                {props.t(
                  'Both harnesses must be eligible before this comparison can be saved. Review the policy decision with your agent.',
                  '비교를 저장하려면 두 하네스 모두 정책 적격성이 확인되어야 합니다. 에이전트와 정책 결정을 다시 검토하세요.'
                )}
              </li>
            )}
            {review.issues.some(issue => issue.code === 'application_mode_mismatch') && (
              <li>
                {props.t(
                  'The selected application method differs from the comparison file. Select the matching method above or prepare a new comparison. Nothing was saved.',
                  '선택한 적용 방식이 비교 파일과 다릅니다. 위에서 같은 방식을 선택하거나 새 비교 파일을 준비하세요. 저장하지 않았습니다.'
                )}
              </li>
            )}
            {review.issues.some(issue => issue.field === 'profile') && <li>{props.t('Reviewed measurement settings', '검토된 측정 설정')}</li>}
            {review.issues.some(issue => issue.field.includes('criterion_ids')) && (
              <li>{props.t('Task completion criteria and allowed work', '작업 완료 기준과 대상 작업')}</li>
            )}
            {review.issues.some(issue => issue.field.includes('policy_status')) && (
              <li>{props.t('A/B policy eligibility approval', 'A/B 정책 적격성 확인')}</li>
            )}
            {review.issues.some(issue => issue.field.startsWith('protocol')) && (
              <li>{props.t('Comparison purpose, recruitment period, sample and source rules', '비교 목적·모집 기간·표본·원본 규칙')}</li>
            )}
            {review.issues.some(issue => issue.field.includes('execution')) && (
              <li>{props.t('Agent product, installation and execution scope', '에이전트 제품·설치·실행 범위')}</li>
            )}
            {review.issues.some(issue => issue.field.startsWith('price_table')) && <li>{props.t('Reviewed price basis', '검토된 가격 기준')}</li>}
          </ul>
          <details>
            <summary className="cursor-pointer">{props.t('Technical missing-field details', '누락 항목 상세')}</summary>
            <ul className="mt-2 list-disc pl-5">
              {review.issues.map((issue, index) => (
                <li key={index} className="break-all">
                  {issue.field || 'input'}: {issue.code}
                </li>
              ))}
            </ul>
          </details>
        </div>
      )}
      {review?.ready && review.profile.setup.workflow.assignment.project_id !== props.project?.id && (
        <p role="alert">
          {props.t(
            'Reviewed inputs belong to a different project. Select matching inputs and review again.',
            '검토 입력이 다른 프로젝트에 속합니다. 일치하는 입력으로 다시 검토하세요.'
          )}
        </p>
      )}
      {review?.ready && review.profile.setup.workflow.assignment.project_id === props.project?.id && (
        <div className="space-y-3 break-keep rounded-lg border p-4" data-setup-review="ready">
          <MeasurementReview review={review} projectName={props.project?.name ?? ''} locale={props.locale} />
          {props.mode !== review.application_mode && (
            <p role="status" data-application-mode-required="" className="text-sm">
              {props.t(
                'To save, select the application method this comparison uses in the first step above.',
                '저장하려면 맨 위 ‘적용 방식’에서 이 비교와 같은 방식을 선택하세요.'
              )}
            </p>
          )}
          <label className="flex items-start gap-2">
            <input
              id="guided-confirm"
              type="checkbox"
              checked={props.confirmed}
              disabled={props.busy}
              onChange={event => props.setConfirmed(event.target.checked)}
            />
            {props.t('I confirm these conditions for new tasks.', '새 작업에 사용할 위 조건을 확인했습니다.')}
          </label>
          <div className="flex flex-wrap gap-2">
            <Button
              data-setup-save=""
              disabled={props.busy || !props.confirmed || props.mode !== review.application_mode}
              onClick={() => {
                const revision = props.inputRevision.current;
                void props.perform<SetupSaveResult>('/api/setup-save-reviewed', { token: review.token }).then(value => {
                  if (value && props.active.current && props.inputRevision.current === revision) {
                    props.change();
                    props.onSaved(value);
                  }
                });
              }}
            >
              {props.t('Confirm and save settings', '이 내용으로 확정하고 저장')}
            </Button>
            <Button variant="outline" disabled={props.busy} onClick={props.change}>
              {props.t('Cancel review', '검토 취소')}
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
