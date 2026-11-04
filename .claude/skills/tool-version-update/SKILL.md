---
name: tool-version-update
description: Update or audit Harness Delta support for newer Codex CLI or Claude Code releases. Use for latest-version support, candidate allowlist updates, compatibility-window changes or exact-version qualification. Verify upstream format, counter and execution changes before editing support declarations. Development-only; not a global tool updater or a measurement skill.
---

# Update native tool version support

Maintain this repository's Codex CLI and Claude Code integrations. Follow
[AGENTS.md](../../../AGENTS.md), [CONTRIBUTING.md](../../../CONTRIBUTING.md) and the
[development workflow](../../../docs/development/workflow.md).
An audit request is read-only; a support-update request authorizes the scoped
repository work, not a native model call, global installation or publication.

This is the canonical procedure. The Codex entry in `.agents/skills/tool-version-update`
loads this file. Resolve links from this directory, not the Codex entry.

## 1. Establish scope and current evidence

1. Record branch, HEAD and existing dirty/untracked files. Preserve unrelated
   changes, including another agent's skill work. Read a selected local work record
   only when its ID is known. Store new detailed evidence under `.harness-delta/`.
2. Confirm the requested product, target release and routes: file collection,
   tool-owned launch workflow, ordinary human pilot, or verified exact admission.
   Do not assume supporting one route supports another.
3. Read R01, R02, R04, R05 and R09 in the
   [requirements](../../../docs/requirements.md) and
   [ADR 013](../../../docs/decisions/013-forward-version-compatibility.md).
4. Inspect the actual code-owned declarations:

   | Contract | Files |
   | --- | --- |
   | Finite file and workflow windows; parser lineage | `src/source-compatibility.ts` |
   | Exact file admissions | `src/adapter-profiles.ts`, `src/codex-admissions.json` |
   | Exact workflow evidence and Claude retirement | `src/readiness.ts`, `src/claude-workflow-versions.ts` |
   | Codex ordinary root candidates and receipt producer | `src/session-binding-codex.ts`, `scripts/session-binding-codex-hook.mjs` |
   | Ordinary task authority and topology | `src/session-binding-human-pilot.ts`, `src/session-binding-claude-human-pilot.ts` |
   | Claude ordinary candidates and source semantics | `src/session-binding-claude.ts` |
   | UI route display and provider construction | `src/local-web-domain.ts` |

5. Obtain the newest regular release from the official GitHub release and npm
   package metadata; record checked UTC date, exact tag/commit and URLs.
   Codex: `openai/codex` releases and `@openai/codex`.
   Claude: `anthropics/claude-code` changelog and `@anthropic-ai/claude-code`.
   Reconcile disagreement; exclude prereleases and build suffixes. Probe installed
   `codex --version` / `claude --version` separately. Do not upgrade either tool.
   An installed version and a previously remembered "latest" are not release evidence.
6. Map acceptance to evidence before editing. Keep exact verified support,
   `compatibility_unverified`, ordinary candidate pilots and unsupported routes
   separate. A new ordinary candidate needs its own exact declaration even when
   the file/workflow version lies inside a conditional window.

## 2. Verify what actually changed on every update

Read the [verification checklist](references/verification.md) before editing.
Compare the target with both the previous reviewed release and the verified base
parser/profile for each requested route. Read every intervening release note.
Then inspect version-pinned implementation/schema changes on the consumed surface;
a quiet changelog or a patch version is not evidence of unchanged semantics.

For Codex, compare official tagged source/schema and hook/CLI contracts, citing
commit IDs and affected paths. For Claude, do not assume the implementation is
public: compare available versioned official docs/schema and executable behavior.
If a pinned source is unavailable, label it `unknown`, not `unchanged`, and use
the bounded runtime comparison described in the checklist when authorized.

Record each consumed contract as `unchanged`, `changed` or `unknown`, with its
evidence and effect on the existing parser. Separate upstream changes from their
impact: an unrelated TUI fix does not establish stable token semantics.

### Mandatory deeper-verification gate

Derive the gate anew from each route's current `upper_exclusive` in
`src/source-compatibility.ts`; do not turn this skill's examples into new policy.
At creation, the conditional upper bounds are Codex **0.164.0** and Claude Code
**2.2.0**. Equality is outside the window. An exact reviewed admission, if present,
is separate evidence; it does not automatically extend the conditional window.

Require pinned upstream comparison **and actual target-binary conformance**
before extending support when any of these holds:

- Target is at or above the selected source/profile's upper bound, or no applicable
  source-specific window exists.
- Major/minor changes from the last reviewed release, including every Codex `0.x`
  minor transition even if it is still inside a conditional window.
- Release notes, source comparison or runtime evidence identify a change or an
  unresolved uncertainty in a consumed field/counter, hook, identity, permissions,
  invocation, export/flush, compaction, resume, topology or termination contract.
- A version is blocked, a required parser contract fails, or verified exact
  admission/retirement is requested.

