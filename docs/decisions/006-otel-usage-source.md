# Native OpenTelemetry export as the primary Claude Code usage source

Status: accepted 2026-09-28; Follow-ups 1 and 2 are done. The Follow-up 1
wording for run-level linkage (R01) and the loopback receiver boundary (R08)
was decided separately and is recorded in the requirements. An internal,
synthetic-only receiver and its storage (migration 005) now exist; see
[Offline receiver](#offline-receiver-follow-up-2). It launches no product
process. There is no CLI, report-schema change or supported product version yet.
The offline part of Follow-up 3 (launch-settings builders and a documented
precedence analysis) exists. See [Launch settings](#launch-settings-follow-up-3).
The approved live checks of Follow-ups 3 and 4 have run; see
[Live checks](#live-checks-follow-ups-3-and-4). They are bounded observations,
not a support claim; user-settings precedence remains open. On 2026-09-29 Codex
OTel was not adopted as a usage source; the rollout-file adapter is the primary
Codex usage candidate (see [Decision](#decision)). The ADR 004 evidence mapping of
Follow-up 5 is recorded in [Evidence mapping](#evidence-mapping-follow-up-5); no
scope has all eleven facts verified, so complete totals remain unavailable.
Requirements: [R01, R02, R04, R05, R07, R08, R09 and R10](../requirements.md).
R11 tool diagnostics are out of scope here. Documentation checked 2026-09-28.
Existing [adapter evidence](001-adapter-capabilities.md), the
[observation contract](003-local-observation-contract.md), the
[coverage evidence policy](004-complete-measurement-readiness.md) and the
[managed observation lifecycle](005-managed-observation.md) remain binding.

## Context

The goal is to compare harness configurations (A/B) on real development tasks
and report token use at maintained quality, so that a team can lower cost.

**Current sources and their limits:**
- Existing adapters read print-mode JSON, Claude transcripts and Codex rollout
  files as partial observations.
- Completeness remains blocked by message revisions, child accounting and
  exceptional boundaries.
- Headless stream output, the candidate producer interface for the ADR 005
  managed lifecycle, has two further limits:
  - Its event vocabulary is not fully documented and is version-coupled.
  - It covers only print-mode processes that the tool launches, not the
    interactive sessions where development tasks happen.

Both target products document opt-in OpenTelemetry (OTel) export.

### Claude Code

Source: [monitoring](https://code.claude.com/docs/en/monitoring-usage). Configuration precedence is in [settings](https://code.claude.com/docs/en/settings).

**Enabling export:**
- `CLAUDE_CODE_ENABLE_TELEMETRY=1`, plus standard `OTEL_*` exporter settings.
- Protocols: OTLP gRPC, `http/json` or `http/protobuf`. There is no default protocol.
- Per-signal endpoints and headers override or merge with the generic ones.
- Variables in user settings override exported shell variables. Managed settings
  and some launchers can replace exporter settings.

**Per-request fields:**
- `claude_code.api_request` carries:
  - `input_tokens`, `output_tokens`, `cache_read_tokens` and `cache_creation_tokens`;
  - `cost_usd` and `cost_usd_micros` (estimates) and `duration_ms`;
  - `model`, `request_id` and `client_request_id`;
  - `event.sequence`, a per-process counter;
  - `query_source`, an open set: for example `repl_main_thread`, `compact`, or a subagent name.
- `claude_code.api_error` carries `attempt`, the total attempt count, and `status_code`.

**Metrics:** default to delta temporality.

**Content and identity:**
- Excluded unless explicitly enabled: prompts, responses, tool details and raw bodies.
- Not excluded:
  - error text;
  - identity attributes: `user.email`, account and organization identifiers;
  - on some events, local workspace paths.
- `OTEL_RESOURCE_ATTRIBUTES` adds caller-defined keys to every record. Most
  standard keys cannot be overridden; `vcs.*` keys can, and gateway sessions
  ignore `user.*` and `identity.*` keys. Harness keys therefore use their own
  namespace.
- A `claude_code.managed_settings_resolved` event (v2.1.274+) is emitted at
  session start and lists managed-settings sources.
- A session can change `session.id` within one process, for example on `/clear`.

**Export timing:** default intervals are 5 s for events and 60 s for metrics.

### Codex

Sources: [advanced configuration](https://learn.chatgpt.com/docs/config-file/config-advanced),
[configuration reference](https://developers.openai.com/codex/config-reference) and
[approvals and security](https://learn.chatgpt.com/docs/agent-approvals-security).

**Enabling export:**
- `[otel]` `exporter` (`otlp-http` or `otlp-grpc`) is disabled by default.
- `metrics_exporter` defaults to `statsig`, and `trace_exporter` is set separately.
- `otel` in project configuration is ignored. Per-run overrides are possible
  through `-c`/`--config`. Managed configuration may also apply.

**Content:**
- Prompts are redacted by default (`log_user_prompt = false`).
- Tool result events can carry output snippets, and error details are included.

**Tokens:**
- A per-turn metric histogram splits input, cached input, output, reasoning
  output and total.
- An SSE event carries token counts on `response.completed`; its fields are not
  listed.
- A per-request token split on events is not documented.

**Other:**
- Exporters flush on shutdown.
- Export cannot reach a collector when the product runs without network access.
- Coverage of `codex exec` and a resource-attribute mechanism are not documented.
- No cost metric is documented.

## Decision

Adopt Claude Code's native OTel export, sent to a local harness-delta receiver,
as the primary usage source for sessions that the measurement CLI launches.
Codex OTel is not adopted as a usage source (user decision, 2026-09-29; see
[Live checks](#live-checks-follow-ups-3-and-4)). The rollout-file adapter is the
primary Codex usage candidate instead; see the
[Codex 0.158.0 rollout check](001-adapter-capabilities.md#codex-01580-rollout-check).
- This candidate currently covers explicitly linked, sequential `exec` sessions.
- Establishing an interactive Codex session's identity before any file access
  (R01) is unresolved.

**Status of the other sources:**
- For Claude Code, the existing adapters remain a separate cross-check source.
- For Codex, the rollout-file adapter is the primary usage candidate.
- OTel and adapter observations are never summed.
- Development of the headless stream interface as a usage source is paused.

### Transport isolation before any payload access

1. **One receiver per launched product process.**
   - It listens on an ephemeral loopback port, never on the default OTLP ports.
   - It requires an unguessable token in the exporter headers. Each launched
     process gets its own token, so the token identifies both the run and the
     process. A resume is a new process with a new token.
   - The token is revoked on pause, finalization or deletion. Later batches
     are then rejected before decoding.
2. **Check the token first.**
   - The token is checked before the request body is decoded. A request that
     fails is dropped undecoded.
   - Incoming headers are never stored or logged, because user credentials can
     be merged into them.
   - Undecodable bodies are dropped, never stored or logged.
3. **Claude settings are passed with `--settings`,** which ranks above user settings.
   They come from a file with 0600 permissions that is deleted after use, so the
   token never appears in the process list. They set:
   - endpoint, protocol and headers for the generic exporter and every
     per-signal exporter;
   - every `OTEL_LOG_*` content option off, including raw bodies;
   - traces to `none`.
4. **Codex uses an equivalent `-c otel.*` override set** covering the log,
   metrics and trace exporters. This mechanism must be verified before any Codex
   support claim. (Codex OTel was later not adopted; see [Decision](#decision).)
5. **Global configuration is never edited.**
6. **Fail closed on unverifiable configuration.**
   - Content-off and destination settings cannot be guaranteed against managed
     configuration or launcher overrides.
   - Readiness is ordering evidence, not a live handshake: the receiver
     listens before the process is launched. The run's usage is accepted only
     if two conditions hold:
     - the first authenticated batch contains the session-start event, carrying
       the lowest sequence value (the starting value is validated per version);
     - `event.sequence` is contiguous from that event.
   - For Claude, `managed_settings_resolved` is the candidate session-start
     event and override check.
   - If an override is detected or this ordering evidence is missing, the run
     is unsupported and its usage is recorded as uncertain, not measured.
   - The CLI stops measuring and tells the user. It does not terminate the
     user's product process.

### Linkage

1. **What establishes linkage.**
   - The per-process token links a payload to one registered, active task, run and process.
   - The following are then cross-checked:
     - a namespaced resource attribute (Claude only);
     - the product version;
     - the first `session.id`, against the session ID recorded at launch: the
       preassigned `--session-id` for a new session, or the resumed session ID
       for a resume.
   - A mismatch marks the process's usage uncertain. Excluded usage is always
     recorded with a reason, never silently dropped.
2. **This is run-level linkage.**
   - A process can report several session IDs, for example after `/clear`.
     A new `session.id` arriving under the same token, in sequence order, stays
     linked to the run.
   - Nested product processes do not inherit the `OTEL_EXPORTER_OTLP_*`
     destinations or the credential. Their usage is recorded as missing, never as
     zero. They can inherit the enable setting and beta tracing settings; their
     own configuration can name another export destination. An export that reaches
     this receiver without its credential is rejected before decoding. See
     [Launch settings](#launch-settings-follow-up-3) and R08 for this limitation.
   - Linking by run changes what R01 calls a linked session. R01 now records
     this wording.
3. **Supported sessions.**
   - Only sessions launched by the measurement CLI are in scope.
   - Desktop, IDE and launcher-owned sessions are not.

### Stored fields

**Stored:**
- event name, timestamp, per-process sequence (kept for every authenticated
  event, including event types whose other fields are dropped, so gaps can be
  detected);
- product version and model;
- session identifier and request identifiers;
- status and success, attempt and duration;
- token counts;
- a closed query-source category (`main`, `compact`, `subagent`, `auxiliary`,
  `other`), mapped from the raw value by a per-version table; unknown values
  map to `other`.

**Everything else is dropped.** That includes:
- identity attributes, workspace paths, repository attributes;
- raw query-source and agent names;
- error text, tool fields and prompt or response fields.

**Vendor cost estimates are not stored** until an explicit R05 decision. If
approved, they would be kept as a product estimate in integer micros, separate
from cost computed from a recorded rate source. Neither is a subscription bill.

### Usage events and integrity

**What counts as usage:**
- Claude per-request `api_request` events are the unit of usage.
- For Codex, the documented token split exists only in turn metrics. Codex
  usage therefore remains unverified until event-level counts or metric
  semantics are validated. (Codex OTel was later not adopted; see
  [Decision](#decision).)
- Metrics are only a cross-check and are never added to event totals.
- Temporality is recorded and validated before any metric aggregation.

**Idempotent keys** combine:
- product and the internal run and process identifiers bound to the token (the
  raw token is never stored);
- the event type;
- `request_id`, else `client_request_id`, else the per-process sequence.

`event.sequence` restarts per process, so it never serves as a key alone.

**Writes:**
- A conflicting payload for an existing key is rejected, never overwritten.
- The exporter receives success only after the durable commit.
- Authenticated records that are dropped by projection are also acknowledged,
  so exporters do not retry them indefinitely.

### Lifecycle

**Observation intervals:**
- The receiver must be ready before the first request. This is required for
  ADR 004's `readyBeforeFirstRequest`, but not sufficient, because that fact
  also covers startup and context usage.
- A receiver failure while the product keeps running creates an uncertain
  interval with no backfill.

**Pause and late batches:** the token is revoked at pause, finalization or
deletion, so later payloads are rejected before decoding.
- A pause therefore ends measurement for that product process. Exporter
  headers are fixed at launch, so continuing needs a newly launched process,
  for example a product resume, with a new token.
- Usage between the pause and that relaunch counts as missing, never zero.
- Batches still in flight at the pause (up to one export interval) are
  rejected. The interval before the pause may therefore be incomplete and is
  not backfilled, consistent with ADR 003 and ADR 005.
- Drain semantics equivalent to ADR 005 need a separately approved
  real-producer profile, because ADR 005 accepts only its synthetic profile.
- R07 tombstones apply. Late batches never reopen a task.

**Where usage goes:** it enters the existing event store as partial usage, and
`complete_tokens` stays null.

**Terminal accounting:** OTel has no documented terminal watermark, so
`terminalAccounting` may remain unverifiable.

### Comparison limits

**Measurement consistency:**
- One consistent instrument across arms is necessary but does not relax R05 or R10.
- That loss is non-differential across arms must be validated, not assumed.
  Two ways to detect it:
  - gaps in `event.sequence`. This needs validation that every sequence number
    is exported, and must allow for sequences restarting in each process;
  - comparison with the product's own result usage (`claude -p` result,
    `codex exec` JSON). This exists only in print mode; interactive runs can
    be cross-checked only against the transcript adapter.

**Scope of comparisons:** comparisons are made within one product and version,
never across products, because token semantics differ.

## Options considered

| Option | Interactive tasks | Stability | Privacy | Completeness path | Verdict |
| --- | --- | --- | --- | --- | --- |
| A. Headless stream decoder | No | Low: vocabulary not fully documented, version-coupled | Must filter content itself | Blocked by the unresolved protocol and startup | Pause |
| B. Transcript/rollout file adapters (current) | Yes (Codex: identity before access unresolved) | Medium: file formats undocumented | Files contain content; scope must precede reads | Blocked by revisions and child accounting | Claude: keep as a separate cross-check. Codex: primary usage candidate (2026-09-29) |
| C. Native OTel to a per-process loopback receiver | Launched sessions only | Higher: documented, opt-in | Prompts off by default, but identity, error text and Codex tool snippets need dropping; user or managed settings can redirect export | Claude per-request events; Codex unverified | **Adopt for Claude, fail closed**; Codex not adopted (2026-09-29) |
| D. HTTP proxy between product and API | Yes | Medium | Sees full prompts and responses | Complete request view | Reject: violates R02 |

**The main trade-off:**
- Option C trades a self-built parser of incompletely documented output for vendor
  telemetry that is itself self-reported.
- That telemetry is not a billing record and can lose data on abrupt exit.
- The residual risk is configuration drift from user or managed settings. It is
  contained by `--settings`, per-process tokens and a fail-closed readiness check,
  not eliminated.

## Consequences

**Easier:**
- Interactive Claude Code sessions launched by the measurement CLI become
  measurable.
- Claude subagent and compaction requests are attributable through a mapped
  query-source category, once a version's table maps their observed values.
- Failed requests expose their attempt count.
- Collection no longer depends on parsing product output streams.

**Harder:**
- The tool runs a per-process authenticated receiver and must detect configuration
  overrides.
- Vendor attribute changes need version-pinned synthetic tests.
- Codex OTel support depended on verifying per-invocation overrides and
  event-level token counts; it was not adopted (see [Decision](#decision)).

**Revisit:**
- Codex sandbox network behavior, if Codex OTel is reconsidered.
- Agreement between metrics and events.
- Flush behavior for short print-mode runs.

## Follow-up

1. Decide and record the linkage and collection-boundary wording in the
   requirements and capability documents.
2. Build the receiver offline with synthetic payloads:
   - token check before decoding;
   - allowlist projection;
   - idempotent keys and conflict rejection;
   - late-batch handling.
3. Verify Claude `--settings` precedence against user settings, and Codex
   `-c otel.*` overrides, without editing global configuration.
4. Run one small approved live check per product against the receiver:
   - compare OTel totals with the product's own result usage;
   - record flush and loss behavior.
5. Map the ADR 004 evidence to this source before any complete-total claim.
   Then prepare the R09 pilot protocol within one product and version.
   The mapping is in [Evidence mapping](#evidence-mapping-follow-up-5). The R09
   pilot protocol is not prepared: its frozen inputs are open user decisions.

## Offline receiver (Follow-up 2)

An internal, synthetic-only implementation exists in `src/otel-receiver.ts`,
`src/sources/otel-journal.ts`, `src/otel-projection.ts` and migration
`005_otel_receiver.sql`. It is not exported from the package entry point. It
has no CLI, launches no product process and enables no telemetry. No real
product version is supported: every accepted version needs an injected profile
that supplies the session-start sequence value and the query-source table.
The values decided for Claude Code 2.1.283 are recorded under
[Live checks](#live-checks-follow-ups-3-and-4); no profile ships in code yet.

**Transport:**
- One receiver per process, on `127.0.0.1` with an ephemeral port.
- The `x-harness-delta-token` header is compared by digest before anything else.
- The scope is then checked without reading the body, and again before the
  body is decoded, because a pause can happen during an upload.
- Rejected, oversized and undecoded bodies are drained unbuffered before the
  reply, so exporters receive a status rather than a reset connection. Above a
  128 MiB ceiling, the connection is destroyed.
- Only `POST /v1/logs` with `application/json` and no content encoding is decoded.
- Authenticated metrics and trace posts are acknowledged undecoded and never
  stored.
- Responses:
  - `200` after the SQLite commit;
  - `401` for a missing or foreign token;
  - `403` for a revoked or out-of-scope process;
  - `400` for an undecodable request or a conflict;
  - `404`, `405`, `413` or `415` for rejected transport;
  - `503` for a storage failure.

**Ordering and fail-closed rules:**
- A process is `pending` until its first record is `managed_settings_resolved`,
  trigger `startup`, at the profile's sequence value, with the launch session ID.
- After that, each sequence value must follow the previous one.
- These conditions make the process uncertain:
  - a missing session-start event;
  - a sequence gap;
  - a non-empty or unreadable `managed_settings.sources`;
  - a raw body event;
  - a `prompt` or `response` attribute whose value is not exactly `<REDACTED>`,
    the documented default when content logging is off;
  - an invalid record;
  - a record timed before the process was registered or after the receipt time;
  - a mismatched `app.version`, `harness_delta.process_id` attribute or
    session owner. Record and resource process attributes that disagree also
    count as a mismatch;
  - a conflicting payload.
- An uncertain process is revoked. An unmeasurable observation window opens at
  its last contiguous record and closes when the receiver closes or the task is
  paused or finalized.
- A process that ends while still `pending` becomes uncertain
  (`ordering_missing`). Its whole lifetime is recorded as an unmeasurable
  window.
- Contiguous records committed before that point remain partial usage.
- A conflict rolls back its whole request.
- An invalid record drops its whole request, because its position is unknown.
  Content exposure (a raw body event or an unredacted `prompt` or `response`)
  also drops its whole request, and it is the recorded reason when a request
  has both. The request is still acknowledged.

**Storage:**
- `otel_records` keeps allowlisted fields and a closed query-source category.
- Only `api_request` becomes a usage event, with the transcript adapter's
  component semantics:
  - input includes cache creation and cache read;
  - cached input is cache read;
  - reasoning is unmeasurable.
- Keys combine the product, run, process and event type with `request_id`,
  else `client_request_id`, else the sequence value.
- A task accepts either OTel processes or file-adapter sessions, never both, so
  reports cannot sum them.
- Pause, finalization and deletion revoke the process permanently. A resumed
  task needs a new process and token.
- A resume under a different product version is rejected at launch. A later
  session ID whose row has another product version is a scope mismatch.
- Writes take the SQLite writer lock at the start of the transaction.

**Launch requirement for Follow-up 3:** by default, Claude Code includes
`app.version` only when `OTEL_METRICS_INCLUDE_VERSION` is `true`. The
per-invocation settings must set that variable. Otherwise every record fails the
version check and the process becomes uncertain. A managed installation that
reports any managed source is always uncertain under this rule.

Tests: `tests/otel-projection.test.ts` and `tests/otel-receiver.test.ts`.

## Launch settings (Follow-up 3)

An internal builder in `src/otel-launch-settings.ts` produces the per-invocation
settings for one launched Claude Code process. Like the receiver, it is not
exported from the package entry point, has no CLI and launches no process.
Documentation checked 2026-09-28; live results are in
[Live checks](#live-checks-follow-ups-3-and-4).

**Claude settings.** The builder writes `{"env": {...}}` to a 0600 file in a
private 0700 directory and returns `--settings <path>` as the only arguments,
so the token is never in argv. The caller disposes the file after the process
exits. The `env` block sets:
- `CLAUDE_CODE_ENABLE_TELEMETRY=1`; logs `otlp`; metrics and traces `none`.
  Metrics are off because the receiver discards them undecoded and they carry
  account attributes; a metrics cross-check needs a separate Follow-up 4 decision.
- protocol `http/json`, the receiver endpoint, the token header and compression
  `none` for the generic exporter and for every per-signal exporter. Per-signal
  endpoints include their `/v1/<signal>` path.
- every documented content option off (`0`): `OTEL_LOG_USER_PROMPTS`,
  `OTEL_LOG_ASSISTANT_RESPONSES`, `OTEL_LOG_TOOL_DETAILS`,
  `OTEL_LOG_TOOL_CONTENT`, `OTEL_LOG_RAW_API_BODIES` and
  `OTEL_LOG_MANAGED_SETTINGS`.
- beta tracing off (`CLAUDE_CODE_ENHANCED_TELEMETRY_BETA`,
  `ENABLE_ENHANCED_TELEMETRY_BETA`, `ENABLE_BETA_TRACING_DETAILED`) and
  `BETA_TRACING_ENDPOINT` at the receiver, because detailed beta tracing
  exports logs to that endpoint instead of the logs exporter.
- `OTEL_METRICS_INCLUDE_VERSION`, `OTEL_METRICS_INCLUDE_SESSION_ID` and
  `OTEL_METRICS_INCLUDE_RESOURCE_ATTRIBUTES` `true`, which the receiver's checks
  need; `OTEL_METRICS_INCLUDE_ACCOUNT_UUID`, `OTEL_METRICS_INCLUDE_REPOSITORY`
  and `OTEL_METRICS_INCLUDE_ENTRYPOINT` `false`.
- `OTEL_RESOURCE_ATTRIBUTES=harness_delta.process_id=<process id>` and
  `OTEL_LOGS_EXPORT_INTERVAL=5000`, the documented default.

Endpoints other than `http://127.0.0.1:<port>`, header values outside the
base64url alphabet and invalid process identifiers are rejected with an error
that does not echo the input.

**Documented precedence** ([settings](https://code.claude.com/docs/en/settings#settings-precedence),
[environment variables](https://code.claude.com/docs/en/env-vars#precedence),
[monitoring](https://code.claude.com/docs/en/monitoring-usage#administrator-configuration)):
- Managed settings rank above `--settings`, which ranks above project local,
  shared project and user settings. `--settings` merges per key; an `env`
  block follows the same levels, per variable.
- A settings `env` value replaces the inherited shell value. Settings can set a
  variable but not remove one, so the builder sets every variable it depends on.
- Project and local settings cannot set the OTel exporter variables (v2.1.282
  or later), `OTEL_LOG_RAW_API_BODIES` or the detailed beta tracing pair
  (v2.1.251 or later). They can still turn a selector off with `none`, or
  `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_TOOL_CONTENT` or `OTEL_LOG_TOOL_DETAILS` off
  with `0`, but not when managed settings, a `--settings` file or the launch
  environment sets that variable; the builder sets all of them. No variable the builder sets is ignored in `--settings`.
- Managed settings lock the destination per variable (v2.1.217 or later): a
  managed generic endpoint removes developer-set per-signal endpoints, a managed
  protocol removes per-signal protocols, and managed credentials remove
  developer-set per-signal credentials and every developer-set endpoint. A
  managed endpoint alone leaves the builder's headers in place, so the token can
  reach a managed collector. It authorizes only posts to this loopback receiver,
  which then receives nothing and fails closed. Desktop and self-hosted launchers
  pin destinations the same way (v2.1.251 or later); launcher-owned sessions are
  out of scope.
- Claude Code does not pass `OTEL_*` variables to its subprocesses, so nested
  processes do not receive the token or the endpoints. Other `env` values reach
  every subprocess. Nested product processes therefore inherit
  `CLAUDE_CODE_ENABLE_TELEMETRY=1`, the beta tracing off values and
  `BETA_TRACING_ENDPOINT`. A nested Claude Code process whose own settings
  configure an exporter would then export there, outside the launched process.
  Setting the variable in the launch environment instead would propagate the
  same way. This is a known limitation of per-invocation settings.
- `0` turns off `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_TOOL_CONTENT`,
  `OTEL_LOG_TOOL_DETAILS` and `OTEL_LOG_ASSISTANT_RESPONSES`. The compression
  variables come from the OpenTelemetry exporter specification; the Claude Code
  documentation does not list them.

**Live-check items** (results in [Live checks](#live-checks-follow-ups-3-and-4)):
- `--settings` values win over the same variables in the shell: observed for
  2.1.283. Against user settings: not established (the check was inconclusive).
- `0` for `OTEL_LOG_RAW_API_BODIES` and the beta tracing flags: no body event or
  beta tracing export was observed with model requests. The defaults produce the
  same result, so this does not show that `0` disables them.
  `OTEL_LOG_MANAGED_SETTINGS`: not observable without managed settings.
- The exporter posts to `/v1/logs`, and the first batch starts with
  `managed_settings_resolved` at sequence 0, carrying `app.version`,
  `session.id` and `harness_delta.process_id`: observed.
- The generic and per-signal copies of the token header arrive as one value:
  observed (no authentication failure).
- An `otelHeadersHelper` in user settings, which `--settings` cannot remove,
  adds its headers to exports and blocks every export when it fails: not tested.
- Nested processes see `CLAUDE_CODE_ENABLE_TELEMETRY`: observed. They did not see
  the checked exporter variables (`OTEL_EXPORTER_OTLP_HEADERS`,
  `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_LOGS_HEADERS`).
- The token did not appear in the debug log. Session records were not opened:
  the interactive runs wrote them, and the model-request runs disabled session
  persistence.

**Codex overrides** ([configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference),
[basics](https://learn.chatgpt.com/docs/config-file/config-basic),
[advanced configuration](https://learn.chatgpt.com/docs/config-file/config-advanced)):
- `--config` overrides rank above project, profile, user, cloud-managed default
  and system configuration. Values are parsed as TOML, and project configuration
  ignores `otel`. `requirements.toml` lists no `otel` keys.
- The builder returns `-c` pairs that set `otel.exporter` to `otlp-http` with the
  receiver's `/v1/logs` endpoint (the documented example includes the path) and
  protocol `json`, and set
  `otel.trace_exporter` and `otel.metrics_exporter` to `none` and
  `otel.log_user_prompt` to `false`.
- Codex documents only static exporter headers. Passed with `-c`, a token would
  appear in the process list, so the builder accepts no credentials. The
  receiver therefore cannot authenticate a Codex process, and Codex OTel
  support stays blocked until an argv-free credential source is verified.
- Whether an inline table replaces or merges configured exporter tables, which
  could add configured headers or another exporter, is not established: the
  observed user configuration configured no exporter. Codex exports logs even
  without a turn.

Tests: `tests/otel-launch-settings.test.ts`.

## Live checks (Follow-ups 3 and 4)

**Conditions:**
- User-approved runs on 2026-09-28 and 2026-09-29, on macOS arm64, with Claude
  Code 2.1.283 and codex-cli 0.156.1.
- No global, user or project configuration was edited, and no workspace trust
  prompt was answered.
- Follow-up 3 submitted no prompt. Its runs started in an empty ignored
  directory inside an already trusted checkout.
- Follow-up 4 used a synthetic prompt and an empty directory outside any
  repository. The Claude runs also used a throwaway store.
- Only allowlisted data was recorded: counts, statuses, timings, byte counts,
  attribute key names, token counts, redaction markers, value-type names, models
  and raw `query_source` values.
- Product output, headers and telemetry bodies were not retained. A Follow-up 3
  debug log was deleted after its lines were counted.

**Follow-up 3 (no model request):**
- **Claude, interactive, shell layer.** The shell environment pointed every
  exporter at a decoy listener. The decoy received nothing. The receiver
  received two authenticated `/v1/logs` posts, and the process became ready.
  Records 0 to 11 were contiguous. The first was `managed_settings_resolved`
  (trigger `startup`, no sources) at sequence 0, with matching `app.version`,
  session and process attribute. The token appeared in no debug log line.
- **Claude, nested process.** A hook subprocess saw `CLAUDE_CODE_ENABLE_TELEMETRY`
  and `BETA_TRACING_ENDPOINT`. It did not see the three checked
  `OTEL_EXPORTER_OTLP_*` variables.
- **Claude, user-settings layer.** Tested with a temporary configuration
  directory. Inconclusive: the product did not reach telemetry start, and the
  receiver failed closed.
- **Codex, interactive.** With the token-free overrides pointing at a decoy, Codex
  sent three `/v1/logs` JSON posts without any turn.

**Follow-up 4, Claude (two runs):**
- **Command:** `claude -p` with `--output-format json`, the per-invocation
  `--settings` file, `--session-id`, `--no-session-persistence`,
  `--model haiku`, `--max-turns 1` and no tools. Context was reduced: no MCP
  servers, slash commands, CLAUDE.md, auto memory or Git instructions.
- **Usage:** in both runs the single `api_request` event matched the result's
  `usage` and `modelUsage` exactly (input, cache creation, cache read and
  output). No auxiliary request occurred.
  - Cache counts were zero in both runs, so cache-component semantics are
    untested.
- **Flush and loss:** each run exported one batch about 1.7 s after launch,
  before the 5 s interval. The process exited about 2.6 s after launch. The
  timing is consistent with a flush at shutdown. Nothing arrived after exit.
  Sequences 0 to 6 were contiguous, and the process stayed ready.
- **Content:** `user_prompt` carried `prompt` and `assistant_response` carried
  `response`. The second run recorded both values as `<REDACTED>`; the first
  recorded only the keys. No body event appeared. A separate change
  ([#9](https://github.com/Byuntil/harness-delta/pull/9)) makes the receiver
  fail closed on any other value.
- **Query source:** the raw `query_source` of print-mode requests was `sdk`.
- **Other attributes:** events also carry `user.email`, `user.id`,
  `organization.id` and `terminal.type`. `api_request` also carries `cost_usd`,
  `cost_usd_micros` and `ttft_ms`. Projection drops all of them.
- **Other events:** `plugin_loaded` and `hook_registered` appeared although
  user settings were excluded with `--setting-sources`.

**Follow-up 4, Codex (two runs):**
- **Command:** `codex exec --json --ephemeral --skip-git-repo-check
  --sandbox read-only` with low reasoning effort and the token-free overrides.
- **Listener:** exports went to a one-off, unauthenticated probe listener. It
  kept only request metadata (path, content type, bytes and timing), event
  names, attribute key names, redaction markers, token-count integers and their
  value-type names. This is feasibility evidence, not R01
  receiver behavior.
- **Export:** log batches arrived at whole-second offsets from launch (1 to 6 s),
  all before exit.
- **Content:** `codex.user_prompt` carried `prompt` with the value `[REDACTED]`.
- **Token counts:** they are on `codex.sse_event` with `event.kind`
  `response.completed`. They were observed over the websocket transport.
  - Input, output and `tool_token_count` arrive as strings; cached, cache-write
    and reasoning counts arrive as integers.
  - `tool_token_count` equalled input plus output.
- **Two completions per turn:** each turn produced two `response.completed`
  events.
  - In the second run, one event had zero output, and the exec
    `turn.completed` usage equalled the other event exactly.
  - Summing the events would therefore exceed the exec usage by the zero-output
    request's input.
  - The first run recorded only cached, cache-write and reasoning values. Its
    cached counts show the same shape.
  - Which figure reflects usage is not documented.
- **No sequence:** Codex records carry no `event.sequence`, so the sequence-gap
  rule cannot detect loss for Codex.
- **Version:** Codex updated itself to 0.158.0 after these runs, when an
  interactive session started. The evidence applies to 0.156.1 only.

**Decisions (user, 2026-09-29):**
- The Claude Code 2.1.283 version profile uses session-start sequence 0.
- Its query-source table maps only observed values, `sdk` to `main`.
  Documented but unobserved values, such as `repl_main_thread` and `compact`,
  map to `other` until observed.
  - `sdk` was observed only without tools or subagents. If print-mode
    compaction or subagent requests also report `sdk`, this table would count
    them as `main`.
- This profile is not a support claim, and no profile ships in code yet. Still
  unobserved: interactive-mode usage, subagents, compaction, retries and
  nested-process usage.
- Codex OTel is not adopted as a usage source. Three questions remain
  unresolved:
  - how to account for the zero-output request;
  - how to detect loss without a sequence;
  - which credential source keeps the token out of argv.
- Codex usage moves to the rollout-file adapter as the primary candidate.
  - In one exec run and one resume on 0.158.0, the rollout's cumulative counters
    matched exec usage and excluded the zero-output request.
  - Interactive session identity before file access is unresolved.
  - See the [Codex 0.158.0 rollout check](001-adapter-capabilities.md#codex-01580-rollout-check).

## Evidence mapping (Follow-up 5)

Mapped 2026-09-29 without a new product run, from this ADR, the
[coverage evidence policy](004-complete-measurement-readiness.md), the
[adapter capabilities](001-adapter-capabilities.md), the
[adapter profiles](007-adapter-version-profiles.md) and a manual Codex 0.158.0
conformance run (one `exec` turn and one resume, 2026-09-29) whose runner is
proposed in [#12](https://github.com/Byuntil/harness-delta/pull/12). That run's detailed results are not yet
published; they are cited here only as supporting observations.

Updated after the separately confirmed M2 admission run on 2026-09-29:
0.158.0 passed its required partial-scope checks and was registered. This updates
the scope and topology mechanism below; it does not clear complete-measurement
facts. See the [admission evidence](001-adapter-capabilities.md#codex-01580-rollout-check).

**Scopes:**
- Claude OTel: Claude Code 2.1.283 processes launched with the per-invocation
  settings of [Launch settings](#launch-settings-follow-up-3). The receiver and
  launch settings are internal and synthetic-only; no version profile ships and
  no measurement command launches them yet.
- Codex rollout: the file adapter. Production accepts exact versions 0.156.1
  and 0.158.0 through an explicit manual link. The 0.158.0 evidence covers `exec`
  and same-session resume under the M2 partial-scope policy. Interactive Codex linkage is unsupported. Each cell names the version it
  describes when the versions differ.

**States.** *Verified*: the harness mechanism is tested and the product behavior
it relies on was observed for this version and mode. *Mechanism only*: the harness
side is tested with synthetic input, but the product behavior is not established.
*Unknown*: not established. *Gap*: a known reason the fact does not hold for that
scope (ADR 004 `violated`). No cell currently reaches *Verified*.

| Fact | Claude OTel (launched, 2.1.283) | Codex rollout |
| --- | --- | --- |
| `scopeBeforeAccess` | Mechanism only: token checked before decoding, scope rechecked before the body; the token path was observed live | Mechanism only: registry rejection and an explicit manual link before reads. In the manual 0.158.0 `exec` run, the file was found by the exact exec-stream thread ID and a per-invocation SessionStart hook matched it. Interactive: gap |
| `freshSession` | Unknown: a new session ID is preassigned, but no source proves the task had no unobserved prior work | Unknown: a new thread is fresh; linking an existing session relies on the baseline rule, which does not recover earlier usage |
| `readyBeforeFirstRequest` | Mechanism only: the receiver listens before launch, and the first batch started at sequence 0 in the live checks; interactive startup and context usage are unknown | Unknown: the product writes the rollout; whether it records every request from the start is not established (see `requestUniverse`) |
| `continuousObservation` | Mechanism only: sequence contiguity, revocation and uncertain windows; export can be lost on abrupt exit | Mechanism only: pause and restart exclusion, rotation and truncation fail closed, no backfill |
| `fixedModel` | Unknown: the model is stored per request, but no rule fails a run on a model change | Mechanism only: a `turn_context.model` change blocks, but turn context does not prove the effective configuration ([ADR 001](001-adapter-capabilities.md)), and no model change was exercised |
| `boundedTopology` | Unknown: only `sdk` to `main` observed; subagent and compaction values unobserved; nested processes did not receive the checked exporter variables, so their usage is expected to be missing | Mechanism only for complete topology: 0.158.0 M2 partial admission passed root/turn and same-thread resume checkpoint checks, with capability `v2` and no observed children. Source-backed child activity items/events and inherited roots now block; synthetic regressions pass. Live child accounting remains unverified. 0.156.1 fails closed on its known shapes (ADR 001) |
| `requestUniverse` | Unknown: retries and auxiliary requests unobserved | Gap: a zero-output `response.completed` with nonzero input appears in the OTel export but in neither the rollout nor exec usage (0.158.0, ADR 001). Its meaning is undocumented, and [ADR 005](005-managed-observation.md) forbids omitting an unobserved warm-up request. Failed attempts unobserved |
| `terminalAccounting` | Unknown: no documented terminal watermark; one print-mode run's timing was consistent with a flush at shutdown | Unknown: after process exit, `exec` usage equalled the rollout total in one run and one resume (0.158.0), but process exit is not a terminal barrier (ADR 004) and no production barrier exists |
| `immutableIdentity` | Mechanism only: request-ID keys, conflicts rejected | Mechanism only: cumulative-vector keys, equal replays add nothing, conflicts fail |
| `durableFlush` | Mechanism only: success only after the SQLite commit; product-side export loss unknown | Mechanism only: collector transaction and partial-line waiting |
| `counterSemantics` | Unknown: cache components were zero live, so their semantics are untested | Unknown: on 0.158.0, cumulative totals held, total equalled input plus output, and cached and cache-write were within input; cache-write and reasoning were zero, so their inclusion and overlap are untested |

**Consequences:**
- No scope has all eleven facts verified, so `complete_tokens` stays null and a
  comparison can use only partial usage with explicit missingness.
- A pilot compares within one product and version, using one usage source for
  both arms.
- Subagents, retries, compaction and the unrecorded zero-output request can make
  loss differential between arms when the arms use these features differently.
  This must be validated, not assumed.
- Codex updated itself from 0.156.1 to 0.158.0 during this work. The process-only
  update controls in ADR 007 are documented but not verified against pinned
  binaries.

**R09 pilot protocol:** not prepared. Its frozen inputs are open user decisions,
and R09 forbids invented defaults: eligibility, classification, participants,
versions and manifests, product and model settings, allocation method and ratio,
primary and quality metrics, margins, sample plan, follow-up, stopping rules,
missingness policy, confidence level, analysis version, and the deviation and
version-drift policy. The R10 analysis validation, a shipped usage-source profile,
verified version pinning, the allocator and a quality metric are also
prerequisites.
