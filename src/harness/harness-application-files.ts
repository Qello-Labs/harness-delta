import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { hashBytes, readRepositoryFile, safeRelativePath } from '../core/repository-files.js';
export function applicationPath(path: string): void {
  const parts = path.toLowerCase().split('/');
  if (
    !safeRelativePath(path) ||
    parts.some(p => p.startsWith('.') || ['harness-config', 'node_modules'].includes(p)) ||
    parts.some(p => /^(?:credentials|secrets?)(?:\.|$)/.test(p))
  )
    throw new Error('application_path_forbidden');
}
export function optionalApplicationBytes(root: string, path: string): Buffer | null {
  applicationPath(path);
  // A missing ancestor is absent; symlinks and non-directories are never absent.
  let current = root;
  for (const [index, part] of path.split('/').entries()) {
    current = join(current, part);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || (index < path.split('/').length - 1 ? !stat.isDirectory() : !stat.isFile())) throw new Error('application_path_forbidden');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  return readRepositoryFile(root, path);
}
export function outputDigest(root: string, path: string): string | null {
  const bytes = optionalApplicationBytes(root, path);
  return bytes === null ? null : hashBytes(bytes);
}
