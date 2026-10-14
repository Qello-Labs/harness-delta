import type { Locale } from './types.js';

export type ApplicationMode = 'selected_markdown_only' | 'agent_applied';
export const applicationModes = ['selected_markdown_only', 'agent_applied'] as const satisfies readonly ApplicationMode[];

const labels = {
  selected_markdown_only: {
    title: ['Instructions only', '지침만 전달'],
    choice: ['Only the instructions changed', '지침만 수정된 경우'],
    description: [
      'Only the instructions the agent reads differ. Preparation writes one managed instruction file; no agent edits the project before a session is connected.',
      '에이전트가 읽을 지침만 달라집니다. 준비 단계에서 관리 지침 파일 하나만 기록하며, 에이전트가 프로젝트를 수정하는 적용 단계 없이 세션을 연결합니다.',
    ],
  },
  agent_applied: {
    title: ['Applied by an agent', '에이전트가 프로젝트에 적용'],
    choice: ['An agent must apply it', '에이전트로 적용해야 하는 경우'],
    description: [
      'Installation, configuration or file changes are required. For each task you confirm the target checkout, a separate application session applies it with harness-apply, then a new working session is connected.',
      '설치·설정·파일 변경이 필요합니다. 작업마다 적용할 checkout을 확인하고, 별도 적용 세션에서 harness-apply로 적용한 뒤 새 작업 세션을 연결합니다.',
    ],
  },
} as const satisfies Record<ApplicationMode, Record<'title' | 'choice' | 'description', readonly [string, string]>>;

export function applicationModeText(mode: ApplicationMode, locale: Locale) {
  const index = locale === 'ko' ? 1 : 0;
  return { title: labels[mode].title[index], choice: labels[mode].choice[index], description: labels[mode].description[index] };
}
