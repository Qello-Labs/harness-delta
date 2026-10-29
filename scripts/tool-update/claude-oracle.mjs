import { requireCondition } from './fixtures.mjs';

const counters = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];
export const historical = Object.freeze({
  normal: Object.freeze({ served: 6, terminal: 6, baseline: 1, retained: [3, 1, 1], input: 675, output: 555, incomplete: 0 }),
  sigint: Object.freeze({ served: 6, terminal: 5, baseline: 1, retained: [2, 1, 1], input: 540, output: 444, incomplete: 1 }),
});

/** Independent metadata projection; no native content survives the call. */
export function projectTranscript(text, session, agent = null, excluded = []) {
  const lines = text.split('\n'), requests = new Map();
  requireCondition(lines.pop() === '', 'source_invalid');
  for (const line of lines) {
    if (!line) continue;
    let row;
    try { row = JSON.parse(line); } catch { requireCondition(false, 'source_invalid'); }
    if (row.type !== 'assistant' || row.message?.model === '<synthetic>') continue;
    requireCondition(row.sessionId === session && row.version === '2.1.306', 'ownership_invalid');
    // A copied child row in the root must never count as a root-owned request.
    if (agent === null ? row.agentId !== undefined || row.isSidechain === true : row.agentId !== agent) continue;
    requireCondition(agent === null || row.isSidechain === true, 'ownership_invalid');
    requireCondition(typeof row.requestId === 'string' && /^req_conformance_[1-6]$/.test(row.requestId) &&
      typeof row.message?.id === 'string', 'ownership_invalid');
    const u = row.message.usage;
    requireCondition(u && counters.every(key => Number.isSafeInteger(u[key]) && u[key] >= 0), 'counter_invalid');
    const ttl = u.cache_creation;
    requireCondition(ttl && ['ephemeral_5m_input_tokens', 'ephemeral_1h_input_tokens']
      .every(key => Number.isSafeInteger(ttl[key]) && ttl[key] >= 0) &&
      ttl.ephemeral_5m_input_tokens + ttl.ephemeral_1h_input_tokens === u.cache_creation_input_tokens, 'counter_invalid');
    requireCondition([null, 'tool_use', 'end_turn'].includes(row.message.stop_reason), 'counter_invalid');
    const value = { message: row.message.id, sessionId: agent === null ? session : `${session}:${agent}`,
      counters: Object.fromEntries(counters.map(key => [key, u[key]])),
      ttl: [ttl.ephemeral_5m_input_tokens, ttl.ephemeral_1h_input_tokens],
      terminal: row.message.stop_reason !== null, excluded: excluded.includes(row.requestId) };
    const old = requests.get(row.requestId);
    if (old) {
      requireCondition(old.message === value.message, 'request_conflict');
      if (old.terminal) {
        requireCondition(!value.terminal || (JSON.stringify(old.counters) === JSON.stringify(value.counters) &&
          JSON.stringify(old.ttl) === JSON.stringify(value.ttl)), 'request_conflict');
        continue;
      }
    }
    requests.set(row.requestId, value);
  }
  return requests;
}

