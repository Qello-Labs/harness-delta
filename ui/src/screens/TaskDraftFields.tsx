import { Field } from '../app-controls';
import { OrdinaryObservationSetup, OrdinaryCriteria } from '../OrdinaryObservationSetup';
import { TaskErrorNotice } from '../TaskErrorNotice';
import { Input } from '@/components/ui/input';
import type { AppModel } from '../hooks/use-app-model';

export function TaskDraftFields({ model }: { model: AppModel }) {
  const {
    t,
    taskMode,
    setTaskMode,
    name,
    setName,
    project,
    setProject,
    setSetup,
    availableSetups,
    snapshot,
    ordinaryCriteria,
    setOrdinaryCriteria,
    locale,
    busy,
    online,
    perform,
    setup,
    setupLabel,
    error,
    setupData,
    reason
  } = model;
  return (
    <>
      <Field
        id="task-mode"
        label={t('Task mode', '작업 모드')}
        help={t('Observe ordinary Claude work or use the existing comparison workflow.', '일반 Claude 작업을 관측하거나 기존 비교 흐름을 사용하세요.')}
      >
        <select
          id="task-mode"
          className="native-select"
          value={taskMode}
          onChange={event => setTaskMode(event.target.value === 'ordinary' ? 'ordinary' : 'comparison')}
        >
          <option value="ordinary">{t('Ordinary Claude observation · no comparison required', '일반 Claude 관측 · 비교 설정 불필요')}</option>
          <option value="comparison">{t('Harness comparison · saved criteria required', '하네스 비교 · 저장된 측정 기준 필요')}</option>
        </select>
      </Field>
      <Field
        id="task-name"
        label={t('Task name', '작업명')}
        help={t('A private, recognizable label. Internal IDs are generated automatically.', '알아볼 수 있는 비공개 이름입니다. 내부 ID는 자동 생성합니다.')}
      >
        <Input id="task-name" value={name} onChange={e => setName(e.target.value)} placeholder={t('Implement login', '로그인 기능 구현')} maxLength={200} />
      </Field>
      <Field
        id="project"
        label={t('Project', '프로젝트')}
        help={t(
          'Choose a connected local directory. Add another directory in Setup.',
          '연결한 로컬 디렉토리를 선택하세요. 다른 디렉토리는 설정에서 추가합니다.'
        )}
      >
        <select
          id="project"
          className="native-select"
          value={project}
          onChange={e => {
            setProject(e.target.value);
            setSetup(availableSetups.find(s => s.project_id === e.target.value)?.id ?? '');
          }}
        >
          {snapshot.projects.map(p => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </Field>
      {taskMode === 'ordinary' ? (
        <>
          <OrdinaryCriteria selected={ordinaryCriteria} onChange={setOrdinaryCriteria} locale={locale} />
          {project && <OrdinaryObservationSetup key={project} projectId={project} locale={locale} busy={busy || !online} perform={perform} />}
        </>
      ) : (
        <Field
          id="setup"
          label={t('Measurement criteria for tasks', '작업에 적용할 측정 기준')}
          help={t(
            'Select saved settings for this project, including its fixed harness pair, criteria and price basis. If none are saved, prepare and connect a reviewed setting in Setup. Choose model and effort in your agent.',
            '이 프로젝트에 저장된 하네스 쌍·완료 기준·가격 기준을 선택하세요. 저장된 설정이 없다면 설정에서 새 설정을 검토·연결하세요. 모델과 effort는 에이전트에서 선택합니다.'
          )}
        >
          <select id="setup" className="native-select" value={setup} onChange={e => setSetup(e.target.value)}>
            <option value="">{t('Choose measurement criteria', '측정 기준 선택')}</option>
            {availableSetups
              .filter(s => s.project_id === project)
              .map(s => (
                <option key={s.id} value={s.id}>
                  {setupLabel(s)}
                </option>
              ))}
          </select>
        </Field>
      )}
      {taskMode === 'comparison' && error !== 'outside_recruitment' && setupData?.recruitment && setupData.recruitment.state !== 'open' && (
        <TaskErrorNotice code="outside_recruitment" locale={locale} recruitment={setupData.recruitment} fallback={reason('outside_recruitment')} />
      )}
    </>
  );
}
