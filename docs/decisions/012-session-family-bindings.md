# Ordinary-session family bindings

Status: synthetic integration and an exactly qualified Codex 0.162.1 bounded
ordinary profile, accepted with actual ordinary-route evidence and independent
review on 2026-10-13.
Other native ordinary routes remain candidate-only.

## Product boundary

An explicitly selected registered project and prepared A/B task authorize reads.
One parent `harness-connect` call sends a native metadata receipt to the local
server. The provider resolves current identity and exact private source; cwd alone
never selects a task. The coordinator binds the parent, begins observation and
follows independently verified child relations recursively. Repeated calls confirm
the existing binding. New parents retain the persisted arm, price pin and original
open observation window.

The shared [SessionBindingProvider](../../src/session-binding-contract.ts) resolves
receipts, returns identity metadata, discovers direct relations and reads own-request
tokens/runtime with cursors and gaps. Optional native session/process/agent mapping
supports provider-specific topology. No prompt, response, code, secret or transcript
text crosses that interface. Exact source paths and receipts remain private local
state and are absent from UI DTOs and exported measurement records.

`POST /api/tasks/:id/session-connect` accepts product and receipt using existing
loopback, Origin, CSRF, If-Match and idempotency guards. Task reads expose sanitized
state, session IDs, root/child/request counts, blockers and partial usage. The UI
polls the same state. The skill re-reads it before success. It never opens transcripts,
guesses UUIDs or requires a separate invocation in each child.

## Observation and lifecycle

Preparation, admission and task generation checks precede provider reads. Source
mapping and ancestry checks precede source-body parsing. Async results are fenced
again before writes. Pause/deletion/human finalization stop collection. Server
restart pauses persisted bindings before source access. Reconnect baselines all
surviving sources without backfilling unobserved intervals. Adding a root preserves
existing live root cursors. Newly discovered children created inside observation
retain their first own request; older children are baselined without historical usage.

Native request IDs are globally deduplicated per product across sources, versions
and tasks. Conflicting replay stops collection. Providers exclude inherited parent
history using native ownership evidence. Existing billing/cache/reasoning semantics
remain unchanged. Missing runtime, incomplete requests, unsupported history and
limits remain explicit gaps. Partial usage never becomes a complete total. Human
completion and statistical adoption gates remain; full cost and inference are out
of scope.

## User sessions and automated qualification

The user owns ordinary native session startup, input and exit. The product
collector owns only explicitly authorized observation. Its source admission,
project/task/generation and preparation checks are independent of an automated
process owner, model choice or request/time safety budget. Normal pause, collector
failure and server close stop collection; they do not terminate a user session.
The declared observation window still bounds collection/report eligibility and
is not the native agent's lifetime.

`resume-binding` revalidates the one linked root using its privately retained
opaque connect receipt and current preparation,
then baselines the surviving family before future collection. Multiple linked
roots require explicit parent reconnect rather than an arbitrary root choice.
Older persisted bindings without a retained receipt require explicit parent
reconnect. Migration022 adds only the nullable private receipt; existing identities,
usage and assignment remain unchanged. No paused/offline usage is backfilled. Fresh connections still reject receipt expiry;
the Claude human pilot below permits only exact persisted live-binding revalidation
without an age cutoff. Source change, configuration
drift, closed windows and deleted/revoked scope remain blockers.

The isolated qualification runner optionally adds its opaque owner lease,
fresh-root/family pins, exact tested model/effort, safety request/token/deadline
limits and verified teardown. Its faults, emergency stop and receiver closure may
stop its own native process. These constraints do not grant ordinary source
admission and are not product requirements. The UI uses the same source authority
as the collector; provider/browser `productionSupported` assertions cannot open it.

The code-owned `codex-binding-01621-direct-family-v1` profile implements ordinary
Codex 0.162.1 CLI collection without a qualification lease or human-pilot
capability: one fresh root and up to two fresh direct children.

