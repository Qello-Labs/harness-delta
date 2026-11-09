import { getEffectiveCodexBindingQualification } from '../core/tool-version-profiles.js';
export {
  codexBindingQualificationBinarySha,
  codexBindingQualificationPolicies,
  codexBindingQualificationVersions,
  getEffectiveCodexBindingQualification
} from '../core/tool-version-profiles.js';
export type { EffectiveCodexBindingQualification } from '../core/tool-version-profiles.js';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

type QualificationOperation = 'collect' | 'link' | 'restart' | 'resume';
type QualificationTopology = 'root' | 'bounded_family';
export function codexBindingQualificationCodeModeHost(
  binary: string,
  productVersion = '0.163.0',
  operation: QualificationOperation = 'collect',
  topology: QualificationTopology = 'root'
) {
  const qualification = getEffectiveCodexBindingQualification(productVersion, operation, topology);
  if (!qualification) {
    throw new Error('binding_qualification_code_mode_host_invalid');
  }
  const host = qualification.host;
  if (!host) return null;
  const path = join(dirname(binary), 'codex-code-mode-host');
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (
    !stat?.isFile() ||
    (stat.mode & 0o100) === 0 ||
    (stat.mode & 0o022) !== 0 ||
    stat.size > host.maxBytes ||
    (host.exactBytes !== undefined && stat.size !== host.exactBytes) ||
    realpathSync(path) !== path
  ) {
    throw new Error('binding_qualification_code_mode_host_invalid');
  }
  const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
  if (sha256 !== host.sha256) {
    throw new Error('binding_qualification_code_mode_host_invalid');
  }
  return { path, sha256 };
}
