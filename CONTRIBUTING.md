# Contributing

Harness Delta has metadata contracts and a local storage foundation. Read the
[product requirements](docs/requirements.md) before proposing or implementing behavior.
For the current exact routes, profiles and qualification states, use the
[generated support matrix](docs/support-matrix.md). Follow [Harness Connect](docs/runbooks/harness-connect.md)
for connection procedures and [native workflow](docs/runbooks/task-native-workflow.md)
for launch and child-operation limits. Ordinary observations remain partial;
reviewed instrumented-source completeness does not promote other routes.

## Development environment

Use Node.js 24 or 26 and npm. With nvm, the `.nvmrc` default remains Node 24:

```sh
nvm install
nvm use
npm ci
npm run check
```

To select Node 26 instead, run `nvm install 26` and `nvm use 26` before installing.
Other version managers are welcome; select Node 24 or 26 before installing. The lockfile
pins dependencies. SQLite may require native build tools if no matching binary is
available. Local validation has covered macOS arm64; other platforms are unverified.
After switching Node majors, run `npm ci` again so SQLite uses the selected runtime's
native ABI. Use that same runtime to build and run the CLI.
Actual native qualification commands and the pinned
Codex direct-child workflow retain their Node 24 requirement. Node 26 synthetic
fixture checks do not extend native source qualification.
Existing root workflow orchestration also accepts Node 26, including Claude's
supervisor. This runtime extension is covered by synthetic fixtures, not an
additional native qualification. Each actual launch still requires its separate
approval and the existing product/version/source gates.

`npm run check` checks the Git index for local records, verifies formatting, runs ESLint and TypeScript
checking, builds the package, and executes tests. Run it from a Git checkout.
Build before focused tests with `npm run build`, then use
`npm test -- tests/runtime.test.ts`. Binding qualification tests freeze the built
UI as well as source bytes, so a clean checkout needs the build first.

The process-budget group runs sequentially before other test files. It includes
owned CLI budgets, ordinary binding qualification, Codex workflow adapter/child
fixtures and the minimal diagnostic runner. Concurrent process-heavy suites can
consume their fixed startup or teardown budgets on CI hosts. Timing, ownership
and disappearance assertions remain unchanged. All remaining suites then run
with normal file parallelism. The default test command includes both groups.

## Linting

Run `npm run lint` to check TypeScript source, tests, and configuration, plus
JavaScript configuration and scripts. `eslint.config.js` uses the recommended
ESLint rules and type-aware typescript-eslint rules for TypeScript, including
unhandled promises and unsafe type usage. Type-aware linting uses `tsconfig.json`;
include new TypeScript directories there when adding them.

Run `npm run lint:fix` to apply supported automatic fixes, then inspect the diff.
Normal checks never apply fixes. Warnings fail the lint command. Generated output,
dependencies, private `.harness-delta/` records, and locally installed
`.agents/skills/` packages are excluded. Skill packages are not part of the project
TypeScript program; validate them with their own tooling. Linting and formatting
are separate checks; neither check stages files or applies fixes.

Run `npm run format` to apply Prettier, then inspect the diff. Run
`npm run format:check` for the read-only check used by `npm run check` and the
pre-commit hook. `.prettierrc.json` uses two spaces, a 160-column target,
single quotes by default, semicolons, no trailing commas, and optional arrow
parameter parentheses. Existing double-quote-only files retain that style.
Property quotes and embedded fixture text are preserved.

Source TypeScript, including reviewed pinned modules, follows Prettier. Keep the
explicit `.prettierignore` exclusions for evidence data and operation inputs,
scripts, skills, documentation, fixtures, generated output, and vendored UI
components. Pinned source changes still require an approved digest re-issue; do
not update evidence hashes merely to make a formatter pass. Formatting-only
revisions are recorded in
`.git-blame-ignore-revs`; use `git blame --ignore-revs-file .git-blame-ignore-revs`
when inspecting logic history.

Root and UI ESLint configurations enforce a 150-line function budget, excluding
blank and comment-only lines. Existing per-file exceptions ratchet at their
current values, like complexity limits; lower them as functions shrink. New files
use the default limits. Vendored UI components retain their existing exemption.

