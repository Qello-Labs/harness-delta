import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import {
  inspectWindowHookRegistration as inspect,
  planWindowHookRegistration as plan,
  WindowHookRegistrationError,
  WindowHookRegistrationSchema
} from '../src/connect/claude-window-registration.js';

const command = '"/synthetic/node" "/synthetic/.claude/skills/harness-connect/scripts/claude-window-session-hook.mjs" record';
const group = JSON.stringify({ hooks: [{ type: 'command', command, timeout: 10 }] });
const operator = '{"matcher":"resume","hooks":[{"type":"command","command":"echo \\"},[ \\\\ hello"}]}';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const installed = (text: string | null = '{}\n') => plan(text === null ? null : Buffer.from(text), undefined, command);

test.each([
  '{}\n',
  ' \r\n{ \t }\r\n',
  '{"$schema":"synthetic","x.y":1.25,"hyphen-key":-1e-3,"unicode":"\u65e5\u672c\u8a9e \u{1f600}","__proto__":null}\r\n',
  '{"same":1,"same":2,"nested":{"hooks":null,"hooks":3}}\n',
  '{ "hooks" : { \r\n\t } }\r\n',
  '{ "hooks" : {"Stop":[{"hooks":[]}]} }\n',
  '{ "hooks" : { "SessionStart" : [ \r\n\t ] } }\r\n',
  `{ "hooks" : { "SessionStart" : [\r\n ${operator} \t\r\n] } }\r\n`,
  `{ "h\\u006foks" : { "Session\\u0053tart" : [ ${operator} ] },"x":"\\uD800" }\n`
])('round trips exact operator bytes for %s', text => {
  const before = Buffer.from(text);
  const result = plan(before, undefined, command);
  const removed = plan(result.after, result.registration, null);
  expect(removed).toEqual({ after: before, registration: undefined, state: 'absent' });
  expect(before).toEqual(Buffer.from(text));
});

test('appends only the compact group before existing array trivia', () => {
  const before = `{"hooks":{"SessionStart":[ ${operator}\r\n ]},"fraction":0.125}\n`;
  const result = installed(before);
  expect(result.after).toEqual(Buffer.from(`{"hooks":{"SessionStart":[ ${operator},${group}\r\n ]},"fraction":0.125}\n`));
  expect(result.registration).toEqual({
    command,
    command_sha256: sha(command),
    group_sha256: sha(group),
    created_file: false,
    created_hooks: false,
    created_session_start: false
  });
  expect(WindowHookRegistrationSchema.parse(result.registration)).toEqual(result.registration);
});

test.each([
  [`{"hooks":{"SessionStart":[${group}, \r\n${operator}]}}`, `{"hooks":{"SessionStart":[ \r\n${operator}]}}`],
  [`{"hooks":{"SessionStart":[${operator},${group}, \t${operator}]}}`, `{"hooks":{"SessionStart":[${operator}, \t${operator}]}}`],
  [`{"hooks":{"SessionStart":[${operator}, ${group}]}}`, `{"hooks":{"SessionStart":[${operator} ]}}`],
  [`{"later":0.5,"hooks":{"SessionStart":[${group}],"Stop":[]}}`, '{"later":0.5,"hooks":{"Stop":[]}}'],
  [`{"hooks":{"SessionStart":[${group}]},"later":{"$schema":0.5}}`, '{"later":{"$schema":0.5}}']
])('preserves later operator changes when removing %s', (current, expected) => {
  const initial = installed();
  const result = plan(Buffer.from(current), initial.registration, null);
  expect(result.after).toEqual(Buffer.from(expected));
});

test('creates an absent file and deletes it only while otherwise empty', () => {
  const initial = installed(null);
  expect(initial.after).toEqual(Buffer.from(`{"hooks":{"SessionStart":[${group}]}}\n`));
  expect(plan(initial.after, initial.registration, null).after).toBeNull();
  const changed = Buffer.from(`{"hooks":{"SessionStart":[${group}]},"operator":false}\r\n`);
  expect(plan(changed, initial.registration, null).after).toEqual(Buffer.from('{"operator":false}\r\n'));
});

