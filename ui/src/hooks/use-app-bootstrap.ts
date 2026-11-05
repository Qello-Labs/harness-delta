import { taskSetupOptions } from '../setup-options';
import { useEffect } from 'react';
import * as api from '../api';
import { subscribeTaskRefresh } from '../task-refresh';
import { defaultSetupProjectId } from '../setup-project';
import type { AppState } from './use-app-state';
export function useAppBootstrap(state: AppState) {
  const { setSetupProject, setProject, setSetup, selectedRef, setSelected, setSnapshot, setOnline, setLoading, busyRef } = state;
  async function reload() {
    try {
      const data = await api.bootstrap();
      setSetupProject(old => defaultSetupProjectId(old, data.projects));
      const available = taskSetupOptions(data.setups);
      setProject(old => (data.projects.some(p => p.id === old) ? old : available[0]?.project_id || data.projects[0]?.id || ''));
      setSetup(old => (available.some(s => s.id === old) ? old : available[0]?.id || ''));
      if (selectedRef.current) {
        const current = await api.task(selectedRef.current);
        if (selectedRef.current === current.id) setSelected(current);
      }
      setSnapshot(data);
      setOnline(true);
    } catch {
      setOnline(false);
    } finally {
      setLoading(false);
    }
  }
  useEffect(
    () =>
      subscribeTaskRefresh(() => {
        if (!busyRef.current) void reload();
      }),
    []
  );
  return reload;
}
