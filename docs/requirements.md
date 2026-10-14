# Product Requirements

Status: Intended behavior, not an implementation or support claim. The current
repository implements local lifecycle/storage, scoped partial CLI collection,
and descriptive task/period reports. Complete product coverage and statistical
methods still need validation. See the local runbook and capability matrix.

This document is the public source of product acceptance requirements. Changes to
requirements, collection scope, or public contracts require an explicit decision.
Personal plans may organize implementation but must not silently redefine these rules.

## R01 - Local operation and scope

The tool measures metadata and outcomes for real development tasks. Local operation
must work without GitHub or a central server. Target integrations are Codex app/CLI
and Claude Code, isolated behind product adapters; target status does not imply support.
Collect only while the measurement CLI runs and only when the project is registered,
the measurement task is active, and the session is linked. A session is linked
explicitly, or at run level when the measurement CLI launched its product process
and a per-process credential binds that process's telemetry to one project, task,
and run. Session identifiers that the process later reports under the same
credential, in sequence order (for example, after a reset), stay linked to that run.
Run-level linkage authorizes only credential-authenticated telemetry received by
the CLI's loopback receiver; opening transcript, rollout, or other session files
still requires an explicit session and source mapping. Usage of nested product
processes is never accepted under the parent process's credential; without their
own credential it is missing, not zero. Desktop, IDE, and launcher-owned sessions
are not linked this way. Installation must not start collection or transmission.
Unlinked sessions are out of scope.

Acceptance: unrelated projects, inactive tasks, and unlinked sessions contribute
no contents or usage; each receiver rejects telemetry without its own valid,
unrevoked process credential before decoding, and never stores or logs request
headers or rejected bodies; restarting does not automatically backfill the offline
interval.

## R02 - Data minimization and capability evidence

Exclude prompt, response, and source-code contents from measurements, fixtures,
diagnostics, exports, and central storage. Shared data must also exclude secrets,
actual local paths, and free-text completion criteria; share criterion IDs and
fulfillment states instead. Use explicit allowlists and synthetic fixtures.

Determine scope before reading session contents. Verify source formats, permissions,
product versions, counter meanings, resumes, compaction, resets, rotation, parent/child
relationships, and pause boundaries. Mark unsupported or ambiguous capabilities
explicitly. A source that cannot establish scope before access is unsupported.

Acceptance: private fields are rejected at sharing boundaries; unsupported sources
and uncertain intervals cannot be reported as successfully measured data.

### Forward-version compatibility policy (accepted 2026-10-08)

For ordinary local measurement, a newer regular release within a reviewed,
source-specific compatibility window may reuse the previous verified parser
before exact-version qualification. Apply the same scope, privacy, identity and
counter checks. Passing those checks permits a compatibility-unverified reference
estimate, not verified support. A known incompatible version or failed required
contract stops the affected observation and invalidates its uncertain data.
File-parser compatibility does not establish native execution compatibility.

Preserve actual product version, applied parser/profile revision, compatibility
rule revision and trust state in observations and supported reports/exchanges.
Keep unverified estimates separate from verified aggregates and cost claims;
missing or invalidated data must not become zero. A later incompatibility must
invalidate the affected version/parser cohort unless a narrower reliable boundary
can be established. New qualification is prospective, with no silent promotion
of historical observations or backfill. Frozen experiments keep R09's exact
versions and deviation policy; fallback does not authorize inference under R10.

Acceptance: in-window parser reuse, out-of-window/blocked-version rejection,
runtime contract failures, provenance, separate totals and later invalidation
have explicit evidence before fallback is enabled. This policy is implemented
with finite source-specific windows and conservative historical provenance. See [ADR 013](decisions/013-forward-version-compatibility.md).

## R03 - Task lifecycle and outcomes

A task has fixed completion criteria and may contain attempts, sessions, child
sessions, and rework. Register its type, expected size, assignee, product/model,
and criterion IDs before starting. Expected complexity is optional, not an observed fact.
Support start, pause, resume, first-completion declaration, and finalization.
Human assessment determines success/failure/abandonment and criterion fulfillment;
CI success alone must not finalize a task. Distinguish first-attempt success from
final success. Changes needed to meet existing criteria are rework; new requirements
form a new task. Do not retroactively replace the original criteria.

Acceptance: invalid transitions fail; finalization is immutable; first completion,
rework, and final outcome remain distinguishable.

## R04 - Usage integrity and durable storage

