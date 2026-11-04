import { z } from 'zod';
import { FlexibleVariantSchema, FlexibleProtocolDraftSchema, FlexibleProtocolSchema, PriceTableSchema, parseProtocol } from './flexible-contracts.js';
import { lookupFileProfile } from './adapter-profiles.js';
import { IdSchema } from './contracts.js';
import { comparisonTimestamp, parseComparison, ProtocolDraftSchema, ProtocolSchema, VariantSchema } from './comparison-contracts.js';
import type { Protocol, Variant } from './comparison-contracts.js';
import type { Store } from './store.js';
import { requireLatestClaudeWorkflowProfile } from './claude-workflow-versions.js';
import { comparisonReadiness } from './readiness-store.js';

export interface ProtocolRow {
  id: string;
  project_id: string;
  settings: string;
  status: 'draft' | 'frozen' | 'invalidated_by_deletion' | 'identity_conflict';
  frozen_at: string | null;
  data_revision: number;
  invalidated_reason: string | null;
}

export function registerVariant(store: Store, input: unknown): void {
  const config = parseComparison(z.union([VariantSchema, FlexibleVariantSchema]), input);
  store.immediateTransaction(() => {
    const current = store.get<{ configuration: string }>('SELECT configuration FROM comparison_variants WHERE id = ?', [config.id]);
    const serialized = JSON.stringify(config);
    if (current) {
      if (current.configuration !== serialized) throw new Error('configuration_conflict');
      return;
    }
    store.execute('INSERT INTO comparison_variants(id,configuration) VALUES (?,?)', [config.id, serialized]);
  });
}

export function registerProtocol(store: Store, input: unknown): void {
  const config = parseComparison(z.union([ProtocolDraftSchema, FlexibleProtocolDraftSchema]), input);
  store.immediateTransaction(() => {
    if (store.get('SELECT id FROM tombstones WHERE kind = ? AND id = ?', ['project', config.project_id])) throw new Error('deleted_identifier');
    if (!store.get('SELECT id FROM projects WHERE id = ?', [config.project_id])) throw new Error('unknown_project');
    const current = store.get<ProtocolRow>('SELECT * FROM comparison_protocols WHERE id = ?', [config.id]);
    const serialized = JSON.stringify(config);
    if (current) {
      if (current.settings !== serialized) throw new Error('protocol_conflict');
      return;
    }
    // New real-source protocols may name only the newest admitted Claude workflow version;
    // a registered protocol keeps its version until that version is retired (ADR 007 exact admission).
    if (config.schema_version === 2 && config.purpose !== 'synthetic_validation')
      requireLatestClaudeWorkflowProfile(config.source_profiles ?? [], undefined, config.purpose === 'functional_pilot');
    store.execute('INSERT INTO comparison_protocols(id,project_id,settings) VALUES (?,?,?)', [config.id, config.project_id, serialized]);
  });
}

export function protocolRow(store: Store, id: string): ProtocolRow {
  const row = store.get<ProtocolRow>('SELECT * FROM comparison_protocols WHERE id = ?', [parseComparison(IdSchema, id)]);
  if (!row) throw new Error('unknown_protocol');
  return row;
}

export function variantConfiguration(store: Store, id: string): Variant {
  const row = store.get<{ configuration: string }>('SELECT configuration FROM comparison_variants WHERE id = ?', [parseComparison(IdSchema, id)]);
  if (!row) throw new Error('unknown_variant');
  return parseComparison(VariantSchema, JSON.parse(row.configuration) as unknown);
}

export function comparisonVariant(store: Store, id: string) {
  const row = store.get<{ configuration: string }>('SELECT configuration FROM comparison_variants WHERE id=?', [parseComparison(IdSchema, id)]);
  if (!row) throw new Error('unknown_variant');
  return parseComparison(z.union([VariantSchema, FlexibleVariantSchema]), JSON.parse(row.configuration) as unknown);
}
export function comparisonProtocol(store: Store, row: ProtocolRow) {
  if (row.status !== 'frozen') throw new Error('protocol_not_active');
  return parseProtocol(JSON.parse(row.settings) as unknown);
}

export function frozenProtocol(store: Store, row: ProtocolRow): Protocol {
  if (row.status !== 'frozen') throw new Error('protocol_not_active');
  return parseComparison(ProtocolSchema, JSON.parse(row.settings) as unknown, 'incomplete_protocol');
}

