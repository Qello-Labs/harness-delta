# Harness Connect project skill

[한국어](harness-connect.ko.md)

## Current implementation

The [shared skill](../../skills/harness-connect/SKILL.md), receipt API, binding
store/coordinator, Codex and Claude metadata hooks/providers and UI family display are implemented.
Isolated synthetic end-to-end tests exercise one parent connection, automatic
child collection and partial usage refresh. Ordinary native production sources
remain qualification-blocked. Claude candidate integration includes session-scoped
skill hooks, same-command receipt lookup and flattened root-family membership.
A configured provider or installed skill alone does not enable that production path.
See [design and qualification](../decisions/012-session-family-bindings.md).

The UI first prepares the registered logical task and A/B assignment. With approved
native instrumentation, a normally opened parent supplies a trusted receipt; the
server resolves current identity/source, preserves arm/price pin, starts observation
and follows supported native child relations. Children do not call the skill.
Repeated calls confirm binding; multiple tasks require one explicit selection.
A common cwd, model statement, environment hint or guessed UUID is never proof.

## Project-only installation boundary

These are manual examples, not an automatic installation. Choose the target and
review the package first. They refuse an existing destination. Node 24 and built-in
libraries suffice for the portable helper. No global settings, AGENTS or auth are changed by copying the skill. Claude
frontmatter registers hooks for the rest of a session when explicitly invoked;
review that package and workspace trust before installation or invocation.

```sh
skillSource="$PWD/skills/harness-connect"
projectRoot="/path/to/your/project"
```

Codex:

```sh
mkdir -p "$projectRoot/.agents/skills"
test ! -e "$projectRoot/.agents/skills/harness-connect" && test ! -L "$projectRoot/.agents/skills/harness-connect" && cp -R "$skillSource" "$projectRoot/.agents/skills/harness-connect"
```

Claude Code:

```sh
mkdir -p "$projectRoot/.claude/skills"
test ! -e "$projectRoot/.claude/skills/harness-connect" && test ! -L "$projectRoot/.claude/skills/harness-connect" && cp -R "$skillSource" "$projectRoot/.claude/skills/harness-connect"
```

