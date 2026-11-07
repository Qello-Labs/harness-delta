import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

/** Source-reviewed leaf allowlists: ADR 007. Never traverse settings/instructions. */
export const codexRolloutPolicy = {
  revision: 'codex-rollout-m2-v1',
  collaborationModes: ['default', 'plan'],
  multiAgentVersions: ['disabled', 'v1', 'v2'],
  childItemTypes: ['SubAgentActivity', 'CollabAgentToolCall']
} as const;
export type CollaborationMode = 'default' | 'plan' | 'other' | 'missing';
export type MultiAgentVersion = 'disabled' | 'v1' | 'v2' | 'other' | 'missing';
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const canonical = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

export function collaborationMode(value: unknown): CollaborationMode {
  const mode = object(value).mode;
  return mode === undefined ? 'missing' : mode === 'default' || mode === 'plan' ? mode : 'other';
}
export function multiAgentVersion(value: unknown): MultiAgentVersion {
  return value === undefined ? 'missing' : value === 'disabled' || value === 'v1' || value === 'v2' ? value : 'other';
}
export function multiAgentAllowed(value: MultiAgentVersion): boolean {
  return (codexRolloutPolicy.multiAgentVersions as readonly string[]).includes(value);
}
export function childActivity(type: unknown, payload: Record<string, unknown>): boolean {
  return (
    type === 'event_msg' &&
    (payload.type === 'sub_agent_activity' ||
      (payload.type === 'item_completed' && (codexRolloutPolicy.childItemTypes as readonly unknown[]).includes(object(payload.item).type)))
  );
}
export function checkpointAllowed(payload: Record<string, unknown>, sessionId: string, root: string, model: string | null): boolean {
  const settings = object(payload.thread_settings);
  return (
    (payload.thread_id === undefined || payload.thread_id === null || payload.thread_id === sessionId) &&
    typeof settings.cwd === 'string' &&
    canonical(settings.cwd) === canonical(root) &&
    (settings.model === undefined || (typeof settings.model === 'string' && (model === null || settings.model === model)))
  );
}
