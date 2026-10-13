# Measure one assigned development task

[한국어](workflow-quickstart.ko.md) · [Documentation map](../../README.md#documentation)

Use this procedure for a small **functional pilot** with descriptive partial costs.
It covers Codex 0.160.0 (`codex-workflow-own-response-v1`) and
Claude Code 2.1.296 (`claude-workflow-own-trace-v1`, parent-only; `claude-workflow-direct-child-v1`), plus
the conditional forward versions described below.
Use one persistent A/B assignment for each logical task.
Choose model and effort per invocation; a new session does not change the assignment.

## Support and costs before you start

| Path | Supported boundary |
| --- | --- |
| Codex 0.160.0 root workflow | Launch, same-session resume, explicit independent-root link, foreground collect, stop and recover; partial usage |
| Codex 0.160.0 direct-child workflow | Separate profile: fresh root and one fresh child, pinned macOS arm64/Node24, read-only; no family resume or external child link |
| Legacy file collector | Exact profiles: Codex 0.156.1/0.158.0 and Claude Code 2.1.283; conditional file versions also available; use [local measurement](local-measurement.md) |
| Claude Code 2.1.296 parent-only workflow | Fresh launch per run (read-only or `workspace-edit`), another launch on the same task, resume of a session kept with `resumable`, stop and recover; partial usage. 2.1.288 and 2.1.291 are retired |
| Claude Code 2.1.296 direct-child workflow | Separate profile: fresh read-only root and at most one read-only `workflow-child`; exact version only; no resume, no deeper or additional children |
| App/IDE/MCP, forks, compaction, deeper descendants | Unsupported for this procedure |
| Complete task cost, actual billing, savings or adoption inference | Unavailable |
| Team file exchange | Synthetic validation only; functional-pilot results cannot use that exchange |

Stable Codex versions `>0.160.0` and `<0.164.0` (including 0.162.1), and Claude Code versions
`>2.1.296` and `<2.2.0`, may reuse their workflow
profiles in a `functional_pilot`. They remain `compatibility_unverified`, with
separate reference estimates. The Claude window covers a fresh parent-only launch only: no child and no resume. These windows do not qualify ticket connections or
ordinary session families. See [version configuration and checks](task-native-workflow.md#conditional-forward-versions).

**Execution notice:** Native launch/resume uses your existing authenticated product and can consume paid or subscription usage.
Approve each actual run before execution. Timeout and stop are not provider spending caps.
Preparing inputs, registering them and reading status do not launch a product.

For Codex fresh-root launch, `project_trust: "untrusted"` disables project-local
configuration, hooks and rules for that invocation. Use it only when intended;
it does not apply to resume/link/collect or child launch. See
[execution details and configuration-scope evidence](task-native-workflow.md#codex-launch-resume-link-and-collection).

## 1. Install from the checkout

Prerequisites: Node.js 24, npm and an existing pinned binary eligible for the selected workflow version.
Local validation covers macOS arm64. Other platforms remain unverified.
The package is private; there is no published-package installation procedure.

1. Select Node 24 with your version manager.
2. From the repository root, install the locked dependencies.

   ```sh
   npm ci
   ```

3. Build the CLI.

   ```sh
   npm run build
   ```

4. Read the workflow help.

   ```sh
   npm start -- --db .harness-delta/pilot/local.sqlite workflow --help
   ```

Expected: the help lists `external`, `codex`, `claude`, `status`, `task`, `begin`, `finish` and `report`.
`external` is a separate [user-opened session procedure](external-session-workflow.md),
not the tool-owned launch path below.
Use `workflow status` in step 4 to check the selected v2 native gate.
The guarded `npm start -- <arguments>` entry checks Node 24, the build and installed
dependencies before loading SQLite. `unsupported_node` (exit 2), `build_required`
(exit 3) and `dependencies_required` (exit 4) give distinct first-run results.
Select Node 24 before `npm ci`; `npm exec node@24` is not proof that your shell
or npm scripts use Node 24. Verify `node --version` in the same terminal.
If installation fails, check Node 24 and the SQLite native-build prerequisites in [CONTRIBUTING](../../CONTRIBUTING.md#development-environment).
Installation also installs local Git hooks. It does not start collection or change product authentication.
Every command below runs from the repository root and includes the database explicitly.
An installed local package can expose `hm`; `npm ci` alone does not put it on your shell PATH.

## 2. Agree on the pilot inputs

Before registration, have the team owner select the following inputs.
The product supplies a reference price catalog; durations, sample size and missingness limits remain explicit choices.

| Decision | Where to record it |
| --- | --- |
| Shared project requirements and the small A/B instruction difference | `variant-a.md`, `variant-b.md`; preserve the shared instructions in both |
| Task output, permitted edits and human acceptance criteria | Private prompt file; criterion IDs in `workflow.json` |
| Participants, environments, assignee strata and allocator ownership | `protocol.json`; each stratum has one assignee |
| Recruitment dates, follow-up duration, sample budget and stopping/deviation rules | `protocol.json`; freeze before recruitment starts |
| Reference catalog or explicit rates, and legacy input basis | [Catalog](reference-price-catalog.md), or `prices.json` and the [cost guide](observed-cost.md) |
| Runtime model/effort, sandbox, timeout, run count and teardown | `runtime.json`, execution files and the actual-run approval |

Choose follow-up long enough for work **and human review**.
Assignment fixes `followup_ends_at`; pause, resume and rework never move it.
Finish must occur before that deadline. A later outcome is stored separately but does not repair deadline status.
A final report needs a cutoff at/after the deadline and after the outcome timestamp.
A cutoff cannot be in the future.

Use `purpose: functional_pilot` for this functionality check.
Omit `minimum_effect`, `quality_margin` and `confidence_level`; the schema rejects them for this purpose.
The report remains `functional_only`, with adoption `not_applicable`.
Do not run the same logical task once under each arm. A new requirement needs a new task.
For a later batch, four distinct tasks, one assignee and two balanced blocks can bound preparation.
Those values require the owner's choice; they do not establish statistical power.

## 3. Prepare the complete input set

1. Create an ignored pilot directory.

   ```sh
   mkdir -p .harness-delta/pilot
   ```

2. Copy the [synthetic example set](../../examples/workflow/).

   ```sh
   cp -R examples/workflow/. .harness-delta/pilot/
   ```

3. Replace the example choices before registering anything.

| Files | Required replacements |
| --- | --- |
| `prices.json` (explicit-table path) | Replace synthetic rates/model/source/date; omit this file and protocol `price_table_id` to pin the catalog at registration |
| `variant-a.md`, `variant-b.md` | Reviewed A/B instructions; no personal source material in public fixtures |
| `protocol.json` | Dates in 2099, example IDs, participants/environments/strata, follow-up/sample/missingness/stopping policies |
| `workflow.json` | Matching IDs, logical task, criteria, environment, actual code-base commit and artifact paths |
| `runtime.json` | User-selected model and effort, or `null` for unspecified; no diagnostic model is required |
| `launch.json`, `resume.json` | Canonical absolute binary/home/recorder/prompt paths, approved sandbox and timeout |
| `link.json`, `collect.json` | The same canonical setup; exact linked session UUID and source path where required |
| `claude-launch.json` (Claude only) | Selected binary path/version/SHA, private mode-0700 workspace, built mediator, prompt, `permissions`, limits |
| `claude-resume.json` (Claude only) | The same setup, a fresh `run_id`, `resume_run_id` of an earlier resumable run of the task, and that run's `workspace` |

Keep the workflow configuration, protocol source profile and executable version
identical. The checked-in Codex examples use 0.160.0; for a conditional version,
set execution `product_version` and its actual `binary.sha256` too.
For Claude, use `product: "claude_code"`, profile `claude-workflow-own-trace-v1`,
and the selected version in `workflow.json`, `protocol.json` and `binary.version`.
A protocol holds one profile per product/version and at most one entry per Claude
workflow profile; use a separate protocol with `claude-workflow-direct-child-v1` for child runs.
A functional protocol permits each Claude workflow profile at 2.1.296, or the own-trace profile at a version
inside its conditional window. Other non-synthetic protocols require the newest
exact admission; see [registration rules](task-native-workflow.md#claude-parent-only-workflow).
Point `binary.path` at the exact versioned file, not the `claude` launcher.
If that file is missing or changed, preflight fails with `claude_probe_executable_mismatch`
before assignment.
With `permissions: "workspace-edit"`, keep the workspace, harness-delta build (mediator), prompt, binary and
database outside the measured project root; otherwise preflight fails with `claude_workflow_harness_inside_project`.
A `workspace` can be reused across launches; each run uses its own subdirectory.

All JSON examples are complete schema inputs, but their choices are synthetic.
Keep prompts, approved execution requests and databases under ignored local storage.
Keep ordinary work products separate from measurement data.
Codex 0.160.0 must match its code-owned binary pin; conditional versions use the reviewed actual hash.
Do not install, log in or update a product to make an example work without a separate decision.

**Output notice:** The measurement CLI discards ordinary native stdout.
For a file-producing task, specify the output destination and permitted edits in the private prompt.
Approve root `workspace-write` when writing that output is required.
A read-only analysis answer will not appear through this CLI.

4. After editing both instruction files, update their manifests before registration.

   ```sh
   node --input-type=module <<'JS'
   import { readFileSync, writeFileSync } from 'node:fs';
   import { createHash } from 'node:crypto';
   const sha = value => createHash('sha256').update(value).digest('hex');
   for (const arm of ['a', 'b']) {
     const path = `.harness-delta/pilot/variant-${arm}`;
     const config = JSON.parse(readFileSync(`${path}.json`, 'utf8'));
     config.instruction_manifest_hash = sha(JSON.stringify([
       { artifact_id: 'instructions', sha256: sha(readFileSync(`${path}.md`)) }
     ]));
     writeFileSync(`${path}.json`, `${JSON.stringify(config, null, 2)}\n`);
   }
   JS
   ```

Expected: each variant JSON contains the manifest hash of its reviewed instruction file.
This example uses one artifact per arm. Multiple artifacts require sorted artifact IDs and the same `{artifact_id, sha256}` formula.
Artifact paths resolve from the command's working directory, not the config file's directory.
Registration is immutable. Keep incomplete drafts in a separate temporary store.
If registered inputs must change, use new IDs and an accepted prospective protocol.

## 4. Register and freeze once

Use a new dedicated database for this pilot. Keep synthetic trials in a different database.
The commands below use an explicit `prices-1` table. For the catalog path, omit
`price_table_id` from `protocol.json` and skip `price-table register`; registration
pins the current catalog once. Run the remaining commands in order.
Replace the project root with its canonical absolute path.

```sh
node dist/cli.js --db .harness-delta/pilot/local.sqlite project add project-1 --root /absolute/path/to/project
node dist/cli.js --db .harness-delta/pilot/local.sqlite price-table register --config .harness-delta/pilot/prices.json
node dist/cli.js --db .harness-delta/pilot/local.sqlite variant register --config .harness-delta/pilot/variant-a.json
node dist/cli.js --db .harness-delta/pilot/local.sqlite variant register --config .harness-delta/pilot/variant-b.json
node dist/cli.js --db .harness-delta/pilot/local.sqlite comparison register --config .harness-delta/pilot/protocol.json
node dist/cli.js --db .harness-delta/pilot/local.sqlite comparison freeze pilot-1
node dist/cli.js --db .harness-delta/pilot/local.sqlite workflow status pilot-1
```

Expected: `native_execution: true` for an eligible workflow profile with complete
accepted inputs. Conditional sources appear as `compatibility_unverified` under
`source_compatibility`; `readiness.real_allocation` remains false for those sources.
`whole_task_cost_unconfirmed` and `analysis_unverified` remain expected limitations.
If `native_source_unqualified` or `native_adapter_not_wired` appears, stop before launch.
If freeze fails, check every required field and ensure recruitment has not started.
Changing a configuration flag cannot qualify an unsupported source.

## 5. Assign and launch the task

Prerequisites: accepted inputs, frozen protocol, exact binary and approval for this actual run.
Use a fresh `run_id` in `launch.json` and a fresh confirmation ID.

```sh
node dist/cli.js --db .harness-delta/pilot/local.sqlite workflow codex launch \
  --config .harness-delta/pilot/workflow.json --runtime .harness-delta/pilot/runtime.json \
  --execution .harness-delta/pilot/launch.json --confirmation confirmation-1
```

For Claude Code, run `workflow claude launch` with the same options and `claude-launch.json`.
`child_runtime` needs a direct-child protocol, the exact version and `permissions: "read-only"`.
Conditional child execution on an own-trace protocol fails before assignment with
`workflow_adapter_mismatch`; matching-profile child execution with edit permissions
fails with `claude_workflow_child_read_only_required`. Direct adapter preflight may
give `claude_workflow_child_unadmitted` for a version without direct-child admission.
To continue the same native session later, add `"resumable": true` to the launch, then run `workflow claude resume` with `claude-resume.json`. A resumable launch makes Claude Code keep its own transcript in your Claude configuration; Harness Delta never reads it, and the time between runs is an `offline` gap.
The resume example is read-only. Only a read-only kept launch followed by a read-only
resume has native evidence; edit-mode resume and changing permissions between runs
are not established. Resume does not compare permissions with the kept launch.

Launch assigns and starts the task. Do not run `task register` for this v2 assignment.
`workflow begin` prepares assignment/start without product execution; it does not apply a harness by itself.
Preflight checks binary, recorder, prompt and home before assignment/start (Claude: binary, prompt, effort, child scope and harness location; the workspace is checked at launch).
A preflight failure creates no assignment or active interval.
A later pre-spawn failure can pause an activated task again; its receipt shows `activation_reverted: true`.

Expected receipt: canonical task ID, selected variant, session ID and `adapter_result`.
Use the returned canonical task ID in later commands.
`completed` means the invocation ended, not that the human task succeeded or all usage was observed.
For `failed`, read `reason` and `diagnostic`; earlier eligible usage can remain partial.
For `stopped`, inspect the task before continuing. Never retry a paid launch automatically.
The receipt's instruction verification covers outgoing invocation settings, not native resolved-harness attestation.

## 6. Check, stop or pause

1. Read the task state, deadline, runs and `next_actions`.

   ```sh
   node dist/cli.js --db .harness-delta/pilot/local.sqlite workflow task task-1
   ```

2. If a run is alive, request its stop.

   ```sh
   node dist/cli.js --db .harness-delta/pilot/local.sqlite workflow codex stop run-1
   ```

3. Read the task again until the run is no longer `running`.

   ```sh
   node dist/cli.js --db .harness-delta/pilot/local.sqlite workflow task task-1
   ```

4. If you are taking a break and the task is active, pause the task.

   ```sh
   node dist/cli.js --db .harness-delta/pilot/local.sqlite task pause task-1
   ```

Expected: `stop` ends the run/collection; `pause` closes the task's active-time interval.
Use `workflow claude stop` and `workflow claude recover` for Claude runs.
Pausing during a run also ends it: the launch reports `workflow_scope_revoked` and the in-flight interval is recorded as an `incomplete` gap.
A completed or stopped run alone leaves the task active. Active time is not human labor.

If the collector disappeared while a run stays `running`, recover before pausing or finishing:

```sh
node dist/cli.js --db .harness-delta/pilot/local.sqlite workflow codex recover run-1
```

Recover records failure `abandoned` and an observation gap; it adds no usage.
An inactive task reports `gap_warning: task_not_active` instead of recording that gap. If the task was paused or finished while the run was `running`, that transition already recorded the gap.
Recover cannot signal an orphaned native process. End any leftover product process yourself before another run.

## 7. Resume or use another session

Use fresh run and confirmation IDs for every operation.
Keep the original logical task, database, project, criteria and assignment.
Changing model/effort does not rerandomize the task.
A launch/resume reactivates a paused task with a new confirmation.

For the same session, put the receipt's exact `session_id` in `resume.json`:

```sh
node dist/cli.js --db .harness-delta/pilot/local.sqlite workflow codex resume \
  --config .harness-delta/pilot/workflow.json --runtime .harness-delta/pilot/runtime.json \
  --execution .harness-delta/pilot/resume.json --confirmation confirmation-2
```

Claude Code has no resume or link operation here; continue with another `workflow claude launch`
on the same task, using a new `run_id` and confirmation ID. The new session starts without the earlier conversation.

For another independent root, use a new `run_id` and prompt in `launch.json` with the same workflow file.
Run the launch command from step 5 with a new confirmation ID.
For an externally started root, explicitly bind its exact UUID and canonical source path:

```sh
node dist/cli.js --db .harness-delta/pilot/local.sqlite workflow codex link \
  --config .harness-delta/pilot/workflow.json --runtime .harness-delta/pilot/runtime.json \
  --execution .harness-delta/pilot/link.json --confirmation confirmation-3
node dist/cli.js --db .harness-delta/pilot/local.sqlite workflow codex collect \
  --config .harness-delta/pilot/workflow.json --runtime .harness-delta/pilot/runtime.json \
  --execution .harness-delta/pilot/collect.json --confirmation confirmation-4
```

Expected: link/collect reports `external_unverified`; these operations do not apply the assigned harness or launch a product.
For external work, confirm the selected instructions independently before using that session.
Wait for collection's initial baseline before starting a new turn. Keep collection in the foreground while working.
Earlier, paused and offline usage is excluded; stored observations survive source-file loss.
There is no discovery, `--last`, retrospective backfill or automatic retry.
A read racing a native append ingests nothing and retries at the next poll, at most 20 consecutive times or the invocation deadline.
Identity, truncation and prefix changes still fail closed.
Keep assigned workflow tasks on `workflow codex`. Generic `session link`/`collect`
is a separate file-parser lane with different scope and trust, even when the version is eligible there.
The separate direct-child profile cannot resume its family; after pause, use a fresh root/child pair.

## 8. Record the human outcome

Prerequisites: collection has settled, no run is still active, and the work product has been reviewed.
Before `followup_ends_at`, record all fulfilled criterion IDs:

```sh
node dist/cli.js --db .harness-delta/pilot/local.sqlite workflow finish task-1 --outcome success --met criterion-1
```

Expected: `counted_in_deadline_status: true` when assessed before the deadline.
`success` requires every criterion. `failed` and `aborted` accept a subset.
Finalization is immutable. A passing test, process exit or positive usage never finalizes the task automatically.
Use first-completion/assessment/rework commands only when recording those separate lifecycle events; see [local measurement](local-measurement.md#assess-report-and-delete).
If review is late, still record the honest outcome. The warning `assessment_after_followup_deadline` means it is stored but excluded from deadline status.

## 9. Create and read the report

After the follow-up deadline and outcome timestamp, capture a current UTC cutoff:

```sh
reportCutoff=$(node -p 'new Date().toISOString()')
```

Create the frozen snapshot:

```sh
node dist/cli.js --db .harness-delta/pilot/local.sqlite workflow report pilot-1 \
  --id report-1 --cutoff "$reportCutoff" --reason initial
```

Read the human-facing tables:

```sh
node dist/cli.js --db .harness-delta/pilot/local.sqlite comparison report report-1 --format markdown-readable
```

Expected: original A/B assignment, human outcomes, partial costs and explicit limitations.
A cutoff before the deadline shows `followup_pending` even for a finished task.
`deadline_status` can be `success`, `failed`, `aborted`, `outcome_missing`, `not_started` or `followup_pending`.
A late assessment appears as `late_outcome` in new `flexible-cost-descriptive-2` reports.
Stored version-1 snapshots retain their original shape.
If more evidence arrives, create a new report ID with the appropriate revision reason; old snapshots do not change.

Estimate the same task's observed components using its pinned comparison table:

```sh
node dist/cli.js --db .harness-delta/pilot/local.sqlite price-table estimate-task task-1 \
  --cutoff "$reportCutoff" --input-basis output-only-v1
```

Read [the cost guide](observed-cost.md) before selecting an input assumption or comparing estimates.
Never add cached input to its total input or reasoning output to its total output again.
A partial amount is not a bill. An unpriced model remains unavailable; do not substitute another model's rate.

| Value/state | Interpretation |
| --- | --- |
| Observed `0` | Eligible observation measured zero |
| Missing | No eligible value was observed |
| Error | The source or observation failed |
| Excluded | The interval/value was outside permitted scope |
| Unmeasurable | This source cannot establish the requested value |
| `partial_amount: null` | No eligible priced amount; not zero |
| `complete_amount: null` | Whole-task cost remains unconfirmed, even when partial usage is priced |

## 10. Resolve errors or remove local data

The CLI prints fixed codes and, for common errors, a `hint:` line.
It does not print raw producer messages, private paths or instruction text.

| Code | Next action |
| --- | --- |
| `invalid_command: ...` | Read that command's `--help`; supply the required arguments/options |
| `*_file_unreadable`, `*_file_invalid_json`, `invalid_execution` | Correct the path/JSON and compare the operation with the example |
| `binary_mismatch`, `binary_unreadable` | Use the exact pinned binary and canonical path; do not update it silently |
| `invalid_hook_recorder`, `invalid_prompt`, `unsafe_home` | Correct the unmodified recorder, UTF-8 prompt (≤1 MiB), or existing home |
| `confirmation_conflict` | Supply a new `--confirmation` ID |
| `workflow_run_active` | Wait for, stop or recover the existing run |
| `real_experiment_disabled` | Check freeze and `workflow status`; source qualification is independent of purpose labels |
| `workflow_manifest_mismatch` | Stop; the registered instructions changed. Resolve prospective inputs before another run |
| `invalid_transition` | Read `workflow task`; perform the action allowed by its current state |
| `invalid_criteria` | Supply every fulfilled criterion ID for `success` |
| `invalid_cutoff` | Capture a valid UTC time no later than now |

Stop on scope loss, unsupported topology/version, conflicting usage, failed teardown or privacy exposure.
Preserve failed/aborted outcomes and earlier eligible partial observations. Do not reassign or backfill them.

If local task deletion is intended:

```sh
node dist/cli.js --db .harness-delta/pilot/local.sqlite delete task task-1
```

Deletion invalidates dependent reports and prevents identifier reuse.
It does not delete original product transcripts, work products or exported copies.
Retention is opt-in; see [local deletion and retention](local-measurement.md#assess-report-and-delete).

## Terms and further reading

| English | 한국어 | Meaning |
| --- | --- | --- |
| Task | 작업 | Durable unit with fixed human criteria |
| Run | 실행 | One invocation; not the human outcome |
| Session | 세션 | One explicitly linked product source |
| Assignment | 배정 | Original A/B selection retained across runs |
| Stop | 실행 중지 | End the run/collection |
| Pause | 작업 일시중단 | Close active task time |
| Follow-up deadline | 판정 기한 | Fixed deadline for the counted outcome |
| Partial cost estimate | 부분 비용 추정 | Priceable observed components at explicit reference rates |

Use [flexible comparison](flexible-comparison.md) for configuration contracts and [native workflow](task-native-workflow.md) for advanced source/child boundaries.
Use [v1 synthetic comparison](task-comparison.md), [synthetic exchange](team-file-exchange.md) and [method validation](comparison-analysis-validation.md) only for their stated development scopes.
