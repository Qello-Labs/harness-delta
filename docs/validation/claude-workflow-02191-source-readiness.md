# Claude Code 2.1.291 parent-only workflow source admission (retired)

> **Retired on 2026-10-13.** 2.1.296 replaced 2.1.291 as the only admitted Claude Code
> version of the parent-only workflow profile
> ([2.1.296 admission](claude-workflow-02196-source-readiness.md)). The evidence entry
> `claude-workflow-02191-root-native-v1` was removed from the registry, and 2.1.291 was
> removed from the workflow version list. Tasks on registered 2.1.291 protocols can no
> longer launch and need a new protocol. Usage stored with 2.1.291 labels keeps those
> labels. The text below describes the state at admission and is kept as historical
> evidence.

The code-owned source registry admitted `claude_code / 2.1.291 /
claude-workflow-own-trace-v1` with evidence ID `claude-workflow-02191-root-native-v1`,
`validation_kind: real_operations` and `complete_cost: false`. This enables local
partial per-request usage collection for fresh parent (root) launches through
`workflow claude launch`. It does not admit child execution, native resume, other
Claude Code versions, complete task cost or inferential adoption.
Requirements: [R01, R02, R04, R05 and R07](../requirements.md).

2.1.291 replaces 2.1.288. On 2026-10-06 the
[2.1.288 profile](claude-workflow-02188-source-readiness.md) was retired from the
workflow: it left both the registry and the workflow version list. Only one Claude Code
workflow version is admitted at a time.

## Admitted scope

| Area | Admitted | Not admitted |
| --- | --- | --- |
| Version | Exact 2.1.291 binary; the native run used SHA-256 `9a1d2ed6bb4421e8fc80c892c0413f293be3ee50ae3d7dda1a7622197a056690` | 2.1.288 (retired), 2.1.289, 2.1.290, 2.1.292 and every other version |
| Session | Fresh print-mode root per launch; further launches on the same task keep the assignment | Native resume, external session link, discovery |
| Children | None | `child_runtime` fails before assignment with `claude_workflow_child_unadmitted` |
| Tools | `read-only` (Read, Glob, Grep) or `workspace-edit` (adds Edit, Write), `dontAsk` permission mode | Bash, MCP servers, slash commands, user settings |
| Limits | `timeout_ms` ≤ 1 h; `max_turns`, `request_limit` ≤ 1024; optional CLI budget estimate (the native run was configured with 300 s, 12 turns and 24 requests per launch and used about 10 s and 3 requests each) | Provider or subscription spending cap |
| Harness files | With `workspace-edit`, workspace, mediator directory, prompt, binary, Node and database must be outside the project root | Harness files the model could edit |
| Usage | Successful request traces; cache read and cache creation stay separate | Reasoning output (missing, never 0), complete request universe |

The SHA-256 is evidence of the binary that ran. The code does not check against this
value: preflight verifies the file against the `binary.sha256` in the execution JSON.
Runtime model and effort remain user choices. The run used one model and two effort
values; it does not establish availability of other models or providers.

## Version selection, consistency and the latest-version rule

The exact version list is in `src/claude-workflow-versions.ts`, and a test requires
every admitted Claude workflow registry version to be in it. The execution
document's `binary.version` selects the version. The configured `product_version`, the
protocol and registry profile, the session rows, the log and trace `app.version`
checks, and the stored usage and runtime evidence must all agree with it. The
internal native probe keeps its own pinned version, 2.1.288, independent of the
workflow list.

One native request ID is never stored under two version labels: a Claude usage whose
request ID already exists under another accepted version fails as a conflict. The
guard checks only the versions currently accepted (the workflow list and the pinned
probe version), so it narrowed when 2.1.288 left the workflow list. The risk is low:
the log and trace `app.version` checks already tie every stored label to the binary
that ran.

A new protocol of any purpose except `synthetic_validation` may list at most one
`claude_code / claude-workflow-own-trace-v1` source profile. Its version must equal the
newest admitted version in the registry (now 2.1.291), by semantic version order.
Otherwise registration fails with `claude_workflow_version_not_latest`. The rule runs at
registration only. A registered protocol keeps its version until that version is
retired; after retirement its tasks cannot launch and need a new protocol.

## Retirement of 2.1.288

A protocol registered with the 2.1.288 profile keeps its stored version, but
`workflow status` shows `native_source_unqualified` and `native_adapter_not_wired`.
A launch fails before assignment: a 2.1.288 binary fails with `invalid_execution`, and
a 2.1.291 binary under a 2.1.288 configuration fails with `real_experiment_disabled`.
Usage already stored with 2.1.288 labels stays readable, and reports still include it.
Register a new protocol with the 2.1.291 profile and assign new tasks there.
The unadmitted manual external Claude candidate stays pinned to the 2.1.288 probe
binary. It is not a workflow admission: it prepares its files with an explicit
pinned-candidate flag that the admitted workflow adapter never sets, and its
coordinator runs in synthetic mode.

## Native evidence

One separately approved run on 2026-10-06 used the ordinary CLI path (macOS arm64,
Node 24.21.0) with the existing login and a disposable synthetic project. The executed
code was this change's build before the 2.1.288 retirement, plus this registry entry
and a metadata-only log audit (event name, request ID, sequence) in a scratch copy. The
retirement only removes 2.1.288 and does not change the 2.1.291 usage path. Two
invocations, no retry:

| Boundary | Observed result |
| --- | --- |
| Assignment | Both launches used the same task and original variant; generation 1, paused, then 3 |
| Runtime choice | `claude-sonnet-5-5` / `high`, then `claude-sonnet-5-5` / `medium`, recorded per request |
| Duration | About 10.9 s and 9.1 s |
| Harness application | Selected instruction file applied per invocation (`invocation_settings_verified`) |
| `workspace-edit` | First run created the requested file (3 lines); second run appended one line; the existing file was byte-identical afterwards; no other files |
| Usage | 3 + 3 request records, 6 distinct native request IDs; ordinary input, cache read, cache write and output observed separately; reasoning output missing |
| Version labels | Every session, usage and runtime evidence record is 2.1.291 |
| Terminal delivery | Every native `api_request` log request ID had a stored usage record after normal exit (6 of 6) |
| Gaps | Each trace batch recorded `not_available` (no trace sequence or terminal watermark) |
| Human outcome and report | `success` before the follow-up deadline; report `deadline_status: success`, `usage_complete: false`, `complete_amount: null`; a partial estimate with synthetic reference rates only |
| User configuration | No entry for the disposable project path appeared in the user's Claude configuration; no leftover processes |

The metadata-only evidence record has SHA-256
`ff8f469f129e9c1ccf3ee0f57698775f80976ba013fa3998c048a6599d040046`, used as the
registry's `semantics_digest`. The executed source diff of tracked files against base
commit `c2533cf9ce5c2a1f773d06802f8ba3ae6119d6a0` has SHA-256
`a876c7be8ef3fe5e367a7da805accdccdcc8b9cb16c8717956469243fe106f45`. With the new file
`src/claude-workflow-versions.ts` included as executed (round-3 content, since changed by the retirement), the hash is
`78ddb5363516f185a9a65fbca5d1dbd5a5afe2b73f9ca0e3f86421301d04a097`. Prompts,
responses, paths, session and request identifiers and credentials are omitted.

## Offline comparison with 2.1.288

Before the native run, both real binaries ran the exact argv and settings that the
workflow builds, against a localhost stub Messages API, with an isolated configuration
directory and a synthetic key (no Anthropic traffic). A local capture kept only event
and span names, attribute key names, fixed metadata values and arrival times. Each
version ran nine scenarios three times: read-only Read tool, `medium` effort,
`workspace-edit` writes inside and outside the project, denied Write and Bash, a direct
child, the default permission mode, a CLI budget estimate, and SIGTERM and SIGINT
while a request was in flight. The three repeats of each version had identical
structure.

| Boundary | 2.1.291 compared with 2.1.288 |
| --- | --- |
| Hook input | Same events, key names and values. `SessionStart` has `source: startup` and no `model` |
| Log events | Same event names and attribute keys per event. `app.version` reports 2.1.291 |
| Log sequence | Contiguous from 0. Sequence 0 is `managed_settings_resolved`, trigger `startup`, no policy sources |
| Log order | The `SessionStart` `hook_execution_start` event moved from sequence 8 to 1. The coordinator checks only continuity and sequence 0 |
| Request trace | `claude_code.llm_request` has the same attribute keys; model, effort, request ID, token counters, `success` and `attempt` match |
| Content | Content attributes are redacted in both versions |
| Requests | Same Messages requests, model, tools and effort; no classifier or title request |
| Permissions | `dontAsk` denies unlisted tools; writes outside the project root are denied |
| Child | Same asynchronous direct-child pattern; child execution stays unadmitted |
| Normal exit | All request logs and spans arrive before `SessionEnd`, which precedes process exit; nothing arrives after exit |
| SIGTERM or SIGINT during a request | Same in both: the completed request's span is exported after the signal, `SessionEnd` runs, the process exits (SIGTERM 143, SIGINT 0); the in-flight request is not reported |
| Other traffic | 2.1.288 sends one `HEAD /api/hello` to the configured base URL; 2.1.291 does not |

The [2.1.291 change record](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#21291)
fixes "a regression in 2.1.288 where the last messages of a session could be lost when
quitting". Offline, quitting showed the same export, flush and hook order in both
versions, so the fix is not visible on the measured telemetry surface. It probably
concerns session transcripts, which the workflow disables with
`--no-session-persistence`; that cause is inferred, not verified. The 2.1.289 and
2.1.290 records list no change to OpenTelemetry events, request spans, print-mode
hooks or the flags the workflow uses.

## Offline CLI scenarios

The ordinary CLI ran each scenario with the 2.1.291 binary through the same stub.

| Scenario | Result |
| --- | --- |
| Launch, Read tool, end | `completed`; 2 usage records; session, usage and runtime evidence record 2.1.291 |
| Pause, then a second launch with another effort | Same task and variant; generation 1, 2, 3; `finish` counted |
| Stop, pause or timeout during a request | Run stopped (pause: CLI `workflow_scope_revoked`); earlier usage kept; `incomplete` gap |
| Collector killed, then `recover` | `failed` / `abandoned`; `incomplete` gap |
| `workspace-edit` | Write and Edit inside the root succeed; writes to the parent and `/tmp` are denied |
| 31 requests; 46 requests in one export burst | All recorded |
| `child_runtime` | `claude_workflow_child_unadmitted` before assignment |
| Report after the follow-up deadline | `deadline_status: success`, `usage_complete: false`, no complete amount |

## Remaining limits

Complete cost stays unavailable. There is no trace sequence or terminal watermark, so
a request in flight at stop, timeout, kill, budget stop or pause can be missing; an
`incomplete` gap marks those cases. A collector killed without `recover` leaves the
run `running` until recovery, and it cannot signal the native process; end that process
manually. Partial estimates need an explicit price table and are not bills. Native
stdout is discarded. Claude Code may update its own state files during a run, as any
invocation does.
