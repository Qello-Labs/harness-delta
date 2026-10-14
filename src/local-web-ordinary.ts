import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { claudeBindingAdmission } from './claude-binding-admission.js';
import {
  installClaudeConnectInstallation, previewClaudeConnectInstallation,
  removeClaudeConnectInstallation, statusClaudeConnectInstallation,
  recoverClaudeConnectInstallationLock,
} from './claude-connect-installation.js';
import { IdSchema } from './contracts.js';
import {
  ordinaryProjectSettings, saveOrdinaryProjectSettings,
} from './ordinary-observation.js';
import type { Store } from './store.js';

export const OrdinaryProjectActionSchema = z.strictObject({
  operation: z.enum(['configure', 'preview-install', 'install', 'preview-remove', 'remove', 'recover-lock']),
  product_version: z.string().optional(),
  claude_projects_directory: z.string().min(1).max(4096).optional(),
  expected_package_hash: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
  expected_installed_hash: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
});
export type OrdinaryProjectAction = z.infer<typeof OrdinaryProjectActionSchema>;

function projectRoot(store: Store, projectId: string): string {
  const project = store.get<{ local_root: string | null }>(
    'SELECT local_root FROM projects WHERE id=?', [IdSchema.parse(projectId)]);
  if (!project?.local_root ||
    store.get("SELECT 1 FROM tombstones WHERE kind='project' AND id=?", [projectId]))
    throw new Error('unknown_project');
  return project.local_root;
}

export function ordinaryProjectDto(store: Store, projectId: string) {
  const root = projectRoot(store, projectId);
  const settings = ordinaryProjectSettings(store, projectId);
  return {
    project_id: projectId, configured: settings !== undefined, product: 'claude_code' as const,
    product_version: settings?.product_version ?? claudeBindingAdmission.productVersion,
    installation: statusClaudeConnectInstallation(root),
    admission: {
      profile_id: claudeBindingAdmission.profileId, qualified: claudeBindingAdmission.qualified,
      max_family_members: claudeBindingAdmission.maxFamilyMembers,
      model: claudeBindingAdmission.model,
    },
  };
}

export function ordinaryProjectAction(store: Store, projectId: string, input: OrdinaryProjectAction) {
  const action = OrdinaryProjectActionSchema.parse(input);
  const root = projectRoot(store, projectId);
  switch (action.operation) {
    case 'recover-lock':
      return { ...ordinaryProjectDto(store, projectId), installation: recoverClaudeConnectInstallationLock(root) };
    case 'configure': {
      if (action.product_version !== undefined && action.product_version !== claudeBindingAdmission.productVersion)
        throw new Error('claude_source_version_unsupported');
      const previous = ordinaryProjectSettings(store, projectId);
      const installation = statusClaudeConnectInstallation(root);
      saveOrdinaryProjectSettings(store, projectId, {
        schema_version: 1, product: 'claude_code', product_version: claudeBindingAdmission.productVersion,
        receipt_directory: join(root, installation.receiptDirectory),
        claude_projects_directory: action.claude_projects_directory ?? previous?.claude_projects_directory ??
          join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects'),
      });
      break;
    }
    case 'preview-install':
    case 'preview-remove': {
      const preview = previewClaudeConnectInstallation(root, {
        operation: action.operation === 'preview-install' ? 'install' : 'remove',
      });
      return { ...ordinaryProjectDto(store, projectId), installation: preview, changes: preview.changes };
    }
    case 'install': {
      if (!ordinaryProjectSettings(store, projectId)) throw new Error('ordinary_project_setup_required');
      const preview = previewClaudeConnectInstallation(root, { operation: 'install' });
      if (action.expected_package_hash !== preview.packageHash ||
        action.expected_installed_hash !== preview.installedHash) throw new Error('installation_preview_changed');
      const installed = installClaudeConnectInstallation(root, {
        expectedPackageHash: action.expected_package_hash, expectedInstalledHash: action.expected_installed_hash,
      });
      return { ...ordinaryProjectDto(store, projectId), installation: installed };
    }
    case 'remove': {
      if (store.get(`SELECT 1 FROM tasks t JOIN ordinary_tasks o ON o.task_id=t.id
        WHERE t.project_id=? AND t.state='active'`, [projectId]))
        throw new Error('ordinary_installation_in_use');
      const preview = previewClaudeConnectInstallation(root, { operation: 'remove' });
      if (action.expected_package_hash !== preview.packageHash ||
        action.expected_installed_hash !== preview.installedHash) throw new Error('installation_preview_changed');
      const removed = removeClaudeConnectInstallation(root, {
        expectedPackageHash: action.expected_package_hash, expectedInstalledHash: action.expected_installed_hash,
      });
      return { ...ordinaryProjectDto(store, projectId), installation: removed };
    }
  }
  return ordinaryProjectDto(store, projectId);
}
