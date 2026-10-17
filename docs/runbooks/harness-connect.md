# Harness Connect project skill

[한국어](harness-connect.ko.md)

## Current implementation

The 2026-10-16 UTC release check found Codex 0.163.0 and Claude Code 2.1.301.
Codex 0.163.0 passed separate bounded ordinary-route native acceptance on that date.
Claude 2.1.301 passed bounded print-mode transcript conformance; ordinary qualification remains pending. Existing file and root-workflow windows still
resolve both as `compatibility_unverified`; ordinary binding evidence does not
promote those sources. Use the exact admitted versions below for ordinary connections.

Codex 0.163.0 can be prepared separately with `--product-version 0.163.0 --route qualification`
in the [bounded qualification procedure](../validation/codex-ordinary-binding-qualification.md).
It requires the pinned same-release `codex-code-mode-host` beside the Codex executable;
the standalone Codex archive alone is insufficient. Preparation and execution check both pins.
The separate `--route ordinary_admission` trial then passed without qualification
collection authority. Explicit setup and the version selector support 0.163.0 alongside
0.162.1; existing saved/default versions are not upgraded automatically. Only the new
exact binding profile gains verified provenance; past unverified observations stay unchanged.

The [shared skill](../../skills/harness-connect/SKILL.md), receipt API, binding
store/coordinator, Codex and Claude metadata hooks/providers and UI family display are implemented.
Isolated synthetic end-to-end tests exercise one parent connection, automatic
child collection and partial usage refresh. The Codex 0.162.1 bounded
ordinary profile described below passed actual ordinary-route native
acceptance and independent review on 2026-10-13; 0.163.0 has the separate acceptance
below. Other ordinary native production
sources remain qualification-blocked. Claude candidate integration includes session-scoped
skill hooks, same-command receipt lookup and flattened root-family membership.
A configured provider or installed skill alone does not enable that production path.
See [design and qualification](../decisions/012-session-family-bindings.md).
Ordinary Claude observation, for a task with no A/B assignment, is open for
[normal use](#ordinary-claude-observation-qualification-pending) under the exact
current Claude source version and binary.

The UI first prepares the registered logical task and A/B assignment. With approved
native instrumentation, a normally opened parent supplies a trusted receipt; the
server resolves current identity/source, preserves arm/price pin, starts observation
and follows supported native child relations. Children do not call the skill.
Repeated calls confirm binding; multiple tasks require one explicit selection.
A common cwd, model statement, environment hint or guessed UUID is never proof.

## Project agent connection setup

In Local setup, select the registered project and open **Agent connection setup**.
Choose **Codex** or **Claude Code**. Saved settings, installed files, native hook
trust and linked sessions are separate states.

For Codex, review the exact version and permitted source roots, then save the
configuration. Preview installation before applying it. The reviewed installation
copies the owned skill and recorder, merges its entries into project-local
`.codex/hooks.json`, and creates `.harness-delta/codex-connect/receipts` with private
permissions. Unrelated hooks are preserved. Installation neither grants native
trust nor launches Codex or creates a receipt. Review and trust the native hook,
then start or resume the working session before invoking `harness-connect`.

Project Codex connection settings supply the receipt/source locations for this
project's Codex tasks; the frozen task version and source-admission gates still
apply. A configuration change or removal is blocked while Codex bindings are
observing. Removal preserves receipts and unrelated hooks. The Claude panel keeps
its project-local package workflow and the source and family limits below.

Refresh setup to check missing/unsafe receipt directories and provider
initialization. A ready provider is an environment check, not proof that the
current session loaded a trusted hook. Confirm the actual session connection in
the task detail. Installation does not enable ordinary Codex tasks without an A/B
assignment or extend the bounded source profile.

If the receipt directory is later removed, preview and apply installation again
to recreate it without replacing unchanged hooks or skill files. Refresh after a
Node runtime upgrade and preview an update if its pinned executable path changed.
Use **Recover stopped installer** only for a proved-dead owner with no remaining
transaction. A missing owner record or saved `transaction-*` evidence requires
manual review; recovery never discards that evidence or releases a live lock.

## Codex 0.163.0 bounded ordinary profile

The exact `codex-binding-01630-direct-family-v1` source admits one fresh CLI root
and up to two fresh direct children in a registered frozen `functional_pilot`.
It preserves the [historical profile's](#codex-01621-bounded-ordinary-profile)
GPT-family/observed-effort policy, receipt-before-access, no-backfill, replay and
topology fences. Select the version explicitly in project connection setup.

The 2026-10-16 macOS arm64 / Node 24 native trial used gpt-6.1-sol/high,
read-only/on-request/no-daemon and one explicitly approved network-only connector.
It verified three fresh linked sources, six observed requests (parent four, each
child one), three excluded connection-baseline requests and owned process teardown.
The source now has its own exact provenance; file/workflow compatibility and
historical profiles/pins remain unchanged.

Costs remain partial reference estimates, never complete totals or vendor bills.
Resume, deeper/additional descendants, tool-owned launch and inferential adoption
are not admitted by this profile. Terminal/incomplete-response completeness is not
qualified. See the [native acceptance record](../validation/codex-ordinary-binding-qualification.md#2026-10-16-ordinary-route-acceptance).

## Codex 0.162.1 bounded ordinary profile

The fresh `ordinary_admission` trial and independent review qualify this exact
bounded route. See the [dated acceptance evidence](../validation/codex-ordinary-binding-qualification.md#2026-10-13-ordinary-route-acceptance).
The previous lease-gated observation and synthetic fixtures are separate evidence;
they do not qualify other ordinary routes.

Use the code-owned `codex-binding-01621-direct-family-v1` source profile in a
frozen `functional_pilot` protocol, exact version `0.162.1`, and a registered task.
The task initial model may be empty, in which case the observed native model is
used, or any GPT-family model, which is kept as written. The functional protocol does not enable an adoption
experiment. Configure the reviewed Codex receipt directory, permitted source
roots and registered project in `session_binding`. No qualification lease,
`native-pilot` command or browser support flag grants admission.

The 2026-10-13 native evidence is a fresh CLI root with two fresh direct children,
`gpt-6.1-sol/high`, under the reviewed read-only, no-daemon invocation. Under the
user-approved 2026-10-15 policy, normal use accepts any GPT-family model and
doesn't force reasoning effort. The ordinary coordinator admits at most one root
and two direct children, requires a GPT-family observed native model and stores
model and effort as observed. No new native trial was run for this policy. Non-GPT models, source replacement, ancestry,
third/nested members and different exact versions fail closed. Application and
working sessions stay separate. Restart/pause creates a fresh baseline; excluded
setup and offline usage are not backfilled.

The implementation pins new observations to `source: codex_binding` and
exact parser provenance established by that ordinary-route trial.
File and tool-owned launch routes retain their previous compatibility-unverified
state; historical observations never gain this new trust. Ordinary collection
does not control the user's native process or impose the qualification runner's
request/token/lifetime safety budget.

Only eligible observed requests and priced components contribute partial cost.
Complete task cost remains unavailable: response records and normal exit do not
establish every attempted request or durable terminal usage. A price match under
the reference policy is not actual billing evidence.

<a id="ordinary-claude-observation-qualification-pending"></a>

## Ordinary Claude observation

The separate exact `claude-binding-2-1-301-family-v1` profile admits explicitly
configured 2.1.301 with one root plus two flattened members. The existing 2.1.296
default and saved/frozen task settings remain unchanged. The project setup API
accepts `{"operation":"configure","product_version":"2.1.301"}`; omitting the
version preserves saved settings, otherwise the historical default. The UI does
not display a Claude version selector. Binary, receipt and transcript must match
the same frozen task version. Both records remain `qualified: false`; the new
profile's [print-mode conformance](../validation/claude-ordinary-binding-02196-qualification.md#2026-10-16-exact-21301-transcript-qualification)
does not qualify interactive use, complete usage or cost. Separate ordinary
authenticated qualification remains outstanding: the 2026-10-17
[authenticated attempt](../validation/claude-ordinary-binding-02196-qualification.md#2026-10-17-authenticated-ordinary-attempt-blocked)
stopped at the `stream_model` guard before connection, with usage and billing
unknown. A separate localhost rehearsal passed through
the real ordinary service/provider (seven native requests minus one baseline,
six observed requests); it does not qualify the production scheduler or TUI.
File/workflow and historical pins are not promoted.

Since the user-approved 2026-10-15 policy, this flow is admitted for normal use.
The code-owned profile `claude-binding-02196-family-v1` admits ordinary
connection only for its exact Claude Code source version and binary hash. Any
Claude model (`claude` or an ID starting with `claude-`, case-insensitive) is accepted and stored as
observed, with its observed effort. Admission for normal use is separate from
the profile's historical `qualified: false` evidence flag. That flag isn't
promoted, and no new native trial was run for this policy. Another source
version or binary still returns a fixed refusal and reads no native source. See
[ADR 016](../decisions/016-ordinary-observation.md#policy-addendum-2026-10-15).

Use the normal [local browser UI](local-browser-ui.md#start-the-local-service).
No pilot flag, qualification lease or browser input opens this path.

1. **Configure the project.** In Local setup, open the registered project's
    Claude connection setup card and choose Configure Claude. This
   saves the exact supported version, the receipt directory
   `.harness-delta/claude-connect/receipts` inside the project and the Claude
   projects directory. Another version returns `claude_source_version_unsupported`.
2. **Preview, then install.** Choose Preview install / update. Status and
   preview write nothing. The preview lists each relative path under
   `.claude/skills/harness-connect` with its action and hashes. Review it, then
   choose the install button. Only files this installer owns are changed; an
   edited, unowned or unsafe path blocks with a fixed code such as
   `package_unowned` or `package_drift`. Removal uses the same preview-then-apply
   steps. It is refused with `ordinary_installation_in_use` while an ordinary
   task in the project is active, and it keeps receipts and native transcripts.
3. **Create the task.** In New task, pick the Ordinary Claude observation mode,
   a name, the project and a completion criterion. The UI offers
   `user_confirmed_completion`. There is no comparison setup, protocol or arm.
   The task pins the project settings and a price table at creation.
4. **Connect from the native parent.** Open Claude yourself and run the command
   the task page shows, once, in the parent session.
5. **Control observation.** Use Pause, Resume, Stop observation and the result
   buttons on the task page. Finish only with your own outcome confirmation.

```text
/harness-connect Connect this session to project PROJECT_ID, task TASK_ID, using http://127.0.0.1:PORT and its native receipt.
```

Installing the package doesn't register hooks. They register when you invoke
the skill in the native parent, and the setup card reports hook registration as
`unverified`. Copied package, registered hook, native receipt and active
observation are four separate facts. Model, effort, permissions, startup and
exit stay under your control in Claude.

The admitted route behaves as follows.

- **One measurement root per task.** Each connection gets a new measurement
  root ID. The native session identity is stored separately and never rewritten.
- **Exclusive native root.** One task reserves a live native root, including
  while its segment is acquiring, paused or stopping. Another task that presents
  the same root gets `binding_session_conflict`.
- **Handover.** Choose Stop observation in the first task. Claude keeps running.
  Then invoke the skill again for the second task. A receipt recorded before the
  stop returns `binding_receipt_stale`. The second task starts from a new
  baseline with its own measurement IDs and price pin. No history is reassigned.
- **Pause and resume.** Pause keeps the segment. Resume revalidates only the
  selected live identity, then takes a new baseline.
- **Restart and relaunch.** A server restart leaves the task paused and reads
  nothing by itself. A relaunched Claude has a new process identity even when it
  resumes the same native session ID. Invoke the skill again to register its
  hooks and explicitly open a new measurement segment.
- **No backfill.** Paused, offline and pre-connection usage stays unobserved.
- **Baseline store.** Exclusions are kept in SQLite, so the 1,024-ID cap of the
  pilot path doesn't apply here. That cap is unchanged for the pilot path.
- **Family limit.** Frozen 2.1.296 tasks allow at most eight members, root included;
  a ninth returns `binding_family_limit`. Frozen 2.1.301 tasks allow at most three
  members, root included; a fourth returns the same code. Members are flattened under the root; the immediate
  parent of a nested member is not verified.
- **Model.** Every Claude model is accepted at its observed effort; there is no
  model pin. A usage record from another product's model stops collection with
  `binding_runtime_unsupported`. Its source batch is rejected atomically,
  including supported records in that batch. Explicit resume excludes that batch
  through a new baseline instead of backfilling it.
- **Deletion.** Deleting an observed task forgets its native root. Other tasks
  still attached to that root are paused and later connections from it are
  refused. Continue with a new native root. Native transcripts are not removed.
- **Cost.** Usage is partial. Complete cost, billing and inferential results
  stay unavailable.

New observations carry separate `claude_binding` provenance, prospective
only. Comparison, Codex, file and workflow trust states are unchanged.

If setup reports `installation_recovery_required`, stop the installer and confirm
that the PID in `.harness-delta/claude-connect/installation-lock/owner.json` is
absent. The UI recovery action only releases a clean, dead installer lock.
It refuses retained `transaction-*` directories and never deletes unknown files.
For an interrupted transaction, first compare the installed package against every
`installed_sha256` in `installation.json`. If they match, installation committed;
retain the transaction for review rather than rolling back. If the live package
differs but `transaction-*/previous` matches that manifest, preserve the live
package by moving it aside and restore only that verified previous directory.
If neither matches, preserve all files and reconcile the ownership manifest
before retrying. Do not remove the lock or transaction to bypass a mismatch.

Historical evidence for this path includes synthetic unit, fake-provider, HTTP
and UI tests, bounded target-binary localhost conformance, and narrowly scoped
interactive connection observations under a development-only qualification
factory. One connection-only trial matched a measured row to independent API
counters and exercised two approve-once Bash permissions. That evidence is
unchanged by the normal-use policy and isn't relabeled as full native
qualification. The runtime check accepts macOS arm64 under Node 24 or 26 and
otherwise returns `binding_runtime_unsupported`.

## Project-only installation boundary

These are manual examples, not an automatic installation. Choose the target and
review the package first. They refuse an existing destination. Node 24 or 26 and built-in
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
The commands below illustrate the implemented contract. Native production admission
requires the exact bounded profile above; other candidates remain blocked.

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
native profile/counter/source formats remains pending. Both 2.1.296 and 2.1.301 have
bounded print-mode transcript qualification; 2.1.301 includes normal/SIGINT
localhost conformance, not authenticated ordinary acceptance. The 2.1.291,
2.1.293 and 2.1.294 transcript profiles remain candidates.
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

Use Node 24 or 26 and existing dependencies. Build is included in `npm run check` before
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
exclusions. Already observed counter conflicts stop collection. The ordinary
observation path keeps its exclusions in SQLite and has no such cap.

For the isolated ordinary Codex CLI qualification runner and its explicit native approval boundary, see [qualification procedure](../validation/codex-ordinary-binding-qualification.md). Preparation and Node-only fixtures do not open production admission.
That runner now has a separate exact 0.162.1 candidate selected with
`--product-version 0.162.1`, using the ordinary `--no-daemon` TUI and the unchanged
one-root/two-fresh-direct-child topology. Its exact binary pin, frozen consent
and owned-run safety guards are separate from normal provider configuration.
The default qualification route uses a source lease; `ordinary_admission`
uses the independently qualified ordinary source authority instead.
Its session-only `projects` inline table trusts only the new disposable project;
it does not save user configuration or widen sandbox/approval permissions.
The new 0.162.1 plan separately opts into the default-off, `UnderDevelopment`
`exec_permission_approvals` feature for this session only. One reviewed helper
execution combines inspect/connect and requires explicit network-only command
approval, preserving the existing filesystem policy. That permission is not
host/port-scoped; managed proxy restrictions may still block loopback access.
No prefix/turn/session grant, unsandboxed escalation or permanent policy change
is permitted. Stop on blocked inspection, connection or approval without retrying
or spawning children. Its reviewed stop envelope is root8/child1each/total10.
Automatic startup connects only. After connection and that turn's completion,
submit the intent's frozen `post_connect_input` once as a separate TUI turn.
Paste it without a submit key (use bracketed paste when supported), inspect the
draft, then press Enter in a separate action. Pasted composer text alone does
not prove submission; observe the sent turn and active work before waiting.
Plan at most three root requests per turn and one per child; excluded connection
requests still count toward safety, never measured usage. After all three sessions'
usage is collected and the work turn finishes, exit the idle TUI normally.
Enter the quit command and its submit key separately as well.
The historical 0.160.0 envelope remains
root4/child1each/total6. The 0.162.1 token stop is 200000; 0.160.0 retains 100000.
The 0.162.1 clock is 900 seconds; 0.160.0 retains 120 seconds.
The target's connection-relative collection window is also 900 seconds;
the historical window remains 180 seconds. The launch-relative native deadline
still ends the trial at 900 seconds, even if the collection window ends later.
The permission mode and stops are frozen in a fresh intent; preparing it is not
native execution authorization. See the procedure for its additional consent field.
The connector path/SHA is frozen; connect runs only after successful inspect.
Approve only its pinned Node command with the current receipt and no chained
commands. The human must deny a second or broader grant and stop continued work
after a blocked connection; unlinked activity is not covered by the source ledger.
The new 0.162.1 plan requires automatic startup; manual mode remains historical
0.160.0 only.
It also freezes approval and agent-turn-complete OSC9 notifications with `notification_condition="always"`.
Subscribe to creation of its private `native-attention.json` before execution,
then to modification after each notification. An existing attention path is
refused before consuming the reservation. Raw PTY framing publishes a
digest/count-only wake hint without waiting for a newline or retaining message text.
Inspect the current screen and obtain explicit human approval of the exact command;
the hint never grants permission or extends the frozen deadline.
Completion hints likewise require observing the finished turn and idle composer
before submitting the fixed work input or normal quit; the hint is not proof of
measured usage. Check all three linked sessions' usage separately before quit.
Node-only delivery tests do not establish target-binary notification conformance.
The pinned 0.162.1 ordinary route has actual native notification, command-permission
and family conformance for the bounded profile above. Other ordinary routes,
versions, runtimes and wider topology remain unqualified.
Source-free task preparation also accepts a functional-pilot protocol with this
exact version and single own-response profile; it grants no binding or ticket
collection authority. Qualification projects each exact source with its own
proved ancestry, while the separate lease bounds the whole family. Sibling-thread
rows fail closed; broader ordinary topology is not admitted.

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
listed by the ordinary provider (currently 2.1.291, 2.1.293, 2.1.294, 2.1.296 or 2.1.301). Existing file and
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
depend on it. The separate 2.1.301 transcript profile has bounded localhost
normal/SIGINT print-mode evidence, not interactive or authenticated ordinary
qualification. The 2.1.291, 2.1.293 and 2.1.294 profiles have synthetic evidence only. Actual 2.1.291, 2.1.293 or 2.1.294 skill loading,
family counters, pause/resume and human completion still need an explicitly
approved native trial. All comparison/pilot Claude profiles, including transcript-qualified 2.1.296 and 2.1.301,
require `allowCandidateProfiles: true`; default provider refusal for pilot
profiles remains closed. Current labels remain `native_unverified_pilot`,
`legacy_unverified` and `candidate_pilot`. These pilot profiles do not grant
ordinary production admission; full task cost and inferential decisions remain
unavailable. This pilot authority is separate from
the [ordinary observation admission](#ordinary-claude-observation-qualification-pending),
which doesn't open pilot profiles.
