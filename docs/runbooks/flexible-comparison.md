# Flexible model comparison workflow

The v2 workflow keeps a task's original A/B harness assignment when model or
reasoning effort changes. Runtime choices are descriptive policy outcomes; they
never allocate another task or reset followup. V1 fixed configuration and frozen
reports remain readable unchanged. Use Node 24 or 26 and `npm run build`.

## Inputs and scope

For synthetic checks, use a dedicated synthetic store. For the functional pilot, use
a different dedicated database and the [task procedure](workflow-quickstart.md).
Registration and offline synthetic tests require
no product executable or model request. The production registry admits two separate Codex 0.160.0 profiles:
[the root workflow](../validation/codex-workflow-01600-source-readiness.md) and
[the fresh root/single-direct-child workflow](../validation/codex-workflow-01600-direct-child-source-readiness.md).
[Conditional workflow versions](task-native-workflow.md#conditional-forward-versions)
are additionally eligible for functional pilots with unverified trust.
Both exact profiles collect partial own-response usage and have no complete cost. The child
profile requires read-only permissions and does not support family resume.
A v2 protocol accepts one profile per product/version, so choose one Codex profile
for that protocol. Claude Code 2.1.296 is admitted for parent-only launch and resume
(`claude-workflow-own-trace-v1`; 2.1.288 and 2.1.291 are retired) and, as a separate profile, for a read-only root with one direct child (`claude-workflow-direct-child-v1`). Candidate parsers for Codex CLI 0.158.0 and Claude Code 2.1.283 are
synthetic test candidates, not admitted sources. The existing v1 partial adapters
remain separate. No desktop/app support or complete usage is inferred.

Register v2 variants with `schema_version: 2`, `id`, `harness_version`,
`instruction_manifest_hash`, `policy_version`, `policy_status: eligible` and
`runtime_policy: flexible`. These variants have no fixed product/model/effort.
Use identifiers and hashes only, never instruction text or source paths.

A v2 protocol retains the [existing required protocol fields](task-comparison.md#preregister-and-freeze-the-protocol),
with `schema_version: 2`, `primary_metric: standardized_cost`,
`runtime_policy: flexible`, `estimand: registered_task_mean`, `price_table_id`,
`planning_basis_id`, `collaboration_policy_id` and explicit `source_profiles`.
Each source profile contains product, exact product_version and profile_id. For
synthetic validation use synthetic / 1.0.0 / synthetic-flexible-v1. Each stratum
contains exactly one assignee. planning_basis_id must match sample_plan.planning_basis_id.
Participants, environments, followup, recruitment dates, missingness, sample plan
and analysis/sensitivity labels remain required user selections. For the existing
`synthetic_validation` and `real_experiment` purposes, `minimum_effect`,
`quality_margin` and `confidence_level` are also required. Use v2
`purpose: functional_pilot` for a functional check; these three effect inputs
must be absent. It accepts exact admitted workflow sources and the separately labeled
[conditional forward versions](task-native-workflow.md#conditional-forward-versions);
inference is always unavailable. Reports mark
`evaluation_status: functional_only` and `adoption.status: not_applicable`, with
null primary arm complete means and relative change. Descriptive partial means,
counts, task costs and human criteria remain available; no superiority or
confidence interval is calculated. Existing protocols/reports retain their shape;
functional protocols remain outside synthetic-only file exchange.
The reference catalog can supply a price basis at CLI registration when
`price_table_id` is omitted. Duration, savings targets and sample counts remain
explicit protocol choices. The stored protocol always pins an immutable table.
Freeze before recruitment. Cost and coverage use [assigned_at, min(cutoff, followup_ends_at)); a delayed task start never removes earlier gaps. Active and elapsed time start at task start. Assignment and usage/evaluation endpoints are half-open.

Task creation through comparison assignment uses schema_version 2 and task
metadata schema_version 2 with initial_model nullable, replacing v1 model.
The flag-based task register command remains v1. Null means unknown, not zero.

For a first useful task, follow the [task procedure](workflow-quickstart.md)
([한국어](workflow-quickstart.ko.md)). Its complete synthetic example set includes
prices, both variants, instructions, a functional protocol and execution configs.
Replace all operational choices before registration; keep incomplete drafts separate.
Before an actual run, approve the project/task/profile, pinned binary and implementation
identity, artifact manifests, runtime/sandbox, work-product destination, invocation
count, timeout, no-retry rule and teardown. Previous qualification consent is consumed.
Offline preparation starts no product, does not read authentication and grants no
permission to commit, publish or run a model. Public fixtures remain synthetic.

## Immutable prices and commands

For the normal flow, use the [reference catalog](reference-price-catalog.md).
For an explicit historical or user-selected basis, provide a strict price-table JSON file with id, version, currency (three uppercase
letters), source_id, as_of (UTC), positive integer unit_tokens, display_decimals,
rounding: half_even, and entries. Each entry contains product, model, component
(ordinary_input/cache_read/cache_write/output) and a nonnegative decimal string
price_per_unit. Duplicate keys and changing an existing table ID are rejected.
Explicit-table registration never fetches prices. The catalog has a separate
approved refresh command; refresh does not change existing protocol pins.

```sh
node dist/cli.js --db .harness-delta/demo/local.sqlite price-table register --config prices.json
node dist/cli.js --db .harness-delta/demo/local.sqlite price-table show prices-1
node dist/cli.js --db .harness-delta/demo/local.sqlite variant register --config variant-a.json
node dist/cli.js --db .harness-delta/demo/local.sqlite variant register --config variant-b.json
node dist/cli.js --db .harness-delta/demo/local.sqlite comparison register --config protocol.json
node dist/cli.js --db .harness-delta/demo/local.sqlite comparison freeze comparison-1
node dist/cli.js --db .harness-delta/demo/local.sqlite comparison assign --config assignment.json
node dist/cli.js --db .harness-delta/demo/local.sqlite task config-history task-1
node dist/cli.js --db .harness-delta/demo/local.sqlite comparison readiness comparison-1
node dist/cli.js --db .harness-delta/demo/local.sqlite report task task-1 --cutoff 2027-01-02T00:00:00Z
```

Create the local directory and register the project first, as in the existing
runbook. Replace identifiers and cutoff with your selected inputs. CLI commands
register and report metadata; they never launch model tasks automatically.
Synthetic runtime/session injection is test-only, not a production link bypass.

## Meaning of the results

Cost is a standardized estimated amount under the embedded immutable table and
formula, not actual billing, subscription savings or labor cost. Disjoint billing
components are priced once; cached and reasoning tokens are not added twice.
Ambiguous model transitions and unpriced models have null complete amounts and
fixed reasons. Known priced components can contribute descriptive partial cost.
Decimal160 arithmetic retains guard digits for repeating divisions; display uses
half-even rounding after aggregation. See [cost coverage](../decisions/flexible-cost-coverage.md).

Each original assignment remains in its arm: successful, failed, aborted,
not started and outcome missing. Followup pending remains provisional. Any
incomplete task suppresses the whole-cohort primary mean and relative change;
partial means are descriptive. Zero baseline and empty arms have no ratio.
Quality criteria, first success, rework, active time and elapsed time are separate.
Elapsed time is not human labor. Frozen snapshots preserve cutoff, receipt-time
boundary, actual price contents/hash and formula. Late arrivals require a new
revision and never mutate an earlier report.

New snapshots use descriptive version `flexible-cost-descriptive-2`. It adds a
task `late_outcome` (status and assessment time) for an outcome assessed at or after
the follow-up deadline and before the cutoff, and an arm `late_outcome_count`.
These are disclosures only: the task's deadline status stays `outcome_missing`,
and rates, means and adoption reasons are unchanged. Snapshots stored with
`flexible-cost-descriptive-1` keep their original shape and remain readable.

The [file exchange workflow](team-file-exchange.md) also accepts v2 data packages.
Only allowlisted task metadata, runtime summaries and cost provenance are shared;
local sessions, requests, event identities and detailed runtime history are omitted.
V1 deletion notices invalidate either data version. Same-ID price conflicts
quarantine the protocol. Deletion and retention purge derived cost/runtime/header
and team snapshots and reject replay. Team completeness and historical team
assignment denominator remain unavailable even when all declared writers respond.

## Preparation gates and followup

Readiness reports real_allocation, complete_cost and inference independently.
The exact Codex 0.160.0 `codex-workflow-own-response-v1` and separately admitted
`codex-workflow-direct-child-v1` sources permit real local allocation and partial
collection for a complete frozen v2 protocol, within each profile's supported
scope. Their shared native engine has operational evidence; ordinary assigned
CLI wiring has offline evidence; later bounded root workspace-write pilots also
exercised actual assigned execution. The first failed configuration scope and the
subsequent untrusted launch passed its monitored checks; see
[the evidence distinction](../validation/codex-workflow-01600-source-readiness.md#later-bounded-functional-observations). Unmatched
profiles, mixed unqualified products and invalidated protocols remain closed.
The analysis registry is empty. Whole-task cost facts remain unknown without a
validated complete producer. Synthetic test inputs do not become real experiment
inputs; create a dedicated store with the user's explicit choices and use
[the Codex or Claude native workflow commands](task-native-workflow.md), not the generic file collector.
Complete cost also requires all metric/window facts, while inference additionally
requires an approved method. Neither completeTotals nor causal adoption is enabled.
See the [analysis boundary](../validation/flexible-cost-analysis-boundary.md).

Further validation requires separate approval: additional exact source versions,
model/effort combinations beyond the tested start/resume pair, request retries,
child topologies or operations beyond the admitted fresh-root/single-direct-child
profile, including family resume, compaction, terminal accounting and durable
flush. Claude Code 2.1.296 separately admits a fresh read-only parent with at most
one fresh read-only `workflow-child` under `claude-workflow-direct-child-v1`.
Deeper, additional, background, isolated or editing children, child resume and
conditional-version child execution remain unsupported. Later validation also needs a
continuous-cost/repeated-person method and selected experiment
inputs. Registration and reporting commands do not launch products, change
authentication or invent an actual experiment. Native launch/resume require the
separate explicit workflow execution commands and their guarded configuration.
