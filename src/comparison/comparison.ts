import { z } from 'zod';
import { IdSchema } from '../contracts.js';
import { preparePriceBasis } from '../pricing/price-catalog-store.js';
import { FlexibleVariantSchema, FlexibleProtocolDraftSchema, FlexibleProtocolSchema, PriceTableSchema } from '../flexible-contracts.js';
import { lookupFileProfile } from '../adapter-profiles.js';
import { comparisonTimestamp, parseComparison, ProtocolDraftSchema, ProtocolSchema, VariantSchema } from '../comparison-contracts.js';
import { comparisonProtocol, comparisonVariant, protocolRow } from '../core/protocol-store.js';
import type { ProtocolRow } from '../core/protocol-store.js';

export { comparisonProtocol, protocolRow };
import type { Store } from '../store.js';
import { requireLatestClaudeWorkflowProfile } from '../claude-workflow-versions.js';

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

/** Fill only the new preparation's missing reference. Repeated registration retains its first pin. */
export function registerProtocolWithCatalogDefaults(store: Store, input: unknown, now = new Date().toISOString()): void {
  store.immediateTransaction(() => {
    let prepared = input;
    if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
      const draft = input as Record<string, unknown>;
      if (draft.schema_version === 2 && draft.price_table_id === undefined) {
        const id = IdSchema.parse(draft.id);
        const existing = store.get<{ settings: string }>('SELECT settings FROM comparison_protocols WHERE id=?', [id]);
        const prior = existing ? (JSON.parse(existing.settings) as { price_table_id?: string }) : null;
        prepared = { ...draft, price_table_id: prior?.price_table_id ?? preparePriceBasis(store, now).table.id };
      }
    }
    registerProtocol(store, prepared);
  });
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
