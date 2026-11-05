import type { Locale } from './types.js';

export type AgentDisplayMetadata =
  { source: 'codex_session_meta'; nickname: string | null; role: string | null } | { source: 'claude_hook'; agent_type: string };
interface DisplaySession {
  session_id: string;
  parent_session_id: string | null;
  agent_metadata?: AgentDisplayMetadata | null;
}

// Hash the complete identity, including a Claude member ID. A shared UUID prefix
// must not collapse labels. Expand colliding suffixes within the displayed family.
function identitySuffix(id: string): string {
  let hash = 14695981039346656037n;
  for (const char of id) hash = BigInt.asUintN(64, (hash ^ BigInt(char.codePointAt(0)!)) * 1099511628211n);
  return hash.toString(16).padStart(16, '0');
}
export function sessionDisplayLabels(sessions: readonly DisplaySession[], locale: Locale): string[] {
  let childNumber = 0;
  const labels = sessions.map(session => {
    const fallback =
      session.parent_session_id === null ? (locale === 'ko' ? '부모' : 'Parent') : locale === 'ko' ? `자식 ${++childNumber}` : `Child ${++childNumber}`;
    const metadata = session.agent_metadata;
    const name =
      metadata?.source === 'codex_session_meta'
        ? metadata.nickname || fallback
        : metadata?.source === 'claude_hook'
          ? metadata.agent_type || fallback
          : fallback;
    const role = metadata?.source === 'codex_session_meta' ? metadata.role : null;
    return { name, label: role ? `${name} [${role}]` : name, id: session.session_id, hash: identitySuffix(session.session_id) };
  });
  return labels.map(value => {
    const duplicates = labels.filter(other => other.name === value.name);
    if (duplicates.length === 1) return value.label;
    let length = 8;
    while (length < 16 && duplicates.some(other => other.id !== value.id && other.hash.slice(0, length) === value.hash.slice(0, length))) length++;
    const collision = duplicates
      .filter(other => other.hash === value.hash)
      .map(other => other.id)
      .sort();
    const suffix = value.hash.slice(0, length) + (collision.length > 1 ? `-${collision.indexOf(value.id) + 1}` : '');
    return `${value.label} · ${suffix}`;
  });
}
