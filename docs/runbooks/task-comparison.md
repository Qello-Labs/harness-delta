# Local task comparison workflow

[한국어](task-comparison.ko.md)

Contributors can exercise configuration registration, durable allocation, manual
application evidence, human outcomes and assignment reports using synthetic tasks.
**V1 real randomized experiment allocation is disabled.** V2 supports the limited
[native workflow profiles](task-native-workflow.md) with explicit user inputs and
partial usage only. Complete cost and inference remain unavailable. The complete team workflow,
real-data file exchange, method validation and validated inference remain gated.
Separate [synthetic file exchange](team-file-exchange.md) is implemented. Existing
local measurement continues under its own [runbook](local-measurement.md).
See [ADR 008](../decisions/008-task-comparison-workflow.md) and
[requirements R09/R10](../requirements.md#r09---randomized-task-comparisons).

Use Node 24 or 26, install with `npm ci`, then `npm run build`. Commands below use
`node dist/cli.js`; an installed package uses `hm`. Keep the database and example
input files in an ignored local directory such as `.harness-delta/comparison-demo/`.
Create that directory before writing the input files. Use a dedicated synthetic
store. No product executable, server, Docker, worktree,
model request, installation of a harness or setting changes are needed.

## Register configuration

Write `variant-a.json` with this **synthetic** input:

```json
{
  "schema_version": 1,
  "id": "variant-a",
  "harness_version": "a-v1",
  "instruction_manifest_hash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "product": "synthetic",
  "product_version": "1.0.0",
  "model": "synthetic-model",
  "reasoning_setting": "none",
  "policy_version": "synthetic-policy-v1",
  "policy_status": "eligible"
}
```

Write `variant-b.json` with `id: variant-b`, `harness_version: b-v1` and a different
64-character lowercase hexadecimal manifest hash. Keep runtime settings identical.
These artificial hashes exercise registration only; they are not real A/B manifests.

```sh
node dist/cli.js --db .harness-delta/comparison-demo/local.sqlite project add demo --root .
node dist/cli.js --db .harness-delta/comparison-demo/local.sqlite variant register --config .harness-delta/comparison-demo/variant-a.json
node dist/cli.js --db .harness-delta/comparison-demo/local.sqlite variant register --config .harness-delta/comparison-demo/variant-b.json
node dist/cli.js --db .harness-delta/comparison-demo/local.sqlite variant show variant-a
```

For eventual real use, A is a reviewed version of the existing harness and B a
reviewed navigation instruction manifest. Register metadata here; keep Repo Map
indexes and navigation tools in their source project. Do not copy instructions,
source identifiers, prompts, responses, criterion text or paths into these inputs.
Registering a version does not register its usage adapter or enable experiments.

## Preregister and freeze the protocol

Write `protocol.json` using this synthetic contract example. **Replace both UTC
recruitment dates with your intended validation interval before registering.**
Freeze before its start; assign during `[recruitment_start, recruitment_end)`.
All metric/sample/margin values below are synthetic inputs, not recommendations
for a real experiment. To revise any registered draft, use a new protocol ID.

```json
{
  "schema_version": 1,
  "id": "demo-comparison",
  "project_id": "demo",
  "team_id": "demo-team",
  "mode": "randomized_task",
  "purpose": "synthetic_validation",
  "protocol_version": "protocol-v1",
  "eligibility_version": "eligibility-v1",
  "classification_version": "classification-v1",
  "participants": ["user-1", "user-2"],
  "environment_ids": ["environment-1", "environment-2"],
  "variant_ids": ["variant-a", "variant-b"],
  "recruitment_start": "2030-01-01T00:00:00Z",
  "recruitment_end": "2030-01-02T00:00:00Z",
  "allocation_method": "balanced_blocks",
  "allocation_version": "balanced-blocks-v1",
  "allocation_ratio": [1, 1],
  "block_size": 4,
  "strata": [{
    "id": "stratum-1",
    "assignees": ["user-1", "user-2"],
    "types": ["feature"],
    "sizes": ["small"],
    "allocator_id": "allocator-1"
  }],
  "primary_metric": "input_total",
  "quality_metric": "criterion_fulfillment",
  "quality_margin": 0.05,
  "minimum_effect": 0.1,
  "sample_plan": {"target_tasks": 8, "planning_basis_id": "synthetic-basis"},
  "followup_seconds": 3600,
  "stopping_rule": {"kind": "fixed_recruitment", "version": "stopping-v1"},
  "missingness_policy": {
    "version": "missingness-v1",
    "max_usage_missing_rate": 0.1,
    "max_outcome_missing_rate": 0.1
  },
  "deviation_policy": {"mismatch": "continue", "unknown": "continue", "version_drift": "stop"},
  "confidence_level": 0.95,
  "analysis_plan_version": "synthetic-analysis-v1",
  "sensitivity_plan_ids": ["synthetic-sensitivity"]
}
```

```sh
node dist/cli.js --db .harness-delta/comparison-demo/local.sqlite comparison register --config .harness-delta/comparison-demo/protocol.json
node dist/cli.js --db .harness-delta/comparison-demo/local.sqlite comparison freeze demo-comparison
node dist/cli.js --db .harness-delta/comparison-demo/local.sqlite comparison show demo-comparison
```

Missing inputs cannot freeze. Invalid/overlapping strata, unavailable participants,
ineligible variants and unmatched runtime settings fail. `real_experiment` drafts
may be recorded/frozen for review, but v1 allocation always rejects them; no readiness
flag overrides R10. These operations do not validate analysis or start collection.

## Preregister a task and reveal its persistent assignment

Write `task.json` before execution:

```json
{
  "schema_version": 1,
  "protocol_id": "demo-comparison",
  "project_id": "demo",
  "logical_task_id": "logical-task-1",
  "task_id": "task-1",
  "alias_ids": ["known-alias-1"],
  "metadata": {
    "type": "feature",
    "expected_size": "small",
    "assignee": "user-1",
    "product": "synthetic",
    "model": "synthetic-model",
    "criterion_ids": ["criterion-1"]
  },
  "environment_id": "environment-1",
  "code_base_commit": "cccccccccccccccccccccccccccccccccccccccc",
  "allocator_id": "allocator-1"
}
```

```sh
node dist/cli.js --db .harness-delta/comparison-demo/local.sqlite comparison assign --config .harness-delta/comparison-demo/task.json
```

The example code commit is synthetic. Real registration will use its actual code
baseline separately from the harness manifest. Assignment can atomically register
a task or attach an identical already registered, unstarted task. The receipt is
printed after commit and includes one assigned variant, assignment ID and fixed
deadline. Re-running the same command returns it with `reused: true`.

Reuse the declared identity for retries/rework. Declare known aliases before
allocation; alias registration returns the canonical task. New requirements need a
new task/criteria/identity. The tool cannot detect undeclared semantic duplicates.
A conflict discovered after separate assignments blocks the affected protocols.
Do not copy the SQLite file to create another authoritative writer.

## Confirm application and record human outcomes

Read the assigned configuration, manually apply its reviewed instructions and start
a fresh task session. This synthetic example exercises declarations without a
product session. Write `confirmation.json` with the **assigned variant from the
receipt** and, optionally, an occurrence time at/after assignment and no later than now.
Omitting `occurred_at` captures the invocation time:

```json
{
  "schema_version": 1,
  "id": "confirmation-1",
  "task_id": "task-1",
  "occurred_at": "2030-01-01T00:00:00Z",
  "evidence_method": "self_attested",
  "actual_variant_id": "variant-a",
  "product": "synthetic",
  "product_version": "1.0.0",
  "model": "synthetic-model",
  "reasoning_setting": "none",
  "environment_id": "environment-1"
}
```

```sh
node dist/cli.js --db .harness-delta/comparison-demo/local.sqlite task confirm-config --config .harness-delta/comparison-demo/confirmation.json
node dist/cli.js --db .harness-delta/comparison-demo/local.sqlite task config-history task-1
node dist/cli.js --db .harness-delta/comparison-demo/local.sqlite task start task-1
node dist/cli.js --db .harness-delta/comparison-demo/local.sqlite task first-complete task-1
node dist/cli.js --db .harness-delta/comparison-demo/local.sqlite task assess-first task-1 --result success
node dist/cli.js --db .harness-delta/comparison-demo/local.sqlite task finalize task-1 --outcome success --met criterion-1
```

Use nullable actual fields for explicit unknown configuration. New confirmations use
new IDs; prior evidence is immutable. Matching declarations are `confirmed` with
`self_attested` evidence, not mechanically verified. Crossover remains in the
original assignment. Frozen mismatch/unknown policies can stop the task; runtime
drift pauses measurement and cannot automatically reassign the old task. Finalizing as `aborted` records a cancellation deviation while preserving the
assignment. Human assessment determines completion; CI alone cannot finalize it. Use the existing
`pause`, `resume` and `rework` commands as appropriate.

Optional selected-artifact verification uses `evidence_method: selected_artifact_hash`
and `--artifact instructions=path/to/instructions.md`. Only explicitly supplied
instruction files are read (1–256 unique artifact IDs, each at most 1 MiB); paths and
contents are never retained. The manifest is SHA-256 of UTF-8 compact JSON containing
`[{"artifact_id":"instructions","sha256":"<file-sha256>"}]`, sorted by artifact ID
in code-point order. Use lowercase hexadecimal hashes. The check describes current
files, omit `occurred_at` so the invocation captures the check time. If supplied through
the API it must equal `confirmConfiguration`'s timestamp; earlier occurrences are
valid only for self-attestation. Product/model/global settings remain declarations.

The synthetic CLI deliberately cannot `session link` a synthetic product or read a
real session in this validation store. Test fixtures inject synthetic usage only in
tests. Ordinary Codex/Claude collection remains separate. The v2 native paths use
`workflow codex` or `workflow claude launch`, with their own
[admission and conditional-version boundaries](task-native-workflow.md).
The generic file path permits exact profiles or eligible conditional parser reuse;
conditional estimates remain `compatibility_unverified`. It requires an explicit
task/session/source map, a running collector and confirmation linkage
(`session link --confirmation`).
Neither assignment nor confirmation reads session contents or backfills earlier usage.

## Create a synthetic assignment report

After following the synthetic registration/allocation steps above, choose a cutoff
no later than the current time. The dates below match the artificial 2030 example;
replace the cutoff with the endpoint for your adjusted validation dates, and invoke
after that cutoff. Snapshot creation reads only stored allowlisted metadata. A task
with no injected usage has missing usage, never zero. The CLI provides no synthetic
source reader or fixture-injection command.

```sh
node dist/cli.js --db .harness-delta/comparison-demo/local.sqlite comparison snapshot create demo-comparison --id demo-report-1 --cutoff 2030-01-02T02:00:00Z --reason initial
node dist/cli.js --db .harness-delta/comparison-demo/local.sqlite comparison report demo-report-1 --format json
node dist/cli.js --db .harness-delta/comparison-demo/local.sqlite comparison report demo-report-1 --format markdown
node dist/cli.js --db .harness-delta/comparison-demo/local.sqlite comparison report demo-report-1 --format markdown-readable
```

`json` remains the default. Existing `json` and `markdown` output and stored
snapshot bytes are unchanged. For V1, opt into `markdown-readable` for tables drawn from
the same frozen report: original-assignment cohorts, partial component task n and
distributions, follow-up, human quality, rework, composition, declared configuration
and deviations. The reading-state table counts events, not tasks. Project
registration activity does not establish an eligibility denominator.

Partial-usage task counts and tasks with a combined token value can differ; input
and output subsets can also differ. `unavailable` preserves null, while observed
zero is displayed as 0. These subsets cannot establish full-task savings or
practical equivalence. Invalidated reports show their reason and unavailable
original cohort without rebuilding removed aggregates. Rendering neither collects
new data nor enables inference or real experiments.

Create these reports **before deleting the task** in the following example. Otherwise
the protocol is already invalidated and snapshot creation rejects it. Retry with the
same report ID and identical options returns the frozen result. Changing an option
under that ID conflicts. Later evidence creates a new ID:

```sh
node dist/cli.js --db .harness-delta/comparison-demo/local.sqlite comparison snapshot create demo-comparison --id demo-report-2 --cutoff 2030-01-02T02:00:00Z --supersedes demo-report-1 --reason evidence_updated
```

Use `late_arrival` for newly received observations at the same cutoff,
`evidence_updated` for other new evidence at the same cutoff, or `cutoff_advanced`
with a strictly later cutoff. Noninitial revisions require a valid parent for the
same protocol; `initial` cannot have a parent. Evaluation time is captured by the CLI;
it cannot be supplied as historical knowledge time. Existing usage receipt times
from older databases remain unknown, not fabricated during migration.

Read the `total`, original-assignment `arms`, `deadline_counts`, composition,
incomplete `blocks` and supplementary `actual_configuration_summary`. The deadline
success denominator includes all assigned tasks, including never-started and
outcome-missing tasks. It is null while any follow-up is pending. Recruitment/follow-up
still open makes the report provisional even when a task finalized early. Events and
assessments exactly at cutoff/deadline are excluded from the half-open endpoint.
Pause/resume/rework never move the deadline. Original assignment always remains;
actual A/B/other/mixed/unknown histories are supplementary declarations, with runtime
uncertainty/drift shown separately. Project registration counts are context, not
inferred eligibility or randomized sample units.

Partial distributions identify their observed-task denominator; complete totals,
cost, savings, confidence intervals, p-values and adoption remain unavailable. A
passing synthetic report does not enable `real_experiment` allocation or establish
R10 analysis validity. Assignment, confirmation and reporting authorize no session
read: exact source profiles or permitted conditional parser reuse, registered
project, active task, explicit session/source linkage and a running collector still
govern ordinary measurement. Conditional estimates remain separate from verified usage.

Deleting a contributing task, applying configured retention, deleting its project,
or discovering an identity conflict purges all affected managed snapshots and their
hashes/dependencies. Old IDs return an invalidated envelope; no original arm counts
are retained or reconstructed. Deleting an unassigned registration contributor can
also invalidate a report. The CLI discloses affected report IDs before purge; only
opaque tombstones survive. Saved output/backups remain outside that deletion.
Report IDs cannot be reused. Snapshot imports and synthetic team exchange cannot
restore deleted scopes; tombstones reject replay. Allocator-authority bypass is
unavailable. See ADR 008 for the full time, revision and deletion contracts.

## Inspect and delete

Existing task reports continue to show missing/partial usage, never a full randomized
endpoint or adoption result. A synthetic task without injected observations has
missing usage, not zero. Synthetic assignment reports are available as described above. Separate synthetic
team exchange is implemented; real-data sharing, network transmission, validated
inference and v1 real allocation remain unavailable.

```sh
node dist/cli.js --db .harness-delta/comparison-demo/local.sqlite delete task task-1
node dist/cli.js --db .harness-delta/comparison-demo/local.sqlite comparison show demo-comparison
```

Deletion invalidates the experiment and stops new assignments; related evidence and
private replay queues are removed. Known identity/alias tombstones reject reuse.
Retained tasks may finish their normal lifecycle. Project deletion removes its
comparison data; explicitly configured retention uses the same deletion path.
Deletion cannot erase exported copies. The separate synthetic exchange path
provides deletion notices; it does not add live-data sharing to this v1 example.

For the additive v2 flexible model workflow, explicit prices and independent
readiness gates, see [flexible comparison](flexible-comparison.md). See the [native workflow](task-native-workflow.md) for exact admissions and
conditional versions. Complete cost and inference remain unavailable.
