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
- `assess` reads a candidate, the observation that produced it, an optional
  review baseline, and any number of optional contract review records. It projects
  the current repository source and writes an immutable assessment record.
- `record-review` validates a hand-authored contract review record and publishes it.
  It never generates a judgment.
- `difference-job`, `collect-difference-evidence` and `judge` build machine
  difference records, and `assess --judgment` reads them through a separate channel
  (see [Machine difference commands](#machine-difference-commands)).
- `prepare-promotion` and `reconcile-promotion` turn an explicit input inventory
  into non-authorizing promotion proposals offline
  (see [Promotion commands](#promotion-commands)).

It won't install anything or run a vendor binary. It also doesn't read sessions,
the user database, or tool configuration, and it never changes admission, defaults,
CI, or tracked files. Only `discover` and `collect-difference-evidence` make network
requests. Both send fixed read requests to official endpoints, with no secrets and no
caller-supplied URL parameters.

The tool never performs a contract review. It only records and reads a maintainer's
manual judgments. Conformance, regression, admission, and default promotion are
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

The source digest also covers `src/nested-candidate.ts` and
`src/codex-candidate-rollout.ts` as hash-only inputs. Assessment does not transpile,
load, execute, or follow imports from these two files. Their changes appear as
`baseline_source_changed` or `review_source_changed`, not `source_scope_changed`.
Adding them makes the digest in every existing baseline row and review record
stale. Those records remain readable and are not rewritten; their historical
digests cannot close current contract review gates.

The current `static-assessment-v7` writer captures exactly 88 deduplicated paths, with no spare entries.
It adds the hash-only `src/binding/session-binding-promotion.ts` coordinator dependency
without loading its Store or native dependencies. The v6/schema-10 closure is frozen at
87 paths; it added the loaded `src/core/tool-version-promotion-store.ts` adapter and the hash-only
`src/deletion.ts`, `src/migrations/038_tool_version_promotion_denials.sql`,
`src/web/local-web-binding-providers.ts` and `src/web/local-web-support.ts` inputs.
Assessment never constructs a Store or queries local denials. The v5/schema-9 closure
is frozen at 82 paths; it added 27 hash-only producer, complete bundle, generator, distribution, installer dependency
and execution-pin API inputs to the frozen v4 closure of 55 paths. These inputs are not
loaded or executed by assessment. The v4 closure retains the v3 closure plus
`src/core/tool-version-promotion.ts`, `src/core/tool-version-promotions.json`
and `src/core/tool-version-promotion-result.json`; v3's 52 paths remain frozen history.
Its Codex window hash-only inputs include `src/connect/codex-connect-installation.ts`,
`skills/harness-connect-window-codex/SKILL.md` and
`skills/harness-connect-window-codex/scripts/connect.mjs`. The generic raw window
hook was already an input. The frozen v2 set already includes
`src/claude-process-binary.ts`. V3 adds exactly four independent Claude bundle
hash-only inputs:
`src/connect/claude-connect-installation.ts`,
`skills/harness-connect-window-claude/SKILL.md`,
`skills/harness-connect-window-claude/scripts/connect.mjs` and
`skills/harness-connect-window-claude/scripts/claude-session-hook.mjs`.
Assessment hashes these files without loading them or
following their imports; setup/transport wrappers are not consumed by this finite
projection. Execution pins separately freeze the complete source and build trees.
The static-assessment-v2 allowlist and cap remain frozen at 48 paths.
Schema 1-4 readers retain their original 32-path ceiling, and the record limit
remains 256 KiB. Input additions change the global source digest, not exact support
or activation; historical baselines/reviews stay immutable and cannot close fresh
gates with an old digest.

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
`inventory_scope: "latest_and_npm_review_range"`. Assessments use schema 11 and
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
Pass the same `--baseline "$baseline_file"` you used for discovery, if any. Add
`--review "$review_file"` once per contract review record (see
[Contract review records](#contract-review-records)). On success the command prints
`{"status":"assessment_created","assessment_id":"..."}` and exits 0.

## Records and identities

| Directory | Record | Identity |
| --- | --- | --- |
| `observations/` | One retrieval: UTC check times, source IDs, response digests and validators, completeness, fixed result codes | Includes timestamps, so every real requery gets a new ID |
| `candidates/` | Product, exact stable version, tag and commit, npm version and integrity | Only canonical release fields, so the same release keeps its ID |
| `reviews/` | One manual contract review of one lane and one release edge: fixed codes and digests only | Canonical record fields; the same review keeps its ID |
| `assessments/` | Candidate ID, observation ID, baseline digest or missing state, source digest, rule revision, lane results, and (schema 3 and 4) the supplied and unused review IDs | Changes when any of those inputs change |

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
- The consumed-contract checklist starts with every contract `unknown`. Only matching
  review records change it.
- `contracts_reviewed` is `unknown` unless review records settle it (see below).
  Conformance, regression, implementation review, admission, and default promotion
  are always `not_assessed`.

Coverage is `review_required` when a baseline row exists for the lane and
`baseline_missing` otherwise. Neither value means the release works.
`review_sources` binds allowlisted upstream source/schema or changelog paths to
each release commit. Their availability is `not_assessed`: these are review
requirements, not claims that the files were fetched or their contracts verified.
These source locations are review starting points and can move upstream. Confirm
each path at the pinned commit before treating it as available review evidence.

### Selection policy

With review records, the current schema-11 manual channel includes a strict `selection_policy`
object in every lane. Frozen schema 6 retains the same requirement:

```json
{
  "parser_base_transition": "none | minor | major | null",
  "baseline_transition": "none | minor | major | null",
  "next_step": "<code>"
}
```

`parser_base_transition` compares the parser base to the target;
`baseline_transition` compares the baseline row's `last_reviewed_version` to the
target. A major-number difference is `major`, a minor-number difference is `minor`,
and otherwise the value is `none`, including patch changes. Missing parser bases
or baseline rows produce JSON `null`, not the string `"null"`. These fields separate
the two comparisons; the existing combined transition reasons remain unchanged.

`next_step` describes the existing selection path. The first matching row wins:

| Code | Condition |
| --- | --- |
| `operation_unsupported` | The operation is not allowed |
| `retired` | The `retired` reason is present |
| `selected_exact` | Compatibility resolved with parser version equal to the target |
| `selected_window` | Compatibility resolved through a window |
| `exact_admission_required` | Nothing resolved and the `exact_only` reason is present |
| `older_version_unsupported` | Nothing resolved and the target is at or below an existing window's base |
| `window_extension_required` | A window exists and the target is at or beyond its upper bound |
| `window_rule_required` | No window exists and the lane is not exact-only |

No `next_step` value means support, qualification, or admission. `selected_*`
describes parser selection only. Source review alone cannot clear `exact_only`
or `no_window`. Older versions without an exact profile remain unsupported under
[ADR 013](../decisions/013-forward-version-compatibility.md);
`older_version_unsupported` has no promotion path. These descriptions do not change
reasons, compatibility, windows, review coverage, gates, or live checks.
An unmatched state fails with `invalid_record` rather than guessing a path.
The assessment record limit remains 256 KiB.

The current writer emits schema 11 with `static-assessment-v7` for the plain, manual
and machine channels. Readers for schemas 1-10 are frozen history: schemas 1–4 with
`static-assessment-v1` and schemas 5-7 with their named `static-assessment-v2` or
`static-assessment-v3` revision, schema 8 with `static-assessment-v4`, schema 9 with
`static-assessment-v5` and schema 10 with `static-assessment-v6`.
The two root-policy IDs are accepted with v3 on schemas 5-7, v4 on schema 8,
v5 on schema 9, v6 on schema 10 and v7 on schema 11; v2 records are not rewritten.
The v3 schemas add two ordinary root-reference
policy lanes, `codex-binding-root-window-v1` and `claude-binding-root-window-v1`,
with rule revisions `codex-ordinary-root-window-v1` and
`claude-ordinary-root-window-v1`. Each covers root only: link, collect and restart,
`exact_only:false`, depth 0 and one member, with no launch, resume or family lane.
These finite policy lanes are distinct from exact admission lanes. Static selection
doesn't read activation state, doesn't clear `exact_only` on legacy lanes and
doesn't make a release usable; `selected_window` on a policy lane describes
selection only. Legacy lanes keep their values in the new schemas. Both policies are
implemented for offline acceptance, ordinary-window collection disabled pending
separate product activation and native acceptance.

The separately delivered Codex bundle/setup uses `source_only` root references,
not verified root-own usage. Only a separately activated, explicitly active frozen
window task may use stable `0.163.0 < v < 0.170.0` before per-target deeper
conformance; no exact row is added for a window-only target. This limited exception
does not cover children, exact support, cap changes or promotion, which retain the
deeper verification gate. Failed required contracts, contradictions, revocation
and incompatible versions still stop observation. Delivery, installation or static
selection does not satisfy activation or native acceptance. See
[ADR 013](../decisions/013-forward-version-compatibility.md#codex-root-reference-exception)
and the [canonical verification boundary](../../.claude/skills/tool-version-update/references/verification.md#closed-codex-root-reference-boundary).

Window pin validation is a separate `ordinary_window_execution_pins` kind, schema 1
in its own namespace, with `pin_scheme_revision: ordinary-window-execution-v1`.
`snapshotWindowPins` / `assertWindowPins` freeze the code-owned Codex raw producer,
selected skill and instrument inputs, source/build trees, matching built copies,
runtime, package and lock independently for source and built selection. The packet
is not a runner or execution/activation approval; old exact pin functions and
approval schema 1 retain their meaning. No native/target/backend run, new budget,
publisher/variant change, cap renewal or successor record is created by validating it.

## Promotion records

Three additional revision-1 kinds describe portable promotion metadata:
`promotion_proposal`, `promotion_validation` and `promotion_decision`. They use
strict recursive schemas, canonical JSON, SHA-256 IDs, the 256 KiB limit and
immutable publication in `promotion-proposals/`, `promotion-validations/` and
`promotion-decisions/`. Only the two commands below produce proposals; no command
produces validations or decisions.

All three are non-authorizing. A decision record describes an external decision;
schema validity does not establish consent or change runtime support. The pure
gate reducer keeps admission, qualification and children separate, preserves
unknown and deferred actual evidence, and stops at `ready_for_decision`.
`review_needed` successors retain predecessor, grant, mapping, descriptor and
unresolved-finding references; they cannot revoke or restore authority. The
separate versioned promotion-engine identity covers the record and reducer
dependencies. It does not replace the difference-engine or assessment identities.

## Promotion commands

Both commands are offline and explicit. Each reads one input inventory file and
publishes into one record root:

```sh
node scripts/tool-update.mjs prepare-promotion --input "$inventory_file" --out "$out"
node scripts/tool-update.mjs reconcile-promotion --input "$inventory_file" --out "$out"
```

The input is a strict revision-1 JSON envelope. It lists every record the run may
read by content ID and file reference, nothing else. The commands never discover,
crawl a directory or follow a latest pointer, so a result is complete only for the
inventory it was given. One invocation accepts at most 256 referenced records and
256 lineage edges, and each record keeps the 256 KiB limit.

Each file reference is `{"id":"<canonical SHA-256>","path":"<input file>"}`.
Relative paths resolve from the inventory file's directory. IDs are recomputed
from parsed canonical record bytes; filenames are not identities. The inventory
file is also bounded to 256 KiB. Both envelopes reject unknown fields:

| Envelope | Required fields |
| --- | --- |
| Preparation | `schema_version:1`, `kind:"promotion_preparation"`, `selection_reason`, `selection_reference`, `scope`, `requested_grants`, `candidate`, `observation`, `assessments`, `jobs`, `judgments`, `descriptor`, `registry`, `ledger`, `decision_payload`, `mappings`, `predecessor_proposals`, `gate_matrix`, `required_validation` |
| Reconciliation | `schema_version:1`, `kind:"promotion_reconciliation"`, `judgments`, `proposals`, `decisions`, `descriptors`, `mappings`, `successors` |

Preparation's candidate, observation, descriptor, registry, ledger and decision
payload are single file references; the other record inputs are arrays of file
references. At least one assessment and job are required. The registry is the
supplied registry array; the ledger retains its versioned result-ledger shape.
The decision payload has the `promotion_decision` fields except
`registry_before_digest` and `effective_projection_digest`; it is read for preview,
never published. `scope`, gates, grants and validation classes use the promotion
record schemas. `predecessor_proposals` retains unresolved findings rather than
preparing a fresh ready proposal around them. Reconciliation's six input lists
are arrays of file references, including empty arrays where applicable.

Coverage mappings use `schema_version:1`, `kind:"promotion_coverage_mapping"`,
`original_lane`, `scope`, `descriptor_digest`, `review_reference`, `contracts`
and `facets`. They cannot expand operation or topology. Descriptor successors use
`schema_version:1`, `kind:"promotion_descriptor_successor"`,
`predecessor_descriptor_digest`, `successor_descriptor_digest`,
`predecessor_proposal_id`, `successor_proposal_id`, `coverage_mapping_ids`
and `review_reference`. Both definitions have content IDs and strict schemas;
their review references describe external review, not machine approval.

- `prepare-promotion` binds the supplied candidate, observation, assessment, job
  and judgment records, the pending descriptor, the registry and ledger state, the
  supplied decision preview payload and its scoped proof inputs. The promotion gate
  reducer derives the proposal state, which never goes past `ready_for_decision`.
  The descriptor, registry-before and proposed-projection digests come from the
  existing descriptor and ledger digest functions, computed from that preview payload.
  Proof from another lane doesn't count.
- `reconcile-promotion` validates the supplied proposal and decision chains, the
  reviewed lane coverage mappings and reviewed same-target descriptor successors.
  It follows only those mappings and successors, keeps the original evidence lane
  IDs and publishes a `review_needed` successor for each affected overlap. Unresolved
  findings carry forward. A stale or unknown judgment, or a later unaffected one
  without a reviewed resolution, can't clear a finding. Supplied IDs that match
  nothing are reported as unused. Invalid revisions, missing predecessors, cycles
  and conflicting mappings fail before anything is published, and identical inputs
  give the same result.

Each run prints one fixed JSON status line. Output is only an immutable
`promotion_proposal` with no authority. Neither command writes a validation or
decision, changes runtime support, or edits the registry, ledger or baselines. They
make no network, database, native, vendor binary, configuration or session access.

Preparation returns `promotion_prepared` and `proposal_id`. Reconciliation returns
`promotion_reconciled`, sorted `proposal_ids`, the declared `input_ids` and explicit
`unused_ids`. Identity mismatches, conflicting mappings and invalid lineage return
`promotion_identity_mismatch`, `promotion_mapping_conflict` or
`promotion_lineage_invalid` with exit 2; invalid schemas use `invalid_record`.

## Promotion support status

Promotion records, commands, the effective projection, the denial Store and the
promoted payload-only bundles are offline infrastructure. Offline completion is not
operational support.

- No real promoted descriptor or grant exists. `src/core/tool-version-promotions.json`
  holds no authorizing decision, and the generated support matrix lists no promoted
  descriptor. Every promoted route stays unavailable until a real grant exists.
- Pre-release gates R0 to R7 are pending: selection, actual-binary conformance,
  native and backend trials, real-session review, the concrete decision, product
  activation and delivery. None has run or been approved.
- A grant is prospective and scoped to its exact product, version, source, route,
  operation, topology, platform and runtime. It doesn't requalify history, backfill
  unobserved intervals or change the trust of earlier observations.
- A root grant can't read or enroll children. Each exact child scope needs its own grant.
- Grants leave historical event and snapshot bytes, the Codex 0.163.0 and Claude
  2.1.306 defaults, saved selections, settings hashes, assignments, protocols and
  prices unchanged. A retired or revoked saved exact selection is refused, never
  replaced by the default.
- An installed promoted copy stays payload-only and makes no native access without a
  current grant. A stale read-capable legacy registration makes the promoted flow
  refuse before launch.
- `reconcile-promotion` publishes only non-authorizing `review_needed` successors.
  It never approves, revokes or restores authority, and it doesn't edit the
  registry, ledger or Store.
- Caps, the Codex 0.166.0 exception, workflow version selection, prices and
  activation are unchanged. This infrastructure claims no new version support.

## Machine difference records

Three separate schema-1 kinds describe machine claims: `difference_job` binds the
candidate, observation, lane, nullable baseline, parser base, inventory and frozen
policy; `difference_evidence` binds finite methods, endpoint hashes and structured
findings; `difference_judgment` reduces required facets and comparisons into all
eight consumed groups. They retain strict recursive schemas, the 256 KiB limit,
canonical JSON, SHA-256 IDs and no-replace publication in `difference-jobs/`,
`difference-evidence/` and `difference-judgments/`. Content, free text, URLs, local
paths and approval fields are rejected. Engine identity uses its own explicit,
versioned file list, separate from the assessment source digest.

Adjacent baseline and parser-base edges plus a cumulative parser comparison are
required, even for equal baseline/target versions. Missing, stale or incomplete
proof stays unknown; applicable confirmed contradictions outrank passing fixtures.
A changed source hash alone establishes no impact. Native/backend/real-session
validation remains pending with windows closed. Static jobs use `not_applicable`
and null build/native/artifact digests. Under the conservative map, only Codex
groups without required native/backend facets can become `ready_for_scoped_review`
with complete unchanged client-source proof; Claude documentation or synthetic
replay alone cannot establish unchanged upstream behavior. No entire lane is
operationally ready. These records grant no authority and never become manual reviews.
Only the commands below create them, and only `assess --judgment` consumes judgments.

The Codex source library uses injected transport only, exact `rust-v<version>`
tags and pinned commits from the job, and code-owned paths. Map v2 compares the
complete Cargo workspace, configuration, patch and vendored-input tree identities,
including serialization, producers, transformations, hooks and invocation inputs.
Changed or incomplete closures remain unknown. The checked-in draft-07 config
schema can identify known consumed model, effort or sandbox field/type/enum changes;
it cannot establish unchanged rollout, hook or whole-group serialized contracts.
Only `api.github.com` is contacted, with same-origin/resource manual redirects.
Limits are 4 MiB decoded per document, 16 MiB per job including identity
revalidation, 128 responses, five redirects and 120 seconds. Failed, truncated,
drifted or exhausted reads produce unavailable evidence, never partial success.
Bodies are transient; records retain hashes and finite findings only. Client-source
identity does not establish packaging, native execution, delivery or backend meaning.

The Claude documentation library uses the same bounds and host, authenticates
`anthropics/claude-code`, resolves exact `v<version>` tags to the job commits and
revalidates `CHANGELOG.md` blobs. Only exact version sections in the comparison
interval are inspected. A finite keyword table requests scoped checks; only a
complete mapped statement contradicting a consumed guarantee can mark it affected.
Quiet, absent or unsupported documentation never establishes `unaffected`.
Unversioned documentation is context only: its receipt keeps a content hash,
fetch time, `release: null` and `unversioned_doc`; release evidence has null content
hashes and stays unavailable. No additional documentation host is admitted.

The synthetic replay library compares independent numeric and ownership ledgers
with parser/provider or synthetic-client results. It preserves terminal replay,
partial finality and missing-versus-zero readings. Test/harness and fixture/input
hashes are bound separately from the engine digest. These fixtures, including the
historical Claude stub/oracle, never test an unexecuted release or establish
backend counter meaning. Native, backend and real-session validation stays pending.
Only `collect-difference-evidence` calls the two network libraries.

## Machine difference commands

These commands are explicit and local. Nothing schedules them, and no remote
workflow runs them. Each prints one fixed JSON status line.

```sh
node scripts/tool-update.mjs difference-job \
  --manifest "$out/candidates/$candidate_id.json" \
  --observation "$out/observations/$observation_id.json" \
  --route "<route>" --profile "<profile_id>" \
  --operation "<operation>" --topology "<topology>" \
  --out "$out"
node scripts/tool-update.mjs collect-difference-evidence \
  --job "$out/difference-jobs/$job_id.json" --out "$out"
node scripts/tool-update.mjs judge \
  --job "$out/difference-jobs/$job_id.json" \
  --evidence "$out/difference-evidence/$evidence_id.json" \
  --out "$out"
node scripts/tool-update.mjs assess \
  --manifest "$out/candidates/$candidate_id.json" \
  --observation "$out/observations/$observation_id.json" \
  --judgment "$out/difference-judgments/$judgment_id.json" \
  --out "$out"
```

- `difference-job` is offline. It reads the candidate and observation records, one
  lane and an optional `--baseline`, and takes the parser base from code, not from
  an argument. If the observation lacks that base's pinned commit, the job keeps
  a null parser base and incomplete coverage; it never guesses a commit or fetches
  extra releases. It prints `difference_job_created` with `job_id`.
- `collect-difference-evidence` is the only new command with network access; the
  existing `discover` is the other. It reads one published job and runs the bounded
  collectors described above. It prints `difference_evidence_created` with
  `evidence_ids` and a nullable `failure`, which is a fixed bounded collector code.
  A complete collection exits 0; a failure exits 2.
- `judge` is offline. It reads one job and any number of `--evidence` records,
  recomputes the current identities and prints `difference_judgment_created` with
  `judgment_id`.
- `assess` accepts `--judgment` once per published judgment, alongside its existing
  options. It loads each referenced job from `difference-jobs/<job_id>.json` in the
  same record root. It reads records only: no network, Store, vendor binary or session.

Malformed records, unsupported revisions, and a judgment whose candidate,
observation, commit or lane doesn't match the assessment inputs fail with a fixed
status and exit 2. Nothing is published. Identical replays are deduplicated, and two
different judgments for the same job are rejected.

### Assessment schema 7

Schema 7 is frozen history; the current writer emits these fields in schema 11 when
`assess` gets at least one `--judgment`, and readers for schemas 1-6 don't change.
Schema 7 keeps the whole static and manual projection and adds:

- sorted top-level `judgment_ids` and `unused_judgment_ids`;
- automated results per lane, kept apart from the manual review fields;
- results per comparison, which describe the job's scope only. They aren't
  independent impact claims for each release edge;
- explicit pending validation for native, backend and real-session facets;
- conflicts where a manual review and a machine judgment disagree. Both values stay,
  and neither overrides the other.

A judgment that is structurally valid but stale still produces
`assessment_created`. If its source digest, engine digest or map revision differs
from the current one, the automated result is `unknown` with a fixed freshness
reason (`stale_source`, `stale_engine` or `stale_map`). A missing baseline, a
baseline equal to the target, or an incomplete parser chain leaves the result pending.

Neither frozen schema 7 nor the current schema-11 machine channel establishes support. Machine results never close `contracts_unknown`,
`exact_only`, `upper_bound`, `minor_transition`, `no_window`, live `not_assessed`
fields, conformance, admission or default gates. They never write a support, live,
admission, default or block decision, and they never make a version outside its
window selectable. An `affected` result writes no block either.

## Contract review records

A contract review record is a manual claim by a maintainer: "for this lane and this
release edge, these consumed contracts are unaffected, affected, or unknown." The tool
checks its shape and whether it matches the observed releases and current source. It
does not check that the review was done or that the judgments are right. A `closed`
lane means the supplied claims judge every contract `unaffected`.
It is not support: conformance, regression, implementation review, admission, and
default promotion stay `not_assessed`.

The record is a strict object. It has no free text, names, timestamps, or paths:

```json
{
  "schema_version": 1,
  "kind": "contract_review",
  "product": "codex",
  "route": "<route>",
  "profile_id": "<profile_id>",
  "operation": "<operation>",
  "topology": "<topology>",
  "contract_revision": "consumed-v1",
  "from": { "version": "<version>", "commit": "<40 hex>" },
  "to": { "version": "<version>", "commit": "<40 hex>" },
  "contracts": [
    { "contract_id": "identity_source_mapping", "judgment": "unaffected | affected | unknown" }
  ],
  "evidence_ids": ["<64 hex>"],
  "source_digest": "<64 hex>"
}
```

This shows the shape only. `contracts` must list all eight consumed contracts once each,
in the order of `consumedContracts`; the example shows one entry. `evidence_ids` is a
nonempty, sorted list of unique 64-character hex IDs. `from.version` must be lower than
`to.version`. `source_digest` is the source digest of the assessment the review was
done against.

### Workflow

1. Review the release edge by hand and write the record file.
2. Publish it:

   ```sh
   node scripts/tool-update.mjs record-review --input "$review_file" --out "$out"
   ```

   It prints `{"status":"review_recorded","review_id":"<64 hex>"}`. The file lands at
   `reviews/<review_id>.json`.
3. Run `assess` with one `--review "$out/reviews/<review_id>.json"` per record. The order of
   the options doesn't change the result.

When the baseline already covers the target version (no release edges), a lane is
closed only if a supplied record has `to.version` equal to the target, matches the
current source digest, judges all eight contracts `unaffected`, and its review ID is
listed in that baseline row's `evidence_ids`. A record alone never closes a lane the
human-approved baseline doesn't bind. Lanes with `baseline_missing` stay unknown
whatever is supplied.

### How assess applies records

With at least one `--review`, the assessment is written as `schema_version: 6`, with
the sorted `review_ids` and `unused_review_ids` and each lane's `selection_policy`.
Without `--review`, output uses `schema_version: 5` with no `selection_policy`. Its
bytes and ID still change whenever an input does, including the source digest.
Schema 1–6 assessments remain readable and are never rewritten.

- A record applies to a lane edge only if the lane key, `contract_revision`, and the
  `from` and `to` versions and commits all match the observation, and `source_digest`
  equals the current snapshot digest. Otherwise that edge stays `unknown`.
- If everything matches except `source_digest`, the edge stays `unknown` and the lane
  gets the reason `review_source_changed`. This isn't an error.
- `unused_review_ids` lists records no assessment reader used. A parser-comparison
  chain also counts as use: if it reads an unbound record on a zero-edge lane,
  that record is not listed, but `contracts_reviewed` stays `unknown` without
  baseline binding.
- `review.contracts` is the per-contract worst case across the interval: `affected`,
  then `unknown`, then `unaffected`. `contracts_reviewed` is `closed` only when every
  contract is `unaffected`, `affected` when any is (with the reason `contracts_affected`),
  and `unknown` otherwise. `contracts_unknown` is removed only when closed. Every other
  reason, such as `exact_only`, `no_window`, and `minor_transition`, stays, and live
  fields, other gates, and `review_sources` don't change.
- `parser_comparison` stays `unknown` unless a contiguous chain of matching records runs
  from the parser base version to the target, with every adjacent release and endpoint
  commit pinned in the observation. A missing parser base, a skipped observed release,
  or a commit gap leaves the comparison `unknown`.

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
fails as `baseline_ahead`. No command updates a baseline.

## Status codes and exit behavior

Every run prints exactly one JSON status line containing fixed codes and safe IDs.
Versions may appear in normalized form. Raw response bodies, error messages, and
local paths are never printed.

| Exit | Status | Meaning |
| --- | --- | --- |
| 0 | `metadata_reconciled` | Discovery finished and wrote a candidate |
| 0 | `assessment_created` | Static assessment written |
| 0 | `review_recorded` | Contract review record published |
| 0 | `difference_job_created` | Difference job published |
| 0 | `difference_evidence_created` | Evidence collection completed and published (`failure` is `null`) |
| 0 | `difference_judgment_created` | Difference judgment published |
| 2 | `difference_evidence_created` | Collection failed; `failure` carries a fixed collector code |
| 2 | `release_mismatch` | GitHub and npm stable heads, or npm `latest` and the stable maximum, disagree |
| 2 | `discovery_incomplete` | Missing selected release, budget exhaustion, or drift on revalidation |
| 2 | `metadata_conflict` | Conflicting release identity, tag resolution, or integrity |
| 2 | `invalid_arguments` | Unknown command or missing option |
| 2 | `invalid_record`, `record_too_large`, `record_conflict`, `record_read_failed`, `record_write_failed`, `unsafe_output` | Local record input or storage failure |
| 2 | `invalid_baseline`, `baseline_ahead` | Baseline rejected |
| 2 | `invalid_review` | A review record is malformed or breaks a fixed rule |
| 2 | `review_conflict` | Two different records cover the same lane and release edge |
| 2 | `review_commit_conflict` | A record's commit differs from the observed commit for that version |
| 2 | `difference_identity_mismatch`, `difference_job_mismatch` | A judgment or evidence record does not belong to its job or assessment |
| 2 | `difference_judgment_conflict` | Different judgments reference the same job |
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
- The approved order is registry, closed ordinary windows, difference judgment,
  then selective promotion. Each later native, promotion and publication gate
  still applies.

## Official metadata contracts

- [GitHub latest release](https://docs.github.com/en/rest/releases/releases#get-the-latest-release)
- [GitHub release by exact tag](https://docs.github.com/en/rest/releases/releases#get-a-release-by-tag-name)
- [GitHub exact references](https://docs.github.com/en/rest/git/refs#get-a-reference)
- [npm package metadata](https://github.com/npm/registry/blob/main/docs/responses/package-metadata.md)
