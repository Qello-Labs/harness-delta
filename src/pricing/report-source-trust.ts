import { z } from 'zod';
import type { UsageEvent } from '../flexible-contracts.js';
import { ReportCompatibilitySchema } from '../report-source-trust-contracts.js';
import { sumAmounts } from './pricing.js';

type Usage = UsageEvent['payload'];
export type ReportSourceTrust = 'verified' | 'compatibility_unverified' | 'legacy_unverified' | 'invalidated';
/** Absence of native provenance is uncertainty, not retrospective qualification. */
export function reportSourceTrust(usage: Usage): ReportSourceTrust {
  if (usage.product === 'synthetic') return 'verified';
  if (usage.source_invalidated) return 'invalidated';
  return usage.source_compatibility?.state ?? 'legacy_unverified';
}
export function reportCompatibility(usages: readonly Usage[], occurredAt: readonly (string | undefined)[] = []) {
  const sources = new Map<string, z.infer<typeof ReportCompatibilitySchema>['sources'][number]>();
  for (const [index, usage] of usages.entries()) {
    if (usage.product === 'synthetic') continue;
    const source = usage.source_compatibility ?? {
      state: usage.source_invalidated ? ('invalidated' as const) : ('legacy_unverified' as const),
      product: usage.product,
      product_version: usage.product_version
    };
    const key = JSON.stringify(source);
    const existing = sources.get(key);
    const at = occurredAt[index];
    if (existing) {
      existing.event_count++;
      if (at) {
        if (!existing.first_observed_at || Date.parse(at) < Date.parse(existing.first_observed_at)) existing.first_observed_at = at;
        if (!existing.last_observed_at || Date.parse(at) > Date.parse(existing.last_observed_at)) existing.last_observed_at = at;
      }
    } else sources.set(key, { ...source, event_count: 1, ...(at ? { first_observed_at: at, last_observed_at: at } : {}) });
  }
  return {
    sources: [...sources].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, value]) => value),
    verified_events: usages.filter(u => reportSourceTrust(u) === 'verified').length,
    compatibility_unverified_events: usages.filter(u => reportSourceTrust(u) === 'compatibility_unverified').length,
    legacy_unverified_events: usages.filter(u => reportSourceTrust(u) === 'legacy_unverified').length,
    invalidated_events: usages.filter(u => reportSourceTrust(u) === 'invalidated').length
  };
}
export function partitionCost(rows: readonly { payload: Usage; occurred_at?: string }[], amounts: readonly (string | null)[]) {
  const sum = (state: ReportSourceTrust) => {
    const values = rows.flatMap((row, i) => (reportSourceTrust(row.payload) === state && amounts[i] != null ? [amounts[i]] : []));
    return values.length ? sumAmounts(values) : null;
  };
  return {
    partial_amount: sum('verified'),
    compatibility_unverified_partial_amount: sum('compatibility_unverified'),
    legacy_unverified_partial_amount: sum('legacy_unverified'),
    compatibility: reportCompatibility(
      rows.map(row => row.payload),
      rows.map(row => row.occurred_at)
    )
  };
}
