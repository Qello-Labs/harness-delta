# Use the reference price catalog

[한국어](reference-price-catalog.ko.md) · [Cost readings and coverage](observed-cost.md)

Use the same local database as the measured task. Prerequisite: Node 24 or 26 built CLI
and authorized stored observations. These commands read local metadata and start
no model requests. Standardized partial estimates are not your bill or savings.

## 1. Read the supplied catalog

```sh
node dist/cli.js --db .harness-delta/pilot/local.sqlite price-table catalog-status
```

Expected: catalog ID/version, verification date, last check/success and update status.
First use loads the bundled catalog offline. It contains Astra, Sol, Luna, Fable,
Opus, Sonnet and Haiku reference rates checked on 2026-10-06. See the
[source policy and exact identifiers](../decisions/reference-price-catalog.md).
`update_channel` is `verified_https_manifest` with the default source in step 3.
An explicitly unconfigured source reports `bundled_or_verified_local_artifact`.
No automatic refresh runs. A stale or failed
update must remain visible beside the last accepted catalog. The verification date does not establish the price's effective date.

The 2026-10-08 v2 catalog is distributed separately and does not replace the v1
bootstrap. It lowers Sonnet 5.5 cache reads to $0.10
per million tokens. Haiku 5.5 has request-specific tiers under the new schema/policy:
up to 100,000 total prompt tokens, or over 100,000, including cache reads/writes.
Automatic selection requires consistent observed input counts and linked request
runtime evidence. Missing evidence leaves the affected cost unavailable
(`unverified_condition`); eligible requests can still yield a partial estimate.
Known one-hour or mixed cache writes remain unpriced while their token counts
remain observed and count toward the prompt threshold. TTL absence means the
explicit five-minute reference, not confirmed actual billing.
See the [verified rates and candidate limits](../decisions/reference-price-catalog.md#october-2026-catalog-update).
Install the updated client before consuming v2; older clients retain cached v1
prices when they reject the unsupported schema/policy.
An explicit trusted artifact or online refresh can accept v2
for future defaults. Existing comparisons and results retain their original pins.

The [v3 release](https://github.com/Qello-Labs/harness-delta/releases/tag/reference-prices-2026-10-08-v3)
contains separate 5-minute and 1-hour write rates. It requires a client with
`catalog-cache-ttl-v3` support, implemented in reviewed commit
`c7ee96fc80d3e9046f476200c44b834aae45246e` and merged as
`62f3841f79bb37c9b3b4e49dc78ce893109063e4`; release notes identify the exact
publication commit and its passing CI. V1/v2 clients
reject it and retain accepted prices. Do not downgrade a database after new TTL
metadata has been written. The bootstrap and existing pins stay unchanged.
New Claude observations with explicit, consistent TTL counts can price both
durations, including mixed writes. Missing/invalid TTL or historical boolean-only
data leaves write cost unavailable; v3 cannot recover the old split. File/OTel
observations without those counts have the same exclusion. Other matched components
can remain partial. `matches[].cache_ttl` explains each matched duration;
`unverified_condition` means missing/invalid TTL or required request evidence,
while `missing_rate` means no rate for an observed condition. See the
[v3 support limits](../decisions/reference-price-catalog.md#observed-cache-ttl-v3).

The UI shows partial amounts and separate source/compatibility unverified references.
An unpriced-usage notice can include excluded cache writes even when their tokens
are observed. The CLI match rows provide condition details. Price support does not
qualify a native source/counter or enable complete cost or inference.

## 2. Estimate without choosing a price file

```sh
reportCutoff=$(node -p 'new Date().toISOString()')
node dist/cli.js --db .harness-delta/pilot/local.sqlite price-table estimate-task task-1 \
  --cutoff "$reportCutoff"
```

Expected: `price_selection`, table provenance,
`partial_amount`, null `complete_amount`, reasons and window/coverage evidence.
Catalog-backed results additionally include catalog provenance and exact component
matches. Explicit-table results retain the explicit-table report shape.
Read `compatibility_unverified_partial_amount` and `legacy_unverified_partial_amount`
separately from verified `partial_amount`; see [source trust and coverage](observed-cost.md#4-read-amount-missingness-and-coverage-separately).
An assigned V2 task uses its frozen comparison reference; a standalone task uses
the current catalog. Explicit historical comparison tables still work. New V2
comparison CLI configurations may omit `price_table_id`; registration fills it once.
Refresh does not change that registered reference. Advanced `--price-table` retains
the [previous explicit procedure](observed-cost.md#1-select-the-rate-table).

The default V1 input basis is `output-only-v1`. V2 keeps its recorded disjoint
components. An explicit `--input-basis cache-read-remainder-ordinary-v1` is a legacy
assumption, not verified cache-write coverage. Effort has no price multiplier;
reasoning is already in output. Missing usage stays missing. Unknown model/rate
leaves the affected cost unavailable while measured tokens remain stored. No fuzzy
model match or another model's rate is used.

## 3. Refresh an approved catalog

After a tool update, reload its bundle:

```sh
node dist/cli.js --db .harness-delta/pilot/local.sqlite price-table refresh-catalog
```

Expected: `unchanged` or `updated`. If the bundle is older than an accepted local
catalog, refresh fails with `catalog_rollback` and keeps the newer cache.
To use a newer trusted publisher release artifact, supply its file and separately
verified SHA-256; replace both placeholders:

```sh
node dist/cli.js --db .harness-delta/pilot/local.sqlite price-table refresh-catalog \
  --artifact /path/to/reviewed-catalog.json --sha256 'TRUSTED_64_CHARACTER_SHA256'
```

Expected: `updated`/`unchanged`, or exit 2 with a sanitized failure reason. Check
`catalog-status` afterwards. A hash checks bytes; it does not establish publisher
trust. Invalid files, timeout, bad hash, conflicting IDs and older versions keep the
last accepted prices. Refresh changes only future default preparation.
Users do not edit/register model rates for the normal estimate flow. Request the
tool's approved published source:

```sh
node dist/cli.js --db .harness-delta/pilot/local.sqlite price-table refresh-catalog --online
```

Expected: `updated`/`unchanged`, or a safe failure with the accepted cache retained.
The default source is the approved `Qello-Labs/harness-delta` GitHub latest release.
After the repository transfer, update older clients to this canonical source;
the old owner's redirect adds a hop outside the fixed download policy. The issuer
ID `harness-delta`, release bytes and existing task price bases remain unchanged.
The first price release passed a real download/refresh check on 2026-10-06.
Future latest releases must carry the manifest and catalog assets; otherwise
refresh fails and retains cached prices. An explicitly unconfigured server returns
`catalog_source_not_configured`. `online_source.status: configured` and
`can_attempt_online_refresh: true` mean a source is configured, not verified reachable
or current. `verification_age_days` describes the retained catalog's check date.
The browser never asks for a model price JSON or arbitrary source URL.

## 4. Retain and reprice a fixed result

Retain a task input before its metadata is deleted:

```sh
node dist/cli.js --db .harness-delta/pilot/local.sqlite price-table snapshot-task task-1 \
  --id cost-input-1 --cutoff "$reportCutoff"
```

For an existing V2 comparison report, retain both arms from the frozen report instead:

```sh
node dist/cli.js --db .harness-delta/pilot/local.sqlite price-table snapshot-comparison report-1 \
  --id comparison-cost-input-1
```

Expected: task capture returns `input_id`, `snapshot_hash`, `original_table_id`
and `cutoff`; comparison capture returns `input_id`, `snapshot_hash`,
`base_report_id` and `cutoff`. Task and comparison windows can
differ; choose the corresponding capture. Neither command reads session contents.
After an approved refresh, create a separate result from that input:

```sh
node dist/cli.js --db .harness-delta/pilot/local.sqlite price-table reprice comparison-cost-input-1 \
  --id repriced-1
node dist/cli.js --db .harness-delta/pilot/local.sqlite price-table revaluation repriced-1
```

Expected: one target catalog basis for all original tasks/arms, unchanged usage/window
hashes, distinct result ID and null complete cost. The original report remains unchanged.
This result is descriptive; it supplies no adoption or relative-change decision.
For a task input, replace `comparison-cost-input-1` with `cost-input-1`. A newly priced
model can become partly priceable; missing usage is still missing. Deleted dependent
tasks/projects or an invalidated base report purge retained inputs/results and block revival.
