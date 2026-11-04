import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { lookupFileProfile } from '../src/adapter-profiles.js';
import { Collector } from '../src/collection.js';
import { evaluateCoverage, mergeCoverageFacts, type CoverageEvidence } from '../src/core/coverage.js';
import { Lifecycle } from '../src/lifecycle.js';
import { aggregateTask } from '../src/metrics.js';
import { Store } from '../src/store.js';

// Supplied policy fixtures only: these facts are never inferred from product logs.
const verified: CoverageEvidence['facts'] = {
  scopeBeforeAccess: 'verified',
  freshSession: 'verified',
  readyBeforeFirstRequest: 'verified',
  continuousObservation: 'verified',
  fixedModel: 'verified',
  boundedTopology: 'verified',
  requestUniverse: 'verified',
  terminalAccounting: 'verified',
  immutableIdentity: 'verified',
  durableFlush: 'verified',
  counterSemantics: 'verified'
};
const at = (second: number) => new Date(Date.parse('2026-01-01T00:00:00Z') + second * 1000).toISOString();
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'synthetic-codex-readiness-'));
  const path = join(root, 'synthetic.jsonl');
  const store = new Store(':memory:');
  let second = 0;
  const life = new Lifecycle(store, () => at(second));
  life.registerProject('p1', root);
  life.createTask('p1', 't1', { type: 'feature', expected_size: 'small', assignee: 'u1', product: 'codex', model: 'synthetic', criterion_ids: ['c1'] });
  life.linkSession('t1', 's1', path, 'codex', '0.158.0');
  writeFileSync(path, JSON.stringify({ type: 'session_meta', payload: { id: 's1', cwd: root, cli_version: '0.158.0', source: 'exec' } }) + '\n');
  const collector = new Collector(store, () => at(second));
  life.start('t1');
  collector.tick('t1');
  const turn = (start: number, input: number, output: number) => {
    const rows = [
      { timestamp: at(start), type: 'event_msg', payload: { type: 'task_started', turn_id: `turn${start}` } },
      {
        type: 'turn_context',
        payload: {
          turn_id: `turn${start}`,
          root_turn_id: `turn${start}`,
          model: 'synthetic',
          cwd: root,
          collaboration_mode: { mode: 'default' },
          multi_agent_version: 'disabled'
        }
      },
      {
        timestamp: at(start + 1),
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: input, output_tokens: output, cached_input_tokens: 0, cache_write_input_tokens: 0, reasoning_output_tokens: 0 }
          }
        }
      },
      { timestamp: at(start + 1), type: 'event_msg', payload: { type: 'task_complete', turn_id: `turn${start}` } }
    ];
    appendFileSync(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  };
  return {
    store,
    life,
    collector,
    turn,
    set: (value: number) => {
      second = value;
    },
    report: () => aggregateTask(store, 't1', at(second)),
    cleanup: () => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  };
}

test('registered checkpoint collection preserves observed zero and replay without promoting synthetic eligibility', () => {
  const f = fixture();
  try {
    f.turn(1, 0, 0);
    f.set(3);
    f.collector.tick('t1');
    f.collector.tick('t1');
    const report = f.report();
    expect(f.store.eventCount()).toBe(1);
    expect(report.usage).toMatchObject({ status: 'partial', partial_tokens: 0, complete_tokens: null });
    for (const metric of ['input_total', 'output_total'] as const) {
      expect(report.usage[metric]).toMatchObject({ observed_sum: 0, observed_events: 1 });
      expect(
        evaluateCoverage({ profileId: 'synthetic-coverage-v1', metric, facts: verified, hasObservedValue: report.usage[metric].observed_sum !== null }).eligible
      ).toBe(true);
    }
    const profile = lookupFileProfile('codex', '0.158.0');
    expect(profile).toMatchObject({ commandDiagnostics: false, evidence: { completeTotals: false } });
    expect(() => evaluateCoverage({ profileId: 'codex-0.158.0', metric: 'input_total', facts: verified, hasObservedValue: true })).toThrow(
      /^invalid_coverage_input$/
    );
    f.life.finalize('t1', 'success', ['c1']);
    expect(f.report().usage.complete_tokens).toBeNull();
  } finally {
    f.cleanup();
  }
});

test('an admitted session with no usage remains missing for both metrics rather than observed zero', () => {
  const f = fixture();
  try {
    f.set(1);
    f.collector.tick('t1');
    const report = f.report();
    expect(report.usage).toMatchObject({ status: 'missing', partial_tokens: null, complete_tokens: null });
    for (const metric of ['input_total', 'output_total'] as const) {
      expect(report.usage[metric]).toMatchObject({ observed_sum: null, observed_events: 0 });
      expect(
        evaluateCoverage({ profileId: 'synthetic-coverage-v1', metric, facts: verified, hasObservedValue: report.usage[metric].observed_sum !== null })
      ).toEqual({ eligible: false, reasons: ['missing_value'] });
    }
  } finally {
    f.cleanup();
  }
});

test('present input cannot certify output counter semantics or the actual task', () => {
  const f = fixture();
  try {
    f.turn(1, 12, 3);
    f.set(3);
    f.collector.tick('t1');
    const report = f.report();
    expect(
      evaluateCoverage({
        profileId: 'synthetic-coverage-v1',
        metric: 'input_total',
        facts: verified,
        hasObservedValue: report.usage.input_total.observed_sum !== null
      }).eligible
    ).toBe(true);
    expect(
      evaluateCoverage({
        profileId: 'synthetic-coverage-v1',
        metric: 'output_total',
        facts: { ...verified, counterSemantics: 'unknown' },
        hasObservedValue: report.usage.output_total.observed_sum !== null
      })
    ).toEqual({ eligible: false, reasons: ['counterSemantics'] });
    expect(report.usage).toMatchObject({ partial_tokens: 15, complete_tokens: null });
  } finally {
    f.cleanup();
  }
});

test('pause exclusion persists after clean resumed usage; completed-interval facts cannot repair it', () => {
  const f = fixture();
  try {
    f.turn(1, 10, 2);
    f.set(3);
    f.collector.tick('t1');
    f.life.pause('t1');
    f.turn(4, 30, 6);
    f.set(6);
    f.life.resume('t1');
    f.collector.tick('t1');
    f.turn(7, 35, 7);
    f.set(9);
    f.collector.tick('t1');
    expect(f.store.eventCount()).toBe(2);
    const report = f.report();
    expect(report.usage).toMatchObject({ partial_tokens: 18, complete_tokens: null });
    expect(report.usage.reasons).toContain('offline');
    const facts = mergeCoverageFacts({ ...verified, continuousObservation: 'violated', requestUniverse: 'unknown' }, verified);
    for (const metric of ['input_total', 'output_total'] as const) {
      expect(evaluateCoverage({ profileId: 'synthetic-coverage-v1', metric, facts, hasObservedValue: report.usage[metric].observed_sum !== null })).toEqual({
        eligible: false,
        reasons: ['continuousObservation', 'requestUniverse']
      });
    }
  } finally {
    f.cleanup();
  }
});
