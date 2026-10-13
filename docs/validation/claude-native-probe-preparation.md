# Claude native probe preparation

This additive preparation lane starts no product and performs no authentication
lookup. It remains internal and absent from package exports and the public CLI.
Use it with the [trace candidate](claude-child-trace-candidate-readiness.md) and
[R01, R02, R04, R05 and R07](../requirements.md). No native profile, complete
measurement, real comparison or inference gate is enabled.

## Verified bounded native probe and current support contract

One separately approved run of the exact Claude Code 2.1.288 binary completed
with `claude-sonnet-5-5` / `high` for both root and one direct child. The run
recorded root startup, child binding and stop, session end, two root usage rows
and one child usage row under the same task. Three distinct native request IDs
and three matching runtime records were retained; attribution was verified.
The probe used the synchronous-child configuration described below. Its successful
execution confirms existing login and that requested runtime for this one run;
it does not authorize another call or establish other model/provider availability.

The observed ordinary input, cache read, cache creation and output counters remain
separate. Reasoning output was missing, and three `not_available` gaps remain.
No cost was computed. Session end and process success do not establish the full
request universe or a terminal export watermark. No natural exporter re-delivery
occurred in this native run; replay idempotence was verified separately offline
using the pinned binary with a localhost stub API.

This is an internal probe contract, still pinned to 2.1.288. The ordinary assigned workflow
was later admitted separately as parent-only `claude-workflow-own-trace-v1`, first for 2.1.288
([retired record](claude-workflow-02188-source-readiness.md)), then for 2.1.291
([retired record](claude-workflow-02191-source-readiness.md)) and now for 2.1.296
([admission evidence](claude-workflow-02196-source-readiness.md)). 2.1.296 also has a
separate [single direct-child admission](claude-workflow-02196-direct-child-source-readiness.md).
Those admissions do not qualify this probe's child topology, other versions,
complete cost or inference.

## Preparation and admission interfaces

`prepareClaudeNativeProbe` in `src/claude-native-probe.ts` validates caller-supplied
exact binary identity, Claude Code 2.1.288, `claude-sonnet-5-5` and `high` effort.
The identity declaration is caller evidence, not executable/backend attestation.
Preparation writes an immutable token-free manifest and private disposable
settings/agent/MCP files. Every telemetry signal destination is loopback; traces
are enabled in these candidate settings only, metrics are off and all content
flags remain off. The existing production settings builder is unchanged.
The prepared settings are not activated by creating them.
Launch arguments pin `--permission-mode dontAsk` in both probe and workflow modes:
2.1.288's default auto mode runs a permission classifier whose extra requests use
another model. The two-root/one-child probe also sets
`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`, because 2.1.288 otherwise launches the
Agent child asynchronously and adds a root request. Workflow mode keeps native
background behavior; the separately admitted 2.1.296 direct-child profile uses that asynchronous single-child path.

`reserveClaudeProbeAction` creates exclusive one-use launch and child reservations
bound to the manifest's process ID. It fsyncs the file and containing directory
before returning. Child reservation requires an existing launch reservation.
Disposal removes ephemeral configuration; it preserves the manifest and reservations.
Reopening cannot authorize an automatic paid retry. This preparation module does
not spawn; the separate internal supervisor owns that explicitly approved boundary.

`ClaudeProbeCoordinator` in `src/claude-probe-coordinator.ts` starts with one
explicitly linked root and one declared child slot. The bounded loopback
gateway calls `authorizeRequest(token)` before buffering/decoding any bytes,
then call `acceptHook`, `ingestLogs` or `ingestTraces` using scoped callbacks.
The coordinator checks its process token, active linked scope, captured generation,
tombstones and a 120-second absolute observation window before callback access.
Trace routes also call `authorizeTraceRequest(token)` before buffering and again
before decoding. Until startup, policy sequence and the direct child binding exist,
they return 503 and discard the body without decoding, revocation or queued backfill.
The pinned 2.1.288 OTLP exporter retries only 429/502/503/504 and drops a batch on
other statuses, so 503 lets the sender re-deliver its own batch; exact replay is
idempotent. Retries are bounded by the exporter and the observation window, so
early root exports may still be missing; this boundary proves no first-delivery or
completeness guarantee.

A trusted run-bound `SessionStart` confirms the declared root. Pinned 2.1.288
print-mode `SessionStart` input carries `source` but no `model`, so the hook model is
checked only when present; every request trace still enforces the requested model
and effort. One matching
`PreToolUse` reserves the direct Agent invocation; `SubagentStart` binds its
agent ID and type into the active task transaction before trace decoding.
The child has the root's process/native session, a distinct local child ID and
an explicit parent relation. Matching hook replay binds once; another child,
resume/background request or contradictory identity stops admission.
Transcript paths and last-assistant-message fields are ignored.

Logs establish session-start/policy/contiguous-sequence evidence only. Normalized
allowed metadata identifies replay; duplicate attributes, changed identity,
conflicting sequence, gaps, policy override and content-enabled data stop the lane.
API error/refusal logs stop qualification without creating error usage.
Log usage/model/effort fields never create or supplement a usage record.