Use a local transactional store with versioned migrations, relationship constraints,
and idempotent source identifiers. Conflicting payloads must not silently overwrite
existing events. Preserve zero separately from missing, error, excluded, and
unmeasurable readings. Verify cumulative versus incremental counters before aggregation.
Do not count cached input or reasoning output twice when included in parent totals;
do not double-count parent/child usage. Use UTC timestamps, nonnegative safe-integer
tokens with overflow rejection, and decimal strings for shared monetary amounts.

Acceptance: restart, replay, duplicate source keys, conflicting events, and rollback
have explicit tested behavior; native-binding smoke tests are not store acceptance.

## R05 - Observation completeness and operational metrics

Exclude paused and uncertain intervals without imputing usage. Retain partial usage
as partial, not a complete task total. Keep model runtime, user elapsed time, and
summed parallel-session time distinct; elapsed time is not human labor time.
Estimate monetary cost only with a recorded rate source, model, effective date,
currency, and calculation version; it is not a subscription bill.

Successful-task usage divides all eligible usage, including failures and rework,
by the number of successful tasks. No successful tasks means undefined, not zero.

Acceptance: reports distinguish missing cost, partial observation, failed tasks,
and undefined denominators without silently converting them to zero.

## R06 - Period comparisons and reproducible reports

Support observational period comparisons with a preregistered task-start cohort
window and task follow-up period. Incomplete follow-up makes the report provisional.
Disclose task composition, products/models, outcomes, missingness, and uncertainty;
do not claim a causal effect from period differences.
Generate JSON/Markdown reports from a fixed data snapshot and versioned settings.

Acceptance: the same synthetic data and settings reproduce results; empty cohorts,
cross-boundary tasks, and incomplete follow-up are handled explicitly.

## R07 - Deletion, retention, and exchange

Support task/project deletion and explicitly configured retention; do not invent
a default deletion period. Retention cleanup runs only during CLI execution.
Use opaque tombstones to prevent deleted records returning through old imports or
queued sync. Removing tombstones requires a retired-namespace import policy.
Versioned file exchange and optional central sync must share a data contract and
detect duplicates and conflicts. Local deletion does not erase previously exported files.

Acceptance: deletion removes the task's related data transactionally, unspecified
retention fails clearly, and old imports cannot resurrect deleted records.

## R08 - Optional integrations and central service

GitHub Issue/PR/Actions integration is optional and read-only. Central transmission
requires explicit per-project enablement and destination; historical uploads require
a separate command. Local work continues during central outages. Central deletion
requires a separate request and confirmed result.
The initial proposed server is a single-team, single-process SQLite service with
hashed administrator-issued bearer tokens and project permissions. Validate locally;
public deployment, public signup, and billing are out of scope.

