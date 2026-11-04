import { z } from 'zod';
import { IdSchema } from './contracts.js';
import { FlexibleVariantSchema, parseProtocol } from './flexible-contracts.js';
import { parseComparison, ProtocolSchema, VariantSchema } from './comparison-contracts.js';
import type { Protocol, Variant } from './comparison-contracts.js';
import type { Store } from './store.js';

export interface ProtocolRow {
  id: string;
  project_id: string;
  settings: string;
  status: 'draft' | 'frozen' | 'invalidated_by_deletion' | 'identity_conflict';
  frozen_at: string | null;
  data_revision: number;
  invalidated_reason: string | null;
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
