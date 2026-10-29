import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, lstat, realpath, mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { digest, fail, ToolUpdateError } from './manifest.mjs';
import { scopeSourceDigests } from './lanes.mjs';

export const assessmentRuleRevision = 'static-assessment-v1';
const modules = [
  'adapter-profiles', 'codex-rollout-policy', 'source-compatibility', 'contracts', 'readiness',
  'comparison-contracts', 'flexible-contracts', 'cost-coverage', 'report-source-trust-contracts',
  'codex-binding-admission', 'claude-binding-admission', 'claude-workflow-versions',
];
const scopePaths = Object.keys(scopeSourceDigests);
export const sourcePathAllowlist = Object.freeze([
  ...new Set([...modules.map(name => `src/${name}.ts`), 'src/codex-admissions.json', ...scopePaths]),
  'package.json', 'package-lock.json',
].sort());
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

/** Only the finite static registry closure is loaded; Store is a stripped type import. */
export async function withSourceSnapshot(root, project) {
  let temporary;
  try {
    const base = await realpath(resolve(root));
    const inputs = new Map();
    let total = 0;
    const take = async path => {
      if (!sourcePathAllowlist.includes(path)) fail('source_snapshot_unavailable');
      const full = join(base, path);
      const stat = await lstat(full);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024 || await realpath(full) !== full)
        fail('source_snapshot_unavailable');
      const bytes = await readFile(full);
      total += bytes.length;
      if (total > 16 * 1024 * 1024) fail('source_snapshot_unavailable');
      inputs.set(path, bytes);
      return bytes.toString('utf8');
    };
    const metadata = JSON.parse(await take('package.json'));
    const lock = JSON.parse(await take('package-lock.json'));
    if (metadata.type !== 'module' || lock.lockfileVersion !== 3 || !lock.packages?.[''])
      fail('source_snapshot_unavailable');
    const dependencies = { ...metadata.dependencies, ...metadata.devDependencies };
    const lockedRoot = lock.packages[''];
    if (digest(metadata.dependencies) !== digest(lockedRoot.dependencies) ||
        digest(metadata.devDependencies) !== digest(lockedRoot.devDependencies)) fail('source_snapshot_unavailable');
    const installed = new Map();
    for (const [name, version] of Object.entries(dependencies)) {
      if (!/^(?:@[a-z0-9-]+\/)?[a-z0-9.-]+$/.test(name) || !/^\d+\.\d+\.\d+$/.test(version))
        fail('source_snapshot_unavailable');
      const path = join(base, 'node_modules', name, 'package.json');
      const bytes = await readFile(path);
      const packageMetadata = JSON.parse(bytes.toString('utf8'));
      if (packageMetadata.name !== name || packageMetadata.version !== version ||
          lock.packages[`node_modules/${name}`]?.version !== version) fail('source_snapshot_unavailable');
      installed.set(path, bytes);
    }
    const require = createRequire(join(base, 'package.json'));
    const ts = require('typescript');
    if (ts.version !== dependencies.typescript) fail('source_snapshot_unavailable');
    temporary = await mkdtemp(join(await realpath(tmpdir()), 'harness-tool-update-'));
    await writeFile(join(temporary, 'package.json'), '{"type":"module"}', { mode: 0o600 });
    await symlink(join(base, 'node_modules'), join(temporary, 'node_modules'), 'dir');
    await mkdir(join(temporary, 'src'), { mode: 0o700 });
    const pending = ['src/source-compatibility.ts', 'src/claude-workflow-versions.ts'];
    const compiled = new Set();
    while (pending.length) {
      const path = pending.pop();
      if (compiled.has(path)) continue;
      if (compiled.size >= 32) fail('source_snapshot_unavailable');
      compiled.add(path);
      const text = await take(path);
      if (path.endsWith('.json')) {
        JSON.parse(text);
        await writeFile(join(temporary, path), text, { mode: 0o600 });
        continue;
      }
      const result = ts.transpileModule(text, { fileName: path, reportDiagnostics: true, compilerOptions: {
        target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext, verbatimModuleSyntax: true,
      } });
      if (result.diagnostics?.some(d => d.category === ts.DiagnosticCategory.Error)) fail('source_snapshot_unavailable');
      const output = result.outputText;
      const parsed = ts.createSourceFile(path, output, ts.ScriptTarget.ES2023, true, ts.ScriptKind.JS);
      const visit = node => {
        if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
            ts.isIdentifier(node.expression) && node.expression.text === 'require')) fail('source_snapshot_unavailable');
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) && node.moduleSpecifier) {
          if (!ts.isStringLiteral(node.moduleSpecifier)) fail('source_snapshot_unavailable');
          const specifier = node.moduleSpecifier.text;
          if (specifier.startsWith('./')) {
            const child = `src/${specifier.slice(2).replace(/\.js$/, '.ts')}`;
            if (!sourcePathAllowlist.includes(child)) fail('source_snapshot_unavailable');
            pending.push(child);
          } else if (specifier === 'node:fs') {
            const bindings = node.importClause?.namedBindings;
            if (node.importClause?.name || !bindings || !ts.isNamedImports(bindings) ||
              bindings.elements.some(item => (item.propertyName ?? item.name).text !== 'realpathSync'))
              fail('source_snapshot_unavailable');
          } else if (!['zod', 'node:crypto', 'node:path'].includes(specifier)) fail('source_snapshot_unavailable');
        }
        ts.forEachChild(node, visit);
      };
      visit(parsed);
      await writeFile(join(temporary, path.replace(/\.ts$/, '.js')), output, { mode: 0o600 });
    }
    for (const path of scopePaths) {
      const text = await take(path);
      if (hash(Buffer.from(text)) !== scopeSourceDigests[path]) fail('source_scope_changed');
    }
    const load = name => import(pathToFileURL(join(temporary, `src/${name}.js`)).href);
    const [compatibility, profiles, readiness, codex, claude] = await Promise.all([
      load('source-compatibility'), load('adapter-profiles'), load('readiness'),
      load('codex-binding-admission'), load('claude-binding-admission'),
    ]);
    const value = await project({
      resolve: compatibility.resolveSourceCompatibility, ruleRevision: compatibility.compatibilityRuleRevision,
      windows: compatibility.sourceCompatibilityWindows, files: profiles.registeredFileProfiles,
      evidence: readiness.productionSourceEvidence, codexAdmissions: codex.codexBindingAdmissions,
      claudeAdmissions: claude.claudeBindingAdmissions,
    });
    for (const [path, bytes] of inputs)
      if (!bytes.equals(await readFile(join(base, path)))) fail('source_drift');
    for (const [path, bytes] of installed)
      if (!bytes.equals(await readFile(path))) fail('source_drift');
    return {
      source_digest: digest({ rule_revision: assessmentRuleRevision, compiler: ts.version,
        files: [...inputs].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([path, bytes]) => ({ path, digest: hash(bytes) })),
        dependencies: [...installed.values()].map(bytes => hash(bytes)).sort() }),
      source_paths: [...inputs.keys()].sort(), value,
    };
  } catch (error) {
    if (error instanceof ToolUpdateError) throw error;
    fail('source_snapshot_unavailable');
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}
