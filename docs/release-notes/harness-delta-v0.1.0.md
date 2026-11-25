# Harness Delta v0.1.0 developer preview

Status: release prepared for tag `v0.1.0` (developer preview). This is a GitHub
source-tag release, not an npm package, separately uploaded tarball or prebuilt
binary. Preparation does not mean the release or its installation checks have
already completed.

The exact release commit and its passing CI are given in the GitHub release body.

## What the preview provides

This release delivers the current partial local measurement workflow:

- Registered local projects and measurement tasks.
- Ordinary Claude observation at the routes and states documented in
  [Harness Connect](../runbooks/harness-connect.md) and the
  [support matrix](../support-matrix.md).
- Harness comparison (A/B) with its documented assignment and frozen-protocol
  boundaries.
- Partial observed cost and explicit price catalog refresh through v5.

These claims have the same limits as the [README](../../README.md). Observation
requires a registered project, active task and linked session. Measurement data
excludes prompts, responses, source-code content and secrets. Installation alone
does not start collection.

## Install from source

Use Node 24 or 26 and npm. Once the tag is available:

```sh
git clone https://github.com/Qello-Labs/harness-delta.git
cd harness-delta
git checkout v0.1.0
npm ci
npm run build
npm start -- --db preview.sqlite ui
```

Open `http://127.0.0.1:4318`. Use your chosen `--db` file instead of
`preview.sqlite` for subsequent work; it contains private measurement data.
Stop the service with Ctrl+C. Follow the [walkthrough](../guide/walkthrough.md)
for project/task setup before observation.

Use the same Node major to install, build and run. After switching Node majors,
run `npm ci` and build again so the native SQLite dependency matches the selected
ABI. A native ABI mismatch reports `native_dependency` and exits with code **4**.
Actual native qualification and the pinned Codex direct-child workflow retain
their separate Node 24 requirements.

The package stays private: `package.json` remains `private: true` and version
`0.0.0`. The Git tag identifies this release; package `0.0.0` and a CLI
`--version` invocation do not identify it. No registry package or automatic
updater is provided.

## Upgrade and compatibility commitments

- **Forward-only database:** stop processes using the selected `--db` and make
  a consistent SQLite backup before upgrading. Keep the backup private, including
  any associated UI metadata database needed for your workflow. Never open a
  database with an older release after a newer release has written to it.
  Restoring a separate pre-upgrade backup is not an in-place downgrade.
- **Price client:** v0.1.0 is the first released tool client and supports
  `catalog-cache-ttl-v3`, accepting catalog schemas 1-3 and catalogs v1-v5.
  Acceptance does not publish the historical v4 candidate. Existing bootstrap,
  defaults, frozen prices, pins, retained inputs and results remain unchanged.
- **0.x compatibility:** minor releases may break compatibility. Breaking changes
  are announced in release notes only; no long-term support is offered.

Earlier price release notes keep their historical minimum-client statements.
Use the current [catalog guide](../runbooks/reference-price-catalog.md) for the
released client floor and each catalog's conditions.

## Explicit limits

- This is delivery of the current state only, a narrow R7 release. R4-R6 remain
  open. Ordinary-window collection stays disabled pending separate product
  activation and native acceptance; this release makes no R6 activation.
- Window-grade Codex 0.169.1, Codex 0.171.0 and Claude 2.1.332 are not exact-version
  qualifications. Admission, transcript conformance, conditional parser reuse and
  ordinary native qualification remain separate. This release grants no new
  support and changes no version cap, default or pin.
- Ordinary usage and cost remain partial. Missing usage or prices are not zero;
  unobserved, paused and pre-connection intervals are not backfilled. Complete
  totals, billing reconciliation and inferential adoption decisions are not
  provided. Separately qualified instrumented-source claims do not promote
  ordinary observations.
- Child topology does not extend beyond the documented families. Codex
  ordinary-session collection still uses its frozen `functional_pilot` assignment
  path, not the assignment-free ordinary Claude mode.
- V5 retains observed OpenAI cache writes but does not price them. Long-context
  billing above 272K is not distinguished by its short-context reference rates.
  Keep the [price support limits](reference-prices-2026-11-25-v5.md) visible.
- No automatic update, global CLI upgrade, npm/other registry publication,
  prebuilt binary or separately uploaded install tarball is included.

## Release verification and delivery

The [tool release checklist](../development/tool-releases.md) requires independent
review, exact-commit CI, local checks, fresh-install checks on Node 24 and 26, and
a post-publication source-archive build. Unrun checks remain pending.

Tool releases use `--latest=false`. After publication, verify that the
`releases/latest/download/manifest.json` URL still serves the current price
manifest, because the price client uses that channel. This tool release does not
authorize a price release or change its assets, bootstrap, defaults or pins.
