import type { Protocol } from './comparison-contracts.js';

export interface RecruitmentWindow {
  starts_at: string;
  ends_at: string;
  state: 'before_start' | 'open' | 'ended';
}

export function localWebRecruitment(
  protocol: Pick<Protocol, 'recruitment_start' | 'recruitment_end'>,
  now = new Date().toISOString(),
): RecruitmentWindow {
  return {
    starts_at: protocol.recruitment_start, ends_at: protocol.recruitment_end,
    state: Date.parse(now) < Date.parse(protocol.recruitment_start) ? 'before_start'
      : Date.parse(now) >= Date.parse(protocol.recruitment_end) ? 'ended' : 'open',
  };
}
