import * as api from '../api';
import type { TaskAction, Task } from '../types';
import type { ApplicationChoice } from '../application-actions';
import { applyHarness } from '../application-actions';
import type { AppState } from './use-app-state';
export function useTaskActions(state: AppState, reload: () => Promise<void>) {
  const { selected, online, busyRef, setBusy, setError, setNotice, setupSelectionRevision, setSelected, setCriteria, criteria } = state;
  const action = (code: string): TaskAction | undefined => selected?.actions.find(a => a.code === code);
  async function perform<T>(route: string, body: unknown, version?: string, expectedSetupRevision?: number): Promise<T | null> {
    if (busyRef.current || !online) return null;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const value = await api.mutate<T>(route, body, version);
      await reload();
      return value;
    } catch (e) {
      if (expectedSetupRevision === undefined || expectedSetupRevision === setupSelectionRevision.current)
        setError(e instanceof api.LocalApiError ? e.code : 'local_operation_failed');
      await reload();
      return null;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  async function taskAction(code: string, body: unknown = {}) {
    if (!selected || !action(code)?.enabled) return;
    const value = await perform<Task>(`/api/tasks/${encodeURIComponent(selected.id)}/${code}`, body, selected.version);
    if (value) {
      setSelected(value);
      setCriteria(value.criteria.length === 1 ? value.criteria : criteria);
    }
  }
  async function applySelectedHarness(choice: ApplicationChoice) {
    if (!selected) return;
    const value = await applyHarness(selected, choice, (route, body, version) => perform<Task>(route, body, version));
    if (value) {
      setSelected(value);
      setCriteria(value.criteria.length === 1 ? value.criteria : criteria);
    }
  }
  async function chooseSession() {
    if (!selected) return;
    const value = await perform<{ selection: { handle: string; label: string } | null }>(`/api/tasks/${selected.id}/session-picker`, {}, selected.version);
    if (value?.selection) await taskAction('connect', { source_handle: value.selection.handle });
  }
  return { action, perform, taskAction, applySelectedHarness, chooseSession };
}
