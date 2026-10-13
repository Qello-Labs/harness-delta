# Claude Code 2.1.296 parent-only workflow source admission

The code-owned source registry admits `claude_code / 2.1.296 /
claude-workflow-own-trace-v1` with evidence ID `claude-workflow-02196-root-native-v1`,
`validation_kind: real_operations` and `complete_cost: false`. This enables local
partial per-request usage collection for parent (root) sessions through
`workflow claude launch` and, new in this admission, `workflow claude resume` for a
session that an earlier launch kept. The profile stays parent-only. It does not admit
other Claude Code versions, complete task cost, billing or inferential adoption.
Requirements: [R01, R02, R04, R05 and R07](../requirements.md).

2.1.296 replaces 2.1.291. On 2026-10-13 the
[2.1.291 profile](claude-workflow-02191-source-readiness.md) was retired from the
workflow: it left both the registry and the workflow version list, as 2.1.288 did on
2026-10-06. Only one Claude Code version is admitted for this profile at a time.

A fresh root with one direct child is a separate exact profile with its own evidence;
see the [direct-child admission](claude-workflow-02196-direct-child-source-readiness.md).

## Admitted scope

| Area | Admitted | Not admitted |
| --- | --- | --- |
| Version | Exact 2.1.296 binary; the native runs used SHA-256 `c9b5341637becbd423ddffc5b254afb645682a3868cb708bbc6cc0e7bb419937` | 2.1.288 and 2.1.291 (retired), 2.1.289 through 2.1.295, and every other version as an exact admission |
| Session | Fresh print-mode root per launch; further launches on the same task keep the assignment | External session link, discovery |
| Resume | A launch with `"resumable": true` keeps the native session; `workflow claude resume` continues it in a later run of the same task, in the same workspace, with the exactly admitted version | Resume on a conditional version; resume of a session that has a child; `--continue`; a continuation of the same native session outside the workflow (not observed) |
| Children | None in this profile | `child_runtime` on a parent-only protocol fails before assignment with `workflow_adapter_mismatch`; see the separate direct-child profile |
| Tools | `read-only` (Read, Glob, Grep) or `workspace-edit` (adds Edit, Write), `dontAsk` permission mode | Bash, MCP servers, slash commands, user settings |
| Limits | `timeout_ms` ≤ 1 h; `max_turns`, `request_limit` ≤ 1024; optional CLI budget estimate (each native launch was configured with 300 s, 12 turns and 24 requests) | Provider or subscription spending cap |
| Harness files | With `workspace-edit`, workspace, mediator directory, prompt, binary, Node and database must be outside the project root | Harness files the model could edit |
| Usage | Successful request traces; cache read and cache creation stay separate | Reasoning output (missing, never 0), complete request universe |

The SHA-256 is evidence of the binary that ran. The code does not check against this
value: preflight verifies the file against the `binary.sha256` in the execution JSON.
Runtime model and effort remain user choices. The runs used one model and two effort
values; they do not establish availability of other models or providers.

Versions newer than 2.1.296 and below 2.2.0 may reuse this parser as
`compatibility_unverified` in a `functional_pilot`, for a fresh parent-only launch
only. That is conditional reuse, not an exact admission. The file source window (base
2.1.283, below 2.2.0) is unchanged, so 2.1.296 file collection stays
`compatibility_unverified`.

## Version selection, consistency and the latest-version rule

The exact version list is in `src/claude-workflow-versions.ts`. The execution
document's `binary.version` selects the version. The configured `product_version`, the
protocol and registry profile, the session rows and the stored usage must agree with
it. The internal native probe keeps its own pinned version, 2.1.288, independent of
the workflow list.

A protocol lists exactly one profile per product and version, so a parent-only
protocol and a direct-child protocol are separate protocols. A new protocol of any
purpose except `synthetic_validation` may list at most one entry per Claude workflow
profile, and its version must equal that profile's newest admitted version in the
registry (now 2.1.296), by semantic version order. A `functional_pilot` may instead
name one own-trace version inside the conditional window. Otherwise registration
fails with `claude_workflow_version_not_latest`. The rule runs at registration only. A
registered protocol keeps its version until that version is retired; after retirement
its tasks cannot launch and need a new protocol.

`compatibility inspect` without `--profile` shows the own-trace row for 2.1.296:

```sh
node dist/cli.js --db .harness-delta/local.sqlite compatibility inspect \
  --product claude_code --version 2.1.296 --source claude_workflow
```

## Retirement of 2.1.291

A protocol registered with the 2.1.291 profile keeps its stored version, but
`workflow status` shows `native_source_unqualified` and `native_adapter_not_wired`.
A launch fails before assignment: a 2.1.291 binary fails with `invalid_execution`, and
a 2.1.296 binary under a 2.1.291 configuration fails with `real_experiment_disabled`.
A new protocol that names 2.1.291 or 2.1.288 fails with
`claude_workflow_version_not_latest`. Usage already stored with 2.1.291 labels keeps
its original labels; it is not promoted or rewritten. Register a new protocol with the
2.1.296 profile and assign new tasks there.

