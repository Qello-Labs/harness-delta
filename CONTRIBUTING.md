# Contributing

Harness Delta has metadata contracts and a local storage foundation. Read the
[product requirements](docs/requirements.md) before proposing or implementing behavior.
The repository provides a local measurement CLI, legacy partial sequential adapters
for Codex CLI 0.156.1/0.158.0 and Claude Code 2.1.283, and two separately admitted
Codex 0.160.0 workflow profiles: root own responses and a fresh root with one fresh
direct child. The child profile is read-only; family resume and broader descendant
collection are unsupported. Assigned CLI wiring has synthetic coverage and later bounded actual root
functional observations; exact admission and configuration-scope limits are separate evidence. Claude Code 2.1.296 has two separately admitted
profiles (2.1.288 and 2.1.291 are retired): a parent-only profile covering launch and resume of a kept session, and a
read-only profile with one direct child. Deeper or additional Claude children and child resume are unsupported.
Ordinary file, binding and workflow usage remains partial, with no inferential
adoption support. The separately qualified instrumented
Codex source can establish standardized complete cost under its reviewed profile;
see the [observed-cost runbook](docs/runbooks/observed-cost.md). It does not turn
ordinary file, binding or workflow observations into complete totals or vendor bills.

Codex 0.162.1 bounded ordinary collection passed fresh ordinary-route native
acceptance and independent review on 2026-10-13: one fresh CLI root and up to two
fresh direct children, gpt-6.1-sol/high, under the reviewed read-only/no-daemon
invocation. Prior lease-gated observations do not replace that evidence. See the
[ordinary profile and limits](docs/runbooks/harness-connect.md#codex-01621-bounded-ordinary-profile),
[current native workflow and limits](docs/runbooks/task-native-workflow.md),
[capability evidence](docs/decisions/001-adapter-capabilities.md), and
[local measurement runbook](docs/runbooks/local-measurement.md).

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

`npm run check` checks the Git index for local records, runs ESLint and TypeScript
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
TypeScript program; validate them with their own tooling. Linting is not a
formatter; no additional formatting conventions or lint-staged dependency are added.

TypeScript is pinned to a 6.0 release compatible with the installed typescript-eslint
peer range. Upgrade both together when newer compiler support is available; do not
bypass incompatible peer dependencies with force-install flags.

## Git hooks

`npm ci` or `npm install` runs `prepare` to install Husky for this checkout.
The pre-commit hook runs `npm run check`: it rejects indexed local records, runs
lint and type checks, builds, and executes tests. A failed command stops the commit. Generated Husky
files under `.husky/_/` are ignored; `.husky/pre-commit` and `.husky/commit-msg`
are shared in Git. The commit-msg hook validates the proposed message with commitlint.

Select Node 24 or 26 before committing. GUI Git clients must also have the selected Node version and npm
on their PATH; see [Husky's version-manager guidance](https://typicode.github.io/husky/how-to.html#node-version-managers-and-guis).
Run `npm run prepare` to reinstall hooks if needed. No global configuration is changed.

Checks run against the working tree; the privacy guard checks the Git index.
With partially staged changes, also inspect the staged diff because the tested
working tree can differ from the commit. Hooks do not stage or modify source files.
They do not enforce commit-message language or replace independent review.
CI disables hook installation with `HUSKY=0` and runs checks explicitly. Hooks can
be bypassed locally, so CI and review remain required verification layers.

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

The accepted [forward-version compatibility policy](docs/decisions/013-forward-version-compatibility.md)
allows conditional reuse of a verified parser for newer releases within declared
source-specific windows, with unverified estimates kept separate and incompatible
data invalidated. Runtime rules live in `src/source-compatibility.ts`; exact profiles
remain the evidence boundary for verified support. The current stable Codex CLI
0.162.1 and Claude Code 2.1.296 use conditional parser reuse for file collection, not new exact
admissions. Codex 0.162.1 workflow collection also remains conditional; the Claude
workflow source is exactly admitted for 2.1.296. Ordinary binding separately permits the exact Codex 0.162.0/0.162.1
root-only and Claude 2.1.291/2.1.293/2.1.294/2.1.296 profiles under explicit
local human-pilot authority; see [Harness Connect](docs/runbooks/harness-connect.md).
The Claude 2.1.296 transcript profile is qualified only for bounded native print-mode
evidence, not interactive qualification or production admission; the others are
candidates. All ordinary Claude profiles, even qualified ones, require
`allowCandidateProfiles: true`. Default provider refusal and ordinary service admission
remain closed. Current labels stay `native_unverified_pilot`, `legacy_unverified`
and `candidate_pilot`.

The separate exact `codex-binding-01621-direct-family-v1` ordinary source admits
one fresh Codex 0.162.1 CLI root and up to two fresh direct children with
gpt-6.1-sol/high, without qualification authority. Its route-specific verified
provenance never promotes file/launch or historical observations. Costs remain
partial; complete request-universe and terminal accounting are not qualified.

Registered file adapters live in `src/adapter-profiles.ts`. Verified registration is an exact `(product, version)` allowlist. Conditional parser selection is separate. A new version whose semantics are unchanged is data, fixtures, and evidence. A semantic change is a named code variant plus tests; the old variant is not edited to fit the new version. Codex 0.158.0 uses the checkpoint variant and a historical exact-version admission. See the [admission workflow](docs/runbooks/codex-version-admission.md) and [current offline readiness limits](docs/validation/codex-01580-offline-readiness.md). The archived live report does not qualify the current source identity or establish whole-task completeness. The conformance runner is manual. `npm test` runs offline synthetic unit tests of the report projector, the candidate parser, and the confirmation helpers. It does not run the conformance runner, spawn product CLIs, or open real sessions. See [ADR 007](docs/decisions/007-adapter-version-profiles.md).

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

Pull requests and pushes to `main` run Node 24 checks on macOS. The workflow needs
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

## Observed-cost verification

Starting with catalog v3, every price release follows the
[price release checklist](docs/development/price-catalog-releases.md). A rate file alone
does not establish support for its model, component or billing condition.

User instructions are in the [cost guide](docs/runbooks/observed-cost.md)
([한국어](docs/runbooks/observed-cost.ko.md)). From a Node 24 or 26 checkout:

```sh
npm test -- tests/observed-cost.test.ts tests/observed-cost-cli.test.ts tests/pricing.test.ts tests/task-cost.test.ts
```

These synthetic checks establish arithmetic and reporting behavior, not whole-task
source coverage or real experiment effectiveness. Workflow example schemas are
covered by `tests/workflow-examples.test.ts`; contract/store boundaries use
`tests/contracts.test.ts` and `tests/store.test.ts`. Documentation-only edits need
link/anchor, example/schema and bilingual command/support checks. Use the general
implementation workflow and `npm run check` when product behavior changes.
