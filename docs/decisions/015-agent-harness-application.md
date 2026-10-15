# ADR 015: Native-session harness application

Status: Accepted responsibility split; native acceptance and measurement qualification pending.
UI-guided restoration amendment (2026-10-16) implemented.

## Context

Portable format-2 comparisons may contain a reusable application procedure and
scripts rather than ready-to-load working instructions. The stored A/B assignment
must survive retries. A procedure can adapt domain-specific rules only after the
applying agent investigates the selected project.

## Decision

The UI preserves assignment and selects an existing checkout/worktree and native
product. The applying product is the user's choice and need not equal the task's
measured product; working-session guidance and connection always use the task's
product, and application identity is registered only through that product's
provider. It prepares an immutable task-scoped application context. The fresh native
session's own agent invokes harness-apply, reads the assigned bundle, investigates
project structure, runs its scripts and edits the selected workspace directly.
Native tools decide permissions in that native window.

The server owns assignment, target inspection, context, explicitly scoped file
checkpoints and result verification. It has no applying agent runner, app-server
owner, tool/permission proxy, execution timer, process termination or publisher.
`application-prepare` does not execute an agent. `application-open` requests one
interactive native opening; acknowledgement does not prove a session started.

On macOS the opening adapter uses a private executable command file and one
`open -a Terminal` request. Individual CLI arguments and cwd are literal POSIX
quoted values. The CLI is interactive with an initial prompt; there are no model,
trust, auth or permission overrides, resume flags or stdin drivers. No agent PID
is retained. The private command file lives under the attempt so deletion can
remove its context along with checkpoints. Other platforms, missing executables and failed opening expose
copyable context. Desktop prompt deep links are unsupported. CLI grammar was
checked using Codex CLI 0.161.0 and Claude Code 2.1.295 help and official references;
synthetic opening tests do not establish native opening or application acceptance.

## File evidence and privacy

The agent requests checkpoints immediately before editing each discovered output.
No complete file list is required in advance. A checkpoint records the actual
dirty preimage or absent state; Git HEAD is never a replacement baseline. Repeated
requests cannot replace the baseline, and drift requires explicit investigation.
Relative paths must stay inside the inspected target; symlinks, hardlinks,
nonregular files, hidden paths, registered bundle storage, node_modules and known
secret paths are excluded. Configured private data paths and DB sidecars are also
excluded. Files are bounded to 1 MiB and 256 checkpointed paths per attempt.

The report contains only file/checkpoint identifiers, expected present/absent
hashes and bounded named check outcomes. Wrong target, bundle, stale attempt,
missing checkpoint and mismatched bytes cannot complete application. The server
reads current files independently and revalidates hashes when results are reused.
Checks remain `agent_reported`; file verification covers the reported set, not
all tool actions or every filesystem change. Missing/refused/failed checks remain
visible and block readiness even if the reported file hashes match.

Before bytes are private ignored review artifacts. Actual after bytes are read
transiently for UI review. File content, prompts, raw command output and secrets
never enter measurement records, mutation response journals, reports or exports.
The UI review is post-application confirmation. There is no second publish approval
and no automatic rollback. Abandonment invalidates helper operations and does not
stop the external agent; stop it in its native window.

## Session separation and compatibility

Application files, reported tool evidence, native identity, instruction loading
and measurement eligibility are independent facts. A metadata-only root identity
provider may register the application role before any transcript access. Codex's
existing exact-version native root receipt path supplies this integration; no
new product/version admission is created. Claude application identity currently
has no metadata-only resolver and remains unavailable. Never infer identity from
cwd or agent claims or inspect unlinked sessions to identify them.

Reject registered application identities and their evidenced immediate parent
relations before working-session source access. Unsupported broader ancestry
remains subject to existing family/source gates. An application-required task
also needs a fresh working root created after completion, and verified
application identity when the applying product equals the working session's
product. A different applying product can never be the working session, so its
identity is not required; exclusion of registered identities, freshness and
epoch checks are unchanged. In that case separation rests on product inequality
and freshness alone: a task-product session that the applying agent itself
starts after completion is not detected, as was already true for any
independently started same-product session. The UI supplies populated target, assignment and harness-connect
context for a separate session. Native instruction-loading and source qualification
remain pending; this feature does not enable unsupported measurement sources.

Migrations 029–030 add external attempts, checkpoints, roles, opaque exclusion
tombstones and a private-artifact cleanup journal without altering
026–028 history. Old managed jobs/receipts are never interpreted as native direct
application. Unfinished external attempts fail closed after restart; neither
restart nor deletion relaunches/stops an agent, rolls back files, starts collection
or recreates deleted records. Task/project deletion schedules cleanup of product-owned
review and launch artifacts after the database transaction commits. Pinned roots
and no-follow directory checks protect unrelated workspace files; unsafe paths
remain durably `application_cleanup_pending` and explicit deletion retries can
complete cleanup. Opaque application identity exclusions survive independently
of deleted tasks to keep still-running applying sessions excluded. Normal task-workflow process ownership is unchanged.

## Explicit restoration and staged check

