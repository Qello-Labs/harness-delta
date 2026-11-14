import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { digest, fail, ToolUpdateError } from './manifest.mjs';
import { scopeSourceDigests } from './lanes.mjs';

export const legacyAssessmentRuleRevision = 'static-assessment-v1';
export const expandedAssessmentRuleRevision = 'static-assessment-v2';
export const policyAssessmentRuleRevision = 'static-assessment-v3';
export const projectionAssessmentRuleRevision = 'static-assessment-v4';
export const producerAssessmentRuleRevision = 'static-assessment-v5';
export const denialAssessmentRuleRevision = 'static-assessment-v6';
export const assessmentRuleRevision = 'static-assessment-v7';
export const denialAssessmentSourcePathLimit = 87;
export const producerAssessmentSourcePathLimit = 82;
export const projectionAssessmentSourcePathLimit = 55;
export const policyAssessmentSourcePathLimit = 52;
export const expandedAssessmentSourcePathLimit = 48;
export const legacySourcePathAllowlist = Object.freeze([
  'package-lock.json',
  'package.json',
  'src/adapter-profiles.ts',
  'src/claude-binding-admission.ts',
  'src/claude-workflow-adapter.ts',
  'src/claude-workflow-versions.ts',
  'src/codex-admissions.json',
  'src/codex-binding-admission.ts',
  'src/codex-candidate-rollout.ts',
  'src/codex-rollout-policy.ts',
  'src/codex-workflow-adapter.ts',
  'src/comparison-contracts.ts',
  'src/contracts.ts',
  'src/core/ordinary-window-policy.ts',
  'src/core/ordinary-window-store.ts',
  'src/core/tool-version-identities.json',
  'src/core/tool-version-profiles.json',
  'src/core/tool-version-profiles.ts',
  'src/core/tool-version-recipes.json',
  'src/cost-coverage.ts',
  'src/flexible-contracts.ts',
  'src/nested-candidate.ts',
  'src/ordinary-session-binding.ts',
  'src/ordinary-window-binding.ts',
  'src/readiness.ts',
  'src/report-source-trust-contracts.ts',
  'src/session-binding-claude.ts',
  'src/session-binding-codex.ts',
  'src/session-binding-contract.ts',
  'src/session-binding-service.ts',
  'src/source-compatibility.ts'
]);
const modules = [
  'adapter-profiles',
  'codex-rollout-policy',
  'source-compatibility',
  'contracts',
  'readiness',
  'comparison-contracts',
  'flexible-contracts',
  'cost-coverage',
  'report-source-trust-contracts',
  'codex-binding-admission',
  'claude-binding-admission',
  'claude-workflow-versions',
  'core/tool-version-profiles',
  'core/ordinary-window-policy'
];
const scopePaths = Object.keys(scopeSourceDigests);
const expandedHashOnlyPaths = [
  'src/claude-process-binary.ts',
  'src/nested-candidate.ts',
  'src/codex-candidate-rollout.ts',
  'src/core/ordinary-window-store.ts',
  'src/ordinary-window-binding.ts',
  'src/ordinary-observation.ts',
  'src/store.ts',
  'src/migrations/036_ordinary_window_observation.sql',
  'src/migrations/037_ordinary_window_decisions.sql',
  'src/cli/source-compatibility-cli.ts',
  'src/cli/ordinary-window-activation-cli.ts',
  'src/core/ordinary-window-decision.ts',
  'src/core/ordinary-window-activation.ts',
  'src/core/ordinary-window-trial.ts',
  'src/ordinary-window-emission.ts',
  'src/core/ordinary-window-evidence.ts',
  'src/pricing/metrics-ordinary-window.ts',
  'scripts/session-binding-codex-window-hook.mjs',
  'src/connect/codex-connect-installation.ts',
  'skills/harness-connect-window-codex/SKILL.md',
  'skills/harness-connect-window-codex/scripts/connect.mjs'
];
const policyHashOnlyPaths = [
  ...expandedHashOnlyPaths,
  'src/connect/claude-connect-installation.ts',
  'skills/harness-connect-window-claude/SKILL.md',
  'skills/harness-connect-window-claude/scripts/connect.mjs',
  'skills/harness-connect-window-claude/scripts/claude-session-hook.mjs'
];
const promotedHashOnlyPaths = [
  'skills/harness-connect/SKILL.md',
  'skills/harness-connect/agents/openai.yaml',
  'skills/harness-connect/references/support.md',
  'skills/harness-connect/scripts/claude-session-hook.mjs',
  'skills/harness-connect/scripts/connect.mjs',
  'skills/harness-connect/tests/current.mjs',
  'skills/harness-connect/tests/package.mjs',
  'skills/harness-connect/tests/transport.mjs',
  'skills/harness-connect/tests/verify.mjs',
  'scripts/session-binding-codex-hook.mjs',
  'scripts/session-binding-codex-hook.template.mjs',
  'scripts/tool-update/promotion-implementation.mjs',
  'scripts/session-binding-codex-promoted-hook.template.mjs',
  'scripts/session-binding-codex-promoted-hook.mjs',
  'skills/harness-connect-promoted-codex/SKILL.md',
  'skills/harness-connect-promoted-codex/scripts/connect.mjs',
  'skills/harness-connect-promoted-claude/SKILL.md',
  'skills/harness-connect-promoted-claude/scripts/connect.mjs',
  'skills/harness-connect-promoted-claude/scripts/claude-session-hook.mjs',
  'scripts/tool-update/promotion-execution-pins.mjs',
  'scripts/tool-update/promotion-execution-pins.d.mts',
  'scripts/tool-update/fixtures.mjs',
  'scripts/tool-update/fixtures.d.mts',
  'scripts/generate-tool-version-assets.mjs',
  'scripts/copy-assets.mjs',
  'src/core/repository-files.ts',
  'src/package-paths.ts'
];
const denialHashOnlyPaths = [
  'src/deletion.ts',
  'src/migrations/038_tool_version_promotion_denials.sql',
  'src/web/local-web-binding-providers.ts',
  'src/web/local-web-support.ts'
];
const authorityHashOnlyPaths = ['src/binding/session-binding-promotion.ts'];
const hashOnlyPaths = [...policyHashOnlyPaths, ...promotedHashOnlyPaths, ...denialHashOnlyPaths, ...authorityHashOnlyPaths];
export const expandedSourcePathAllowlist = Object.freeze(
  [
    ...new Set([
      ...modules.map(name => `src/${name}.ts`),
      'src/codex-admissions.json',
      'src/core/tool-version-profiles.json',
      'src/core/tool-version-recipes.json',
      'src/core/tool-version-identities.json',
      ...scopePaths,
      ...expandedHashOnlyPaths
    ]),
    'package.json',
    'package-lock.json'
  ].sort()
);
export const policySourcePathAllowlist = Object.freeze([...new Set([...expandedSourcePathAllowlist, ...policyHashOnlyPaths])].sort());
export const projectionSourcePathAllowlist = Object.freeze(
  [
    ...policySourcePathAllowlist,
    'src/core/tool-version-promotion.ts',
    'src/core/tool-version-promotions.json',
    'src/core/tool-version-promotion-result.json'
  ].sort()
);
export const producerSourcePathAllowlist = Object.freeze([...projectionSourcePathAllowlist, ...promotedHashOnlyPaths].sort());
export const denialSourcePathAllowlist = Object.freeze(
  [...producerSourcePathAllowlist, ...denialHashOnlyPaths, 'src/core/tool-version-promotion-store.ts'].sort()
);
export const sourcePathAllowlist = Object.freeze([...denialSourcePathAllowlist, ...authorityHashOnlyPaths].sort());
export const assessmentSourcePathLimit = 88;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function snapshotImports(ts, path, output) {
  const pending = [];
  const parsed = ts.createSourceFile(path, output, ts.ScriptTarget.ES2023, true, ts.ScriptKind.JS);
  const visit = node => {
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      fail('source_snapshot_unavailable');
    }
    if (ts.isImportDeclaration(node) || (ts.isExportDeclaration(node) && node.moduleSpecifier)) {
      if (!ts.isStringLiteral(node.moduleSpecifier)) {
        fail('source_snapshot_unavailable');
      }
      const specifier = node.moduleSpecifier.text;
      if (specifier.startsWith('./') || specifier.startsWith('../')) {
        const child = posix.normalize(posix.join(posix.dirname(path), specifier)).replace(/\.js$/, '.ts');
        if (!child.startsWith('src/') || !sourcePathAllowlist.includes(child) || hashOnlyPaths.includes(child)) fail('source_snapshot_unavailable');
        pending.push(child);
      } else if (specifier === 'node:fs') {
        const bindings = node.importClause?.namedBindings;
        if (
          node.importClause?.name ||
          !bindings ||
          !ts.isNamedImports(bindings) ||
          bindings.elements.some(item => (item.propertyName ?? item.name).text !== 'realpathSync')
        ) {
          fail('source_snapshot_unavailable');
        }
      } else if (!['zod', 'node:crypto', 'node:path'].includes(specifier)) fail('source_snapshot_unavailable');
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return pending;
}

/** Only the finite static registry closure is loaded; Store is a stripped type import. */
export async function withSourceSnapshot(root, project) {
  let temporary;
  try {
    const base = await realpath(resolve(root));
    const inputs = new Map();
    let total = 0;
    const take = async path => {
      if (!sourcePathAllowlist.includes(path)) {
        fail('source_snapshot_unavailable');
      }
      const full = join(base, path);
      const stat = await lstat(full);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024 || (await realpath(full)) !== full) {
        fail('source_snapshot_unavailable');
      }
      const bytes = await readFile(full);
      total += bytes.length;
      if (total > 16 * 1024 * 1024) fail('source_snapshot_unavailable');
      const captured = inputs.get(path);
      if (captured && !captured.equals(bytes)) fail('source_drift');
      if (!captured) inputs.set(path, bytes);
      return bytes.toString('utf8');
    };
    const metadata = JSON.parse(await take('package.json'));
    const lock = JSON.parse(await take('package-lock.json'));
    if (metadata.type !== 'module' || lock.lockfileVersion !== 3 || !lock.packages?.['']) {
      fail('source_snapshot_unavailable');
    }
    const dependencies = {
      ...metadata.dependencies,
      ...metadata.devDependencies
    };
    const lockedRoot = lock.packages[''];
    if (digest(metadata.dependencies) !== digest(lockedRoot.dependencies) || digest(metadata.devDependencies) !== digest(lockedRoot.devDependencies)) {
      fail('source_snapshot_unavailable');
    }
    const installed = new Map();
    for (const [name, version] of Object.entries(dependencies)) {
      if (!/^(?:@[a-z0-9-]+\/)?[a-z0-9.-]+$/.test(name) || !/^\d+\.\d+\.\d+$/.test(version)) {
        fail('source_snapshot_unavailable');
      }
      const path = join(base, 'node_modules', name, 'package.json');
      const bytes = await readFile(path);
      const packageMetadata = JSON.parse(bytes.toString('utf8'));
      if (packageMetadata.name !== name || packageMetadata.version !== version || lock.packages[`node_modules/${name}`]?.version !== version) {
        fail('source_snapshot_unavailable');
      }
      installed.set(path, bytes);
    }
    const require = createRequire(join(base, 'package.json'));
    const ts = require('typescript');
    if (ts.version !== dependencies.typescript) {
      fail('source_snapshot_unavailable');
    }
    temporary = await mkdtemp(join(await realpath(tmpdir()), 'harness-tool-update-'));
    await writeFile(join(temporary, 'package.json'), '{"type":"module"}', {
      mode: 0o600
    });
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
      await mkdir(dirname(join(temporary, path)), {
        recursive: true,
        mode: 0o700
      });
      if (path.endsWith('.json')) {
        JSON.parse(text);
        await writeFile(join(temporary, path), text, { mode: 0o600 });
        continue;
      }
      const result = ts.transpileModule(text, {
        fileName: path,
        reportDiagnostics: true,
        compilerOptions: {
          target: ts.ScriptTarget.ES2023,
          module: ts.ModuleKind.ESNext,
          verbatimModuleSyntax: true
        }
      });
      if (result.diagnostics?.some(d => d.category === ts.DiagnosticCategory.Error)) fail('source_snapshot_unavailable');
      const output = result.outputText;
      pending.push(...snapshotImports(ts, path, output));
      await writeFile(join(temporary, path.replace(/\.ts$/, '.js')), output, { mode: 0o600 });
    }
    for (const path of hashOnlyPaths) await take(path);
    for (const path of scopePaths) {
      const text = await take(path);
      if (hash(Buffer.from(text)) !== scopeSourceDigests[path]) {
        fail('source_scope_changed');
      }
    }
    const load = name => import(pathToFileURL(join(temporary, `src/${name}.js`)).href);
    const [compatibility, profiles, readiness, codex, claude, core, ordinary] = await Promise.all([
      load('source-compatibility'),
      load('adapter-profiles'),
      load('readiness'),
      load('codex-binding-admission'),
      load('claude-binding-admission'),
      load('core/tool-version-profiles'),
      load('core/ordinary-window-policy')
    ]);
    const value = await project({
      resolve: compatibility.resolveSourceCompatibility,
      ruleRevision: compatibility.compatibilityRuleRevision,
      ordinaryWindows: ordinary.ordinaryWindowPolicies,
      resolveOrdinaryWindow: ordinary.resolveOrdinaryWindow,
      windows: compatibility.sourceCompatibilityWindows,
      files: profiles.registeredFileProfiles,
      evidence: readiness.productionSourceEvidence,
      promotionFacets: core.toolVersionPromotionProjection.facets,
      codexAdmissions: codex.codexBindingAdmissions,
      claudeAdmissions: claude.claudeBindingAdmissions,
      retiredClaudeWorkflowVersions: core.retiredClaudeWorkflowVersions
    });
    for (const [path, bytes] of inputs) {
      if (!bytes.equals(await readFile(join(base, path)))) {
        fail('source_drift');
      }
    }
    for (const [path, bytes] of installed) {
      if (!bytes.equals(await readFile(path))) fail('source_drift');
    }
    return {
      source_digest: digest({
        rule_revision: assessmentRuleRevision,
        compiler: ts.version,
        files: [...inputs].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([path, bytes]) => ({ path, digest: hash(bytes) })),
        dependencies: [...installed.values()].map(bytes => hash(bytes)).sort()
      }),
      source_paths: [...inputs.keys()].sort(),
      value
    };
  } catch (error) {
    if (error instanceof ToolUpdateError) throw error;
    fail('source_snapshot_unavailable');
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}
