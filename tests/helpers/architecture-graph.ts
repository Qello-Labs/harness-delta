import { dirname, join, normalize } from 'node:path';
import ts from 'typescript';

export interface SourceModule {
  readonly path: string;
  readonly text: string;
}

export interface ImportEdge {
  readonly from: string;
  readonly to: string;
  readonly typeOnly: boolean;
}

export interface ArchitecturePolicy {
  readonly area: (path: string) => string;
  readonly ranks: Readonly<Record<string, number>>;
  readonly cycles: readonly string[];
  readonly edges: readonly string[];
}

export function buildImportGraph(modules: readonly SourceModule[], knownAssets: readonly string[] = []): readonly ImportEdge[] {
  const paths = new Set(modules.map(module => module.path));
  const assets = new Set(knownAssets);
  const edges = new Map<string, ImportEdge>();
  for (const module of modules) {
    const source = ts.createSourceFile(module.path, module.text, ts.ScriptTarget.Latest, true);
    const add = (specifier: ts.Node | undefined, typeOnly: boolean): void => {
      if (!specifier || !ts.isStringLiteralLike(specifier) || !specifier.text.startsWith('.')) return;
      const target = normalize(join(dirname(module.path), specifier.text));
      if (assets.has(target)) return;
      if (typeOnly && assets.has(target.replace(/\.mjs$/, '.d.mts'))) {
        return;
      }
      const path = target.replace(/\.js$/, '.ts');
      if (!paths.has(path)) {
        throw new Error(`Unresolved relative dependency in ${module.path}: ${specifier.text}`);
      }
      const key = `${module.path} -> ${path}`;
      const previous = edges.get(key);
      edges.set(key, {
        from: module.path,
        to: path,
        typeOnly: typeOnly && (previous?.typeOnly ?? true)
      });
    };
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && (node.text === 'require' || node.text === 'createRequire')) {
        throw new Error(`Unsupported loader identifier in ${module.path}: ${node.text}`);
      }
      if (ts.isImportDeclaration(node)) {
        // Inline type specifiers retain import/export {} under verbatimModuleSyntax.
        add(node.moduleSpecifier, node.importClause?.isTypeOnly ?? false);
      } else if (ts.isExportDeclaration(node)) {
        add(node.moduleSpecifier, node.isTypeOnly);
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const specifier = node.arguments[0];
        if (!specifier || !ts.isStringLiteralLike(specifier)) {
          throw new Error(`Unresolved module dependency in ${module.path}`);
        }
        add(specifier, false);
      } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
        add(node.argument.literal, true);
      } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
        add(node.moduleReference.expression, node.isTypeOnly);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return [...edges.values()];
}

export function runtimeCycles(edges: readonly ImportEdge[]): readonly string[] {
  const outgoing = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.typeOnly) continue;
    const targets = outgoing.get(edge.from) ?? new Set<string>();
    targets.add(edge.to);
    outgoing.set(edge.from, targets);
  }
  const cycles: string[] = [];
  for (const start of [...outgoing.keys()].sort()) {
    const visit = (node: string, trail: readonly string[]): void => {
      for (const target of outgoing.get(node) ?? []) {
        if (target === start) cycles.push([...trail, start].join(' -> '));
        else if (target > start && !trail.includes(target)) visit(target, [...trail, target]);
      }
    };
    visit(start, [start]);
  }
  return cycles.sort();
}

export function areaViolations(edges: readonly ImportEdge[], policy: ArchitecturePolicy): readonly string[] {
  return edges
    .filter(edge => {
      const from = policy.area(edge.from);
      const to = policy.area(edge.to);
      const fromRank = policy.ranks[from];
      const toRank = policy.ranks[to];
      return from !== to && fromRank !== undefined && toRank !== undefined && fromRank <= toRank;
    })
    .map(edge => `${edge.typeOnly ? 'type' : 'runtime'} ${edge.from} -> ${edge.to}`)
    .sort();
}

export function checkArchitecture(edges: readonly ImportEdge[], policy: ArchitecturePolicy): readonly string[] {
  const failures: string[] = [];
  for (const path of new Set(edges.flatMap(edge => [edge.from, edge.to]))) {
    if (policy.ranks[policy.area(path)] === undefined) failures.push(`Unmapped module: ${path}`);
  }
  for (const [label, actual, frozen] of [
    ['runtime cycle', runtimeCycles(edges), policy.cycles],
    ['area edge', areaViolations(edges, policy), policy.edges]
  ] as const) {
    for (const entry of actual) {
      if (!frozen.includes(entry)) failures.push(`New ${label}: ${entry}`);
    }
    for (const entry of frozen) {
      if (!actual.includes(entry)) failures.push(`Delete stale frozen ${label}: ${entry}`);
    }
  }
  return failures;
}
