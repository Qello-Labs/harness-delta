import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { IdSchema } from '../contracts.js';
import { Lifecycle, utcNow } from '../lifecycle.js';
import { createOrdinaryWindowTask, ordinaryTask, revokeOrdinaryObservation } from '../ordinary-observation.js';
import { collectOrdinaryCodexWindow, connectOrdinaryCodexWindow } from '../ordinary-session-binding.js';
import {
  assertOrdinaryWindowAuthority,
  assertOrdinaryWindowPrepared,
  ordinaryWindowSelection,
  ordinaryWindowSelectionHash,
  pauseOrdinaryWindowSegment
} from '../core/ordinary-window-store.js';
import { ordinaryWindowDecisionKeyForSelection, readOrdinaryWindowDecision } from '../core/ordinary-window-activation.js';
import type { Store } from '../store.js';
import type { createLocalWebMetadata } from './local-web-metadata-store.js';
import type { createCodexProjectSetupManager } from './local-web-codex.js';
import { CodexWindowPreferenceSchema } from './local-web-codex-window-setup.js';
import { withLiveWebMetadataScope } from './local-web-metadata.js';

export const CodexWindowPrepareSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  criterion_ids: z
    .array(IdSchema)
    .min(1)
    .max(256)
    .refine(ids => new Set(ids).size === ids.length)
});
export const CodexWindowConnectSchema = z.strictObject({
  project_id: IdSchema,
  product: z.literal('codex'),
  receipt: z.uuid()
});
export const CodexWindowActionSchema = z.strictObject({
  project_id: IdSchema,
  operation: z.enum(['start', 'pause', 'resume', 'revoke-collection', 'collect'])
});
const frozenSetupSchema = z.strictObject({
  schema_version: z.literal(1),
  kind: z.literal('codex_window_setup'),
  selection_hash: z.string().regex(/^[a-f0-9]{64}$/),
  configuration: CodexWindowPreferenceSchema.extend({
    project_root: z.string(),
    receipt_directory: z.string()
  })
});
const closedReasons = z.enum([
  'binding_window_activation_required',
  'binding_scope_revoked',
  'binding_scope_mismatch',
  'compatibility_invalidated',
  'binding_window_trial_expired',
  'binding_window_trial_budget_exhausted',
  'binding_fresh_root_required',
  'binding_window_unavailable'
]);
export type CodexWindowTaskReason = z.infer<typeof closedReasons>;

