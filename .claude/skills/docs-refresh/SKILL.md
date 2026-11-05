---
name: docs-refresh
description: Use when asked to refresh, update, sync or audit this repository's documentation (runbooks, README, CONTRIBUTING and their Korean translations) against the current source, tests and examples. Development-only maintenance; not a product harness skill, and not for writing new requirements or decisions.
---

# Refresh repository documentation

Development-only procedure for this checkout. `AGENTS.md`, `CONTRIBUTING.md` and
`docs/development/workflow.md` still apply; this skill adds the documentation steps.
The canonical copy lives in `.claude/skills/docs-refresh`; `.agents/skills/docs-refresh`
is a symlink to it. Edit the canonical copy only.

## 1. Fix the scope

1. Record the branch, `git rev-parse HEAD` and `git status --short`. Uncommitted
   changes you did not make belong to someone else; leave them untouched.
2. If source files that affect the documents in scope have uncommitted changes,
   ask whether to document `HEAD` or the working tree. Do not guess.
3. Default scope when the request names none: `docs/runbooks/`, `README.md` and
   `CONTRIBUTING.md`.
4. Change these only on explicit request:
   - `docs/requirements.md`: a requirement change needs its own decision.
   - `docs/decisions/` and `docs/validation/`: dated evidence. Never rewrite a
     record to match newer behavior.
   - Product skill packages under `skills/`.
5. When resuming, read `.harness-delta/work/<work-id>/status.md` and reconcile it
   with the tree.

## 2. Find the drift

1. For each document, list what changed since it was last edited:

   ```sh
   since=$(git log -1 --format=%H -- docs/runbooks/workflow-quickstart.md)
   git diff --stat "$since"..HEAD -- src scripts skills examples ui/src package.json
   ```

2. Check each kind of claim against its source. This table is a starting point;
   grep the source for every identifier, version and option you keep or write.

   | Claim in the document | Check against |
   | --- | --- |
   | CLI commands, options, exit and error codes | `src/cli.ts`, `src/cli/*-cli.ts`, `src/cli/local-web-main.ts`, `src/cli/cli-errors.ts`, `scripts/hm.mjs` |
   | Exact supported versions and profile IDs | `src/adapter-profiles.ts`, `src/codex-admissions.json`, `src/readiness.ts`, `src/claude-workflow-versions.ts` |
   | Conditional version windows | `src/source-compatibility.ts` |
   | Ordinary-session pilot profiles and family limits | `src/session-binding-human-pilot.ts`, `src/session-binding-claude-human-pilot.ts`, `src/session-binding-claude.ts` |
   | npm scripts, Node range, CI | `package.json`, `.nvmrc`, `.github/workflows/ci.yml` |
   | Example inputs | `examples/workflow/`, `tests/workflow-examples.test.ts` |
   | Price catalog statements | `src/price-catalog*.ts`, `src/pricing/price-catalog*.ts`, `src/cli/price-catalog-cli.ts`, `docs/development/price-catalog-releases.md` |

3. For a wide scope, give a separate read-only agent the documents you are not
   reading yourself. Ask for confirmed mismatches only, each with the document
   line and the source evidence.
4. Write the findings list before editing: document location, current text and
   source evidence. "No confirmed mismatch" is a valid result. Do not edit a
   document that is already correct.

## 3. Edit

- Make the smallest change that makes the document true. Do not add files or
  restructure sections unless asked.
- Support wording must not exceed the evidence. Keep these states distinct:
  verified exact admission, `compatibility_unverified` reuse, candidate pilot,
  synthetic-only validation, unsupported. Configured, installed or
  synthetic-tested does not mean supported.
- Keep observed zero, missing, error, excluded and unmeasurable distinct, and
  partial amounts separate from complete totals.
- Do not add prompt, response or source-code content, secrets, real session
  data, personal paths, private task IDs or anything from `.harness-delta/`.
  Examples stay synthetic.
- Write documents in English. Update each `*.ko.md` in the same change as its
  English file: same section order, identical fenced blocks, same identifiers,
  warnings and support limits. In a Korean file, link to the `.ko.md` target and
  its Korean heading anchor when that translation exists.
- Do not invent command output, test results or dates. Run the command, or copy
  the value from a test that asserts it.
- If the fix would change requirements, collection scope or a public contract,
  stop and ask.
- Price documentation follows `docs/development/price-catalog-releases.md`.

## 4. Verify

Run both commands from the repository root. `<skill-dir>` is this skill's directory.

```sh
node <skill-dir>/scripts/check-docs.mjs
git diff --check
```

The check reads every Markdown file that Git does not ignore. A `PROBLEM` line
(exit 1) is a missing link target, a target Git does not list, a missing heading
anchor, a link that leaves the repository, or an English/Korean pair whose heading
structure or fenced blocks differ. A `NOTE` line is a Korean page that links to an English
page although a translation exists; fix it unless the English target is intended.
Pass paths to limit the files checked; a path that selects no Markdown file
exits 2. Report a problem outside your scope; do not fix it silently.

- If examples or documented schemas changed, select Node 24 and run
  `npm run build`, then `npm test -- tests/workflow-examples.test.ts`.
  A documentation-only change does not need `npm run check`.
- If Node 24 is not available, do not install a runtime. Report the test as not run.
- Read the final diff against the findings list. Every finding is resolved or
  explicitly deferred, and nothing else changed.

## 5. Review and hand off

1. Request a read-only review from a separate agent. Give it the findings list,
   the complete scoped diff including uncommitted files, and the check output.
   Without a reviewer, record `review-pending`; self-review does not replace it.
2. Resolve material findings, then run the check again.
3. Update `.harness-delta/work/<work-id>/status.md` with the template in
   `docs/development/workflow.md`. Never stage that directory.
4. Report the changed files, each finding with its evidence, the check results,
   what was not verified and the review result.
5. Do not commit or push unless asked. When asked, use a `docs/<kebab-case>`
   branch and a `docs: <imperative summary>` message.
