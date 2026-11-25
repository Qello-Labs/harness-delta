# Price catalog release checklist

This checklist is required for catalog v3 and every later price release. Read the
[price policy](../decisions/reference-price-catalog.md), [repository rules](../../AGENTS.md)
and [development workflow](workflow.md). Preparing a candidate does not authorize
publication, changing bootstrap/defaults, changing frozen pins or repricing results.

## 1. Review source and supported conditions

- Verify exact identifiers/aliases, units, prices, dates and billing predicates
  against official vendor sources. Record the checked date and direct URLs. Keep
  effective timestamps null when the vendor gives no exact clock/timezone.
- List every released model/component/condition as implemented and validated, or
  explicitly excluded with the observed-token behavior and unavailable reason.
  Never claim supported pricing just because a rate appears in the file.
- Verify parser/projection/arithmetic support together. Keep collection admission,
  counter qualification and price coverage separate; price support does not admit
  a native version, establish complete task cost or enable inference.
- Retain only permitted numeric metadata and immutable provenance. Do not collect
  session content or extend collection scope to obtain a missing pricing condition.

## 2. Implement and verify the client with the data

- Ship matching, disjoint components and predicates with synthetic regressions.
  Cache TTL regressions include 5m, 1h, mixed, observed zero, absent/partial/invalid
  counts, overflow, old boolean-only data, cache reads and no double counting.
  Keep aggregate writes observed even when their price condition is unavailable.
- Cover request-tier boundaries and missing/conflicting request evidence when
  applicable. Verify replay fingerprints distinguish meaningful new evidence,
  preserve legacy cursors safely and reject conflicts instead of rewriting events.
- Verify backward compatibility for prior catalog/schema/policies and exact frozen
  basis IDs/hashes. Cover frozen inputs/results and separate opt-in revaluation:
  no live metadata backfill, silent repricing, source-trust promotion or deleted
  record revival. Forward unknown schema/policy must retain the last accepted cache.
- Define the minimum client capability and exact reviewed client commit in release
  notes. For v3 this is `catalog-cache-ttl-v3`: schema 3, observed-TTL policy,
  TTL-aware tables/matching/arithmetic and numeric usage metadata. Clients supporting
  only v1/v2 reject v3 and retain accepted prices. Old clients may also reject new
  usage metadata; do not downgrade a database after writing the new contract.
  Tool release [v0.1.0](../release-notes/harness-delta-v0.1.0.md) is the first
  released client and supports `catalog-cache-ttl-v3`, accepting catalog schemas
  1-3 and catalogs v1-v5. Its tag, not private package version `0.0.0`, identifies
  that released client floor. Earlier published price notes remain historical.
- Run focused tests and `npm run check`. Obtain independent review of the exact
  data/code/documentation diff and resolve material findings. Record exact-head
  local evidence separately from remote CI. Required remote CI must pass before
  publication; a workflow file is not execution evidence.

## 3. Validate immutable release assets

- Choose fresh catalog ID/version and tag. Never replace accepted catalog IDs,
  prior tags, manifests or assets. Keep bootstrap and defaults unless separately
  authorized; updating latest can affect a later explicit online refresh.
- Build the reviewed client. Run `scripts/prepare-price-catalog-release.mjs` with
  the reviewed file into an ignored output directory. The helper prepares local
  assets only; it does not publish. Reconfirm day-snapshot publication metadata
  when preparing on a later date.
- Validate manifest schema/publisher/policy/ID/version/dates, exact artifact length,
  SHA-256 and digest-named filename. Test schema/policy mismatch, bad hash, rollback,
  future versions and safe client rejection/cache retention with synthetic transport.
- Bind the release to the exact independently reviewed commit and its passing CI.
  Publication needs explicit authorization. After authorized publication, independently
  download manifest/artifact, verify bytes/digests/identity and the client refresh
  in a fresh synthetic database. Never use a historical measured database as a probe.
- Check that prior published assets and identities remain unchanged. Keep the
  download check distinct from local simulated transport; report any unavailable
  evidence accurately.

## 4. Synchronize contributor and user explanations

- Update the price decision/support matrix, release notes and paired English/Korean
  [catalog instructions](../runbooks/reference-price-catalog.md) and relevant cost
  guidance together. Keep command blocks, identifiers, section order and limits aligned.
- Explain CLI match conditions/unavailable reasons and the UI's partial/reference
  amounts. Missing pricing is not missing usage or zero. Historical boolean-only
  writes cannot be recovered by adopting v3. Partial costs and native/counter
  qualification limits must remain visible.
- Map acceptance criteria to actual test/review/CI/download evidence in the final
  report. Keep personal plans and detailed reviews under `.harness-delta/` only.
