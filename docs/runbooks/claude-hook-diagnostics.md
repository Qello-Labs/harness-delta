# Claude hook recorder diagnostics

[한국어](claude-hook-diagnostics.ko.md)

Use this optional recorder mode to distinguish rejected lifecycle input from a
receipt write failure. It does not enable source admission, install hooks, start
collection, or prove that a native child finished or delivered every counter.
The default hook command remains silent. Existing receipt schema and identity,
project, process, source-path, deletion and version guards remain in force.

## Evidence boundaries

The current [official hook reference](https://code.claude.com/docs/en/hooks#hooks-in-skills-and-agents)
says invoked skill hooks remain registered for the session. Its
[SubagentStop input](https://code.claude.com/docs/en/hooks#subagentstop-input)
describes separate main-session and agent transcript paths. The
[environment reference](https://code.claude.com/docs/en/env-vars) describes
`CLAUDE_PID` for hook commands. These documents are expectations, not exact-version
native qualification. Missing stop receipts alone cannot distinguish no invocation,
invalid input, failed persistence or observation timing. A start receipt can still
support family discovery; absent stop evidence is neither zero usage nor proof
that a child is running, failed or complete.

## Opt-in command

Approve the exact project, fresh active task, linked root session, installed hook
bytes and bounded native actions before changing any real instrumentation. Preserve
completed trials and their receipts. Do not automatically install, reload, alter
trust/auth/global settings, launch or terminate a native process. Select Node 24 or 26.

For an explicitly selected session, add this option to an approved hook command:

```sh
node <skill-dir>/scripts/claude-session-hook.mjs record --diagnostics-session <selected-session-uuid>
```

A valid different session emits no diagnostic. Invalid identity or undecodable
stdin can emit a content-free reason under this explicitly scoped invocation;
its session attribution is unavailable. Unselected events and unrelated Bash
commands remain silent. Invalid diagnostic selection disables diagnostic output.
The option filters diagnostics only; it does not filter or expand ordinary receipt
recording. Limit any native probe through approved user actions, not an automatic
timeout or kill. Do not redirect or retain stdin, tool payloads or native debug logs.

One stderr JSON line reports only `schema_version`, a fixed `kind`, `status` and
`reason_code`. It contains no identifiers, paths, timestamps, prompts, responses,
tool commands, counters or exception details. Stdout remains empty and `record`
returns zero. Example:

```json
{"schema_version":1,"kind":"subagent_stop","status":"rejected","reason_code":"agent_transcript_path_invalid"}
```

| Status | Meaning |
| --- | --- |
| `recorded` / `receipt_recorded` | This invocation created a receipt. Check its allowlisted metadata separately. |
| `ignored` / `receipt_exists` | The target path already exists. This does not validate its contents. |
| `ignored` / `session_forgotten` | Deletion suppressed the event. |
| `rejected` | Required input is invalid; no receipt was created. |
| `error` / `receipt_write_failed` | Receipt persistence failed; raw error details are suppressed. |

Rejection codes name `session_id`, `claude_pid`, `transcript_path`, `cwd`,
`tool_use_id`, `agent_id` or `agent_transcript_path` with `_invalid`. Non-object
JSON uses `hook_input_invalid`; malformed JSON uses `hook_input_invalid_json`;
stdin larger than 4 MiB uses `hook_input_too_large`. Undecodable stdin has `kind: null`.
No diagnostic still leaves hook loading/invocation and command startup unresolved.
Use only separately approved metadata observations to resolve that boundary.

## Private family-rejection diagnostics

A separately authorized Claude human-pilot observer also retains a fixed diagnostic
when an already linked, observing attempt fails family discovery or admission.
The sink is `<private-ui-metadata-file>.family-diagnostics.jsonl`; it is separate
from measurement data, public responses, reports and exports. Preparation, ordinary
mode, Codex pilots and inactive or unlinked attempts do not write this diagnostic.
This adds no source/provider reads, replay, member admission or native actions.

Provider reasons are preserved before they collapse into shared gap codes. The
public error and existing automatic pause remain unchanged. Eligibility is captured
for the selected project/task/root and generation before that pause; only that
rejection may be recorded afterward. A sink failure cannot prevent a pause, replace
the original rejection or trigger a retry. Existing records are not reconstructed.

Each strict JSON line contains only version, service phase and closed reason codes:

```json
{"schema_version":1,"phase":"tick_discovery","reason_codes":["child_source_missing"]}
```

Phases are `baseline_discovery`, `baseline_relation`, `baseline_descendants`,
`tick_discovery` and `tick_relation`. Examples of reasons include child receipt
mismatch, missing child source, unverified ownership/relation, and
`pilot_member_predates_root` for the existing source-birth-time check. These codes
identify rejected checks, not the upstream cause or the internal Claude feature.
Unrecognized causes are suppressed; `reason_codes: []` leaves the cause unknown.
No identifiers, paths, timestamps, content, raw errors or environment dumps enter
the diagnostic. Missing evidence never means zero usage or successful admission.

The sink requires an owner-private parent directory and regular owner-private file,
rejects symbolic/hard links, and caps cooperating writers at 64 rows and 64 KiB.
An exclusive private `.lock` prevents concurrent budget overruns; a busy/stale lock
skips output without retries or deleting another writer's lock. Unsafe, corrupt,
full or unavailable storage also skips output silently. Its absence does not prove
that no rejection happened. Preserve prior trials and approve installation and
bounded native actions separately; offline code verification does not authorize
restarting an existing observer, reconnecting, or a fresh native trial.

## Bounded Start source readiness

A valid Start receipt can precede creation of its child transcript. During an
already authorized Claude binding operation, a fresh Start from the bound root
process, recorded no earlier than the root identity, may hold measurement for the
whole family while the expected source is absent, empty or has no complete row.
This is metadata discovery only: no usage body read or cursor commit occurs while
identity remains unavailable. File presence alone does not release the hold.
The existing path, ownership, process, version and relation checks must pass.

The hold expires two seconds after the original Start time. One family budget is
latched across polling and capped by monotonic elapsed time; repeated receipts,
additional pending children and clock rollback cannot extend it. A result that
returns after the deadline cannot release the hold. Unsafe, foreign, stale or
future evidence, mixed terminal gaps and a Stop with missing/unverified source
still reject the attempt and pause the observer. There is no internal-event
exemption based on `agent_type: null` or missing files. An unknown Stop retains
the existing rejection policy.

After identity is verified within the budget, every family member takes a fresh
prospective baseline. Measurement resumes only after all baselines and a final
family check finish. The excluded snapshot is labeled `unobserved_interval` and
an `incomplete` observation gap; it is never backfilled. The conservative gap
may overlap retained earlier measured rows. Missing usage remains missing and
cost coverage remains `partial`. Connect, resume and ticks share serialization;
pause immediately revokes in-flight and queued operations from that generation.
Timeout may emit the fixed private reason `child_readiness_timeout`; it identifies
the expired check, not a Claude internal feature.

This behavior has synthetic regression coverage. It does not qualify a native
version, install or restart an observer, resume a paused trial, or reconstruct
historical Start/Stop events. Native application and a fresh human-run trial
remain separate actions.

## Prepared Start readiness acknowledgment probe

The internal `onChildReadiness` option is opt-in local operator wiring for the
selected observing Claude human pilot. Ordinary mode, preparation, Codex pilots,
profiles and browser requests cannot enable it. It emits `hold_entered` only after
the original family hold is latched, then `rebaseline_complete` only after every
family baseline, final admission check and prospective gap/boundary commit. The
same attempt, original receipt, root and generation are retained. Delivery failure
is inconclusive and cannot replace an existing rejection or authorize collection.

`createReadinessProbeSink` and `waitForReadinessProbeHold` in
`src/binding-readiness-probe.ts` provide an optional private control channel.
Use a fresh owner-private directory and observer-instance UUID for exactly one
selected Start. Correlate the original receipt UUID with that instance, attempt,
generation and unchanged Start-plus-two-seconds deadline. Strict markers retain
only control tokens, generation, phase and elapsed/deadline/boundary metadata;
they contain no native session/agent identifier, transcript path, body or usage.
They are not measurement data or exported diagnostics. Exclusive single-use claims,
no-follow regular/private single-link files, directory identity checks and an
eight-artifact/2 KiB-per-artifact budget reject replay, unsafe storage or foreign
acknowledgments. No cleanup or retry can silently replace prior evidence.

For child lifecycle events, the prepared adapter
`scripts/claude-readiness-capture.mjs` validates the selected project/task and
observing root process ancestry and matching task/root generation before reading
stdin and rechecks scope immediately
before recording. The connect event uses its registered/active project gate. It invokes
the ordinary recorder first. Only a newly recorded, matching Start may use the
optional acknowledgment channel; duplicates, Stop and connect do not wait. Every
poll rechecks active task, generation, unchanged root identity and actual process
ancestry. Missing or invalid evidence releases silently and leaves a fixed
`hold_unverified` audit code; a matching hold yields `hold_acknowledged`. No raw
stdin, exception, child stderr or native debug information is retained. This
proves wrapper ancestry and collector hold entry, not native hook authenticity.

Optional probe module, receipt and scope work runs in an owned Node probe worker. A shared
500 ms operational deadline starts when the normal recorder returns; receipt/code
checks, module loading, scope checks, IPC and acknowledgment must fit that budget.
Late results are ignored. At expiry the wrapper terminates only its own probe
worker and releases without waiting indefinitely for teardown. It never signals
Claude or the bound root. Worker output is bounded and cannot reach hook stdout
or stderr. Startup, ordinary admission/recording, scheduler and kernel I/O latency
remain outside a hard real-time guarantee. The helper's cooperative budget alone
cannot contain a stalled callback; use the isolated adapter for native preparation.

Operator configuration supplies the selected scope, read-only metadata database,
normal recorder and private audit paths, and optional `readinessProbe` directory,
instance UUID, generation and hash-pinned built helper module. Prepare and review
that exact protected configuration and observer wiring before activation. Do not
register both this adapter and a second Start recorder. Preparation does not
install or activate this wiring, restart the observer or qualify a native version.
A fresh human-run trial still requires separate authorization and preserves prior
paused trials.

A positive hold and matching committed completion exercise prospective recovery
under a deliberate hook timing intervention. They do not establish natural file
creation frequency, a full two-second expiry, complete counters or the origin of
an unrelated Stop. An unknown Stop still pauses collection; an empty agent type
or absent file does not justify ignoring it.

## Synthetic verification

From a Node 24 or 26 checkout:

```sh
npm run build
npm test -- tests/claude-hook-diagnostics.test.ts tests/session-binding-claude.test.ts tests/session-binding-claude-api.test.ts
npm test -- tests/binding-readiness-probe.test.ts tests/claude-readiness-capture.test.ts
npm test -- tests/claude-family-diagnostics.test.ts tests/binding-family-diagnostic-sink.test.ts tests/session-binding-human-pilot.test.ts tests/claude-child-start-readiness.test.ts
node --test skills/harness-connect/tests/*.mjs
npm run check
```

These checks use synthetic inputs and temporary receipt directories. They establish
recorder behavior, privacy, replay/deletion handling and existing binding guards.
They do not execute Claude, qualify exact native lifecycle behavior or counters,
reconstruct missing stop events, or change historical measurements.
