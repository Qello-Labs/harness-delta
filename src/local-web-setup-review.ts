import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { IdSchema, TimestampSchema } from './contracts.js';
import { FlexibleProtocolSchema, FlexibleVariantSchema, PriceTableSchema } from './flexible-contracts.js';
import { comparisonProtocol, freezeProtocol, protocolRow, registerProtocol, registerVariant } from './comparison.js';
import { readPriceTable, registerPriceTable } from './pricing.js';
import { LocalWebProfileSchema, type LocalWebProfile } from './local-web-domain.js';
import type { createSharedSetupManager } from './local-web-shared.js';
import { localWebError } from './local-web-server.js';
import type { Store } from './store.js';
import { comparisonRelativePath, hashBytes, readComparison } from './harness-config.js';

// This envelope is private UI input. Its contents use the existing production contracts.
export const SetupReviewInputSchema = z.strictObject({
  comparison_path: z.string().min(1).max(4096),
  project_id: IdSchema.optional(),
  template_id: z.lazy(() => LocalWebProfileSchema.shape.id).optional(),
  profile: z.lazy(() => LocalWebProfileSchema.refine(profile => !profile.shared_binding)).optional(),
  variants: z.array(FlexibleVariantSchema).max(2).optional(),
  policy_status: z.strictObject({ arm_a: FlexibleVariantSchema.shape.policy_status, arm_b: FlexibleVariantSchema.shape.policy_status }).optional(),
  protocol: FlexibleProtocolSchema.optional(),
  price_table: PriceTableSchema.optional(),
  freeze_at: TimestampSchema.optional(),
  application_mode: z.enum(['selected_markdown_only', 'agent_applied']).optional(),
});
type ReviewInput = z.infer<typeof SetupReviewInputSchema>;
type Issue = { field: string; code: string };
export function createSetupReviewManager(
  store: Store, privateDb: Database.Database, profiles: () => LocalWebProfile[],
  saveProfiles: (inputs: LocalWebProfile[]) => unknown,
  shared: ReturnType<typeof createSharedSetupManager>,
) {
  const tokens = new Map<string, { input: ReviewInput; hash: string; expires: number }>();
  const rollback = new Error('setup_review_rollback');
  const selectedProfile = (input: ReviewInput) =>
    input.profile ?? profiles().find(row => row.id === input.template_id && !row.shared_binding);
  function scopedPath(input: ReviewInput) {
    const profile = selectedProfile(input);
    const projectId = input.project_id ?? profile?.setup.workflow.assignment.project_id;
    if (!projectId) throw new Error('shared_project_required');
    if (profile && profile.setup.workflow.assignment.project_id !== projectId ||
      input.protocol && input.protocol.project_id !== projectId) throw new Error('shared_registration_mismatch');
    const project = store.get<{ id: string; local_root: string }>('SELECT id,local_root FROM projects WHERE id=?', [projectId]);
    if (!project) throw new Error('unknown_project');
    return { project, path: comparisonRelativePath(project.local_root, input.comparison_path) };
  }
  const proposedVariantId = (projectId: string, bundleHash: string) =>
    `variant-${hashBytes(JSON.stringify(['harness-delta-variant', projectId, bundleHash]))}`;
  function generatedVariants(input: ReviewInput) {
    const { project, path } = scopedPath(input);
    const pair = readComparison(project.local_root, path);
    const variant = (index: 0 | 1) => {
      const reference = index === 0 ? pair.descriptor.arm_a : pair.descriptor.arm_b;
      const bundle = pair.bundles[index];
      return FlexibleVariantSchema.parse({
        schema_version: 2, id: proposedVariantId(project.id, reference.bundle_hash),
        harness_version: reference.version, instruction_manifest_hash: bundle.instruction_manifest_hash,
        policy_version: bundle.policy_version, policy_status: index === 0 ? input.policy_status?.arm_a : input.policy_status?.arm_b,
        runtime_policy: 'flexible',
      });
    };
    return [variant(0), variant(1)];
  }
  function apply(input: ReviewInput) {
    scopedPath(input);
    if (input.profile && input.template_id && input.profile.id !== input.template_id) throw new Error('invalid_ui_setup');
    if (input.price_table) registerPriceTable(store, input.price_table);
    for (const variant of input.variants ?? []) registerVariant(store, variant);
    if (input.protocol) registerProtocol(store, input.protocol);
    const profile = selectedProfile(input);
    if (!profile) throw new Error('shared_registration_required');
    const row = protocolRow(store, profile.setup.workflow.assignment.protocol_id);
    if (row.status !== 'frozen') {
      freezeProtocol(store, row.id, input.freeze_at ?? new Date().toISOString());
    }
    saveProfiles([profile]);
    const preview = shared.preview(input.comparison_path);
    try {
      const project = preview.projects.find(row => row.project_id === profile.setup.workflow.assignment.project_id);
      const template = project?.templates.find(row => row.id === profile.id);
      if (!project || !template) throw new Error('shared_registration_required');
      if (template.blocker) throw new Error(template.blocker);
      if (input.application_mode && input.application_mode !== project.pair.application) throw new Error('application_mode_mismatch');
      const protocol = comparisonProtocol(store, protocolRow(store, row.id));
      if (protocol.schema_version !== 2) throw new Error('shared_registration_mismatch');
      return { preview, profile, protocol, price_table: readPriceTable(store, protocol.price_table_id), application_mode: project.pair.application };
    } catch (error) { shared.discardPreview(preview.token); throw error; }
  }
  function missing(input: ReviewInput): Issue[] {
    const issues: Issue[] = [];
    const profile = selectedProfile(input);
    if (!profile) issues.push({ field: 'profile', code: 'shared_registration_required' });
    const projectId = profile?.setup.workflow.assignment.project_id ?? input.protocol?.project_id;
    if (projectId && !store.get('SELECT id FROM projects WHERE id=?', [projectId]))
      issues.push({ field: `project:${projectId}`, code: 'unknown_project' });
    const protocolId = profile?.setup.workflow.assignment.protocol_id;
    const row = protocolId ? store.get<{ settings: string; status: string }>('SELECT settings,status FROM comparison_protocols WHERE id=?', [protocolId]) : undefined;
    const protocol = input.protocol ?? (row ? FlexibleProtocolSchema.parse(JSON.parse(row.settings) as unknown) : undefined);
    if (protocolId && !row && input.protocol?.id !== protocolId)
      issues.push({ field: `protocol:${protocolId}`, code: 'unknown_protocol' });
    for (const id of protocol?.variant_ids ?? []) {
      if (!input.variants?.some(variant => variant.id === id) && !store.get('SELECT id FROM comparison_variants WHERE id=?', [id]))
        issues.push({ field: `variant:${id}`, code: 'unknown_variant' });
    }
    if (protocol && input.price_table?.id !== protocol.price_table_id && !store.get('SELECT id FROM price_tables WHERE id=?', [protocol.price_table_id]))
      issues.push({ field: `price_table:${protocol.price_table_id}`, code: 'unknown_price_table' });
    return issues;
  }
  const identity = (result: ReturnType<typeof apply>) => hashBytes(JSON.stringify({
    profile: result.profile, protocol: result.protocol, price_table: result.price_table,
    pairs: result.preview.projects.map(project => ({ project_id: project.project_id, pair: project.pair })),
  }));
  return {
    review(raw: unknown) {
      const parsed = SetupReviewInputSchema.safeParse(raw);
      if (!parsed.success) return { ready: false as const, issues: parsed.error.issues.map(issue => ({ field: issue.path.join('.'), code: issue.code })) };
      try {
        if (parsed.data.variants && parsed.data.policy_status) throw new Error('invalid_ui_setup');
        if (!selectedProfile(parsed.data)) {
          if (!parsed.data.project_id) return { ready: false as const, issues: [{ field: 'project_id', code: 'shared_project_required' }] };
          const { project, path } = scopedPath(parsed.data);
          const pair = readComparison(project.local_root, path);
          const arm = (index: 0 | 1) => {
            const bundle = pair.bundles[index];
            const reference = index === 0 ? pair.descriptor.arm_a : pair.descriptor.arm_b;
            return { ...reference, policy_version: bundle.policy_version, instruction_manifest_hash: bundle.instruction_manifest_hash,
              proposed_variant_id: proposedVariantId(project.id, reference.bundle_hash) };
          };
          const issues = missing(parsed.data);
          if (!parsed.data.protocol) issues.push({ field: 'protocol', code: 'unknown_protocol' });
          if (!parsed.data.protocol && !parsed.data.variants?.length && !parsed.data.policy_status) issues.push({ field: 'variants', code: 'unknown_variant' });
          if (!parsed.data.protocol && !parsed.data.price_table) issues.push({ field: 'price_table', code: 'unknown_price_table' });
          for (const field of [
            'profile.setup.workflow.assignment.metadata.criterion_ids', 'profile.execution',
            ...(!parsed.data.variants?.length && !parsed.data.policy_status ? ['variants.policy_status'] : []),
            ...(!parsed.data.protocol ? ['protocol.recruitment_start', 'protocol.recruitment_end', 'protocol.sample_plan', 'protocol.source_profiles'] : []),
          ]) issues.push({ field, code: 'decision_required' });
          if (parsed.data.application_mode && parsed.data.application_mode !== pair.descriptor.application)
            issues.push({ field: 'application_mode', code: 'application_mode_mismatch' });
          return { ready: false as const, issues, comparison: {
            project_id: project.id, comparison_id: pair.descriptor.id, descriptor_path: path,
            settings_hash: pair.descriptor.settings_hash, application_mode: pair.descriptor.application,
            proposed_profile_id: LocalWebProfileSchema.shape.id.parse(`setup-${hashBytes(JSON.stringify([project.id, pair.descriptor.settings_hash]))}`),
            arm_a: arm(0), arm_b: arm(1),
          } };
        }
        const input = parsed.data.policy_status ? { ...parsed.data, variants: generatedVariants(parsed.data) } : parsed.data;
        if (input.project_id) scopedPath(input);
        const issues = missing(input);
        if (issues.length) return { ready: false as const, issues };
        let result: ReturnType<typeof apply> | undefined;
        try {
          store.immediateTransaction(() => privateDb.transaction(() => {
            result = apply(input);
            throw rollback;
          })());
        } catch (error) { if (error !== rollback) throw error; }
        finally { if (result) shared.discardPreview(result.preview.token); }
        if (!result) throw new Error('invalid_ui_setup');
        for (const [token, value] of tokens) if (value.expires < Date.now()) tokens.delete(token);
        if (tokens.size >= 64) throw new Error('shared_import_limit');
        const token = randomUUID();
        tokens.set(token, { input, hash: identity(result), expires: Date.now() + 300000 });
        return { ready: true as const, token, registrations: input, ...result };
      } catch (error) { return { ready: false as const, issues: [{ field: 'registrations', code: localWebError(error) }] }; }
    },
    save(token: string) {
      const selected = tokens.get(token);
      if (!selected || selected.expires < Date.now()) throw new Error('shared_import_expired');
      // Re-run the production checks under writer locks; a review is not a reservation.
      let previewToken: string | undefined;
      let removeCreatedFile: (() => void) | undefined;
      let privateCommitted = false;
      let result: ReturnType<typeof shared.bind>;
      try {
        result = store.immediateTransaction(() => {
          const bound = privateDb.transaction(() => {
            const current = apply(selected.input);
            previewToken = current.preview.token;
            if (identity(current) !== selected.hash) throw new Error('shared_preview_changed');
            return shared.bind({
              token: current.preview.token,
              project_id: current.profile.setup.workflow.assignment.project_id,
              template_id: current.profile.id,
            }, remove => { removeCreatedFile = remove; });
          })();
          // Separate SQLite files cannot commit atomically. Keep a committed private
          // snapshot recoverable if the measurement-store commit subsequently fails.
          privateCommitted = true;
          return bound;
        });
      } catch (error) {
        if (previewToken) shared.discardPreview(previewToken);
        if (!privateCommitted) removeCreatedFile?.();
        throw error;
      }
      tokens.delete(token);
      return result;
    },
  };
}
export type SetupReviewResult = ReturnType<ReturnType<typeof createSetupReviewManager>['review']>;
export type SetupSaveResult = ReturnType<ReturnType<typeof createSetupReviewManager>['save']>;
