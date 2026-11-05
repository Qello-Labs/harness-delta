import { AgentConnectionSetup } from '../AgentConnectionSetup';
import type { LocalWebSetupImportResult } from '../types';
import { SharedSetupPreview, type SharedSetupImport } from '../SharedSetupPreview';
import { GuidedSetup } from '../GuidedSetup';
import { SavedSetups } from '../SavedSetups';
import type { AppModel } from '../hooks/use-app-model';
import { ProjectSetup } from './ProjectSetup';
import { SetupPrices } from './SetupPrices';

export function SetupScreen({ model }: { model: AppModel }) {
  const {
    t,
    setupProject,
    locale,
    busy,
    online,
    performSetup,
    setupProjectData,
    snapshot,
    setupSelectionRevision,
    setupRevision,
    setSharedImport,
    setProject,
    setSetup,
    setNotice,
    setTaskMode,
    kind,
    setKind,
    size,
    setSize,
    navigate,
    sharedImport
  } = model;
  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold">{t('Local setup', '로컬 설정')}</h1>
        <p className="mt-2 text-muted-foreground">
          {t(
            'Connect a local project for ordinary Claude observation. Comparison settings are optional and prepared separately.',
            '로컬 프로젝트를 연결해 일반 Claude 작업을 관측하세요. 비교 설정은 필요한 경우 별도로 준비합니다.'
          )}
        </p>
      </div>
      <div className="grid gap-6 md:grid-cols-3">
        <div className="space-y-6 md:col-span-2">
          <ProjectSetup model={model} />
          {setupProject && (
            <AgentConnectionSetup key={`agent:${setupProject}`} projectId={setupProject} locale={locale} busy={busy || !online} perform={performSetup} />
          )}
          <GuidedSetup
            key={setupProject || 'unselected'}
            locale={locale}
            project={setupProjectData}
            setups={snapshot.setups}
            busy={busy || !online}
            perform={performSetup}
            onSaved={value => {
              if (setupSelectionRevision.current !== setupRevision) return;
              setSharedImport(null);
              setProject(setupProject);
              setSetup(value.profile_id);
              setNotice(
                t(
                  'Measurement settings saved and connected. You can use them for a new task below.',
                  '측정 설정을 저장하고 연결했습니다. 아래에서 이 설정으로 새 작업을 준비할 수 있습니다.'
                )
              );
            }}
          />
          <SavedSetups
            locale={locale}
            project={setupProjectData}
            setups={snapshot.setups}
            busy={busy || !online}
            onUse={selectedSetup => {
              setTaskMode('comparison');
              setProject(selectedSetup.project_id);
              setSetup(selectedSetup.id);
              if (!selectedSetup.types.includes(kind)) setKind(selectedSetup.types[0] ?? 'feature');
              if (!selectedSetup.sizes.includes(size)) setSize(selectedSetup.sizes[0] ?? 'small');
              navigate('new');
            }}
            onImport={() => {
              void performSetup<SharedSetupImport | LocalWebSetupImportResult>('/api/setup-picker', {}).then(value => {
                if (value && 'shared' in value) {
                  setSharedImport({ ...value, projects: value.projects.filter(p => p.project_id === setupProject) });
                  return;
                }
                if (value && 'imported' in value) {
                  if (value.added_count > 0) setNotice(t('Reviewed setup connected.', '검토된 설정을 연결했습니다.'));
                  else if (value.existing_count > 0) setNotice(t('This setup is already connected.', '이미 연결된 설정입니다.'));
                }
              });
            }}
            preview={
              sharedImport && (
                <SharedSetupPreview
                  key={sharedImport.token}
                  value={{ ...sharedImport, projects: sharedImport.projects.filter(p => p.project_id === setupProject) }}
                  locale={locale}
                  busy={busy || !online}
                  onCancel={() => setSharedImport(null)}
                  onBind={(project_id, template_id) => {
                    if (project_id !== setupProject) return;
                    void performSetup<{ already_connected: boolean }>('/api/setup-bind', {
                      token: sharedImport.token,
                      project_id,
                      template_id
                    }).then(value => {
                      if (value) {
                        setSharedImport(null);
                        setNotice(
                          value.already_connected
                            ? t('Settings already connected.', '이미 연결된 설정입니다.')
                            : t('Local settings connected.', '로컬 설정을 연결했습니다.')
                        );
                      }
                    });
                  }}
                />
              )
            }
          />
        </div>
        <SetupPrices model={model} />
      </div>
    </>
  );
}
