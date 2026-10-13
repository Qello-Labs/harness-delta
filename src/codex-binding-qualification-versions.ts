import { pinnedCodexWorkflowBinarySha } from './codex-workflow-adapter.js';

export const codexBindingQualificationVersions = ['0.160.0', '0.162.1'] as const;
export const codexBindingQualificationBinarySha = Object.freeze({
  '0.160.0': pinnedCodexWorkflowBinarySha,
  '0.162.1': '74c6a6d263f40d65f99c27a815275f5b4ed0bcc2baecc396b4cf3255498bdfc0',
});

export const codexBindingQualificationPolicies = Object.freeze({
  '0.160.0': { rootRequestStop: 4, totalRequestStop: 6, tokenStop: 100000, durationMs: 120000, helperNetworkPermission: 'none' },
  '0.162.1': { rootRequestStop: 8, totalRequestStop: 10, tokenStop: 200000, durationMs: 900000, helperNetworkPermission: 'single_command_network_only' },
} as const);
