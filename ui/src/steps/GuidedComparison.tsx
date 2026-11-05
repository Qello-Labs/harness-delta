import type { GuidedSetupModel } from '../hooks/use-guided-setup';
import { applicationModeText } from '../application-mode';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type GuidedComparisonProps = Pick<
  GuidedSetupModel,
  | 't'
  | 'path'
  | 'busy'
  | 'project'
  | 'change'
  | 'setPath'
  | 'setInspected'
  | 'setSuggestedIdentifier'
  | 'setDocuments'
  | 'selectedTemplate'
  | 'setups'
  | 'setTemplate'
  | 'documents'
  | 'freezeAt'
  | 'inspect'
  | 'inputError'
  | 'inspected'
  | 'review'
  | 'locale'
>;

export function GuidedComparison(props: GuidedComparisonProps) {
  return (
    <>
      <div className="space-y-2">
        <Label htmlFor="guided-comparison">{props.t('Comparison JSON file path', '비교 JSON 파일 경로')}</Label>
        <Input
          id="guided-comparison"
          value={props.path}
          placeholder="/path/to/project/harness-config/comparisons/comparison.json"
          disabled={props.busy || !props.project}
          onChange={event => {
            props.change();
            props.setPath(event.target.value);
            props.setInspected(null);
            props.setSuggestedIdentifier('');
            props.setDocuments(old => ({ ...old, arm_a_status: '', arm_b_status: '' }));
          }}
        />
        {(!props.project || !props.path.trim()) && (
          <p className="text-sm text-muted-foreground">
            {props.project
              ? props.t('Enter the comparison JSON path to enable file checking.', '비교 JSON 경로를 입력하면 파일 확인 버튼이 활성화됩니다.')
              : props.t('Select a registered project above before entering its comparison path.', '위에서 등록된 프로젝트를 선택한 뒤 비교 경로를 입력하세요.')}
          </p>
        )}
      </div>
      <details className="text-sm">
        <summary className="cursor-pointer text-muted-foreground">
          {props.t('What happens after checking the comparison?', '비교 파일을 확인한 뒤에는?')}
        </summary>
        <div className="mt-3 space-y-2 text-muted-foreground">
          <p>
            {props.t(
              'Ask your agent for one setup bundle, load it below, then confirm the summary. Saving also connects the comparison.',
              '에이전트에게 설정 묶음 하나를 받아 아래에서 불러온 뒤 요약을 확인하세요. 저장하면 비교 설정까지 연결됩니다.'
            )}
          </p>
          <p>
            {props.t(
              'Setup does not start an agent or measurement. harness-apply and harness-connect are later steps with separate support requirements.',
              '설정만으로 에이전트나 측정이 시작되지는 않습니다. harness-apply와 harness-connect는 이후 단계이며 별도 지원 조건이 있습니다.'
            )}
          </p>
        </div>
      </details>
      <div className="space-y-2">
        <Label htmlFor="guided-template">{props.t('Reuse registered measurement settings', '등록된 측정 설정 재사용')}</Label>
        <select
          id="guided-template"
          className="w-full rounded border bg-background p-2"
          disabled={props.busy}
          value={props.selectedTemplate?.id ?? ''}
          onChange={event => {
            props.change();
            props.setTemplate(event.target.value);
          }}
        >
          <option value="">{props.t('Provide new measurement settings', '새 측정 설정 제공')}</option>
          {props.setups
            .filter(setup => !setup.shared && setup.project_id === props.project?.id)
            .map(setup => (
              <option key={setup.id} value={setup.id}>
                {setup.name} · {setup.id}
              </option>
            ))}
        </select>
      </div>
      <Button
        disabled={props.busy || !props.project || !props.path.trim()}
        onClick={() => {
          void props.inspect();
        }}
      >
        {props.selectedTemplate ||
        Object.keys(props.documents).some(key => !['identifier', 'arm_a_status', 'arm_b_status'].includes(key) && !!props.documents[key]?.trim()) ||
        props.freezeAt
          ? props.t('Review inputs without saving', '저장 없이 입력 검토')
          : props.t('Check comparison file', '비교 파일 확인')}
      </Button>
      {props.inputError && (
        <p role="alert">
          {props.t('Invalid JSON. Correct the selected input; nothing was saved.', 'JSON이 올바르지 않습니다. 해당 입력을 수정하세요. 저장하지 않았습니다.')}
        </p>
      )}
      {props.inspected && (
        <div data-comparison-inspected="" className="space-y-2 rounded-lg border p-4 text-sm">
          <p className="font-medium">
            {props.review?.ready
              ? props.t('Comparison reviewed · ready to save', '비교 검토됨 · 저장 준비 완료')
              : props.review && !props.review.ready && 'comparison' in props.review
                ? props.t('Comparison file verified · not saved yet', '비교 파일 확인됨 · 아직 저장 전')
                : props.t('Previously checked comparison · verify again before saving', '이전에 확인한 비교 · 저장 전 다시 확인 필요')}
          </p>
          <p>
            A: {props.inspected.arm_a.version} → B: {props.inspected.arm_b.version}
          </p>
          <p data-comparison-application-mode={props.inspected.application_mode}>
            {props.t('How the harness is applied: ', '하네스 적용 방식: ')}
            {applicationModeText(props.inspected.application_mode, props.locale).title}
          </p>
          <p className="text-muted-foreground">
            {props.t(
              'The project and ordered manifests were checked. This does not prove that B is applied or that measurement is supported.',
              '프로젝트와 순서가 있는 manifest를 확인했습니다. B의 실제 적용이나 측정 지원을 뜻하지는 않습니다.'
            )}
          </p>
          <details>
            <summary>{props.t('Verified file references', '확인된 파일 정보')}</summary>
            <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(props.inspected, null, 2)}</pre>
          </details>
        </div>
      )}
    </>
  );
}
