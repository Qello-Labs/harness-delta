import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, test, vi } from 'vitest';
import { readOrdinaryWindowBindingReport } from '../../src/ordinary-session-binding.js';
import { recordObservationGap } from '../../src/runtime-history.js';
import { emptyOrdinaryWindowCoverage } from '../../src/core/ordinary-window-policy.js';
import { OrdinaryWindowReportView } from './OrdinaryWindowReport.js';
import { OrdinaryWindowNotice } from './OrdinaryWindowNotice.js';
import { UiRouter } from './UiRouter.js';
import type { Locale, ReportSourceTrust } from './types.js';
import { windowReportCutoff, windowReportFixture } from '../../tests/helpers/ordinary-window-report-fixture.js';

const fixtures: ReturnType<typeof windowReportFixture>[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.store.close();
  vi.unstubAllGlobals();
});
function fixture(product: 'codex' | 'claude_code') {
  const value = windowReportFixture(product);
  fixtures.push(value);
  return value;
}
function render(value: ReturnType<typeof windowReportFixture>, locale: Locale) {
  const report = readOrdinaryWindowBindingReport(value.store, value.taskId, windowReportCutoff);
  return renderToStaticMarkup(createElement(OrdinaryWindowReportView, { report, locale }));
}
function cells(markup: string, trust: ReportSourceTrust) {
  const row = markup.match(new RegExp(`<tr[^>]*data-window-trust="${trust}"[^>]*>([\\s\\S]*?)</tr>`))?.[1];
  if (!row) throw new Error(`Missing visible trust row: ${trust}`);
  return [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(match => match[1]?.replace(/<[^>]+>/g, '').trim());
}

test.each(['en', 'ko'] as const)('unknown exclusion reasons use a fixed label without raw text in %s', locale => {
  const f = fixture('codex');
  f.life.start(f.taskId);
  f.put('excluded-reference', 'compatibility_unverified', { at: '2026-11-06T01:02:00.000Z' });
  recordObservationGap(f.store, f.taskId, 'excluded-reference', '2026-11-06T01:02:00.000Z', '2026-11-06T01:03:00.000Z', 'source_error', f.clock());
  const report = readOrdinaryWindowBindingReport(f.store, f.taskId, windowReportCutoff);
  expect(report.cost.excluded_event_count).toBe(1);
  const privateReason = 'SYNTHETIC_PRIVATE_REASON_DO_NOT_RENDER';
  report.cost.reasons.push(privateReason);
  const markup = renderToStaticMarkup(createElement(OrdinaryWindowReportView, { report, locale }));
  expect(markup).not.toContain(privateReason);
  expect(markup).toContain(locale === 'en' ? 'Other or unknown code' : '기타 또는 알 수 없는 코드');
  expect(markup).toContain(locale === 'en' ? 'Source error' : '원본 오류');
});

test.each(['en', 'ko'] as const)('unknown report codes never enter content or attributes in %s', locale => {
  const f = fixture('codex');
  f.activate();
  f.connect();
  f.put('eligible-zero', 'compatibility_unverified', { zero: true });
  const report = readOrdinaryWindowBindingReport(f.store, f.taskId, windowReportCutoff);
  expect(report.cost.compatibility_unverified.partial_amount).toBe('0');
  const segment = report.coverage.segments[0];
  if (!segment) throw new Error('Missing synthetic root segment');
  const targets = [
    [report, 'report_version'],
    [report.collection, 'state'],
    [report.collection, 'reason'],
    [report.selection.policy, 'policyId'],
    [report.selection.policy, 'evidenceMode'],
    [report.coverage, 'status'],
    [segment.coverage, 'status'],
    [segment, 'source_version_basis'],
    [segment, 'publisher_proof'],
    [segment, 'mapped_image_proof'],
    [segment, 'writer_version'],
    [report.cost, 'currency']
  ] as const;
  for (const [target, key] of targets) {
    Reflect.set(target, key, `SYNTHETIC_PRIVATE_CODE_${key}_DO_NOT_RENDER`);
  }
  const markup = renderToStaticMarkup(createElement(OrdinaryWindowReportView, { report, locale }));
  for (const [, key] of targets) {
    expect(markup).not.toContain(`SYNTHETIC_PRIVATE_CODE_${key}_DO_NOT_RENDER`);
  }
  expect(markup).toContain(locale === 'en' ? 'Other or unknown code' : '기타 또는 알 수 없는 코드');
});

test.each([
  ['codex', 'en'],
  ['codex', 'ko'],
  ['claude_code', 'en'],
  ['claude_code', 'ko']
] as const)('%s interval exclusions differ visibly from missing and invalidated readings in %s', (product, locale) => {
  const f = fixture(product);
  f.life.start(f.taskId);
  const eventless = render(f, locale);
  f.put('excluded-reference', 'compatibility_unverified', { at: '2026-11-06T01:02:00.000Z' });
  recordObservationGap(f.store, f.taskId, 'excluded-reference', '2026-11-06T01:02:00.000Z', '2026-11-06T01:03:00.000Z', 'source_error', f.clock());
  const report = readOrdinaryWindowBindingReport(f.store, f.taskId, windowReportCutoff);
  expect(report.cost.excluded_event_count).toBe(1);
  expect(report.usage.event_count).toBe(0);
  expect(report.usage.complete_tokens).toBeNull();
  expect(report.cost.complete_amount).toBeNull();
  expect(report.denominators.tokens_per_success).toBeNull();
  expect(report.denominators.cost_per_success).toBeNull();
  const markup = renderToStaticMarkup(createElement(OrdinaryWindowReportView, { report, locale }));
  expect(markup).not.toBe(eventless);
  const exclusionLabel = locale === 'en' ? 'Interval-excluded observations' : '구간 제외 관측';
  const exclusions = markup.match(new RegExp(`<dl[^>]*aria-label="${exclusionLabel}"[^>]*>([\\s\\S]*?)</dl>`))?.[1];
  expect(exclusions).toMatch(/<dd[^>]*>1<\/dd>/);
  expect(exclusions).toContain(locale === 'en' ? 'Source error' : '원본 오류');
  expect(exclusions).toContain(locale === 'en' ? 'Excluded intervals' : '제외 구간');
  expect(exclusions).not.toContain('excluded-reference');
  expect([...markup.matchAll(/<tr\b/g)]).toHaveLength(5);
  for (const trust of ['verified', 'compatibility_unverified', 'legacy_unverified', 'invalidated'] as const) {
    expect(report.usage[trust].complete_tokens).toBeNull();
    expect(report.cost[trust].complete_amount).toBeNull();
    expect(cells(markup, trust).slice(0, 3)).toEqual(['0', locale === 'en' ? 'Missing' : '누락', locale === 'en' ? 'Missing' : '누락']);
  }
});

test.each(['codex', 'claude_code'] as const)('eventless %s evidence renders unobserved coverage in both locales without zero child usage', product => {
  const f = fixture(product);
  const before = f.reportSnapshot();
  for (const locale of ['en', 'ko'] as const) {
    const markup = render(f, locale);
    expect(markup).toContain('data-window-collection="disabled"');
    expect(markup).toContain('data-window-root="unobserved"');
    expect(markup).toContain('data-window-child="unobserved"');
    expect(cells(markup, 'compatibility_unverified').slice(0, 3)).toEqual(['0', locale === 'en' ? 'Missing' : '누락', locale === 'en' ? 'Missing' : '누락']);
    expect(markup).not.toMatch(/<button|<form|data-task-action=/);
  }
  expect(f.reportSnapshot()).toEqual(before);
  expect(f.calls).toEqual([]);
});

test.each(['codex', 'claude_code'] as const)(
  '%s UI separates all four trust partitions and preserves observed zero, missing and invalidated values',
  product => {
    const f = fixture(product);
    f.life.start(f.taskId);
    f.put('verified', 'verified');
    f.put('zero', 'compatibility_unverified', { zero: true });
    f.put('missing', 'legacy_unverified', { missingOutput: true });
    f.put('invalidated', 'invalidated');
    const markup = render(f, 'en');
    expect([...markup.matchAll(/<tr\b/g)]).toHaveLength(5);
    expect(cells(markup, 'verified').slice(0, 3)).toEqual(['1', '10', '5']);
    expect(cells(markup, 'compatibility_unverified').slice(0, 3)).toEqual(['1', '0', '0']);
    expect(cells(markup, 'legacy_unverified').slice(0, 3)).toEqual(['1', '10', 'Missing']);
    expect(cells(markup, 'invalidated')).toEqual(['1', 'Excluded', 'Excluded', 'Excluded']);
    expect(cells(markup, 'compatibility_unverified')[3]).toBe(product === 'codex' ? 'USD 0' : 'Unavailable1 unpriced');
  }
);

test.each(['codex', 'claude_code'] as const)('%s eventless root and metadata-only child coverage remain visible outside enrolled usage rows', product => {
  const f = fixture(product);
  f.activate();
  f.connect();
  f.store.execute('UPDATE ordinary_window_segments SET coverage=? WHERE root_session_id=?', [
    JSON.stringify({
      ...emptyOrdinaryWindowCoverage(),
      detectedChildren: [
        { identity: 'metadata-child', firstSeenAt: f.clock(), basis: 'root_linked_receipt', parentRelation: 'unverified', usage: null, cost: null }
      ]
    }),
    f.rootId
  ]);
  const before = f.reportSnapshot();
  const markup = render(f, 'en');
  expect(markup).toContain('data-window-root="missing"');
  expect(markup).toMatch(/data-window-child="unobserved"[^>]*>metadata-child — Unobserved/);
  expect(cells(markup, 'compatibility_unverified').slice(0, 3)).toEqual(['0', 'Missing', 'Missing']);
  expect(f.store.all('SELECT * FROM sessions')).toHaveLength(1);
  expect(f.reportSnapshot()).toEqual(before);
  expect(f.calls).toEqual([]);
});

test.each(['codex', 'claude_code'] as const)(
  '%s UI marks incompatible historical root coverage invalidated without presenting a valid reference amount',
  product => {
    const f = fixture(product);
    f.activate();
    f.connect();
    f.put('historical', 'compatibility_unverified');
    f.store.execute('INSERT INTO source_compatibility_blocks(product,product_version,source,reason) VALUES (?,?,?,?)', [
      product,
      f.selection.declaredVersion,
      f.selection.policy.source,
      'contract_failed'
    ]);
    const markup = render(f, 'en');
    expect(markup).toContain('data-window-coverage="invalidated"');
    expect(markup).toContain('data-window-root="invalidated"');
    expect(cells(markup, 'invalidated')).toEqual(['1', 'Excluded', 'Excluded', 'Excluded']);
    expect(cells(markup, 'compatibility_unverified')).toEqual(['0', 'Missing', 'Missing', 'Unavailable']);
  }
);

test.each(['codex', 'claude_code'] as const)('%s window selection has no enabled control or mutation handler in either locale', product => {
  for (const locale of ['en', 'ko'] as const) {
    const markup = renderToStaticMarkup(createElement(OrdinaryWindowNotice, { product, locale }));
    expect(markup).toMatch(/<select[^>]*disabled=""/);
    expect(markup).toContain('href="#ordinary-window-task-v1"');
    expect(markup).not.toMatch(/<button|<form/);
  }
});

test('the explicit versioned report route renders its read-only inputs instead of legacy App bootstrap', () => {
  const query = new URLSearchParams({ task: 'synthetic-window-task', cutoff: windowReportCutoff, locale: 'en' });
  vi.stubGlobal('location', { hash: `#ordinary-window-task-v1?${query}` });
  const markup = renderToStaticMarkup(createElement(UiRouter));
  expect(markup).toMatch(/id="window-report-task"[^>]*value="synthetic-window-task"/);
  expect(markup).toMatch(/id="window-report-cutoff"[^>]*value="2026-11-06T01:10:00.000Z"/);
  expect(markup).not.toContain('data-task-action=');
});
