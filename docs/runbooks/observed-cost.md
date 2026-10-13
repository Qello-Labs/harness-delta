# Read an observed task cost estimate

[한국어](observed-cost.ko.md) · [Task procedure](workflow-quickstart.md)

This report prices **eligible stored observations** at an explicit reference rate.
It reads database events, not session files. It starts no product or model request.
`complete_amount` is always null. A partial estimate is not your bill, savings or an adoption result.
Linked root/child/rework events contribute only when their source and interval are eligible.
This report cannot qualify a source or prove that parent/child counters do not overlap.

For the normal flow, use the [supplied reference catalog](reference-price-catalog.md):
`estimate-task` no longer requires `--price-table`. Assigned V2 tasks retain their
frozen comparison table; standalone tasks use the current catalog. The procedure
below is the advanced explicit-table path and remains available for historical estimates.

## 1. Select the rate table

Use the same database as the measured task. Select the table explicitly.
For a pilot with an already registered `prices-1`, skip this registration example.

The checked-in [reference table](../../config/prices/openai-standard-short-2026-10-04.json) is a fixed OpenAI API Standard, short-context snapshot checked on **2026-10-04**.
Its unit is USD per 1,000,000 tokens. `as_of` is the verification date, not the effective-date claim.

| Exact model | Ordinary input | Cache read | Cache write | Output |
| --- | ---: | ---: | ---: | ---: |
| gpt-6-astra | 10 | 1 | 12.5 | 50 |
| gpt-6.1-sol | 2 | 0.1 | 2.5 | 10 |

