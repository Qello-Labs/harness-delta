import { z } from 'zod';
import { FlexibleDataPackageSchema, digest } from '../exchange/contracts.js';
import { TeamInputSchema, TeamRequestSchema } from './team-contracts.js';
import { canonicalJson } from './comparison-snapshot.js';
import { codePointOrder } from './comparison-task.js';
import { validateDataPackage } from '../exchange/identity.js';
import { Decimal } from 'decimal.js';
export const FlexibleTeamRequestSchema = z.strictObject({ ...TeamRequestSchema.shape, schema_version: z.literal(2) });
export const FlexibleTeamInputSchema = z.strictObject({
  ...TeamInputSchema.shape,
  schema_version: z.literal(2),
  descriptive_version: z.literal('flexible-team-descriptive-1'),
  request: FlexibleTeamRequestSchema,
  contributions: z
    .array(z.strictObject({ received_at: TeamInputSchema.shape.created_at, package: FlexibleDataPackageSchema }))
    .min(1)
    .max(256)
});
export type FlexibleTeamInput = z.infer<typeof FlexibleTeamInputSchema>;
const Money = Decimal.clone({ precision: 160, rounding: Decimal.ROUND_HALF_EVEN, toExpNeg: -1000, toExpPos: 1000 });
export function projectFlexibleTeam(input: FlexibleTeamInput) {
  const { request, mapping } = input;
  const expected = [...new Set(mapping.writers.map(w => w.namespace_id))].sort(codePointOrder);
  const contributions = [...input.contributions].sort((a, b) => codePointOrder(a.package.namespace_id, b.package.namespace_id));
  if (
    canonicalJson(expected) !== canonicalJson(request.required_namespaces) ||
    mapping.local_project_id !== request.local_project_id ||
    mapping.shared_project_id !== request.shared_project_id ||
    mapping.protocol_id !== request.protocol_id ||
    Date.parse(request.as_of) > Date.parse(input.created_at) ||
    Date.parse(request.cutoff) > Date.parse(request.as_of)
  )
    throw new Error('invalid_snapshot_request');
  if (new Set(contributions.map(c => c.package.namespace_id)).size !== contributions.length) throw new Error('invalid_snapshot');
  const first = contributions[0]!.package;
  for (const c of contributions) {
    validateDataPackage(c.package, mapping, request.as_of);
    if (
      c.package.shared_project_id !== request.shared_project_id ||
      c.package.protocol_id !== request.protocol_id ||
      !expected.includes(c.package.namespace_id) ||
      c.package.tombstones.length
    )
      throw new Error('invalid_snapshot');
    if (c.package.cutoff !== request.cutoff) throw new Error('cutoff_mismatch');
    if (c.package.price_table_hash !== first.price_table_hash || canonicalJson(c.package.price_table) !== canonicalJson(first.price_table))
      throw new Error('price_table_conflict');
    if (Date.parse(c.received_at) > Date.parse(request.as_of) || Date.parse(c.package.produced_at) > Date.parse(c.received_at))
      throw new Error('snapshot_as_of_unavailable');
  }
  const keys = new Set<string>();
  const slots = new Set<string>();
  const assignments = new Set<string>();
  const tasks = contributions
    .flatMap(c =>
      c.package.assignments.map(a => {
        for (const key of new Set([a.task_id, a.logical_task_id, ...a.alias_ids])) {
          if (keys.has(key)) throw new Error('identity_conflict');
          keys.add(key);
        }
        const slot = canonicalJson([a.stratum_id, a.allocation_index]);
        if (slots.has(slot) || assignments.has(a.assignment_id)) throw new Error('assignment_conflict');
        slots.add(slot);
        assignments.add(a.assignment_id);
        return {
          ...a,
          namespace_id: c.package.namespace_id,
          deadline_status:
            Date.parse(request.cutoff) < Date.parse(a.followup_ends_at)
              ? ('followup_pending' as const)
              : (a.evidence.current_outcome ?? (a.evidence.started ? ('outcome_missing' as const) : ('not_started' as const)))
        };
      })
    )
    .sort((a, b) => codePointOrder(a.task_id, b.task_id));
  const missing = expected.filter(id => !contributions.some(c => c.package.namespace_id === id));
  // Imported complete amounts are source claims. Team request-universe/coverage is not established.
  const arms = first.protocol.settings.variant_ids.map(variant_id => {
    const rows = tasks.filter(t => t.original_variant_id === variant_id);
    const partial = rows.flatMap(t => (t.evidence.cost.partial_amount === null ? [] : [t.evidence.cost.partial_amount]));
    return {
      variant_id,
      assigned_count: rows.length,
      source_complete_count: rows.filter(t => t.evidence.cost.complete_amount !== null).length,
      partial_count: partial.length,
      complete_mean: null,
      partial_mean: partial.length
        ? partial
            .reduce((sum, v) => sum.plus(v), new Money(0))
            .div(partial.length)
            .toFixed()
        : null
    };
  });
  return {
    schema_version: 2 as const,
    descriptive_version: input.descriptive_version,
    snapshot_id: request.snapshot_id,
    validity_status: 'valid' as const,
    purpose: 'synthetic_validation' as const,
    shared_project_id: request.shared_project_id,
    protocol_id: request.protocol_id,
    settings: first.protocol.settings,
    variants: first.variants,
    cutoff: request.cutoff,
    as_of: request.as_of,
    created_at: input.created_at,
    merged_revision: input.merged_revision,
    snapshot_sequence: input.snapshot_sequence,
    price_table: first.price_table,
    price_table_hash: first.price_table_hash,
    formula_version: first.formula_version,
    required_namespaces: expected,
    missing_namespaces: missing,
    declared_writer_coverage: missing.length ? ('partial' as const) : ('complete' as const),
    team_completeness: 'unverified' as const,
    team_assignment_denominator: null,
    source_vector: contributions.map(c => ({
      namespace_id: c.package.namespace_id,
      export_revision: c.package.export_revision,
      source_snapshot_sequence: c.package.source_snapshot_sequence,
      received_at: c.received_at
    })),
    tasks,
    arms,
    relative_change: null,
    adoption: { status: 'inconclusive' as const, reason: 'analysis_not_validated' },
    limitations: ['standardized_estimated_cost_is_not_actual_billing', 'team_completeness_unverified', 'elapsed_is_not_human_labor'],
    snapshot_hash: digest(input)
  };
}
export type FlexibleTeamReport = ReturnType<typeof projectFlexibleTeam>;