export function freezeProtocol(store: Store, id: string, timestamp: string): void {
  const now = comparisonTimestamp(timestamp);
  store.immediateTransaction(() => {
    const row = protocolRow(store, id);
    if (row.status === 'frozen') return;
    if (row.status !== 'draft') throw new Error('protocol_not_active');
    const config = parseComparison(z.union([ProtocolSchema, FlexibleProtocolSchema]), JSON.parse(row.settings) as unknown, 'incomplete_protocol');
    if (Date.parse(now) >= Date.parse(config.recruitment_start)) throw new Error('registration_too_late');
    const [a, b] = config.variant_ids.map(variantId => comparisonVariant(store, variantId));
    if (!a || !b) throw new Error('unknown_variant');
    if (a.policy_status !== 'eligible' || b.policy_status !== 'eligible') throw new Error('ineligible_variant');
    if (a.schema_version !== config.schema_version || b.schema_version !== config.schema_version) throw new Error('configuration_mismatch');
    if (a.schema_version === 1 && b.schema_version === 1) {
      if (a.product !== b.product || a.product_version !== b.product_version || a.model !== b.model || a.reasoning_setting !== b.reasoning_setting)
        throw new Error('configuration_mismatch');
      if (config.purpose === 'synthetic_validation' && a.product !== 'synthetic') throw new Error('synthetic_only');
    }
    if (config.schema_version === 2) {
      const prices = store.get<{ payload: string }>('SELECT payload FROM price_tables WHERE id=?', [config.price_table_id]);
      if (!prices) throw new Error('unknown_price_table');
      parseComparison(PriceTableSchema, JSON.parse(prices.payload) as unknown, 'invalid_price_table');
      if (config.purpose === 'synthetic_validation' && config.source_profiles.some(profile => profile.product !== 'synthetic'))
        throw new Error('synthetic_only');
    }
    const participants = new Set(config.participants);
    for (const stratum of config.strata) {
      if (stratum.assignees.some(assignee => !participants.has(assignee))) throw new Error('invalid_strata');
    }
    if (config.participants.some(assignee => !config.strata.some(stratum => stratum.assignees.includes(assignee)))) throw new Error('invalid_strata');
    for (let i = 0; i < config.strata.length; i++) {
      for (const other of config.strata.slice(i + 1)) {
        const stratum = config.strata[i]!;
        if (
          stratum.assignees.some(value => other.assignees.includes(value)) &&
          stratum.types.some(value => other.types.includes(value)) &&
          stratum.sizes.some(value => other.sizes.includes(value))
        )
          throw new Error('overlapping_strata');
      }
    }
    store.execute("UPDATE comparison_protocols SET status = 'frozen', frozen_at = ? WHERE id = ?", [now, id]);
    for (const stratum of config.strata) {
      store.execute('INSERT INTO comparison_allocation_state(protocol_id,stratum_id,allocator_id) VALUES (?,?,?)', [id, stratum.id, stratum.allocator_id]);
    }
  });
}

export function showVariant(store: Store, id: string) {
  const configuration = comparisonVariant(store, id);
  if (configuration.schema_version === 2) return { configuration, file_adapter_status: 'unverified' };
  return {
    configuration,
    file_adapter_status:
      configuration.product === 'synthetic'
        ? 'not_applicable'
        : lookupFileProfile(configuration.product, configuration.product_version) === 'unsupported'
          ? 'unsupported'
          : 'registered_partial'
  };
}

export function showProtocol(store: Store, id: string) {
  const row = protocolRow(store, id);
  const configuration = parseComparison(z.union([ProtocolDraftSchema, FlexibleProtocolDraftSchema]), JSON.parse(row.settings) as unknown);
  const realAllocation =
    configuration.schema_version === 2 &&
    configuration.purpose !== 'synthetic_validation' &&
    row.status === 'frozen' &&
    comparisonReadiness(store, id).real_allocation;
  return {
    schema_version: configuration.schema_version,
    configuration,
    status: row.status,
    frozen_at: row.frozen_at,
    data_revision: row.data_revision,
    invalidated_reason: row.invalidated_reason,
    real_allocation_enabled: realAllocation,
    experiment_readiness: realAllocation
      ? 'source_qualified_partial'
      : configuration.schema_version === 1 || configuration.purpose === 'synthetic_validation'
        ? 'synthetic_only'
        : 'source_unqualified'
  };
}