The source is the [official API pricing table](https://developers.openai.com/api/docs/pricing), Flagship models / Standard / Short context.
The [Astra announcement](https://openai.com/index/gpt-6-astra/) confirms standard input/output rates.
The [Sol announcement](https://openai.com/index/introducing-gpt-6-1-sol/) also confirms its cached-input rate.
The pricing table supplies cache-write rates.
The [Astra model page](https://developers.openai.com/api/docs/models/gpt-6-astra) and [Sol model page](https://developers.openai.com/api/docs/models/gpt-6.1-sol) distinguish long context above 272K input tokens.
This snapshot uses reference rates at or below that boundary.

**Rate notice:** Selecting this table does not prove a request used its service tier or context range.
Fast/Ultrafast, Batch/Flex, long-context and regional rates are not chosen automatically.
API estimates do not measure subscription billing or subscription allowance use.
No model aliases or rate substitutions apply.

1. If this table is the agreed reference, register it.

   ```sh
   node dist/cli.js --db .harness-delta/pilot/local.sqlite price-table register \
     --config config/prices/openai-standard-short-2026-10-04.json
   ```

2. Read its registered contents.

   ```sh
   node dist/cli.js --db .harness-delta/pilot/local.sqlite price-table show openai-standard-short-2026-10-04
   ```

Expected: immutable rates and the selected source/version.
Identical registration is idempotent. Changed content under one ID fails.
For different rates, select a new ID/version prospectively; a frozen protocol keeps its original table.

For another model, provide your explicitly chosen rates or omit the model.
Use the complete `prices.json` example with a new ID/version/source/date, one currency, `unit_tokens`, display policy and exact component rates.
Record the source URL, tier/context scope and verification date beside your local configuration.
A user reference rate is not an official vendor price.
A missing model remains unavailable; do not use another model's price.
The checked-in bounded table deliberately omits `gpt-6-sol` and other models.

## 2. Create the estimate

Prerequisite: authorized task observations already exist in this database.
Replace the task/table IDs if your pilot uses other identifiers.
Capture the UTC cutoff after the observations you intend to include:

```sh
reportCutoff=$(node -p 'new Date().toISOString()')
```

Estimate with the default legacy output-only basis:

```sh
node dist/cli.js --db .harness-delta/pilot/local.sqlite price-table estimate-task task-1 \
  --price-table prices-1 --cutoff "$reportCutoff" --input-basis output-only-v1
```

If you selected the checked-in table instead, replace `prices-1` with `openai-standard-short-2026-10-04`.
This operation estimates existing data; it does not collect additional usage or inspect authentication.

Expected: `partial_amount`, null `complete_amount`, explicit reasons and observation-window evidence.
If the task was deleted, the estimate fails. Deletion does not restore earlier events.
The [workflow comparison report](workflow-quickstart.md#9-create-and-read-the-report) freezes its own assignment/follow-up window.
This task estimate uses task-start/active intervals and cutoff/finalization.
Do not assume the two reports include identical time windows.

## 3. Choose a legacy input basis only when intended

| Basis | Effect |
| --- | --- |
| `output-only-v1` | Price known legacy output; legacy input split stays unavailable |
| `cache-read-remainder-ordinary-v1` | Assume ordinary input is total input minus cached input; price cached input as cache read |

V1 events lack a verified disjoint ordinary/cache-write split.
The remainder basis assumes no separately billed cache writes in that remainder.
Unobserved cache writes have **not** been verified as zero.
Missing total/cache counters withhold the input estimate; cache above total input fails.
Reasoning output is already included in total output. Do not add it again.
V2 events retain their recorded disjoint billing components and attribution with either legacy basis.

If the assumption is agreed, request it explicitly:

```sh
node dist/cli.js --db .harness-delta/pilot/local.sqlite price-table estimate-task task-1 \
  --price-table prices-1 --cutoff "$reportCutoff" --input-basis cache-read-remainder-ordinary-v1
```

Expected: the report names the basis and counts assumed input events.
Compare estimates only when rates, component coverage, input assumptions and windows are comparable.
An output-only estimate is not equivalent to an estimate with assumed input prices.

## 4. Read amount, missingness and coverage separately

| Field/state | Meaning |
| --- | --- |
| `partial_amount` | Eligible priceable components with verified source trust; can contain an explicit input assumption |
| `compatibility_unverified_partial_amount` | Separate estimate from conditional parser/profile reuse |
| `legacy_unverified_partial_amount` | Separate estimate for historical native usage without source provenance |
| `compatibility` | Source/version/parser provenance and trust counts, including invalidated events excluded from amounts |
| `partial_amount: "0"` | Eligible verified priced observations sum to zero |
| `partial_amount: null` | No eligible verified priced amount; unverified estimates may still exist |
| `complete_amount: null` | Complete task cost is unavailable |
| `unpriced_events` | Events with a component withheld from pricing because a rate is missing or required pricing-condition evidence is unavailable or unsupported |
| `unavailable_events` | Events have no priceable partial amount |
| `excluded_event_count` | Stored candidates excluded by the observation-window policy |
| Missing / error / excluded / unmeasurable | Different reading states; none is observed zero |
| `observed_components_priced: true` | Eligible observed components are priceable; whole-task coverage is still unknown |

Read the reasons with each trust bucket. An all-unverified task has null
`partial_amount`, even when an unverified estimate is available. Empty or entirely
unpriceable buckets are null, not zero. Frozen historical reports retain their
original shape; missing provenance is never silently promoted to verified trust.
Usage absence, unknown attribution/components and missing rates must remain visible.
Never add cached/reasoning subsets again or infer parent/child completeness from an aggregate.

The cutoff is exclusive. Events before task start and at/after finalization do not contribute.
Only recorded active intervals contribute. Paused and unobserved intervals are not backfilled.
Explicit loss/error/excluded intervals conservatively exclude events across the task.
Generic incomplete/unavailable coverage retains independently observed eligible events; it does not make them complete.
A candidate Claude out-of-window span can mark its listener window offline and exclude companion events conservatively.

The `coverage` object exposes guarded scope/identity facts, unknown facts and an ineligible decision.
A source-change failure retains an identity violation.
Journals ending after the cutoff cannot prove earlier coverage.
Empty windows have null coverage evidence and an ineligible decision.
Priceability does not establish request-universe completeness or terminal delivery.

## 5. Read a separate sealed instrumented window

The separate instrumented receiver provides before-dispatch/terminal records and
immutable sealed snapshots. Production eligibility requires code-owned
exact-producer qualification and an
authenticated owned launch; a caller-created profile or launch row is not enough.
Conformance without the issuance/launch chain remains
`source_unverified_partial_amount`.
Ordinary Codex logs and historical observations are not promoted by this path.
The first profile is limited to HTTP Responses, `gpt-6.1-sol` / `high`, one fresh
root and at most two lifetime fresh direct children. Unqualified WebSocket,
Guardian, auxiliary, tool/extension or unknown work keeps the run partial;
normal approval and safety behavior must remain enabled.
The reviewed child path is a direct V2 `collaboration.spawn_agent` call with
`fork_turns: "none"`. Code-mode execution, history forks and resumed members
remain partial; the model's default tool mode does not qualify those paths.
Missing token detail is not zero, and an unaccounted dispatched attempt remains unresolved.

The owned launcher starts a registered, unused task itself. Launching an already
active task creates only a work window. Successful process retirement does not
finalize a task: human finalization is required before a later snapshot can
establish whole-task coverage. The instrumented invocation selects HTTP without
overriding the builtin OpenAI provider; other transports remain unqualified.
Native analytics and log/trace/metrics exporters are disabled for that invocation
only. Global settings and normal approval/sandbox policy are not changed.

### Qualify and launch the exact build

Use Node 24, macOS arm64, the exact accepted Rust 1.95.0 toolchain and a populated
Cargo download/Git-object cache. The local checkout must be at the profile's pinned
commit with the shipped `native/instrumented-codex-01621.patch` applied and no other
changes. The qualifier reconstructs its own source and owns a fresh locked,
offline build; it never accepts a caller profile, verdict or claimed executable hash.
Compiler bytes are authenticated before execution, inherited ancestor Cargo
configuration is rejected, and changes to receiver/build inputs invalidate issuance.

Create a location-only JSON file, replacing the synthetic paths:

```json
{
  "checkout_path": "/absolute/reviewed/codex-source",
  "toolchain_path": "/absolute/reviewed/rust-1.95.0-aarch64-apple-darwin",
  "cargo_home_path": "/absolute/reviewed/cargo-cache",
  "build_root_path": "/private/tmp"
}
```

```sh
node dist/cli.js --db .harness-delta/pilot/local.sqlite instrumented-codex qualify \
  --locations locations.json
```

Qualification runs controlled synthetic native scenarios with loopback-only
networking, then stores an immutable build identity and prints its exact binary
path. It makes no paid model request. Interrupts terminate owned process groups
and remove unsuccessful temporary builds.

Register the project and task and confirm the required task configuration before
launch. Use the issued identity/path and the task's current generation:

```json
{
  "schema_version": 1,
  "run_id": "instrumented-run-1",
  "project_id": "synthetic-project",
  "task_id": "synthetic-task",
  "task_generation": 0,
  "build_identity_id": "issued-build-identity",
  "binary_path": "/absolute/issued/build/codex",
  "price_table_id": "registered-prices",
  "duration_ms": 900000,
  "termination_grace_ms": 1000
}
```

```sh
node dist/cli.js --db .harness-delta/pilot/local.sqlite instrumented-codex launch \
  --execution execution.json
```

This command starts the owned native model run and inherits its stdin/stdout.
Only metadata on fd3 enters measurement storage. It rehashes the actual executable;
an unrelated binary, changed file or ordinary binding qualification cannot satisfy
the gate. Runtime duration is a termination limit, not a hard billing bound.
Missing counters, unqualified work or incomplete price coverage still prevent a
complete amount. Prices remain standardized estimates, not proof of a vendor bill.

After the receiver has committed the family seal, replace `run-1` with its run ID:

```sh
node dist/cli.js --db .harness-delta/pilot/local.sqlite price-table snapshot-instrumented run-1 \
  --id instrumented-input-1 --valuation-id instrumented-value-1 --cutoff "$reportCutoff"
```

This command freezes the exact seal and metadata, then values it under the run's
original immutable price pin. It starts no model request. A cutoff before the
seal's durable commit cannot use that seal as earlier evidence.
Without verified launcher evidence, `source_unverified_partial_amount` is separate
and `partial_amount`, `complete_window_amount` and `complete_amount` remain null.

| Field | Meaning |
| --- | --- |
| `coverage_scope: work_window` | The sealed accounting window, not the entire logical task |
| `complete_window_amount` | Available only when every required usage and price fact is established |
| `complete_amount` | Requires whole-task coverage, owned producer retirement and human finalization |
| `source_snapshot_hash` | Immutable seal/metadata identity retained across valuations |

A clean turn or the sum of complete windows cannot erase earlier work or excluded gaps.
The functional pilot still supplies no inferential adoption result.
To revalue exactly the same retained evidence, select an already registered new table:

```sh
node dist/cli.js --db .harness-delta/pilot/local.sqlite price-table reprice-instrumented instrumented-input-1 \
  --id instrumented-value-2 --price-table prices-2
node dist/cli.js --db .harness-delta/pilot/local.sqlite price-table instrumented-valuation instrumented-value-1
```

The original table, snapshot and valuation stay unchanged. New prices cannot repair
missing usage or establish billing. Deletion purges dependent snapshots/valuations
and blocks their resurrection.

## Provenance and verification reference

The JSON includes table contents/hash, deduplicated usage hash, formula `decimal160-disjoint-v1`, report version `observed-cost-v1` and input basis.
It also includes boundaries, event/session counts, assumed input counts and missing/unpriced reasons.
Amounts are decimal strings; rounding is for display.
Observation tables, gap reasons and the versioned window policy participate in the observation-window hash.
The coverage hash binds eligible events, journal metadata, rates and basis; it returns no source paths.

Developer arithmetic/reporting checks are listed in [CONTRIBUTING](../../CONTRIBUTING.md#observed-cost-verification).
They use synthetic fixtures and do not establish production completeness or real experiment effectiveness.
