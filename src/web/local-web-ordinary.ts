import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { defaultClaudeBindingVersion, getClaudeBindingAdmission } from '../claude-binding-admission.js';
import {
  installClaudeConnectInstallation,
  previewClaudeConnectInstallation,
  removeClaudeConnectInstallation,
  statusClaudeConnectInstallation,
  recoverClaudeConnectInstallationLock,
  type ClaudeConnectInstallationOptions
} from '../connect/claude-connect-installation.js';
import { IdSchema } from '../contracts.js';
import { ordinaryProjectSettings, saveOrdinaryProjectSettings } from '../ordinary-observation.js';
import { resolveOrdinaryWindow } from '../core/ordinary-window-policy.js';
import type { Store } from '../store.js';

export const OrdinaryProjectActionSchema = z.strictObject({
  operation: z.enum(['configure', 'preview-install', 'install', 'preview-remove', 'remove', 'recover-lock']),
  bundle_mode: z.enum(['exact', 'ordinary_window']).optional(),
  product_version: z.string().optional(),
  claude_projects_directory: z.string().min(1).max(4096).optional(),
  expected_package_hash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable()
    .optional(),
  expected_installed_hash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable()
    .optional()
});
export type OrdinaryProjectAction = z.infer<typeof OrdinaryProjectActionSchema>;

function projectRoot(store: Store, projectId: string): string {
  const project = store.get<{ local_root: string | null }>('SELECT local_root FROM projects WHERE id=?', [IdSchema.parse(projectId)]);
  if (!project?.local_root || store.get("SELECT 1 FROM tombstones WHERE kind='project' AND id=?", [projectId])) throw new Error('unknown_project');
  return project.local_root;
}

function bundleInUse(store: Store, projectId: string): boolean {
  return !!store.get(
    `SELECT 1 FROM ordinary_tasks o JOIN tasks t ON t.id=o.task_id
    WHERE t.project_id=? AND json_extract(t.metadata,'$.product')='claude_code'
      AND t.state!='finalized' AND o.revoked_at IS NULL
      AND (t.state='active' OR EXISTS (SELECT 1 FROM session_bindings b WHERE b.task_id=t.id AND b.state!='closed'))`,
    [projectId]
  );
}

function installationOptions(store: Store, projectId: string): ClaudeConnectInstallationOptions {
  const settings = ordinaryProjectSettings(store, projectId);
  return {
    ...(settings?.bundle_mode ? { bundleMode: settings.bundle_mode } : {}),
    windowInUse: () => bundleInUse(store, projectId)
  };
}

function projectAdmission(version: string, mode: 'exact' | 'ordinary_window') {
  if (mode === 'ordinary_window')
    return {
      profile_id: 'claude-binding-root-window-v1',
      admitted: false,
      qualified: false,
      max_family_members: 1,
      model_family: 'claude' as const
    };
  const admission = getClaudeBindingAdmission(version);
  if (!admission) throw new Error('claude_source_version_unsupported');
  return {
    profile_id: admission.profileId,
    admitted: admission.admitted,
    qualified: admission.qualified,
    max_family_members: admission.maxFamilyMembers,
    model_family: 'claude' as const
  };
}

export function ordinaryProjectDto(store: Store, projectId: string) {
  const root = projectRoot(store, projectId);
  const settings = ordinaryProjectSettings(store, projectId);
  const productVersion = settings?.product_version ?? defaultClaudeBindingVersion;
  projectAdmission(productVersion, settings?.bundle_mode ?? 'exact');
  const installation = statusClaudeConnectInstallation(root, installationOptions(store, projectId));
  const mode = settings?.bundle_mode ?? installation.bundleMode ?? 'exact';
  return {
    project_id: projectId,
    configured: settings !== undefined,
    product: 'claude_code' as const,
    product_version: productVersion,
    ...(settings?.bundle_mode || installation.bundleMode ? { bundle_mode: mode } : {}),
    installation,
    admission: projectAdmission(productVersion, mode),
    ...(mode === 'ordinary_window'
      ? {
          window: {
            policy_id: 'claude-binding-root-window-v1',
            policy_revision: 'claude-ordinary-root-window-v1',
            evidence_mode: 'publisher_verified_local_pin' as const,
            collection_enabled: false as const,
            reason: resolveOrdinaryWindow('claude_code', productVersion, 'claude-binding-root-window-v1')
              ? 'binding_window_activation_required'
              : 'binding_version_out_of_window'
          }
        }
      : {})
  };
}

