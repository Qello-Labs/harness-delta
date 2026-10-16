# Forward-version compatibility policy

Status: implemented 2026-10-08; exact-version qualification remains separate.

Requirements: [R01, R02, R04, R05, R06 and R09](../requirements.md).
This decision supersedes ADR 007's blanket rejection of unregistered versions
as the operating policy. Exact-version registration remains the evidence
boundary for verified support. The measurement CLI and existing functional native workflows use finite
conditional windows. This does not qualify newer releases as verified.

## Decision

For ordinary local measurement, a newer regular release within a declared
compatibility window should use the previous verified parser by default, without
waiting for an exact-version admission. Its data is compatibility-unverified.
Runtime contract checks still apply, and a known incompatible release is blocked.
Verification later promotes supported releases through the existing reviewed
admission procedure. Successful parsing alone never establishes verified support.

The purpose is to keep local measurement usable during frequent product updates
while exposing uncertainty instead of silently presenting inherited assumptions
as evidence. A small version-number change is a selection hint, not proof of
stable log structure, counter meaning or execution behavior.

## Profile selection and scope

A reviewed, code-owned compatibility rule must name the product, usage source,
previous verified parser/profile, parser revision, supported operations/topology,
and a finite forward version window. Resolve that rule deterministically before
source access; do not try multiple parsers until one accepts a record. A new regular
release within the window needs no individual registration to use the fallback.
Bounds are source-specific implementation decisions, not an assumption that all
releases sharing a major or minor number are compatible. The implementation must
publish its actual bounds and tests before enabling this policy.

An exact verified match takes precedence over fallback. Known incompatible versions
are blocked in both paths until a reviewed fix and fresh verification clear the
block. Versions outside all declared windows, older versions without an exact
profile, malformed versions and prereleases remain unsupported. Do not strip a
suffix, alias a new version to the old one, or change a historical parser variant
to fit changed semantics.

The registered project, active task and explicit session/source or authenticated
run linkage remain prerequisites. Parser reuse grants no additional file access,
session discovery, descendant collection, permission, exporter destination or
content retention. The actual source version must match its declared version;
using an older parser never permits falsifying the product identity.

File parsing and native execution require separate compatibility rules. A file
format rule cannot authorize launching a new executable. Native rules must preserve
the supported invocation, hooks, credential binding, permissions, runtime and
termination contract, as well as the parser's counter checks. Bind each launch
to its actual executable identity and detect replacement rather than skipping
integrity checks to accommodate a new release. Session topology and operations
outside the base profile remain unsupported.

## Data trust and reporting

Persist three distinct compatibility states:

| State | Meaning | Reporting treatment |
| --- | --- | --- |
| Verified | Exact product/source/profile semantics have reviewed evidence | Eligible observed data remains subject to existing partial-coverage limits |
| Compatibility-unverified | A newer release uses a declared previous parser and passes runtime checks | Show a labeled local reference estimate, separate from verified aggregates |
| Invalidated | An incompatibility makes an observed interval unreliable | Exclude it from usable aggregates and disclose the affected interval/reason |

Usage payloads carry `source_compatibility`; session enrollment pins its selection.
Compatibility is independent of observation completeness: verified partial data
is still partial, and an unverified zero remains distinct from missing/error data.
Store the actual product version, applied parser/profile revision and compatibility
rule revision with observations. Carry their trust state and any invalidation into
local reports and supported exports. Legacy observations without such evidence
must not be silently labeled verified during migration.

Personal task and cost views may show compatibility-unverified observed tokens and
reference costs with a visible label and separate totals. Existing price-source,
model/date and arithmetic requirements still apply. Do not mix these estimates
into verified aggregates, confirmed cost claims or inferential adoption decisions.
Each report must expose the unverified and invalidated portions, including an
all-unverified task; filtering them out must not produce an apparent measured zero.

## Detection and correction

Keep required-field/type, nonnegative safe-integer, counter continuity/subset,
replay/conflict, session/model identity and supported topology checks. Unknown
structures that prevent establishing those contracts stop collection. Additional
unconsumed fields may be ignored through the existing allowlisted extraction;
they must never be copied into diagnostics or automatically added to sums.

