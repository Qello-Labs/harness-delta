import type { GuidedSetupModel } from '../hooks/use-guided-setup';
import { Label } from '@/components/ui/label';

type GuidedPolicyProps = Pick<GuidedSetupModel, 'inspected' | 'selectedTemplate' | 'documents' | 't' | 'busy' | 'change' | 'setDocuments'>;

export function GuidedPolicy(props: GuidedPolicyProps) {
  const { inspected } = props;
  return (
    <>
      {inspected && !props.selectedTemplate && !props.documents.variants?.trim() && (
        <details open={!(props.documents.arm_a_status && props.documents.arm_b_status)}>
          <summary className="cursor-pointer text-sm font-medium">
            {props.documents.arm_a_status && props.documents.arm_b_status
              ? props.t('Policy choices recorded · review or change', '정책 적격성 확인됨 · 확인하거나 변경')
              : props.t('Confirm remaining policy choices', '미결정 정책 적격성 확인')}
          </summary>
          <fieldset className="mt-3 space-y-3 rounded-lg border p-4 text-sm">
            <legend className="px-1 font-medium">{props.t('Confirm A/B policy eligibility', 'A/B 정책 적격성 확인')}</legend>
            <p className="text-muted-foreground">
              {props.t(
                'The manifests prove identity, not eligibility. After you explicitly decide both statuses, variant IDs and verified hash references are generated without filling in experimental criteria.',
                'manifest는 구성을 식별하지만 적격성까지 보증하지 않습니다. A/B 상태를 직접 결정하면 variant ID와 확인된 해시 참조를 자동 생성합니다. 완료 기준은 임의로 채우지 않습니다.'
              )}
            </p>
            {(['arm_a', 'arm_b'] as const).map((arm, index) => (
              <div key={arm} className="space-y-1">
                <Label htmlFor={`guided-${arm}-status`}>{index === 0 ? `A · ${inspected.arm_a.version}` : `B · ${inspected.arm_b.version}`}</Label>
                <select
                  id={`guided-${arm}-status`}
                  className="native-select"
                  value={props.documents[`${arm}_status`] ?? ''}
                  disabled={props.busy}
                  onChange={event => {
                    props.change();
                    props.setDocuments(old => ({ ...old, [`${arm}_status`]: event.target.value }));
                  }}
                >
                  <option value="">{props.t('Choose after review', '검토 후 선택')}</option>
                  <option value="eligible">{props.t('Eligible', '적격 확인')}</option>
                  <option value="ineligible">{props.t('Ineligible', '부적격')}</option>
                </select>
              </div>
            ))}
          </fieldset>
        </details>
      )}
    </>
  );
}
