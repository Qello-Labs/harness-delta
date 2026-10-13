# Assigned task workflow and native execution boundary

New to the workflow? Start with the [first A/B run quickstart](workflow-quickstart.md)
([한국어](workflow-quickstart.ko.md)); this page holds the detailed contracts.

The common workflow connects durable flexible assignment, selected instruction
artifacts, task start/resume, an explicit execution-adapter boundary, human finish,
and an existing comparison snapshot. Models and effort are runtime choices;
changing them or opening another session does not create a new task assignment.
Use an explicit logical task ID and opaque issue aliases. GitHub is unnecessary.

**Codex 0.160.0 root own-response collection is admitted.** The code-owned
registry contains `codex-workflow-own-response-v1`, qualified by one actual
start/same-UUID resume/reopen replay run, and a separate
`codex-workflow-direct-child-v1`, qualified by a fresh-root/single-child run.
Both have `complete_cost: false`.
See [the source evidence and limits](../validation/codex-workflow-01600-source-readiness.md).
The CLI connects per-invocation selected instructions, launch, explicit
resume/link, foreground collection and durable stop. Versions and profiles outside exact admissions or the conditional windows below
fail before reading selected instructions or launching a product.
The admission run validates the shared execution engine. Coordinator/CLI coverage
includes synthetic tests and later bounded actual root functional observations; see
[the evidence distinction](../validation/codex-workflow-01600-source-readiness.md#later-bounded-functional-observations). Only the bounded direct-child flow below is admitted;
fork/compaction, deeper children, app support, complete cost and inference
remain unavailable.

**Claude Code 2.1.296 is admitted** under two separate exact profiles, both with
`complete_cost: false`: parent-only `claude-workflow-own-trace-v1`, which covers a
fresh launch and the resume of a session kept by a resumable launch, and
`claude-workflow-direct-child-v1`, a fresh read-only root with at most one read-only
direct child. 2.1.288 was retired from the workflow on 2026-10-06 and 2.1.291 on
2026-10-13. Newer in-window versions remain conditional for a fresh parent-only
launch, not exact admissions; see [Claude parent-only workflow](#claude-parent-only-workflow).

```sh
node dist/cli.js --db .harness-delta/local.sqlite workflow status protocol-1
```

Status distinguishes source qualification, whether the requested profile has an implemented adapter,
incomplete whole-task cost and unvalidated inference. These are independent
blockers; a writable configuration flag cannot admit a source.


## Conditional forward versions

Stable Codex releases newer than 0.160.0 and below 0.164.0, including 0.162.1,
can reuse `codex-workflow-own-response-v1` or the separate
`codex-workflow-direct-child-v1` profile in a `functional_pilot`.
Set execution JSON `product_version` to the actual Codex version; the workflow
configuration and protocol `source_profiles` must use that same version. Keep the
same `profile_id`. Supply the actual executable SHA-256 under `binary.sha256`.
The adapter checks both executable bytes and `--version`; the exact 0.160.0
path retains its existing pinned identity. Root/direct-child scope and permissions
remain unchanged; a compatibility rule does not admit broader binding families.

Claude Code releases newer than 2.1.296 and below 2.2.0 can
reuse `claude-workflow-own-trace-v1` for a fresh parent-only functional launch.
Set `binary.version`, configuration `product_version`, and protocol profile version
to the actual version; supply the executable SHA-256. Runtime checks remain active.
Versions 2.1.289 through 2.1.295 are unsupported for the workflow source.
In the window, assigned child execution fails before assignment with
`workflow_adapter_mismatch`: the execution selects the direct-child profile, but
the conditional protocol holds only own-trace. Direct adapter preflight may instead
give `claude_workflow_child_unadmitted`. In the window,
`resumable` or `resume` fails with `claude_workflow_resume_unadmitted`.
`claude-workflow-direct-child-v1` has no conditional window.

New versions have `compatibility_unverified` source trust. Reports separate their
reference tokens/costs from verified amounts. Functional eligibility does not make
`real_allocation`, complete task cost or inference ready, and real experiments
retain exact source evidence. `hm compatibility inspect` accepts `--source
codex_workflow` or `--source claude_workflow`. Without `--profile`, the Claude
workflow source shows the own-trace row for 2.1.296; pass
`--profile claude-workflow-direct-child-v1` to inspect the child profile.
`compatibility invalidate` can still block a retired version when a stored cohort
exists for it. Contract failures block the affected
version/source; network, deadline and ordinary process errors remain observation gaps.
See [ADR 013](../decisions/013-forward-version-compatibility.md) for windows and recovery.


## Begin an assigned task

This is a command/source reference. Use the [task procedure](workflow-quickstart.md)
for installation, complete input preparation and the human task sequence.

Register and freeze a complete v2 protocol and two immutable variants using the
[quickstart registration procedure](workflow-quickstart.md#4-register-and-freeze-once).
CLI registration pins the reference catalog when `price_table_id` is omitted;
an explicit table remains supported. A/B files, participants and operational
choices still require user input. Keep synthetic checks in a separate database
with the synthetic product.

For real partial local collection, use a dedicated store and an eligible source
profile. The exact Codex root example is
`{"product":"codex","product_version":"0.160.0","profile_id":"codex-workflow-own-response-v1"}`.
A `functional_pilot` may instead select a [conditional forward version](#conditional-forward-versions)
under [ADR 013](../decisions/013-forward-version-compatibility.md#implemented-windows-and-evidence).
This permits unverified reference estimates, not exact source qualification or
real-experiment readiness. A complete frozen v2 protocol remains mandatory.

Supply a local JSON workflow configuration with `schema_version: 1`, an
`assignment` matching the existing v2 assignment schema, `product_version`, a new
`confirmation_id`, and exactly two artifact mappings:

```json
{
  "variant_id": "variant-a",
  "selected_artifacts": [{ "artifact_id": "instructions", "path": "./variant-a.md" }]
}
```

Each mapping belongs in the configuration's `artifacts` array and must reference
one frozen variant. Supply the full assignment contract; no experiment inputs
are filled automatically. `initial_model` is immutable task metadata. A separate
runtime file supplies current choices, such as:

```json
{ "model": "synthetic-model", "effort": null }
```

Null means unknown/unspecified, never an invented default. Runtime choices do not
replace the original task metadata or harness assignment.

```sh
node dist/cli.js --db .harness-delta/local.sqlite workflow begin \
  --config workflow.json --runtime runtime.json
```

Assignment commits before selected artifacts are read. Only the chosen variant's
explicit files are read. Files must be regular UTF-8 files without NUL, at most
1 MiB each and 16 MiB combined; final symlinks and changed reads fail. The sorted
manifest uses the existing artifact ID plus SHA-256 formula. Drift fails before
task start or adapter execution and preserves the original assignment.

The CLI returns only IDs, hashes, generation and `harness_application:
"prepared_only"`. It never prints instruction text or applies it to a product.
The internal execution interface supplies the verified selected bytes transiently
to its adapter, which must apply them through per-invocation product settings
before launch. No instruction bytes enter measurements or receipts. It does not
overwrite AGENTS.md or change project, global or authentication configuration.

Begin can resume a paused task or confirm another run of the same active task.
Use a fresh confirmation ID and the same preregistered metadata. Logical aliases
resolve to the canonical task and original variant; they do not advance allocation.
Task finalization prevents subsequent execution. An adapter receives an active
generation check it must call before every launch/source/observation boundary;
it also owns explicit session binding, receiver credentials, collection and
process teardown. Adapter return does not prove those duties were satisfied and
does not imply human success or complete cost.

## Codex launch, resume, link and collection

The exact admitted profile is `codex-workflow-own-response-v1` for Codex 0.160.0;
newer in-window versions use the conditional rules above, not a new exact admission.
It supports sequential independent root sessions. Forked histories, compaction,
child sessions and mismatched identities fail closed. Production source admission
is code-owned; there is no CLI flag to enable a synthetic or unqualified source.
Only exact `cli` and `exec` source origins are allowed; IDE/MCP and other source
origins are unsupported even with a matching root UUID and version.

Each invocation uses the common workflow/runtime files and a strict execution
JSON file. Use a fresh `run_id` and `confirmation_id` for every operation. Pass
`--confirmation <id>` to override the configuration's `confirmation_id` instead of
editing the file. [Example files](../../examples/workflow/) match these schemas:

```json
{
  "run_id": "run-1",
  "operation": "launch",
  "binary": {"path": "/absolute/codex", "sha256": "<pinned-0.160.0-SHA256>"},
  "codex_home": "/absolute/existing-codex-home",
  "hook_recorder": "/absolute/harness-delta/scripts/conformance/candidate-start-recorder.mjs",
  "prompt_file": "/absolute/private-task-prompt.txt",
  "sandbox": "workspace-write",
  "timeout_ms": 180000,
  "poll_ms": 250
}
```

Paths must be absolute and canonical. For launch/resume, the native binary must
match `binary.sha256` and report the selected `product_version`; exact 0.160.0
requires the code-owned pin. Conditional versions require their reviewed actual
hash. The metadata-only recorder must match its code-owned content hash.
Launch/resume check these files, the prompt and Codex home before assignment or
task activation. Link/collect check the home but do not invoke the binary or read
the recorder or prompt. A preflight failure prints a fixed code (for example
`binary_mismatch`) and leaves no assignment, active interval or run journal row.
The binary is checked again immediately before spawn and is re-hashed unless the
file identity hashed by preflight is unchanged. If a launch still fails before any
native process starts, and that invocation activated the task, the task is paused
again and the receipt reports `activation_reverted: true`.
For a bounded fresh parent verification launch, explicitly adding
`"project_trust": "untrusted"` passes the registered project root's trust setting
through a one-invocation CLI override. This optional setting disables project-local
`.codex` config, hooks and rules for that invocation; use it only when that behavior
is intended. It does not disable the CLI-injected collection hook or change the
default launch behavior. Resume/link/collect and child launches reject this option.
Codex 0.160.0's thread/start writes implicit trust only when the effective project
trust value is unspecified and effective permissions allow writing the project.
Managed configuration has higher precedence: this option is not a general guarantee
against other configuration writes, and supervised scope verification is still required.
The home is used by the native process without inspecting credentials or older
session files. The selected instruction text is bounded to 32 KiB; prompt UTF-8
is bounded to 1 MiB and supplied through stdin. No argv, prompt, instructions,
native stdout or stderr enter the measurement database or CLI receipt. Ordinary
workflow stdout is discarded, so a read-only analysis answer is not returned by
this measurement CLI. For a useful file-producing task, explicitly include a
normal work-product destination in the prompt and approve root workspace-write
permissions; keep that artifact separate from measurement data and reports. The
initial native qualifications were read-only. Later bounded write-mode functional
observations exist: one failed configuration scope; a subsequent explicitly untrusted
launch passed its monitored checks. They do not establish general settings isolation.
See [the task procedure](workflow-quickstart.md) and
[the evidence distinction](../validation/codex-workflow-01600-source-readiness.md#later-bounded-functional-observations). Runtime
model/effort may be null or explicit native choices; actual context values are
recorded per request. Null does not select a diagnostic model.

```sh
node dist/cli.js --db .harness-delta/local.sqlite workflow codex launch \
  --config workflow.json --runtime runtime.json --execution launch.json
node dist/cli.js --db .harness-delta/local.sqlite workflow codex resume \
  --config workflow.json --runtime runtime.json --execution resume.json
node dist/cli.js --db .harness-delta/local.sqlite workflow codex link \
  --config workflow.json --runtime runtime.json --execution link.json
node dist/cli.js --db .harness-delta/local.sqlite workflow codex collect \
  --config workflow.json --runtime runtime.json --execution collect.json
node dist/cli.js --db .harness-delta/local.sqlite workflow codex stop run-1
node dist/cli.js --db .harness-delta/local.sqlite workflow codex recover run-1
node dist/cli.js --db .harness-delta/local.sqlite workflow task task-1
```

`stop` asks a live run to end. `recover` is for a run left `running` after its
process disappeared (crash, kill or reboot), which otherwise blocks the task with
`workflow_run_active`. It marks the run `failed` with reason `abandoned`, records
an `incomplete` observation gap after the last retained usage of each bound
session, and never adds usage; a harness-delta collector that is still alive stops
at its next guard. Recover before pausing or finishing: an inactive task cannot
record the gap, and the result reports `gap_warning: task_not_active`; a pause or finish while the run was `running` already recorded it. Codex and
Claude Code processes run in their own process groups and can outlive a killed
collector; no process ID is persisted, so `recover` cannot signal them and they
must be ended manually. `workflow task` prints the task state, follow-up deadline, run states
and fixed next-action codes without paths or instruction text.

`resume` requires `operation: "resume"` and the exact previously linked UUID in
`session_id`. It applies the selected harness again with current runtime choices.
`link` requires `operation: "link"`, a new explicit root UUID and `source_path`
under that home's canonical sessions directory. It binds the session before its
first bounded read; existing source usage establishes a baseline and is excluded.
`collect` requires that linked UUID and admits only future usage while it runs in
the foreground. Link and collect do not launch or apply a harness and therefore
return `external_unverified`. Every command's operation must match its JSON file.
No session discovery, `--last`, automatic operation retry or retrospective backfill
occurs. A bounded read that races a native append (`unstable_read`) ingests nothing
and is reread at the next poll, up to 20 consecutive times or the invocation
deadline; identity, truncation and prefix changes still fail closed.

Launch/resume use the awaited metadata hook to bind the exact native UUID/path,
then poll only that authorized source with task generation, configuration,
tombstone and immutable-file checks. Durable file identity, size and prefix hashes
reject replacement/rewrites across CLI invocations. Resume baselines prior work before launch.
Globally scoped response IDs reject conflicts and avoid duplicate accumulation.
A durable stop ends collection and terminates the launched process group; it
does not finalize the human task. Timeout and stop are process controls, not a
provider token/cost cap. Failed adapter results produce CLI exit code 2.

`invocation_settings_verified` proves that verified selected bytes generated the
outgoing per-invocation developer-instruction argument. It does not attest native
resolved harness application; native TurnContext does not expose those bytes.
The setting uses the [official developer-instructions configuration](https://developers.openai.com/codex/config-reference/).
The exact native launch/resume/source boundary has operational qualification and
limited source admission. The tested marker pair is behavioral evidence, not
resolved-harness attestation. Only guarded host scope and identity facts are
produced; whole-task request universe, terminal
flush and continuous coverage remain unknown, so complete cost and inference
stay closed under their existing independent gates.

## Single direct-child launch and durable collection

The separately admitted `codex-workflow-direct-child-v1` profile supports Codex
0.160.0 on the pinned macOS arm64 binary and Node24. Include the exact profile in
the frozen v2 protocol's source profiles:

```json
{"product":"codex","product_version":"0.160.0","profile_id":"codex-workflow-direct-child-v1"}
```

For a conditional functional pilot, use the same profile ID with the actual
in-window version in the protocol, workflow configuration and execution JSON.
Supply that binary's reviewed SHA-256. The read-only, macOS arm64/Node24 launch
boundary and fresh-root/single-child limits still apply; its estimates remain
`compatibility_unverified`, not exactly admitted.

Use the same `workflow codex launch` command and common configuration/runtime files.
Add `child_runtime` to the launch execution JSON and require `sandbox: "read-only"`:

```json
{"child_runtime":{"model":"<user-selected-child-model>","effort":"high"},"sandbox":"read-only"}
```

The full execution document must also supply all required launch fields shown above.
These are runtime choices; diagnostic Astra/Sol settings are not required policy.
The task prompt must request one fresh direct child without forked context. The
collector verifies that one child; zero, second/deeper or unsupported child evidence
stops the run rather than claiming successful supported collection. Hook detection
and process teardown do not enforce a hard provider or subscription spending cap.

After a completed development launch, collect with a new run/confirmation ID and the
returned root `session_id`. Omit `child_runtime` and `direct_child`: the adapter
resolves only that launch's source-verified durable child binding for the same task,
project and generation. An explicitly supplied `direct_child` mapping must match;
it never authorizes a new source. The same `workflow codex collect` and `stop` commands
operate on both linked sources. History at collection start and earlier unobserved
records that arrive later are excluded; new own usage in the same bound turns is
collected. Reopen/replay inserts no duplicate usage/runtime records.

Family `resume` and external child `link` are unsupported, including attempts to
omit a known child and reuse the root-only profile. Another session/rework under
the same logical task may use another fresh launch and retains its original sticky
A/B assignment. After a task pause/generation change, start a fresh pair. The native
shared engine was verified once; this ordinary coordinator/CLI wiring was verified
offline. See [the exact operational evidence and limits](../validation/codex-workflow-01600-direct-child-source-readiness.md).

The connection applies the selected root instructions, enables agents transiently
with maximum depth one and the explicit child defaults, and configures the pinned
SessionStart/SubagentStart metadata hooks. Only the fresh callback path is bound;
source headers, initial contexts, request identities and managed read-only
permissions are checked before acknowledgement. Callback-first and persisted
spawn-first ordering are supported offline. A second child, inherited history,
compaction, source replacement or scope loss stops the run. Same-child lifecycle
activities are checked against the
[pinned protocol](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/protocol/src/protocol.rs#L4097);
only started activities count as a new spawn. Prompt/response content and personal
paths do not enter measurement output. Native hooks can fail open; detection and
process-group termination do not enforce provider token or billing limits.

Both sessions bind to the same task and confirmation. One sticky assignment and
request-local model/effort evidence survive the admitted fresh launch and durable
family collection/replay. Root-to-child resume remains a synthetic candidate test,
not admitted production behavior. General child resumes, forks, deeper descendants
and whole-task completeness remain unqualified.

## One-shot Codex workflow qualification

Developer-only qualification commands and historical consent/lease/marker rules
are preserved in [the admission record](../validation/codex-workflow-01600-source-readiness.md#one-shot-codex-workflow-qualification).
They are not part of an ordinary assigned task and do not grant actual-run approval.

## Continue, finish and compare

The existing task pause/resume, first-completion, assessment and rework commands
retain their behavior. Explicit session linking and foreground collection remain
subject to their own admitted profiles and scope rules; this common workflow
does not admit a candidate or authorize automatic session discovery/backfill.
Use [the task continuation procedure](workflow-quickstart.md#7-resume-or-use-another-session)
for Codex 0.160.0. [Legacy session continuation](session-continuation.md) describes
the separate generic file path and internal candidates.

Human assessment supplies the fixed criteria:

```sh
node dist/cli.js --db .harness-delta/local.sqlite workflow finish task-1 \
  --outcome success --met criterion-1
node dist/cli.js --db .harness-delta/local.sqlite workflow report protocol-1 \
  --id report-1 --cutoff 2026-10-05T00:00:00Z --reason initial
```

Finish before the task's `followup_ends_at`. An outcome assessed at or after that
deadline is stored, but deadline status stays `outcome_missing` (or `not_started`); `workflow finish`
returns `counted_in_deadline_status: false` and warns
`assessment_after_followup_deadline`. A report cutoff before the deadline shows
`followup_pending`, so create the final report after the deadline with a cutoff at
or after it and no later than report evaluation. Snapshots are half-open; an
outcome exactly at the cutoff is excluded. Finish and
report are separate durable operations so a report error cannot undo or silently
repeat a human outcome. All linked eligible sessions and rework remain under the
original assignment. Missing coverage or prices keep complete cost unavailable;
synthetic local checks cannot prove billing, native support or an adoption decision.
## Claude parent-only workflow

`workflow claude launch`, `resume`, `stop <run-id>` and `recover <run-id>` use the same
assignment, selected-artifact confirmation and task lifecycle as Codex. The code-owned
registry admits `claude_code / 2.1.296 / claude-workflow-own-trace-v1` for a
parent-only root session: a fresh launch, or the [resume](#claude-resume) of a
session that a resumable launch kept. See [the admission evidence](../validation/claude-workflow-02196-source-readiness.md).
A separate exact profile admits one read-only direct child; see
[Claude direct-child profile](#claude-direct-child-profile).
The binary's `version` must equal the configured `product_version`.

2.1.288 and 2.1.291 are retired; their tasks need a new protocol and eligible version.
Stored usage keeps its original labels. Historical qualification remains in the retired
[2.1.288](../validation/claude-workflow-02188-source-readiness.md) and
[2.1.291](../validation/claude-workflow-02191-source-readiness.md) records.

A protocol lists one profile per product and version, so a parent-only protocol and
a direct-child protocol are separate protocols. A new non-synthetic protocol may list
at most one entry per Claude workflow profile. Exact-version registration
requires that profile's newest admitted version (2.1.296); `functional_pilot` also permits
one newer own-trace version in the [conditional window](#conditional-forward-versions).
Other selections fail with `claude_workflow_version_not_latest`. Registration does
not change an existing protocol's version or promote conditional source trust.
Retired or blocked sources cannot launch. Synthetic protocols are exempt from
this registration rule.

| Boundary | Supported behavior |
| --- | --- |
| Product | Pinned eligible Claude Code binary path/version and SHA-256; existing login |
| Session | Fresh print-mode root per launch. With `"resumable": true` (exact version only) the native session is kept for a later `resume`; no discovery or external link |
| Continuation | Another `launch` on the same task keeps the original assignment; use a new `run_id` and confirmation ID. The `workspace` may be reused: each run gets its own subdirectory. `resume` continues a kept session of the same task in the same `workspace` and reuses its session row |
| Child execution | Not part of this profile: `child_runtime` on a parent-only protocol fails with `workflow_adapter_mismatch` before assignment. The separate `claude-workflow-direct-child-v1` profile admits one read-only `workflow-child` at the exact version |
| Tools | `permissions: "read-only"` (default): Read, Glob, Grep. `"workspace-edit"`: adds Edit and Write. Bash, MCP, slash commands and user settings are never loaded |
| Limits | `timeout_ms` ≤ 3,600,000; `max_turns` and `request_limit` ≤ 1024; optional `max_budget_usd` |
| Usage | One record per successful `claude_code.llm_request` trace; cache read and cache creation stay separate |

The execution document specifies `operation: "launch"`, `run_id`, the pinned binary
path/version/SHA, a private `workspace` (canonical, mode 0700), the built
`mediator_path` (`dist/claude-probe-hook-mediator.js`), `prompt_file`, `permissions`,
`timeout_ms`, `max_turns` and `request_limit`. See
[the example](../../examples/workflow/claude-launch.json). The protocol's
`source_profiles` and `workflow.json` use `product: "claude_code"` and
the selected `product_version` (the example uses `2.1.296`). Runtime model and effort remain invocation choices;
supported effort values are `low`, `medium`, `high`, `xhigh` and `max`.

```sh
node dist/cli.js --db .harness-delta/local.sqlite workflow claude launch \
  --config workflow.json --runtime runtime.json --execution claude-launch.json --confirmation confirmation-1
node dist/cli.js --db .harness-delta/local.sqlite workflow claude stop claude-run-1
node dist/cli.js --db .harness-delta/local.sqlite workflow claude recover claude-run-1
```

With `workspace-edit`, preflight rejects (`claude_workflow_harness_inside_project`,
before assignment) a `workspace`, mediator directory, prompt, Claude binary, Node
executable or database inside the project root: an edited hook mediator would run
model-written code. Keep the harness-delta build outside the measured project.

The invocation runs with `--permission-mode dontAsk`: any tool or path the
invocation does not allow is denied, never prompted. Offline checks with the pinned
binary showed Write and Edit succeed inside the project root and are denied in its
parent directory and in `/tmp`. Native stdout is discarded, so state the output file
in the private prompt and use `workspace-edit` when the task must produce one.
`max_budget_usd` is passed to the product's own estimate; it is not a provider or
subscription spending cap, and neither are timeouts, turn or request limits.

Selected instructions are applied through a temporary appended system-prompt file.
Logs check ordering, policy and replay; only request traces create usage. Exact
log or trace re-delivery adds nothing, and a request ID already stored anywhere in
the database stops the run as a conflict. A task cannot acquire a second file,
managed or OTel log usage owner after trace ownership is reserved.

Stop, timeout, scope loss and abnormal exits end the native process group and
record an `incomplete` gap after the last verified usage; earlier usage remains a
partial observed estimate. Pausing or finishing the task during a run records that
gap inside the same transaction, before the task becomes inactive, and the launch
command then reports `workflow_scope_revoked`. The same applies to running Codex
workflow runs. Every trace
batch also records a `not_available` gap: Claude exposes no trace sequence or
terminal watermark, so a run's usage is never complete. In the native admission
run, every native `api_request` log request ID had a stored usage record after a
normal exit; an abnormal exit (budget stop, kill) can lose the final request, which
the `incomplete` gap marks. Usage therefore stays partial under both profiles:
complete task cost, billing and inference remain unavailable.

### Claude direct-child profile

`claude-workflow-direct-child-v1` is a separate exact profile for 2.1.296 with no
conditional window. See [the admission evidence](../validation/claude-workflow-02196-direct-child-source-readiness.md).
Register a separate protocol whose source profile is:

```json
{"product":"claude_code","product_version":"2.1.296","profile_id":"claude-workflow-direct-child-v1"}
```

Use the same `workflow claude launch` command. Every launch on this protocol adds
`child_runtime` to the execution JSON and requires `permissions: "read-only"`:

```json
{"child_runtime":{"model":"<user-selected-child-model>","effort":"high"},"permissions":"read-only"}
```

The full execution document must also supply all required launch fields shown above.

| Condition | Refusal before assignment |
| --- | --- |
| `permissions: "workspace-edit"` with `child_runtime` | `claude_workflow_child_read_only_required` |
| Execution without `child_runtime` on this protocol, or with it on a parent-only protocol | `workflow_adapter_mismatch` |
| Conditional child execution on an own-trace protocol | `workflow_adapter_mismatch` |

The assigned CLI compares the selected profile before adapter preflight. Direct
adapter preflight for a version without the direct-child admission may instead
give `claude_workflow_child_unadmitted`.

The root gets the Agent tool and exactly one agent type, `workflow-child`, with the
tools Read, Glob and Grep. Agent, Bash, Write, Edit, WebFetch and WebSearch are
disallowed for it, its turn limit equals the run's `max_turns`, it is not a
background agent, and the selected instructions are also appended to it. The model
may or may not use the child; a run without a child still completes.

Only one child is admitted. A second Agent call stops the run with
`claude_probe_child_limit`. Another agent type, a resume request, a background
request, an `isolation` request, a model different from `child_runtime.model`, or an
`effort` different from `child_runtime.effort` in the Agent tool input stops it with
`claude_probe_child_scope`. Each stop records a gap. These are fail-closed checks
performed at hooks that may fail open, so they do not guarantee that a request was
never sent. Deeper descendants, more children, background or isolated children and
a child that edits files are unsupported.

Child usage is stored on its own session row linked to the root; each child request
records the child's model and effort. A direct-child run cannot be kept or resumed.

### Claude resume

Resume belongs to `claude-workflow-own-trace-v1` and needs the exactly admitted
version. It is parent-only. First launch with `"resumable": true` in the launch
execution document. That launch keeps the native session, so the product stores its
own transcript for the project in the user's Claude configuration directory. Harness
Delta never reads that transcript. Without `resumable`, nothing is persisted.

The resume execution document specifies `operation: "resume"`, a fresh `run_id`,
`resume_run_id` naming the earlier resumable run of the same task, and the same
`workspace`, which must still hold that run's directory. The other fields match a
launch. See [the example](../../examples/workflow/claude-resume.json), which uses
`permissions: "read-only"`. Only a read-only kept launch and read-only resume have
native evidence; edit-mode resume or changing permissions between runs is not
established. Resume does not compare permissions with the kept launch.

```sh
node dist/cli.js --db .harness-delta/local.sqlite workflow claude resume \
  --config workflow.json --runtime runtime.json --execution claude-resume.json --confirmation confirmation-2
```

The resumed run reuses the kept session's row, and each run reports only its own
requests in `observed_requests`. The interval between the kept session's last run
and the resume is recorded as an `offline` gap and is never backfilled. Requests made
in that native session outside the workflow are not observed.

| Condition | Refusal before assignment |
| --- | --- |
| Unknown run; a run not launched resumable; another task or project; a session with a running run, with a child or without stored usage; a manifest of another version; a symlinked manifest; a run directory that is not private | `claude_workflow_resume_source_invalid` |
| `resumable` or `resume` on a conditional version | `claude_workflow_resume_unadmitted` |
| Subcommand differs from the document's `operation` | `workflow_operation_mismatch` |

`resume` cannot be combined with `child_runtime`, and `resumable` cannot be set on a
child launch.

