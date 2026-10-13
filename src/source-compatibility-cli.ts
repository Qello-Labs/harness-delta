import { z } from 'zod';
import type { Command } from 'commander';
import { SourceCompatibilitySchema } from './contracts.js';
import { compatibilityRuleRevision, effectiveSourceCompatibility, invalidateCompatibility, resolveSourceCompatibility, sourceCompatibilityWindows } from './source-compatibility.js';
import type { Store } from './store.js';

export function registerCompatibilityCommands(program: Command, db: () => Store, print: (value: unknown) => void): void {
  const compatibility = program.command('compatibility').description('Source parser compatibility and local invalidation');
  compatibility.command('status').action(() => {
    print({ rule_revision: compatibilityRuleRevision, windows: sourceCompatibilityWindows,
      blocks: db().all('SELECT product,product_version,source,reason FROM source_compatibility_blocks ORDER BY product,product_version,source') });
  });
  for (const operation of ['inspect', 'invalidate'] as const) {
    const command = compatibility.command(operation).requiredOption('--product <codex|claude_code>').requiredOption('--version <version>')
      .requiredOption('--source <file|codex_workflow|claude_workflow>').option('--profile <id>');
    if (operation === 'invalidate') command.option('--reason <semantic_incompatibility|contract_failed>', 'Fixed metadata-only reason', 'semantic_incompatibility');
    command.action((options: { product: string; version: string; source: string; profile?: string; reason?: string }) => {
      const source = SourceCompatibilitySchema.shape.source.parse(options.source);
      let selected = resolveSourceCompatibility(options.product, options.version, source, options.profile);
      // A retired version no longer resolves, but a cohort that was already observed must stay blockable.
      if (!selected && operation === 'invalidate') {
        const stored = db().get<{ payload: string }>("SELECT payload FROM session_source_compatibility WHERE json_extract(payload,'$.product')=? AND json_extract(payload,'$.product_version')=? AND json_extract(payload,'$.source')=? LIMIT 1",
          [options.product, options.version, source]);
        if (stored) selected = SourceCompatibilitySchema.parse(JSON.parse(stored.payload) as unknown);
      }
      if (!selected) throw new Error('unsupported');
      if (operation === 'invalidate') invalidateCompatibility(db(), selected,
        z.enum(['semantic_incompatibility', 'contract_failed']).parse(options.reason));
      print(effectiveSourceCompatibility(db(), selected));
    });
  }
}
