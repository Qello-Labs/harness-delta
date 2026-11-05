import { LocaleContext, ActionContext } from './app-controls';
import { useAppModel } from './hooks/use-app-model';
import { AppLayout } from './screens/AppLayout';
import { TasksScreen } from './screens/TasksScreen';
import { NewTaskScreen } from './screens/NewTaskScreen';
import { TaskDetailScreen } from './screens/TaskDetailScreen';
import { SetupScreen } from './screens/SetupScreen';
import { IntroScreen } from './screens/IntroScreen';
export { defaultSetupProjectId } from './setup-project';
export function App() {
  const model = useAppModel();
  const { locale, action, reason, busy, online, taskAction, loading, screen, selected } = model;
  return (
    <LocaleContext.Provider value={locale}>
      <ActionContext.Provider value={{ action, reason, busy, online, taskAction }}>
        <AppLayout model={model}>
          {!loading && screen === 'tasks' && <TasksScreen model={model} />}
          {!loading && screen === 'new' && <NewTaskScreen model={model} />}
          {!loading && screen === 'detail' && selected && <TaskDetailScreen model={model} selected={selected} />}
          {!loading && screen === 'setup' && <SetupScreen model={model} />}
          {!loading && screen === 'intro' && <IntroScreen model={model} />}
        </AppLayout>
      </ActionContext.Provider>
    </LocaleContext.Provider>
  );
}
