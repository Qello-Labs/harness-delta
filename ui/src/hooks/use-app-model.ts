import { taskSetupOptions } from '../setup-options';
import type { Setup } from '../types';
import { useAppState } from './use-app-state';
import { useAppBootstrap } from './use-app-bootstrap';
import { useLocalePersistence } from './use-locale-persistence';
import { useAppNavigation } from './use-app-navigation';
import { useTaskActions } from './use-task-actions';
import { defaultSetupProjectId } from '../setup-project';
import { taskReason } from '../task-reason';
import { taskStateLabel } from '../task-state-label';
export function useAppModel() {
  const state = useAppState();
  const {
    locale,
    snapshot,
    selectedSetupProject,
    setupSelectionRevision,
    project,
    setup,
    screen,
    selected,
    taskMode,
    setSetupProject,
    setSharedImport,
    setNotice,
    setError
  } = state;
  const t = (en: string, ko: string) => (locale === 'ko' ? ko : en);
  const setupLabel = (value: Setup) =>
    value.shared
      ? `${value.name} · ${value.shared.template_name} (${value.shared.template_id}) · ${value.shared.runtime.model ?? t('Native model', '네이티브 모델')} / ${value.shared.runtime.effort ?? t('Native effort', '네이티브 effort')} · ${value.id}`
      : `${value.name} · ${value.id}`;
  const availableSetups = taskSetupOptions(snapshot.setups);
  const setupProject = defaultSetupProjectId(selectedSetupProject, snapshot.projects);
  const setupRevision = setupSelectionRevision.current;
  const setupProjectData = snapshot.projects.find(value => value.id === setupProject) ?? null;
  const projectData = snapshot.projects.find(p => p.id === project);
  const setupData = snapshot.setups.find(s => s.id === setup);
  const errorRecruitment =
    screen === 'detail' && selected?.mode !== 'ordinary'
      ? selected?.recruitment
      : screen === 'new' && taskMode === 'comparison'
        ? setupData?.recruitment
        : undefined;
  // The first refresh must precede hash admission so direct task URLs retain request order.
  const reload = useAppBootstrap(state);
  useLocalePersistence(locale);
  const navigate = useAppNavigation(state);
  const actions = useTaskActions(state, reload);
  const { perform } = actions;
  function selectSetupProject(id: string) {
    if (id === setupProject) return;
    setupSelectionRevision.current++;
    setSetupProject(id);
    setSharedImport(null);
    setNotice(null);
    setError(null);
  }
  async function performSetup<T>(route: string, body: unknown): Promise<T | null> {
    const value = await perform<T>(route, body, undefined, setupRevision);
    return setupSelectionRevision.current === setupRevision ? value : null;
  }
  const reason = (code: string) => taskReason(code, locale, errorRecruitment, state.selected);
  const stateLabel = (value: string) => taskStateLabel(value, locale);
  return {
    ...state,
    ...actions,
    t,
    setupLabel,
    availableSetups,
    setupProject,
    setupRevision,
    setupProjectData,
    projectData,
    setupData,
    errorRecruitment,
    reload,
    navigate,
    selectSetupProject,
    performSetup,
    reason,
    stateLabel
  };
}
export type AppModel = ReturnType<typeof useAppModel>;
