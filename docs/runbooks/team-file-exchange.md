# Synthetic metadata file exchange

See [the exchange contract](../decisions/011-team-file-exchange.md) and
[task comparison](task-comparison.md). This is offline synthetic validation, not
real experiment activation or a complete-usage claim. Functional-pilot and live
team data are unsupported here. Build the checkout first; every command below
uses `node dist/cli.js` with an explicit database.

1. Register a project and freeze a complete synthetic protocol in a new dedicated
   store. Before tasks, register a source configuration file:

```json
{"schema_version":1,"namespace_id":"11111111-1111-4111-8111-111111111111","local_project_id":"project-1","shared_project_id":"22222222-2222-4222-8222-222222222222","protocol_id":"comparison-1","owned_strata":["stratum-1"]}
```

```sh
node dist/cli.js --db source.db exchange source register --config source.json
```

2. Use the existing synthetic comparison lifecycle and create a frozen snapshot.
   Then explicitly export it:

```sh
node dist/cli.js --db source.db exchange export --protocol comparison-1 --snapshot report-1 --id 33333333-3333-4333-8333-333333333333 --out package.json
```

Retain the same package UUID for retries. A conflicting existing output file is
never overwritten. First export seals identities; later alias extension fails
`identity_sealed`. A real identity conflict still invalidates the comparison.

3. After task/project deletion or source identity conflict, transmit a compact notice:

```sh
node dist/cli.js --db source.db exchange export-deletions --namespace 11111111-1111-4111-8111-111111111111 --id 44444444-4444-4444-8444-444444444444 --out deletion.json
```

This command works after project deletion. It does not remove earlier exported
files. No background delivery exists. Never clear tombstones or reuse a retired
namespace to recover an old package. Configure retention explicitly with the
existing source retention commands; there is no default period.

`source_scope_not_empty` means this version cannot onboard historical data.
`export_invalidated` requires using deletion-only export, not a new data package ID.
`invalid_exchange_package` rejects malformed/private/unknown fields without echoing
content. File/DB failures use fixed diagnostics; no raw private paths are printed.

Create the team report before applying deletion notices; retirement is irreversible.

## Import and local controls

Register a destination project with `node dist/cli.js --db team.db project add destination --root .`.
Review the producer protocol, variants, shared project and expected writers. From a
built repository, obtain their canonical pin locally (no network):

```sh
node --input-type=module -e 'import {readExchangeFile} from "./dist/exchange/files.js"; import {parseExchangePackage,protocolDigest} from "./dist/exchange/contracts.js"; const p=parseExchangePackage(readExchangeFile("package.json")); if(p.kind!=="assignment_metadata")throw Error("data_required"); console.log(protocolDigest(p));'
```

Create mapping.json with the resulting 64-character digest in `protocol_digest`:

```json
{"schema_version":1,"shared_project_id":"22222222-2222-4222-8222-222222222222","local_project_id":"destination","protocol_id":"comparison-1","protocol_digest":"REPLACE_WITH_REVIEWED_DIGEST","writers":[{"namespace_id":"11111111-1111-4111-8111-111111111111","stratum_id":"stratum-1","allocator_id":"allocator-1"}]}
```

The placeholder is intentionally invalid until replaced. Declare every protocol
stratum, including writers whose files have not arrived. Namespace declarations do
not authenticate a sender. Only accept files from your explicitly trusted exchange.

```sh
node dist/cli.js --db team.db exchange mapping register --config mapping.json
node dist/cli.js --db team.db exchange import --file package.json --project destination
node dist/cli.js --db team.db exchange import --file package.json --project destination
```

The second import reports `replayed`; it adds no usage. A deletion/conflict retires
the whole original comparison and removes all imported task evidence, including
surviving arms. No report can recover its old totals. A valid deletion mixed with
rejected live rows reports `deletions_applied_data_rejected` and exits nonzero:
the deletion DID commit. Storage failure rolls back the transaction.

Local imported-task deletion and its separate retention policy:

```sh
node dist/cli.js --db team.db exchange delete-task --project destination --shared-project 22222222-2222-4222-8222-222222222222 --task task-1
node dist/cli.js --db team.db exchange retention set --project destination --shared-project 22222222-2222-4222-8222-222222222222 --days 30
node dist/cli.js --db team.db exchange retention apply --project destination --shared-project 22222222-2222-4222-8222-222222222222
```

