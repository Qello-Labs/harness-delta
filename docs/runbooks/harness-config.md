# Portable harness configuration

[한국어](harness-config.ko.md)

## 1. Prepare selected files

Use Node 24 or 26 and a built Harness Delta checkout:

```sh
npm ci
npm run build
```

In the target project, select existing Markdown instructions and only the related
files you intend to pin. Prepare `harness-notes.md`: purpose, project-root manual
application, dependencies, selected-file limits and manual verification. Tool
commands remain manual. Registration copies exact bytes and preserves originals.

Expected layout:

```text
harness-config/
├── baseline/
│   ├── harness.md
│   ├── README.md
│   ├── manifest.json
│   └── scripts/search.py
├── v2/
│   ├── harness.md
│   ├── README.md
│   ├── manifest.json
│   └── scripts/search.py
└── comparisons/baseline-vs-v2.json
.harness-delta/setup/
├── baseline-vs-v2-<revision-hash>.json
└── tasks/<task-id>.json
```

`harness-config` is suitable for deliberate Git sharing. Inspect selected files
before publishing them. Private local bindings belong in ignored
`.harness-delta/setup`; keep that directory out of Git. The revision suffix allows
multiple reviewed local settings without replacing historical task pins.

## 2. Register baseline and modified versions

A is the currently applied project configuration; B is a prepared improvement.
Prepare the candidate instruction/application procedure and any supporting
scripts before registration. Preserve common project rules in both configurations.
The agent inspects these files, proposes the selected baseline/candidate files
and identifiers, and asks for confirmation before registration. A candidate file
existing in the checkout does not establish that it is already applied.

After human adoption and actual application, that configuration can become A in
the next comparison against a new candidate. A/B are comparison roles, not version
names. Reuse a baseline bundle only when its selected artifacts match the confirmed
current configuration; otherwise register a new version. Keep old versions,
comparisons and task assignments unchanged. Registration and comparison creation
do not apply or adopt a winner; partial estimates do not establish superiority.

Create a selected input file outside the generated version directory:

Keep artifact `source_path` files outside the entire `harness-config/` directory.

```json
{
  "schema_version": 1,
  "harness_id": "search",
  "version": "baseline",
  "policy_version": "policy-v1",
  "readme_path": "harness-notes.md",
  "artifacts": [
    {"artifact_id":"instruction","role":"instruction","source_path":"policy.md","target_path":"harness.md"},
    {"artifact_id":"search-tool","role":"tool","source_path":"scripts/search.py","target_path":"scripts/search.py"}
  ]
}
```

Run from the built Harness Delta checkout:

```sh
node dist/harness-config-main.js register --root /path/to/project --input /path/to/register-input.json
```

Expected result: `registered`; exact repeats return `already_registered`. To
register the modified files, change `version` to `v2` and optionally add
`"base":{"path":"harness-config/baseline/manifest.json"}`. Run the same command.
An existing version with different bytes fails with `harness_version_conflict`.
Do not edit a published version; select a new version.

Paths use portable ASCII components within the project. Absolute paths,
traversal, symlinks, case-folding collisions and Windows device names are rejected.
The primary instruction targets `harness.md`. Select at most 255 artifacts;
the README copied from `readme_path` adds one entry, for at most 256 manifest artifacts.
Each file is limited to 1 MiB, with 16 MiB total. Missing selected files and unresolved inline
local Markdown links block publication. Command strings, reference-style links,
remote links and dependency closure are not fully validated. Supply missing
files explicitly or describe unselected prerequisites and limits in the README.

## 3. Generate the portable comparison

Create a comparison input:

```json
{
  "schema_version": 1,
  "id": "baseline-vs-v2",
  "name": "Baseline vs v2",
  "arm_a": "baseline",
  "arm_b": "v2"
}
```

```sh
node dist/harness-config-main.js compare --root /path/to/project --input /path/to/comparison-input.json
```

Expected result: `generated`; exact repeats return `already_generated`. Different
contents under an existing ID fail with `shared_settings_conflict`. The pair
contains relative manifest references and hashes. Baseline is A; modified is B.
It contains no model/effort, local DB identities or experimental defaults.
Tool-only changes alter the whole-bundle digest even when instruction hashes
remain unchanged. Hashes show integrity, not authenticity or actual use.

The optional repository reference packages are
[harness-register](../../skills/harness-register/SKILL.md) and
[harness-compare-config](../../skills/harness-compare-config/SKILL.md). Their
helpers require an explicit `--harness-delta` checkout; no global plugin is
required. Installing a skill is separate from creating a harness snapshot.

## 4. Connect on each PC

First complete the existing [reviewed local setup prerequisites](local-browser-ui.md)
and [comparison registration](task-comparison.md): registered project, ordered
compatible variants, frozen protocol, criteria, price basis and reviewed execution
settings. This feature does not create or freeze those records. Copy the shared
harness-config files into the registered project checkout.

1. Open Local UI → Setup and choose the comparison JSON file.
2. Read snapshot integrity and separate A/B original-tool compatibility.
3. Select the registered project and reviewed local measurement settings explicitly.
4. Select **Connect local settings**.

