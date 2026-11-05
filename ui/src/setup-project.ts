import type { Snapshot } from './types';
export function defaultSetupProjectId(selected: string, projects: Snapshot['projects']): string {
  return selected || (projects.length === 1 ? (projects[0]?.id ?? '') : '');
}
