import type { SourceCompatibility } from '../../src/contracts.js';
import type { ReportSourceTrust } from '../../src/pricing/report-source-trust.js';
import { recordRuntimeEvidence } from '../../src/core/runtime-history.js';
import { ordinaryWindowFixture } from './ordinary-window-fixture.js';

export const windowReportCutoff = '2026-11-06T01:10:00.000Z';

export function windowReportFixture(product: 'codex' | 'claude_code' = 'codex') {
  const f = ordinaryWindowFixture(product);
  const put = (
    id: string,
    trust: ReportSourceTrust,
    options: { readonly zero?: boolean; readonly at?: string; readonly model?: string; readonly missingOutput?: boolean } = {}
  ) => {
    const version = trust === 'invalidated' ? '0.168.0' : f.selection.declaredVersion;
    f.store.execute('INSERT INTO sessions(id,project_id,task_id,product,product_version) VALUES (?,?,?,?,?)', [id, 'project', f.taskId, product, version]);
    if (trust !== 'legacy_unverified') {
      const compatibility: SourceCompatibility = {
        state: trust === 'invalidated' ? 'compatibility_unverified' : trust,
        product,
        product_version: version,
        source: f.selection.policy.source,
        parser_version: f.selection.policy.baseVersion,
        parser_revision: 'synthetic-report-parser',
        profile_id: 'synthetic-report-profile',
        rule_revision: 'synthetic-report-rule'
      };
      f.store.execute('INSERT INTO session_source_compatibility(session_id,payload) VALUES (?,?)', [id, JSON.stringify(compatibility)]);
    }
    const payload = f.record(id).payload;
    const output = options.missingOutput
      ? { status: 'missing' as const, value: null, reason: 'not_available' as const }
      : { status: 'observed' as const, value: options.zero ? 0 : 5, reason: null };
    const observed = { status: 'observed' as const, value: 0, reason: null };
    recordRuntimeEvidence(f.store, {
      id: `runtime-${id}`,
      task_id: f.taskId,
      session_id: id,
      turn_id: null,
      request_id: id,
      model: options.model ?? payload.model,
      effort: 'high',
      product,
      product_version: version,
      source: 'product_log',
      occurred_at: f.clock(),
      recorded_at: f.clock(),
      boundary: 'request'
    });
    f.store.putEvent({
      id,
      source_key: id,
      project_id: 'project',
      task_id: f.taskId,
      session_id: id,
      occurred_at: options.at ?? '2026-11-06T01:01:00.000Z',
      payload: {
        ...payload,
        runtime_evidence_id: `runtime-${id}`,
        product_version: version,
        model: options.model ?? payload.model,
        ...(options.zero ? { input_total: observed, cached_input: observed, reasoning_output: observed } : {}),
        output_total: output,
        billing_components: [{ kind: 'output', reading: output }]
      }
    });
    if (trust === 'invalidated') {
      f.store.execute('INSERT OR IGNORE INTO source_compatibility_blocks(product,product_version,source,reason) VALUES (?,?,?,?)', [
        product,
        version,
        f.selection.policy.source,
        'contract_failed'
      ]);
    }
  };
  const reportSnapshot = () =>
    f.store.all<{ name: string }>("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map(row => ({
      table: row.name,
      rows: f.store
        .all(`SELECT * FROM "${row.name}"`)
        .map(value => JSON.stringify(value))
        .sort()
    }));
  return { ...f, put, reportSnapshot };
}
