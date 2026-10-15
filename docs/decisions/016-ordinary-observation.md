# ADR 016: Ordinary Claude observation

Status: Ordinary use admitted by the 2026-10-15 policy addendum below.
Historical native qualification evidence is unchanged.

## Context

[ADR 012](012-session-family-bindings.md) binds a normally opened session to a
prepared A/B task. People also want to observe everyday Claude Code work that
belongs to no comparison. Reusing the comparison path for that would force an
invented protocol and arm onto work that was never randomized.

## Decision

Ordinary observation is a separate descriptive mode. A task is created from a
registered project's saved defaults and explicit criterion IDs. It has no
comparison setup, protocol, allocation or arm, and a task that holds an
assignment is rejected as an ordinary task. The task pins a snapshot of the
project settings and a price table when it is created.

Project setup is explicit and project-local. Configuration saves the exact
product version, a receipt directory under `.harness-delta/claude-connect/` and
the Claude projects directory. Package installation is a previewed, owned-file
operation under `.claude/skills/harness-connect`: status and preview write
nothing, a manifest records each installed hash, and edited, unowned or unsafe
paths block the change. Removal is refused while an ordinary task in that
project is active, and it leaves receipts and native transcripts alone.

Installing the package is not hook registration. Native hooks register only
when the user invokes the skill in the parent session, and the installation
status reports hook registration as `unverified`. Copied package, registered
hook, native receipt and active observation stay four separate facts.

### Measurement roots and native identity

Each task has at most one selected measurement root. Every connection creates a
new measurement root ID. The native session identity is stored beside it and is
immutable, so a measurement segment can end while the native session lives on.

A live native root is reserved by one task at a time. The reservation holds
while that task's segment is acquiring, observing, paused or stopping. A second
task that presents the same native root is refused with
`binding_session_conflict`.

Handing a native root to another task takes an explicit stop of observation in
the first task. Stopping closes the segment and releases the reservation. It
doesn't exit Claude. The second task then needs a receipt recorded after that
stop; an earlier one is refused with `binding_receipt_stale`. The second task
starts from its own baseline, with its own measurement IDs and price pin.
Earlier usage is never reassigned between tasks and nothing is backfilled.

### Pause, resume, restart and relaunch

Pause keeps the selected segment. Resume revalidates only that segment's stored
live identity, then baselines every surviving member before collecting again.
A server restart leaves the task paused and reads no source by itself. A
relaunched Claude process is a new native root: an explicit reconnect closes the
old segment and opens a new one. Paused, offline and pre-connection usage stays
unobserved.

### Baseline, family and model limits

Baseline exclusions for this path are stored in SQLite, so the 1,024-ID
in-memory cap of the earlier Claude path doesn't apply here. That earlier path
and its cap are unchanged.

The admission profile declares a family of at most eight members, root included.
A ninth is refused with `binding_family_limit`. Members are flattened under the
root. The documented hook fields prove family membership, not the immediate
parent of a nested member.

The profile originally named one model (see the
[2026-10-15 addendum](#policy-addendum-2026-10-15)). A usage record for a
different model stopped collection with `binding_runtime_unsupported`. The source batch is rejected
atomically, including supported records in that batch; no cursor advances.
Explicit resume takes a new baseline rather than backfilling the rejected batch.

### Deletion

Deleting an observed task forgets its native root for good. Other tasks that
still hold a segment on that native root are paused, and later connections from
it are refused. Continuing requires a new native root. Native transcripts are
never removed.

### Provenance and unchanged gates

New observations carry their own `claude_binding` source provenance. It is
prospective only. Existing comparison, Codex, file and workflow trust states are
untouched, and no earlier observation is promoted. Usage stays partial: complete
cost is unavailable, a reference price match is not a bill, and no inferential
or adoption result is produced.

## Admission and evidence

The code-owned profile `claude-binding-02196-family-v1` names Claude Code
2.1.296, one exact binary hash and the declared family limit. Its `qualified`
flag is false. Before the 2026-10-15 addendum, that flag also closed production
admission, and connecting an ordinary task returned `binding_source_unqualified`
before any native source was read. No pilot flag, browser input or provider
setting opened that admission.

Current evidence includes local unit, fake-provider, HTTP and UI tests over
synthetic fixtures, bounded target-binary localhost conformance, and narrowly
scoped interactive connection observations under a development-only qualification
factory. A connection-only trial matched one measured row to independent API
counters and exercised two approve-once Bash permissions. This does not establish
production admission or full native qualification. The full actual-backend family,
pause/resume and task-handover profile, families up to the declared eight members,
compaction, background agents, resumed history and immediate nested parents
remain unverified.

Native qualification needs an accepted native trial tied to the exact 2.1.296 binary on
macOS arm64 under Node 24, sanitized evidence, independent review and a
code-owned admission change. The runtime check also accepts Node 26, which needs
its own evidence before any native Node 26 qualification claim. The historical
support state was "implemented, qualification pending"; normal-use admission is
now independent of that evidence flag.

### Policy addendum (2026-10-15)

The user authorized normal use of this route. This addendum changes use policy,
not the historical evidence above.

- Ordinary provider and source admission is open for the profile's exact current
  Claude Code source version and binary hash. Admission for use is recorded
  separately from the `qualified` evidence flag, which stays false.
- Any Claude model is accepted, meaning a model ID matching `claude` alone or
  followed by `-`, case-insensitive. Model and observed effort are stored as
  observed. There is no model pin. A usage record from another product's model
  stops collection with `binding_runtime_unsupported`, and its source batch is
  rejected atomically.
- Scope, receipt, identity, source version and binary, the eight-member family
  limit, lifecycle, privacy, partial cost and compatibility invalidation rules
  are unchanged.
- No new native trial was run, and no earlier observation is promoted. The
  qualification criteria above remain the record of what was and wasn't shown.

## Consequences

Everyday work can be prepared for observation without a comparison protocol,
and the user keeps control of model, effort, permissions, startup and exit.
The cost is a second binding state machine beside ADR 012's, with its own
tables for project settings, prepared tasks, baseline exclusions and root
segments. Since the 2026-10-15 addendum, ordinary use no longer waits on that
qualification. The user-facing steps are in the
[Harness Connect runbook](../runbooks/harness-connect.md#ordinary-claude-observation-qualification-pending).
