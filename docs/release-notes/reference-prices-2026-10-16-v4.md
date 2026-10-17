# Reference prices 2026-10-16 v4 candidate

Status: unpublished candidate; local full validation and independent review passed.
Proposed tag: `reference-prices-2026-10-16-v4`. No release assets, bootstrap,
online source, defaults, frozen pins, retained inputs or results are changed.

## Identity and minimum client

- File: `config/prices/catalogs/reference-catalog-2026-10-16-v4.json`.
- Catalog ID/version: `reference-catalog-2026-10-16`, **4**.
- Catalog schema: **3**; manifest envelope schema: **1**.
- Policy: `reference-standard-observed-cache-ttl-v3`.
- Matching: `exact-catalog-observed-cache-ttl-v3`.
- Arithmetic: `decimal160-disjoint-v1`.
- Minimum capability: `catalog-cache-ttl-v3`, including schema-3 parsing,
  request-tier selection, numeric TTL usage metadata, TTL-aware tables,
  component matching and disjoint arithmetic. Catalog version 4 does not require
  schema 4. V1/v2 clients reject the unsupported policy/schema and keep accepted prices.
- Reviewed capability implementation:
  `c7ee96fc80d3e9046f476200c44b834aae45246e`, merged as
  `62f3841f79bb37c9b3b4e49dc78ce893109063e4`.
  Package `0.0.0` is not a semantic client floor. Do not downgrade databases
  after writing numeric TTL metadata.
- Exact candidate commit and its passing remote CI must be bound before publication.
  Local review and checks do not satisfy that remote release gate.
- Checked/proposed publication day: `2026-10-16T00:00:00Z`. These are day snapshots,
  not exact vendor effective times or proof of publication. All effective bounds
  remain null. Reconfirm publication metadata before any later publication.

## Rates, sources and support

The [decision's complete rate and condition matrix](../decisions/reference-price-catalog.md#october-16-refresh-candidate-catalog-v4-schema-3)
records every candidate rate in USD per million tokens, official sources checked
on 2026-10-16, exact identifiers, exclusions and unavailable-token behavior.
The eight previous model rows keep their rates and advance their checked dates.
Two literal OpenAI models are newly included: `gpt-5.6-sol` with official alias
`gpt-5.6`, and `gpt-5.6-cyber`. Claude `claude-mythos-5-1` adds global Standard
and observed-TTL rates. No fuzzy aliases or new conditions are introduced.
OpenAI short-context Standard and Anthropic first-party global Standard remain
explicit reference assumptions, not bill reconciliation.

Sol's rates are promotional and available **at least through 2026-11-21**.
`effective_until` remains null because no exact promotion end instant is given;
this candidate does not represent post-promotion rates. A later rate change
requires a new immutable catalog, not replacement of these bytes.

Existing Haiku whole-request tiers include ordinary input, cache reads and all
cache writes; 100,000 is in the lower tier and 100,001 in the upper tier.
Claude writes require numeric observed 5m/1h counts, including mixed and zero.
Missing/partial/invalid splits or old boolean-only rows preserve aggregate writes
but leave their cost unavailable. Revaluation cannot recover missing conditions
from live metadata. Reasoning remains included in output; no double counting.

Rosalind research/science, Astra Pro, other unlisted models, non-Standard
tiers, OpenAI long-context rates, regional/boost/media/tool/subscription/discount
pricing remain excluded. Unsupported models yield `unknown_model`; unsupported
billing modes are not detected or reconciled by the reference matcher.
Price coverage does not grant native admission, verified counters, complete cost,
source-trust promotion or inferential adoption decisions.

## Candidate bytes and validation gates

- Artifact length: **5,783 bytes**.
- Artifact SHA-256:
  `b3f05b7efe58930f300345c420de2877c94f35631fc91a11167a581695429dc6`.
- Expected asset:
  `catalog-b3f05b7efe58930f300345c420de2877c94f35631fc91a11167a581695429dc6.json`.
- Compiled basis ID:
  `catalog-prices-ba18fb0c978390b16ec3d914006e7288371b6746d0c7d5af37702eadf1725b84`.

Local Node 24.21.0 validation on 2026-10-16 passed `npm run check`: privacy,
lint, type checks, build and 212 test files / 2,848 tests. Local preparation
produced the manifest/artifact identity above; the built CLI accepted those
exact bytes in an in-memory database. This is not a remote CI run, publication
or a public download check. Independent review approved the exact
candidate/test/documentation diff with no actionable findings.

Reproduce the checks and local immutable asset preparation:

```sh
npm test -- tests/reference-price-update.test.ts tests/cache-ttl-pricing.test.ts tests/price-catalog-online.test.ts tests/price-revaluation.test.ts
npm run check
node scripts/prepare-price-catalog-release.mjs config/prices/catalogs/reference-catalog-2026-10-16-v4.json .harness-delta/catalog-release-v4-20261016
```

Manifest/hash/schema/client rejection, rollback and frozen-input regressions must
pass. Local preparation does not prove remote CI or download behavior.
Before publication, reconfirm Sol's promotion status and all publication-day
metadata. Publication and any default/pin changes require separate explicit authorization.
Only after authorized publication may a fresh synthetic database download and
refresh check verify the exact published manifest/artifact and prior asset
immutability. No native rerun or model request is needed for this data candidate.
