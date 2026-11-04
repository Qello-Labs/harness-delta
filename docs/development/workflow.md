# Agent Development Workflow

Use [AGENTS.md](../../AGENTS.md) as the single shared entry point. The workflow is
tool-neutral and does not require a personal plugin. The human contribution path
is described in [CONTRIBUTING.md](../../CONTRIBUTING.md).

## Start or resume

Identify the approved work item, scope, stopping point, requirements, prerequisites,
branch, base commit, and existing working-tree changes. Read only the relevant
public requirements and local records; do not reload every past plan or conversation.

When creating or explicitly renaming a work branch, follow the
[branch naming convention](../../CONTRIBUTING.md#branch-names):
`<type>/<kebab-case-description>`, such as `chore/project-setup`. Use the work type,
not the agent tool name. Preserve existing branch names unless a rename is requested.

Use `.harness-delta/work/<work-id>/` for local status, acceptance evidence, decisions,
and reviews. One writer owns each work item. Use separate IDs for independent work
and integrate shared contracts, CLI files, and migrations sequentially.

If local records are absent, use the user request, public requirements, issues/PRs,
Git history, code, and tests. Do not assume a missing task is complete. If several
work items match, ask which to resume. Reconcile stale notes with the current tree.

Local records do not travel with clones or new worktrees. Deliberately transfer only
the required sanitized handoff or reconstruct it. Never copy all private records
into a public PR as a substitute for a public requirements summary.

## Implement and verify

1. Before implementation, map acceptance criteria to public references and planned
   evidence. Include failure paths and privacy/contract boundaries where relevant.
2. Work within the approved scope. Record routine implementation decisions and
   rationale locally. Confirm requirements, collection-scope, or public-contract
   changes before implementing them; promote approved durable decisions publicly.
3. Add meaningful behavioral tests and run focused checks. Reproduce bugs before
   fixing them. Feasibility work can use controlled observations and documented
   source evidence; documentation changes need link and consistency checks.
4. Run `npm run check` for implementation changes and record actual results,
   command, time, and tested revision or working-tree state. The existing runtime
   probes do not prove product acceptance. Distinguish local and remote results.

After dependency installation, Husky runs the privacy guard, formatting check, lint, type checks,
and Vitest tests related to staged files before local commits. It builds the
package and UI before tests, even for test-only changes, to refresh subprocess
entry points and frozen UI inputs. Root and `docs/` Markdown-only changes skip
build and tests; no related tests passes. Source changes also select filesystem
and subprocess test consumers that import analysis misses. Deletions and global
or opaque inputs, including scripts, test helpers, UI, configuration, manifests,
and assets, fall back to the full suite.
The commit-msg hook validates the proposed message with commitlint.
Checks use the working tree; only the privacy guard and changed-path selection
read the Git index. Inspect partial staging separately: hooks do not stage files,
and the tested working tree can differ from the commit. Hooks can be bypassed.
CI runs the full gate explicitly with hooks disabled and covers Node 24 only,
not Node 26. The full `npm run check` remains required for implementation
completion. A successful hook does not replace that check, independent review,
or handoff records.

Acceptance table:

| Criterion | Public reference | Evidence | Status |
| --- | --- | --- | --- |
| Describe an observable outcome | Requirement ID or issue | Test/observation and result | Pending/pass/fail |

## Independent review

Request a separate agent review for every implementation task. Give the reviewer
the requirements, acceptance table, base/current revision, complete scoped diff
(including new and uncommitted files), and verification evidence. A commit-only
diff is insufficient when the implementation is still uncommitted.

The reviewer checks requirement coverage, unintended behavior, invariants, and
test adequacy without modifying implementation files. Record actionable findings
with severity and evidence. The reviewer need not use a different model or vendor.
An unavailable reviewer leaves the task `review-pending`; self-review does not
silently replace the agreed independent review.

Resolve material findings and verify fixes. Request a focused follow-up review if
a fix changes behavior beyond the reviewed scope. Avoid repeatedly reviewing
unchanged code. Record deferred minor findings and their impact in the handoff and
final report. Preserve the review outcome and dispositions under `reviews/` locally.

## Completion and handoff

Complete a task only when all acceptance criteria have evidence, relevant checks
pass, independent review is complete, and material findings are resolved. Pending
or failed required remote CI keeps merge readiness unverified; a workflow file
alone does not prove a remote run. Report setup implemented and validation pending
separately when external checks cannot run.

Update status at task boundaries, material decisions, before tool/session switches,
and when stopping. Store detailed outputs only when useful and sanitized. Keep one
current status summary and a separate decision history, rather than growing a chat log.
Record interrupted work as partial. Never continue beyond the approved stopping point.

Copy this template into the local work directory:

```markdown
# Work Status

- Work ID:
- Branch and observed HEAD:
- Approved scope and stopping point:
- Public requirement references:
- Active task and status: not-started / in-progress / review-pending / blocked / complete
- Completed criteria and evidence references:
- Current changes, including uncommitted work:
- Verification: command, result, tested revision/worktree state, and time
- Independent review: reviewer, reviewed scope, findings, and dispositions
- Unverified assumptions and pending decisions:
- Next concrete action:
```

## Verify instruction discovery

Start a fresh session in this repository with each tool and ask it to summarize
its loaded repository rules without reading files or changing anything. Confirm
it identifies the English artifact policy, local record directory, independent
review, and stopping rules. If tool settings suppress repository instructions,
report that limitation; do not silently modify global settings or add a second file.

Codex documents [AGENTS.md discovery](https://learn.chatgpt.com/docs/agent-configuration/agents-md).
Claude Code documents [AGENTS.md support and loading conditions](https://code.claude.com/docs/en/memory).
Use a version/configuration that loads AGENTS.md directly. File presence alone is
not a loading test. A pre-existing ancestor CLAUDE.md or instruction setting may
change Claude Code discovery; report an observed conflict rather than duplicating rules.
