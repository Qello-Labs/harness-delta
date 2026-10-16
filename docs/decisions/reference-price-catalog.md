# Tool supplied reference prices

The tool supplies a reviewed, versioned catalog instead of requiring routine user
price-table registration. This decision applies to standardized estimated token
cost under R02/R04/R05/R06/R07/R09/R10. It does not admit a collection source,
complete-cost profile, real experiment or inference method.

## Source and reference policy

The bundled [catalog](../../config/prices/catalogs/reference-catalog-2026-10-06.json)
contains seven exact model identifiers and one explicitly verified Haiku alias.
Rates were checked on **2026-10-06 UTC** against
[OpenAI pricing](https://developers.openai.com/api/docs/pricing) and
[Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing).
The midnight verification/publication timestamp represents the day snapshot; it
is neither an exact checking minute nor a vendor effective-date claim.
Unknown effective dates remain null. Anthropic identifiers/alias were checked in
the [model overview](https://platform.claude.com/docs/en/models/overview).

`reference-standard-v1` is USD per 1,000,000 tokens: OpenAI Standard short context
and Anthropic first-party global Standard with a 5-minute cache-write reference.
Applying this policy binds Codex to OpenAI and Claude Code to Anthropic for the
reference estimate. Output says `provider_basis: reference_policy`; the product
name alone does not establish the actual provider, billing tier, context length
or cache TTL. Callers with separate verified provider evidence can pass it to
the matcher; a reseller identity does not match first-party prices.
Fast/Flex/Batch, region, personal discounts, subscription allowances, tool charges,
image/audio units and actual billing reconciliation are outside this policy.

The [OpenAI Models API](https://developers.openai.com/api/reference/resources/models/methods/list)
and [Anthropic Models API](https://platform.claude.com/docs/en/api/models/list)
do not document reference price fields. Official pricing pages are available, but
this investigation did not confirm a documented, stable official catalog API.
The app catalog is tool-maintained and source-checked, not an official vendor API.
No third-party catalog is used. A future public catalog must identify its author,
license, upstream verification and pinned version/hash before adoption.

Effort is not a rate dimension. It can change observed usage. Cache reads/writes
are separate disjoint components; writes replace ordinary input for those tokens.
Reasoning tokens are included in output, never charged twice. See
[OpenAI caching](https://developers.openai.com/api/docs/guides/prompt-caching),
[OpenAI reasoning](https://developers.openai.com/api/docs/guides/reasoning) and
[Anthropic thinking cost](https://platform.claude.com/docs/en/build-with-claude/thinking-steering-and-cost).
Unsupported modifiers or unknown token readings cannot be inferred from the catalog.

## October 2026 catalog update

The separate [2026-10-08 catalog](../../config/prices/catalogs/reference-catalog-2026-10-08.json)
is `reference-catalog-2026-10-08`, catalog version **2**, under the new
`reference-standard-request-tiers-v2` policy and schema version 2. It has eight
priced models and the existing Haiku 4.5 alias. Schema/policy v1 remains supported.
The bootstrap remains the original 2026-10-06 v1 catalog. Local preparation does
not publish it or refresh a database. Accepted updates never change a frozen price pin.

The [official Haiku 5.5 announcement](https://www.anthropic.com/claude-haiku-5-5)
is dated **2026-10-07** and states availability and the Sonnet 5.5 cache-read cut
start that day. The [official model overview](https://platform.claude.com/docs/en/models/haiku-5-5/overview)
confirms the literal Claude API ID `claude-haiku-5-5` and release date. It is a pinned
[dateless model ID](https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions),
not a fabricated dated alias. No additional alias is added.
The [official pricing document](https://platform.claude.com/docs/en/about-claude/pricing)
and model overview were checked on **2026-10-08 UTC**. All following rates are
USD per **1,000,000 tokens**, for first-party global Standard:

| Model / prompt length | Ordinary input | Output | Cache read | Cache write, 5 minutes | Cache write, 1 hour |
| --- | --- | --- | --- | --- | --- |
| Haiku 5.5, up to and including 100,000 tokens | 0.10 | 0.50 | 0.01 | 0.125 | 0.20 |
| Haiku 5.5, over 100,000 tokens | 0.50 | 2.50 | 0.05 | 0.625 | 1.00 |
| Sonnet 5.5 | 2.00 | 10.00 | 0.10 | 2.50 | 4.00 |

The update changes Sonnet 5.5 `cache_read` from `0.2` to `0.1`; its other
reference rates are unchanged. One-hour writes are verified above but excluded
from the existing five-minute policy. Unchanged rows retain their original
2026-10-06 verification dates; this focused update does not claim to reverify
OpenAI or other Anthropic entries.

Haiku 5.5 chooses one rate set for the whole request, including its output.
`up_to_100000` covers 0 through 100,000 prompt tokens; `over_100000` starts at
100,001. It is not progressive pricing of the excess tokens. The
[official caching contract](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
defines total input as ordinary input plus cache-read input plus cache-creation
input. Output and reasoning tokens do not enter that prompt-length threshold.

The catalog's `prompt_tiers` compiles into conditional table entries with
`prompt_tier`. Matching version `exact-catalog-request-tiers-v2` binds the policy,
rates and predicates into the immutable basis hash. The arithmetic remains
`decimal160-disjoint-v1`; only rate selection changes. Flat v1 catalogs compile to
their original bytes, table IDs and `exact-catalog-v1` matching behavior.

Automatic selection requires a V2 event with verified attribution and its linked
runtime evidence: matching task, session, model, product/version and occurrence
stamp, a non-null unique request ID, `boundary: request`, and a source other than
`self_attested`. All three disjoint input components, cached-input summary and full
input total must be observed, consistent and within safe integer bounds. A
session/turn total, ordinary input alone, missing cache count, conflicting identity
or absent evidence leaves every affected Haiku rate `unverified_condition`.
Measured zero remains zero; missing values are never filled. Independently eligible
requests can still contribute a partial amount, with `complete_amount: null`.

Existing Claude trace projections already retain request identity and the three
input components; legacy V1 transcript messages do not prove that request boundary.
This change reads stored metadata only and does not read extra session content,
admit a new collector/version or improve usage completeness. The five-minute cache
write remains an explicit reference condition, not a claim about actual TTL/billing.
When the existing Claude binding parser observes positive one-hour cache creation,
it preserves `cache_write_1h_observed: true` with the observed aggregate counters.
Catalog matching and direct table arithmetic leave that request's entire cache-write
component unpriced, including mixed five-minute/one-hour writes. Other eligible
components remain partial; all observed write tokens still enter Haiku's prompt
threshold. Conflicting request rows with different one-hour evidence are rejected.
The flag survives frozen cost inputs and repricing. No one-hour rate is guessed or
activated, and previously frozen inputs/results are not rewritten. TTL absence
still means an explicit five-minute reference estimate, not verified actual TTL.

Task, binding and frozen comparison projections pass eligible runtime evidence to
the same selector. New retained cost inputs with such evidence use snapshot schema
2 and freeze the linked runtime metadata and conflicting request aliases with their
original usage/window. Freezing never removes a known request-identity conflict. Old
schema 1 inputs remain readable and unavailable for tier-dependent pricing if they
lack evidence; repricing never backfills runtime metadata from the live database.
Previously stored reports, inputs and revaluations are not rewritten.

Upgraded clients can consume schema/policy v2. Older clients reject the unsupported
catalog/manifest and retain cached v1 prices; installing the updated client precedes
an explicit accepted refresh. Bootstrap remains v1; an explicit accepted refresh selects the updated catalog.

Neither official source supplies an exact effective clock time/timezone. Both
changed/new rows retain null `effective_from`/`effective_until`; the documented
vendor date does not authorize an invented midnight effective timestamp. Catalog
`verified_at`/`published_at` midnight values represent the verification day snapshot,
not an exact public-release clock time. Reconfirm publication
metadata before publishing on a later date; never replace bytes under an accepted ID.
The prior public v1 manifest and catalog were downloaded on 2026-10-08 and matched
the repository's 3,476-byte file, SHA-256
`ae7f1aefab3b78f87bf9259b68b29882edc498b305831e3c2b3146f0968adf24`.

Prepare the release assets locally after a build:

```sh
node scripts/prepare-price-catalog-release.mjs config/prices/catalogs/reference-catalog-2026-10-08.json .harness-delta/catalog-release-v2-request-tiers
```

The release tag is `reference-prices-2026-10-08-v2`. Publication binds the exact
reviewed commit, manifest and digest-named catalog assets.
The existing v1 release, bootstrap, stored tables and measured results remain
unchanged; only an explicit accepted refresh can select v2 for future preparation.

## Observed cache TTL (v3)

The [v3 catalog](../../config/prices/catalogs/reference-catalog-2026-10-08-v3.json)
uses schema/catalog version 3, ID `reference-catalog-2026-10-08-cache-ttl`, policy
`reference-standard-observed-cache-ttl-v3` and matching version
`exact-catalog-observed-cache-ttl-v3`. The
[reference-prices-2026-10-08-v3 release](https://github.com/Qello-Labs/harness-delta/releases/tag/reference-prices-2026-10-08-v3)
distributes the manifest and digest-named catalog. Bootstrap remains v1; no default, frozen pin, stored input or result is changed automatically.
Every release from v3 follows the [release checklist](../development/price-catalog-releases.md).

[Official pricing](https://platform.claude.com/docs/en/about-claude/pricing) and
[cache usage semantics](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
were checked on **2026-10-08 UTC**. The first-party global Standard 1-hour write
rates per million tokens are Fable 5.1 `20`, Opus 5.5 `8`, Sonnet 5.5 `4`, Haiku 4.5
`2`, and Haiku 5.5 `0.2`/`1` for its existing whole-request tiers. The catalog
retains v2 rates otherwise and the same OpenAI short-context reference conditions.
Anthropic row verification dates advance to this check date; OpenAI dates do not.
Unknown exact effective times remain null. These are reference prices, not billing
or subscription reconciliation.

New authorized Claude binding observations preserve the aggregate `cache_write`
component plus optional `cache_write_ttl` metadata. Its source is
`product_usage_cache_creation`; observed `five_minute_tokens` and `one_hour_tokens`
must be nonnegative safe integers whose sum equals the aggregate. They are read
only from `usage.cache_creation.ephemeral_5m_input_tokens` and
`ephemeral_1h_input_tokens`. Missing fields remain `missing/not_available`; malformed,
negative, fractional, overflowing or inconsistent values become `error/source_error`.
Invalid TTL metadata does not discard the aggregate or other usage components.
No remainder, request setting or absence of a one-hour flag proves a numeric split.
The original positive one-hour flag is retained for old-policy compatibility.

V3 tables declare `cache_write_policy: observed_ttl-v1` and qualify Anthropic write
entries by `cache_ttl: 5m` or `1h`. Matching and arithmetic use a transient split
view and never add it to the aggregate. Cache reads remain disjoint and reasoning
remains included in output. The full aggregate still enters Haiku's prompt threshold;
its existing linked-request evidence requirement applies to both TTL rates. Missing
TTL leaves only the write component `unverified_condition`/`unpriced_component`;
an omitted TTL rate is `missing_rate`. Other eligible components stay partial.
The report version is `catalog-observed-cost-cache-ttl-v3`; `matches` includes the
TTL condition. Source trust partitions, provider reference policy and null complete
cost remain independent of rate coverage.

| Condition | V3 behavior |
| --- | --- |
| Explicit consistent 5m/1h counts, including mixed and zero | Match each available TTL rate once |
| Old boolean-only or absent/partial TTL metadata | Preserve aggregate tokens; exclude write cost |
| Invalid/inconsistent TTL counts | Preserve aggregate tokens; exclude write cost with error metadata |
| Missing model/rate/provider or required request evidence | Keep affected price unavailable |
| Fast/Batch/regional/subscription/tool charges, unknown models | Excluded from this reference policy |
| File/OTel observations without numeric TTL metadata | Writes unavailable under v3; no source expansion |

V1/v2 policies and basis hashes keep their previous five-minute reference behavior,
including exclusion of the whole write component when the one-hour flag is present.
Retained snapshots preserve whichever TTL metadata was originally recorded. A
separate explicitly requested v3 revaluation cannot reconstruct a split from old
boolean-only data or fetch it from current logs/database rows. Original results
remain immutable. Numeric splits enter new request fingerprints; legacy rows with
no TTL object keep their old fingerprints. Replaying different evidence conflicts
instead of upgrading a previous observation silently.

Minimum client capability is `catalog-cache-ttl-v3` (the client containing this
schema/policy, table and usage extension), implemented in reviewed commit
`c7ee96fc80d3e9046f476200c44b834aae45246e` and merged as
`62f3841f79bb37c9b3b4e49dc78ce893109063e4`. Release notes identify the exact
publication commit and its passing CI; package `0.0.0` is not a meaningful minimum semantic version.
V1/v2 clients reject the v3 manifest policy/catalog schema and retain accepted
prices. They may reject new optional usage metadata too; do not downgrade a
database after writing it. The manifest envelope remains schema 1 with the new
policy bound to validated artifact bytes. No native rerun or exact counter/TTL
qualification was performed: Claude binding versions remain candidates, inherited
source observations remain unverified, complete cost and inference remain closed.

## October 16 refresh candidate (catalog v4, schema 3)

The unpublished [candidate](../../config/prices/catalogs/reference-catalog-2026-10-16-v4.json)
has ID `reference-catalog-2026-10-16` and catalog version **4**, but retains
**schema 3**, policy `reference-standard-observed-cache-ttl-v3`, matching version
`exact-catalog-observed-cache-ttl-v3` and arithmetic `decimal160-disjoint-v1`.
Catalog version counts immutable data releases; it does not select a new schema.
It does not change the bootstrap, online source, defaults, existing pins or results.
Its proposed tag is `reference-prices-2026-10-16-v4`; preparation is not publication.
See the [candidate release notes](../release-notes/reference-prices-2026-10-16-v4.md)
for capability, artifact identity and remaining release gates.

All eleven canonical models and both aliases were checked on **2026-10-16 UTC**:
[OpenAI pricing](https://developers.openai.com/api/docs/pricing),
[OpenAI models](https://developers.openai.com/api/docs/models),
[Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing),
[Anthropic model IDs](https://platform.claude.com/docs/en/models/overview) and
[cache rates and usage](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).
The eight existing rows retain their rates. GPT-5.6 Sol and GPT-5.6 Cyber add
literal short-context Standard rate sets; Claude Mythos 5.1 adds its global
Standard/observed-TTL rates without new matching predicates.
The [Sol model page](https://developers.openai.com/api/docs/models/gpt-5.6-sol)
verifies `gpt-5.6` as its explicit alias; no suffix removal is introduced.
The [Haiku 4.5 page](https://platform.claude.com/docs/en/models/haiku-4-5/overview)
reconfirms its dated ID and `claude-haiku-4-5` alias. The
[Mythos model page](https://platform.claude.com/docs/en/models/mythos-5-1/overview)
confirms `claude-mythos-5-1` and its cache rates. The five current Claude
models use their literal dateless IDs, not fabricated dated snapshots.

Full candidate rates follow, in USD per **1,000,000 tokens**. OpenAI cache writes
are its separately listed write component, not Anthropic TTL writes; `n/a` means
no one-hour rate is asserted, not zero.

| Canonical model / whole-request prompt tier | Ordinary input | Cache read | Cache write / Claude 5m | Claude 1h write | Output |
| --- | --- | --- | --- | --- | --- |
| `gpt-6-astra` | 10 | 1 | 12.5 | n/a | 50 |
| `gpt-6.1-sol` | 2 | 0.1 | 2.5 | n/a | 10 |
| `gpt-6-luna` | 0.1 | 0.01 | 0.125 | n/a | 0.5 |
| `gpt-5.6-sol` (alias `gpt-5.6`), current promotion | 4 | 0.4 | 5 | n/a | 20 |
| `gpt-5.6-cyber` | 12.5 | 1.25 | 15.625 | n/a | 75 |
| `claude-fable-5-1` | 10 | 0.25 | 12.5 | 20 | 50 |
| `claude-mythos-5-1` | 10 | 0.25 | 12.5 | 20 | 50 |
| `claude-opus-5-5` | 4 | 0.2 | 5 | 8 | 20 |
| `claude-sonnet-5-5` | 2 | 0.1 | 2.5 | 4 | 10 |
| `claude-haiku-4-5-20251001` (alias `claude-haiku-4-5`) | 1 | 0.1 | 1.25 | 2 | 5 |
| `claude-haiku-5-5`, prompt <=100,000 | 0.1 | 0.01 | 0.125 | 0.2 | 0.5 |
| `claude-haiku-5-5`, prompt >100,000 | 0.5 | 0.05 | 0.625 | 1 | 2.5 |

The official Sol pricing is promotional, available **at least through
2026-11-21**. The vendor does not specify an exact ending instant, so
`effective_until` remains null rather than inventing one. This snapshot does not
represent post-promotion rates; changed prices require a fresh immutable catalog.
Reconfirm the Sol promotion status before publication or use as a current-price
reference after that date. An existing frozen pin remains a historical reference.

Haiku retains the existing verified whole-request boundary requirement and TTL
split semantics, including the 100,000/100,001 boundary. For all Claude writes,
only explicit consistent numeric 5m/1h splits are priced; aggregate tokens remain
observed when TTL is missing, partial, invalid or historical boolean-only.
The write cost then remains `unverified_condition`; an absent rate for an observed
condition remains `missing_rate`. No collection or metadata contract changes.

This is bounded reference coverage, not an exhaustive vendor inventory:

| Unsupported model or condition | Candidate behavior |
| --- | --- |
| Models absent from the candidate, including Rosalind research/science, GPT-6 Astra Pro and other unlisted legacy models | `unknown_model`; observed tokens remain; no family fallback |
| Invented dated IDs or effort/Fast suffixes | `unknown_model`; no normalization |
| OpenAI long-context billing, Fast/Ultrafast/Priority/Flex/Batch, Claude Fast/Batch, US-only/other regional rates, Fable boost over 500K, service/tool/media charges, subscriptions and discounts | No such rate or predicate is implemented; only the explicit Standard short-context/global reference is supplied |
| Missing/conflicting Haiku request evidence or Claude TTL split | Existing `unverified_condition` behavior; other eligible components may remain partial |
| Reseller or different verified provider | `unsupported_provider`; no first-party billing claim |

The matcher does not observe or infer actual service tier, geography, boost state
or OpenAI context tariff. It can still return the explicit reference-policy
amount; that is not validation of those unsupported billing conditions.
OpenAI's pricing table omits Cyber long-context rates while its
[model page](https://developers.openai.com/api/docs/models/gpt-5.6-cyber) lists
them. Only their consistent short-context rates enter this candidate. Resolving
long-context selection would require a separately approved contract; none is added.
All exact vendor effective timestamps remain null. Midnight `verified_at` and
proposed `published_at` represent the checked day, not a vendor effective instant
or evidence that the candidate has been published.

Minimum client capability remains **`catalog-cache-ttl-v3`**: schema-3 parsing,
observed-TTL policy/tables/arithmetic, Haiku request evidence and numeric TTL usage
metadata. Its reviewed implementation is
`c7ee96fc80d3e9046f476200c44b834aae45246e`, merged as
`62f3841f79bb37c9b3b4e49dc78ce893109063e4`. No semantic-version floor exists.
Catalog v4 is readable by that capability; it does not need a schema-4 client.
V1/v2-only clients must reject its policy/schema and retain accepted prices.
This data refresh grants no native admission, counter qualification, complete
cost, trust promotion or inference. Existing frozen inputs are not backfilled.

## Distribution, update and pin

The bootstrap ships in `dist/catalogs`; a local database retains the last accepted
catalog. `catalog-status` exposes verification/version, last check/success, failure
and the update channel. `refresh-catalog` reloads the bundle or accepts an explicit
trusted publisher artifact with SHA-256. A hash proves the supplied bytes, not the
publisher's authority or the rates' truth: operators must obtain it from a trusted
release channel. The approved first release is
[reference-prices-2026-10-06-v1](https://github.com/Qello-Labs/harness-delta/releases/tag/reference-prices-2026-10-06-v1).
Its two assets passed a real bounded HTTPS download/refresh check on 2026-10-06
under the original repository owner. Moving to Qello-Labs requires a fresh download
check on that canonical source; the release bytes and `publisher_id: harness-delta`
remain unchanged. Older clients must update their fixed source rather than rely
on GitHub's repository-transfer redirect, which adds a hop outside this policy.
`defaultPriceCatalogSource` uses this publisher's `releases/latest/download/manifest.json`.
Online refresh is on demand; no automatic network refresh or scraper is enabled.
An explicitly unconfigured server source still returns `catalog_source_not_configured`.
The server owner supplies fixed source configuration, never browser request URLs.

`readOnlinePriceCatalogStatus` exposes `online_source`, `can_attempt_online_refresh`
and `verification_age_days` in addition to the existing status. Configuration means
an attempt is permitted; it does not prove availability or that prices were checked
today. `publisher_id` is a declared issuer bound to the configured ID; publisher
trust comes from the fixed approved HTTPS source, not that string or the content hash.
The release manifest binds policy, catalog ID/version, verification/publication dates,
exact artifact length and SHA-256. The artifact retains its original reviewed bytes.
No signatures, model calls, credentials, tasks or measurement data are required.

The transport reads at most 16 KiB of manifest and 1 MiB of catalog within the existing
5-second refresh deadline. Only a digest-named JSON artifact beside the manifest is
accepted. HTTPS requests send no cookies/local metadata and do not use authentication.
Redirects are denied for generic sources. A separately approved fixed
`Qello-Labs/harness-delta` GitHub source may follow at most two hops: the same publisher
tag/asset and configured `release-assets.githubusercontent.com` or
`objects.githubusercontent.com`. Each target is validated before request; signed CDN
queries are transient. Resolving `latest` captures its tag before fetching the artifact,
so a concurrent latest-release change cannot mix manifest/artifact versions.
[GitHub's release-asset API](https://docs.github.com/en/rest/releases/assets?apiVersion=2022-11-28)
documents both 200 and 302 downloads. The first release passed this redirect path.

Maintainers can prepare the two public files locally after a build:

```sh
node scripts/prepare-price-catalog-release.mjs config/prices/catalogs/reference-catalog-2026-10-06.json .harness-delta/catalog-release-v1
```

The output is only `manifest.json` and `catalog-<sha256>.json`: normalized numeric
rates, source links, model/provider aliases, policy, version and dates. Existing
different files are not overwritten. The script publishes nothing. Publication requires
explicit approval of the repository, tag, commit and exact public files. Future GitHub latest releases
must carry both catalog files, or clients retain cached rates on a failed refresh.

The validator accepts only the bounded known schema/policy/currency/unit, exact
official source URLs, unique literal mappings and decimal rates. Loading is limited
to 1 MiB and 5 seconds. Future publication dates, downgrade, changed payload/bytes
under one catalog ID, failed loads and bad hashes fail closed. Racing updates cannot
replace a newer version with an older one. Failure retains cached prices and exposes
a sanitized reason; cached verification may be stale. First initialization remains
offline. A new shipped bundle updates an existing database only through refresh.

For a V2 protocol with no price-table ID, CLI registration prepares an immutable
PriceTable plus catalog/policy/matching sidecar once. Repeated registration retains
the first pin. Explicit user tables retain their old API/CLI behavior. Task estimates
without a table use their frozen V2 comparison pin or the current catalog for a
standalone task. Refresh never rewrites a protocol or existing price table/report.
No default comparison configuration, enrollment window or deadline is changed.
`readReferenceTaskCostReport` shares that selection/capture/projection path with
descriptive task facades and the default CLI. Its exported `ReferenceTaskCostReport`
retains catalog matches when available, legacy fallback, coverage and partial reasons.
It admits the existing task start/active/loss window; an external clock owner must
ensure or separately restrict its own window start. No new clock is inferred here.

## Minimal contracts and revaluation

Catalog identity/version and canonical hash bind each compiled basis; its content
ID also binds policy, `exact-catalog-v1` and exact compiled rate entries. Aliases
are explicit catalog literals, scoped by product/provider. No family prefix,
effort suffix removal or fuzzy fallback is permitted. Raw model evidence remains
unchanged. Unknown provider/model/attribution/condition/rate stays unavailable.
An explicit zero rate differs from a missing rate. Missing/error/excluded usage
does not become zero even when its model/rate is known.

Retained cost inputs contain only validated eligible usage metadata, the original
cutoff/window/coverage hashes, table identity and original arm IDs. Task capture
reuses the existing active/loss interval selection. Comparison capture reads the
original frozen report input, preserving assignment, follow-up and receipt
eligibility. It does not reread live session files or include newly observed usage.
An input ID cannot silently recapture a different snapshot.

Repricing creates a separately identified immutable descriptive result. All retained
tasks/arms use one target basis and the original formula/window. Original report
bytes and results remain unchanged, including originally unknown costs. A newly
listed model can later yield a partial estimate; usage completeness does not improve.
`complete_amount` stays null. No adoption, primary mean or relative-change result
is generated. Deleting a dependent task/project or invalidating the base comparison
purges the retained input and its revaluations; opaque tombstones prevent ID revival.
This batch adds no cost snapshot export/import or sync format.

User procedure: [English](../runbooks/reference-price-catalog.md)
([한국어](../runbooks/reference-price-catalog.ko.md)). Synthetic verification:

```sh
npm test -- tests/price-catalog.test.ts tests/price-catalog-store.test.ts tests/price-catalog-selection.test.ts tests/price-catalog-cli.test.ts tests/price-catalog-online.test.ts tests/catalog-cost-report.test.ts tests/price-revaluation.test.ts tests/reference-price-update.test.ts tests/haiku-request-pricing.test.ts
```

These checks cover catalog identity, cache retention, exact matching, frozen pins,
missing/zero values, immutable repricing and deletion. They do not prove deployed
distribution, official price timeliness, production source completeness or spending.
