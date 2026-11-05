import type { GuidedSetupModel } from '../hooks/use-guided-setup';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type GuidedAdvancedProps = Pick<
  GuidedSetupModel,
  | 't'
  | 'identifier'
  | 'selectedTemplate'
  | 'busy'
  | 'change'
  | 'setDocuments'
  | 'suggestedIdentifier'
  | 'documents'
  | 'inputRevision'
  | 'active'
  | 'freezeAt'
  | 'setFreezeAt'
  | 'project'
  | 'path'
  | 'inspect'
>;

export function GuidedAdvanced(props: GuidedAdvancedProps) {
  return (
    <details>
      <summary className="cursor-pointer font-medium">
        {props.t('Advanced: individual files and technical values', '고급: 개별 파일·기술 값 직접 입력')}
      </summary>
      <Label htmlFor="guided-template-id">{props.t('Settings identifier (editable suggestion)', '설정 식별자 (자동 제안·직접 수정 가능)')}</Label>
      <Input
        id="guided-template-id"
        value={props.identifier}
        readOnly={!!props.selectedTemplate}
        disabled={props.busy}
        aria-describedby="guided-identifier-help"
        onChange={event => {
          props.change();
          props.setDocuments(old => ({ ...old, identifier: event.target.value }));
        }}
      />
      <p id="guided-identifier-help" role="status" className="break-keep text-sm text-muted-foreground">
        {props.selectedTemplate
          ? props.t(
              'This is the selected registered setting’s identifier. Its existing profile is reused.',
              '선택한 등록 설정의 식별자입니다. 기존 profile을 재사용합니다.'
            )
          : props.suggestedIdentifier
            ? props.t(
                'Suggested from the verified comparison. You may edit it; if you provide a profile JSON with an id, the two must match.',
                '확인된 비교에서 자동 제안했습니다. 수정할 수 있으며, profile JSON에 id가 있으면 서로 같아야 합니다.'
              )
            : props.t(
                'Check the comparison path first. An identifier will be suggested automatically; you can also enter one yourself.',
                '먼저 비교 경로를 확인하세요. 식별자가 자동 제안되며 직접 입력할 수도 있습니다.'
              )}
      </p>
      <p className="my-3 break-keep text-pretty text-sm">
        {props.t(
          'The comparison path can be checked without these files. For a first-time measurement setting, provide only the reviewed decisions not already registered; no criteria, source support or prices are invented.',
          '비교 경로 확인에는 아래 파일이 필요하지 않습니다. 처음 등록할 때는 이미 등록되지 않은 검토된 결정만 제공하세요. 완료 기준·원본 지원·가격은 만들어 넣지 않습니다.'
        )}
      </p>
      <p className="mb-3 break-keep text-sm">
        {props.t(
          'If you already have reviewed profile, variant, protocol or price JSON, add it here. Missing human decisions are listed after checking the comparison. An omitted profile id uses the suggested identifier.',
          '검토된 profile·variant·protocol·가격 JSON이 이미 있다면 여기에 넣으세요. 사람의 결정이 필요한 항목은 비교 확인 후 표시됩니다. profile의 id를 생략하면 제안된 식별자를 사용합니다.'
        )}
      </p>
      <div className="space-y-4">
        {(['profile', 'variants', 'protocol', 'price_table'] as const).map(key => (
          <div key={key} className="space-y-2">
            <Label htmlFor={`guided-${key}`}>{key} JSON</Label>
            <input
              type="file"
              accept=".json,application/json"
              disabled={props.busy || (key === 'profile' && !!props.selectedTemplate)}
              aria-label={`${key} JSON file`}
              onChange={event => {
                const file = event.target.files?.[0];
                if (!file) return;
                props.change();
                const revision = props.inputRevision.current;
                void file.text().then(value => {
                  if (!props.active.current || props.inputRevision.current !== revision) return;
                  props.change();
                  props.setDocuments(old => ({ ...old, [key]: value }));
                });
              }}
            />
            <textarea
              id={`guided-${key}`}
              className="min-h-32 w-full rounded border bg-background p-3 font-mono text-xs"
              value={props.documents[key] ?? ''}
              disabled={props.busy || (key === 'profile' && !!props.selectedTemplate)}
              onChange={event => {
                props.change();
                props.setDocuments(old => ({ ...old, [key]: event.target.value }));
              }}
            />
          </div>
        ))}
      </div>
      <div className="mt-4 space-y-2">
        <Label htmlFor="guided-freeze">{props.t('Override confirmation time (optional)', '확정 시각 직접 지정 (선택)')}</Label>
        <Input
          id="guided-freeze"
          value={props.freezeAt}
          disabled={props.busy}
          onChange={event => {
            props.change();
            props.setFreezeAt(event.target.value);
          }}
        />
      </div>
      <p className="mt-2 text-sm text-muted-foreground">
        {props.t('Leave the time blank to record server time when you confirm and save.', '비워두면 최종 확인하고 저장하는 서버 시각을 기록합니다.')}
      </p>
      <Button
        className="mt-4"
        variant="outline"
        disabled={props.busy || !props.project || !props.path.trim()}
        onClick={() => {
          void props.inspect();
        }}
      >
        {props.t('Review edited inputs', '수정한 입력 검토')}
      </Button>
    </details>
  );
}
