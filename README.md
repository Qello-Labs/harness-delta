# Harness Delta

Measure how much an AI coding agent used for one development task.

Harness Delta links your Claude Code or Codex sessions to a task you define,
collects usage metadata while you work, and lets you judge the outcome yourself.
Measurement records exclude prompts, responses, source-code content and secrets.

> **New here?** Follow the [walkthrough with screenshots](docs/guide/walkthrough.md) ·
> [스크린샷으로 보는 따라 하기](docs/guide/walkthrough.ko.md).
> It observes one real task from setup to outcome.

## How it works

The steps below describe ordinary Claude observation.

```text
 Setup (once)                         Repeat for each task
┌──────────────────────────┐   ┌──────────────────────────────────────────────────┐
│ ① Register a project      │   │ ③ New task → ④ /harness-connect in Claude         │
│ ② Install Claude connect  │──▶│ → ⑤ Confirm "measuring", work → ⑥ Stop → ⑦ Judge  │
└──────────────────────────┘   └──────────────────────────────────────────────────┘
```

1. **Register** a local Git project in the browser UI. Nothing is written to it.
2. **Install** the project-local `harness-connect` skill after reviewing a preview.
3. **Create a task** with a name and a completion criterion.
4. **Connect** by pasting one command into the Claude session you opened yourself.
5. **Work** as usual. Supported family usage is grouped under the parent session.
6. **Stop observation** when done. Claude keeps running.
7. **Judge** the outcome: success, failure or abandon.

For ordinary Claude observation, you start and stop Claude yourself.
Stopping observation does not stop Claude. Assigned workflows have separate
launch and process-control gates; follow their guide instead.

## Quick start

Requires Node.js 24 or 26.

```sh
npm ci
npm run build
npm start -- --db local.sqlite ui
```

Open `http://127.0.0.1:4318`. The service listens on 127.0.0.1 only. Keep using the
same `--db` file; it holds your measurements. Press Ctrl+C to stop.
Installation alone never starts collection.

## Two ways to measure

| Mode | Use it when | Setup needed | Guide |
| --- | --- | --- | --- |
| **Ordinary Claude observation** | You want usage for your normal Claude work. | Project registration and Claude connection. No comparison or A/B assignment. | [Walkthrough](docs/guide/walkthrough.md) · [따라 하기](docs/guide/walkthrough.ko.md) |
| **Harness comparison (A/B)** | You compare a current harness (A) with a candidate (B) across assigned tasks. | Reviewed comparison file, frozen protocol and harness pair. | [Measure one assigned task](docs/runbooks/workflow-quickstart.md) · [배정된 작업 측정](docs/runbooks/workflow-quickstart.ko.md) |

Codex ordinary-session collection still uses the frozen `functional_pilot`
assignment path, not the assignment-free ordinary Claude mode.

## What is supported

**Preview: partial local measurement.** The package is private.

| Product | Supported route |
| --- | --- |
| Claude Code 2.1.296 (exact version and binary; existing default) | Ordinary observation with at most 8 family members total, including the parent; separate parent-only launch/resume and read-only single direct-child workflow profiles |
| Claude Code 2.1.301 (exact version and binary; explicit configuration) | Separate ordinary observation profile: one root and up to two flattened members, 3 members total |
| Codex 0.163.0 (exact version) | Separate bounded ordinary profile: one fresh parent and up to two fresh direct children inside a frozen `functional_pilot` |
| Codex 0.162.1 (exact version) | Bounded ordinary profile inside a frozen `functional_pilot` protocol |
| Codex 0.160.0 (exact version) | Two separately admitted workflow profiles |

