import { CacheWriteTtlSchema, TokenSchema } from '../contracts.js';
import type { BillingComponent, PriceTable, UsageV2 } from '../flexible-contracts.js';

export type PriceableComponent = BillingComponent & { cache_ttl?: '5m' | '1h' };

/** Only explicit, consistent numeric usage leaves prove the split. Never infer a remainder. */
export function readCacheWriteTtl(creation: unknown, aggregate: number): NonNullable<UsageV2['cache_write_ttl']> {
  const source = 'product_usage_cache_creation' as const;
  if (creation === undefined) return { status: 'missing', source, reason: 'not_available' };
  if (creation === null || typeof creation !== 'object' || Array.isArray(creation)) return { status: 'error', source, reason: 'source_error' };
  const values = creation as Record<string, unknown>;
  const five = values.ephemeral_5m_input_tokens;
  const hour = values.ephemeral_1h_input_tokens;
  if ((five !== undefined && !TokenSchema.safeParse(five).success) || (hour !== undefined && !TokenSchema.safeParse(hour).success))
    return { status: 'error', source, reason: 'source_error' };
  if (five === undefined || hour === undefined) return { status: 'missing', source, reason: 'not_available' };
  const parsed = CacheWriteTtlSchema.parse({ status: 'observed', source, five_minute_tokens: five, one_hour_tokens: hour });
  if (
    parsed.status !== 'observed' ||
    !Number.isSafeInteger(parsed.five_minute_tokens + parsed.one_hour_tokens) ||
    parsed.five_minute_tokens + parsed.one_hour_tokens !== aggregate
  )
    return { status: 'error', source, reason: 'source_error' };
  return parsed;
}

/** A transient pricing view. The durable billing component remains aggregate cache_write. */
export function pricingComponents(usage: UsageV2, table: PriceTable): PriceableComponent[] {
  if (table.cache_write_policy !== 'observed_ttl-v1' || usage.product !== 'claude_code' || usage.cache_write_ttl?.status !== 'observed')
    return usage.billing_components;
  const ttl = usage.cache_write_ttl;
  return usage.billing_components.flatMap(component =>
    component.kind !== 'cache_write'
      ? [component]
      : [
          { kind: 'cache_write' as const, cache_ttl: '5m' as const, reading: { status: 'observed' as const, value: ttl.five_minute_tokens, reason: null } },
          { kind: 'cache_write' as const, cache_ttl: '1h' as const, reading: { status: 'observed' as const, value: ttl.one_hour_tokens, reason: null } }
        ]
  );
}
