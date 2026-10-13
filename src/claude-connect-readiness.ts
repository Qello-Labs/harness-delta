import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { dirname, join, parse, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export type ClaudeProjectSkillReadiness =
  | { readonly state: 'installed'; readonly reason: null; readonly install_command: null }
  | { readonly state: 'missing'; readonly reason: string; readonly install_command: string }
  | { readonly state: 'conflict' | 'unavailable'; readonly reason: string; readonly install_command: null };

const expectedFiles = ['SKILL.md', 'scripts/connect.mjs', 'scripts/claude-session-hook.mjs', 'references/support.md'] as const;
const maxFileBytes = 64 * 1024;
const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const packagedSource = join(moduleDirectory, moduleDirectory.endsWith(`${sep}dist`) ? 'skills' : '../skills', 'harness-connect');

class InspectionFailure extends Error {
  constructor(readonly state: 'conflict' | 'unavailable', readonly reason: string) {
    super(reason);
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

// Only metadata on the named path components is inspected, never directory entries.
function directoryChain(path: string, state: 'conflict' | 'unavailable'): string[] {
  const root = parse(path).root;
  const parts = path.slice(root.length).split(sep).filter(Boolean);
  if (parts.length > 128 || path.includes('\0')) throw new InspectionFailure('unavailable', 'path_invalid');
  const paths = [root];
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    paths.push(current);
  }
  for (const component of paths) {
    try {
      const stat = lstatSync(component);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new InspectionFailure(state, 'path_unsafe');
    } catch (error) {
      if (hasCode(error, 'ENOENT')) throw new InspectionFailure('unavailable', 'directory_unavailable');
      throw error;
    }
  }
  return paths;
}

function boundedBytes(path: string, state: 'conflict' | 'unavailable'): Buffer {
  const entry = lstatSync(path);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > maxFileBytes) {
    throw new InspectionFailure(state, 'package_file_invalid');
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxFileBytes || stat.ino !== entry.ino || stat.dev !== entry.dev) {
      throw new InspectionFailure(state, 'package_file_invalid');
    }
    const bytes = Buffer.alloc(maxFileBytes + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, null);
      if (count === 0) break;
      size += count;
    }
    if (size > maxFileBytes) throw new InspectionFailure(state, 'package_file_invalid');
    return bytes.subarray(0, size);
  } finally {
    closeSync(fd);
  }
}

function shellQuote(path: string): string {
  return `'${path.replaceAll("'", "'\\''")}'`;
}

function copyCommand(root: string, source: string): string {
  const claude = join(root, '.claude');
  const skills = join(claude, 'skills');
  const destination = join(skills, 'harness-connect');
  const guards = [...directoryChain(root, 'conflict'), ...directoryChain(source, 'unavailable'), join(source, 'scripts'), join(source, 'references')]
    .map(path => `[ ! -L ${shellQuote(path)} ] && [ -d ${shellQuote(path)} ]`);
  for (const file of expectedFiles) {
    const path = shellQuote(join(source, file));
    guards.push(`[ ! -L ${path} ] && [ -f ${path} ]`);
  }
  for (const path of [claude, skills]) {
    const quoted = shellQuote(path);
    guards.push(`[ ! -L ${quoted} ] && ( [ -d ${quoted} ] || mkdir ${quoted} )`);
  }
  // mkdir is the no-clobber reservation; cp never targets a pre-existing install.
  guards.push(`[ ! -L ${shellQuote(destination)} ] && [ ! -e ${shellQuote(destination)} ]`,
    `mkdir ${shellQuote(destination)}`, `mkdir ${shellQuote(join(destination, 'scripts'))}`, `mkdir ${shellQuote(join(destination, 'references'))}`);
  for (const file of expectedFiles) {
    guards.push(`cp ${shellQuote(join(source, file))} ${shellQuote(join(destination, file))}`);
  }
  return guards.join(' && ');
}

/** Package presence only: no source admission, trust, receipt or session readiness. */
export function inspectClaudeProjectSkill(projectRoot: string, packageSourceDirectory = packagedSource): ClaudeProjectSkillReadiness {
  try {
    const root = resolve(projectRoot);
    const source = resolve(packageSourceDirectory);
    directoryChain(source, 'unavailable');
    directoryChain(join(source, 'scripts'), 'unavailable');
    directoryChain(join(source, 'references'), 'unavailable');
    const bundled = expectedFiles.map(file => ({ file, bytes: boundedBytes(join(source, file), 'unavailable') }));
    directoryChain(root, 'conflict');
    let destination = root;
    for (const part of ['.claude', 'skills', 'harness-connect']) {
      destination = join(destination, part);
      try {
        const stat = lstatSync(destination);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new InspectionFailure('conflict', 'path_unsafe');
      } catch (error) {
        if (hasCode(error, 'ENOENT')) {
          return { state: 'missing', reason: 'project_skill_missing', install_command: copyCommand(root, source) };
        }
        throw error;
      }
    }
    try {
      directoryChain(join(destination, 'scripts'), 'conflict');
      directoryChain(join(destination, 'references'), 'conflict');
      for (const { file, bytes } of bundled) {
        if (!boundedBytes(join(destination, file), 'conflict').equals(bytes)) {
          throw new InspectionFailure('conflict', 'package_differs');
        }
      }
    } catch (error) {
      if (hasCode(error, 'ENOENT') || error instanceof InspectionFailure && error.reason === 'directory_unavailable') {
        throw new InspectionFailure('conflict', 'package_incomplete');
      }
      throw error;
    }
    return { state: 'installed', reason: null, install_command: null };
  } catch (error) {
    if (error instanceof InspectionFailure) return { state: error.state, reason: error.reason, install_command: null };
    return { state: 'unavailable', reason: 'inspection_unavailable', install_command: null };
  }
}
