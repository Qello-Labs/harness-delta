import type { Task } from './types.js';

export type ClaudeConnectionStage = 'install' | 'conflict' | 'unknown' | 'blocked' | 'ready' | 'starting' | 'measuring' | 'paused' | 'revoked' | 'ended';

export function claudeConnectionStage(task: Task): ClaudeConnectionStage | null {
  if (!task.connection_readiness || task.support_details?.context !== 'real'
    || task.support_details.connection_route !== 'family' || task.binding?.product !== 'claude_code') return null;
  if (task.outcome || task.measurement.state === 'measurement_ended') return 'ended';
  if (task.connection_readiness.collection_revoked) return 'revoked';
  if (task.measurement.state === 'active') return 'measuring';
  if (task.measurement.state === 'starting') return 'starting';
  if (task.measurement.state === 'paused') return 'paused';
  switch (task.connection_readiness.skill.state) {
    case 'missing': return 'install';
    case 'conflict': return 'conflict';
    case 'unavailable': return 'unknown';
    case 'installed': return task.actions.some(action => action.code === 'session-connect' && action.enabled) ? 'ready' : 'blocked';
  }
}

export function claudeConnectPrompt(task: Task, origin: string, locale: 'en' | 'ko'): string {
  return locale === 'ko'
    ? `/harness-connect 이 세션을 프로젝트 ${task.project_id}의 작업 ${task.id}에 연결해 주세요. 서버: ${origin}`
    : `/harness-connect Connect this session to project ${task.project_id}, task ${task.id}, using ${origin}.`;
}

export function claudeConnectionBlocker(task: Task): string | null {
  if (task.connection_readiness?.collection_revoked) return 'binding_scope_revoked';
  if (task.reason) return task.reason;
  return task.actions.find(action => action.code === 'session-connect' && !action.enabled)?.reason ?? null;
}