Rollback stays non-automatic. A user-authorized explicit local CLI adds three
operations, run from a built checkout:

```sh
node dist/cli.js --db /path/to/local.sqlite application preview <task-id>
node dist/cli.js --db /path/to/local.sqlite application restore <task-id> --preview <digest>
node dist/cli.js --db /path/to/local.sqlite application check-staged <task-id>
```

`preview` is read-only. It outputs a digest and a path/action list of `delete`,
`restore`, `unchanged` and `conflict`, with no file contents. `restore` requires
a digest that matches a fresh preview, an inactive task, no running or observing
connections and the external released stop acknowledgement. Finalized tasks are
allowed. The server still stops no agent; the acknowledgement records a stop the
user performed in the native window.

A conflict blocks all edits, so restoration is never partial by guesswork. Files
whose current hash equals the applied hash are restored to the actual dirty
checkpoint baseline, not Git HEAD. Files the application created are deleted.
User-modified files are not overwritten. After restore the application is fenced
and must be explicitly reapplied before measurement; restore neither reapplies
nor starts collection.

Restore never changes the Git index. The user restages and runs `check-staged`,
which returns exit 2 while harness edits or private `.harness-delta` or
`.harness-delta-managed` entries remain staged. A file at its current checked
original baseline is allowed. Mixed divergence is flagged conservatively rather
than guessing which edits belong to the user. All three operations cover checkpointed
paths, including reported files. Changed checkpoints without verified result hashes
remain conflicts. The staged check retains paths from earlier restored cycles
in the same worktree and rejects private directories throughout the index.
Changes outside checkpoint scope are not audited or restored.

Restoration may be interrupted after earlier files have completed. Its fence and
lease remain until an explicit retry completes. A fresh preview skips completed
baseline files; partly written or concurrently changed files require manual
recovery from the retained private checkpoint without overwriting user edits.
Missing parent directories are recreated with the existing no-follow directory
helper. Inactivity and stop acknowledgement are checked inside the transaction
that reserves the lease and fences the application.

Switching worktrees requires completing restoration first. Historical inherited
metadata without a checkpoint in the selected root is not an edit in that root
and is not restored there; any earlier-worktree edits need separate review.
Index baselines use Git clean conversion. Checks never read current working
file bytes. Alternate indexes are supplied by the caller, whose hook must select
the task for its worktree. Divergent user-only staged edits are conservatively
flagged as well. Mode-only changes remain outside the hash-based preview; legacy
absent files without mode metadata are recreated with mode 0600.

