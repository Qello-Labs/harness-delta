import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { localWebTaskErrorCodes } from '../../src/local-web-task-errors.js';
import type { RecruitmentWindow } from '../../src/local-web-recruitment.js';
import { taskErrorGuidance } from './task-error-guidance';
import { TaskErrorNotice } from './TaskErrorNotice';

const recruitment: RecruitmentWindow = { starts_at: '2099-01-01T00:00:00Z', ends_at: '2099-01-02T00:00:00Z', state: 'before_start' };

test.each(['before_start', 'open', 'ended'] as const)('outside recruitment chooses the server-provided %s state, not the browser clock', state => {
  expect(taskErrorGuidance('outside_recruitment', 'ko', { ...recruitment, state })?.kind).toBe(`outside_recruitment_${state}`);
});

test.each(localWebTaskErrorCodes)('task error %s selects a specific guide in both locales', code => {
  for (const locale of ['ko', 'en'] as const)
    expect(taskErrorGuidance(code, locale)?.kind).toBe(code);
});

test('unknown errors use the existing fallback without attaching unrelated recruitment details', () => {
  expect(taskErrorGuidance('unrecognized_code', 'ko', recruitment)).toBeNull();
  const html = renderToStaticMarkup(createElement(TaskErrorNotice, { code: 'unrecognized_code', locale: 'ko', recruitment, fallback: 'Synthetic fallback' }));
  expect(html).toContain('data-error-kind="generic"');
  expect(html).not.toContain('data-recruitment-state');
});

test('known error renders its selected guide, exact timestamps and a collapsed technical code', () => {
  const html = renderToStaticMarkup(createElement(TaskErrorNotice, { code: 'outside_recruitment', locale: 'ko', recruitment, fallback: 'Synthetic fallback' }));
  expect(html).toContain('data-error-kind="outside_recruitment_before_start"');
  expect([...html.matchAll(/<time datetime="([^"]+)"/gi)].map(match => match[1])).toEqual([recruitment.starts_at, recruitment.ends_at]);
  expect(html).toMatch(/<details\b[^>]*>/);
  expect(html).not.toMatch(/<details\b[^>]*\bopen/);
});

test('outside recruitment without window metadata does not guess a period', () => {
  expect(taskErrorGuidance('outside_recruitment', 'en')?.kind).toBe('outside_recruitment');
  const html = renderToStaticMarkup(createElement(TaskErrorNotice, { code: 'outside_recruitment', locale: 'en', fallback: 'Synthetic fallback' }));
  expect(html).not.toContain('<time');
});
