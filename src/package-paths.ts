import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const modulePath = fileURLToPath(import.meta.url);
const implementationRoot = dirname(modulePath);
export const implementationExtension = modulePath.endsWith('.ts') ? '.ts' : '.js';

export function packagePath(...parts: readonly string[]): string {
  return join(implementationRoot, '..', ...parts);
}

export function implementationPath(...parts: readonly string[]): string {
  return join(implementationRoot, ...parts);
}

export function packagedSkillPath(name: string): string {
  return implementationExtension === '.ts' ? packagePath('skills', name) : implementationPath('skills', name);
}
