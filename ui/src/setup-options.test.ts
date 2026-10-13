import { expect, test } from 'vitest';
import { taskSetupOptions } from './setup-options';
import type { Setup } from './types';

const template: Setup = { id: 'template', name: 'Template', project_id: 'one', arm_a: 'a', arm_b: 'b', types: ['feature'], sizes: ['small'], support: 'synthetic' };
const connected: Setup = { ...template, id: 'shared-one', shared: { revision_id: 'revision', template_id: template.id, template_name: template.name, runtime: { model: null, effort: null } } };

test('connected comparison replaces its template without mutating the stored list', () => {
  const stored = [template, connected];
  expect(taskSetupOptions(stored).map(setup => setup.id)).toEqual(['shared-one']);
  expect(stored).toHaveLength(2);
});

test('unconnected and other-project templates remain available', () => {
  const other = { ...template, project_id: 'two' };
  expect(taskSetupOptions([template])).toEqual([template]);
  expect(taskSetupOptions([template, connected, other])).toEqual([connected, other]);
});

test('multiple shared comparisons referencing one template remain distinct', () => {
  const second = { ...connected, id: 'shared-two' };
  expect(taskSetupOptions([template, connected, second])).toEqual([connected, second]);
});
