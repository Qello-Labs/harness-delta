import { useRef, useState } from 'react';
import type { Snapshot, Locale, Task } from '../types';
import type { SharedSetupImport } from '../SharedSetupPreview';
import type { Screen } from '../types';
const empty: Snapshot = { projects: [], setups: [], tasks: [], catalog: null };
function initialLocale(): Locale {
  try {
    return localStorage.getItem('harness-delta.locale') === 'en' ? 'en' : 'ko';
  } catch {
    return 'ko';
  }
}
function useBootstrapState() {
  const [snapshot, setSnapshot] = useState<Snapshot>(empty);
  const [loading, setLoading] = useState(true);
  const [online, setOnline] = useState(false);
  return { snapshot, setSnapshot, loading, setLoading, online, setOnline };
}
function useTaskNavigationState() {
  const [screen, setScreen] = useState<Screen>('tasks');
  const [selected, setSelected] = useState<Task | null>(null);
  const [criteria, setCriteria] = useState<string[]>([]);
  const [taskMenu, setTaskMenu] = useState(false);
  const selectedRef = useRef<string | null>(null);
  const shownHandoffs = useRef(new Set<string>());
  return { screen, setScreen, selected, setSelected, criteria, setCriteria, taskMenu, setTaskMenu, selectedRef, shownHandoffs };
}
function useTaskActionState() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ action: string; title: string; description: string } | null>(null);
  const busyRef = useRef(false);
  return { busy, setBusy, error, setError, notice, setNotice, confirm, setConfirm, busyRef };
}
function useSetupState() {
  const [sharedImport, setSharedImport] = useState<SharedSetupImport | null>(null);
  const [selectedSetupProject, setSetupProject] = useState('');
  const [directory, setDirectory] = useState('');
  const setupSelectionRevision = useRef(0);
  return { sharedImport, setSharedImport, selectedSetupProject, setSetupProject, directory, setDirectory, setupSelectionRevision };
}
function useTaskDraft() {
  const [taskMode, setTaskMode] = useState<'comparison' | 'ordinary'>('ordinary');
  const [ordinaryCriteria, setOrdinaryCriteria] = useState<string[]>(['user_confirmed_completion']);
  const [name, setName] = useState('');
  const [project, setProject] = useState('');
  const [setup, setSetup] = useState('');
  const [kind, setKind] = useState('feature');
  const [size, setSize] = useState('small');
  return { taskMode, setTaskMode, ordinaryCriteria, setOrdinaryCriteria, name, setName, project, setProject, setup, setSetup, kind, setKind, size, setSize };
}
export function useAppState() {
  const [locale, setLocale] = useState<Locale>(initialLocale);
  const bootstrapState = useBootstrapState();
  const taskNavigationState = useTaskNavigationState();
  const taskActionState = useTaskActionState();
  const setupState = useSetupState();
  const taskDraft = useTaskDraft();
  return { locale, setLocale, ...bootstrapState, ...taskNavigationState, ...taskActionState, ...setupState, ...taskDraft };
}
export type AppState = ReturnType<typeof useAppState>;
