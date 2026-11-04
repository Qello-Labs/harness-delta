import { pinnedCodexWorkflowBinarySha } from './codex-workflow-adapter.js';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

const codeModeHostPins = {
  '0.163.0': '79f123a85dbc61e8f5d0f0c050dfc3f4b81a8305d33a32b41e008b7f6e035698',
  '0.166.0': 'fd37051bfdce0b65cf22a7077e265720a7bd6709d5e400dcbc26197f3041400a'
} as const;

export function codexBindingQualificationCodeModeHost(binary: string, productVersion = '0.163.0') {
  if (productVersion === '0.160.0' || productVersion === '0.162.1') return null;
  if (productVersion !== '0.163.0' && productVersion !== '0.166.0') throw new Error('binding_qualification_code_mode_host_invalid');
  const path = join(dirname(binary), 'codex-code-mode-host');
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (
    !stat?.isFile() ||
    (stat.mode & 0o100) === 0 ||
    (stat.mode & 0o022) !== 0 ||
    stat.size > 128 * 1024 * 1024 ||
    (productVersion === '0.166.0' && stat.size !== 69182864) ||
    realpathSync(path) !== path
  )
    throw new Error('binding_qualification_code_mode_host_invalid');
  const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
  if (sha256 !== codeModeHostPins[productVersion]) throw new Error('binding_qualification_code_mode_host_invalid');
  return { path, sha256 };
}

export const codexBindingQualificationVersions = ['0.160.0', '0.162.1', '0.163.0', '0.166.0'] as const;
export const codexBindingQualificationBinarySha = Object.freeze({
  '0.160.0': pinnedCodexWorkflowBinarySha,
  '0.162.1': '74c6a6d263f40d65f99c27a815275f5b4ed0bcc2baecc396b4cf3255498bdfc0',
  '0.163.0': '8813367285524ac798dd96d1b071aea30d58708c7226fd236cd275cf1cfdee31',
  '0.166.0': '39acf979729dd290f9a24ee38b2914e036c91b65952872e28ae2a6b88a7db7c1'
});

export const codexBindingQualificationPolicies = Object.freeze({
  '0.160.0': { rootRequestStop: 4, totalRequestStop: 6, tokenStop: 100000, durationMs: 120000, helperNetworkPermission: 'none' },
  '0.162.1': { rootRequestStop: 8, totalRequestStop: 10, tokenStop: 200000, durationMs: 900000, helperNetworkPermission: 'single_command_network_only' },
  '0.163.0': { rootRequestStop: 8, totalRequestStop: 10, tokenStop: 200000, durationMs: 900000, helperNetworkPermission: 'single_command_network_only' },
  '0.166.0': { rootRequestStop: 10, totalRequestStop: 12, tokenStop: 300000, durationMs: 900000, helperNetworkPermission: 'single_command_network_only' }
} as const);
