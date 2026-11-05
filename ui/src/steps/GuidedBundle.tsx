import type { GuidedSetupModel } from '../hooks/use-guided-setup';
import { Label } from '@/components/ui/label';

type GuidedBundleProps = Pick<GuidedSetupModel, 't' | 'busy' | 'loadingBundle' | 'project' | 'loadBundle' | 'bundleName' | 'bundleError'>;

export function GuidedBundle(props: GuidedBundleProps) {
  return (
    <section className="space-y-3 rounded-lg bg-muted/30 p-4" aria-labelledby="guided-bundle-label">
      <Label id="guided-bundle-label" htmlFor="guided-bundle">
        {props.t('Load prepared settings', '준비된 설정 불러오기')}
      </Label>
      <p className="break-keep text-sm text-muted-foreground">
        {props.t(
          'Choose the one setup bundle from your agent. Its contents are checked without saving.',
          '에이전트가 만든 설정 묶음 파일 하나를 선택하세요. 저장하지 않고 내용을 확인합니다.'
        )}
      </p>
      <input
        id="guided-bundle"
        type="file"
        accept=".json,application/json"
        className="block w-full min-w-0 text-sm file:mr-3 file:rounded-md file:border file:bg-background file:px-4 file:py-3"
        disabled={props.busy || props.loadingBundle || !props.project}
        onChange={event => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void props.loadBundle(file);
        }}
      />
      {props.loadingBundle && (
        <p role="status" className="text-sm">
          {props.t('Reading and checking settings…', '설정을 읽고 확인하는 중…')}
        </p>
      )}
      {props.bundleName && <p className="break-all text-sm">{props.bundleName}</p>}
      {props.bundleError && (
        <p role="alert" className="break-keep text-sm">
          {props.bundleError}
        </p>
      )}
    </section>
  );
}
