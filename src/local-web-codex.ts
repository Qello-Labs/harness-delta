import { lstatSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { codexBindingAdmission } from './codex-binding-admission.js';
import {
  installCodexConnectInstallation, previewCodexConnectInstallation,
  recoverCodexConnectInstallationLock, removeCodexConnectInstallation, statusCodexConnectInstallation,
} from './codex-connect-installation.js';
import { IdSchema } from './contracts.js';
import { CodexSessionBindingProvider } from './session-binding-codex.js';
import type { Store } from './store.js';

const sourceRoot = z.string().min(1).max(4096).refine(path => isAbsolute(path) && resolve(path) === path && !/[\0\r\n]/.test(path));
const settingsSchema = z.strictObject({
  product_version: z.literal(codexBindingAdmission.productVersion),
  source_roots: z.array(sourceRoot).min(1).max(16).refine(paths => new Set(paths).size === paths.length),
});
export const CodexProjectActionSchema = z.strictObject({
  operation: z.enum(['configure', 'preview-install', 'install', 'preview-remove', 'remove', 'recover-lock']),
  product_version: settingsSchema.shape.product_version.optional(),
  source_roots: settingsSchema.shape.source_roots.optional(),
  expected_package_hash: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
  expected_installed_hash: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
});
export type CodexProjectAction = z.infer<typeof CodexProjectActionSchema>;

export function codexReceiptDirectoryState(path: string): 'ready' | 'missing' | 'unsafe' {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink() && realpathSync(path) === path &&
      (stat.mode & 0o077) === 0 && stat.uid === process.getuid?.() ? 'ready' : 'unsafe';
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT' ? 'missing' : 'unsafe';
  }
}