On a failed contract, stop the affected observation, record a fixed sanitized
reason, and invalidate the uncertain interval. Other unaffected sources may
continue. A later source review or cross-surface check can reveal a semantic change
even when no parser exception occurred. Identify affected data by actual version,
parser and rule revision; invalidate previously collected estimates in that cohort.
If a narrower reliable boundary cannot be established, treat the entire affected
version/parser cohort as uncertain. Subsequent reports must honor the invalidation.
Already exported snapshots cannot be silently repaired; identify them as affected.

Block the incompatible release, reproduce the problem with synthetic fixtures,
add a named parser variant when semantics change, and run focused tests, the full
implementation checks and independent review before clearing the block. Fast repair
must not weaken scope, privacy, deduplication or counter checks. Diagnose using
allowlisted metadata and source evidence, without retaining raw session contents.

New qualification applies prospectively. It does not silently rewrite the trust
state of earlier observations, reparse excluded history, backfill offline intervals,
restore deleted records or change task assignments. Any retrospective correction
needs an explicit, reproducible revision with sufficient retained metadata; missing
content is not a reason to start retaining prompts, responses or source code.

## Frozen experiments and version drift

Automatic fallback applies to ordinary local measurement. A frozen randomized
experiment retains its declared exact versions and deviation policy. A compatible
new parser does not authorize changing that protocol or pooling different versions.
Functional reference views may expose unverified estimates but gain no verified
source-readiness or inference claim from them.

Version or executable drift during an active run still stops the uncertain
observation. Resolve the new version for a subsequent explicitly linked run and
establish a new baseline; do not switch parsers halfway through a cumulative
counter interval. Existing no-backfill and no-rerandomization rules remain in force.

## Implementation acceptance

Before enabling fallback, demonstrate with synthetic tests that:

- Exact profiles win; forward-window boundaries, blocked versions, malformed
  input, prereleases and unsupported source/topology fail as specified.
- In-window releases reuse the designated parser without falsifying the source
  version; out-of-scope sources are rejected before content access.
- Missing/changed fields, resets, subset violations and replay conflicts stop the
  affected interval without emitting a false zero or double counting usage.
- Product/parser/rule provenance and trust survive storage, replay, reports and
  supported export/import boundaries; old records have conservative migration.
- Unverified estimates and invalidations remain separate from verified totals,
  complete-cost/readiness claims and frozen experimental evidence.
- Later incompatibility blocks new collection and invalidates the affected cohort;
  prospective qualification and fixes do not silently promote or backfill history.
- Native executable replacement and invocation/hook contract failures cannot be
  bypassed by a file compatibility rule or a version declaration.

Update the paired user runbooks with the implemented windows, visible status and
recovery procedure. Exact admission still requires separate reviewed evidence.


## Implemented windows and evidence

`src/source-compatibility.ts` owns these stable-version windows. Exact matches win.

| Source | Previous verified parser | Conditional releases | Preserved scope |
| --- | --- | --- | --- |
| Codex file | 0.158.0 checkpoint parser | >0.158.0 and <0.164.0 | Linked sequential root, partial usage |
| Claude file | 2.1.283 message components | >2.1.283 and <2.2.0 | Linked sequential root, partial usage |
| Codex workflow | 0.160.0 own responses | >0.160.0 and <0.164.0 | Existing root operations and read-only direct-child profile |
| Claude workflow | 2.1.296 own trace | >2.1.296 and <2.2.0 | Fresh parent-only launch |

