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
      .requiredOption('--source <file|codex_workflow|claude_workflow|codex_binding>').option('--profile <id>');
    if (operation === 'invalidate') command.option('--reason <semantic_incompatibility|contract_failed>', 'Fixed metadata-only reason', 'semantic_incompatibility');
    command.action((options: { product: string; version: string; source: string; profile?: string; reason?: string }) => {
      const source = SourceCompatibilitySchema.shape.source.parse(options.source);
      const selected = resolveSourceCompatibility(options.product, options.version, source, options.profile);
      if (!selected) throw new Error('unsupported');
      if (operation === 'invalidate') invalidateCompatibility(db(), selected,
        z.enum(['semantic_incompatibility', 'contract_failed']).parse(options.reason));
      print(effectiveSourceCompatibility(db(), selected));
    });
  }
}