test.each(['{}', '{"hooks":{}}', '{"hooks":{"SessionStart":[]}}'])('retains preexisting empty containers in %s', text => {
  const initial = installed(text);
  expect(plan(initial.after, initial.registration, null).after).toEqual(Buffer.from(text));
});

test('leaves unowned remove and owned install noops unchanged', () => {
  const before = Buffer.from('not parsed for an unowned removal');
  expect(plan(before, undefined, null)).toEqual({ after: before, registration: undefined, state: 'absent' });
  const initial = installed();
  expect(plan(initial.after, initial.registration, command).after).toBe(initial.after);
  expect(inspect(Buffer.from('{}'), undefined)).toBe('absent');
  expect(inspect(initial.after, initial.registration)).toBe('present');
});

test.each([null, '{}', '{"hooks":{}}', '{"hooks":{"SessionStart":[]}}'])('reports missing ownership without recreating it for %s', text => {
  const initial = installed();
  const current = text === null ? null : Buffer.from(text);
  expect(inspect(current, initial.registration)).toBe('missing');
  for (const target of [command, null]) {
    expect(() => plan(current, initial.registration, target)).toThrowError(new WindowHookRegistrationError('window_registration_missing'));
  }
});

test.each([
  group.replace('"timeout":10', '"timeout":11'),
  JSON.stringify({ hooks: [{ type: 'command', command: 'echo edited', timeout: 10 }] }),
  group.replace('"hooks":', '"matcher":"startup","hooks":'),
  `${group},${group}`,
  group.replace('/synthetic/node', '/different/node'),
  group.replace('"command":', '"command":"ignored","command":')
])('blocks modified or duplicated owned groups: %s', changed => {
  const initial = installed();
  const current = Buffer.from(`{"hooks":{"SessionStart":[${changed}]}}`);
  if (changed.includes('"command":"ignored"')) {
    expect(() => inspect(current, initial.registration)).toThrowError(new WindowHookRegistrationError('window_settings_invalid'));
    return;
  }
  expect(inspect(current, initial.registration)).toBe('mismatched');
  for (const target of [command, null]) {
    expect(() => plan(current, initial.registration, target)).toThrowError(new WindowHookRegistrationError('window_registration_mismatched'));
  }
});

test.each([group.replace('{"hooks"', '{ "hooks"'), JSON.stringify({ hooks: [{ timeout: 10, command, type: 'command' }] }, null, 2)])(
  'accepts rewritten owned content with the original canonical manifest: %s',
  rewritten => {
    const initial = installed();
    const current = Buffer.from(`{"hooks":{"SessionStart":[${rewritten}]},"permissions":{"allow":[]}}`);
    expect(initial.registration).toMatchObject({ command_sha256: sha(command), group_sha256: sha(group) });
    expect(inspect(current, initial.registration)).toBe('present');
    expect(plan(current, initial.registration, command)).toEqual({ after: current, registration: initial.registration, state: 'present' });
  }
);

test('removes only a reformatted owned entry while preserving native rewrite bytes', () => {
  const initial = installed('{"hooks":{"SessionStart":[]}}');
  const rewritten = JSON.stringify({ hooks: [{ timeout: 10, command, type: 'command' }] }, null, 2).replace(/\n/g, '\n      ');
  const current = `{\n  "hooks": {\n    "SessionStart": [\n      ${rewritten},\n      ${operator}\n    ]\n  },\n  "disabledMcpjsonServers": ["synthetic-disabled"]\n}\n`;
  expect(plan(Buffer.from(current), initial.registration, null).after).toEqual(Buffer.from(current.replace(rewritten + ',', '')));
});

test('removes a rewritten installer-created file when its owned containers are now empty', () => {
  const initial = installed(null);
  const current = Buffer.from(JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ timeout: 10, command, type: 'command' }] }] } }, null, 2) + '\n');
  expect(plan(current, initial.registration, null).after).toBeNull();
});

