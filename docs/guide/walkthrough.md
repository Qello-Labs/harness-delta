# Walkthrough: observe one task in the Qello backend

[한국어](walkthrough.ko.md)

This guide is for first-time users of the Harness Delta local UI. It follows one
feature task in the Qello backend repository (`dnd-15th-2-backend`) from setup to
the final outcome. It uses **ordinary Claude observation**, which needs no A/B
comparison setup.

Detailed rules and error codes are in the [local UI runbook](../runbooks/local-browser-ui.md)
and [Harness Connect](../runbooks/harness-connect.md#ordinary-claude-observation).
This guide combines those procedures into one flow. Screenshots show the Korean UI;
select **EN** in the top-right corner for English labels.

Screenshots 10–16 were captured on 2026-10-16 from a running local server and its
built UI, using an isolated example project, synthetic session identities and
synthetic usage. They demonstrate real UI controls, not an actual Qello task result
or native Claude/Codex qualification. The example project is named
`harness-delta-guide-demo`; use your own task's IDs and server address.

## Summary

Harness Delta records **how much an AI agent used for one development task**.
It stores usage metadata only, not prompts, responses or code. You create a task,
paste one connect command into a Claude session, and judge the outcome yourself
when the work is done. You always start and stop the agent yourself.

```text
 Setup (once)                         Repeat for each task
┌──────────────────────────┐   ┌──────────────────────────────────────────────────┐
│ ① Register the project   │   │ ③ New task → ④ /harness-connect in Claude        │
│ ② Install Claude connect │──▶│ → ⑤ Confirm "measuring", work → ⑥ Stop → ⑦ Judge │
└──────────────────────────┘   └──────────────────────────────────────────────────┘
```

## Terms

| Term | Meaning |
| --- | --- |
| Task | The unit of measurement: one request with a judgeable outcome, such as "notification inbox read API". |
| Ordinary Claude observation | Normal Claude work with usage observation and no A/B assignment. |
| Parent / child session | The Claude session you open is the parent. Sub-agents it starts are children. Up to 8 members, including the parent, are counted together. |
| Pause | Stops collection only. Claude keeps running, and paused usage is never backfilled. |
| Observed cost | A **partial estimate** of observed usage with matched prices. It is not billing. |

## Before you start

| Item | Requirement | Check |
| --- | --- | --- |
| Node.js | 24 or 26 | `node --version` |
| Ordinary Claude runtime | macOS arm64 | `node -p "process.platform + ' ' + process.arch"` |
| Claude Code | **Exactly 2.1.296** (reviewed binary) | `claude --version` |
| Target repository | A Git repository with a work branch ready | `git status --short` |

### Claude and Codex version updates

Newer-version support is being updated separately from this screenshot guide.
The repository status on **2026-10-16** is:

| Route | Version status | What this means for this guide |
| --- | --- | --- |
| Ordinary Claude connection | Exact 2.1.296 version and reviewed binary; native qualification remains incomplete | This is the currently admitted connection route shown here. |
| Ordinary Codex connection | Exact 0.162.1, bounded family, frozen `functional_pilot` assignment | Not the assignment-free Claude flow. |
| Update targets: Claude 2.1.301 / Codex 0.163.0 | Existing file and selected workflow windows return `compatibility_unverified`; target-binary conformance and ordinary connection admission are pending | Conditional parser reuse does not enable connection through this flow. |

Check [Harness Connect current implementation](../runbooks/harness-connect.md#current-implementation)
before starting, and [native workflow limits](../runbooks/task-native-workflow.md#conditional-forward-versions)
for the separate workflow route. Setup or installation succeeding does not prove
that a new version can connect. If connection returns `claude_source_version_unsupported`,
check the current admitted version there; do not treat a pending update as completed support.

## Step 0: Start the local UI

Run these commands in the Harness Delta checkout.

```sh
npm ci
npm run build
npm start -- --db local.sqlite ui
```

Open the displayed `http://127.0.0.1:4318` address. The service is reachable only
from this computer. `local.sqlite` holds your measurements, so keep using the same
file. Press Ctrl+C in the terminal to stop the service.

The task list is empty at first. Select **Connect project** or go to **Setup**.

![Empty task list](images/01-empty-tasks.png)

**Getting started** summarizes the whole flow. The top card, "Ordinary Claude work ·
no A/B assignment", is the route in this guide. The numbered comparison flow below it
is for A/B harness comparison; skip it for now.

![Getting started](images/02-intro.png)

## Step 1: Register the project (once)

In **Setup → 1. Register and select a project**, type the **absolute path** of the
target repository, or use **Choose** to pick the directory. Then select
**Connect project**.

```text
/Users/<you>/DEV/project/dnd-15th-2-backend
```

A `~/...` path is not expanded and fails with `local_operation_failed`. Registration
reads Git HEAD only. It does not write files or create commits in the target repository.

![Register project](images/03-settings-register.png)

After registration, a `dnd-15th-2-backend` project card appears. The
**2. Prepare comparison settings** section is for A/B comparison only.

For the full Settings click-through, including Codex setup, comparison-file
review, bundle loading, confirmation and saved-setting reuse, see
[Setup screenshots](../runbooks/local-browser-ui.md#click-through-setup).

## Step 2: Install the Claude connection (once)

Under the project card, open **Agent connection setup** and select **Claude Code**.

![Claude connection before setup](images/04-claude-connection-before.png)

1. Select **Configure Claude**. The badge changes from "Not configured" to "Configured".
   **Prepare measurement** in Step 4 stays disabled until this is done.
2. Select **Preview install / update**. This step writes no files. Check that every file
   is under `.claude/skills/harness-connect/`.
3. After review, select **Install / update reviewed package**.

![Install preview](images/05-claude-install-preview.png)

When installation finishes, the badge shows "Installed".

![Installed](images/08-claude-installed.png)

The Qello backend `.gitignore` already excludes Harness Delta local artifacts such as
`/.claude/skills/harness-connect/` and `.harness-delta/` (#357). The installed package
and connection records therefore stay out of `git add -A` and the clean-worktree checks
of `./harness start` and `sync`.

> Installation does not start observation. Package installation, hook registration,
> confirmed connection and active measurement are separate states.

## Step 3: Prepare the work branch in the target repository

Follow the usual Qello procedure: create the Issue branch and `TASK.md` first.
This step belongs to the Qello harness, not to Harness Delta.

```sh
cd /Users/<you>/DEV/project/dnd-15th-2-backend
./harness start --issue <issue-number> --type feat --slug notification-inbox-read
./harness task-init --title "알림함 읽기 API (F07-N1)" --replace
```

## Step 4: Create a task

In the Harness Delta UI, open **Tasks → New task**.

| Field | Value |
| --- | --- |
| Task mode | **Ordinary Claude observation · no comparison required** |
| Task name | `알림함 읽기 API (F07-N1)` (matching the Issue title helps later) |
| Project | `dnd-15th-2-backend` |
| Completion criterion | "User confirms completion of the original request" (selected by default) |
| Optional settings | Type `feature`, size `small`, and so on. Change them only when needed. |

Select **Prepare measurement**. The task is created and its detail page opens. The task
pins the current project setup and price table.

![New task](images/06-new-ordinary-task.png)

If you configured Claude but skipped installation, the detail page shows "This project
needs the connection skill." Finish installation with **Preview install / update** on the
same page.

![Task that needs installation](images/07-task-install-needed.png)

## Step 5: Connect the Claude session

When installation is confirmed, the **Claude connection** card moves to step
`2 Connect` and shows the connect command.

![Connect command](images/09-task-connect-command.png)

1. Open Claude yourself in the target repository.

   ```sh
   cd /Users/<you>/DEV/project/dnd-15th-2-backend
   claude
   ```

2. Select **Copy connection prompt** in the UI and paste it **once** into that Claude session
   (the parent). The command has this shape:

   ```text
   /harness-connect Connect this session to project <PROJECT_ID>, task <TASK_ID>, using http://127.0.0.1:4318.
   ```

3. Wait for the UI to refresh. When connected, it shows "Connected. Continue your work."
   and the card moves to `3 Measure`.

Usage before the connection is excluded. An older session can be connected; only
later usage is counted.

## Step 6: Confirm measurement, then work as usual

Confirm that the status is **Measuring**, then give Claude the task. Before the first
usage arrives, the page shows that it is waiting for the first usage, and cost stays
**unknown**, not zero.

Sub-agents started by this session appear under the parent in the **Connected
sessions** table. Agent and model columns come from observed metadata.

![Connected and waiting for first usage — synthetic example](images/10-measuring-waiting-usage.png)

Read the screen from top to bottom:

1. The summary shows **In progress** (`진행 중`), while the **Claude connection**
   badge shows **Measuring** (`측정 중`). These indicate collection, not task success.
2. The connection card says "Connected. Continue your work." and highlights `3 Measure`.
3. **Connected sessions** shows parent 1, child 0. Before usage arrives, model is
   unknown, request count is `—`, input/output are missing and cost is unknown.
   A connected session alone does not establish observed zero.

![Parent and child usage — synthetic example](images/11-measuring-family-usage.png)

In this example, the parent has 1 request, 1,200 input tokens and 320 output tokens.
The child has 1 request, 400 input tokens and 120 output tokens. **Observed total**
is 2 requests, 1,600 input and 440 output tokens; do not add the total row again.
The displayed USD 0.0152 is a partial example amount, labeled
**Compatibility-unverified reference cost** (`호환성 미검증 참고 비용`), not a bill
or a verified complete cost. Missing-family warnings still matter even when rows
contain numbers. Family members appear under the root; the UI does not establish
the immediate parent relationship of nested members.
Here the unverified label comes from the current Claude binding's incomplete
qualification, not from using the newer-version update target.

In the Qello backend, Claude runs the usual checks:

```sh
./harness check
./harness pr-ready --project-tests
```

Controls during the work:

| Control | What it does | What it does not do |
| --- | --- | --- |
| **Pause measurement** | Stops collection, for example during a meeting. | It does not stop Claude or backfill the paused interval. |
| **Resume measurement** | Collects again from a new baseline. | It does not backfill the paused interval. |
| **Stop observation · keep Claude running** | Releases this task's ownership of the session. | It does not stop Claude. |

![Measurement paused — synthetic example](images/12-measurement-paused.png)

After **Pause measurement**, the summary shows **Paused** (`일시정지`) and the
connection card says measurement is paused (`일시중단`). The button changes to
**Resume measurement**. Existing rows and partial cost remain visible; they are
not new collection. Select **Resume measurement** to observe future usage again.
If the session cannot resume, follow the connection instructions instead.

## Step 7: Stop observation and judge the outcome

When the work is done (for example, the PR is ready):

1. Select **Stop observation · keep Claude running**. This is required before the same
   Claude session can serve the next task. Connecting another task first returns
   `binding_session_conflict` or `binding_receipt_stale`.
2. Review the retained usage and judge the outcome under **Task outcome**.

![Observation stopped, outcome not yet judged — synthetic example](images/13-observation-stopped.png)

Observation stop and task completion are separate. In the current UI, stopping
returns the connection card to **Waiting for connection** (`연결 대기`) while the
summary can still say **Paused** and **Not judged yet**. Previous session rows and
cost stay visible. This is not a success result; do not paste the old connect
command again just to finish the task.

| Outcome | When |
| --- | --- |
| **Complete successfully** | The original request (the Issue completion criteria) is met. This is final. |
| **Continue rework** | Disabled in the ordinary flow shown here. Do not finalize success while fixes are still needed. |
| **End task ▾ → End as failed / Abandon** | The request was not achieved, or the work stopped. |

If requirements grew, create a new task instead of rework. Leaving the page or
closing Claude never records success.

Select **Complete successfully** only after reviewing the original completion
criterion. A confirmation dialog opens; **Cancel** leaves the task unjudged.

![Success confirmation — synthetic example](images/14-outcome-confirmation.png)

Select **Confirm** to make the result final. The dialog warns that rework cannot
be added after success is finalized.

![Finalized success — synthetic example](images/15-task-completed.png)

The summary now shows **Measurement ended** (`측정 종료`) and **Success** (`성공`).
**Task outcome** records the human confirmation and its time. The session rows
and partial amount remain available for review; success does not make them
complete usage or billing evidence.

## Moving to the next task

To keep using the same Claude session:

1. Confirm that you stopped observation on the previous task.
2. Prepare the next Issue branch in the target repository (Step 3).
3. Create a new task (Step 4) and paste its connect command into the same session (Step 5).

The new task starts with a new baseline and its own measurement ID. It does not take
usage from the previous task. If you restarted Claude, paste the connect command again,
even when you resumed the same session ID.

## Reading the results

The summary at the top of the detail page has four values.

| Value | Meaning |
| --- | --- |
| Measurement | Summary: waiting for connection / in progress (`진행 중`) / paused (`일시정지`) / measurement ended (`측정 종료`). The connection card uses measuring (`측정 중`) / paused (`일시중단`). |
| Outcome | Not judged yet, or your judgement |
| Active measurement time | Time with collection on. It is not human working time. |
| Observed cost | Partial estimate of observed usage with prices. Missing prices are unknown, not zero. |

See [observed cost](../runbooks/observed-cost.md) and
[reference prices](../runbooks/reference-price-catalog.md) for the calculation.

![Completed task in the list — synthetic example](images/16-completed-task-list.png)

Select **Back to tasks** to return to the list. The row shows the task name,
**Success** and the example project. **View details** reopens the retained result;
**New task** starts a separate measurement, not another attempt on this finalized task.

## Common blockers

| Symptom | Cause | Action |
| --- | --- | --- |
| `local_operation_failed` when connecting a project | Unresolvable path such as `~` | Type an absolute path or use **Choose**. |
| `claude_source_version_unsupported` on connect | Claude Code is not 2.1.296 | Run Claude with the supported version. |
| `binding_session_conflict` when connecting another task | The session is still bound to the previous task | Select **Stop observation · keep Claude running** on that task. |
| `package_unowned` or `package_drift` on install | Files under `.claude/skills/harness-connect` were edited or created by another tool | Back up and review the files, then preview again. Nothing is overwritten. |
| `ordinary_installation_in_use` on uninstall | An ordinary task is still active | End and judge the task first. |
| Collection stops after a service restart | Tasks stay paused after a restart | Resume on the task page, or paste the connect command again if Claude was restarted. |

## Boundaries

- Measurement data never contains prompts, responses, source code or secrets.
- Only usage from a registered project, an active task and a connected session is collected.
- Paused, offline and pre-connection usage stays unobserved and is never backfilled.
- The UI does not start or stop Claude, create commits, change authentication or expose the service.