As of 2026-10-10 the official stable releases are [Codex 0.162.1](https://github.com/openai/codex/releases/tag/rust-v0.162.1)
and [Claude Code 2.1.296](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#21296).
Both file sources fall within the implemented conditional windows and remain
unverified. Codex 0.162.1 workflow collection is also conditional, not an exact
admission. Claude 2.1.296 is now the exact workflow base described below, not a
conditional workflow release. Synthetic fallback tests establish conditional behavior,
not new live admission.

The 2026-10-16 UTC check of official GitHub and npm metadata agrees on
[Codex 0.163.0](https://github.com/openai/codex/releases/tag/rust-v0.163.0) and
[Claude Code 2.1.301](https://github.com/anthropics/claude-code/releases/tag/v2.1.301).
Both still select the existing conditional file and root-workflow parsers.
Codex remains below 0.164.0 but crosses a `0.x` minor boundary. The
[target implementation](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/core/src/session/mod.rs#L4948-L5101)
now records supplied usage for some incomplete responses in spending totals without
replacing the installed context baseline. That accounting change, saved permissions,
interruption and process-output changes require actual target-binary conformance.
Claude remains below 2.2.0, but undocumented transcript semantics and changes to
compaction, hooks and telemetry remain qualification concerns. The
[pinned Claude changelog](https://github.com/anthropics/claude-code/blob/03b5892ee77de289bcd5dfa39f541525ade74aff/CHANGELOG.md)
also reports new transcript API-parameter content and 5m/1h telemetry fields;
neither may be copied or added to aggregate counters without its own reviewed
projection. Existing parser
selection is not evidence that these consumed contracts are unchanged.
This maintenance snapshot adds synthetic target regressions, not exact admissions,
new ordinary binding candidates, wider windows or native qualification. Existing
ordinary source gates and historical trust are preserved.

Subsequent 2026-10-16 Codex 0.163.0 ordinary-route native acceptance established
the separate exact `codex-binding-01630-direct-family-v1` source for a fresh root
and up to two fresh direct children, with partial observed usage only. It does not
qualify file/workflow sources, incomplete-response completeness, resume or deeper
topology, and does not rewrite earlier unverified observations. See the
[route-specific acceptance](../validation/codex-ordinary-binding-qualification.md#2026-10-16-ordinary-route-acceptance).

On 2026-10-13 the Claude workflow base moved from 2.1.291 to 2.1.296 with its own
[exact admission](../validation/claude-workflow-02196-source-readiness.md); 2.1.289
through 2.1.295 are unsupported for that source. Keeping or resuming a session and the
separate `claude-workflow-direct-child-v1` profile need the exact version and have no
conditional window. Claude Code 2.1.296 file collection remains conditional.

Migration 024 preserves original events and stores session provenance and durable
version/source blocks separately. New usage inherits the enrollment pin; legacy
native records without provenance remain `legacy_unverified` report references.
A known blocked product/version excludes those references conservatively through
read-time `source_invalidated` metadata, without inventing parser provenance.
No migration reparses session contents. A block conservatively invalidates the
whole local product/version/source cohort because narrower trustworthy timing is
unavailable. Original event and snapshot bytes stay immutable; report reads and
repricing disclose affected trust, and saved external copies cannot be recalled.
There is no automatic unblock command: clearing requires a reviewed repair and
fresh verification, not merely a restart or successful parse.

`hm compatibility status` shows bounds and local blocks. `inspect` resolves a
specific product/version/source without reading session contents. `invalidate`
records a fixed reason and blocks new source access. Collector diagnostics contain
only session IDs, UTC times and fixed categories. Native SHA/version checks are
independent of the parser window. Functional pilot allocation may use conditional
profiles; `real_allocation`, complete-cost qualification and inference remain
unavailable for those profiles, and frozen real experiments remain exact.

Verification entry points are `tests/source-compatibility.test.ts`,
`tests/source-compatibility-cli.test.ts`, `tests/source-trust-report.test.ts`,
the native workflow adapter/admission tests, and `npm run check` under Node 24.

## Explicit ordinary-root Codex pilot parser reuse

The exact `codex-01620-ordinary-root-human-pilot` profile grants no permission by
itself. A task-bound local functional-pilot scope, reviewed Codex 0.162.0 or 0.162.1 receipt
instrumentation, and explicit observer authority are required. Version selection
alone remains metadata-only. The provider accepts one fresh root, no descendants;
a completed agent application also requires unchanged output proofs and a separate
working identity in its selected checkout.

This route reuses `codex-workflow-own-response-v1` under a code-owned mapping.
`source: codex_workflow` identifies the inherited parser lineage, not launch
authority or ordinary-source admission. Persist its existing tuple atomically
with the binding: `compatibility_unverified`, actual product version `0.162.0`,
parser version `0.160.0`, the own-response parser/profile revision, and
`forward-version-v1`. The 0.162.1 candidate uses the same tuple with actual product
version `0.162.1`, never an alias to 0.162.0. Pinning is required before storing observations.

The UI distinguishes root-only candidate authority from inherited-parser trust.
Shared lineage invalidation conservatively blocks both collection routes before
source access; a required parser-contract failure invalidates that tuple. Replay,
restart baselines and paused intervals retain their original provenance and
collection fences. Production admission, complete cost, native instruction-loading
qualification and inference remain closed. Synthetic checks or successful partial
observation do not qualify those separate contracts.
