import { expect, test } from 'vitest';
import { sessionDisplayLabels } from '../ui/src/session-labels.js';

const codex = (nickname: string | null, role: string | null) => ({ source: 'codex_session_meta' as const, nickname, role });

test('EN/KO labels use native names, separate roles and child ordinals independent of parent count', () => {
  const sessions = [
    { session_id: 'root-a', parent_session_id: null },
    { session_id: 'root-b', parent_session_id: null },
    { session_id: 'kid-1', parent_session_id: 'root-b' },
    { session_id: 'kid-2', parent_session_id: 'root-a', agent_metadata: codex(null, 'worker') },
    { session_id: 'kid-3', parent_session_id: 'root-a', agent_metadata: codex('Cedar', 'reviewer') },
    { session_id: 'kid-4', parent_session_id: 'root-a', agent_metadata: { source: 'claude_hook' as const, agent_type: 'my-plugin:reviewer' } }
  ];
  const en = sessionDisplayLabels(sessions, 'en');
  const ko = sessionDisplayLabels(sessions, 'ko');
  expect(en.slice(2)).toEqual(['Child 1', 'Child 2 [worker]', 'Cedar [reviewer]', 'my-plugin:reviewer']);
  expect(ko.slice(2)).toEqual(['자식 1', '자식 2 [worker]', 'Cedar [reviewer]', 'my-plugin:reviewer']);
  expect(en[0]).not.toEqual(en[1]);
});

test('duplicate names retain distinct identity suffixes even for shared UUID prefixes and Claude native roots', () => {
  const sessions = [
    { session_id: '12345678-abcd-4000-8000-000000000001', parent_session_id: 'root', agent_metadata: codex('Cedar', 'worker') },
    { session_id: '12345678-abcd-4000-8000-000000000002', parent_session_id: 'root', agent_metadata: codex('Cedar', 'worker') },
    {
      session_id: '12345678-abcd-4000-8000-000000000003:a',
      parent_session_id: 'root',
      agent_metadata: { source: 'claude_hook' as const, agent_type: 'Explore' }
    },
    {
      session_id: '12345678-abcd-4000-8000-000000000003:b',
      parent_session_id: 'root',
      agent_metadata: { source: 'claude_hook' as const, agent_type: 'Explore' }
    }
  ];
  const labels = sessionDisplayLabels(sessions, 'en');
  expect(new Set(labels).size).toBe(4);
  expect(labels[0]).toMatch(/^Cedar \[worker\] · [a-f0-9]{8,}$/);
  expect(labels[2]).toMatch(/^Explore · [a-f0-9]{8,}$/);
  expect(sessionDisplayLabels([...sessions].reverse(), 'en')).toEqual([...labels].reverse());
});
