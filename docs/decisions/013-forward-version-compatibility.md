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

Two ordinary root-reference policies select observation only. They aren't exact
admission or launch authority, and the launch identity rule above is unchanged.
`codex-binding-root-window-v1` covers stable Codex `>0.163.0` and `<0.170.0`
with source-only evidence: the task declaration must equal the root creation
header, but that header doesn't prove the writer version, and no native asset is
a prerequisite. Optional Codex file assurance isn't implemented, isn't a Claude
dependency and isn't a hidden activation gate. `claude-binding-root-window-v1`
covers stable Claude Code `>2.1.306` and `<2.2.0` and requires receipt PID/start,
publisher and local disk pins; those pins don't prove the mapped process image.
Each evidence mode needs its own risk acceptance. Both policies are implemented
for offline acceptance, ordinary-window collection disabled pending separate
product activation and native acceptance.

### Codex root-reference exception

The separate Codex window bundle, explicit owned-copy installer and closed setup
are implemented for offline acceptance, ordinary-window collection disabled pending
separate product activation and native acceptance. An activated
`codex-binding-root-window-v1` may collect only descriptive `source_only` root
references for stable `0.163.0 < v < 0.170.0` before per-target deeper conformance.
A window-only release needs no exact admission row. Equality at either bound,
prereleases, build suffixes, blocked versions and failed required contracts remain
refused; changing the upper bound needs a separate renewal decision. This exception
does not cover children, launch/resume, verified exact support or promotion, which
retain pinned upstream comparison and actual target-binary verification.

A separately activated, explicitly active unassigned task freezes its declaration,
policy, roots and price table. Connection needs a fresh eligible startup root and
live scope checks before source access and after awaits. The creation header must
match the declaration but cannot prove a newer writer after a missed resume or
hook. Native asset proof is not required by `source_only`; accepting that identity
and ownership uncertainty is a separate Codex activation decision, not support.
A lifecycle fence, version/source contradiction, revoked scope or incompatibility
block stops the affected reference; the helper never falls back to an exact path.

Install the generic window bundle only through explicit preview/apply, retaining
the historical exact helpers and commands. An in-window N -> N+1 upgrade needs a
new declared-version task and fresh root/baseline, not a per-patch helper rewrite.
Old tasks, price pins and observations are unchanged, and no interval is backfilled.
See the [closed setup procedure](../runbooks/harness-connect.md#codex-ordinary-window-setup-collection-disabled)
and [descriptive-mode addendum](016-ordinary-observation.md#codex-ordinary-window-addendum-collection-disabled).

The historical PR #70 exception that introduced the unqualified exact Codex
0.166.0 candidate is retained, not generalized. It is neither a precedent to add
future window-only exact rows nor evidence of qualification, a new default or
activation. Its [dated candidate record](../validation/codex-ordinary-binding-qualification.md#01660-unqualified-ordinary-candidate)
is unchanged; this decision authorizes no historical revert or evidence rewrite.

### Claude root-reference exception

The independent Claude window bundle, explicit owned-copy installer and closed
setup are implemented for offline acceptance, ordinary-window collection disabled
pending separate product activation and native acceptance. The finite policy
`claude-binding-root-window-v1` selects stable `2.1.306 < v < 2.2.0`, not another
exact admission. Equality at either bound, prereleases and build suffixes are
refused. It uses `claude_terminal_message_v1` with
`claude_terminal_message_window_v1` strict terminal finality; an unseen patch
never falls back to historical quiescence or treats silence as completion.
Required-contract failures commit neither usage nor cursor advancement; later
incompatibility invalidates the affected observations.

Only a live-authorized provider checks the fresh receipt's same-user PID/start,
canonical executable path from that process, approved publisher signature and local disk pins. The
initial native adapter is limited to the standalone macOS arm64 CLI layout and
fails closed on unknown hosts/layouts. Pins bind the opened disk bytes and are
revalidated; a signature proves neither the declared version nor the mapped
running image. Scoped source version must independently match the frozen task.
`publisher_verified_local_pin` retains mapped-image uncertainty, unverified root
ownership and unknown possible child contribution. Claude activation therefore
needs its own identity/ownership risk acceptance, separately from Codex.

Project selection and installation create no collection authority. Explicit
preview/apply retains owned exact helper/recorder files and records the window
mode/revision. N -> N+1 needs a new declared-version task and fresh root/PID/path
and local pins, not a per-patch helper rewrite or task/price migration. No missed
interval is backfilled. See the [closed Claude procedure](../runbooks/harness-connect.md#claude-ordinary-window-setup-collection-disabled)
and [descriptive-mode addendum](016-ordinary-observation.md#claude-ordinary-window-addendum-collection-disabled).

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

Ordinary-window reports use a separate versioned projection,
`ordinary-window-task-v1`, and leave legacy report shapes unchanged. Root-source
references stay `compatibility_unverified`. Coverage is `root_only` with
`rootOwnership:unverified`, `possibleChildContribution:unknown` and children
`unobserved`; detected children carry null usage and cost, and detection
completeness stays unknown. Coverage is recorded for eventless roots. Tokens and
costs are split into verified, compatibility-unverified, legacy-unverified and
invalidated partitions with null complete totals. A required-contract failure
commits no usage or cursor advance, and a later incompatibility invalidates the
affected cohort. An observed ownership contradiction stops collection.

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

Subsequent Claude 2.1.301 actual-binary localhost normal/SIGINT print-mode
conformance establishes its separate transcript profile and a separately configured
ordinary binding record, `claude-binding-2-1-301-family-v1`, with one root and two
flattened members. A real-service localhost rehearsal also passed; ordinary
qualification remains false pending separate authenticated acceptance.
The 2.1.296 default, old pins, file/workflow windows and historical trust remain
unchanged. See the [bounded evidence](../validation/claude-ordinary-binding-02196-qualification.md#2026-10-16-exact-21301-transcript-qualification).

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
`tests/cli/source-compatibility-cli.test.ts`, `tests/pricing/source-trust-report.test.ts`,
the native workflow adapter/admission tests, and `npm run check` under Node 24.

The ordinary root-reference policies above are not rows in this table. Static
assessment reports them as separate finite policy lanes, distinct from exact
admission lanes; a policy lane doesn't read activation state, doesn't clear
`exact_only` on legacy lanes and doesn't make a release usable. The approved
order is: registry, closed windows, difference judgment, then selective
promotion. Native acceptance, promotion and publication gates stay in force.

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
