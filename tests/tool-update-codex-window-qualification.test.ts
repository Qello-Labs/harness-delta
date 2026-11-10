import { expect, test } from 'vitest';
import { assessWindowContainment } from '../scripts/tool-update/codex-window-qualification.mjs';

const probes = ['loopback', 'external_tcp', 'dns', 'outside_read', 'home_stat', 'outside_write', 'exec_denied', 'quota'];
function results() {
  return [false, true].flatMap(descendant =>
    probes.map(name => ({
      name,
      descendant,
      ok: true,
      code: name === 'loopback' ? 'allowed' : name === 'quota' ? 'ENOSPC' : 'EPERM',
      written_bytes: name === 'quota' && !descendant ? 3800000000 : 0
    }))
  );
}

test('complete direct and descendant controls remain nonvendor-only evidence', () => {
  expect(assessWindowContainment(results())).toEqual({
    passed: true,
    actual_target_qualified: false,
    checked: 16
  });
});

test.each(['missing', 'duplicate', 'failed', 'wrong_denial', 'quota_not_filled'])('refuses %s qualification controls', variant => {
  const rows = results();
  if (variant === 'missing') rows.pop();
  if (variant === 'duplicate' && rows[1]) rows[0] = rows[1];
  if (variant === 'failed' && rows[0]) rows[0].ok = false;
  if (variant === 'wrong_denial' && rows[1]) rows[1].code = 'ETIMEDOUT';
  if (variant === 'quota_not_filled') {
    const quota = rows.find(row => row.name === 'quota' && !row.descendant);
    if (quota) quota.written_bytes = 0;
  }
  expect(assessWindowContainment(rows).passed).toBe(false);
});