function configureOrdinaryProject(store: Store, projectId: string, action: OrdinaryProjectAction): void {
  const root = projectRoot(store, projectId);
  const options = installationOptions(store, projectId);
  const previous = ordinaryProjectSettings(store, projectId);
  const currentMode = previous?.bundle_mode ?? statusClaudeConnectInstallation(root, options).bundleMode ?? 'exact';
  const mode = action.bundle_mode ?? currentMode;
  if (mode !== currentMode && action.product_version === undefined) throw new Error('claude_source_version_unsupported');
  if (mode !== currentMode && bundleInUse(store, projectId)) throw new Error('installation_busy');
  const productVersion = action.product_version ?? previous?.product_version ?? defaultClaudeBindingVersion;
  if (
    mode === 'ordinary_window'
      ? !resolveOrdinaryWindow('claude_code', productVersion, 'claude-binding-root-window-v1')
      : !getClaudeBindingAdmission(productVersion)?.admitted
  )
    throw new Error('claude_source_version_unsupported');
  const installation = statusClaudeConnectInstallation(root, { ...options, bundleMode: mode });
  saveOrdinaryProjectSettings(store, projectId, {
    schema_version: 1,
    product: 'claude_code',
    product_version: productVersion,
    ...(action.bundle_mode !== undefined || previous?.bundle_mode !== undefined || mode === 'ordinary_window' ? { bundle_mode: mode } : {}),
    ...(mode === 'ordinary_window' ? { bundle_revision: 'claude-window-bundle-v1' } : {}),
    receipt_directory: join(root, installation.receiptDirectory),
    claude_projects_directory:
      action.claude_projects_directory ?? previous?.claude_projects_directory ?? join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects')
  });
}

export function ordinaryProjectAction(store: Store, projectId: string, input: OrdinaryProjectAction) {
  const action = OrdinaryProjectActionSchema.parse(input);
  const root = projectRoot(store, projectId);
  const options = installationOptions(store, projectId);
  if (
    action.operation !== 'configure' &&
    action.bundle_mode !== undefined &&
    action.bundle_mode !== (options.bundleMode ?? statusClaudeConnectInstallation(root, options).bundleMode ?? 'exact')
  )
    throw new Error('installation_preview_changed');
  switch (action.operation) {
    case 'recover-lock':
      return { ...ordinaryProjectDto(store, projectId), installation: recoverClaudeConnectInstallationLock(root, options) };
    case 'configure':
      configureOrdinaryProject(store, projectId, action);
      break;
    case 'preview-install':
    case 'preview-remove': {
      const preview = previewClaudeConnectInstallation(root, {
        ...options,
        operation: action.operation === 'preview-install' ? 'install' : 'remove'
      });
      return { ...ordinaryProjectDto(store, projectId), installation: preview, changes: preview.changes };
    }
    case 'install': {
      if (!ordinaryProjectSettings(store, projectId)) throw new Error('ordinary_project_setup_required');
      const preview = previewClaudeConnectInstallation(root, { ...options, operation: 'install' });
      if (action.expected_package_hash !== preview.packageHash || action.expected_installed_hash !== preview.installedHash)
        throw new Error('installation_preview_changed');
      const installed = installClaudeConnectInstallation(root, {
        ...options,
        expectedPackageHash: action.expected_package_hash,
        expectedInstalledHash: action.expected_installed_hash
      });
      return { ...ordinaryProjectDto(store, projectId), installation: installed };
    }
    case 'remove': {
      if (
        store.get(
          `SELECT 1 FROM tasks t JOIN ordinary_tasks o ON o.task_id=t.id
        WHERE t.project_id=? AND t.state='active'`,
          [projectId]
        )
      )
        throw new Error('ordinary_installation_in_use');
      const preview = previewClaudeConnectInstallation(root, { ...options, operation: 'remove' });
      if (action.expected_package_hash !== preview.packageHash || action.expected_installed_hash !== preview.installedHash)
        throw new Error('installation_preview_changed');
      const removed = removeClaudeConnectInstallation(root, {
        ...options,
        expectedPackageHash: action.expected_package_hash,
        expectedInstalledHash: action.expected_installed_hash
      });
      return { ...ordinaryProjectDto(store, projectId), installation: removed };
    }
  }
  return ordinaryProjectDto(store, projectId);
}