For Codex, a separate concrete startup-hook proposal requires review of existing hooks, exact script,
receipt directory, approved source roots and trust. Applying/trusting it and actual
native qualification require authorization. Codex needs a new/resumed startup boundary afterward. Claude documents skill
hooks registering at invocation; installation/reload and actual loading remain
unverified here. Do not bypass trust or force model/effort. The skill
has no product-version installation requirement; source admission stays on the server.
[Official Codex hooks](https://learn.chatgpt.com/docs/hooks) describe metadata and
trust; transcript formats remain unstable. Pinned source proves child start hooks
supply their own path after a materialization attempt with a shared root ID; the provider validates
direct parent/depth from the exact metadata header, without scanning history.
Live skill discovery and source/counter conformance remain unverified.

## Connect once and verify

Supply the local UI origin and explicit project/task. Use the opaque receipt delivered
by the current native hook. Never manufacture a receipt or scan transcript directories.
The commands below illustrate the implemented contract; native production admission
is still blocked until qualification.

```text
Codex: $harness-connect Connect this session to project PROJECT_ID, task TASK_ID, using http://127.0.0.1:PORT and its native receipt.
Claude: /harness-connect Connect this session to project PROJECT_ID, task TASK_ID, using http://127.0.0.1:PORT and its native receipt.
```

```sh
node .agents/skills/harness-connect/scripts/connect.mjs inspect --origin http://127.0.0.1:PORT --product codex
node .agents/skills/harness-connect/scripts/connect.mjs connect --origin http://127.0.0.1:PORT --product codex --project PROJECT_ID --task TASK_ID --receipt NATIVE_RECEIPT
```

The helper checks Origin/CSRF/version, calls session-connect and re-reads durable
assignment and native binding. It reports sanitized IDs, arm, evidence, active
collection and automatic-child support. Missing instrumentation, unsupported
source or identity conflict returns a fixed blocker with exit 1. A read-only inspect
is not connection success. Use `claude_code` and `.claude/skills` only when the server
has an explicitly configured Claude provider. The default candidate remains
qualification-blocked. For approved project-local Claude installation the connect
command omits a receipt argument: its PreToolUse hook records current metadata
and the helper locates it in the same Bash call through OS process ancestry.
`${CLAUDE_SKILL_DIR}` is not documented for hook commands; the packaged hooks
use the exported `CLAUDE_PROJECT_DIR` project installation path. The receipt
directory must match the server configuration; choose it explicitly at approved
setup rather than widening source access. A missing/ambiguous receipt blocks.
[Claude skill hooks](https://code.claude.com/docs/en/skills) and
[hook environment](https://code.claude.com/docs/en/hooks) document these boundaries.

```sh
node .claude/skills/harness-connect/scripts/connect.mjs inspect --origin http://127.0.0.1:PORT --product claude_code
node .claude/skills/harness-connect/scripts/connect.mjs connect --origin http://127.0.0.1:PORT --product claude_code --project PROJECT_ID --task TASK_ID
```

Claude records future members through SubagentStart/Stop hooks and validates
their own transcript ownership. All evidenced members, including nested members,
are flattened under the root: the documented hook fields do not establish their
direct nested parent. Child re-calls only confirm an active independently discovered
family. A paused family requires parent reconnect unless its code-owned human UI pilot
authority permits same-live-root UI resume as described below. Interactive qualification of
native profile/counter/source formats remains pending. Only 2.1.296 has bounded print-mode
qualification as described below; other listed versions remain candidates.
No model or effort setting is imposed.

The UI refreshes family counts and partial usage. Pause/server restart stops collection;
use an authorized same-live-root UI resume, or invoke again once in the parent for
a fresh baseline. A new parent can join the same
open task with its original arm and price pin. Earlier/unobserved intervals are not
backfilled. A discovered older member records `late_linked_member`. Unsupported descendants and missing usage remain gaps, not zero. Complete
cost and inference stay unavailable; metadata hooks can continue during pause
even though no transcript collection occurs. Deletion durably queues metadata-only
receipt forgetting and suppresses later family receipts, including across restart;
native transcripts are never removed. Complete collection and hook removal are
different operations. Finish only through human outcome confirmation.

## Existing ticket compatibility

The legacy path remains for an exact root opened with the UI's startup ticket.
An ordinary session without the ticket's native context is not admitted through it.

```sh
node .agents/skills/harness-connect/scripts/connect.mjs connect --origin http://127.0.0.1:PORT --product codex --project PROJECT_ID --task TASK_ID --session SESSION_UUID
```

Select the confirmed exact source in the native picker. The helper re-reads source,
context, freshness and window evidence. It confirms only the latest selected source;
observation starts separately in the UI, with no automatic family inheritance in
this legacy path. See [manual UI](local-browser-ui.md) and
[native workflow gates](task-native-workflow.md). Do not silently restart a session
or claim past harness application.

## Local verification

Use Node 24 and existing dependencies. Build is included in `npm run check` before
the optional transport test imports its assets.

```sh
node --check skills/harness-connect/scripts/connect.mjs
npm run check
node --test skills/harness-connect/tests/*.mjs
```

These tests use isolated fixture databases and synthetic hook/source records. They
make no native model call, read no user history/database, and establish no live hook
trust or source qualification. Report focused/full local checks and independent
review separately from remote CI. The exact adapter contract is
[session-binding-contract.ts](../../src/session-binding-contract.ts).

Claude baselines preserve up to 1,024 distinct excluded own request IDs independently
of live replay history. Over-capacity (`claude_baseline_limit`) or partial/unreadable
(`claude_baseline_incomplete`) baselines stop connection instead of silently losing
exclusions. Already observed counter conflicts stop collection.

For the isolated ordinary Codex CLI qualification runner and its explicit native approval boundary, see [qualification procedure](../validation/codex-ordinary-binding-qualification.md). Preparation and Node-only fixtures do not open production admission.

For the isolated qualification runner, the UI also shows parent/child own request, input/output and partial cost rows with an observed sum. Its same-live-root resume and separate owned-AI emergency stop preserve the original deadline and safety counters; paused source counters remain unverified. See [the bounded procedure](../validation/codex-ordinary-binding-qualification.md).

## Codex 0.162.0 ordinary-root local pilot

Use only the exact `codex-01620-ordinary-root-human-pilot` source profile in a
reviewed `functional_pilot`. The normal service remains closed. An operator must
select the exact task and separately authorize observation:

```sh
npm start -- --db "$DB" ui --pilot-task "$TASK_ID" --pilot-observe --pilot-until-stop
```

Configure the provider and reviewed SessionStart hook proposal with the independently
verified `0.162.0` or `0.162.1` product version. Use the same actual version in the
task's workflow and frozen protocol. The existing profile ID also covers the
0.162.1 candidate; it does not alias the executable or receipt to 0.162.0.
Metadata-only application identity does not
authorize transcript reading. Review project-local hook installation/trust and
the exact receipt/source directories before native startup; never fabricate receipts.
Only one fresh root is eligible; child sessions are unsupported.

For `agent_applied`, first complete the separate application session, review file
outputs and checks, then start a fresh working root in the selected checkout and
invoke `harness-connect`. Applying-session identity reuse, incomplete application,
file drift and old roots remain blocked.

Own-response observations reuse the 0.160.0 parser and are labeled
`compatibility_unverified`, with immutable `codex_workflow` parser lineage; this
label is not launch permission or production admission. Contract failure invalidates
the shared parser tuple before another source read. Costs remain partial reference
estimates, not complete totals, native-loading proof, or inference. See
[ADR 013](../decisions/013-forward-version-compatibility.md).

The [0.162.1 release](https://github.com/openai/codex/releases/tag/rust-v0.162.1)
fixes TUI questions and startup feature compatibility. Synthetic checks cover
versioned receipts, selected-checkout application identity, root-only observation,
pause/resume and contract invalidation. They do not qualify native hook loading
or latest counter semantics; those still require an approved native trial.

## Claude human-operated UI pilot

The local operator may select one prepared `functional_pilot` task using the
`claude-ordinary-human-pilot` source profile, with an exact version
listed by the ordinary provider (currently 2.1.291, 2.1.293, 2.1.294 or 2.1.296). Existing file and
launch-workflow version compatibility does not qualify ordinary family sources.
The profile, binary version, project source directory and receipt directory must
be reviewed before installation or native observation. A browser or manifest
cannot grant collection authority. The existing `ui --pilot-task` local command
prepares either product; `--pilot-observe --pilot-until-stop` additionally grants
only that selected task's explicit-stop observation. It does not launch an agent.

The human opens a fresh Claude terminal after the observer is ready, invokes
`/harness-connect` once in the parent, then creates up to two new family members.
No child invocation, fixed model, effort or child type is required. Own requests
and partial estimates are shown separately per member and as an observed sum.
Claude membership is flattened under the root; nested direct parents are not
proven. Unsupported members and intervals remain explicit gaps.

Pause, completion and revocation stop collection without terminating Claude.
Collection has no elapsed-time cutoff; the frozen comparison follow-up remains
separate. UI resume revalidates the exact persisted live root binding, project,
preparation, source identity, process and deletion/revocation state, even when
its original receipt is old. Restart stays paused. Resume establishes a new
baseline and excludes paused/offline requests without backfill.

New connections still require a fresh receipt. An old receipt alone cannot
select a new root, project or task, and it does not authorize history discovery.
Legacy bindings missing retained process proof fail closed; create a separately
prepared task and fresh Claude root rather than replacing their stored identity.
Native process exit/relaunch is a separate boundary, not measurement resume.
Skill metadata hooks may continue while collection is paused. Receipt lifetime
is separate from the hook timeout and the helper's fresh-receipt lookup window.

The [2.1.294 change record](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#21294)
describes fixes to `prompt` and `agent` hook judgment. It does not establish native
transcript fields, command-hook loading or counter compatibility. The ordinary
parser is unchanged; 2.1.294 has synthetic candidate coverage for connection,
family usage, pause/resume and human completion.

The [2.1.296 change record](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#21296)
includes managed-hook and token-count fixes, but the changelog alone does not qualify
the ordinary source. The unchanged parser has synthetic 2.1.296 identity, own-request replay,
baseline exclusion, family-ceiling and pilot-gate coverage.

The 2.1.296 transcript profile is qualified only for bounded native print-mode
evidence, not interactive qualification or production admission: an offline actual-binary rehearsal and one
native print-mode pilot confirmed skill loading, receipts, family membership and own
counters; see [the qualification record](../validation/claude-ordinary-binding-02196-qualification.md).
The skill-scoped `SubagentStop` hook wrote no receipt there, and discovery does not
depend on it. The other listed versions have synthetic evidence only. Actual 2.1.291, 2.1.293 or 2.1.294 skill loading,
family counters, pause/resume and human completion still need an explicitly
approved native trial. All ordinary Claude profiles, including qualified 2.1.296,
require `allowCandidateProfiles: true`; default provider refusal and ordinary service
admission remain closed. Current labels remain `native_unverified_pilot`,
`legacy_unverified` and `candidate_pilot`. Ordinary production admission, full task cost and
inferential decisions remain unavailable.
