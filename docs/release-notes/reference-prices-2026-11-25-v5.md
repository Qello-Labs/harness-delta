# Reference prices 2026-11-25 v5

Status: published release,
[reference-prices-2026-11-25-v5](https://github.com/Qello-Labs/harness-delta/releases/tag/reference-prices-2026-11-25-v5).
Existing published assets, bootstrap, online source, defaults, frozen pins,
retained inputs and results remain unchanged.

The reviewed candidate is `c8763ff6100adfbe48a5d7f70c066750594da492`, merged in
PR #138 as `0121d33f15d87fe820acebff43a77ebadad311ce`, with
[passing PR CI](https://github.com/Qello-Labs/harness-delta/actions/runs/45593032815).
The publication commit (the publication-documentation PR's merge) and its
passing exact-commit CI are identified in the GitHub release body. The actual
public-download and client-refresh check is performed after publication and
reported separately; these notes do not claim that check has run.

## Identity and minimum client

- File: `config/prices/catalogs/reference-catalog-2026-11-25-v5.json`.
- Catalog ID/version: `reference-catalog-2026-11-25`, **5**.
- Catalog schema: **3**; manifest envelope schema: **1**.
- Policy: `reference-standard-observed-cache-ttl-v3`.
- Matching: `exact-catalog-observed-cache-ttl-v3`.
- Arithmetic: `decimal160-disjoint-v1`.
- Minimum capability: `catalog-cache-ttl-v3`, implemented in reviewed commit
  `c7ee96fc80d3e9046f476200c44b834aae45246e` and merged as
  `62f3841f79bb37c9b3b4e49dc78ce893109063e4`. Catalog version 5 doesn't need a
  schema-4 client. V1/v2-only clients reject the policy/schema and keep accepted prices.
- No semantic client floor exists; package `0.0.0` isn't one, and none is invented here.
- Publication/verification day: `2026-11-25T00:00:00Z`. That's a day snapshot,
  not a vendor effective time or proof of publication. All effective bounds stay null.

V1 to v4 catalog files, IDs, pins and basis hashes stay as they were. The v4
candidate remains unpublished history and isn't published as a step toward v5.

## Rates, sources and support

The [decision's rate and condition matrix](../decisions/reference-price-catalog.md#november-25-refresh-candidate-catalog-v5-schema-3)
lists every released rate in USD per million tokens, checked on 2026-11-25 against
official OpenAI and Anthropic pricing pages. The catalog has 17 canonical models
and the two retained aliases, `gpt-5.6` for `gpt-5.6-sol` and `claude-haiku-4-5`
for `claude-haiku-4-5-20251001`. Six OpenAI models are new: `gpt-6.2-astra`,
`gpt-6.2-sol`, `gpt-6.1-terra`, `gpt-6-sol`, `gpt-5.6-terra` and `gpt-5.6-luna`.
The eleven carried models keep their v4 rates, except that no OpenAI cache-write
rate is carried.

**OpenAI cache writes are unpriced in v5.** Every OpenAI `cache_write` rate is
omitted, not set to zero. Observed write tokens stay stored and reported. Their
write component gets `missing_rate`, so the amount is partial wherever writes are
present; ordinary input, cache reads and output can still be priced. A missing
rate isn't missing usage and isn't zero. This also applies to the five models v4
could price, as a deliberate v5 exclusion. Claude 5m/1h writes and the
Haiku 5.5 request tiers behave exactly as in v4.

**OpenAI long context isn't distinguished.** Requests above 272,000 input tokens
aren't detected or refused. They get the same short-context/global reference rate
as shorter requests, so the reference amount can understate the actual long-context
charge. Long-context rates stay excluded and unsupported, as in v3/v4.

Sol's promotional rates are available **until 2026-11-30**. The vendor gives no
ending clock or timezone, so `effective_until` stays null. Reconfirm this row
before publication; after that date the snapshot isn't a current-price reference.

Fast/Ultrafast/Priority, Flex, Batch, regional and geography modifiers, Cyber long
context, boost, tools/media, subscriptions and discounts remain excluded actual-billing
conditions. Models outside the catalog give `unknown_model`. Price coverage grants
no native admission, verified counters, complete cost, trust promotion or inference.

## Release bytes and validation gates

The reviewed preparation produced these immutable release identities. Local
preparation is not evidence of a public download:

| Item | Value |
| --- | --- |
| Catalog bytes | `8068` |
| Catalog/artifact SHA-256 | `cce7964ed3b74b7feee5a0110b2eacc28d4220799292d90cdc65d3260877b805` |
| Artifact filename | `catalog-cce7964ed3b74b7feee5a0110b2eacc28d4220799292d90cdc65d3260877b805.json` |
| Manifest bytes | `490` |
| Manifest SHA-256 | `d76f668f9b9d91508d0165fbd45d0abed9d48e55f3631a5a86978f07b0ebc419` |
| Canonical parsed catalog hash | `ebc1bbb253d0c3f21dd912c3bfbeba611f4048b627480838419320613f726346` |
| Compiled basis ID | `catalog-prices-1f952f78851c52e13ee04d4c94a0ae1e64bd02ab722e849fc52e7a90a023af53` |
| Compiled entries | `76` |

Select the supported runtime and native dependency ABI as described in
[CONTRIBUTING](../../CONTRIBUTING.md#development-environment). The focused checks
use Node 24; the full local gate uses Node 26. Reproduce the checks and local
immutable asset preparation:

```sh
npm test -- tests/pricing/reference-price-v5.test.ts tests/pricing/reference-price-v5-store.test.ts \
  tests/pricing/reference-price-update.test.ts tests/pricing/cache-ttl-pricing.test.ts \
  tests/pricing/haiku-request-pricing.test.ts tests/pricing/price-catalog-online.test.ts \
  tests/comparison/reports/price-revaluation.test.ts --project default
npm run check
node scripts/prepare-price-catalog-release.mjs config/prices/catalogs/reference-catalog-2026-11-25-v5.json .harness-delta/catalog-release-v5-20261125
```

Before publication, reconfirm identifiers and both aliases from permitted primary
sources, Sol promotion and publication-day metadata, and require independent review
and passing exact-commit CI. The GitHub release body binds the publication commit
and CI separately from the reviewed candidate above. Publication and any default/pin
change require their own authorization; publication does not authorize changing
defaults or pins. After publication, download and refresh the manifest/artifact
in a fresh synthetic database, verify the identities above and confirm prior
assets are unchanged. Report that actual public-download check separately.
