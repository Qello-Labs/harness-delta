import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { area, ranks } from './helpers/architecture-areas.js';
import { frozenCycles, frozenEdges } from './helpers/architecture-baseline.js';
import { buildImportGraph, checkArchitecture } from './helpers/architecture-graph.js';
import type { ArchitecturePolicy, ImportEdge } from './helpers/architecture-graph.js';

const policy: ArchitecturePolicy = {
  area, ranks, cycles: frozenCycles, edges: frozenEdges,
};
const syntheticPolicy: ArchitecturePolicy = {
  area: path => path.split('/')[0] ?? '',
  ranks: { core: 0, feature: 1, peer: 1 },
  cycles: [], edges: [],
};
const runtime = (from: string, to: string): ImportEdge => ({ from, to, typeOnly: false });

test('source imports introduce no cycles or area violations and frozen lists stay current', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const src = join(root, 'src');
  const modules = readdirSync(src, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.ts'))
    .map(entry => {
      const path = join(entry.parentPath, entry.name);
      return { path: relative(root, path), text: readFileSync(path, 'utf8') };
    });
  const unmapped = modules.filter(module => ranks[area(module.path)] === undefined).map(module => module.path);
  expect(unmapped).toEqual([]);
  expect(checkArchitecture(buildImportGraph(modules), policy)).toEqual([]);
});

test('a new runtime cycle fails even within an already cyclic component', () => {
  const edges = [runtime('core/a.ts', 'core/b.ts'), runtime('core/b.ts', 'core/a.ts'),
    runtime('core/b.ts', 'core/c.ts'), runtime('core/c.ts', 'core/a.ts')];
  expect(checkArchitecture(edges, {
    ...syntheticPolicy, cycles: ['core/a.ts -> core/b.ts -> core/a.ts'],
  })).toEqual(['New runtime cycle: core/a.ts -> core/b.ts -> core/c.ts -> core/a.ts']);
});

test.each(['feature', 'peer'])('a new upward or sideways edge to %s fails', target => {
  const from = target === 'peer' ? 'feature/a.ts' : 'core/a.ts';
  expect(checkArchitecture([runtime(from, `${target}/b.ts`)], syntheticPolicy))
    .toEqual([`New area edge: runtime ${from} -> ${target}/b.ts`]);
});

test('removed violations require deleting their frozen entries', () => {
  expect(checkArchitecture([], {
    ...syntheticPolicy, cycles: ['core/a.ts -> core/a.ts'],
    edges: ['runtime core/a.ts -> feature/b.ts'],
  })).toEqual([
    'Delete stale frozen runtime cycle: core/a.ts -> core/a.ts',
    'Delete stale frozen area edge: runtime core/a.ts -> feature/b.ts',
  ]);
});

test('type-only imports and exports do not create runtime cycles', () => {
  const graph = buildImportGraph([
    { path: 'core/a.ts', text: "import type { B } from './b.js'; export type { C } from './c.js';" },
    { path: 'core/b.ts', text: "import type { A } from './a.js';" },
    { path: 'core/c.ts', text: "export type { A } from './a.js'; type B = import('./b.js').B;" },
  ]);
  expect(graph).toHaveLength(5);
  expect(graph.every(edge => edge.typeOnly)).toBe(true);
  expect(checkArchitecture(graph, syntheticPolicy)).toEqual([]);
});

test.each(['import', 'export'])('inline type-only %s specifiers retain runtime dependencies', declaration => {
  const graph = buildImportGraph([
    { path: 'core/a.ts', text: `${declaration} { type B } from './b.js';` },
    { path: 'core/b.ts', text: "import './a.js';" },
  ]);
  expect(graph.map(edge => edge.typeOnly)).toEqual([false, false]);
  expect(checkArchitecture(graph, syntheticPolicy))
    .toEqual(['New runtime cycle: core/a.ts -> core/b.ts -> core/a.ts']);
});

test('type-only upward edges are tracked separately and cannot become runtime edges', () => {
  const edge = { from: 'core/a.ts', to: 'feature/b.ts', typeOnly: true };
  const frozen = { ...syntheticPolicy, edges: ['type core/a.ts -> feature/b.ts'] };
  expect(checkArchitecture([edge], frozen)).toEqual([]);
  expect(checkArchitecture([{ ...edge, typeOnly: false }], frozen)).toEqual([
    'New area edge: runtime core/a.ts -> feature/b.ts',
    'Delete stale frozen area edge: type core/a.ts -> feature/b.ts',
  ]);
});

test('mixed imports, side effects, dynamic imports and repeated targets retain runtime edges', () => {
  const graph = buildImportGraph([
    { path: 'core/a.ts', text: "import type { B } from './b.js'; import { type T, B } from './b.js'; import './c.js'; void import('./d.js'); export * from './e.js';" },
    ...['b', 'c', 'd', 'e'].map(name => ({ path: `core/${name}.ts`, text: '' })),
  ]);
  expect(graph.map(edge => [edge.to, edge.typeOnly])).toEqual([
    ['core/b.ts', false], ['core/c.ts', false], ['core/d.ts', false], ['core/e.ts', false],
  ]);
});
