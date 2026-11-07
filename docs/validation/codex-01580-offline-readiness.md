# Codex CLI 0.158.0 offline readiness

Status: offline integration of the historical partial adapter; current live
qualification and complete measurement remain unavailable. Requirements:
[R01–R05, R07 and R11](../requirements.md). This does not enable an R09 experiment
or an R10 adoption decision.

## Evidence identity and scope

The exact-version entry and checkpoint parser were integrated from application
commit `88d59831b8567cd7a3a6adb41b42e0c4d8ec582e`. The previously approved M2
exec/resume admission on 2026-09-29 used policy `codex-rollout-m2-v1`, source ref
`rust-v0.158.0`, previous profile `0.156.1`, and implementation digest
`a53c612f08e045b3ee3e1b73669bec1b7f12b4acb3ff19c27a54f2cd9bb9ba90`.
The original source digest was recomputed from committed application files and
its archived sanitized report passed the pure admission gate offline.

At integration commit `2a12046502dd8f908c396255fe91d47b3a9b715e`, the implementation had digest
`3fb4968e892787a013192ed875ef8c03019592d4273c1319220c8d22af915e73`.
Only `src/core/lifecycle.ts` differs within the digest closure: main's configuration
confirmation and comparison lifecycle controls are preserved. Assessing the
same historical report against this identity returns `eligible: false` with
`stale_implementationDigest`. Its digest was not rewritten, and no new live
report or registration was manufactured. A separately authorized current live
qualification is needed before claiming fresh conformance for this tree.

The historical source entry remains the exact runtime allowlist; lookup checks
its policy revision, not a runtime source hash. Retaining that entry and passing
synthetic parser/collector tests establish offline integration, not current live
qualification. No production coverage profile, evidence producer, schema or
complete-total switch is added. Codex 0.156.1 and Claude Code 2.1.283 keep their
existing variants. Unknown versions remain unsupported.

Historical evidence has three distinct scopes:

