# Harness Delta

Measure metadata for an assigned development task across explicitly linked sessions.

**Preview: partial local measurement.** Codex 0.160.0 has two separately admitted
workflow profiles, and Claude Code 2.1.296 has a parent-only profile (launch and
resume of a kept session) and a separate read-only single direct-child profile.
Complete task cost, actual billing and inferential adoption remain unavailable.
Installation does not start collection. The package is private and supports Node.js 24 and 26.

처음 설치하는 팀 사용자는 아래 작업 절차를 읽으세요.
현재는 부분 로컬 측정 미리보기이며 전체 비용·실제 청구액·추론에 따른 도입 판정은 제공하지 않습니다.
Claude Code 2.1.296은 부모 전용 프로필(launch와 유지한 세션의 resume)과 별도의 read-only 직계 자식 1개 프로필을 지원합니다.

**Start here:** [Measure one assigned task](docs/runbooks/workflow-quickstart.md) ·
[배정된 작업 하나 측정하기](docs/runbooks/workflow-quickstart.ko.md).
The procedure covers installation → A/B setup → launch → stop/pause/resume/new session →
human outcome → partial cost and missingness → recovery.

## Documentation

| Need | English | 한국어 |
| --- | --- | --- |
| First installation and functional pilot | [Task procedure](docs/runbooks/workflow-quickstart.md) | [작업 절차](docs/runbooks/workflow-quickstart.ko.md) |
| Partial estimate and missing prices | [Observed cost](docs/runbooks/observed-cost.md) | [관측 비용](docs/runbooks/observed-cost.ko.md) |
| Exact native/child contracts | [Native workflow](docs/runbooks/task-native-workflow.md) | 핵심 지원 범위는 [작업 절차](docs/runbooks/workflow-quickstart.ko.md) |
| Flexible v2 configuration reference | [Flexible comparison](docs/runbooks/flexible-comparison.md) | 핵심 입력 준비는 [작업 절차](docs/runbooks/workflow-quickstart.ko.md) |
| Existing older-version file collection | [Local measurement](docs/runbooks/local-measurement.md), [continuation](docs/runbooks/session-continuation.md) | [로컬 측정](docs/runbooks/local-measurement.ko.md) |
| Developer synthetic checks | [V1 comparison](docs/runbooks/task-comparison.md), [exchange](docs/runbooks/team-file-exchange.md), [analysis](docs/runbooks/comparison-analysis-validation.md) | [V1 비교](docs/runbooks/task-comparison.ko.md), [교환](docs/runbooks/team-file-exchange.ko.md) |
| Source admission and historical evidence | [Version admission](docs/runbooks/codex-version-admission.md), [validation records](docs/validation/), [decisions](docs/decisions/) | 개발·검증 기록은 영어로 보존 |

The task and cost procedures have synchronized English/Korean versions.
They use an STE-inspired style, without ASD compliance or certification claims.
Unique architecture decisions and dated validation records remain available as evidence.
They are not prerequisites to follow the task procedure.

## Development

Use [CONTRIBUTING](CONTRIBUTING.md) for Node 24 or 26 setup, checks, Git hooks and contribution rules.
Agents use [AGENTS.md](AGENTS.md) and the [development workflow](docs/development/workflow.md).
The [product requirements](docs/requirements.md) define collection and acceptance gates.

For recurring native-version support updates, use the project-local
[tool-version-update skill](.claude/skills/tool-version-update/SKILL.md):
`$tool-version-update` in Codex or `/tool-version-update` in Claude Code.
It checks upstream contract changes and requires actual-binary qualification at
source-specific version boundaries or earlier semantic changes before expanding support.

SQL migrations live under `src/migrations` and are copied to `dist/migrations`.
`src/index.ts` exports `Store` and strict metadata schemas.
`Store.putEvent` inserts once per source key: identical replay returns false;
conflicting identity/data throws `event_conflict`.
A registered project, task and linked session must exist before insertion.
`Store.transaction` is synchronous; close the store when finished.
Use the contract/store tests documented in CONTRIBUTING for these API boundaries.

Collection excludes prompt/response text, source-code content and secrets from measurement data.
Personal plans, databases and detailed reviews remain in Git-ignored `.harness-delta/`.
A fresh clone does not need those records to build or contribute.
See the [MIT license](LICENSE). Publication name/channel are separate decisions.
