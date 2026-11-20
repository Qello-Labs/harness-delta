import { basename, isAbsolute } from 'node:path';

export function claudeProcessImagePath(text: string, pid: number): string | null {
  const fields = text.split('\n');
  if (fields.at(-1) === '') fields.pop();
  if (fields.shift() !== `p${pid}`) return null;
  const matches: string[] = [];
  let needsName = false;
  for (const field of fields) {
    if (field === 'ftxt') {
      if (needsName) return null;
      needsName = true;
      continue;
    }
    if (!needsName || !field.startsWith('n')) return null;
    const path = field.slice(1);
    if (!isAbsolute(path) || path.includes('\0') || path.split('/').some(part => part === '.' || part === '..')) return null;
    if (!path.includes('.app/') && (basename(path) === 'claude' || /\/claude\/versions\/\d+\.\d+\.\d+$/.test(path))) matches.push(path);
    needsName = false;
  }
  return !needsName && matches.length === 1 ? (matches[0] ?? null) : null;
}
