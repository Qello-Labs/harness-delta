import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { IdSchema } from '../contracts.js';
import type { ClaudeWindowBinaryAdapters } from '../claude-process-binary.js';
import { Lifecycle, utcNow } from '../core/lifecycle.js';
import { createOrdinaryWindowTask, ordinaryProjectSettings, ordinaryTask, revokeOrdinaryObservation } from '../ordinary-observation.js';
import { collectOrdinaryClaudeWindow, connectOrdinaryClaudeWindow } from '../ordinary-session-binding.js';
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
import { withLiveWebMetadataScope } from './local-web-metadata.js';

const prepareSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  criterion_ids: z.array(IdSchema).min(1).max(256),
  type: IdSchema.optional(),
  expected_size: IdSchema.optional(),
  assignee: IdSchema.optional()
});

export const ClaudeWindowConnectSchema = z.strictObject({
  project_id: IdSchema,
  product: z.literal('claude_code'),
  receipt: z.uuid()
});
export const ClaudeWindowActionSchema = z.strictObject({
  project_id: IdSchema,
  operation: z.enum(['start', 'pause', 'resume', 'revoke-collection', 'collect'])
});
const directory = z
  .string()
  .min(1)
  .max(4096)
  .refine(value => isAbsolute(value) && !/[\0\r\n]/.test(value));
const frozenSetupSchema = z
  .strictObject({
    schema_version: z.literal(1),
    kind: z.literal('claude_window_setup'),
    selection_hash: z.string().regex(/^[a-f0-9]{64}$/),
    bundle_mode: z.literal('ordinary_window').optional(),
    bundle_revision: z.literal('claude-window-bundle-v1').optional(),
    configuration: z.strictObject({
      product_version: z.string().min(1).max(100),
      project_root: directory,
      receipt_directory: directory,
      claude_projects_directory: directory
    })
  })
  .refine(value => (value.bundle_mode === undefined) === (value.bundle_revision === undefined));
const closedReasons = z.enum([
  'binding_window_activation_required',
  'binding_scope_revoked',
  'binding_scope_mismatch',
  'binding_ordinary_assignment_conflict',
  'compatibility_invalidated',
  'binding_window_trial_expired',
  'binding_window_trial_budget_exhausted',
  'binding_fresh_root_required',
  'binding_window_unavailable'
]);

