import type { Task } from './types';

export interface ApplicationChoice {
  readonly workspace: string;
  readonly workspaceDigest: string;
  readonly product: string;
}

export async function applyHarness(
  task: Task,
  choice: ApplicationChoice,
  perform: (route: string, body: unknown, version: string) => Promise<Task | null>
): Promise<Task | null> {
  if (!task.actions.some(action => action.code === 'application-prepare' && action.enabled)) return null;
  const route = `/api/tasks/${encodeURIComponent(task.id)}`;
  const prepared = await perform(`${route}/application-prepare`, choice, task.version);
  if (!prepared) return null;
  const canOpen = prepared.actions.some(action => action.code === 'application-open' && action.enabled);
  const available = prepared.application?.capabilities.find(agent => agent.id === choice.product)?.available;
  if (!canOpen || !available) return prepared;
  return perform(`${route}/application-open`, {}, prepared.version);
}
