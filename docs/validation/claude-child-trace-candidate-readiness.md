# Claude child trace candidate readiness

The internal Claude trace candidate connects synthetic OTLP HTTP/JSON request
spans to the PR25 parent/child usage projector and durable request deduplication.
It adds no production adapter, public export, measurement CLI command, or product
launcher. Claude Code 2.1.288 child traces remain unadmitted. The assigned workflow is admitted
separately for 2.1.296: a parent-only profile ([evidence](claude-workflow-02196-source-readiness.md))
and a read-only single direct-child profile ([evidence](claude-workflow-02196-direct-child-source-readiness.md)). Existing 2.1.283 partial file
collection and the production OTel receiver are unchanged.

This document describes the candidate lane. A later separately approved bounded
2.1.288 native probe succeeded with two root and one direct-child usage records;
see the [current probe evidence and support contract](claude-native-probe-preparation.md#verified-bounded-native-probe-and-current-support-contract).
That result does not admit child execution or establish completeness.

Applicable requirements are [R01, R02, R04, R05 and R07](../requirements.md).
See [ADR 006](../decisions/006-otel-usage-source.md) and
[the nested candidate limits](nested-session-candidate-readiness.md).

## Sources and qualification limits

The official [monitoring documentation](https://code.claude.com/docs/en/monitoring-usage#traces-beta)
describes request spans, agent/parent identity, cache components and optional
request effort. Its version floors establish documented availability, not the
exact emitted schema of an installed binary. The
[2.1.288 release notes](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#21288)
include retry/timeout behavior changes; they do not qualify trace delivery or
all-attempt accounting. Both sources are mutable. The
[OTLP specification](https://opentelemetry.io/docs/specs/otlp/#json-protobuf-encoding)
defines JSON field encoding and trace identifiers independently of product
semantics. Beyond the bounded probe's observed request/counter shape, native
2.1.288 schema coverage, source continuity and terminal delivery still need
separately authorized evidence.
No real model call was made for the original candidate change. The later probe
evidence linked above verifies only its exact synchronous configuration.

The current `OtelReceiver.handle` acknowledges `/v1/traces` without decoding.
Its log journal retains usage without effort or agent identity; this candidate
does not silently change that channel. Transcript `parentUuid` is a message
relationship and does not establish a child session. Existing synthetic tests
characterize these limits separately.

## Internal path and tested boundary

`src/claude-trace-candidate-receiver.ts` owns a bounded, ephemeral `127.0.0.1`
receiver for one explicit process mapping. It starts no product and configures
no exporter. The random token authenticates the local transport only; it does
not prove native producer identity. Token, linked active scope, deletion and
captured task generation are checked before decoding and after body upload.
The receiver accepts only bounded `/v1/traces` JSON bodies and logs no bodies
or headers. A pause/resume requires a new receiver, preserving its new start
boundary. A listener has no durable process reservation; this is an internal
candidate, not the production run-level linkage mechanism.

`src/claude-trace-candidate.ts` projects only request metadata from explicitly
mapped process/session/agent identities. Root and child must share the registered
native session and process; parent-agent identity must match the local mapping.
Unmapped agents stay unattributed. Separate nested processes require their own
credential and binding; this candidate does not qualify inherited credentials
or native same-process provenance.

The parser requires version agreement, valid trace/span IDs and finished request
intervals. It rejects ambiguous duplicate attributes/AnyValue leaf types, unsafe known counters and
contradictory identities. Decimal-string or safe numeric OTLP intValue and integral
doubleValue counters are decoded without rounding; unsafe/fractional values fail.
It admits only successful single-attempt spans;
failed, retried or request-ID-free spans remain unavailable. Content, identity,
query-source names and tool attributes are discarded from retained measurements.
An omitted OTLP default `UNSET` status is accepted, but explicit malformed status
is rejected. Optional cache counters stay missing and effort stays null when absent.

The transactional bridge calls `ingestCandidateObservation`. Provider request
keys are independent of local aliases, so exported replay counts once and
root/child collisions fail. One outer transaction rolls back the whole batch on
conflict, including newly inserted runtime records and gaps. Existing log/managed
accounting registrations prevent source access; their usage is never summed with
trace usage. Ordinary input, cache read and cache write are disjoint inputs.
Reasoning remains missing rather than adding an inferred output component.

Only requests starting after the listening boundary and finishing by receipt are
eligible. Older/future intervals are excluded; restart cannot backfill them.
Each batch records unavailable trace continuity because there is no qualified
sequence/terminal watermark. All-request completeness, complete estimated cost,
actual bills, real experiments and inference stay unavailable.

## Concrete production connection still required

The future insertion point is the `/v1/traces` branch in `OtelReceiver.handle`.
Calling this bridge directly there would conflict with existing `otel_processes`
registration and double-count the log journal. A separately approved integration
must choose one usage owner: trace requests for usage and logs only for validated
session-start, sequence and policy evidence. It must preserve credential and
generation revocation and transactional deletion. Do not remove the existing
mixed-source guard to make both accounting channels run together.

Before enabling that path, qualify an exact 2.1.288 profile, register the native
process and root before collection, and bind each child using independently
scoped metadata before payload access (a qualified child-start hook is a candidate).
The current receiver uses a fixed explicit mapping; it does not discover children
or buffer unknown child telemetry for later backfill. A production binder and
native evidence are necessary before a supported interactive launch command.

Launch settings also need separately authorized validation: the existing builder
turns traces off, and enabling the beta trace exporter changes collection scope.
Verify per-invocation destination precedence and every content gate; do not edit
user/global settings, inspect credentials, or build another OTel service.

## Historical native probe proposal

The following proposal preceded the later approved successful probe. It grants
no new execution authority. The current implementation avoids auth-status calls
and pins `dontAsk` plus synchronous child execution as described in the linked
probe contract; the proposal below is not a current execution recipe.

Use the existing installed exact-version binary after rechecking its identity.
The proposed pinned Anthropic API model is `claude-sonnet-5-5`, effort `high`,
for both root and one direct child, subject to account/provider availability.
The official [model configuration](https://code.claude.com/docs/en/model-config)
and [CLI reference](https://code.claude.com/docs/en/cli-reference) describe explicit
model/effort selection; this is a proposal, not observed backend configuration.
A provider alias or model fallback must stop qualification rather than silently
substitute another model.

Before any invocation, obtain approval for the telemetry/child-binding path and
one launch, then confirm existing login state through a bounded status command
that emits only logged-in/unsupported/error. Never read a keychain, token file,
email/account identity or raw auth output. No new login or credential copy is
permitted. The status command itself is still unexecuted here.

The minimal intended flow is one parent request to spawn one direct child, one
child response with no tools, and one parent completion: three intended model
requests in one top-level launch. No repeats, retries, deeper children, teammates,
resume, compaction, source-file access or independent child process are in that
probe. Prepare one-use launch/child reservations and a process-group cutoff first.
Do not rely on prompting alone to enforce these limits.

The proposed stop thresholds are three observed request attempts, 120 seconds
wall time and USD 0.10 estimated API usage. These are qualification stop conditions,
not guaranteed billing caps: internal auxiliary requests, in-flight billing,
provider retries, exporter delay, escaped descendants and subscription billing can
exceed observable bounds. A CLI budget flag, if supported in the exact binary,
is supplementary and must be verified before relying on it. An enforceable total
request/cost upper bound is not established, so report that limitation before
asking for execution approval. Use no fictional price entry for a real model.

Stop on version/model/effort disagreement, missing start/child identity, unmapped
agent, retry, content-enabled or redirected telemetry, managed-policy override,
source gap, missing terminal delivery, auth failure or any need for another login.
Retain only sanitized metadata and classify incomplete evidence as unavailable.
Do not automatically retry a failed qualification. This proposal grants no
permission to execute it.

## Offline verification

Run with Node 24 from this isolated checkout:

```sh
npm test -- tests/claude-trace-candidate.test.ts tests/claude-trace-candidate-receiver.test.ts tests/claude-offline-verification.test.ts tests/nested-candidate.test.ts tests/otel-receiver.test.ts tests/otel-projection.test.ts
npm run check
git diff --check
```

The HTTP tests require loopback listener permission and use only synthetic bodies
and isolated test databases. Tests cover replay/reopen, whole-batch rollback,
missing/zero readings, explicit identity/version boundaries, private-field
exclusion, unmatched agents, old intervals, token isolation, body-upload revocation,
and unchanged production gates. They invoke neither Claude nor Codex and read
no actual transcripts or authentication state. General workflow native compatibility
and remote CI remain unverified beyond the bounded probe. Independent review belongs to the consolidated
integration review rather than repeated per-task agents.