Model policy (user-approved 2026-10-15): this ordinary route accepts every
GPT-family model and doesn't force a reasoning effort. A task `initial_model` may be
null, in which case the observed native runtime model is used; a present
GPT-family `initial_model` and frozen task settings are kept as written. The
observed native model must be GPT-family, and model and effort are stored as
observed. Source format/version, registered project/task/receipt ownership,
ancestry, one root with two direct children, lifecycle, partial cost and
inference gates are unchanged. The 2026-10-13 trial ran gpt-6.1-sol/high and
remains the historical qualification evidence; no new native trial was run for
this policy and not every GPT-family model was tested. The qualification runner
still pins its own exact test runtime, separate from normal user acceptance.
Prior hook/source/counter observations came from the bounded lease-gated native
family qualification; they remain separate from the fresh ordinary authority
acceptance. The [2026-10-13 ordinary-route trial](../validation/codex-ordinary-binding-qualification.md#2026-10-13-ordinary-route-acceptance)
and independent review establish this exact bounded path.
New observations use separate `codex_binding` provenance rather than
promoting the existing file/launch fallback.
The implementation requires reviewed instrumentation, a frozen functional
protocol, registered task, a GPT-family observed model and exact permitted sources. Third/nested
members, non-GPT models and non-CLI roots are rejected. A new root cannot
reuse that task's family. Its normal coordinator never owns or stops the user's
process; paid validation safety instrumentation is separate from admission.

All other ordinary native family admission remains closed. Codex 0.160.0 needs actual
hook/materialized-path/header and own-counter conformance for the supported
family/history scope. Claude 2.1.291, 2.1.293 and 2.1.294 remain candidates and need actual transcript,
hook loading, family membership and own-counter conformance; nested immediate
parents are unverified. The Claude 2.1.296 transcript profile is qualified only for
bounded native print-mode evidence, following an offline actual-binary rehearsal
and one native print-mode pilot
([record](../validation/claude-ordinary-binding-02196-qualification.md)); that status does not
qualify interactive sessions or open ordinary admission. All ordinary Claude
profiles, including qualified profiles, require `allowCandidateProfiles: true`.
Default provider refusal and ordinary service admission remain closed; the UI
retains `native_unverified_pilot`, `legacy_unverified` and `candidate_pilot`.
Existing admitted workflow profiles and root-only
`no_child_activity` conformance cannot substitute for that evidence. A future
promotion requires sanitized evidence tied to the exact binary/source/profile and
implementation, plus independent review and a code-owned admission change.
An owned qualification probe can provide evidence without imposing owner control
on ordinary product sessions. No other gate is promoted by this exact admission.

## Native instrumentation and support

The [official Codex hooks](https://learn.chatgpt.com/docs/hooks) expose startup
identity/source and subagent shared root identity plus child agent ID. Transcript shape is
unstable. Documented hook fields therefore do not establish production admission;
both private receipts and matching native source metadata are required. Pinned native start hooks supply the child
thread's own rollout path after a materialization attempt; recorder/file checks
establish availability. Their session_id is the shared root, so
the provider verifies the exact child header's own ID, root ID, direct parent and
depth before following its usage. No source-directory scan, guessed path or
thread/read preview is used. See [pinned acquisition evidence](../validation/codex-ordinary-hook-source-acquisition.md). Synthetic
siblings and clean-history descendants are supported, with defaults of depth 8,
32 family members, 1,024 receipts, 8 MiB source size, 64 native turns and a 64 KiB
metadata header. Paginated inherited descendant history yields an unsupported gap.
A different project cwd is conservatively rejected.

`proposeCodexSessionBindingHooks` returns a reviewable project-only configuration
and writes nothing. The recorder persists allowlisted metadata in owner-private
POSIX files and injects the receipt into developer context. This local mechanism
is not remote authentication. It depends on reviewed exact hook trust and source
scope. Installing a skill alone cannot prove startup instructions were loaded.

Default providers remain blocked by code-owned admission except the exact
reviewed Codex profile above. Explicit provider injection in an isolated
synthetic-validation protocol exercises unsupported topologies without admitting
them as ordinary native sources.
Optional profile `session_binding` specifies Codex receipt directory, approved
source roots and project root, or Claude receipt and projects directories. Providers
are scoped per task to its exact registered project root; it grants neither trust nor native admission.
Existing production ticket/tool-owned profiles stay separate. Claude's implemented
ordinary transcript profile uses nativeMapping for root UUID and member agent ID. Official
[Claude hooks](https://code.claude.com/docs/en/hooks) and
[skills](https://code.claude.com/docs/en/skills) document invocation-scoped hooks,
metadata and process environment. PreToolUse records a connect receipt and the
same Bash helper locates it using process ancestry; explicit task selection remains
mandatory. Hook commands use project-only installation paths, not undocumented
skill-directory substitution. No installation, trust, permission allowlist or global
settings change occurs here.

Claude verifies hook-evidenced root-family members before own-source parsing.
Nested members are flattened under the root because direct nested-parent evidence
is unavailable; this is family membership, not a claimed direct-parent topology.
Members without ownership evidence and late old members produce gaps. Claude
baselines retain up to 1,024 distinct excluded own request IDs separately from the
rolling observed replay window; overflow, unreadable or partial baseline fails
closed with a fixed blocker. Missing baseline counters still retain an owned ID.
Changed counters on an already observed request stop collection as a conflict. Child
re-calls confirm independently discovered active members; paused families use
authorized same-live-root UI resume or parent reconnect. Candidate formats/counters and actual hook loading remain
qualification-pending. Same-user metadata files are a local trust boundary and
cannot prevent deliberate same-user forgery; they are not remote authentication.

Migration021 queues minimal Claude native IDs and project scope before deletion
cascades. Bootstrap/connect/tick retry metadata-only forgetSession before source
access. Deleted families suppress future receipts; native transcripts are never
removed. Failed cleanup stays queued with a fixed reason. Paused collectors do
not read transcripts although session metadata hooks can continue running.

## Qualification and evidence

Review the concrete project hook proposal, existing hook merge, exact native/source
profile, local metadata/source roots and a bounded start boundary first. Applying
hooks/trust and any actual model call require separate authorization. Use a disposable
project and fixture database, never original user conversation history/database.
Test a normal new parent, at least two siblings and a supported descendant, repeated
connection, pause/reconnect and a new parent. Verify native relation/source fields,
request ownership and sanitized artifacts. Record exact native conformance before
lifting the production gate. Installation does not enforce model/effort; the skill
has no version-install requirement.

| Acceptance | Isolated local evidence |
| --- | --- |
| Explicit task/native proof, root/relation conflicts | Service and Codex provider tests |
| Multiple siblings, supported descendant, first child response | Service/provider/API tests |
| Global replay/conflict; inherited history exclusion | Service/provider tests |
| Pause/restart/new root, no backfill, arm/price pin, deletion fence | Service/API tests |
| HTTP connection starts collector, task reads reflect usage | Real local server/domain/store/parser with synthetic hook/source fixtures |
| Portable receipt re-read and legacy compatibility | Harness-connect package tests |

See `tests/session-binding-service.test.ts`, `tests/session-binding-codex.test.ts`,
`tests/session-binding-api.test.ts`, `tests/session-binding-claude.test.ts`,
`tests/session-binding-claude-api.test.ts` and `skills/harness-connect/tests/*.mjs`.
Local results are separate from remote CI and actual native source qualification.

### Collaborative native pilot

A local operator may explicitly observe one isolated Codex 0.160.0
`functional_pilot` task using the candidate profile
`codex-01600-ordinary-human-pilot`. This grants candidate evidence collection,
not ordinary production admission. A process-local exact-task/provider capability
is separate from browser/profile inputs and owned qualification. Source-free
preparation grants no reads. Native provenance and the persistent unverified pilot
label are retained; user-owned agents are never launched or terminated by this
path. Scope is one fresh root and two direct children; all existing identity,
preparation, generation, window, dedup and pause fences still apply. Assignment
preparation alone may use the candidate; normal activation/adapter execution and
real allocation remain gated. See the
[collaborative pilot procedure](../validation/codex-human-session-pilot.md).

## Claude human pilot preparation

The local operator's existing human-pilot authority now supports the separate
`claude-ordinary-human-pilot` profile at an exact listed ordinary version.
2.1.296 is qualified only for bounded native print-mode evidence, not interactive
qualification; the other listed versions remain candidates.
Production admission stays closed. Source metadata freshness and family pins
precede transcript row scans; the pilot permits one new root and two members,
with flattened membership rather than an asserted nested direct-parent topology.

Claude UI resume uses only the persisted binding's pinned receipt and full live
process/source identity. Receipt age and source inactivity do not expire that
existing authorization. New connection still requires a fresh receipt; scope,
preparation, source replacement, revocation and deletion continue to fail closed.
Missing legacy process proof fails closed and requires a separately prepared task
and fresh Claude root without replacing the old stored identity. Explicit-stop
collection never imposes a native deadline or process termination. Baselines
exclude unobserved usage after pause/restart. Synthetic evidence is not actual
native qualification; see the paired [pilot procedure](../runbooks/harness-connect.md#claude-human-operated-ui-pilot).

## Ordinary Claude observation

A later, separate path observes ordinary Claude work that has no A/B assignment.
It doesn't change anything above: the comparison binding, the Codex profile, the
human pilot and the 1,024-ID Claude baseline cap all keep their behavior and
trust. That path has its own code-owned admission, which is currently closed,
and its own durable baseline store. Its native qualification is pending. See
[ADR 016](016-ordinary-observation.md).