class LocalClaudeWindowControl {
  private readonly life: Lifecycle;
  constructor(
    private readonly store: Store,
    private readonly metadata: ReturnType<typeof createLocalWebMetadata>,
    private readonly binaryAdapters?: ClaudeWindowBinaryAdapters
  ) {
    this.life = new Lifecycle(store);
  }
  private context(taskId: string) {
    const task = this.life.task(taskId);
    const selection = ordinaryWindowSelection(this.store, taskId);
    if (
      !selection ||
      selection.projectId !== task.project_id ||
      selection.policy.product !== 'claude_code' ||
      selection.policy.policyId !== 'claude-binding-root-window-v1' ||
      selection.policy.evidenceMode !== 'publisher_verified_local_pin'
    ) {
      throw new Error('binding_scope_mismatch');
    }
    if (this.store.get("SELECT 1 FROM tombstones WHERE (kind='task' AND id=?) OR (kind='project' AND id=?)", [taskId, task.project_id])) {
      throw new Error('deleted_identifier');
    }
    const record = this.metadata.task(taskId);
    if (!record || record.profile_id !== 'ordinary-claude-window-v1') {
      throw new Error('ordinary_preparation_required');
    }
    const frozen = frozenSetupSchema.parse(JSON.parse(record.setup) as unknown);
    const root = this.store.get<{ local_root: string }>('SELECT local_root FROM projects WHERE id=?', [task.project_id])?.local_root;
    if (
      !root ||
      root !== frozen.configuration.project_root ||
      frozen.configuration.receipt_directory !== join(root, '.harness-delta/claude-window-receipts') ||
      frozen.selection_hash !== ordinaryWindowSelectionHash(selection) ||
      frozen.configuration.product_version !== selection.declaredVersion
    ) {
      throw new Error('ordinary_configuration_changed');
    }
    const decision = readOrdinaryWindowDecision(this.store, ordinaryWindowDecisionKeyForSelection(selection));
    return { task, selection, frozen, decision };
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
  private authoritySnapshot(value: ReturnType<LocalClaudeWindowControl['context']>) {
    return JSON.stringify({
      generation: value.task.generation,
      selection: value.selection,
      frozen: value.frozen,
      // Authorized collection advances the budget counter without replacing authority.
      decision: value.decision === null ? null : { ...value.decision, trial_tokens_consumed: 0 }
    });
  }
  private readback(taskId: string, projectId: string, rootId: string, snapshot: string) {
    const value = this.authorize(taskId, projectId, rootId);
    if (this.authoritySnapshot(value) !== snapshot) {
      throw new Error('binding_scope_revoked');
    }
    const current = this.task(taskId);
    if (!current.connection_enabled || current.selected_root_id !== rootId) throw new Error('binding_scope_revoked');
    return current;
  }
  task(taskId: string) {
    return this.store.immediateTransaction(() => this.readTask(taskId));
  }
  private readTask(taskId: string) {
    const value = this.context(taskId);
    const prepared = ordinaryTask(this.store, taskId);
    const selected = prepared?.selected_root_id ?? null;
    let reason: z.infer<typeof closedReasons> | null = null;
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
      ? this.store.get(
          `SELECT s.state,s.revision,b.cursor,b.generation,b.state AS binding_state FROM binding_root_segments s
          LEFT JOIN session_bindings b ON b.session_id=s.root_session_id WHERE s.root_session_id=?`,
          [selected]
        )
      : undefined;
    const blocks = this.store.all('SELECT * FROM source_compatibility_blocks WHERE product=? AND product_version=? AND source=?', [
      value.selection.policy.product,
      value.selection.declaredVersion,
      value.selection.policy.source
    ]);
    const version =
      '"' +
      createHash('sha256')
        .update(JSON.stringify({ ...value, prepared, segment, blocks, reason }))
        .digest('hex') +
      '"';
    return {
      schema_version: 1 as const,
      kind: 'claude_window_task' as const,
      project_id: value.task.project_id,
      task_id: taskId,
      version,
      state: value.task.state,
      connection_enabled: reason === null,
      reason,
      selected_root_id: connectedRoot
    };
  }
  prepare(projectId: string, input: z.infer<typeof prepareSchema>) {
    const parsed = prepareSchema.parse(input);
    return withLiveWebMetadataScope(this.store, { projectId }, () =>
      this.metadata.database.transaction(() => {
        const settings = ordinaryProjectSettings(this.store, projectId);
        if (!settings || settings.bundle_mode !== 'ordinary_window' || settings.bundle_revision !== 'claude-window-bundle-v1')
          throw new Error('ordinary_project_setup_required');
        const project = this.store.get<{ local_root: string | null }>('SELECT local_root FROM projects WHERE id=?', [projectId]);
        if (!project?.local_root) throw new Error('unknown_project');
        const receiptDirectory = join(project.local_root, '.harness-delta/claude-window-receipts');
        if (settings.receipt_directory !== receiptDirectory) throw new Error('binding_scope_mismatch');
        const taskId = createOrdinaryWindowTask(this.store, {
          schema_version: 2,
          mode: 'ordinary_window',
          project_id: projectId,
          product: 'claude_code',
          declared_version: settings.product_version,
          policy_id: 'claude-binding-root-window-v1',
          criterion_ids: parsed.criterion_ids,
          ...(parsed.type ? { type: parsed.type } : {}),
          ...(parsed.expected_size ? { expected_size: parsed.expected_size } : {}),
          ...(parsed.assignee ? { assignee: parsed.assignee } : {})
        });
        const selection = assertOrdinaryWindowPrepared(this.store, taskId);
        this.metadata.insertTask({
          id: taskId,
          name: parsed.name,
          profileId: 'ordinary-claude-window-v1',
          projectId,
          setup: frozenSetupSchema.parse({
            schema_version: 1,
            kind: 'claude_window_setup',
            bundle_mode: 'ordinary_window',
            bundle_revision: 'claude-window-bundle-v1',
            selection_hash: ordinaryWindowSelectionHash(selection),
            configuration: {
              product_version: settings.product_version,
              project_root: project.local_root,
              receipt_directory: receiptDirectory,
              claude_projects_directory: settings.claude_projects_directory
            }
          })
        });
        return this.task(taskId);
      })()
    );
  }

  private bindingOptions(taskId: string, value: ReturnType<LocalClaudeWindowControl['authorize']>) {
    return {
      store: this.store,
      taskId,
      receiptDirectory: value.frozen.configuration.receipt_directory,
      claudeProjectsDirectory: value.frozen.configuration.claude_projects_directory,
      ...(this.binaryAdapters === undefined ? {} : { binaryAdapters: this.binaryAdapters })
    };
  }
  async connect(taskId: string, input: z.infer<typeof ClaudeWindowConnectSchema>) {
    const parsed = ClaudeWindowConnectSchema.parse(input);
    const value = this.authorize(taskId, parsed.project_id);
    const snapshot = this.authoritySnapshot(value);
    const result = await connectOrdinaryClaudeWindow(this.bindingOptions(taskId, value), { receipt: parsed.receipt });
    return this.store.immediateTransaction(() => {
      const current = this.readback(taskId, parsed.project_id, result.rootSessionId, snapshot);
      return {
        schema_version: 1 as const,
        kind: 'claude_window_connection' as const,
        status: 'connected' as const,
        project_id: parsed.project_id,
        task_id: taskId,
        version: current.version,
        session_id: result.rootSessionId,
        automatic_children: false as const,
        collection_active: true as const,
        evidence_mode: 'publisher_verified_local_pin' as const,
        trust: 'compatibility_unverified' as const,
        root_ownership: 'unverified' as const,
        possible_child_contribution: 'unknown' as const,
        mapped_image_proof: 'unverified' as const,
        cost_coverage: 'partial' as const
      };
    });
  }
  async action(taskId: string, input: z.infer<typeof ClaudeWindowActionSchema>) {
    const parsed = ClaudeWindowActionSchema.parse(input);
    if (parsed.operation === 'collect') {
      const value = this.authorize(taskId, parsed.project_id);
      const rootId = ordinaryTask(this.store, taskId)?.selected_root_id;
      if (!rootId) throw new Error('binding_fresh_root_required');
      this.authorize(taskId, parsed.project_id, rootId);
      const snapshot = this.authoritySnapshot(value);
      await collectOrdinaryClaudeWindow(this.bindingOptions(taskId, value), rootId);
      return this.store.immediateTransaction(() => this.readback(taskId, parsed.project_id, rootId, snapshot));
    }
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
    return this.task(taskId);
  }
  validateReplay(taskId: string, input: unknown) {
    this.store.immediateTransaction(() => {
      const cached = z
        .object({
          kind: z.string(),
          project_id: IdSchema,
          task_id: IdSchema,
          version: z.string()
        })
        .parse(input);
      const current = this.task(taskId);
      if (cached.task_id !== taskId || cached.project_id !== current.project_id) throw new Error('binding_scope_mismatch');
      if (cached.kind === 'claude_window_connection') {
        const connection = z.object({ session_id: IdSchema }).parse(input);
        this.authorize(taskId, cached.project_id, connection.session_id);
        if (!current.connection_enabled || current.selected_root_id !== connection.session_id) throw new Error('binding_scope_revoked');
      } else if (cached.kind !== 'claude_window_task') {
        throw new Error('binding_scope_mismatch');
      }
      if (current.version !== cached.version) {
        throw new Error('ui_state_changed');
      }
    });
  }
}

export function createClaudeWindowControl(store: Store, metadata: ReturnType<typeof createLocalWebMetadata>, binaryAdapters?: ClaudeWindowBinaryAdapters) {
  return new LocalClaudeWindowControl(store, metadata, binaryAdapters);
}
export type ClaudeWindowControl = ReturnType<typeof createClaudeWindowControl>;
export type ClaudeWindowTaskDto = ReturnType<ClaudeWindowControl['task']>;