export function reconcileOracle(scenario, ledger, sources) {
  const expected = historical[scenario];
  requireCondition(expected !== undefined && ledger.length === expected.served && sources.length === 3, 'oracle_mismatch');
  const served = new Map(ledger.map(row => [row.requestId, row]));
  requireCondition(served.size === ledger.length, 'request_conflict');
  const seen = new Set(), owners = new Map(), retained = [];
  let input = 0, output = 0, terminal = 0, baseline = 0, incomplete = 0;
  for (const [index, source] of sources.entries()) {
    let count = 0;
    for (const [id, row] of source) {
      const request = served.get(id);
      requireCondition(request !== undefined && !seen.has(id) && (index === 0 ? request.owner === 'root' : request.owner !== 'root'), 'ownership_invalid');
      if (index !== 0) {
        const owner = owners.get(index);
        requireCondition(owner === undefined || owner === request.owner, 'ownership_invalid');
        owners.set(index, request.owner);
      }
      seen.add(id);
      if (!row.terminal) {
        requireCondition(request.status === 'partial', 'oracle_mismatch'); incomplete++; continue;
      }
      requireCondition(request.status === 'terminal' && counters.every(k => row.counters[k] === request.counters[k]) &&
        row.ttl[0] === 7 && row.ttl[1] === 4, 'oracle_mismatch');
      terminal++;
      if (row.excluded) { baseline++; continue; }
      count++; input += row.counters.input_tokens + row.counters.cache_read_input_tokens + row.counters.cache_creation_input_tokens;
      output += row.counters.output_tokens;
      requireCondition(Number.isSafeInteger(input) && Number.isSafeInteger(output), 'counter_invalid');
    }
    retained.push(count);
  }
  requireCondition(owners.size === 2 && new Set(owners.values()).size === 2, 'ownership_invalid');
  for (const [id, row] of served) if (!seen.has(id)) {
    requireCondition(row.status === 'partial', 'oracle_mismatch'); incomplete++;
  }
  requireCondition(terminal === expected.terminal && baseline === expected.baseline &&
    input === expected.input && output === expected.output && incomplete === expected.incomplete &&
    JSON.stringify(retained) === JSON.stringify(expected.retained), 'oracle_mismatch');
  return { served: ledger.length, terminal, baseline, retained, input, output, incomplete,
    interrupted_usage: incomplete ? { status: 'missing', value: null } : null };
}

export function reconcileCollector(summary, batches, sources) {
  const expected = new Map(sources.flatMap(source => [...source.entries()]
    .filter(([, row]) => row.terminal && !row.excluded)));
  const seen = new Set(); let input = 0, output = 0;
  for (const batch of batches) {
    requireCondition(batch.gaps.every(gap => gap === 'binding_partial_usage' || gap === 'missing_usage'), 'collector_mismatch');
    for (const record of batch.records) {
      const row = expected.get(record.requestId), payload = record.payload;
      requireCondition(row && record.sessionId === row.sessionId && !seen.has(record.requestId) &&
        payload.product === 'claude_code' && payload.product_version === '2.1.306' &&
        payload.model === 'claude-sonnet-5-5' && payload.input_total.status === 'observed' &&
        payload.output_total.status === 'observed' && payload.cached_input.status === 'observed' &&
        payload.input_total.value === row.counters.input_tokens + row.counters.cache_read_input_tokens + row.counters.cache_creation_input_tokens &&
        payload.output_total.value === row.counters.output_tokens &&
        payload.cached_input.value === row.counters.cache_read_input_tokens &&
        payload.cache_write_ttl?.status === 'observed' && payload.cache_write_ttl.five_minute_tokens === row.ttl[0] &&
        payload.cache_write_ttl.one_hour_tokens === row.ttl[1] &&
        payload.reasoning_output.status === 'unmeasurable' && payload.reasoning_output.value === null, 'collector_mismatch');
      const components = new Map(payload.billing_components.map(component => [component.kind, component.reading]));
      requireCondition(components.size === 4 && payload.billing_components.length === 4 &&
        [['ordinary_input', 'input_tokens'], ['cache_read', 'cache_read_input_tokens'],
          ['cache_write', 'cache_creation_input_tokens'], ['output', 'output_tokens']]
          .every(([kind, counter]) => components.get(kind)?.status === 'observed' &&
            components.get(kind).value === row.counters[counter]), 'collector_mismatch');
      seen.add(record.requestId); input += payload.input_total.value; output += payload.output_total.value;
    }
  }
  requireCondition(seen.size === expected.size && input === summary.input && output === summary.output, 'collector_mismatch');
  return { records: seen.size, input, output, partial_usage: true, complete_cost: false };
}
