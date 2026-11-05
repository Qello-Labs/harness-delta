import { codexBindingQualificationHosts } from '../core/tool-version-profiles.js';
export { codexBindingQualificationVersions, codexBindingQualificationBinarySha, codexBindingQualificationPolicies } from '../core/tool-version-profiles.js';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function codexBindingQualificationCodeModeHost(binary: string, productVersion = '0.163.0') {
  if (productVersion === '0.160.0' || productVersion === '0.162.1') return null;
  if (productVersion !== '0.163.0' && productVersion !== '0.166.0') throw new Error('binding_qualification_code_mode_host_invalid');
  const path = join(dirname(binary), 'codex-code-mode-host');
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (
    !stat?.isFile() ||
    (stat.mode & 0o100) === 0 ||
    (stat.mode & 0o022) !== 0 ||
    stat.size > codexBindingQualificationHosts[productVersion].maxBytes ||
    (productVersion === '0.166.0' && stat.size !== codexBindingQualificationHosts['0.166.0'].exactBytes) ||
    realpathSync(path) !== path
  )
    throw new Error('binding_qualification_code_mode_host_invalid');
  const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
  if (sha256 !== codexBindingQualificationHosts[productVersion].sha256) throw new Error('binding_qualification_code_mode_host_invalid');
  return { path, sha256 };
}