- [ADR 001's rollout check](../decisions/001-adapter-capabilities.md#codex-01580-rollout-check)
  observed inclusive cumulative input/output and exec agreement in one initial
  turn and resume. The separate M2 admission verified paired/root turns, accepted
  setting enums and a fresh resume checkpoint with capability `v2`; no child
  activity was observed. Neither demonstrates exhaustive request accounting.
- The later bounded collector smoke observed one fresh resumed usage event and
  a partial report, stable replay and human outcome recording. Its startup
  baseline excluded earlier usage. This historical window therefore violates
  whole-task first-request/continuity coverage; it is not silently backfilled.
- This offline integration reads only committed application files and sanitized
  saved evidence, and runs synthetic tests. It opens no native session, invokes
  no product or model and executes no live conformance runner. No new product
  behavior or whole-task certificate was observed.

## Input/output eleven-fact matrix

The following states concern a **new real task on the integrated tree**. No task
was measured and no validated producer supplies its facts. Thus each per-task
state is `unknown`, even where a synthetic mechanism or historical observation
exists. These states are a documentation inventory, not emitted coverage data.
All facts must be independently verified for each metric under
[ADR 004](../decisions/004-complete-measurement-readiness.md).

| Fact | Input total | Output total | Available bounded evidence and remaining requirement |
| --- | --- | --- | --- |
| `scopeBeforeAccess` | unknown | unknown | Synthetic registry/task/link guards pass before reads. A new task's exact source and active authorization must still be established. |
| `freshSession` | unknown | unknown | Historical same-session resume is partial. A baseline excludes old work and cannot establish a fresh whole-task session. |
| `readyBeforeFirstRequest` | unknown | unknown | No first-request observer barrier. Historical collector smoke excluded its initial turn; its whole-task fact is violated. |
| `continuousObservation` | unknown | unknown | Synthetic pause/restart exclusions and no backfill pass. Historical baseline exclusion is a known gap; no complete new interval was observed. |
| `fixedModel` | unknown | unknown | Synthetic model/checkpoint conflicts block. Turn context and package version alone do not certify effective configuration throughout a new task. |
| `boundedTopology` | unknown | unknown | M2's historical sequential roots/enums and no observed child activity are bounded observations. Synthetic actual children, inherited roots and compaction block; auxiliary accounting is unverified. |
| `requestUniverse` | unknown | unknown | ADR 001 observed a zero-output completion with nonzero input absent from rollout and exec totals. That historical scope is violated for both request-universe facts, as retained in ADR 006; retries and failed attempts remain unverified. It cannot be treated as a harmless zero. |
| `terminalAccounting` | unknown | unknown | Historical exit and counter agreement are not a terminal watermark. No validated production closure barrier exists. |
| `immutableIdentity` | unknown | unknown | Synthetic cumulative replay/conflict controls pass. New-task identity, all eligible requests and conflicting producer evidence are not certified. |
| `durableFlush` | unknown | unknown | Synthetic transactions, rollback and deletion controls pass. Exhaustive product delivery and final durable evidence are not established. |
| `counterSemantics` | unknown | unknown | Historical input/output counter equalities and subsets passed in the bounded run. Nonzero cache-write/reasoning and auxiliary inclusion remain unverified; input evidence cannot certify output. |

A known violation in an observed interval must remain `violated`; the absence of
a new task does not erase historical gaps. Completed interval merging remains
`violated > unknown > verified`. Later clean work cannot repair the excluded
initial turn, a pause, or an unaccounted request. See
[ADR 006's source mapping](../decisions/006-otel-usage-source.md#evidence-mapping-follow-up-5)
for the historical source-level gaps, rather than substituting this new-task
inventory for that mapping.

Both new-task metrics are ineligible for complete measurement. Observed zero,
missing and unavailable readings stay distinct. The internal
`synthetic-coverage-v1` evaluator can accept a supplied synthetic vector only;
passing it does not promote a real profile. `completeTotals` remains false and
`complete_tokens` remains null, including finalized successful tasks.

## Reproduce offline checks

Use Node 24 and `npm ci`, then:

```sh
npm test -- tests/sources/codex-production.test.ts tests/codex-topology.test.ts tests/sources/codex-readiness.test.ts tests/adapter-profiles.test.ts tests/sources/adapter-profile-isolation.test.ts tests/conformance-admission.test.ts tests/conformance-registration.test.ts tests/core/coverage.test.ts
npm run check
```

`tests/sources/codex-readiness.test.ts` exercises actual admitted linking, collector and
report behavior with synthetic files: observed zero versus missing, exact replay,
metric-specific supplied policy evidence, no complete promotion after success,
and pause exclusion that clean resumed usage cannot backfill or repair.
Existing admission tests reject stale identity and missing required checks.
Normal checks never execute product conformance. A contributor without archived
private evidence can reproduce these synthetic checks; they do not need a real
session or personal plugin.

## Bounded model-support diagnosis

A separately authorized diagnostic on 2026-10-02 requested `gpt-6.1-sol` with
reasoning effort `high` on installed Codex CLI 0.158.0, using the existing ChatGPT
authentication. One synthetic initial exec and one resume of that exact session
were attempted, with the same `ready`/`again` prompts and read-only sandbox as the
earlier bounded execution. Both exited nonzero before a completed turn. The linked
native error records contained an HTTP 400 JSON wrapper whose message rejected
the model for Codex with a ChatGPT account. Settings and session linkage were
checked against native metadata; backend model identity was not attested.

The stream reducer now retains only fixed `failureReasons` enums from error and
failed-turn events. It recognizes a single JSON message wrapper and the complete
account-rejection template, without retaining arbitrary provider codes, model
names, messages or HTTP bodies. Synthetic tests cover that wrapper, unknown
errors, unrelated item events, report privacy and stopping before source lookup
or automatic resume. The default runner still stops on a nonzero product exit. The one
diagnostic continuation after the failed initial was a separately approved local
adapter; it does not qualify the default runner.

The model cache listed the requested model and effort, but a catalog is not an
entitlement check, as explained in the [official OpenAI documentation](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server).
The observed rejection establishes the current authentication path's failure;
the precise backend policy and availability through other paths remain unverified.
The [official model guide](https://learn.chatgpt.com/docs/models) documents the
same `codex exec -m gpt-6.1-sol` selection and states that availability depends on
rollout, sign-in method and client. This diagnosis does not establish a universal
CLI or ChatGPT-account limitation, nor an invalid model name or reasoning effort.
No model substitution, new authentication, provider rerouting or client-identity
override was performed. These failed calls produced no usable usage
measurement; unavailable usage is not observed zero.

After explicit approval for an additional pair, the already-installed desktop
CLI `0.159.0-alpha.12.1` completed one synthetic exec and one resume of its exact
session with the same model, effort, existing authentication and read-only
sandbox. Both exited zero with one completed turn and observed usage. Native
metadata confirmed the exact session, model, effort and client version;
configuration metadata and executable version remained unchanged. No native
session content was read for this newer-client diagnostic. The existing
environment filtering was preserved, with no client-identity override.

Using the newer installed executable resolves this bounded model-support
execution failure. This does not isolate the backend policy responsible for the
older client's rejection or prove compatibility of arbitrary client versions.
The newer version has no admitted adapter here: its successful model calls do
not qualify the exact 0.158.0 adapter, register 0.159.0, or enable collection or
complete measurement for it. Backend model identity remains unattested.

This diagnostic change also changes the implementation digest closure. Historical
admission evidence is not rebound to the new code, and no fresh admission is
claimed. `completeTotals` remains false and `complete_tokens` remains null.

Further work requires a separately approved live qualification scope and, for
complete measurement, a validated producer contract satisfying all eleven facts.
No complete measurement, live experiment or inferential adoption is enabled by
this offline readiness result.