A retired version no longer resolves in `compatibility inspect`. `compatibility
invalidate` can still block it when a stored cohort exists for that product, version
and source.

## Native evidence

Four separately approved launches on 2026-10-12 (UTC) used the ordinary CLI path
(macOS arm64, Node 24.21.0) with the existing login, a disposable synthetic project
and one model, `claude-sonnet-5-5`. The executed code was this change's build with a
metadata-only log audit (event name, sequence, request ID hash) added in a scratch
copy; nothing else differed. No launch was retried. Limits per launch: 300 s timeout,
`max_turns` 12, `request_limit` 24. The protocol purpose was `functional_pilot`.

| Run | Operation | Permissions | Effort | State | Requests | Duration |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | launch | `workspace-edit` | `high` | `completed` | 3 | 6.5 s |
| 2 | launch | `workspace-edit` | `medium` | `completed` | 3 | 7.5 s |
| 3 | launch, resumable | `read-only` | `high` | `completed` | 3 | 8.0 s |
| 4 | resume | `read-only` | `medium` | `completed` | 1 | 3.8 s |

| Boundary | Observed result |
| --- | --- |
| Assignment | Runs 1 and 2 are two launches of the same task with the original variant kept; each has its own fresh session. Runs 3 and 4 are a second task |
| `workspace-edit` | Run 1 created the requested file (3 lines); run 2 appended one line; the first three lines were byte-identical afterwards; no other file appeared in the project |
| Resume | Runs 3 and 4 share one session row; the resume stored exactly one new request and one `offline` gap |
| Usage | 10 usage records, 10 distinct native request IDs; ordinary input, cache read, cache write and output observed separately; reasoning output missing, never 0 |
| Labels | Every record is 2.1.296, `verified`, `claude-workflow-own-trace-v1`, with the model and effort requested for that request |
| Terminal delivery | 10 native `api_request` log request IDs, 10 with a stored usage record, 0 stored records without a log ID |
| Gaps | Every trace batch recorded `not_available` (no trace sequence or terminal watermark); one `offline` gap for the resume |
| Human outcome and report | `success` recorded for both tasks before their follow-up deadlines; a report with a cutoff after the deadlines shows `deadline_status: success`, `usage_complete: false`, `complete_amount: null` and a partial estimate from synthetic reference rates only |
| User configuration | No entry for the disposable project path appeared in the user's Claude configuration file. The resumable launch created one project transcript directory in the user's Claude configuration, which is the product's own storage. No leftover processes |

Observed counters per request (session 3 holds runs 3 and 4):

| Session | Effort | `input_total` | `cached_input` | `output_total` | `reasoning_output` |
| --- | --- | --- | --- | --- | --- |
| session-1 | high | 5319 | 3702 | 90 | missing |
| session-1 | high | 5467 | 5317 | 131 | missing |
| session-1 | high | 5694 | 5465 | 3 | missing |
| session-2 | medium | 5306 | 4650 | 90 | missing |
| session-2 | medium | 5454 | 5304 | 350 | missing |
| session-2 | medium | 5903 | 5452 | 3 | missing |
| session-3 | high | 4705 | 3118 | 90 | missing |
| session-3 | high | 4853 | 4703 | 343 | missing |
| session-3 | high | 5248 | 4851 | 3 | missing |
| session-3 | medium | 5311 | 5246 | 3 | missing |

The metadata-only evidence record has SHA-256 `27298b4ecb2fc8c2982afc6307268a19ccf2652db787c96dff4b52321526333a`, used as the
registry's `semantics_digest`. The executed source diff of tracked files against base
commit `24c2458` has SHA-256
`e675d32a2b5562cdee220c2209582103e6d75a04bd975cfcebbdf1d865d14304`; the new example
`examples/workflow/claude-resume.json` was untracked and is not part of that hash.
Prompts, responses, paths, session and request identifiers and credentials are
omitted.

## Offline comparison with 2.1.291

The upstream change records were reviewed, and both real binaries then ran the exact
argv and settings that the workflow builds, against a localhost stub Messages API,
with an isolated configuration directory and kernel-enforced network denial except
localhost. The comparison covered 72 scenario families and 90 invocations, three
repeats each: read-only Read, `medium` effort, `workspace-edit` writes inside and
outside the project, denied Write and Bash, one acknowledgment child, a working
read-only child, a second Agent call, the default permission mode, a CLI budget
estimate, SIGTERM and SIGINT during a request, and persist, resume, continue and
conflicting session flags. The 2.1.291 binary came from the official npm platform
package (SHA-256 `9a1d2ed6bb4421e8fc80c892c0413f293be3ee50ae3d7dda1a7622197a056690`),
extracted to a scratch directory and not installed.

