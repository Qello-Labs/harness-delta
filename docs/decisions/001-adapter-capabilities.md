# Adapter feasibility and collection boundaries

Status: implemented partial sequential CLI adapters; no complete measurement claim.
The [offline coverage evidence policy](004-complete-measurement-readiness.md)
is synthetic-only and does not enable complete totals or expand adapter support.
Checked on macOS arm64 on 2026-09-26. Requirements: R01, R02, R04, R05.

## Evidence and limits

Two newly created, explicitly scoped synthetic sessions were run, then resumed
once by exact ID. Both initial and resumed invocations exited successfully.
Only metadata was retained; fixtures below are independently authored synthetic
examples, not copies of sessions. No existing personal session was opened.
The initial probes performed no tool calls. Additional dedicated synthetic sessions
ran one `printf READY` Bash/command operation per product. This is not live compaction, child-agent, rotation,
concurrent-turn, interrupted-turn, or complete observation validation.

| Source | Version observed | Status and blocker |
| --- | --- | --- |
| Codex CLI exec JSON and rollout JSONL | 0.156.1 and 0.158.0 (partial adapters) | Primary Codex usage candidate. Partial adapter for explicitly linked, sequential sessions; the adapter accepts these exact registered versions. Complete measurement is blocked by unverified exceptional boundaries and child accounting. See the [0.158.0 rollout check](#codex-01580-rollout-check) |
| Codex desktop | Not probed | Unsupported until a dedicated app session establishes identity, version, and counter behavior; CLI evidence does not establish app parity |
| Claude Code print JSON and transcript JSONL | 2.1.283 | Partial adapter for explicitly linked, sequential sessions; complete measurement blocked by message revisions, exceptional boundaries, and child accounting |
| Claude Code native OpenTelemetry export | 2.1.283 | Unsupported primary candidate ([ADR 006](006-otel-usage-source.md)). Bounded live checks: shell-layer precedence held, session start at sequence 0, prompt and response redacted (second run), and in two single-request print-mode runs the event usage matched the result usage, with timing consistent with a shutdown flush. Cache semantics, user-settings precedence, interactive usage, subagents, compaction, retries and nested-process usage are unverified |
| Codex OpenTelemetry export | 0.156.1 | Not adopted as a usage source ([ADR 006](006-otel-usage-source.md)). Token-free per-invocation overrides routed logs, and event-level token counts exist, but a zero-output completion per turn is absent from exec usage. There is no event sequence and no verified argv-free credential source. Sandbox network behavior is unverified |

## Codex 0.158.0 rollout check

This was a user-approved bounded check on 2026-09-29, on macOS arm64 with codex-cli
0.158.0.

**Conditions:**
- **Runs:** one `codex exec --json` run, then one `codex exec resume` of the same thread.
  Both used synthetic prompts requesting a one-word reply, low reasoning effort and a read-only sandbox,
  from an empty directory outside any repository.
- **Locating the rollout:** by the exact thread id from the exec stream, matching file
  names only. No other session file was opened.
- **Reading:** the file was read in memory once after each run. Only allowlisted metadata was retained:
  record and event type counts, key names, version, source, model, identity-match
  booleans and token integers.
- **Other data:**
  - A one-off OTel probe recorded the same runs.
  - Configuration was not edited.
  - The rollout file was left in place.

**Results:**
- **Counters:** the single `token_count` after the first run had equal cumulative and
  last-turn usage.
  - Values (input, cached, cache-write, output, reasoning): 15775, 8960, 0, 5, 0. This
    equalled the exec `turn.completed` usage.
  - After the resume, the cumulative total was 31568, 24576, 0, 10, 0. For every field,
    it equalled the previous total plus the new last-turn usage.
  - The resumed exec usage reported the same cumulative total. The cumulative
    semantics observed on 0.156.1 held in this one exec-plus-resume check on
    0.158.0.
- **Zero-output requests:** each run's OTel export also had a zero-output
  `response.completed` of 13346 input tokens. It appears in neither the rollout nor the
  exec usage.
- **Format:**
  - Top-level record types: `session_meta`, `event_msg`, `response_item`,
    `world_state`, `turn_context` and `token_usage_record`.
  - `session_meta.id` matched the exec thread id, and `cwd` matched the launch
    directory. `cli_version` was 0.158.0, `source` was `exec`, and the same file
    was appended on resume, which added `thread_settings_applied` events.
  - The usage objects add `cache_write_input_tokens`.
  - `session_meta` carries account and user identifiers, which must never be retained.
  - No compaction, fork or collaboration record appeared.
- **Not verified:**
  - the keys of the turn start and completion events;
  - the contents of `token_usage_record`, which may be a second usage surface and must
    not be summed;
  - how `session_id` relates to `id`;
  - nonzero reasoning;
  - handling of `cache_write_input_tokens` (the adapter reads four usage fields).

0.158.0 was admitted on 2026-09-29 after a fresh typed-confirmed exec/resume run passed the M2 partial-scope gate. The observed multi-agent capability was `v2`; no child activity was observed. Counter agreement, paired/root turns and a newly observed same-thread resume checkpoint passed. The shared production parser is covered by normal registry/link/collector/report synthetic integration tests. At admission time this did not establish a live product collector window, complete coverage or interactive linkage. The later bounded collector smoke and current offline integration retain partial-only limits; see the [readiness assessment](../validation/codex-01580-offline-readiness.md).

File adapters accept only the exact registered versions Codex CLI 0.156.1/0.158.0 and Claude Code 2.1.283. `session link --version` is required manual input. Unregistered versions, ranges, and suffixes are rejected before the file is read and are not stored. Codex 0.158.0 is registered under the [M2 partial-scope policy and admission workflow](../runbooks/codex-version-admission.md). OTel profiles are a separate allowlist and are not consulted by this file registry. See [ADR 007](007-adapter-version-profiles.md).

## Fields

`available` means observed in this bounded probe, not a universal product guarantee.

| Field | Codex CLI | Claude Code |
| --- | --- | --- |
| Input | available: total and last usage | available: per-message input |
| Cache | available: cached input; cache-write field observed zero | available: cache creation and cache read, separate from ordinary input |
| Output | available: total and last usage | available: per-message output |
| Reasoning | ambiguous: field observed zero, nonzero inclusion unverified | ambiguous: nested thinking field observed zero, nonzero semantics unverified |
| Timestamp | available in rollout records; absent from exec usage | available in transcript records |
| Model | available in turn context | available in assistant message |
| Configuration | partial; turn context does not prove effective global configuration | partial; message model does not prove effective global configuration |
| Parent/child | ambiguous; no child was generated | ambiguous; parentUuid is a message relationship, not proof of a child session |
| Resume counter | available: cumulative across both invocations | available: each result's usage matched its new assistant message, not both messages summed |
| Runtime | unavailable as model runtime from exec usage | ambiguous: duration_api_ms increased across resume; do not treat it as per-invocation model time |

Codex's initial input/output totals were 15728/5; resumed totals were 31482/10.
The last-use counters after resume were 15754/5, exactly the difference.
Adding both cumulative totals would double-count the first invocation. Cached
input was below total input; total_tokens equaled input_tokens + output_tokens.
Nonzero reasoning and cache-write inclusion still require validation.

Claude's initial input/cache-create/cache-read/output were 2/1758/531/4;
its resumed values were 2/880/1459/4. Cache inputs must not be subtracted
from its ordinary input. The [official caching contract](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
explains the separate input components. Do not sum nested iteration counters
in addition to the enclosing usage.

The [Codex exec documentation](https://learn.chatgpt.com/docs/non-interactive-mode)
describes JSON events including usage and content-bearing items. The
[Claude programmatic interface](https://code.claude.com/docs/en/headless)
describes exact-session resume. These sources establish interfaces, not all
local transcript semantics or support for untested versions.

## Scope before access

The probe registered its dedicated working directory and active feasibility task
before launching each process. Claude used a preassigned session UUID; Codex's new
thread ID was captured from thread.started in the dedicated process stream and
subsequently recorded in the local scope registry before opening its rollout.
The probe did not enforce a durable session link before processing stream usage;
that is a limitation of this feasibility probe, not production gate evidence.
Only files whose names matched these exact IDs were subsequently opened. The
metadata inside agreed with the known working directory and session IDs.

OpenTelemetry sources have no file to open. Their scope comes from run-level
linkage under R01: a per-process credential issued at launch, checked before any
payload is decoded. The OpenTelemetry rows summarize the bounded live checks in
[ADR 006](006-otel-usage-source.md#live-checks-follow-ups-3-and-4); neither row is
a support claim.

A production adapter must receive an explicit project/task/session/source mapping
before opening a source. Do not discover membership by opening all transcripts.
`discover(projectRoot)` may return already authorized mappings only. A path or
filename supplied without trusted linkage is insufficient proof of membership.
Local source paths and access permissions are local configuration, never shared
measurement fields. Permission failures must yield a fixed error code.

Product streams and transcripts contain raw content. Reading an authorized source
may encounter that content in memory; extract only allowlisted metadata, never
persist raw lines, diagnostics, hashes of content, or arbitrary error messages.
The collector now resolves registered/active/linked mappings before bounded source
reads under a SQLite writer lock. Synthetic tests cover that boundary separately
from these feasibility probes. No raw source hashes or raw exception messages persist.

## Boundary decisions and remaining validation

- Resume: observed only for two sequential successful turns per product.
- Compaction/reset: unverified; a decrease or changed counter epoch must not become
  a negative delta, observed zero, or automatically complete total.
- Rotation/truncation: unverified; identity changes or size decreases must invalidate a cursor. Ordinary append
  growth must not invalidate it; same-size replacement also needs validation.
- Pause/restart: synthetic collector and CLI tests verify new baselines and excluded
  in-flight turns; live pause/reset/rotation semantics remain unverified.
- Parent/child: unverified. Do not auto-link descendants or add parent/child totals.
- Unknown versions/formats, partial writes, conflicting revisions: exact
  registration remains separate from conditional parser reuse. Unsupported or
  incompatible data preserves a reason and never manufactures zero.
  [ADR 013](013-forward-version-compatibility.md) defines an implemented compatibility-unverified
  lane for newer releases within finite declared windows; implementation is in
  `src/source-compatibility.ts`.
  Unestablished format/identity/counter contracts and conflicting revisions still
  stop observation. Exact verified registration is defined in [ADR 007](007-adapter-version-profiles.md).
- Current bounded snapshot reader: local file identity, size, modification time,
  generation, baseline and allowlisted metadata fingerprints. Incomplete final lines
  wait for completion. Every new collector ignores durable checkpoints for resumption.

The fixtures encode cumulative/individual counters, replay, reset candidates,
unverified child identity, and unknown format. Their expected handling is described
in [the fixture notes](../../tests/fixtures/adapters/README.md). They prove no live
support. The collection implementation must not advertise complete measurement based on these probes.


## Implemented diagnostic boundary

Additional authorized synthetic tool sessions passed the implemented parsers:
each yielded two usage records and one confirmed execution with a known originating
turn. Codex normalized input/output sums were 30122/47; Claude sums were 7233/79.
These are probe observations, not product benchmarks or complete task totals.

- Codex: `event_msg.item_completed` / `CommandExecution`, matching `turn_id`,
  `started_at_ms`, numeric exit code. Count the leaf command once; do not also count
  `response_item.custom_tool_call` wrappers. Exit zero confirms completion; nonzero
  exit does not by itself prove a broken tool, and remains an unknown outcome.
- Claude: a scoped assistant `Bash` tool-use ID matched to a scoped user tool-result
  with the observed Bash result shape, `is_error: false`, and `interrupted: false`.
  Completion keeps the invoking prompt's origin across later prompts. Error,
  interruption, permission denial and validation rejection remain ambiguous.
- Only these command/Bash subsets are measured. General external tool counts and
  execution-failure totals are unavailable. Search/read classification and actual
  first edit/test/oracle milestones are deferred; command text is never classified.
- Unknown topology/compaction/reset or overlapping Codex turns block the batch.
  Changing project identity is rejected. Missing topology evidence always prevents
  complete totals even when no explicit boundary was seen.

See `tests/sources/adapters.test.ts`, `tests/sources/collection.test.ts`, and
`tests/cli-integration.test.ts` for independently authored synthetic fixtures and
failure/boundary behavior. Runtime tests and live probes complement each other;
neither establishes untested app or descendant parity.

## Fidelity and availability follow-up

Synthetic regressions preserve the first explicit Codex cumulative vector even
when all counters are zero. Its identity is the session and cumulative vector;
repeated equal vectors, including later timestamps or turns, do not establish new
observations. No row means missing, not zero. Startup and pause/restart baselines
still exclude pre-existing and in-flight observations. This does not establish
per-turn zero usage from unchanged counters.

Claude exact normalized message replay retains the first message's originating
prompt, including an unknown origin, across intervening prompts. Its timestamp,
model, usage and recognized Bash invocation IDs must still agree; conflicting
revisions remain errors, including metadata changes between collector polls. Replayed
Bash invocation metadata must not move an earlier invocation to a later prompt.
These are synthetic fidelity guarantees, not evidence that every replay layout
occurs in the pinned product.

A subsequent bounded Claude initial/resume probe reproduced a collection failure
classified as `same_size_modified`: size was unchanged while modification time
changed between snapshots. It did not establish whether source contents changed
or why the product modified the file. The resumed interval remained excluded;
its original raw-content change and cause remain unknown. A follow-up scoped
probe established equal normalized usage metadata at this condition. The
collector now accepts a stable same-size Claude rewrite only after validated
measurement metadata equality, including prompt origins before usage arrives;
true revisions and uncertain intervals still invalidate the checkpoint. Synthetic
tests cover touch, ignored auxiliary changes, real revisions, baseline boundaries
and rollback. These checks alone do not establish live availability. The diagnostic categories in the
[observation contract](003-local-observation-contract.md) distinguish conditions
without relaxing source stability or completeness rules.


A later bounded confirmation on the same pinned versions produced eligible
post-baseline partial reports for both products. Claude preserved its baseline
across a stable same-size metadata-equal modification; Codex's controlled driver
observed zero exact filename matches followed by one match 26 ms later. The driver
waited only for the newly obtained exact session ID and completed durable linkage
before decoding content-bearing stream bytes. Baseline usage stayed excluded and
repeated polls/restart did not duplicate usage. This resolves those bounded
availability probes, not complete collection, billing truth or exceptional-boundary
support. A subsequent synthetic review correction rejects conflicting replay input
components even when their normalized sum is unchanged; that adversarial case has
not been exercised with a live product.
