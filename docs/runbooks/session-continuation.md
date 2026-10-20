# Continue one task across explicit sessions

This page covers legacy collection and internal candidate evidence. For assigned
native workflow tasks, use [the task procedure](workflow-quickstart.md#7-resume-or-use-another-session).

A development task is the durable unit; a product session is one explicitly
linked source. Closing a product CLI or starting a new session does not require
another measurement task when the completion criteria are unchanged. Keep the
same local database, registered project and task ID. A changed requirement needs
a new task. See [local measurement](local-measurement.md) for registration and
[current capability limits](../decisions/001-adapter-capabilities.md).

## Restart the collector or add a new root

These commands use the sequential partial file path, with exact admissions or
permitted compatibility-unverified parser reuse. See the
[file-version controls](local-measurement.md#versions-conformance-and-update-controls).
Replace
the identifiers, exact source paths, version and cutoff with your own values.
They do not discover sessions or launch a product/model request.

```sh
# Restart the foreground collector for the existing active task.
node dist/cli.js --db local.db task show task1
node dist/cli.js --db local.db collect --task task1
```

Wait for the initial poll before starting a new product turn. Work already in the
source at startup, and responses from a turn already open at startup, are excluded.
A new collector starts at the current tail; the stored cursor is diagnostic metadata
and cannot authorize replaying the interval while collection was stopped. Keep
collection running. Repeated `--once` invocations establish baselines, never
measure the work between invocations.

For a new independent product session, explicitly link its exact session ID and
file to the same task. The collector can remain running during linkage; its first
poll of that source establishes the new baseline.

```sh
node dist/cli.js --db local.db session link NEW_SESSION_ID --task task1 --source /path/to/new-session.jsonl --product codex --version 0.158.0
node dist/cli.js --db local.db collect --task task1
```

The second command is for a stopped collector; keep only one foreground collector
for the task. It opens only linked sources while the task is active. Sources must
match the registered project and the product/version recorded at linkage.
Version eligibility is checked separately against exact profiles and the finite
file-source compatibility windows; conditional estimates remain unverified.
An independently linked
root has its own source keys and baseline; equal turn IDs or token values in two
roots do not mean their usage is a replay of one another. Repeated polling of the
same eligible records does not add usage again.

For a paused task, use `task resume task1` before collecting new work. The next
poll establishes a fresh baseline, excluding paused work and already-open turns.
For failed first completion and rework against unchanged criteria, use the
existing `task first-complete`, `task assess-first --result failed` and
`task rework` commands. All eligible sessions stay attached to the original task.
Finalize with a human assessment after the last eligible events have been polled.

## When the original source is gone

Usage already stored in SQLite survives loss of the original file. Usage that was
never observed cannot be recovered from a lost source and stays missing. Do not
delete or recreate the task to continue. Explicitly link a fresh independent root
as above. An unreadable old source records `source_error`; it does not prevent
eligible observations from another linked root. Reports retain prior partial
usage and disclose the errors and offline exclusions.

If the old source becomes available again, its next successful poll establishes a
fresh baseline. Identity changes, truncation and uncertain rewrites also reset
observation continuity. Recovery excludes uncertain history and does not backfill
it. This workflow neither deletes product transcripts nor retires the old mapping.
A task report remains partial; an unobserved value is not observed zero.

```sh
node dist/cli.js --db local.db report task task1 --cutoff 2030-01-02T12:00:00Z --format json
```

## Assignment and topology gates

In the [synthetic task comparison workflow](task-comparison.md), repeat
`comparison assign --config assignment.json` with the same logical task identity
(or a previously recorded alias). Its receipt returns `reused: true` and the
original `task_id`, variant, block and allocation index. Use that **returned
canonical task ID** in later commands. A newly requested task ID does not replace
it. Keep preregistration metadata, allocator, environment and original criteria
consistent. A new session does not rerandomize the task or reset followup.

This v1 assignment path and the [assigned native workflow](task-native-workflow.md)
have separate validation boundaries. Keep assigned native tasks on `workflow codex`
or `workflow claude`; generic `session link`/`collect` has different parser and
scope contracts. Codex versions newer than 0.158.0 and below 0.164.0, including Codex 0.160.0,
are eligible for conditional file-parser reuse,
but that does not transfer native workflow admission to the file lane.
See [file-version controls](local-measurement.md#versions-conformance-and-update-controls).
Whole-task cost and inference remain unavailable.

Ordinary sequential collection excludes forked histories and observed child
activity. Do not link a fork/child as an independent root to force aggregation.
Earlier eligible parent observations remain partial; no complete parent/child
usage is inferred. Candidate parent/child accounting needs its own bounded,
explicit source permissions and evidence.

## Bounded Codex 0.160 candidate continuation

The internal opt-in `Collector.tickCodexContinuation(families)` accepts at most two
explicit independent root families for one active task, each with at most one
direct child. Each family supplies its existing `CandidateScope` and exact
`CodexCandidateSources`. Register every source with the candidate-only lifecycle
binder first; the method verifies the complete linked set before reading any
source. This API is absent from package exports and the ordinary CLI.

Each family retains the existing single-root native header, ancestry, request and
turn checks. Families commit independently, with atomic root/child transactions.
A missing or changed file discards that family's current checkpoint and records
`source_error` gaps for its members. The returned fixed diagnostic identifies the
family's root, including when its child was unreadable. Another explicitly
authorized family can continue. Recovery begins with a fresh baseline and excludes
uncertain history. A duplicate response ID with conflicting root attribution
fails; it is never made unique by prefixing a new root ID. Prior committed
families remain partial if a later family fails.

This is bounded offline candidate evidence for multi-root continuation and
root/child accounting. It preserves production source, native assignment and
completeness gates. Candidate tasks still reject comparison assignments and mixed
production channels. Actual Codex 0.160 multi-root execution after terminal
shutdown/source loss remains unverified and needs separately authorized native
observations. No live-call approval is implied by this API.

## Offline verification evidence

```sh
npm test -- tests/session-continuation-cli.test.ts tests/codex-continuation.test.ts
npm run check
```

The integration suite compiles current source and launches separate **measurement
CLI** processes with disposable native-shaped Codex 0.158.0 fixtures. It exercises
SIGTERM/relaunch, explicit new-root linkage after collected/uncollected source
loss, offline and pause/resume exclusion, replay, failed first completion/rework,
human outcome and report arithmetic, fork/child rejection and synthetic issue
assignment reuse across processes. It does not invoke Codex or Claude, access real
session files, prove actual Codex 0.160.0 multi-root continuity, validate model/effort
switches, or establish complete usage/cost or adoption readiness.
