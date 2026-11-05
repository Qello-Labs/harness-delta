# Nested-session candidate readiness

This record describes the earlier candidate stage. Later, the separate fresh-root/
single-child workflow was admitted; see [current direct-child evidence](codex-workflow-01600-direct-child-source-readiness.md)
and [current workflow limits](../runbooks/task-native-workflow.md#single-direct-child-launch-and-durable-collection).
The earlier offline connection summary below is historical. Family resume remains unsupported.

This internal candidate covers explicitly mapped parent/child request metadata.
It implements bounded preparation and observation for a pinned Codex CLI 0.160.0
root with one direct child. It is absent from the public CLI, package exports,
production adapter allowlist and real comparison workflows. It does not admit a
new production profile or prove general descendant collection.

An offline assigned-workflow connection now accepts an explicit `direct_child`
mapping for `link`/`collect` in the synthetic test adapter. It binds the root and
one direct child to the same task assignment and configuration confirmation,
collects their future own responses atomically, and persists child inode/prefix
checkpoints across database reopen. Child request identity collisions roll back
the whole tick; previous partial usage remains. Root and child models/effort come
from their own request metadata. The family path rejects fork/history-base,
compaction and deeper-child evidence, and never follows inherited source paths.
At that stage, the separate `codex-workflow-direct-child-v1` profile was absent from the production
registry, so production family input failed before selected instructions or source
contents were accessed. Launch/resume was root-only. This was an implemented
offline connection, not admitted native child support; historical qualification
of the candidate is not qualification of this new workflow connection.

The applicable public requirements are [R01–R05, R07 and R11](../requirements.md):
authorize scope before source access, minimize retained data, preserve usage and
replay integrity, distinguish incomplete observations, respect deletion, and
report safe diagnostics. Existing [capability limits](../decisions/001-adapter-capabilities.md)
and [exact-version admission](../decisions/007-adapter-version-profiles.md) remain.

## Projection and collection boundary

`src/nested-candidate.ts` validates explicit local/native session mappings and
projects only request usage and runtime metadata. The Codex projection pins
`SessionMeta`, `TurnContextItem` and `TokenUsageRecord` semantics from
[openai/codex a956835d](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/protocol/src/protocol.rs).
Each completed response belongs to its native thread and authorized root turn.
Ancestor copies and cumulative token_count mirrors are excluded. Paginated child
history requires explicit ordinal and parent-history boundaries; unsupported
history remains unavailable.

Usage keys identify the product/version/provider request independently of local
source or session aliases. Replay is idempotent; conflicting identity, runtime or
usage fails closed. Input components are disjoint ordinary input, cache read and
cache write. Cached input is already included in input; reasoning is already
included in output. Missing metadata is not zero.

The candidate collector requires the entire exact linked set in an active task
and registered project before reading any source, and rechecks authorization
after each bounded read. It checks generation, source continuity, initial turn
boundaries and append-only identity. The candidate-only lifecycle binder allows
one root and one direct child, rejects mixed sources and tombstoned records, and
does not change ordinary session linking or collection defaults.

The Claude Code 2.1.288 projection is an offline candidate for explicitly mapped,
completed request traces and correlated API metadata, based on the documented
[monitoring fields](https://code.claude.com/docs/en/monitoring-usage).
Agent/process identity is required; an API log alone does not establish child
attribution. Exact native schema admission and real Claude collection are
unverified. Synthetic tests do not establish product compatibility.

## Bounded qualification lane

`prepareCodexQualification` prepares an isolated caller-supplied fixture, exact
binary identity, ledger, hook recorder and invocation arguments without executing
a product CLI. `run` is a separate explicit model-execution boundary requiring
authorization. The intended root/child settings are gpt-6-astra/high and
gpt-6.1-sol/high. One-use root and child reservations survive restart and cannot
be reset for an automatic retry.

An explicit `reuseExistingHome: true` option allows the native process to reuse
an already authenticated home without requiring an empty sessions directory.
The default still requires an empty directory. This opt-in does not inspect or
copy credentials, read prior transcript contents, clear sessions or reset old
reservations. Each run still needs a new empty fixture, active task, private
ledger and specific actual-call approval. Only exact fresh native hook paths
with birth times after this launch are linked and read; an old exact callback
source fails before content access. This is qualification access only, not a
comparison assignment or production workflow adapter.

The observer verifies root/direct-child hooks, source identity and declared
managed read-only/restricted permissions. Legacy and modern permission shapes
are checked explicitly; missing, contradictory or changed declarations fail.
Initial root delivery, root waiting, observed child spawn and child handoff are
distinct stages under one absolute maximum of 180 seconds. Child handoff timing
starts from qualified spawn progress; callbacks do not extend the total deadline.
V1/V2 fresh-child arguments and modern activity events are handled explicitly.

The process-group cutoff and delayed observation are best effort. Native hooks
may fail open; internal requests, escaped descendants, in-flight billing and
token/cost caps are not enforced. Declarations and local tool acceptance are not
proof of provider backend identity or security enforcement.

Stdout is discarded. Opt-in stderr diagnostics retain only fixed categories and
codes, with bounded transient bytes, lines and signal counts. Unknown and
truncated observations stay explicit; raw stderr, prompts, responses, source
content, credentials and personal source paths are excluded from retained
diagnostics and public fixtures.

## Verification and current limits

Run offline synthetic checks with Node 24:

```sh
npm test -- tests/nested-candidate.test.ts tests/codex-candidate-collection.test.ts tests/qualification/codex-qualification.test.ts tests/workflow/bounded-candidate-invocation.test.ts tests/workflow/bounded-candidate-diagnostics.test.ts
npm run check
git diff --cached --check
```

These commands do not invoke real Codex or Claude models. The tests cover request
attribution, cache/output accounting, deduplication and conflicts, active/deleted
scope, source changes, permission shapes, staged timers, durable reservations,
fake-process teardown and bounded safe diagnostics.

One separately authorized Codex 0.160.0 qualification run completed on macOS
arm64: three parent own responses and one direct-child own response. All four
mapped one-to-one to runtime/usage records; close/reopen replay inserted zero.
Own-response sums matched native turn/thread cumulative and cache counters in
that run. Parent cumulative usage excluded the child's own records. This
observation predates integration with the preceding diagnostic PR and a final
malformed-child identity guard repair. That repair rejects missing child identity
before source access, reservation or registration and is verified synthetically.
The final published lane has not had another real model run.

The observation establishes only this controlled flow and its observed subset.
It does not establish all-request completeness, product-wide nested support,
general resumes/deeper descendants, or Claude real collection. Applicable fixed
prices for the two actual models were unavailable, so observed partial and full
costs remain null, not zero. Fictional test prices cannot be applied to real
models. Complete usage/billing coverage, production cost profiles, actual bills,
savings claims and inferential comparison remain unavailable.

## Assigned native child connection followup

The workflow adapter now connects its launch/resume metadata hooks to the explicit
family collector under one task/configuration confirmation, rather than requiring
manual child paths after execution. Read-only `child_runtime`, transient agents
settings, fresh direct-child source/initial-context guards, shared own-request
collection and durable child checkpoints are implemented in the shared engine.
The actual CLI root-to-child resume/replay route and a separately intent-bound
one-shot family qualification entry are verified with synthetic processes. See
[the current direct-child workflow contract](../runbooks/task-native-workflow.md#single-direct-child-launch-and-durable-collection).

At this historical candidate stage, the adapter/CLI wiring had offline evidence
without child admission. Earlier observations could not qualify the changed engine
and root consent could not authorize a family run. A later separately approved
family qualification admitted the limited fresh-root/single-child profile; see
[the admission record](codex-workflow-01600-direct-child-source-readiness.md).
Family resume remains unadmitted. Claude general workflow and whole-task cost
coverage remain separate blockers.