Traces require startup and child-binding evidence and exact requested model/effort, then delegate
to the unchanged `ingestClaudeTraceBatch`. Request conflicts revoke admission while
preserving previously committed partial usage. Missing/malformed/unmapped traces
and requests beyond two root requests or one child request stop qualification.
Counts come from new committed usage rows per session; exact replay does not
increment them and three root requests cannot replace child evidence. The coordinator
retains only allowlisted metadata/keys; it never opens native transcript files.
Its log keys are in memory; native qualification and a durable production run
owner are still separate requirements.

## Internal execution connection

`startClaudeProbeGateway` binds an ephemeral 127.0.0.1 port, accepts only bounded
authenticated JSON hook/log/trace routes and rechecks scope after uploads.
`prepareClaudeProbeHookMediator` creates an ephemeral mode-0600 process token and
a bounded command that projects hook identity/control metadata without transcript
paths or tool/prompt/response content. The token itself is absent from argv.
`prepareClaudeProbeSupervisor` verifies the exact executable hash, canonical empty
registered project and active prelinked scope; it prepares private disposable files
and the local gateway. Preparation makes no product or authentication call.
Its separate `run()` method permanently reserves one launch before spawning,
ignores stdout/stderr, enforces the absolute maximum 120-second window and kills
the process group on exit or stop. It never retries. Terminal evidence requires
startup, child binding/stop, session end and exactly two root plus one child usage
insertions. A successful synthetic run cannot qualify native semantics.
Artifact, executable and process-token readers use nonblocking NOFOLLOW opens,
regular-file checks and bounded reads; a FIFO cannot block their initial open.
The supervisor is internal, absent from the public CLI and package exports.
No central OTel service or persistent integration is needed.
The manual internal `scripts/claude-minimal-command.mjs` entry wraps this connection:
`prepare DIRECTORY EXACT_BINARY SHA256 BUILT_MEDIATOR` creates a private empty
fixture, SQLite task and immutable execution intent without activating telemetry
or starting a product. `execute INTENT_FILE CONSENT_FILE` requires both specific
actual-model and transient trace/log/hook consent bound to the intent SHA and an
opaque user-approval reference. It exclusively reserves one execution request,
then uses the supervisor and preserves sanitized result/SQLite evidence. This
consent file is a trusted executor witness, not automatic proof of permission;
obtain actual user approval first. A consumed intent cannot run again.
`createClaudeMinimalIntent` and `executeClaudeMinimalIntent` remain internal and
do not implement a development workflow adapter or admit a production source.
Do not wire trace usage into the production log journal: the existing mixed-source
guard prevents double accounting and must remain.

The [hook reference](https://code.claude.com/docs/en/hooks#subagentstart) documents
child identity but says SubagentStart cannot block creation. Reservation and cutoff
mechanisms therefore do not prove a hard cap on in-flight native requests.
The [subagent reference](https://code.claude.com/docs/en/sub-agents) documents model,
effort and turn settings; exact native enforcement remains unverified.

## Authentication and version decision

The official [2.1.289 change record](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#21289)
notes, under VSCode, a revert of a 2.1.288 auth-status change that may have increased
sign-outs. A 2.1.288 auth-status invocation is not established as side-effect-free.
This preparation runs no auth status, reads no credential file/keychain and performs
no login/update. User confirmation of an existing login avoids that status-command
risk but remains an assertion until a separately approved runtime succeeds/fails.

The bounded successful run above confirms existing authenticated execution for
that invocation. It made no auth-status, login, credential-read or update call;
its result is not a reusable authentication or provider-availability attestation.

2.1.289 is not interchangeable with this exact 2.1.288 lane. Its changelog is
not an attestation that trace/schema/counter semantics are unchanged. A version
change requires an explicit decision, new exact-version candidate evidence and
native qualification; do not update automatically or infer admission.

## Proposed execution limits and consent

A separately approved minimal run requests the same pinned model and `high` effort
for a root and one direct child. The intended flow has two parent model requests
and one child request, in one top-level launch. Preparation fixes a 120-second
window, two root turns, one child turn and a USD 0.10 CLI estimated budget.
These are stop conditions, not guaranteed backend request or billing bounds:
auxiliary calls, retries/fallback, delayed export, in-flight billing and escaped
descendants can exceed observable thresholds. The small budget may stop before
the intended flow finishes. Do not automatically repeat it.

Before execution, approve the specific model run and transient per-invocation
trace/log settings plus child-start binding. Confirm existing login/provider
without sending credentials. No new login, credential read/copy by the assistant,
persistent configuration change or model fallback is authorized by preparation.
Stop on authentication failure, unsupported provider/version/model/effort,
missing startup/child identity, policy/content/destination conflict, source gap,
model/API-request retry, missing terminal evidence or the first required scope
change. Bounded telemetry exporter re-delivery remains subject to the replay
checks above and does not authorize a model/API-request retry.

## Offline checks

```sh
npm test -- tests/claude-native-probe.test.ts tests/claude-probe-coordinator.test.ts
npm run check
```

These tests use synthetic callbacks, temporary private files, isolated SQLite
stores and temporary Node executables for supervisor cutoff checks. They invoke no
product model, authentication command or native transcript read. Full checks also
include existing synthetic loopback tests and require loopback permission.
Independent review covers the exact integration delta. The bounded native probe
above supplements these offline checks. General native enforcement, provider
availability beyond that run, all-request completeness and remote CI remain
unverified.