| Boundary | 2.1.296 compared with 2.1.291 |
| --- | --- |
| Hook input | Same key names and fixed values. `SessionStart` has `source: startup` and no `model` |
| Log events | Same event names and attribute keys |
| Log sequence | Contiguous from 0. Sequence 0 is `managed_settings_resolved`, trigger `startup`, no policy sources |
| Request trace | `llm_request` span has the same attribute keys; input, output, cache-read and cache-creation counters stay separate |
| Content | Content attributes are redacted in both versions |
| Permissions | Same `dontAsk` behaviour: writes outside the project are denied and Bash is unavailable |
| Child | Same asynchronous single-child pattern. `SubagentStop` arrives before the child's request spans are exported, in both versions; the coordinator does not treat the stop hook as a usage watermark |
| Agent tool input (D1) | The schema gained `effort` (2.1.292) and also exposes `isolation`. The hook mediator now forwards an Agent effort and an isolation marker, and the coordinator rejects a differing effort or any isolation request |
| CLI budget estimate (D2) | With the same synthetic usage and a USD 0.20 budget, 2.1.291 ends with a budget error, exits 1 and exports no request log or span for the completed request; 2.1.296 completes, exits 0 and exports it |
| Normal exit | All request logs and spans arrive before `SessionEnd` and before process exit |
| SIGTERM or SIGINT during a request | Same in both: SIGTERM exits 143 and SIGINT exits 0, with the completed request exported and the in-flight request absent |
| Other traffic | Only `POST /v1/messages` reached the stub |

D2 matches the 2.1.296 change record that reprices Sonnet 5.5 cache reads in the
CLI's own estimate. It is a pricing finding only. No price catalog change is part of
this admission, and `max_budget_usd` remains the product's own estimate, not a
spending cap.

Not established, offline or natively: real adaptive-thinking-only model counters,
compaction, long histories on resume, hook failure behaviour, deeper descendants,
delayed exports beyond teardown and the complete request universe.

## Resume observations

Observed offline on both 2.1.291 and 2.1.296, and natively on 2.1.296:

| Boundary | Observed result |
| --- | --- |
| Session identity | `--resume <id>` keeps the session ID |
| Hook input | `SessionStart` has `source: resume` |
| Log sequence | Restarts at 0 with the startup policy record |
| Request trace | Only new requests emit request spans; history is not re-exported |
| Conflicting flags | The CLI refuses `--session-id` together with `--resume` |
| `--continue` | Starts its logs under a provisional session ID; the workflow does not use it |

A resumable launch omits `--no-session-persistence`, so the product stores its own
transcript for that project in the user's Claude configuration directory. Harness
Delta never reads that transcript. The native session ID for a resume comes from the
earlier run's own manifest in the workspace and is cross-checked against the stored
run and session; there is no database migration. Without `resumable`, launches are
unchanged and nothing is persisted.

The resumed run reuses the same session row, and each run reports only its own
requests in `observed_requests`. The interval between the kept session's last run and
the resume is recorded as an `offline` observation gap and is never backfilled.
Requests made in that native session outside the workflow are not observed.

Resume is refused before assignment with `claude_workflow_resume_source_invalid` for
an unknown run, a run that was not launched resumable, another task or project, a
session that still has a running run, a session with a child, a session without any
stored usage, a manifest of another version, a symlinked manifest, or a run directory
that is not private. `resumable` or `resume` on a conditional version fails with
`claude_workflow_resume_unadmitted`. A subcommand that does not match the document's
`operation` fails with `workflow_operation_mismatch`.

## Offline CLI scenarios

The ordinary CLI ran each scenario with the real 2.1.296 binary through a localhost
stub, with no Anthropic traffic.

| Scenario | Result |
| --- | --- |
| Launch with a Read tool call | `completed`; 2 usage records; counters equal to the stub's (input 101, cache read 23, cache creation 11) |
| Resumable launch, resume, resume of the resume | `completed` each; 2 + 1 + 1 usage records on one session row; 4 distinct request IDs; 2 `offline` gaps |

## Remaining limits

Usage stays partial: complete task cost, billing and inference remain unavailable, and
`real_allocation` readiness does not imply them. There is no trace sequence or
terminal watermark, so every trace batch records a `not_available` gap. Resume is
parent-only and needs the exactly admitted version, the same workspace with the
earlier run directory, and the same Claude configuration; an external continuation of
the same native session is invisible. Timeouts, turn and request limits and
`max_budget_usd` are not provider or subscription spending caps. The run evidence used
one model and two effort values; it does not establish other models or providers.
Native resume evidence covers only a read-only kept launch followed by a read-only
resume. Edit-mode resume and permission changes between runs are not established;
resume does not compare permissions with the kept launch. The resume example stays
read-only.
