import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, test } from 'vitest';
import { promotedInputs } from '../scripts/tool-update/fixtures.mjs';

test.each([
  ['config-confirmation', 'core/configuration-evidence'],
  ['comparison/reports/ordinary-window', 'pricing/metrics-ordinary-window'],
  ['comparison/reports/ordinary-window-state', 'core/ordinary-window-evidence'],
  ['harness/harness-managed-file', 'workflow/external-session-managed-file'],
  ['qualification/codex-failure-diagnostics', 'workflow/bounded-candidate-diagnostics'],
  ['pricing/price-revaluation', 'comparison/reports/price-revaluation'],
  ['adapters', 'sources/adapters'],
  ['adapters-flexible', 'sources/adapters-flexible'],
  ['agent-metadata', 'sources/agent-metadata'],
  ['cache-write-ttl', 'sources/cache-write-ttl'],
  ['collection', 'sources/collection'],
  ['managed-journal', 'sources/managed-journal'],
  ['otel-journal', 'sources/otel-journal'],
  ['catalog-cost-report', 'pricing/catalog-cost-report'],
  ['observed-cost-report', 'pricing/observed-cost-report'],
  ['price-catalog-selection', 'pricing/price-catalog-selection'],
  ['price-catalog-store', 'pricing/price-catalog-store'],
  ['pricing', 'pricing/pricing'],
  ['metrics', 'pricing/metrics'],
  ['report-source-trust', 'pricing/report-source-trust'],
  ['binding-child-readiness', 'binding/binding-child-readiness'],
  ['binding-family-diagnostics', 'binding/binding-family-diagnostics'],
  ['session-binding-human-pilot', 'binding/session-binding-human-pilot'],
  ['session-binding-claude-human-pilot', 'binding/session-binding-claude-human-pilot'],
  ['session-binding-qualification-lease', 'binding/session-binding-qualification-lease'],
  ['codex-candidate-permissions', 'workflow/codex-candidate-permissions'],
  ['codex-continuation', 'workflow/codex-continuation'],
  ['codex-workflow-journal', 'workflow/codex-workflow-journal'],
  ['external-session-context', 'workflow/external-session-context'],
  ['external-session-service', 'workflow/external-session-service'],
  ['external-session-workflow', 'workflow/external-session-workflow'],
  ['task-workflow', 'workflow/task-workflow'],
  ['claude-native-probe', 'qualification/claude-native-probe'],
  ['claude-probe-supervisor', 'qualification/claude-probe-supervisor'],
  ['claude-trace-candidate', 'qualification/claude-trace-candidate'],
  ['comparison', 'comparison/comparison'],
  ['harness-application', 'harness/harness-application'],
  ['external-session-contract', 'core/external-session-contract'],
  ['lifecycle', 'core/lifecycle'],
  ['runtime-history', 'core/runtime-history'],
  ['source-errors', 'core/source-errors']
])('rebuilding removes retired %s outputs without deleting current modules', (retired, current) => {
  const root = mkdtempSync(join(tmpdir(), 'copy-assets-synthetic-'));
  const put = (path: string, bytes: string) => {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  };
  try {
    put('scripts/copy-assets.mjs', readFileSync(new URL('../scripts/copy-assets.mjs', import.meta.url), 'utf8'));
    put('src/migrations/synthetic.sql', 'SELECT 1;');
    put('config/prices/catalogs/synthetic.json', '{}');
    put('skills/synthetic/SKILL.md', 'Synthetic asset');
    for (const path of ['SKILL.md', 'scripts/connect.mjs']) {
      put(`skills/harness-connect-window-codex/${path}`, readFileSync(new URL(`../skills/harness-connect-window-codex/${path}`, import.meta.url), 'utf8'));
    }
    put('scripts/session-binding-codex-hook.mjs', 'Synthetic recorder');
    const windowProducer = readFileSync(new URL('../scripts/session-binding-codex-window-hook.mjs', import.meta.url), 'utf8');
    put('scripts/session-binding-codex-window-hook.mjs', windowProducer);
    const promotedProducer = readFileSync(new URL('../scripts/session-binding-codex-promoted-hook.mjs', import.meta.url), 'utf8');
    put('scripts/session-binding-codex-promoted-hook.mjs', promotedProducer);
    for (const inputs of Object.values(promotedInputs)) {
      for (const member of inputs.members) {
        put(`${inputs.skill}/${member}`, readFileSync(new URL(`../${inputs.skill}/${member}`, import.meta.url), 'utf8'));
      }
    }
    put('scripts/generated/current-support.json', '{"schemaVersion":1}');
    put('dist/assets/session-binding-codex-hook.mjs', 'Stale recorder');
    put('dist/assets/session-binding-codex-window-hook.mjs', 'Stale window recorder');
    put('dist/assets/session-binding-codex-promoted-hook.mjs', 'Stale promoted recorder');
    put('dist/skills/harness-connect-window-codex/scripts/connect.mjs', 'Stale window helper');
    put('dist/assets/current-support.json', 'Stale support data');
    put('dist/flexible-candidates.json', 'Retired candidate data');
    for (const extension of ['js', 'js.map', 'd.ts', 'd.ts.map']) {
      put(`dist/${retired}.${extension}`, 'Retired output');
      put(`dist/${current}.${extension}`, 'Current output');
    }
    execFileSync(process.execPath, [join(root, 'scripts/copy-assets.mjs')], { stdio: 'pipe' });
    for (const extension of ['js', 'js.map', 'd.ts', 'd.ts.map']) {
      expect(existsSync(join(root, `dist/${retired}.${extension}`))).toBe(false);
      expect(readFileSync(join(root, `dist/${current}.${extension}`), 'utf8')).toBe('Current output');
    }
    expect(readFileSync(join(root, 'dist/migrations/synthetic.sql'), 'utf8')).toBe('SELECT 1;');
    expect(existsSync(join(root, 'dist/flexible-candidates.json'))).toBe(false);
    expect(readFileSync(join(root, 'dist/assets/session-binding-codex-hook.mjs'), 'utf8')).toBe('Synthetic recorder');
    expect(readFileSync(join(root, 'dist/assets/session-binding-codex-window-hook.mjs'), 'utf8')).toBe(windowProducer);
    expect(readFileSync(join(root, 'dist/assets/session-binding-codex-promoted-hook.mjs'), 'utf8')).toBe(promotedProducer);
    for (const inputs of Object.values(promotedInputs)) {
      for (const member of inputs.members) {
        expect(readFileSync(join(root, inputs.builtSkill, member))).toEqual(readFileSync(new URL(`../${inputs.skill}/${member}`, import.meta.url)));
      }
    }
    for (const path of ['SKILL.md', 'scripts/connect.mjs']) {
      expect(readFileSync(join(root, `dist/skills/harness-connect-window-codex/${path}`))).toEqual(
        readFileSync(new URL(`../skills/harness-connect-window-codex/${path}`, import.meta.url))
      );
    }
    expect(readFileSync(join(root, 'dist/assets/current-support.json'), 'utf8')).toBe('{"schemaVersion":1}');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
