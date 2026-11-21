export class WindowHookRegistrationError extends Error {
  constructor(readonly code: 'window_settings_invalid' | 'window_registration_conflict' | 'window_registration_missing' | 'window_registration_mismatched') {
    super(code);
    this.name = 'WindowHookRegistrationError';
  }
}

type Span = { readonly start: number; readonly end: number };
export type JsonEntry = Span & { readonly key: string | undefined; readonly value: JsonNode };
export type JsonContainer = Span & { readonly kind: 'object' | 'array'; readonly entries: readonly JsonEntry[] };
export type JsonNode = JsonContainer | (Span & { readonly kind: 'scalar'; readonly value: string | number | boolean | null });

const invalid = (): never => {
  throw new WindowHookRegistrationError('window_settings_invalid');
};

export function parseWindowSettings(bytes: Buffer): { readonly text: string; readonly root: JsonContainer } {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes)) invalid();
  try {
    JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) invalid();
    throw error;
  }
  let offset = 0;
  const whitespace = () => {
    while (/[ \t\r\n]/.test(text[offset] ?? '') && offset < text.length) offset++;
  };
  const string = (): string => {
    const start = offset++;
    while (offset < text.length) {
      if (text[offset] === '\\') offset += 2;
      else if (text[offset++] === '"') {
        const value: unknown = JSON.parse(text.slice(start, offset));
        return typeof value === 'string' ? value : invalid();
      }
    }
    return invalid();
  };
  const node = (depth: number, consumed: boolean): JsonNode => {
    whitespace();
    const start = offset;
    const character = text[offset];
    if (character !== '{' && character !== '[') {
      if (character === '"') {
        const value = string();
        return { kind: 'scalar', start, end: offset, value };
      }
      while (offset < text.length && !/[ \t\r\n,\]}]/.test(text[offset] ?? '')) offset++;
      const value: unknown = JSON.parse(text.slice(start, offset));
      if (value === null || typeof value === 'number' || typeof value === 'boolean') return { kind: 'scalar', start, end: offset, value };
      return invalid();
    }
    const kind = character === '{' ? 'object' : 'array';
    const close = kind === 'object' ? '}' : ']';
    const entries: JsonEntry[] = [];
    const keys = new Set<string>();
    offset++;
    whitespace();
    while (text[offset] !== close) {
      whitespace();
      const entryStart = offset;
      let key: string | undefined;
      if (kind === 'object') {
        key = string();
        if (keys.has(key) && (consumed || (depth === 0 && key === 'hooks'))) invalid();
        keys.add(key);
        whitespace();
        offset++;
      }
      const value = node(depth + 1, consumed || (depth === 0 && key === 'hooks'));
      entries.push({ start: entryStart, end: value.end, key, value });
      whitespace();
      if (text[offset] === ',') offset++;
    }
    return { kind, start, end: ++offset, entries };
  };
  const root = node(0, false);
  if (root.kind !== 'object') return invalid();
  return { text, root };
}

export function property(node: JsonContainer, name: string): JsonNode | undefined {
  return node.entries.find(entry => entry.key === name)?.value;
}

export function container(node: JsonNode, kind: 'object' | 'array'): JsonContainer {
  if (node.kind === 'scalar' || node.kind !== kind) return invalid();
  return node;
}

export function insertEntry(text: string, parent: JsonContainer, entry: string): string {
  const last = parent.entries.at(-1);
  const offset = last?.end ?? parent.start + 1;
  return text.slice(0, offset) + (last ? ',' : '') + entry + text.slice(offset);
}

export function removeEntry(text: string, parent: JsonContainer, index: number): string {
  const entry = parent.entries[index];
  if (!entry) return invalid();
  const previous = parent.entries[index - 1];
  const next = parent.entries[index + 1];
  // Keep all trivia; only the owned token span and one separator belong to this edit.
  if (previous) {
    const comma = text.indexOf(',', previous.end);
    return text.slice(0, comma) + text.slice(comma + 1, entry.start) + text.slice(entry.end);
  }
  if (next) {
    const comma = text.indexOf(',', entry.end);
    return text.slice(0, entry.start) + text.slice(entry.end, comma) + text.slice(comma + 1);
  }
  return text.slice(0, entry.start) + text.slice(entry.end);
}
