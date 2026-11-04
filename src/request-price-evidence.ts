import { addTokens } from './contracts.js';
import { RuntimeEvidenceSchema, type RuntimeEvidence, type UsageEvent } from './flexible-contracts.js';

/** Keep linked metadata and conflicting aliases so freezing cannot make an ambiguous request priceable. */
export function linkedRequestPriceEvidence(events: readonly UsageEvent[], evidence: readonly RuntimeEvidence[]): RuntimeEvidence[] {
  const ids = new Set(
    events.flatMap(event => ('schema_version' in event.payload && event.payload.runtime_evidence_id ? [event.payload.runtime_evidence_id] : []))
  );
  const key = (row: RuntimeEvidence) => JSON.stringify([row.product, row.product_version, row.request_id]);
  const requests = new Set(evidence.filter(row => ids.has(row.id) && row.request_id !== null).map(key));
  return evidence.filter(row => ids.has(row.id) || (row.request_id !== null && requests.has(key(row))));
}

/** Full prompt tokens from an identified request, never session sums or ordinary input alone. */
export function verifiedRequestPromptTokens(event: UsageEvent, evidence: readonly RuntimeEvidence[]): number | null {
  const usage = event.payload;
  if (!('schema_version' in usage) || usage.attribution !== 'verified' || usage.input_total.status !== 'observed') return null;
  const matches = evidence.filter(row => row.id === usage.runtime_evidence_id);
  if (matches.length !== 1) return null;
  const parsed = RuntimeEvidenceSchema.safeParse(matches[0]);
  if (!parsed.success) return null;
  const runtime = parsed.data;
  if (
    runtime.boundary !== 'request' ||
    runtime.request_id === null ||
    runtime.source === 'self_attested' ||
    runtime.task_id !== event.task_id ||
    runtime.session_id !== event.session_id ||
    runtime.product !== usage.product ||
    runtime.product_version !== usage.product_version ||
    runtime.model !== usage.model ||
    runtime.occurred_at !== event.occurred_at
  )
    return null;
  if (
    evidence.filter(row => row.request_id === runtime.request_id && row.product === runtime.product && row.product_version === runtime.product_version)
      .length !== 1
  )
    return null;
  const inputs = ['ordinary_input', 'cache_read', 'cache_write'].map(kind => usage.billing_components.find(row => row.kind === kind)?.reading);
  if (
    inputs.some(reading => reading?.status !== 'observed') ||
    usage.cached_input.status !== 'observed' ||
    usage.billing_components.find(row => row.kind === 'cache_read')?.reading.value !== usage.cached_input.value
  )
    return null;
  try {
    const total = addTokens(inputs.map(reading => reading!.value!));
    return total === usage.input_total.value ? total : null;
  } catch {
    return null;
  }
}
