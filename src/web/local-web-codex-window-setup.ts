import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { resolveOrdinaryWindow } from '../core/ordinary-window-policy.js';
import { statusCodexConnectInstallation } from '../connect/codex-connect-installation.js';
import { codexBindingAdmissions, isQualifiedCodexBindingAdmission } from '../codex-binding-admission.js';
import type { Store } from '../store.js';

export const CodexWindowPreferenceSchema = z.strictObject({
  schema_version: z.literal(2),
  mode: z.literal('ordinary_window'),
  product: z.literal('codex'),
  product_version: z.string().refine(version => resolveOrdinaryWindow('codex', version, 'codex-binding-root-window-v1') !== null),
  source_roots: z
    .array(
      z
        .string()
        .min(1)
        .max(4096)
        .refine(path => isAbsolute(path) && resolve(path) === path && path !== '/' && !/[\0\r\n]/.test(path))
    )
    .min(1)
    .max(16)
    .refine(paths => new Set(paths).size === paths.length)
});
export type CodexWindowPreference = z.infer<typeof CodexWindowPreferenceSchema>;
export function codexWindowConfiguration(root: string, saved: CodexWindowPreference) {
  return {
    ...saved,
    project_root: root,
    receipt_directory: join(root, '.harness-delta/window-receipts')
  };
}
export type CodexWindowConfiguration = ReturnType<typeof codexWindowConfiguration>;
export function codexWindowInstallationOptions(saved: CodexWindowPreference) {
  return {
    bundleMode: 'ordinary_window' as const,
    productVersion: saved.product_version,
    sourceRoots: saved.source_roots
  };
}
export function inspectCodexWindowSetup(store: Store, projectId: string, root: string, saved: CodexWindowPreference) {
  const resolved = resolveOrdinaryWindow('codex', saved.product_version, 'codex-binding-root-window-v1');
  if (!resolved) throw new Error('binding_version_out_of_window');
  const installation = statusCodexConnectInstallation(root, codexWindowInstallationOptions(saved));
  const connection = store.get<{ roots: number; observing: number }>(
    `SELECT COUNT(*) AS roots, COALESCE(SUM(CASE WHEN b.state='observing' THEN 1 ELSE 0 END),0) AS observing
    FROM session_bindings b JOIN tasks t ON t.id=b.task_id JOIN ordinary_window_selections w ON w.task_id=t.id
    WHERE t.project_id=? AND b.root_id=b.session_id AND json_extract(b.identity,'$.product')='codex'`,
    [projectId]
  );
  return {
    schema_version: 2 as const,
    mode: 'ordinary_window' as const,
    project_id: projectId,
    configured: true,
    product: 'codex' as const,
    product_version: saved.product_version,
    source_roots: saved.source_roots,
    installation,
    available_versions: codexBindingAdmissions.map(admission => admission.productVersion),
    unqualified_versions: codexBindingAdmissions
      .filter(admission => !isQualifiedCodexBindingAdmission(admission.productVersion))
      .map(admission => admission.productVersion),
    readiness: {
      receipt_directory: 'unverified' as const,
      provider: 'blocked' as const,
      reason: 'binding_window_activation_required',
      hook_trust: 'manual_confirmation_required' as const,
      requires_new_session: true as const
    },
    connection: connection ?? { roots: 0, observing: 0 },
    admission: {
      profile_id: resolved.policy.policyId,
      qualified: false,
      max_family_members: 1
    },
    window: {
      policy_id: resolved.policy.policyId,
      policy_revision: resolved.policy.ruleRevision,
      evidence_mode: 'source_only' as const,
      collection_enabled: false as const,
      reason: 'binding_window_activation_required'
    }
  };
}
export type CodexWindowSetupDto = ReturnType<typeof inspectCodexWindowSetup>;