Hook integration is manual. The product installs and overwrites no hooks, and
the check is not mandatory enforcement. Checkpoint records are retained until
restoration and the commit check are complete. Task deletion still never
restores files. No native support limit, identity gate or source admission
changes. See [the restore flow](../runbooks/harness-config.md#7-restore-applied-edits-and-check-staged-files).

## Amendment 2026-10-16: UI-guided restoration

### Context

Restoration needs four separate CLI steps: external release, preview, restore
and check-staged. Each step needs the database path and task ID. Users finish
measurement in the UI and then must change to a terminal to remove the harness
before they open a pull request. The CLI steps are easy to forget, and a missed
restore puts harness edits into the pull request.

### Decision

Restoration becomes the second of two UI steps. The first step is unchanged.

1. **End the measurement.** The existing task outcome actions (complete, end as
   failed, abandon) end the measurement. They do not restore files. The harness
   stays in the project, so the user can continue review fixes with it.
2. **Remove the harness.** After the outcome is recorded, the task page shows a
   restoration card while checkpointed application edits remain in the selected
   worktree. The card stays until restoration completes. It is a request to the
   user, not an automatic action.

The restoration dialog is the warning. It does not show a generic warning:

- When the dialog opens, the server computes a fresh preview. The dialog groups
  the paths by action: restored, deleted and unchanged. It shows no file
  contents.
- If the preview has a conflict, the dialog lists the conflicting paths and
  disables the confirm button. No file changes. This is the same all-or-nothing
  rule as the CLI.
- The user must select a checkbox that confirms that they stopped the native
  agent. The checkbox records the external release acknowledgement when it is
  not already recorded. The server still stops no agent.
- The confirm request sends the preview digest. The server refuses the request
  when a fresh preview has a different digest or a conflict, before it records
  the stop acknowledgement. The UI then loads the new preview and asks again.
- After a successful restore, the server runs the read-only staged check and
  the UI shows its result. A clean result says only that no checkpointed harness
  edits or private records are staged. It does not say that the pull request is
  safe. Restore and the UI never change the Git index. If entries remain staged,
  the UI lists them and tells the user to unstage them.

Interrupted restoration uses the same dialog. A fresh preview shows completed
files as unchanged. The application stays fenced until a retry completes.

The CLI operations stay available with the same contracts for hooks and
scripts. The UI and the CLI call the same preview, restore and staged-check
operations. The release acknowledgement and restore remain separate
transactions. If restore fails after release, the release stays recorded.

### Unchanged

- Ending a measurement never restores files. Task deletion never restores files.
- Restore needs an inactive task and no running or observing connections.
- No hook is installed. The staged check is not mandatory enforcement.
- Mutation responses and journals contain paths, hashes and actions only. File
  contents, prompts and command output never enter them.
- No native support limit, identity gate or source admission changes.

### User-facing copy

The UI shows plain-language text. The Korean text is primary for the current
users. `N` is a count; `<path>` is a repository-relative path.

| Location | Korean | English |
| --- | --- | --- |
| Outcome card, after step 1 | 측정이 끝났습니다. 측정에 쓴 하네스 파일은 아직 프로젝트에 남아 있습니다. PR을 올리기 전에 하네스를 되돌리세요. | Measurement has ended. The harness files used for measurement are still in your project. Remove the harness before you open a pull request. |
| Restoration card title | 프로젝트에서 하네스 되돌리기 | Remove the harness from your project |
| Restoration card body | 측정 결과는 그대로 남습니다. 하네스가 고친 파일은 적용 전 내용으로 돌아가고, 하네스가 새로 만든 파일은 삭제됩니다. | Your measurement results stay. Files that the harness changed return to their earlier content. Files that the harness created are deleted. |
| Restoration card button | 하네스 되돌리기… | Remove harness… |
| Dialog title | 하네스를 되돌릴까요? | Remove the harness? |
| Dialog description | 아래 파일을 하네스 적용 전 상태로 되돌립니다. 되돌린 뒤에는 하네스를 다시 적용해야 이 작업을 다시 측정할 수 있습니다. | These files return to their state before the harness was applied. After this, you must apply the harness again to measure this task again. |
| Group: restore | 원래 내용으로 되돌림 (N) — 하네스가 고친 파일입니다. | Restore earlier content (N): files that the harness changed. |
| Group: delete | 삭제 (N) — 하네스가 새로 만든 파일입니다. | Delete (N): files that the harness created. |
| Group: unchanged | 변경 없음 (N) — 이미 원래 상태입니다. | No change (N): already in their earlier state. |
| Conflict | 직접 고친 파일이 있어 되돌릴 수 없습니다 (N). 하네스 적용 뒤에 이 파일들이 수정됐습니다. 수정 내용을 잃지 않도록 아무 파일도 바꾸지 않았습니다. 수정 내용을 정리한 뒤 다시 시도하세요. | Some files changed after the harness was applied (N). No file was changed, so your edits are safe. Resolve these files, then try again. |
| Checkbox | 터미널이나 IDE에서 AI 세션을 직접 종료했습니다. | I stopped the AI session in my terminal or IDE. |
| Checkbox help | 실행 중인 AI는 되돌린 파일을 다시 고칠 수 있습니다. Harness Delta는 AI를 대신 종료하지 않습니다. | A running AI can change the restored files again. Harness Delta does not stop the AI for you. |
| Index note | 이미 git add 한 파일은 커밋 대기(staged) 목록에 그대로 남습니다. | Files that you already added with git add stay staged. |
| Buttons | 취소 / 되돌리기 | Cancel / Remove |
| Retry button (conflict or load failure) | 다시 확인 | Check again |
| Loading | 파일을 확인하는 중… | Checking the files… |
| Load failure | 파일 목록을 불러오지 못했습니다. 다시 시도하세요. | The file list could not be loaded. Try again. |
| Preview changed | 목록을 확인하는 동안 파일이 바뀌었습니다. 새 목록을 불러왔으니 다시 확인하세요. | Files changed while you reviewed the list. Review the new list. |
| Result: clean | 하네스를 되돌렸습니다. 커밋 대기 목록에 하네스 변경분이 없습니다. | The harness is removed. No harness edits are staged. |
| Result: staged | 하네스를 되돌렸습니다. 아직 커밋 대기 목록에 하네스 파일이 있습니다. 터미널에서 아래 파일마다 git restore --staged를 실행하세요. (경로 목록과 복사할 명령 표시) | The harness is removed, but harness files are still staged. Run git restore --staged with these paths in a terminal. (Paths and a copyable command follow.) |
| Result: check failed | 하네스를 되돌렸지만 커밋 대기 목록은 확인하지 못했습니다. 터미널에서 git status로 확인하세요. | The harness is removed, but the staged files could not be checked. Run git status in a terminal. |

### Consequences

- Users can remove the harness without the CLI, the database path or the task
  ID.
- Measurement and restoration stay separate, so review fixes with the harness
  remain possible after measurement.
- The UI gains a file-changing action. The digest binding, conflict block and
  stop acknowledgement keep it as explicit as the CLI.
- Section 7 of the runbook and the Korean runbook describe the UI flow first and
  the CLI second.
- The card state is read from the database only, so task polling never hashes
  workspace files. If the user already reverted the files by hand, the card still
  appears and restoration completes with only unchanged files.

## Validation boundary

Synthetic tests establish API, assignment, file integrity, privacy and lifecycle
behavior. Actual native opening, project adaptation, script execution, permissions
and fresh working-session loading require separately authorized human/native
acceptance for each product. Historical managed-runner tests are not evidence for
this design. See [the user flow](../runbooks/harness-config.md#6-agent-application-format-2).
