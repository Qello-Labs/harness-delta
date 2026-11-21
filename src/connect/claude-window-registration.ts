import { createHash } from 'node:crypto';
import { z } from 'zod';
import { container, insertEntry, parseWindowSettings, property, removeEntry, WindowHookRegistrationError } from './claude-window-registration-json.js';
import type { JsonContainer, JsonNode } from './claude-window-registration-json.js';

export { WindowHookRegistrationError } from './claude-window-registration-json.js';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const WindowHookRegistrationSchema = z.strictObject({
  command: z.string(),
  command_sha256: digest,
  group_sha256: digest,
  created_file: z.boolean(),
  created_hooks: z.boolean(),
  created_session_start: z.boolean()
});
export type WindowHookRegistration = z.infer<typeof WindowHookRegistrationSchema>;
type RegistrationState = 'absent' | 'present' | 'missing' | 'mismatched';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const groupJson = (command: string) => JSON.stringify({ hooks: [{ type: 'command', command, timeout: 10 }] });

function settings(before: Buffer | null) {
  const parsed = parseWindowSettings(before ?? Buffer.from('{}\n'));
  const hooksNode = property(parsed.root, 'hooks');
  const hooks = hooksNode === undefined ? undefined : container(hooksNode, 'object');
  const startsNode = hooks && property(hooks, 'SessionStart');
  const starts = startsNode === undefined ? undefined : container(startsNode, 'array');
  for (const entry of starts?.entries ?? []) {
    const group = container(entry.value, 'object');
    const nested = property(group, 'hooks');
    if (nested === undefined) throw new WindowHookRegistrationError('window_settings_invalid');
    container(nested, 'array');
  }
  return { ...parsed, hooks, starts };
}

function commandCount(node: JsonNode, command: string): number {
  if (node.kind === 'scalar') return 0;
  return node.entries.reduce(
    (total, entry) =>
      total + (entry.key === 'command' && entry.value.kind === 'scalar' && entry.value.value === command ? 1 : 0) + commandCount(entry.value, command),
    0
  );
}

function conflicting(node: JsonNode, permitted?: JsonNode): boolean {
  if (node === permitted) return false;
  if (node.kind === 'scalar') return typeof node.value === 'string' && /harness-connect|claude-(?:window-)?session-hook\.mjs/.test(node.value);
  return node.entries.some(entry => conflicting(entry.value, permitted));
}

function inspect(parsed: ReturnType<typeof settings>, owned: WindowHookRegistration | undefined): RegistrationState {
  if (!owned) return 'absent';
  if (hash(owned.command) !== owned.command_sha256) return 'mismatched';
  const count = parsed.hooks ? commandCount(parsed.hooks, owned.command) : 0;
  if (count === 0) return parsed.hooks && conflicting(parsed.hooks) ? 'mismatched' : 'missing';
  const group = parsed.starts?.entries.find(entry => commandCount(entry.value, owned.command) > 0)?.value;
  if (!group || count !== 1) return 'mismatched';
  const raw = parsed.text.slice(group.start, group.end);
  if (raw !== groupJson(owned.command) || hash(raw) !== owned.group_sha256 || (parsed.hooks && conflicting(parsed.hooks, group))) return 'mismatched';
  return 'present';
}

export function inspectWindowHookRegistration(before: Buffer | null, owned: WindowHookRegistration | undefined): RegistrationState {
  return inspect(settings(before), owned);
}

function removeOwned(parsed: ReturnType<typeof settings>, owned: WindowHookRegistration): string {
  const starts = parsed.starts;
  if (!starts) throw new WindowHookRegistrationError('window_registration_missing');
  const index = starts.entries.findIndex(entry => commandCount(entry.value, owned.command) > 0);
  let after = removeEntry(parsed.text, starts, index);
  // Reparse after each local edit so parent offsets never refer to old bytes.
  for (const name of ['SessionStart', 'hooks'] as const) {
    const current = settings(Buffer.from(after));
    const parent = name === 'SessionStart' ? current.hooks : current.root;
    const created = name === 'SessionStart' ? owned.created_session_start : owned.created_hooks;
    if (!parent || !created) continue;
    const value = property(parent, name);
    if (value && value.kind !== 'scalar' && value.entries.length === 0) {
      after = removeEntry(
        after,
        parent,
        parent.entries.findIndex(entry => entry.key === name)
      );
    }
  }
  return after;
}

export function planWindowHookRegistration(
  before: Buffer | null,
  owned: WindowHookRegistration | undefined,
  command: string | null
): { readonly after: Buffer | null; readonly registration: WindowHookRegistration | undefined; readonly state: RegistrationState } {
  if (!owned && command === null) return { after: before, registration: undefined, state: 'absent' };
  const parsed = settings(before);
  const state = inspect(parsed, owned);
  if (state === 'missing') throw new WindowHookRegistrationError('window_registration_missing');
  if (state === 'mismatched') throw new WindowHookRegistrationError('window_registration_mismatched');
  if (!owned && parsed.hooks && (conflicting(parsed.hooks) || (command !== null && commandCount(parsed.hooks, command) > 0))) {
    throw new WindowHookRegistrationError('window_registration_conflict');
  }
  if (owned && command === null) {
    const after = removeOwned(parsed, owned);
    const empty = parseWindowSettings(Buffer.from(after)).root.entries.length === 0;
    return { after: owned.created_file && empty ? null : Buffer.from(after), registration: undefined, state: 'absent' };
  }
  if (command === null) return { after: before, registration: undefined, state: 'absent' };
  if (owned?.command === command) return { after: before, registration: owned, state: 'present' };
  const group = groupJson(command);
  let after: string;
  if (owned) {
    const entry = parsed.starts?.entries.find(item => commandCount(item.value, owned.command) > 0);
    if (!entry) throw new WindowHookRegistrationError('window_registration_missing');
    after = parsed.text.slice(0, entry.start) + group + parsed.text.slice(entry.end);
  } else {
    const parent: JsonContainer = parsed.starts ?? parsed.hooks ?? parsed.root;
    const addition = parsed.starts ? group : parsed.hooks ? `"SessionStart":[${group}]` : `"hooks":{"SessionStart":[${group}]}`;
    after = insertEntry(parsed.text, parent, addition);
  }
  return {
    after: Buffer.from(after),
    registration: {
      command,
      command_sha256: hash(command),
      group_sha256: hash(group),
      created_file: owned?.created_file ?? before === null,
      created_hooks: owned?.created_hooks ?? parsed.hooks === undefined,
      created_session_start: owned?.created_session_start ?? parsed.starts === undefined
    },
    state: 'present'
  };
}
