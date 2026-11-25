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

Catalog revisions stay immutable; the bundled v1 bootstrap and existing pins never change automatically:

| Catalog | Status & client requirement | Key pricing scope and limits |
| --- | --- | --- |
| v1 (2026-10-06) | Bundled offline bootstrap | Astra, Sol, Luna, Fable, Opus, Sonnet and Haiku reference rates ([source policy](../decisions/reference-price-catalog.md)). |
| v2 (2026-10-08) | Separate distribution; requires v2+ client | Lowers Sonnet 5.5 cache reads to $0.10/M and adds Haiku 5.5 request tiers (<=100,000 vs >100,000 total prompt tokens including cache reads/writes). Needs consistent input counts and request evidence; known 1h/mixed writes stay unpriced ([details](../decisions/reference-price-catalog.md#october-2026-catalog-update)). |
| [v3](https://github.com/Qello-Labs/harness-delta/releases/tag/reference-prices-2026-10-08-v3) (2026-10-08) | Published release; requires `catalog-cache-ttl-v3` | Separates 5m and 1h Claude cache-write rates (including mixed writes) when explicit consistent TTL counts are present; older clients reject v3 and keep cached prices ([limits](../decisions/reference-price-catalog.md#observed-cache-ttl-v3)). Do not downgrade a DB after TTL metadata is written. |
| v4 (2026-10-16) | **Unpublished candidate** (schema 3, `catalog-cache-ttl-v3`) | Rechecks existing rates and adds `gpt-5.6-sol` (alias `gpt-5.6`), `gpt-5.6-cyber` and `claude-mythos-5-1` ([candidate notes](../release-notes/reference-prices-2026-10-16-v4.md)). Sol recorded promotional rates stated through **2026-11-21** (`effective_until: null`); because that date has passed, reverify current Sol pricing before publishing or treating it as current, and issue a new catalog for post-promotion prices. |

Pricing condition rules across catalogs:

- Missing/invalid TTL, historical boolean-only writes, file/OTel events without TTL counts, or missing request-tier evidence leave the affected component `unverified_condition` (while observed tokens remain stored and other matched components can still form a partial estimate). `missing_rate` means no rate exists for an observed condition; unlisted models stay `unknown_model`. `matches[].cache_ttl` reports each matched TTL duration.
- Fast/Ultrafast/Priority/Flex/Batch, long-context billing, regional/boost modifiers, tools/media, subscriptions and discounts are not priced. Matching supplies a Standard short-context/global reference only, not proof of actual billing conditions.
- The UI separates partial amounts from source/compatibility-unverified references, and unpriced-usage notices can include excluded cache writes whose tokens were observed. Price support never qualifies native sources/counters or enables complete cost or inference.

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
An ordinary observation task uses its immutable creation-time price pin
(`ordinary_task_pin`), selected before any comparison reference. An assigned V2 task
uses its frozen comparison reference (`frozen_comparison`). Only tasks without
either pin, including legacy standalone tasks, use the current catalog
(`current_catalog`). Catalog refresh changes neither ordinary task pins nor frozen
comparison references. Explicit historical comparison tables still work. New V2
comparison CLI configurations may omit `price_table_id`; registration fills it once.
Refresh does not change that registered reference. Advanced `--price-table` retains
the [previous explicit procedure](observed-cost.md#1-select-the-rate-table).

For legacy V1 `--input-basis` options (`output-only-v1` vs `cache-read-remainder-ordinary-v1`),
see [observed cost](observed-cost.md#3-choose-a-legacy-input-basis-only-when-intended).
Effort has no price multiplier; reasoning is already in output. Missing usage stays
missing, and unknown models or rates leave the affected cost unavailable without fuzzy
matching or substituting another model's rate.

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