Codex 0.163.0 passed separate ordinary-route native acceptance on 2026-10-16;
its exact binding profile does not promote file/workflow or historical observations.
Both Claude ordinary admissions remain `qualified: false`; admission for normal
use is separate from native qualification. For Claude Code 2.1.301, bounded print-mode
transcript conformance and real-service localhost rehearsal passed, but the
authenticated ordinary attempt on 2026-10-17 stopped at the instrument's
`stream_model` guard before connection. Usage and billing are unknown, and
ordinary qualification remains outstanding; see the
[blocked-attempt record](docs/validation/claude-ordinary-binding-02196-qualification.md#2026-10-17-authenticated-ordinary-attempt-blocked).
The Claude Code 2.1.296 default and existing task pins remain unchanged.
Existing file and selected workflow windows still label Codex 0.163.0 and
Claude Code 2.1.301 `compatibility_unverified`.
Conditional parser reuse does not extend the exact connection routes above. Ordinary connections
outside their admitted versions still return fixed codes such as
`claude_source_version_unsupported`. Route-specific status is tracked in
[Harness Connect](docs/runbooks/harness-connect.md#current-implementation) and
[ADR 013](docs/decisions/013-forward-version-compatibility.md).

What you get, and what you do not:

- **Observed cost is a partial estimate** of observed usage with matched prices.
  Missing usage or prices are unknown, not zero. It is not billing.
- Unobserved intervals, including paused and pre-connection usage, are never backfilled.
- Complete task cost, actual billing and inferential adoption decisions are not available.

## Documentation

| Need | English | 한국어 |
| --- | --- | --- |
| First task, step by step | [Walkthrough](docs/guide/walkthrough.md) | [따라 하기](docs/guide/walkthrough.ko.md) |
| Every UI screen and rule | [Local UI](docs/runbooks/local-browser-ui.md) | [로컬 UI](docs/runbooks/local-browser-ui.ko.md) |
| Claude/Codex connection details and error codes | [Harness Connect](docs/runbooks/harness-connect.md) | [Harness Connect](docs/runbooks/harness-connect.ko.md) |
| Assigned A/B task | [Task procedure](docs/runbooks/workflow-quickstart.md) | [작업 절차](docs/runbooks/workflow-quickstart.ko.md) |
| Cost estimate and missing prices | [Observed cost](docs/runbooks/observed-cost.md), [reference prices](docs/runbooks/reference-price-catalog.md) | [관측 비용](docs/runbooks/observed-cost.ko.md), [기준 가격](docs/runbooks/reference-price-catalog.ko.md) |
| Portable harness pairs | [Harness config](docs/runbooks/harness-config.md) | [하네스 구성](docs/runbooks/harness-config.ko.md) |
| Exact native/child contracts | [Native workflow](docs/runbooks/task-native-workflow.md) | — |
| Flexible v2 configuration | [Flexible comparison](docs/runbooks/flexible-comparison.md) | — |
| Older-version file collection | [Local measurement](docs/runbooks/local-measurement.md), [continuation](docs/runbooks/session-continuation.md) | [로컬 측정](docs/runbooks/local-measurement.ko.md) |
| Developer synthetic checks | [V1 comparison](docs/runbooks/task-comparison.md), [exchange](docs/runbooks/team-file-exchange.md), [analysis](docs/runbooks/comparison-analysis-validation.md) | [V1 비교](docs/runbooks/task-comparison.ko.md), [교환](docs/runbooks/team-file-exchange.ko.md) |
| Evidence and decisions | [Version admission](docs/runbooks/codex-version-admission.md), [validation records](docs/validation/), [decisions](docs/decisions/) | — |

Task and cost procedures have synchronized English/Korean versions in an
STE-inspired style, without ASD compliance or certification claims. Decision and
validation records are evidence; you do not need them to follow a procedure.

## Privacy and data

- Collection requires a registered project, an active task and a linked session.
  Permitted scope is decided before any session content is read.
- Measurement data, fixtures, exports and reports exclude prompt, response,
  source-code content and secrets.
- The UI keeps additional private names, setup paths and launch commands in a
  separate metadata database. The measurement database also retains local project
  paths. Keep both raw databases private; neither is a shareable measurement report.
- Personal plans, databases and detailed reviews stay in the Git-ignored
  `.harness-delta/` directory. A fresh clone does not need them.

## Development

- Setup, checks, Git hooks and contribution rules: [CONTRIBUTING](CONTRIBUTING.md).
- Agents: [AGENTS.md](AGENTS.md) and the [development workflow](docs/development/workflow.md).
- Collection and acceptance gates: [product requirements](docs/requirements.md).
- Native version updates: the project-local
  [tool-version-update skill](.claude/skills/tool-version-update/SKILL.md)
  (`$tool-version-update` in Codex, `/tool-version-update` in Claude Code). It checks
  upstream contract changes and requires actual-binary qualification before support expands.

Run `npm run check` before submitting implementation changes.

### Library API

`src/index.ts` exports `Store` and strict metadata schemas.

- `Store.putEvent` inserts once per source key. An identical replay returns `false`;
  conflicting identity or data throws `event_conflict`.
- A registered project, task and linked session must exist before insertion.
- `Store.transaction` is synchronous. Close the store when finished.
- SQL migrations live under `src/migrations` and are copied to `dist/migrations`.

The contract and store tests listed in CONTRIBUTING cover these boundaries.

## License

[MIT](LICENSE). Publication name and channel are separate decisions.