A loopback receiver that the measurement CLI starts for one launched product process
is a local collection boundary under R01, not an integration or central service.
It listens only on a loopback interface, accepts only that process's credential,
forwards nothing to any other destination, and stops accepting data when the
credential is revoked at pause, finalization, or deletion. The CLI enables product
telemetry only through per-invocation settings of the launched process, points
every exporter it can configure at that receiver or turns it off, and never edits
global, user, or project configuration. A product can pass its telemetry enable
setting and some tracing settings, but not its `OTEL_EXPORTER_OTLP_*` exporter
destinations or the receiver credential, to processes it starts. A nested
product process can therefore export to a destination named by its own
configuration; an export that reaches the receiver without the credential is
rejected before decoding. This is a known limitation: the CLI does not configure,
accept, or measure that export, and the nested process's usage remains missing.
See the bounded [launch-settings evidence](decisions/006-otel-usage-source.md#launch-settings-follow-up-3).

Acceptance: unauthorized reads/writes/deletes fail, retries remain idempotent, and
central failure does not block local measurement.

## R09 - Randomized task comparisons

Keep randomized-task and observational-period modes separate. Randomize once per
task before execution; attempts and child sessions retain that assignment. Never
implement the same task twice just for comparison. Freeze eligibility, classification,
participants, versions/manifests, product/model settings, allocation method/ratio,
primary and quality metrics, margins, sample plan, follow-up, stopping rules,
missingness policy, confidence level, and analysis version before starting.
Do not fill missing real experiment inputs with invented defaults.

A v2 `functional_pilot` checks assignment, collection and reporting on useful
work without evaluating harness effectiveness. It retains the operational
protocol settings and exact production source gates, but forbids `minimum_effect`,
`quality_margin` and `confidence_level`. Both existing purposes retain their
required fields. Functional reports explicitly identify `functional_only` and
`not_applicable` adoption; they cannot produce primary arm means, relative savings
or inferential decisions, including if future complete-cost evidence is available.
A frozen purpose is immutable; a later effectiveness study needs its own accepted
protocol and validated analysis. Functional protocols are not admitted to the
current synthetic-only exchange lane.

Ordinary descriptive observation is separate from both comparison modes. It
prepares a task from a registered project's defaults and explicit criterion IDs
before work starts, with no protocol, allocation or arm. Such a task holds no
assignment and yields no arm means, savings or adoption decision. R01 scope, R02
capability evidence, R03 human outcomes, R05 partial usage and the delivery
gates apply unchanged. Preparing an ordinary task doesn't establish source
support. See [ADR 016](decisions/016-ordinary-observation.md).

The initial allocation proposal is balanced 1:1 blocks with fixed size/strata and
one authoritative allocator per stratum. Persist before revealing the assignment;
keep future allocations hidden. Detect conflicting allocators and reassignment
attempts. Imports and restarts must not reassign tasks. Record actual configuration
and deviations without claiming perfect isolation from global settings or learning.

Acceptance: incomplete protocols cannot freeze; assignment and configuration
deviations remain auditable across restarts and file exchange.

## R10 - Analysis validation and decision limits

Validate analysis methods against synthetic known-effect, null-effect, unequal
missingness, small-sample, ratio, and incomplete-block cases before implementing
inferential comparisons or starting an experiment. Account for allocation blocks,
repeated users, and time dependence. Tasks, not calls or sessions, are analysis units.

Analyze by original assignment; actual-configuration analysis is supplementary.
Show counts, distributions, quality, missingness, deviations, sensitivity results,
and uncertainty. Complete-case usage is not the full randomized population.
Change rates use (modified mean - baseline mean) / baseline mean; zero baseline
is undefined. Do not compare unequal group totals as a savings rate.
Adoption requires both preregistered practical savings and quality criteria;
insufficient precision or excessive missingness requires an inconclusive result.
No opportunistic early stopping without a registered sequential method.

Acceptance: quality uncertainty and small samples cannot become confident savings
claims; reported conclusions disclose their population and observation limits.

## R11 - Operational diagnostics

Add versioned, task-scoped diagnostic metrics alongside usage and human outcomes.
Initially prioritize deduplicated confirmed tool executions, execution failures,
and elapsed/active task time. Preserve denied, cancelled, validation-failed and
unknown outcomes separately. Define the counting boundary so wrappers, nested
operations, event replay, and start/completion pairs are not silently added twice.
Search/read and first-edit/test/oracle milestones require validated structured
classification and attribution. Exact duplicate reads and context expansion are
deferred until file/revision/range/context identity or explicit router events exist.

Acceptance: known counts and elapsed intervals match synthetic arithmetic; denied
calls do not count as execution failures; missing data never becomes zero. Reports
show metric-specific coverage and retain all eligible tasks, including failures
and partial observations. These diagnostics do not replace quality criteria or
prove an adoption decision. See [the observation contract](decisions/003-local-observation-contract.md).

## Delivery gates and open decisions

1. Verify adapter sources and collection boundaries before claiming product support.
2. Validate contracts, storage, lifecycle, collection, metrics, deletion, and period
   reports before treating local measurement as usable.
3. Build sharing/integrations on those contracts; validate analysis before inference.
4. Verify end-to-end scenarios and explicit experiment inputs before real experiments.

Statistical packages, actual experiment inputs, publication name/channel, and remote
deployment are not established by this document. The repository's existing MIT
license applies. Completing scaffolding does not complete any product gate.

## Flexible runtime comparison (version 2)

A registered logical task retains its original randomized harness assignment when
models, reasoning effort, retries, or linked sessions change. Version 1 fixed
configuration protocols and report serialization remain supported. Version 2
requires an immutable single-currency price table, observation followup, sample
planning basis, minimum effect and quality margin as explicit protocol inputs.
Strata identify one responsible assignee; realized model is descriptive metadata,
not an adjustment variable for the policy effect.

Runtime evidence records nullable model/effort and its source and boundary.
Unknown attribution, missing components and unpriced models produce unavailable
cost, never observed zero. Measurement excludes prompt, response and source text.
Standardized estimated cost is distinct from bills, subscriptions and labor.
Synthetic candidate parsing does not admit a production source, prove complete
coverage or enable inference. Real allocation, complete cost and inference require
separate validated evidence and remain closed without it.
