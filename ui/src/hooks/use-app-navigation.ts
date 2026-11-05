import { useEffect } from 'react';
import type { Task } from '../types';
import * as api from '../api';
import type { Screen } from '../types';
import type { AppState } from './use-app-state';
export function useAppNavigation(state: AppState) {
  const { selectedRef, setScreen, setSelected, setCriteria, setError, setNotice, setTaskMenu } = state;
  useEffect(() => {
    const change = () => {
      const hash = location.hash.slice(1);
      if (hash.startsWith('task/')) {
        const id = decodeURIComponent(hash.slice(5));
        selectedRef.current = id;
        setScreen('detail');
        void api
          .task(id)
          .then(value => {
            if (selectedRef.current === id) {
              setSelected(value);
              setCriteria(value.criteria);
            }
          })
          .catch(() => {
            setError('local_operation_failed');
          });
      } else {
        setScreen((['new', 'setup', 'intro'].includes(hash) ? hash : 'tasks') as Screen);
      }
    };
    change();
    window.addEventListener('hashchange', change);
    return () => window.removeEventListener('hashchange', change);
  }, []);
  function navigate(next: Screen, task?: Task) {
    setError(null);
    setNotice(null);
    setTaskMenu(false);
    if (task) {
      selectedRef.current = task.id;
      setSelected(task);
      setCriteria(task.criteria);
      location.hash = `task/${encodeURIComponent(task.id)}`;
    } else {
      selectedRef.current = null;
      location.hash = next;
      setScreen(next);
    }
  }
  return navigate;
}
