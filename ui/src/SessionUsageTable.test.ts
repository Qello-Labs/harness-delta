import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { SessionUsageTable } from './SessionUsageTable';
import { sessionDisplayLabels } from './session-labels';
import type { BindingSummary } from './types';

const summary: BindingSummary = {
 requests: 1, input_total: { status: 'observed', value: 10, statuses: [], reasons: [] },
 output_total: { status: 'missing', value: null, statuses: [], reasons: [] },
 partial_amount: null, currency: null, unpriced_events: 1, price_table_id: null, complete_cost: null,
};

test.each(['en', 'ko'] as const)('session identities remain available only inside closed %s diagnostics', locale => {
 const sessions = [
  { ...summary, session_id: 'synthetic-complete-root-id', parent_session_id: null },
  { ...summary, session_id: 'synthetic-complete-child-id', parent_session_id: 'synthetic-complete-root-id' },
 ];
 const markup = renderToStaticMarkup(createElement(SessionUsageTable, { sessions, summary, locale }));
 const disclosures = [...markup.matchAll(/<details\b([^>]*)>([\s\S]*?)<\/details>/g)];
 expect(disclosures).toHaveLength(2);
 expect(disclosures.every(match => !/\bopen\b/.test(match[1] ?? ''))).toBe(true);
 for (const session of sessions) expect(disclosures.some(match => match[2]?.includes(session.session_id))).toBe(true);
 const primary = markup.replace(/<details\b[^>]*>[\s\S]*?<\/details>/g, '');
 for (const session of sessions) expect(primary).not.toContain(session.session_id);
 for (const label of sessionDisplayLabels(sessions, locale)) expect(primary).toContain(label);
 expect(primary.match(/scope="row"/g)).toHaveLength(2);
 expect(primary).toContain('<td>1</td>');
});