class LocalCodexWindowControl {
  private readonly life: Lifecycle;
  constructor(
    private readonly store: Store,
    private readonly metadata: ReturnType<typeof createLocalWebMetadata>,
    private readonly projects: Pick<ReturnType<typeof createCodexProjectSetupManager>, 'windowConfiguration'>
  ) {
    this.life = new Lifecycle(store);
  }
  private context(taskId: string) {
    const task = this.life.task(taskId);
    const selection = ordinaryWindowSelection(this.store, taskId);
    if (
      !selection ||
      selection.projectId !== task.project_id ||
      selection.policy.product !== 'codex' ||
      selection.policy.policyId !== 'codex-binding-root-window-v1' ||
      selection.policy.evidenceMode !== 'source_only'
    ) {
      throw new Error('binding_scope_mismatch');
    }
    if (this.store.get("SELECT 1 FROM tombstones WHERE (kind='task' AND id=?) OR (kind='project' AND id=?)", [taskId, task.project_id])) {
      throw new Error('deleted_identifier');
    }
    const record = this.metadata.task(taskId);
    if (!record || record.profile_id !== 'ordinary-codex-window-v1') {
      throw new Error('ordinary_preparation_required');
    }
    const frozen = frozenSetupSchema.parse(JSON.parse(record.setup) as unknown);
    const root = this.store.get<{ local_root: string }>('SELECT local_root FROM projects WHERE id=?', [task.project_id])?.local_root;
    if (
      !root ||
      frozen.selection_hash !== ordinaryWindowSelectionHash(selection) ||
      frozen.configuration.product_version !== selection.declaredVersion ||
      root !== frozen.configuration.project_root ||
      frozen.configuration.receipt_directory !== join(root, '.harness-delta/window-receipts')
    ) {
      throw new Error('ordinary_configuration_changed');
    }
    return { task, selection, frozen };
  }
  private authorize(taskId: string, projectId: string, rootSessionId?: string) {
    const value = this.context(taskId);
    if (value.task.project_id !== projectId) {
      throw new Error('binding_scope_mismatch');
    }
    assertOrdinaryWindowAuthority(this.store, {
      taskId,
      generation: value.task.generation,
      ...(rootSessionId === undefined ? {} : { rootSessionId })
    });
    return value;
  }
  task(taskId: string) {
    return this.store.immediateTransaction(() => this.readTask(taskId));
  }
  private readTask(taskId: string) {
    const value = this.context(taskId);
    const prepared = ordinaryTask(this.store, taskId);
    const selected = prepared?.selected_root_id ?? null;
    let reason: CodexWindowTaskReason | null = null;
    try {
      this.authorize(taskId, value.task.project_id);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      reason = closedReasons.parse(error.message);
    }
    let connectedRoot = reason === null ? selected : null;
    if (connectedRoot !== null) {
      try {
        this.authorize(taskId, value.task.project_id, connectedRoot);
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'binding_scope_revoked') throw error;
        connectedRoot = null;
      }
    }
    const segment = selected
      ? this.store.get<{ state: string; revision: number; cursor: string | null }>(
          `SELECT s.state,s.revision,b.cursor,b.generation,b.state AS binding_state FROM binding_root_segments s
          LEFT JOIN session_bindings b ON b.session_id=s.root_session_id WHERE s.root_session_id=?`,
          [selected]
        )
      : undefined;
    const decision = readOrdinaryWindowDecision(this.store, ordinaryWindowDecisionKeyForSelection(value.selection));
    const blocks = this.store.all('SELECT * FROM source_compatibility_blocks WHERE product=? AND product_version=? AND source=?', [
      value.selection.policy.product,
      value.selection.declaredVersion,
      value.selection.policy.source
    ]);
    const version =
      '"' +
      createHash('sha256')
        .update(
          JSON.stringify({
            ...value,
            prepared,
            segment,
            decision,
            blocks,
            reason
          })
        )
        .digest('hex') +
      '"';
    return {
      schema_version: 1 as const,
      kind: 'codex_window_task' as const,
      project_id: value.task.project_id,
      task_id: taskId,
      version,
      state: value.task.state,
      connection_enabled: reason === null,
      reason,
      selected_root_id: connectedRoot
    };
  }
  prepare(projectId: string, input: z.infer<typeof CodexWindowPrepareSchema>) {
    const parsed = CodexWindowPrepareSchema.parse(input);
    return withLiveWebMetadataScope(this.store, { projectId }, () =>
      this.metadata.database.transaction(() => {
        const configuration = this.projects.windowConfiguration(projectId);
        if (!configuration) {
          throw new Error('codex_connect_not_configured');
        }
        const taskId = createOrdinaryWindowTask(this.store, {
          schema_version: 2,
          mode: 'ordinary_window',
          project_id: projectId,
          product: 'codex',
          declared_version: configuration.product_version,
          policy_id: 'codex-binding-root-window-v1',
          criterion_ids: parsed.criterion_ids
        });
        const selection = assertOrdinaryWindowPrepared(this.store, taskId);
        this.metadata.insertTask({
          id: taskId,
          name: parsed.name,
          profileId: 'ordinary-codex-window-v1',
          projectId,
          setup: frozenSetupSchema.parse({
            schema_version: 1,
            kind: 'codex_window_setup',
            selection_hash: ordinaryWindowSelectionHash(selection),
            configuration
          })
        });
        return this.task(taskId);
      })()
    );
  }
  private bindingOptions(taskId: string, projectId: string, rootSessionId?: string) {
    const value = this.authorize(taskId, projectId, rootSessionId);
    return {
      store: this.store,
      taskId,
      receiptDirectory: value.frozen.configuration.receipt_directory,
      sourceRoots: value.frozen.configuration.source_roots
    };
  }
  async connect(taskId: string, input: z.infer<typeof CodexWindowConnectSchema>) {
    const parsed = CodexWindowConnectSchema.parse(input);
    const options = this.bindingOptions(taskId, parsed.project_id);
    const result = await connectOrdinaryCodexWindow(options, {
      receipt: parsed.receipt
    });
    return this.store.immediateTransaction(() => {
      this.authorize(taskId, parsed.project_id, result.rootSessionId);
      const current = this.task(taskId);
      if (!current.connection_enabled || current.selected_root_id !== result.rootSessionId) throw new Error('binding_scope_revoked');
      return {
        schema_version: 1 as const,
        kind: 'codex_window_connection' as const,
        status: 'connected' as const,
        project_id: parsed.project_id,
        task_id: taskId,
        session_id: result.rootSessionId,
        automatic_children: false as const,
        collection_active: true as const,
        evidence_mode: 'source_only' as const,
        trust: 'compatibility_unverified' as const,
        cost_coverage: 'partial' as const
      };
    });
  }
  async action(taskId: string, input: z.infer<typeof CodexWindowActionSchema>) {
    const parsed = CodexWindowActionSchema.parse(input);
    if (parsed.operation === 'collect') {
      const rootId = ordinaryTask(this.store, taskId)?.selected_root_id;
      if (!rootId) throw new Error('binding_fresh_root_required');
      await collectOrdinaryCodexWindow(this.bindingOptions(taskId, parsed.project_id, rootId), rootId);
      return this.store.immediateTransaction(() => {
        this.authorize(taskId, parsed.project_id, rootId);
        return this.task(taskId);
      });
    } else {
      this.store.immediateTransaction(() => {
        const value = this.context(taskId);
        if (value.task.project_id !== parsed.project_id) {
          throw new Error('binding_scope_mismatch');
        }
        assertOrdinaryWindowPrepared(this.store, taskId);
        switch (parsed.operation) {
          case 'start':
            this.life.start(taskId);
            break;
          case 'resume':
            this.life.resume(taskId);
            break;
          case 'pause':
            this.life.pause(taskId);
            pauseOrdinaryWindowSegment(this.store, taskId, utcNow(), 'binding_scope_revoked');
            break;
          case 'revoke-collection':
            revokeOrdinaryObservation(this.store, taskId);
            pauseOrdinaryWindowSegment(this.store, taskId, utcNow(), 'binding_scope_revoked');
            if (this.life.state(taskId) === 'active') {
              this.life.pause(taskId);
            }
            break;
        }
      });
    }
    return this.task(taskId);
  }
  validateReplay(taskId: string, input: unknown) {
    return this.store.immediateTransaction(() => this.assertReplay(taskId, input));
  }
  private assertReplay(taskId: string, input: unknown) {
    const result = z.object({ kind: z.string() }).parse(input);
    if (result.kind === 'codex_window_connection') {
      const connection = z
        .object({
          project_id: IdSchema,
          session_id: IdSchema
        })
        .parse(input);
      this.authorize(taskId, connection.project_id, connection.session_id);
      const current = this.task(taskId);
      if (!current.connection_enabled || current.selected_root_id !== connection.session_id) {
        throw new Error('binding_scope_revoked');
      }
    } else {
      const cached = z.object({ version: z.string() }).parse(input);
      if (this.task(taskId).version !== cached.version) {
        throw new Error('ui_state_changed');
      }
    }
  }
}
export function createCodexWindowControl(
  store: Store,
  metadata: ReturnType<typeof createLocalWebMetadata>,
  projects: Pick<ReturnType<typeof createCodexProjectSetupManager>, 'windowConfiguration'>
) {
  return new LocalCodexWindowControl(store, metadata, projects);
}
export type CodexWindowControl = ReturnType<typeof createCodexWindowControl>;
export type CodexWindowTaskDto = ReturnType<CodexWindowControl['task']>;
export type CodexWindowConnectionDto = Awaited<ReturnType<CodexWindowControl['connect']>>;