TypeScript is pinned to a 6.0 release compatible with the installed typescript-eslint
peer range. Upgrade both together when newer compiler support is available; do not
bypass incompatible peer dependencies with force-install flags.

## Git hooks

`npm ci` or `npm install` runs `prepare` to install Husky for this checkout.
The pre-commit hook rejects indexed local records, checks formatting, runs lint and type checks,
then runs Vitest tests related to staged files. Before any test run it rebuilds
the package and UI, including for test-only changes, because focused tests may
spawn built output or freeze UI bytes. Root and `docs/` Markdown-only changes
skip the build and tests; no related tests is also a successful result.
Source changes additionally select tests and helpers that use filesystem reads,
subprocesses, or built-output paths, whose dependencies the import graph can miss.
Deletions and global or opaque inputs (including scripts, test helpers, UI,
configuration, manifests, and assets) conservatively run the full suite instead.
A failed command stops the commit. Generated Husky
files under `.husky/_/` are ignored; `.husky/pre-commit` and `.husky/commit-msg`
are shared in Git. The commit-msg hook validates the proposed message with commitlint.

Select Node 24 or 26 before committing. GUI Git clients must also have the selected Node version and npm
on their PATH; see [Husky's version-manager guidance](https://typicode.github.io/husky/how-to.html#node-version-managers-and-guis).
Run `npm run prepare` to reinstall hooks if needed. No global configuration is changed.

Checks run against the working tree; the privacy guard checks the Git index.
With partially staged changes, also inspect the staged diff because the tested
working tree can differ from the commit. Hooks do not stage or modify source files.
They do not enforce commit-message language or replace independent review.
Implementation changes still require the full `npm run check` before completion;
a successful related run is not that completion gate. CI disables hook installation
with `HUSKY=0` and runs the full checks explicitly, on Node 24 only, not Node 26.
Hooks can be bypassed locally, so CI and independent review remain required
verification layers; a passing hook is not proof that the staged snapshot passed.

## Changes and review

- State the problem, intended behavior, scope, and acceptance criteria first.
- Link public requirement IDs, issues, or public design decisions. A personal plan
  must not be the only explanation for shipped behavior.
- Add meaningful tests for behavior changes, including failure and boundary cases.
  For bug fixes, demonstrate the failure before applying the fix.
- Keep fixtures synthetic. Do not attach real session logs or personal paths.
- Run relevant checks, then report actual results and unverified behavior.
- Use the [agent workflow](docs/development/workflow.md) when working with an agent.
  Agent-assisted tasks require independent agent review. Manual contributions can
  use normal maintainer review without an AI account, plugin, or subscription.

## Task comparison workflow

The [task comparison runbook](docs/runbooks/task-comparison.md) describes the
synthetic-only workflow and assignment reports. Configuration registration, durable assignment and
manual application evidence do not enable real experiments or inference.
Explicit synthetic [file exchange and frozen team reports](docs/runbooks/team-file-exchange.md)
use a separate strict sharing boundary with static writer mappings and conservative
deletion. They do not enable live experiments or prove team completeness.
See [ADR 008](docs/decisions/008-task-comparison-workflow.md) for contracts and limits.

## File adapter profiles

Use the [generated support matrix](docs/support-matrix.md) for current versions,
route status, profile IDs and qualification flags. Its legend distinguishes exact
registration/admission, candidates, retirement and conditional parser reuse.
Operational connection and pilot limits live in [Harness Connect](docs/runbooks/harness-connect.md).

Add or admit a version through the [admission workflow](docs/runbooks/codex-version-admission.md)
and the [forward-version compatibility policy](docs/decisions/013-forward-version-compatibility.md).
Registered file adapters live in `src/adapter-profiles.ts`; the code-owned registry
is `src/core/tool-version-profiles.json`. Verified registration is an exact
`(product, version)` allowlist. Conditional parser selection is separate and does
not grant ordinary binding admission. Runtime windows live in
`src/source-compatibility.ts`; keep unverified estimates separate and invalidate
incompatible data. Exact profiles remain the evidence boundary for verified support.

A new version whose semantics are unchanged is data, fixtures and evidence.
A semantic change is a named code variant plus tests; never edit the old variant
to fit the new version. Review the operation/topology scope, target-binary
conformance and native qualification separately before claiming stronger support.
An ordinary admission never promotes file/workflow sources or historical observations.

After an approved registry edit, run `node scripts/generate-tool-version-assets.mjs`
and include both support-matrix translations with the generated assets.
`node scripts/generate-tool-version-assets.mjs --check` rejects stale output and
is part of `npm run check`. Do not hand-edit generated support claims.

The conformance runner is manual. `npm test` runs offline synthetic unit tests of
the report projector, candidate parser and confirmation helpers; it does not run
the conformance runner, spawn product CLIs or open real sessions. Historical
reports do not qualify the current source identity or whole-task completeness.
See [ADR 007](docs/decisions/007-adapter-version-profiles.md).

## Branch names

Name work branches `<type>/<kebab-case-description>`. Choose a type that describes
the work: `build`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`, `refactor`, `revert`,
`style`, or `test`. Use a concise English description made of lowercase letters
and digits, with single hyphens between words. Use exactly one slash; do not use
spaces, underscores, uppercase letters, or tool-specific prefixes such as `codex/`.

```text
feat/session-tracking
fix/duplicate-events
chore/project-setup
docs/contribution-guide
```

The default branch `main` is exempt. Apply this convention when creating or
explicitly renaming a work branch. Do not automatically rename existing branches
or recreate branches for detached checkouts. If a requested name already exists,
do not overwrite it; resolve the name with the user.

This is a contributor and agent instruction, not a Husky or CI validation rule.
Commit-message validation remains separate.

## Language and commits

Write developer documentation, code comments, new local records, commit messages, and PR text
in English. User task/cost procedures also have synchronized Korean versions.
Update each pair together: preserve section order, command blocks, JSON identifiers,
expected results, warnings and support limits. Keep CLI identifiers untranslated.
Use the quickstart glossary for shared terms. Write short commands to the reader,
with one action per step; separate prerequisites and expected results from actions.
This is STE-inspired editing, not a claim of ASD-STE100 compliance or certification.
No translation framework or automatic translation is required.

Use `<type>: <imperative summary>` with an optional scope, for example:

```text
chore: add the development harness
fix(store): reject conflicting events
docs: clarify collection boundaries
```

The commit-msg hook uses `@commitlint/config-conventional` from
`commitlint.config.js`. Allowed types are `build`, `chore`, `ci`, `docs`, `feat`,
`fix`, `perf`, `refactor`, `revert`, `style`, and `test`. Use a lowercase type,
an optional `(scope)`, a colon followed by a space, and a nonempty summary.
Keep the header at most 100 characters and omit its trailing period. The preset
also checks subject case and conventional body/footer formatting. Breaking changes
may use `!`, for example `feat(api)!: change the response format`.

Messages such as `update stuff`, `foo: add a feature`, and `fix:` are rejected.
Commitlint's standard ignores remain enabled for generated merge/revert, version,
and autosquash messages. English wording and imperative grammar remain review rules;
the hook checks structure, not natural-language correctness.

To validate a message file manually:

```sh
npm run commitlint -- --edit path/to/message.txt
```

This is local message validation; the current CI checks code but does not lint
commit history. Local hooks can be bypassed.

Describe the change without private task IDs, user paths, or session history.
Do not include unrelated working-tree changes in your commit.

## Public and local information

Public source, requirements, durable architecture decisions, tests, contributor
guidance, and CI belong in Git. Personal plans, work status, detailed reviews,
temporary evidence, and original private design material belong under
`.harness-delta/`, which is ignored. Never force-add it.

Before submitting, run `npm run check:privacy` after staging to check the actual
index, and inspect `git diff --cached`. This guard only detects the local directory
in the index; review other files for accidentally copied private content as well.
Ignored records are not backed up, encrypted, or synchronized by Git. A new clone
or worktree must reconstruct context or receive an explicitly selected handoff.

## CI

Pull requests and pushes to `main` run four independent Node 24 jobs on macOS:
static checks (privacy, lint, types) and process-budget tests each have a
15-minute timeout; default tests run in two shards, each with a 25-minute timeout.
All four start independently; a failed job does not cancel its siblings.
Each test job runs `npm ci` and `npm run build` on its own
runner before selecting its Vitest project. No `dist/`, UI assets or installed
dependencies are shared between jobs. The existing npm download cache is retained.
Process-budget file serialization is unchanged. Local `npm run check` still runs
all phases and both test projects sequentially as described above.

To run the test phases exactly as CI does, after installing and building:

```sh
HUSKY=0 node scripts/ci-phase.mjs process-budget tests npm test -- --project process-budget --reporter ./scripts/ci-reporter.mjs
HUSKY=0 node scripts/ci-phase.mjs default tests npm test -- --project default --shard 1/2 --reporter ./scripts/ci-reporter.mjs
HUSKY=0 node scripts/ci-phase.mjs default tests npm test -- --project default --shard 2/2 --reporter ./scripts/ci-reporter.mjs
```

Each job uploads only its explicit phase/result JSONL files from the ignored
`.harness-delta/ci-results/<job>/` directory, including after failure when possible.
The default shards upload separate `ci-default-1` and `ci-default-2` artifacts;
their result paths stay the same because each shard has its own runner.
Phase starts and completions record statuses, durations, exit codes and runner
Node/platform/architecture. The CI-only reporter appends test identities, statuses
and durations plus file/run statuses. It omits assertion messages, source snippets,
console output, response bodies and arbitrary metadata. A failed result still
fails the job. The reporter replaces Vitest's normal diagnostic output in these
CI test commands; use a normal focused `npm test -- <file>` locally for diagnostics
with synthetic fixtures. Partial records are not complete test totals. Cancellation
or runner loss can prevent completion records or artifact upload entirely.

The workflow needs
no private plans, session data, or agent credentials. It does not perform agent
review or prove requirement completeness. Adding the workflow does not configure
branch protection or mean a remote run has passed.

## Offline comparison method study

The [comparison analysis validation runbook](docs/runbooks/comparison-analysis-validation.md)
reproduces the bounded synthetic study with `npm run analysis:validate`. Its exact
oracle checks are separate from full R10 validation and real experiment readiness.

## Offline statistical validation

Use the [analysis validation runbook](docs/runbooks/comparison-analysis-validation.md)
for the separate `npm run analysis:validate` sharp-null arithmetic study and
`npm run analysis:validate:confidence` bounded mean-effect/deadline-quality study.
Both are synthetic development commands under Node 24 or 26. Full confidence calibration
is opt-in, outside normal unit tests. Neither enables production inference or real
experiments; preserve the fixed registries, failures and historical evidence.

## Tool update discovery

The [tool update pipeline guide](docs/development/tool-update-pipeline.md)
([한국어](docs/development/tool-update-pipeline.ko.md)) covers maintainer-only
release discovery and static assessment. Its records aren't support or admission.
Changes to the workflow/binding scope files listed in
`scripts/tool-update/lanes.mjs` require a fresh operation/topology review and
matching scope digests. Tests fail closed on drift; do not update the hashes
without reviewing the rules they protect.
Ordinary root-window policy lanes are implemented for offline acceptance,
ordinary-window collection disabled pending separate product activation and native
acceptance; see [ADR 013](docs/decisions/013-forward-version-compatibility.md#implemented-windows-and-evidence)
and [local measurement](docs/runbooks/local-measurement.md#versions-conformance-and-update-controls).

## Observed-cost verification

Starting with catalog v3, every price release follows the
[price release checklist](docs/development/price-catalog-releases.md). A rate file alone
does not establish support for its model, component or billing condition.

User instructions are in the [cost guide](docs/runbooks/observed-cost.md)
([한국어](docs/runbooks/observed-cost.ko.md)). From a Node 24 or 26 checkout:

```sh
npm test -- tests/pricing/observed-cost.test.ts tests/pricing/observed-cost-cli.test.ts tests/pricing/pricing.test.ts tests/pricing/task-cost.test.ts
```

These synthetic checks establish arithmetic and reporting behavior, not whole-task
source coverage or real experiment effectiveness. Workflow example schemas are
covered by `tests/workflow-examples.test.ts`; contract/store boundaries use
`tests/contracts.test.ts` and `tests/store.test.ts`. Documentation-only edits need
link/anchor, example/schema and bilingual command/support checks. Use the general
implementation workflow and `npm run check` when product behavior changes.
