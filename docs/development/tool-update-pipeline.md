# Tool update pipeline: discovery and static assessment

[한국어](tool-update-pipeline.ko.md)

This guide covers the first increment of the maintainer tool-update pipeline. It
finds the current stable Codex CLI or Claude Code release from official metadata,
then compares that candidate against the routes this repository declares. That's
all it does. A candidate isn't support, an assessment isn't admission, and none of
these records changes a default.

## What this increment does

- `discover` reads official GitHub release and npm package metadata for one product.
  It writes an immutable observation record and, on success, an immutable candidate
  record.
- `assess` reads a candidate, the observation that produced it, and an optional
  review baseline. It projects the current repository source and writes an immutable
  assessment record.

It won't install anything or run a vendor binary. It also doesn't read sessions,
the user database, or tool configuration, and it never changes admission, defaults,
CI, or tracked files. Only `discover` makes network requests. It sends fixed read
requests to official GitHub and npm endpoints, with no secrets and no caller-supplied
URL parameters.

Contract review, conformance, regression, admission, and default promotion are
separate stages. They aren't part of this increment. The repository-owned
[admitted Claude runner](tool-update-conformance.md) has synthetic coverage;
its actual-binary acceptance and execution approval remain separate.

## Prerequisites

- A checkout running Node 24 or 26. The command doesn't install Node.
- Dependencies installed with `npm ci`, following [CONTRIBUTING](../../CONTRIBUTING.md#development-environment).
- A private local output directory that isn't tracked by Git and isn't a symlink.
  Keep records there, outside shared artifacts.

Symlinked parent directories are rejected too. On macOS, canonicalize temporary
paths under `/var` or `/tmp` to their physical paths before passing them.

`assess` compiles the current TypeScript source into a private temporary directory
using the existing lockfile dependencies. It doesn't use a stale `dist` build.
Imperative operation/topology rules are checked against reviewed source digests.
If those source files change, `source_scope_changed` stops assessment until the
maintainer reviews the rules again; it never silently keeps the old scope.

## Discover a candidate

```sh
out="$HOME/tool-update-records/codex"
node scripts/tool-update.mjs discover --product codex --out "$out"
```

Use `--product claude_code` for Claude Code. To attach review coverage, add
`--baseline "$baseline_file"` (see [Review baseline](#review-baseline)).

The command prints one JSON line:

```json
{"status":"metadata_reconciled","candidate_id":"<64 hex>","observation_id":"<64 hex>","heads":{"github":"<version>","npm_latest":"<version>","npm_stable":"<version>"}}
```

Discovery verifies the official repository name and numeric ID, then compares
GitHub's published `/releases/latest` with both npm's `latest` tag and its maximum
stable version. GitHub's chosen latest is not assumed to be its highest historical
semantic version. Without a baseline, only that target is pinned.
With a baseline, the review universe is npm's stable versions from the earliest
explicit baseline through the target, including both endpoints. Every selected
version must have a matching published stable GitHub release and exact tag commit.
Tag lookups use the same prefix spelling as the current GitHub latest tag.
Alternate tag spellings are neither queried nor checked for conflicts.
GitHub-only intermediate releases and full historical GitHub coverage are not
verified. Historical release pagination is not requested or followed.
It revalidates every queried resource with ETags or repeated digests before
finishing. Drift or an exhausted budget is `discovery_incomplete`,
not success. That check gives bounded retrieval consistency. It isn't an atomic
snapshot across GitHub and npm, so don't describe it as one.

A failed discovery still writes a sanitized observation when storage works. In that
case `candidate_id` is `null` and the exit code is 2. An earlier successful
observation never stands in for a failed one.

This increment uses unauthenticated public requests. GitHub's primary limit is
[60 requests per hour per originating IP](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api).
Revalidation and tag resolution also consume requests. The local 512-response
ceiling does not grant that much upstream quota; `rate_limited` leaves discovery incomplete.
There is no automatic retry or token loading.
Each reviewed version needs multiple GitHub requests, including revalidation.
An old baseline can exhaust upstream quota far below the local ceiling. Advance
a baseline only after actual contract review, not to bypass the limit.

Decoded response caps are 64MiB for release objects, 32MiB for npm and 4MiB
for other GitHub responses. Initial retrieval and revalidation share a 512MiB
budget; the 120-second deadline remains. Large release-asset
metadata is discarded after projection, not retained in records.
On 2026-10-29, the former all-history mode hit HTTP 422 beyond Codex's first
1000 releases. The scoped mode avoids that inventory scan; it does not reinterpret
the first 1000 as a complete history.

New observations use `schema_version: 2` and
`inventory_scope: "latest_and_npm_review_range"`. New assessments use schema 2 and
carry the observation's scope (`legacy_full_inventory` for schema-1 inputs).
Legacy schema-1 observations and assessments remain readable without rewriting
them. The legacy scope label reflects the old record format, not authenticated
proof of its coverage. Candidate schema and identity are unchanged. `metadata_reconciled` proves
only the labeled scope, not full historical coverage or runtime compatibility.

## Assess a candidate

```sh
candidate_id="<id from discover>"
observation_id="<id from discover>"
node scripts/tool-update.mjs assess \
  --manifest "$out/candidates/$candidate_id.json" \
  --observation "$out/observations/$observation_id.json" \
  --out "$out"
```

Replace the quoted placeholders with the IDs printed by `discover`. If you leave out
`--out`, the assessment goes in the record root two levels above the manifest file.
Pass the same `--baseline "$baseline_file"` you used for discovery, if any. On
success the command prints `{"status":"assessment_created","assessment_id":"..."}`
and exits 0.

## Records and identities

| Directory | Record | Identity |
| --- | --- | --- |
| `observations/` | One retrieval: UTC check times, source IDs, response digests and validators, completeness, fixed result codes | Includes timestamps, so every real requery gets a new ID |
| `candidates/` | Product, exact stable version, tag and commit, npm version and integrity | Only canonical release fields, so the same release keeps its ID |
| `assessments/` | Candidate ID, observation ID, baseline digest or missing state, source digest, rule revision, lane results | Changes when any of those inputs change |

Each file is named `<sha256>.json` over canonical JSON. Records are write-once.
Rewriting identical bytes succeeds, while different bytes under an existing ID fail
with `record_conflict`. There's no mutable `latest` alias or `candidate.json`.
Select records by the IDs printed for your run. A newer release gets a new
candidate and never retargets an old one.

Each response check keeps its first `queried_at` and final successful `checked_at`
separately. Failure observations can contain only partially revalidated checks.

## Reading an assessment

Results are keyed by explicit product, route, profile, operation, and topology for
every code-owned profile. Exact-only and unsupported profiles stay visible as such.

Every lane is static:

- Live dimensions (invalidation, binary, permissions, config, authentication) are
  `not_assessed`.
- The consumed-contract checklist starts with every contract `unknown`.
- `contracts_reviewed` is `unknown`. Conformance, regression, implementation review,
  admission, and default promotion are `not_assessed`.

Coverage is `review_required` when a baseline row exists for the lane and
`baseline_missing` otherwise. Neither value means the release works.
`review_sources` binds allowlisted upstream source/schema or changelog paths to
each release commit. Their availability is `not_assessed`: these are review
requirements, not claims that the files were fetched or their contracts verified.
These source locations are review starting points and can move upstream. Confirm
each path at the pinned commit before treating it as available review evidence.

## Review baseline

The baseline is optional and reviewed by hand. Without it, discovery still reconciles
the stable head, but review coverage stays incomplete as `baseline_missing`. The
tool never infers a baseline from the parser base or the current default.

The file is a strict object:

```json
{
  "schema_version": 1,
  "kind": "baseline",
  "rows": [
    {
      "product": "codex",
      "route": "<route>",
      "profile_id": "<profile_id>",
      "operation": "<operation>",
      "topology": "<topology>",
      "last_reviewed_version": "<version>",
      "contract_revision": "consumed-v1",
      "evidence_ids": ["<64 hex>"],
      "source_digest": "<64 hex>"
    }
  ]
}
```

This shows the shape only, and it isn't usable input. Each value must come from a
real, manually reviewed record: the release you actually reviewed, the evidence IDs
for that review, and the digest of the source you reviewed. `evidence_ids` must be a
nonempty list of unique 64-character hex IDs. Duplicate keys, unknown keys, and
malformed rows are rejected with `invalid_baseline`. A version newer than the target
fails as `baseline_ahead`. Neither command updates a baseline.

## Status codes and exit behavior

Every run prints exactly one JSON status line containing fixed codes and safe IDs.
Versions may appear in normalized form. Raw response bodies, error messages, and
local paths are never printed.

| Exit | Status | Meaning |
| --- | --- | --- |
| 0 | `metadata_reconciled` | Discovery finished and wrote a candidate |
| 0 | `assessment_created` | Static assessment written |
| 2 | `release_mismatch` | GitHub and npm stable heads, or npm `latest` and the stable maximum, disagree |
| 2 | `discovery_incomplete` | Missing selected release, budget exhaustion, or drift on revalidation |
| 2 | `metadata_conflict` | Conflicting release identity, tag resolution, or integrity |
| 2 | `invalid_arguments` | Unknown command or missing option |
| 2 | `invalid_record`, `record_too_large`, `record_conflict`, `record_read_failed`, `record_write_failed`, `unsafe_output` | Local record input or storage failure |
| 2 | `invalid_baseline`, `baseline_ahead` | Baseline rejected |
| 2 | `source_snapshot_unavailable`, `source_scope_changed`, `source_drift`, `observation_mismatch` | Source projection failed, reviewed scope changed, or inputs don't belong together |
| 2 | `internal_error` | Unexpected local failure; no raw exception is printed |

For `discover`, an ahead baseline appears as `baseline_ahead` in the failure
observation's reasons; stdout still reports `discovery_incomplete`. The `assess`
command returns `baseline_ahead` directly.

Fix the cause and run again. Don't edit records by hand.

## Limits

- Local historical source windows are repository declarations. They don't claim
  anything about the latest upstream release.
- CLI tests use synthetic metadata only. Running the real tool against localhost
  vendor binaries is a future stage that needs its own execution approval.
- Support, qualification, admission, and default changes still follow the
  [development workflow](workflow.md) and the product requirements.

## Official metadata contracts

- [GitHub latest release](https://docs.github.com/en/rest/releases/releases#get-the-latest-release)
- [GitHub release by exact tag](https://docs.github.com/en/rest/releases/releases#get-a-release-by-tag-name)
- [GitHub exact references](https://docs.github.com/en/rest/git/refs#get-a-reference)
- [npm package metadata](https://github.com/npm/registry/blob/main/docs/responses/package-metadata.md)
