import type { CandidateScope } from '../../src/nested-candidate.js';
import type { Store } from '../../src/store.js';

export const startedAt = '2026-01-01T00:00:00.000Z';
export const receivedAt = '2026-01-01T00:00:03.000Z';
export const traceScope: CandidateScope = {
  projectId: 'project-1',
  taskId: 'task-1',
  allowedRootTurnIds: ['turn-root'],
  sessions: [
    {
      sessionId: 'root',
      rootSessionId: 'root',
      parentSessionId: null,
      sourceId: 'source-root',
      product: 'claude_code',
      nativeSessionId: 'native-root',
      processId: 'process-1',
      agentId: null
    },
    {
      sessionId: 'child',
      rootSessionId: 'root',
      parentSessionId: 'root',
      sourceId: 'source-child',
      product: 'claude_code',
      nativeSessionId: 'native-root',
      processId: 'process-1',
      agentId: 'agent-child'
    }
  ]
};
export function seedTraceScope(store: Store): void {
  store.execute('INSERT INTO projects(id) VALUES (?)', ['project-1']);
  store.execute("INSERT INTO tasks(id,project_id,state) VALUES ('task-1','project-1','active')", []);
  for (const s of traceScope.sessions)
    store.execute('INSERT INTO sessions(id,task_id,project_id,parent_id,product,product_version) VALUES (?,?,?,?,?,?)', [
      s.sessionId,
      'task-1',
      'project-1',
      s.parentSessionId,
      'claude_code',
      '2.1.288'
    ]);
}
export function attrs(input: Record<string, unknown>): { key: string; value: unknown }[] {
  return Object.entries(input)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => ({
      key,
      value: typeof value === 'string' ? { stringValue: value } : typeof value === 'boolean' ? { boolValue: value } : { intValue: String(value) }
    }));
}
export function span(child = false, patch: Record<string, unknown> = {}) {
  return {
    name: 'claude_code.llm_request',
    traceId: '1'.repeat(32),
    spanId: (child ? '3' : '2').repeat(16),
    parentSpanId: '4'.repeat(16),
    startTimeUnixNano: '1767225601000000000',
    endTimeUnixNano: '1767225602000000000',
    status: { code: 0 },
    attributes: attrs({
      'session.id': 'native-root',
      'app.version': '2.1.288',
      'harness_delta.process_id': 'process-1',
      agent_id: child ? 'agent-child' : undefined,
      model: child ? 'child-model' : 'root-model',
      effort: child ? 'high' : undefined,
      request_id: child ? 'request-child' : 'request-root',
      input_tokens: 30,
      output_tokens: 15,
      cache_read_tokens: 20,
      cache_creation_tokens: 10,
      success: true,
      attempt: 1,
      ...patch
    })
  };
}
export function traces(spans: unknown[] = [span(), span(true)]) {
  return { resourceSpans: [{ resource: { attributes: attrs({ 'harness_delta.process_id': 'process-1' }) }, scopeSpans: [{ spans }] }] };
}
