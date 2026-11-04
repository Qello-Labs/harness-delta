import { Decimal } from 'decimal.js';
import { addTokens, EventSchema, IdSchema, MonetaryAmountSchema } from './contracts.js';
import { parseComparison } from './comparison-contracts.js';
import { PriceTableSchema, type BillingComponent, type UsageEvent, type PriceTable, type PricedUsage, type RuntimeEvidence } from './flexible-contracts.js';
import { verifiedRequestPromptTokens } from './request-price-evidence.js';
import { pricingComponents, type PriceableComponent } from './cache-write-ttl.js';
import type { Store } from './store.js';
// Prices: <=60 digits, counters/units: <=16 digits, <=4096 entries.
// Precision160 exceeds finite-product/sum requirements and preserves >80 guard
// digits for nonterminating division. Global Decimal configuration is untouched.
export const costFormulaVersion = 'decimal160-disjoint-v1';
const Money = Decimal.clone({ precision: 160, rounding: Decimal.ROUND_HALF_EVEN, toExpNeg: -1000, toExpPos: 1000 });
export function registerPriceTable(store: Store, input: PriceTable): void {
  const table = parseComparison(PriceTableSchema, input, 'invalid_price_table');
  const payload = JSON.stringify(table);
  store.immediateTransaction(() => {
    const existing = store.get<{ payload: string }>('SELECT payload FROM price_tables WHERE id=?', [table.id]);
    if (existing) {
      if (existing.payload !== payload) throw new Error('price_table_conflict');
      return;
    }
    store.execute('INSERT INTO price_tables(id,payload) VALUES (?,?)', [table.id, payload]);
  });
}
export function readPriceTable(store: Store, id: string): PriceTable {
  parseComparison(IdSchema, id);
  const row = store.get<{ payload: string }>('SELECT payload FROM price_tables WHERE id=?', [id]);
  if (!row) throw new Error('unknown_price_table');
  return parseComparison(PriceTableSchema, JSON.parse(row.payload) as unknown, 'invalid_price_table');
}
export type LegacyInputBasis = 'output-only-v1' | 'cache-read-remainder-ordinary-v1';
export function priceUsage(
  input: UsageEvent,
  inputTable: PriceTable,
  legacyInputBasis: LegacyInputBasis = 'output-only-v1',
  runtimeEvidence: readonly RuntimeEvidence[] = []
): PricedUsage {
  if (!['output-only-v1', 'cache-read-remainder-ordinary-v1'].includes(legacyInputBasis)) throw new Error('invalid_input_basis');
  const event = parseComparison(EventSchema, input, 'invalid_event');
  if (event.payload.kind !== 'usage') throw new Error('invalid_event');
  const table = parseComparison(PriceTableSchema, inputTable, 'invalid_price_table');
  const u = event.payload;
  const reasons: PricedUsage['reasons'] = [];
  const conditional = table.entries.some(entry => entry.product === u.product && entry.model === u.model && entry.prompt_tier !== undefined);
  const promptTokens = conditional ? verifiedRequestPromptTokens(event as UsageEvent, runtimeEvidence) : null;
  if (conditional && promptTokens === null)
    return { event_id: event.id, amount: null, partial_amount: null, reasons: ['unknown_components', 'unpriced_component'] };
  if (u.model === null) reasons.push('unknown_model');
  if ('schema_version' in u && u.attribution !== 'verified') reasons.push('unknown_attribution');
  // V1 lacks provenance for cache-write and request accounting. By default price
  // observed output only; an explicit basis below never certifies completeness.
  const components: BillingComponent[] = 'schema_version' in u ? u.billing_components : [{ kind: 'output', reading: u.output_total }];
  if (!('schema_version' in u) && legacyInputBasis === 'cache-read-remainder-ordinary-v1') {
    // Explicit descriptive assumption only: unknown cache writes are not evidence
    // of zero. Preserve unknown_components even when all arithmetic is available.
    reasons.push('unknown_components');
    if (u.input_total.status === 'observed' && u.cached_input.status === 'observed') {
      if (u.cached_input.value > u.input_total.value) throw new Error('invalid_usage_components');
      components.push(
        { kind: 'ordinary_input', reading: { status: 'observed', value: u.input_total.value - u.cached_input.value, reason: null } },
        { kind: 'cache_read', reading: u.cached_input }
      );
    }
  }
  const inputs = components.filter(c => c.kind !== 'output');
  const output = components.find(c => c.kind === 'output');
  const inputsKnown = inputs.length > 0 && inputs.every(c => c.reading.status === 'observed');
  const inputSum = inputsKnown ? addTokens(inputs.map(c => c.reading.value!)) : null;
  const cached = inputs.find(c => c.kind === 'cache_read');
  if (
    (u.input_total.status === 'observed' && inputSum !== null && inputSum > u.input_total.value) ||
    (output?.reading.status === 'observed' && u.output_total.status === 'observed' && output.reading.value > u.output_total.value) ||
    (cached?.reading.status === 'observed' && u.cached_input.status === 'observed' && cached.reading.value > u.cached_input.value)
  )
    throw new Error('invalid_usage_components');
  if (
    !inputsKnown ||
    u.input_total.status !== 'observed' ||
    inputSum !== u.input_total.value ||
    !output ||
    output.reading.status !== 'observed' ||
    u.output_total.status !== 'observed' ||
    output.reading.value !== u.output_total.value ||
    u.cached_input.status !== 'observed' ||
    (cached?.reading.status === 'observed' ? cached.reading.value : 0) !== u.cached_input.value
  )
    reasons.push('unknown_components');
  let numerator = new Money(0);
  let priced = false;
  if (u.model !== null && (!('schema_version' in u) || u.attribution === 'verified')) {
    const priceable: PriceableComponent[] = 'schema_version' in u ? pricingComponents(u, table) : components;
    for (const component of priceable) {
      if (component.reading.status !== 'observed') {
        reasons.push('unknown_components');
        continue;
      }
      if (
        component.kind === 'cache_write' &&
        (table.cache_write_policy === 'observed_ttl-v1' && u.product === 'claude_code'
          ? component.cache_ttl === undefined
          : 'cache_write_1h_observed' in u && u.cache_write_1h_observed)
      ) {
        reasons.push('unpriced_component');
        continue;
      }
      const entry = table.entries.find(
        e =>
          e.product === u.product &&
          e.model === u.model &&
          e.component === component.kind &&
          e.cache_ttl === component.cache_ttl &&
          (e.prompt_tier === undefined || e.prompt_tier === (promptTokens! <= 100000 ? 'up_to_100000' : 'over_100000'))
      );
      if (!entry) {
        reasons.push('unpriced_component');
        continue;
      }
      numerator = numerator.plus(new Money(entry.price_per_unit).times(component.reading.value));
      priced = true;
    }
  }
  const partial = priced ? numerator.div(table.unit_tokens).toFixed() : null;
  return { event_id: event.id, amount: reasons.length === 0 ? partial : null, partial_amount: partial, reasons: [...new Set(reasons)].sort() };
}
export function sumAmounts(amounts: readonly string[]): string {
  let sum = new Money(0);
  for (const amount of amounts) {
    parseComparison(MonetaryAmountSchema, amount, 'invalid_amount');
    if (amount.length > 512 || new Money(amount).sd() > 200) throw new Error('amount_overflow');
    sum = sum.plus(amount);
  }
  if (!sum.isFinite() || sum.e >= 100) throw new Error('amount_overflow');
  return sum.toFixed();
}
export function displayAmount(amount: string, inputTable: PriceTable): string {
  const table = parseComparison(PriceTableSchema, inputTable, 'invalid_price_table');
  parseComparison(MonetaryAmountSchema, amount, 'invalid_amount');
  return new Money(amount).toFixed(table.display_decimals, Decimal.ROUND_HALF_EVEN);
}
