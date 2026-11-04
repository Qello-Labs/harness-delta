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
  const files = readdirSync(src, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => join(entry.parentPath, entry.name));
  const modules = files.filter(path => path.endsWith('.ts'))
    .map(path => ({ path: relative(root, path), text: readFileSync(path, 'utf8') }));
  const assets = files.filter(path => !path.endsWith('.ts')).map(path => relative(root, path));
  const unmapped = modules.filter(module => ranks[area(module.path)] === undefined).map(module => module.path);
  expect(unmapped).toEqual([]);
  expect(checkArchitecture(buildImportGraph(modules, assets), policy)).toEqual([]);
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

test.each([
  "import('./local-web-domain.js')",
  'import(`./local-web-domain.js`)',
])('literal dynamic dependency %s retains cycle and area checks', expression => {
  const modules = [
    { path: 'src/coverage.ts', text: `void ${expression};` },
    { path: 'src/local-web-domain.ts', text: "import './coverage.js';" },
  ];
  expect(checkArchitecture(buildImportGraph(modules), { ...policy, cycles: [], edges: [] })).toEqual([
    'New runtime cycle: src/coverage.ts -> src/local-web-domain.ts -> src/coverage.ts',
    'New area edge: runtime src/coverage.ts -> src/local-web-domain.ts',
  ]);
});

test.each([
  'import(target)',
  'import(`./${target}.js`)',
  "import(import.meta.resolve('./local-web-domain.js'))",
])('unresolved dynamic dependency %s fails with its source file', expression => {
  const modules = [
    { path: 'src/coverage.ts', text: `const target = './local-web-domain.js'; void ${expression};` },
    { path: 'src/local-web-domain.ts', text: "import './coverage.js';" },
  ];
  expect(() => checkArchitecture(buildImportGraph(modules), { ...policy, cycles: [], edges: [] }))
    .toThrow('Unresolved module dependency in src/coverage.ts');
});

test.each([
  "export * from './local-web-domain.js';",
  "export { value } from './local-web-domain.js';",
  "import dependency = require('./local-web-domain.js');",
])('static dependency %s retains cycle and area checks', text => {
  const modules = [
    { path: 'src/coverage.ts', text },
    { path: 'src/local-web-domain.ts', text: "import './coverage.js';" },
  ];
  expect(checkArchitecture(buildImportGraph(modules), { ...policy, cycles: [], edges: [] })).toEqual([
    'New runtime cycle: src/coverage.ts -> src/local-web-domain.ts -> src/coverage.ts',
    'New area edge: runtime src/coverage.ts -> src/local-web-domain.ts',
  ]);
});

test('import.meta.resolve alone does not load a runtime dependency', () => {
  const graph = buildImportGraph([
    { path: 'src/coverage.ts', text: "import.meta.resolve('./local-web-domain.js');" },
    { path: 'src/local-web-domain.ts', text: "import './coverage.js';" },
  ]);
  expect(graph).toEqual([runtime('src/local-web-domain.ts', 'src/coverage.ts')]);
});

test.each(['require', 'createRequire'].flatMap(identifier => [
  [identifier, `(${identifier})(target);`],
  [identifier, `const load = ${identifier};`],
  [identifier, `${identifier}('./x');`],
  [identifier, `module.${identifier};`],
  [identifier, `const ${identifier} = 1;`],
  [identifier, `type Loader = { ${identifier}: unknown };`],
  [identifier, `import { ${identifier} as load } from 'node:module';`],
] as const))('forbids loader identifier %s in %s', (identifier, text) => {
  expect(() => buildImportGraph([{ path: 'src/coverage.ts', text }]))
    .toThrow(`Unsupported loader identifier in src/coverage.ts: ${identifier}`);
});

test('loader names in comments and strings are not identifiers', () => {
  const graph = buildImportGraph([{
    path: 'core/a.ts',
    text: '// require createRequire\nconst value = "require createRequire";\nconst object = { "require": `createRequire` };',
  }]);
  expect(graph).toEqual([]);
});

test.each([
  ["import './b';", './b'],
  ["import './missing.js';", './missing.js'],
  ["import type { B } from './missing.js';", './missing.js'],
  ["export * from './missing.js';", './missing.js'],
  ["export type { B } from './missing.js';", './missing.js'],
  ["type B = import('./missing.js').B;", './missing.js'],
  ["import B = require('./missing.js');", './missing.js'],
  ["void import('./missing.js');", './missing.js'],
  ["import data from './missing.json' with { type: 'json' };", './missing.json'],
])('rejects unknown relative specifier in %s', (text, specifier) => {
  expect(() => buildImportGraph([
    { path: 'core/a.ts', text },
    { path: 'core/b.ts', text: '' },
  ])).toThrow(`Unresolved relative dependency in core/a.ts: ${specifier}`);
});

test('known JSON assets remain allowed without becoming graph modules', () => {
  const graph = buildImportGraph([{
    path: 'core/a.ts', text: "import data from './data.json' with { type: 'json' };",
  }], ['core/data.json']);
  expect(graph).toEqual([]);
});
