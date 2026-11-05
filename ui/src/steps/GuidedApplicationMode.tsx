import type { GuidedSetupModel } from '../hooks/use-guided-setup';
import { applicationModes, applicationModeText } from '../application-mode';

type GuidedApplicationModeProps = Pick<
  GuidedSetupModel,
  't' | 'mode' | 'busy' | 'project' | 'review' | 'change' | 'setMode' | 'setCopied' | 'setManualPrompt' | 'fileMode' | 'locale' | 'modeMismatch'
>;

export function GuidedApplicationMode(props: GuidedApplicationModeProps) {
  return (
    <fieldset className="space-y-3 rounded-lg border p-4 break-keep" data-application-mode-choice={props.mode || 'unselected'}>
      <legend className="px-1 font-medium">{props.t('How is the harness applied?', '하네스를 어떻게 적용하나요?')}</legend>
      <p className="text-sm text-muted-foreground">
        {props.t(
          'This is separate from A/B assignment. It decides what happens after a harness is assigned to a task, so choose it before preparing the comparison.',
          'A/B 배정과는 별개입니다. 작업에 하네스가 배정된 뒤 무엇을 할지 정하므로, 비교를 준비하기 전에 선택하세요.'
        )}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {applicationModes.map(value => {
          const text = applicationModeText(value, props.locale);
          return (
            <label key={value} htmlFor={`guided-mode-${value}`} className="flex items-start gap-3 rounded-lg border p-3 has-[:checked]:bg-muted/60">
              <input
                type="radio"
                name="guided-application-mode"
                id={`guided-mode-${value}`}
                value={value}
                checked={props.mode === value}
                disabled={props.busy || !props.project}
                className="mt-1"
                onChange={() => {
                  if (!props.review?.ready) props.change();
                  props.setMode(value);
                  props.setCopied(null);
                  props.setManualPrompt(null);
                }}
              />
              <span className="min-w-0">
                <span className="block font-medium">{text.choice}</span>
                <span className="mt-1 block text-sm text-muted-foreground">{text.description}</span>
              </span>
            </label>
          );
        })}
      </div>
      {!props.mode && props.fileMode && (
        <p role="status" className="text-sm">
          {props.t('This comparison file uses: ', '이 비교 파일의 적용 방식: ')}
          <span className="font-medium">{applicationModeText(props.fileMode, props.locale).title}</span>
          {props.t('. Select the same method above to confirm it.', '. 위에서 같은 방식을 선택해 확인하세요.')}
        </p>
      )}
      {props.modeMismatch && props.fileMode && (
        <p role="alert" data-application-mode-mismatch="" className="text-sm">
          {props.t('Your selection differs from the comparison file, which uses: ', '선택한 방식이 비교 파일과 다릅니다. 비교 파일의 방식: ')}
          <span className="font-medium">{applicationModeText(props.fileMode, props.locale).title}</span>
          {props.t(
            '. Change the selection, or prepare a new comparison with the method you want. Nothing can be saved until they match.',
            '. 선택을 바꾸거나, 원하는 방식으로 새 비교 파일을 준비하세요. 일치하기 전에는 저장할 수 없습니다.'
          )}
        </p>
      )}
    </fieldset>
  );
}