Expected result: private immutable JSON appears in `.harness-delta/setup` and the
setup is available for new tasks. An exact repeat reports an existing connection.
Import reads no sessions and starts no task, tool, agent or model. Missing
registration or an incompatible ordered pair remains blocked. Display names do
not identify a setup; explicit IDs distinguish equally named entries.

For startup after binding:

```sh
node dist/cli.js --db /path/to/local.sqlite ui --setup /path/to/project/harness-config/comparisons/baseline-vs-v2.json
```

No matching revision fails with `shared_binding_required`. Multiple revisions
fail with `shared_binding_selection_required`; choose one explicitly:

```sh
node dist/cli.js --db /path/to/local.sqlite ui --setup /path/to/project/harness-config/comparisons/baseline-vs-v2.json --setup-binding-revision shared-<revision-hash>
```

Use an actual private revision ID. Existing legacy reviewed manifests remain
supported. Different runtime templates create separate revisions for future
tasks; they do not update existing task pins.

## 5. Prepare and measure

Create a task using the connected setup. Task and A/B assignment IDs are reserved
and retained through interruptions. A preparation blocker remains visible;
correct the original selected files manually, then retry the same task. Never
restore tools from the snapshot automatically or rerandomize to a matching arm.
Follow the existing prepare/apply/new-session/connect flow. Start actual work only
after the current workflow permits observation.

During observation, changed or missing snapshot/private/original-tool files stop
collection. In-flight uncertain data is discarded; retained observations, partial
cost, window, assignment and outcomes remain readable. Correction requires an
explicit continuation/reconnect; no automatic resume or backfill occurs.

Snapshot integrity does not establish native startup order, instruction loading,
actual tool execution or dependencies. Existing exact-version and forward-version
labels remain unchanged. See the [current native support limits](task-native-workflow.md)
and [ADR 014](../decisions/014-portable-harness-config.md). No complete task cost,
statistical adoption decision or new native admission follows from this feature.

If the selected descriptor changes after preview, Connect fails with `shared_preview_changed`; import it again and review it. Revision IDs and reviewed template/runtime choices distinguish settings in the task chooser. Bindings for a deleted project do not transfer when the same directory is registered again. Private JSON remains local; archive or remove obsolete private files deliberately after historical work is no longer needed.

## 6. Agent application (format 2)

Use format 2 when the assigned bundle contains an application procedure that
adapts project rules and scripts. Register both versions normally, then generate:

```json
{
  "schema_version": 2,
  "id": "agent-baseline-vs-v2",
  "name": "Agent baseline vs v2",
  "arm_a": "baseline",
  "arm_b": "v2",
  "application": "agent_applied"
}
```

1. Import the comparison, bind a reviewed local template and prepare the task.
   The UI stores assignment without applying files or starting collection.
2. Select an existing checkout/worktree and Codex or Claude Code. Inspect its
   branch and HEAD. Prepare the native session context. Retry preserves assignment;
   no branch switch or new worktree is automatic.
3. Request a fresh native session. On macOS with an installed CLI this requests a
   Terminal interactive session with the prepared prompt. The installed grammar
   was checked for Codex CLI 0.161.0 and Claude Code 2.1.295; actual native opening
   and agent acceptance are unverified. Desktop prompt deep links and other
   platforms are unsupported. If unavailable or failed, open a fresh session in
   the selected target yourself and paste the copyable application context.
4. The session's own agent uses harness-apply, reads the assigned bundle,
   investigates domains and edits target files directly. It discovers output
   paths as needed and checkpoints each file before editing. Preserve unrelated
   dirty/untracked files. Decide file and command permissions in the native window.
5. Inspect actual changes and check outcomes in the UI after editing. File hashes
   are independently verified for the reported set. Script/check outcomes remain
   `agent_reported`; missing, refused and failed outcomes are visible. This is not
   an exhaustive filesystem or tool audit. There is no publish approval.
