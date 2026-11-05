import type { GuidedSetupModel } from '../hooks/use-guided-setup';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';

type GuidedMeasurementRequestProps = Pick<GuidedSetupModel, 'measurementPrompt' | 't' | 'copying' | 'copyRequest' | 'copied' | 'manualPrompt'>;

export function GuidedMeasurementRequest(props: GuidedMeasurementRequestProps) {
  const { measurementPrompt } = props;
  return (
    <>
      {measurementPrompt && (
        <div className="space-y-3 rounded-lg border bg-muted/30 p-4 text-sm" data-measurement-request="">
          <p className="font-medium">{props.t('Ask your agent to prepare measurement settings', '에이전트에게 측정 설정 준비 요청')}</p>
          <p className="text-muted-foreground">
            {props.t(
              'Send this request to your agent. Answer its missing questions, then load the single setup bundle below.',
              '에이전트에게 요청문을 보내고 필요한 질문에 답하세요. 받은 설정 묶음 파일 하나를 바로 아래에서 불러오면 됩니다.'
            )}
          </p>
          <Button
            variant="outline"
            data-copy-skill="measurement-request"
            disabled={props.copying !== null}
            onClick={() => {
              void props.copyRequest('measurement', measurementPrompt);
            }}
          >
            {props.copied === 'measurement' ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
            {props.copied === 'measurement' ? props.t('Copied', '복사됨') : props.t('Copy measurement request', '측정 설정 요청문 복사')}
          </Button>
          {props.copied === 'measurement' && (
            <p role="status">
              {props.t(
                'Paste into your agent. You confirm the generated files before saving.',
                '에이전트에 붙여넣으세요. 생성된 파일은 저장 전에 직접 확인합니다.'
              )}
            </p>
          )}
          {props.manualPrompt?.kind === 'measurement' && (
            <div className="space-y-2">
              <p role="alert">
                {props.t('Clipboard access failed. Select and copy the request below.', '복사하지 못했습니다. 아래 요청문을 직접 복사하세요.')}
              </p>
              <textarea
                aria-label={props.t('Measurement request to copy manually', '직접 복사할 측정 설정 요청문')}
                readOnly
                rows={4}
                value={props.manualPrompt.text}
                onFocus={event => event.currentTarget.select()}
                className="w-full rounded border bg-background p-3 text-xs"
              />
            </div>
          )}
          <details>
            <summary className="cursor-pointer text-muted-foreground">{props.t('View measurement request', '측정 설정 요청문 보기')}</summary>
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">{measurementPrompt}</pre>
          </details>
        </div>
      )}
    </>
  );
}