A finalized task older than the configured period retires its whole imported
comparison. Missing/nonfinalized timestamps do not independently expire a task.
These local denials are not sent back to producers; arrange source deletion and
notice delivery separately. `delete project destination` also purges mapped imports.
Never clear denial markers. `deleted_identifier` cannot be bypassed by a new package
UUID. `authority_conflict`, `mapping_conflict`, `protocol_conflict`, `identity_conflict`,
`assignment_conflict`, `evidence_conflict`, `package_conflict` and `stale_revision`
require correcting the source/mapping or stopping the invalid comparison, not
force-importing. Mapping changes and writer handover have no override command.

## Freeze and read a team report

After importing every available writer file, create team-snapshot.json:

```json
{"schema_version":1,"snapshot_id":"team-report-1","local_project_id":"destination","shared_project_id":"22222222-2222-4222-8222-222222222222","protocol_id":"comparison-1","cutoff":"2026-01-03T00:00:00.000Z","as_of":"2026-10-01T12:00:00.000Z","required_namespaces":["11111111-1111-4111-8111-111111111111"]}
```

Replace the example cutoff with the exact common source cutoff and as_of with a
UTC time at/after imports and no later than now. `required_namespaces` must equal
the full mapping writer set, including writers whose files are missing. For a
second stratum owned by another source, add its writer to both mapping and this
list; each source is registered with only its owned strata. Both source protocols
must have the same reviewed full settings/variants and digest.

```sh
node dist/cli.js --db team.db team snapshot create --config team-snapshot.json
node dist/cli.js --db team.db team report team-report-1 --format json
node dist/cli.js --db team.db team report team-report-1 --format markdown
node dist/cli.js --db team.db team report team-report-1 --format markdown-readable
```

`json` remains the default. Existing `json` and `markdown` output and frozen
snapshot bytes are unchanged. For V1, `markdown-readable` adds tables from the existing
snapshot, including original imported cohorts, component-specific observed task n,
quality, rework, follow-up, configuration deviations and the source revision vector.
It performs no new measurement or aggregation. Reading-state counts are event
counts; component n counts tasks with an observed value. V2 `markdown-readable`
currently embeds the report as a JSON block rather than these tables.

An identical snapshot request returns the same frozen result. Use a new snapshot
ID for updated evidence. `cutoff_mismatch` requires new source snapshots with a
common cutoff. `snapshot_as_of_unavailable` means current imported rows arrived
after as_of: use a later boundary or read a previously saved snapshot. No discarded
historical state is reconstructed. `missing_exchange_data` requires at least one
accepted writer package (an empty contribution is allowed). `report_conflict`
means an existing ID has a different request. `invalidated_report` cannot be reset.

Read `source_vector`, source evaluation/identity times, received_at, cutoff, as_of
and merged revision together. Team completeness is always unverified even when
declared writer coverage is complete. Missing writers do not count as zero tasks;
the full-team denominator stays null. Descriptive denominators include all imported
assignments, including never-started and pending follow-up. Observed zero remains
zero; missing, excluded, error and unmeasurable readings retain their own states.
Cached/reasoning subsets are not added again. Partial token distributions have their
own observed denominators and do not estimate complete task costs or savings.
Recruitment registration counts are unavailable; no inference/adoption is enabled.

After retirement, explicitly deliver and import the notice:

```sh
node dist/cli.js --db team.db exchange import --file deletion.json --project destination
node dist/cli.js --db team.db team report team-report-1 --format json
```

The report returns an invalidated marker without its former tasks, totals, input,
hash or provenance. This applies to all writers in the comparison. Local imported
deletion, imported retention and local project deletion use the same purge path.
A stale file or a new package/snapshot ID cannot resurrect that retired scope.

## Reproducible offline acceptance

From a Node 24 or 26 checkout after `npm ci`:

```sh
npm test -- tests/exchange-boundaries.test.ts tests/team-report.test.ts tests/team-snapshot.test.ts tests/team-deletion.test.ts tests/team-exchange-cli.test.ts
npm run check
```

The test-only helper `tests/helpers/team-fixture.ts` creates two registered synthetic
sources with distinct participants/environments/strata and eight original A/B
assignments, confirms declared configuration, starts tasks, and records human
outcomes through existing APIs. It inserts synthetic session linkage and usage at
the storage test seam; it never starts a collector or reads real session files.
There is no general synthetic-injection CLI or bypass for live experiments.
Public CLI tests cover export, import, replay, snapshot, JSON/Markdown, deletion,
stale rejection and restart. Separate tests cover source conflict propagation,
project-wide purge, retention boundaries, rollback and two-connection races.

Independent expected results are eight assignments (four per arm), three successes,
two failures, one abort, one never-started and one missing outcome. Six tasks have
partial usage, two have missing usage, and the four partial input+output sums are
`[0, 2, 4, 10]` (mean 4). These are synthetic verification facts, not a measured
improvement or inference result. Existing local report bytes remain compatible.