export function createCodexProjectSetupManager(store: Store, metadata: Database.Database) {
  metadata.exec('CREATE TABLE IF NOT EXISTS web_codex_connections(project_id TEXT PRIMARY KEY, settings TEXT NOT NULL)');
  function project(projectId: string) {
    const row = store.get<{ local_root: string }>('SELECT local_root FROM projects WHERE id=?', [IdSchema.parse(projectId)]);
    if (!row || store.get("SELECT 1 FROM tombstones WHERE kind='project' AND id=?", [projectId]))
      throw new Error('unknown_project');
    return row.local_root;
  }
  function settings(projectId: string) {
    project(projectId);
    const row = metadata.prepare('SELECT settings FROM web_codex_connections WHERE project_id=?').get(projectId);
    const saved = z.object({ settings: z.string() }).optional().parse(row);
    return saved ? settingsSchema.parse(JSON.parse(saved.settings) as unknown) : undefined;
  }
  function defaults() {
    return settingsSchema.parse({
      product_version: codexBindingAdmission.productVersion,
      source_roots: [join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions')],
    });
  }
  function configuration(projectId: string) {
    if (!store.get('SELECT id FROM projects WHERE id=?', [projectId]) ||
      store.get("SELECT 1 FROM tombstones WHERE kind='project' AND id=?", [projectId])) {
      metadata.prepare('DELETE FROM web_codex_connections WHERE project_id=?').run(projectId);
      return undefined;
    }
    const saved = settings(projectId);
    return saved ? {
      product: 'codex' as const, product_version: saved.product_version,
      receipt_directory: join(project(projectId), '.harness-delta/codex-connect/receipts'),
      source_roots: saved.source_roots, project_root: project(projectId),
    } : undefined;
  }
  function pruneDeleted() {
    const rows = z.array(z.object({ project_id: z.string() }))
      .parse(metadata.prepare('SELECT project_id FROM web_codex_connections').all());
    for (const row of rows) {
      if (!store.get('SELECT id FROM projects WHERE id=?', [row.project_id]) ||
        store.get("SELECT 1 FROM tombstones WHERE kind='project' AND id=?", [row.project_id]))
        metadata.prepare('DELETE FROM web_codex_connections WHERE project_id=?').run(row.project_id);
    }
  }
  function inspect(projectId: string) {
    const root = project(projectId);
    const saved = settings(projectId);
    const effective = saved ?? defaults();
    const options = { productVersion: effective.product_version, sourceRoots: effective.source_roots };
    const installation = statusCodexConnectInstallation(root, options);
    const receiptPath = join(root, installation.receiptDirectory);
    const receiptDirectory = codexReceiptDirectoryState(receiptPath);
    let reason: string | null = !saved ? 'codex_connect_not_configured'
      : receiptDirectory === 'missing' ? 'receipt_directory_missing'
        : receiptDirectory === 'unsafe' ? 'receipt_directory_unsafe'
          : installation.state !== 'installed' ? installation.blockers[0] ?? 'codex_connect_package_missing' : null;
    if (reason === null) {
      try {
        new CodexSessionBindingProvider({
          receiptDirectory: receiptPath, sourceRoots: effective.source_roots, projectRoot: root,
          productVersion: effective.product_version,
        });
      } catch {
        reason = 'codex_connect_source_missing';
      }
    }
    const connection = store.get<{ roots: number; observing: number }>(
      `SELECT COUNT(*) AS roots, COALESCE(SUM(CASE WHEN b.state='observing' THEN 1 ELSE 0 END),0) AS observing
       FROM session_bindings b JOIN tasks t ON t.id=b.task_id
       WHERE t.project_id=? AND b.root_id=b.session_id AND json_extract(b.identity,'$.product')='codex'`, [projectId]);
    return {
      project_id: projectId, configured: saved !== undefined, product: 'codex' as const,
      product_version: effective.product_version, source_roots: effective.source_roots, installation,
      readiness: {
        receipt_directory: receiptDirectory, provider: reason === null ? 'ready' as const : 'blocked' as const,
        reason, hook_trust: 'manual_confirmation_required' as const, requires_new_session: true as const,
      },
      connection: connection ?? { roots: 0, observing: 0 },
      admission: {
        profile_id: codexBindingAdmission.profileId, qualified: true,
        max_family_members: codexBindingAdmission.maxFamilyMembers,
      },
    };
  }
  function action(projectId: string, input: CodexProjectAction) {
    const parsed = CodexProjectActionSchema.parse(input);
    const root = project(projectId);
    const effective = settings(projectId) ?? defaults();
    const options = { productVersion: effective.product_version, sourceRoots: effective.source_roots };
    if (['configure', 'install', 'remove', 'recover-lock'].includes(parsed.operation) &&
      store.get(`SELECT 1 FROM session_bindings b JOIN tasks t ON t.id=b.task_id
        WHERE t.project_id=? AND b.state='observing' AND json_extract(b.identity,'$.product')='codex'`, [projectId]))
      throw new Error('codex_connect_in_use');
    switch (parsed.operation) {
      case 'recover-lock':
        recoverCodexConnectInstallationLock(root, options);
        return inspect(projectId);
      case 'configure': {
        const next = settingsSchema.parse({
          product_version: parsed.product_version ?? effective.product_version,
          source_roots: parsed.source_roots ?? effective.source_roots,
        });
        metadata.prepare('INSERT INTO web_codex_connections(project_id,settings) VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET settings=excluded.settings')
          .run(projectId, JSON.stringify(next));
        return inspect(projectId);
      }
      case 'preview-install':
      case 'preview-remove': {
        const preview = previewCodexConnectInstallation(root, {
          ...options, operation: parsed.operation === 'preview-install' ? 'install' : 'remove',
        });
        return { ...inspect(projectId), installation: preview, changes: preview.changes };
      }
      case 'install':
      case 'remove': {
        if (!settings(projectId)) throw new Error('codex_connect_not_configured');
        const preview = previewCodexConnectInstallation(root, { ...options, operation: parsed.operation });
        if (parsed.expected_package_hash !== preview.packageHash || parsed.expected_installed_hash !== preview.installedHash)
          throw new Error('installation_preview_changed');
        const reviewed = {
          ...options, expectedPackageHash: parsed.expected_package_hash,
          expectedInstalledHash: parsed.expected_installed_hash,
        };
        if (parsed.operation === 'install') installCodexConnectInstallation(root, reviewed);
        else removeCodexConnectInstallation(root, reviewed);
        return inspect(projectId);
      }
    }
  }
  return { inspect, action, configuration, pruneDeleted };
}
