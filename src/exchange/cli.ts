import { createTeamSnapshot, readTeamSnapshot } from '../reports/team-snapshot.js';
import { renderTeamReport } from '../reports/team-render.js';
import { registerExchangeMapping } from './mapping.js';
import { importExchangePackage } from './import.js';
import { deleteImportedTask, configureImportedRetention, applyImportedRetention } from './retention.js';
import type { Command } from 'commander';
import type { Store } from '../store.js';
import { registerExchangeSource, buildExchangePackage } from './source.js';
import { readExchangeFile, publishExchangeFile } from './files.js';

const codes = new Set([
  'invalid_snapshot_request',
  'invalid_snapshot',
  'invalidated_report',
  'report_conflict',
  'unknown_report',
  'invalid_report_id',
  'missing_exchange_data',
  'snapshot_as_of_unavailable',
  'invalid_format',
  'invalid_exchange_package',
  'unsupported_exchange_version',
  'exchange_limit_exceeded',
  'unknown_mapping',
  'mapping_conflict',
  'source_scope_not_empty',
  'identity_sealed',
  'unknown_imported_task',
  'retention_not_configured',
  'authority_conflict',
  'protocol_conflict',
  'identity_conflict',
  'assignment_conflict',
  'evidence_conflict',
  'package_conflict',
  'stale_revision',
  'deleted_identifier',
  'retired_namespace',
  'cutoff_mismatch',
  'revision_overflow',
  'exchange_io_error',
  'export_invalidated',
  'real_experiment_disabled'
]);
export class ExchangeCliError extends Error {}
export function exchangeAction(action: () => void): void {
  try {
    action();
  } catch (e) {
    throw new ExchangeCliError(e instanceof Error && codes.has(e.message) ? e.message : 'exchange_io_error');
  }
}
export function registerExchangeCommands(program: Command, store: () => Store, print: (value: unknown) => void): void {
  const exchange = program.command('exchange').description('Explicit synthetic metadata file exchange');
  exchange
    .command('source')
    .command('register')
    .requiredOption('--config <file>')
    .action((o: { config: string }) =>
      exchangeAction(() => {
        registerExchangeSource(store(), readExchangeFile(o.config));
        print({ status: 'registered' });
      })
    );
  exchange
    .command('export')
    .requiredOption('--protocol <id>')
    .requiredOption('--snapshot <id>')
    .requiredOption('--id <uuid>')
    .requiredOption('--out <file>')
    .action((o: { protocol: string; snapshot: string; id: string; out: string }) =>
      exchangeAction(() => {
        const pkg = buildExchangePackage(store(), { kind: 'assignment_metadata', protocolId: o.protocol, snapshotId: o.snapshot, packageId: o.id });
        publishExchangeFile(o.out, pkg);
        print({ status: 'exported', package_id: pkg.package_id, export_revision: pkg.export_revision });
      })
    );
  exchange
    .command('export-deletions')
    .requiredOption('--namespace <uuid>')
    .requiredOption('--id <uuid>')
    .requiredOption('--out <file>')
    .action((o: { namespace: string; id: string; out: string }) =>
      exchangeAction(() => {
        const pkg = buildExchangePackage(store(), { kind: 'deletion_metadata', namespaceId: o.namespace, packageId: o.id });
        publishExchangeFile(o.out, pkg);
        print({ status: 'exported', package_id: pkg.package_id, export_revision: pkg.export_revision });
      })
    );
  exchange
    .command('mapping')
    .command('register')
    .requiredOption('--config <file>')
    .action((o: { config: string }) =>
      exchangeAction(() => {
        registerExchangeMapping(store(), readExchangeFile(o.config));
        print({ status: 'registered' });
      })
    );
  exchange
    .command('import')
    .requiredOption('--file <file>')
    .requiredOption('--project <id>')
    .action((o: { file: string; project: string }) =>
      exchangeAction(() => {
        const receipt = importExchangePackage(store(), readExchangeFile(o.file), o.project);
        print(receipt);
        if (receipt.reason) throw new ExchangeCliError(receipt.reason);
      })
    );
  exchange
    .command('delete-task')
    .requiredOption('--project <id>')
    .requiredOption('--shared-project <uuid>')
    .requiredOption('--task <id>')
    .action((o: { project: string; sharedProject: string; task: string }) =>
      exchangeAction(() => print(deleteImportedTask(store(), { local_project_id: o.project, shared_project_id: o.sharedProject, task_id: o.task })))
    );
  const retention = exchange.command('retention');
  retention
    .command('set')
    .requiredOption('--project <id>')
    .requiredOption('--shared-project <uuid>')
    .requiredOption('--days <integer>')
    .action((o: { project: string; sharedProject: string; days: string }) =>
      exchangeAction(() => {
        configureImportedRetention(store(), { local_project_id: o.project, shared_project_id: o.sharedProject, days: Number(o.days) });
        print({ status: 'configured' });
      })
    );
  retention
    .command('apply')
    .requiredOption('--project <id>')
    .requiredOption('--shared-project <uuid>')
    .action((o: { project: string; sharedProject: string }) =>
      exchangeAction(() => print(applyImportedRetention(store(), { local_project_id: o.project, shared_project_id: o.sharedProject })))
    );

  const team = program.command('team').description('Frozen synthetic imported-team descriptions');
  team
    .command('snapshot')
    .command('create')
    .requiredOption('--config <file>')
    .action((o: { config: string }) =>
      exchangeAction(() => {
        const report = createTeamSnapshot(store(), readExchangeFile(o.config));
        print({ status: 'created', snapshot_id: report.snapshot_id, snapshot_hash: report.snapshot_hash });
      })
    );
  team
    .command('report')
    .argument('<snapshot-id>')
    .option('--format <format>', 'json, markdown or markdown-readable', 'json')
    .action((id: string, o: { format: string }) =>
      exchangeAction(() => {
        process.stdout.write(renderTeamReport(readTeamSnapshot(store(), id), o.format));
      })
    );
}
