import { Field, Help } from '../app-controls';
import { Label } from '@/components/ui/label';
import type { AppModel } from '../hooks/use-app-model';

export function NewTaskOptions({ model }: { model: AppModel }) {
  const { t, kind, setKind, taskMode, setupData, size, setSize, projectData } = model;
  return (
    <details className="space-y-4 rounded-lg border p-4">
      <summary className="cursor-pointer font-medium">{t('Optional settings', '선택 항목')}</summary>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field
          id="type"
          label={t('Task type', '유형')}
          help={t(
            'Describes the original request. The selected measurement criteria determine allowed task types.',
            '원래 요청의 성격입니다. 선택한 측정 기준에서 허용하는 유형을 선택하세요.'
          )}
        >
          <select id="type" className="native-select" value={kind} onChange={e => setKind(e.target.value)}>
            {['feature', 'fix', 'infra', 'chore', 'docs', 'ci'].map(value => (
              <option key={value} value={value} disabled={taskMode === 'comparison' && setupData ? !setupData.types.includes(value) : false}>
                {value}
              </option>
            ))}
          </select>
        </Field>
        <Field
          id="size"
          label={t('Expected size', '예상 크기')}
          help={t(
            'Small: local change; medium: related changes; large: broader scope. Not a time or spending cap.',
            'small: 국소 변경, medium: 관련 변경, large: 넓은 범위입니다. 시간·비용 상한이 아닙니다.'
          )}
        >
          <select id="size" className="native-select" value={size} onChange={e => setSize(e.target.value)}>
            {['small', 'medium', 'large'].map(value => (
              <option key={value} value={value} disabled={taskMode === 'comparison' && setupData ? !setupData.sizes.includes(value) : false}>
                {value}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="mt-4">
        <Label>{t('Code baseline', '코드 기준 커밋')}</Label>
        <Help label={t('Code baseline', '코드 기준 커밋')}>
          {t('Read Git HEAD automatically. No new commit is created.', 'Git HEAD를 자동 조회합니다. 새 커밋을 만들지 않습니다.')}
        </Help>
        <p className="break-all text-sm text-muted-foreground">{projectData?.baseline ?? t('Read before preparation', '준비 전에 자동 조회')}</p>
      </div>
    </details>
  );
}