Actual binary conformance may use an isolated localhost synthetic API when it
proves the affected contract; use the approved native/backend trial when that
contract cannot be established offline. Neither a fake executable, a parser
accepting synthetic rows, `--version`, nor successful parsing alone passes this
gate. Missing authority, unavailable binary or insufficient observations leaves
the affected route unsupported/blocked or candidate-only as applicable; report
the remaining gate. Never widen an upper bound just to make a version fit.

## 3. Implement only the evidenced change

1. Finish the independent offline work first. If a new window, collection scope,
   public contract, native trial or exact promotion needs a user decision, present
   the concrete diff/proposal and evidence before taking that action.
2. If existing file/workflow windows already cover the target, keep the existing
   parser and `compatibility_unverified` provenance unless evidence requires a
   repair. Add only the independently reviewed exact ordinary candidate needed
   for the requested route. Preserve default provider refusal and pilot authority.
3. Unchanged semantics use candidate data, synthetic fixtures and evidence.
   Changed semantics require a named parser/profile variant and regressions.
   Do not alter a historical variant to fit the new release or relax required
   fields, closed enums, counter/subset checks, replay or topology fences.
4. Preserve the actual product version in receipts, sessions, observations and
   reports. File reuse does not authorize launch. Ordinary authority does not
   establish production admission. Preserve executable SHA/version checks,
   immutable parser/rule pins, separate unverified totals and durable invalidation.
5. Keep no-backfill baselines, paused/offline exclusions, existing task/assignment
   and price pins, and frozen experiments' exact versions. Do not promote old
   observations, silently unblock a cohort or discover unrelated session files.
6. Update affected EN/KO runbooks together, plus contributor guidance where needed.
   Preserve historical validation records and published anchors. State unsupported
   operations/models explicitly. Pricing changes are findings, not an automatic
   catalog release; use the separate
   [price release checklist](../../../docs/development/price-catalog-releases.md).

## 4. Validate the requested routes

Select Node 24, build, then run the relevant existing suites. Typical selection:

```sh
npm run build
npm test -- tests/source-compatibility.test.ts tests/cli/source-compatibility-cli.test.ts tests/native-forward-compatibility.test.ts tests/session-binding-codex.test.ts tests/session-binding-claude.test.ts tests/session-binding-application-pilot.test.ts tests/local-web-root-application-pilot.test.ts tests/claude-human-pilot.test.ts tests/local-web-domain.test.ts
npm run check
```

Add the requested adapter/admission/receipt/runtime suites named in the checklist;
this selection is not proof of an untested route. Read nearby tests before editing.
Use deterministic synthetic fixtures, not native logs or timing-based waits.
Reproduce a reported rejection/failure before fixing it. Do not pin prose with tests.
Run implementation checks once; repeat only for a new change or unresolved failure.
For a skill/document-only edit, validate structure, links and examples instead.

Exercise the built metadata-only CLI for the actual target version and each
selected source. Use an in-memory database rather than an existing user's DB:

```sh
node dist/cli.js --db :memory: compatibility status
node dist/cli.js --db :memory: compatibility inspect --product codex --version "$CODEX_VERSION" --source file
node dist/cli.js --db :memory: compatibility inspect --product claude_code --version "$CLAUDE_VERSION" --source claude_workflow
```

Set the variables to the independently verified targets. Substitute the requested
source (`file`, `codex_workflow` or `claude_workflow`), not an unrelated route.
Inspect actual version, applied parser/profile, trust and unsupported/blocked
status. Do not treat a successful inspect as native conformance. If UI behavior
changes, exercise the real UI with isolated synthetic data as well.

## 5. Review and stop

Obtain one independent review of the full scoped diff, acceptance mapping,
upstream comparison and actual verification evidence. Resolve material findings.
Without a reviewer, keep `review-pending`. Update the ignored local handoff.

Report target and base versions, route/topology, gate classification, actual
changed/unchanged/unknown contracts, trust, tests and runtime observations, review,
and any missing authorization/evidence. Distinguish synthetic tests, actual-binary
offline probes, approved native trials and remote CI. Do not call incomplete
qualification verified support. Stop at the approved scope; no commit, push,
publication, global update or additional native trial is implicit.

## Installation and invocation

These project-local files work from this checkout; no copy or global settings edit
is needed. In Codex, select `$tool-version-update` (or find it with `/skills`).
In Claude Code, invoke `/tool-version-update`. Supply the product/target or ask
for the latest stable support update. Both tools use this canonical procedure.

If it does not appear, start a fresh session in this repository and inspect the
skill list. Confirm the project is trusted and that a personal/plugin skill with
the same name is not taking precedence. File presence proves structure, not
observed native discovery or model compliance. The skill does not install hooks
or start measurement. Official discovery references:
[Codex skills](https://learn.chatgpt.com/docs/build-skills) and
[Claude skills](https://code.claude.com/docs/en/skills).