test.each([
  `{"hooks":{"SessionStart":[${group}]}}`,
  '{"hooks":{"Stop":[{"hooks":[{"command":"node claude-session-hook.mjs"}]}]}}',
  '{"hooks":{"Other":{"nested":["prefix harness-connect suffix"]}}}',
  '{"hooks":{"Other":["claude-window-session-hook.mjs"]}}',
  '{"h\\u006foks":{"Other":["claude-\\u0073ession-hook.mjs"]}}'
])('refuses foreign harness hooks without manifest ownership: %s', text => {
  expect(() => installed(text)).toThrowError(new WindowHookRegistrationError('window_registration_conflict'));
});

test('refuses an identical foreign command even without the harness marker', () => {
  const current = Buffer.from('{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"echo hello","timeout":10}]}]}}');
  expect(() => plan(current, undefined, 'echo hello')).toThrowError(new WindowHookRegistrationError('window_registration_conflict'));
});

test('rejects foreign hooks alongside the exact owned group', () => {
  const initial = installed();
  const current = Buffer.from(`{"hooks":{"SessionStart":[${group}],"Stop":[{"command":"claude-session-hook.mjs"}]}}`);
  expect(inspect(current, initial.registration)).toBe('mismatched');
  expect(() => plan(current, initial.registration, null)).toThrowError(new WindowHookRegistrationError('window_registration_mismatched'));
});

test.each([
  '',
  '{"hooks":',
  '{"hooks":{},}',
  '[{}]',
  'null',
  '{"hooks":null}',
  '{"hooks":[]}',
  '{"hooks":{"SessionStart":{}}}',
  '{"hooks":{"SessionStart":[null]}}',
  '{"hooks":{"SessionStart":[[]]}}',
  '{"hooks":{"SessionStart":[{}]}}',
  '{"hooks":{"SessionStart":[{"hooks":{}}]}}',
  '{"hooks":{},"h\\u006foks":{}}',
  '{"hooks":{"SessionStart":[],"Session\\u0053tart":[]}}',
  '{"hooks":{"SessionStart":[{"hooks":[],"h\\u006foks":[]}]}}'
])('rejects unsafe JSON with categorical diagnostics: %s', text => {
  expect(() => installed(text)).toThrowError(new WindowHookRegistrationError('window_settings_invalid'));
  expect(() => inspect(Buffer.from(text), undefined)).toThrowError(new WindowHookRegistrationError('window_settings_invalid'));
});

test('rejects invalid UTF8 rather than rewriting replacement characters', () => {
  const before = Buffer.from([123, 34, 120, 34, 58, 34, 255, 34, 125]);
  expect(() => plan(before, undefined, command)).toThrowError(new WindowHookRegistrationError('window_settings_invalid'));
});

test.each([null, '{}', '{"hooks":{}}', '{"hooks":{"SessionStart":[]}}'])('updates command hashes while retaining initial cleanup ownership: %s', text => {
  const initial = installed(text);
  const nextCommand = command.replace('/synthetic/node', '/synthetic/new node');
  const updated = plan(initial.after, initial.registration, nextCommand);
  expect(updated.registration).toEqual({
    ...initial.registration,
    command: nextCommand,
    command_sha256: sha(nextCommand),
    group_sha256: sha(JSON.stringify({ hooks: [{ type: 'command', command: nextCommand, timeout: 10 }] }))
  });
  expect(inspect(updated.after, updated.registration)).toBe('present');
  expect(plan(updated.after, updated.registration, null).after).toEqual(text === null ? null : Buffer.from(text));
});

test.each(['command_sha256', 'group_sha256'] as const)('rejects a stale manifest %s', key => {
  const initial = installed();
  const owned = WindowHookRegistrationSchema.parse(initial.registration);
  const stale = { ...owned, [key]: '0'.repeat(64) };
  expect(inspect(initial.after, stale)).toBe('mismatched');
  expect(() => plan(initial.after, stale, null)).toThrowError(new WindowHookRegistrationError('window_registration_mismatched'));
});
