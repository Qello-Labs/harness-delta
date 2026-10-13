# Version change verification

Read with the [canonical skill](../SKILL.md). Repository paths below start at the
checkout root. Evidence is route-specific; the checklist grants no source access.

## Required comparison record

Keep a sanitized table in the selected ignored work record:

| Contract | Previous reviewed release | Verified parser base | Target tag/commit | Result | Evidence | Action |
| --- | --- | --- | --- | --- | --- | --- |
| Each consumed contract below | Exact version | Exact profile/version | Exact release | unchanged / changed / unknown | Official path/URL, key names or numeric checks | reuse / variant / blocked / qualification pending |

Inspect these contracts even when a changelog mentions none of them:

- Product/version, cwd, session/root/thread/request identity and source kind.
- Native required fields/types and closed settings enums; transcript/rollout
  envelope, ordinal/checkpoint, source inode/prefix and partial-write behavior.
- Per-request versus cumulative totals; cache read/write inclusion; reasoning
  inclusion/subsets; terminal deltas, counter resets, overflow and zero/missing.
- Parent/child own requests versus inherited history, copies and cumulative
  mirrors; supported direct-parent evidence and family ceilings.
- Hook key names, trusted receipt paths, startup/child/stop order and request
  identity; actual project-local skill/hook loading when that is claimed.
- CLI flags, configuration precedence, permissions, executable replacement,
  model/effort propagation, exporter content controls/destinations and auth linkage.
- Replay/conflict, resume/restart/pause baseline, compaction/reset/rotation,
  final delivery/flush, interruption, scope revocation and owned termination.

For Codex, inspect release-tag source/schema for session metadata, turn context,
token usage, rollout ordinals/history, hooks and execution arguments. Record exact
old/target refs; compare target to the inherited parser base too. Use the
[file admission procedure](../../../../docs/runbooks/codex-version-admission.md)
for required counter/checkpoint evidence. Its runner accepts only registered
`conformanceCandidates`; never substitute a target number into a pinned recipe.

Claude's public changelog is not the CLI's implementation. Review official
[hooks](https://code.claude.com/docs/en/hooks) and
[telemetry](https://code.claude.com/docs/en/monitoring-usage) plus available pinned
schema/docs. Undocumented transcript fields remain candidate evidence unless an
explicitly reviewed decision qualifies an exact profile for a bounded evidence
scope. Claude 2.1.296 is qualified only for bounded native print-mode evidence,
not interactive qualification or production admission. Every ordinary Claude
profile, even qualified, requires `allowCandidateProfiles: true`; default provider
refusal and ordinary service admission remain closed. Current UI/observation labels
remain `native_unverified_pilot`, `legacy_unverified` and `candidate_pilot`. Compare
actual old/target binaries against an isolated localhost synthetic API when
authorized, recording only allowlisted key names, numeric usage, fixed statuses
and ordering. Keep missing source material explicitly `unknown`.
The existing
[parent-workflow evidence](../../../../docs/validation/claude-workflow-02196-source-readiness.md)
is a comparison recipe, not evidence for another version.

## Actual target-binary verification

Before a native/backend call, finish the source review and synthetic regressions.
Present exact binary/version/SHA, affected route, selected registered project,
active task, explicit session/run linkage, disposable workspace, observation
inputs, runtime choice and bounded stopping/termination plan. Obtain the specific
execution and instrumentation authorization. A version-update request, previous
trial or fabricated consent file is not approval for this run.

No unrelated session discovery or contents are permitted. Native transcripts stay
in the product's own source; measurement fixtures, diagnostics and evidence must
not retain prompts, responses, source-code content, secrets or copied real logs.
Public upstream implementation can be inspected, but retain its references and
derived contract findings rather than copying it into measurement data.

Choose a supported existing lane for the exact requested topology:

| Route | Existing entry points/evidence to inspect first |
| --- | --- |
| Codex sequential file | `scripts/conformance/candidate.ts`, `npm run conformance`, `npm run profile:admit`; [procedure](../../../../docs/runbooks/codex-version-admission.md) |
| Codex own-response/root or direct-child workflow | `tests/codex-workflow-admission.test.ts`, `tests/codex-workflow-child-admission.test.ts`; [root](../../../../docs/validation/codex-workflow-01600-source-readiness.md) and [child](../../../../docs/validation/codex-workflow-01600-direct-child-source-readiness.md) evidence |
| Codex ordinary root | [human pilot](../../../../docs/runbooks/harness-connect.md#codex-01620-ordinary-root-local-pilot); one fresh root, separate observer authority |
| Codex ordinary family qualification | [isolated qualification](../../../../docs/validation/codex-ordinary-binding-qualification.md); its exact pinned version, native intent and own limits apply |
| Claude parent workflow | `tests/claude-workflow-admission.test.ts`, `tests/claude-workflow-adapter.test.ts`; [parent](../../../../docs/validation/claude-workflow-02196-source-readiness.md) and [child](../../../../docs/validation/claude-workflow-02196-direct-child-source-readiness.md) evidence |
| Claude ordinary family | [human pilot](../../../../docs/runbooks/harness-connect.md#claude-human-operated-ui-pilot); exact listed profile under explicit pilot authority, one fresh root and two flattened members; 2.1.296 qualified only for bounded native print-mode evidence, other listed versions candidate |
| Claude internal probe | [probe preparation](../../../../docs/validation/claude-native-probe-preparation.md); this is an exact historical lane, not a generic latest-version launcher |

Read and qualify a lane before using it with a new target. Preparation alone
does not launch or admit a source. If the current runner is pinned to another
version, propose a separate exact-target candidate/instrumentation change and
review it first; do not change a hash/version or bypass the pin to execute.

Subscribe to the exact event/state before an asynchronous action and use a bounded
timeout, not sleeps or polling luck. Record normal exit and interruption outcomes,
usage/identity agreement and terminal observation separately. A process exiting
zero is not proof of a complete request universe. Keep partial usage partial and
unsupported scenarios explicit. Stop on drift, uncertainty or failed contract;
do not automatically retry model requests or broaden permissions.

For a gate-triggering target, require independent review of the source comparison,
actual-binary observations and exact proposed support change before enabling it.
When observations fail or are unavailable, finish offline work and report the
unsupported or qualification-pending route. A window expansion needs a separately
confirmed contract decision, new source-specific evidence and boundary regressions;
it does not confer exact verified admission.

## Regression and publication boundaries

Cover the actual target's permitted routes, newest boundary and adjacent rejected
versions; prereleases/malformed identities; exact precedence; blocked cohorts;
scope-before-read and executable drift; baseline/replay/conflict; counter/subset
changes; partial/unverified reporting; no frozen-pin or historical trust promotion.
Use existing test locations and independent synthetic fixtures. Add named variants
only where the target semantics changed.

Keep exact registries and historical evidence unchanged unless promotion or
retirement is explicitly requested and freshly qualified. Cross-version reports
must retain actual version/parser/rule provenance, durable invalidation and
separate verified/unverified aggregates. No backfill, source-content retention,
silent repricing, task reassignment or experiment pooling is permitted.

Update EN/KO executable examples and limits together. Check links/anchors and
inspect installed or built skill copies if packaging changed. Report local checks
separately from native trials and remote CI. No publication or default/pin change
is part of a maintenance skill invocation without its own request.