6. After verified application, copy the populated working-session guidance. Open
   a separate fresh session in that target and invoke harness-connect there.
   File application does not prove generated-instruction loading or measurement
   readiness. Existing identity/loading/source gates remain in force; these
   working-session routes remain production-qualification-pending. The explicit
   Codex 0.162.0/0.162.1 root-only local functional pilot can connect after completed file
   application under separate task/source authority; its parser references remain
   unverified. See [the bounded pilot](harness-connect.md#codex-01620-ordinary-root-local-pilot).

Application helper operations are `context`, `checkpoint`, `identity`, `report`
and `status`. Use the installed skill path and Node 24 or 26. Checkpoints retain actual
dirty bytes and absent states; a missing baseline is rejected, never replaced with
Git HEAD. Reports contain hashes and bounded check IDs/outcomes, not source bytes,
secrets or command output. Hidden paths, symlinks/hardlinks, private DB paths and
sidecars, registered bundles, node_modules and known secret paths are unsupported.
Each file is limited to 1 MiB and an attempt to 256 checkpointed paths.
Checkpoint/report HTTP bodies and helper input files are limited to 1 MiB; other
mutation routes keep their 16 KiB transport limit.

Copy fallback is not evidence of automatic opening. Opening acknowledgement is
not evidence that an agent started. Repeated opening clicks do not request another
window for the same attempt. Abandon an attempt before explicitly retrying opening.
If current files drift after completion, abandon the old attempt and prepare a
new one; preserve and inspect those user edits. Abandonment and server restart
never stop or relaunch the native agent or roll back files. Stop it in its native
window. Stale helpers and deleted tasks remain fenced. Deletion removes product-owned
review/launch artifacts while preserving workspace edits and opaque application
session exclusions. Unsafe/replaced private roots report `application_cleanup_pending`;
restore the intended private directory and retry deletion. Tasks stay deleted.

Application role registration requires a supported metadata-only identity provider.
The current Codex root receipt integration retains its exact-version limits.
Claude's application identity resolver is unavailable; file application remains
visible, while subsequent connection is blocked. Never identify a session from
cwd or an agent claim. Do not run harness-connect in the applying session.

See [ADR 015](../decisions/015-agent-harness-application.md). Synthetic tests validate
wiring and integrity only; separately authorized native acceptance remains required
for opening, adaptation, scripts, permissions and working-session loading.

## 7. Restore applied edits and check staged files

Use these explicit local commands when applied harness edits must leave the
checkout, for example before you commit your own work. Nothing in this section
runs automatically. Run from the built Harness Delta checkout:

```sh
node dist/cli.js --db /path/to/local.sqlite application preview <task-id>
node dist/cli.js --db /path/to/local.sqlite application restore <task-id> --preview <digest>
node dist/cli.js --db /path/to/local.sqlite application check-staged <task-id>
```

An installed `hm` command takes the same arguments, for example
`hm --db <database> application preview <task-id>`.

1. Stop the native agent in its native window. Restore needs an inactive task,
   no running or observing connections, and the external stop acknowledgement in
   its released state. A finalized task is allowed.
   After stopping observation and the agent, record the acknowledgement:

   ```sh
   node dist/cli.js --db /path/to/local.sqlite workflow external release <task-id> --external-session-stopped
   ```

2. Run `preview`. It prints a digest and one action for each checkpointed path:
   `delete`, `restore`, `unchanged` or `conflict`. It prints no file contents and
   edits nothing. `unchanged` means its bytes already match the checkpoint baseline.
3. Read the list. `conflict` marks a file changed after application or a changed
   checkpointed file without a verified application result. A single
   conflict blocks every edit, so resolve it yourself and preview again.
4. Run `restore` with that digest. The command takes a fresh preview first and
   refuses when the digest differs. Files still at their applied hash return to
   the actual dirty checkpoint baseline, never Git HEAD. Files the application
   created are deleted. Files you modified are not overwritten.
5. Restage your intended changes, then run `check-staged`. Restore never changes
   the Git index, so harness edits staged earlier stay staged until you restage.
   Exit code 2 means harness edits or private `.harness-delta` or
   `.harness-delta-managed` entries remain staged. Unstage them and run the check
   again before committing.

After restore the application is fenced. Measurement stays blocked until you
explicitly reapply through the section 6 flow. Restore does not reapply, start
collection, stop an agent or open a session.

If restoration is interrupted, the application stays fenced and its workspace
lease stays held. Run `preview` again, review the remaining actions, and retry
`restore` with the new digest. Completed files appear as `unchanged`. A partly
written or subsequently edited file remains a conflict; preserve its current
bytes and review its private checkpoint before recovering it manually.
`application_restoration_required` prevents reapplication or moving the task to
another worktree until restoration completes. Legacy cross-worktree inherited
metadata without a local checkpoint is not restored; review any edits left in
the earlier worktree separately.
Failed attempts without any unresolved checkpoints can select another worktree
without an empty restoration. Recreated parent directories use mode 0700; their
original permissions are not recorded.

The bundle and private checkpoint/context records must remain intact. Newly
captured file permissions are restored when bytes are restored; legacy deleted
files without mode metadata are recreated with mode 0600. Mode-only changes
are outside the hash-based preview.

`check-staged` allows a staged file whose current content equals its checked
original baseline. A file that mixes harness and user changes is flagged
conservatively, even if the divergence contains only user edits; the check does
not guess which edits are yours. Git clean filters and line-ending conversion
are applied to baseline bytes as they are during staging. Preview, restore
and the staged check cover checkpointed paths, including reported outputs.
Changes outside that set are not audited or restored. The staged check also
rejects private record directories anywhere in the index and retains reported
paths from earlier restored applications of this task in the same worktree.

Hook integration is manual. No hook is installed or overwritten, and the check is
not mandatory enforcement. To use it from your own pre-commit hook, add the
`check-staged` command yourself and keep the existing hook content.
Run the hook command in the task's selected worktree using absolute CLI/database
paths. A shared hook must select the task for that worktree; an alternate
`GIT_INDEX_FILE` is checked as supplied, not mapped to another worktree.

Keep the task and its checkpoint records until restoration and the commit check
are complete. Deleting a task still never restores files. These commands change
no native support limit, identity gate or measurement eligibility.
