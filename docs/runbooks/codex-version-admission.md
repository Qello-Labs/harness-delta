# Codex version admission and partial measurement

Developer admission procedure for the legacy file adapter. It is not the first
installation path; use [the task procedure](workflow-quickstart.md).

This workflow supports exact, source-reviewed Codex rollout versions. It does not
establish complete task tokens, child aggregation, interactive linkage or an A/B
adoption decision. Read [ADR 007](../decisions/007-adapter-version-profiles.md).

[ADR 013](../decisions/013-forward-version-compatibility.md) changes the operating
policy to conditional forward-version parser reuse with compatibility-unverified
estimates. Conditional runtime reuse is implemented; the commands below still require
exact source-reviewed entries in `conformanceCandidates`. This admission procedure remains the path to verified
support, rather than a prerequisite for every future in-window reference estimate.

## Current support

This section is the exact file-adapter registry only: Codex 0.156.1 and Codex 0.158.0.
The commands below do not register ordinary-session or workflow versions. Those routes
are [Harness Connect](harness-connect.md#current-implementation) and the
[file and workflow windows](local-measurement.md#versions-conformance-and-update-controls).

Codex 0.156.1 remains registered with its original behavior. The Codex 0.158.0 checkpoint
variant is implemented and uses M2: `multi_agent_version` values `disabled`, `v1`
and `v2` describe available tools, not observed children. `collaboration_mode.mode`
accepts `default` and `plan`. Actual child activity, inherited roots, forks,
compaction, model changes and ambiguous settings block the affected snapshot.
Already stored usage stays partial. Command diagnostics are excluded for this variant.

Codex 0.158.0 was admitted on 2026-09-29 after a freshly confirmed exec/resume run
passed every required check under M2 (observed capability `v2`). Its entry in
`src/codex-admissions.json` binds that evidence to the implementation and policy.
Production linking and collection accept this historical exact entry. The current
integrated tree has a different implementation digest and the archived report
fails its fresh admission gate; see the [offline readiness assessment](../validation/codex-01580-offline-readiness.md). Never manually
add an entry to bypass failed or stale evidence.

Live evidence covers the shared parser and exec/resume agreement. The normal
project/task/session → collector → report path passed synthetic integration tests
using the actual registered entry. At admission time, a live product collector window was not run. A later separately
authorized smoke observed one fresh resumed partial event with baseline exclusion;
see the [evidence scopes](../validation/codex-01580-offline-readiness.md#evidence-identity-and-scope).
Conformance is a separate investigation and its earlier usage is never backfilled.

## Verify and register a candidate

Use Node 24, run `npm ci`, then run these commands from this repository's root:

```sh
npm run conformance -- --candidate 0.158.0 --out "$PWD/.harness-delta/work/codex-version-fast-track/live"
```

The runner prints its exact execution plan and waits for the human to type
`confirm` in an interactive terminal. No noninteractive approval switch exists.
This requests one short `exec` turn and one exact-session `exec resume`, with no
retries and a 180-second cap per generation (then bounded termination). Version
probes run before and after. The model is the existing product default; reasoning
is low. The native rollout (which contains content) stays in Codex's native
storage. Temporary hook/linkage files are removed. Existing trusted user hooks may
run. No global config or trust setting is changed. Two requested turns are **not**
a token, money or backend-call cap: internal requests can add usage. Review these
conditions before typing confirmation; prior consent is never reused.

Review the sanitized report, then evaluate it without writing registration data:

```sh
npm run profile:admit -- --candidate 0.158.0 --report "$PWD/.harness-delta/work/codex-version-fast-track/live/conformance-live-report.json"
```

The gate names every failed/missing required check and the remaining optional
limitations. Initial/resume counter agreement, sequential turn IDs, topology,
closed setting enums and a same-thread resume checkpoint are required. Nonzero
reasoning, cache-write examples, warmup accounting and interactive linkage are
not completeness gates for this partial scope. Contradictory observations still
fail. An old report cannot pass after a relevant implementation or policy change.
Only the application implementation is fingerprinted; native session content,
configuration, prompts and responses are never hashed.

After reviewing passing evidence, explicitly register and rebuild:

```sh
npm run profile:admit -- --candidate 0.158.0 --report "$PWD/.harness-delta/work/codex-version-fast-track/live/conformance-live-report.json" --register
npm run check
```

This writes an exact-version entry in reviewed application source
`src/codex-admissions.json`. It is not user configuration and never enables a
version range. Review that diff with the synthetic tests and public capability
notes. Installation, tests, hooks and CI never run product conformance.

## Collect and report with an admitted Codex 0.158.0

Build first (`npm run build`). Use an explicitly known session ID and exact native
rollout path from an authorized **CLI exec** session. Do not discover sessions by
reading unrelated files. The registered project root must match the session cwd,
and the task model must match the model actually recorded. These are placeholders:

```sh
node dist/cli.js --db .harness-delta/measurement.sqlite project add project1 --root /absolute/project
node dist/cli.js --db .harness-delta/measurement.sqlite task register task1 --project project1 --type feature --size small --assignee user1 --product codex --model MODEL_ID --criteria criterion1
node dist/cli.js --db .harness-delta/measurement.sqlite task start task1
node dist/cli.js --db .harness-delta/measurement.sqlite session link SESSION_ID --task task1 --source /absolute/exact-rollout.jsonl --product codex --version 0.158.0
node dist/cli.js --db .harness-delta/measurement.sqlite collect --task task1
```

Leave collection running, then resume that same CLI session in another terminal
and perform new work. The first collector poll establishes the current tail;
earlier turns and in-flight turns are excluded. `collect --once` establishes only
a baseline: it cannot recover historical tokens. Stop with Ctrl-C after observing
the new turn. A new collector process or pause/resume establishes a new baseline.

```sh
node dist/cli.js --db .harness-delta/measurement.sqlite report task task1 --cutoff 2026-09-30T00:00:00Z --format json
node dist/cli.js --db .harness-delta/measurement.sqlite task first-complete task1
node dist/cli.js --db .harness-delta/measurement.sqlite task assess-first task1 --result success
node dist/cli.js --db .harness-delta/measurement.sqlite task finalize task1 --outcome success --met criterion1
```

Choose the actual cutoff and assess success yourself; usage does not prove quality.
Report `usage.status`, `partial_tokens`, per-metric readings and `reasons` together.
No observations means `missing`, never zero. `complete_tokens` remains null.
`child_activity`, `settings_conflict`, `settings_unsupported` and
`turn_topology_or_model` identify unsupported boundaries; other fail-closed paths
retain `unsupported` or the existing source-error categories. Do not remove a
blocking history row to salvage usage or backfill excluded intervals.

## Version drift and update controls

For a frozen experiment, verify process-only update controls against the pinned
binary before execution. Check product version and executable provenance before
and after the run. On drift, stop measurement and follow the frozen deviation
policy; do not relink, backfill or rerandomize. Conditional parser reuse does not
waive R09 exact-version controls or R10 analysis validation.

## Next exact version

1. Review the version-pinned source/schema against the current candidate's
   counters, turn/checkpoint/topology leaves and native hook/exec contract.
2. Add one exact entry to `conformanceCandidates` in
   `scripts/conformance/candidate.ts`, naming its previous registered version and
   pinned source ref. With unchanged semantics, reuse the existing candidate data
   and checkpoint variant. Add independent synthetic fixtures; do not clone native
   logs. A changed semantic rule needs a named variant and focused tests.
3. Run the same commands with the new exact version. Unknown candidates are
   rejected before product spawning. Reports bind candidate version, previous
   profile, source ref, policy revision and application implementation digest.
4. Review required versus optional outcomes, explicitly register, run focused
   tests and `npm run check`, and obtain independent review. Update public evidence.
   No automatic promotion or old-interval reprocessing follows.

Compare only partial observations with the same product, exact version, model,
usage source and supported sequential scope. Unobserved internal requests and
features can produce unequal missingness. Before a real A/B experiment, complete
R09's frozen user-specified protocol, verified version controls, allocation and
quality measurement, and R10's analysis validation. This workflow does not supply
those experimental decisions.
