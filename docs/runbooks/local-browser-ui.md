# Local browser workflow

[한국어](local-browser-ui.ko.md)

Use the private `hm` checkout with Node.js 24 or 26. This UI shares the CLI's Store and
external-task coordinator. The ordinary measurement flow does not launch an agent.
Format-2 application can explicitly request a fresh macOS Terminal session;
`open_requested` does not prove the agent started, and native acceptance remains
unverified. The UI does not change authentication, create commits, or publish a service.

## Start the local service

From the checkout:

```sh
npm ci
npm run build
npm start -- --db local.sqlite ui
```

After main CLI registration, the equivalent command is:

```sh
hm --db local.sqlite ui
```

Open the printed `http://127.0.0.1:4318` address. `--port` changes only the local
port; no host option exists. Stop the local service with Ctrl+C. Its collectors
settle and active measurement pauses; the external AI remains under your control.

Select Node 24 or 26 and verify `node --version` before installation. Run `npm ci`
again after switching Node majors to rebuild SQLite for the selected runtime. The guarded entry
reports `unsupported_node` (exit 2), `build_required` (exit 3), or
`dependencies_required` (exit 4) before importing SQLite. Follow its instructions
in the checkout; it never installs an AI product or switches your global runtime.

No setup file is required to open an empty UI. For ordinary Claude observation,
register a project in **Setup**, configure its Claude connection, preview and install
the project package, then choose **Ordinary Claude observation** in **New task**.
Choose a name, project and completion criterion; no comparison, protocol or A/B
assignment is required. Follow the [ordinary connection steps](harness-connect.md#ordinary-claude-observation-qualification-pending).
The comparison setup below is optional and applies to assigned A/B tasks.
To load an already reviewed comparison at startup, add `--setup reviewed-ui-setup.json`.

## Click through Setup

These Korean UI screenshots were captured on 2026-10-16 from the running local
server and built UI. Project paths, identities, comparison inputs and rates are
isolated examples. No native agent was launched or connected. The comparison uses
**synthetic validation**, not real measurement: its 2099 recruitment dates, participant,
criteria, sample size and rates are not recommendations. Use your own reviewed values.
Select **EN** in the header for English labels.

For ordinary Claude observation, complete project registration and Claude setup
below, then follow the [task walkthrough](../guide/walkthrough.md#step-4-create-a-task).
Comparison settings are optional; do not prepare an A/B comparison for ordinary Claude work.

### Register and select the project

1. Select **Setup**. With no project registered, **Connect project** and comparison
   preparation are disabled until their inputs are available.

![Initial Setup screen](../guide/images/settings-01-empty.png)

2. Enter the Git project's absolute directory, or use **Choose**. Select
   **Connect project**. The example path is disposable; do not paste it into
   your own installation. Registration reads HEAD, not session contents.

3. After connection, the project is selected and **Agent connection setup** appears.
   Project selection determines which agent settings and saved comparisons you see.

![Selected project after connecting](../guide/images/settings-02-project-help.png)

### Configure Claude and review installation

Select **Claude Code**, then **Configure Claude**. **Configured** and **Installed**
are separate badges. Select **Preview install / update** to see relative paths
and actions without writing files.

![Claude install preview](../guide/images/settings-06-claude-preview.png)

Review the paths under `.claude/skills/harness-connect/`, then select
**Install / update reviewed package**. The badge becomes **Installed**.
**Cancel** closes the preview without applying it. **Preview removal** is a
separate operation, not a way to stop measurement.

![Claude package installed](../guide/images/settings-07-claude-installed.png)

Installation alone does not connect a session or collect usage. Create an ordinary
task and invoke its connection prompt in Claude afterward. Support still depends
on the [current source and binary gates](harness-connect.md#current-implementation),
not on reaching this screen.

### Configure Codex and distinguish its states

Select **Codex** to switch products. Before configuration, the example shows
**Not configured**, `Files: absent`, unverified hook trust and 0 linked roots.
Select **Configure Codex** to save the displayed version and permitted source roots.

![Codex setup before configuration](../guide/images/settings-03-codex-before.png)

Select **Preview install**. Review the skill package, recorder, project hook
file and receipt directory, then select **Install reviewed package**.

![Codex installation preview](../guide/images/settings-04-codex-preview.png)

![Codex package installed, no native root linked](../guide/images/settings-05-codex-installed.png)

`Files: installed` does not change **Hook trust: unverified** or **Linked roots: 0**.
Review native hook trust and start or resume Codex before connecting a task.
**Refresh status** rereads setup; it does not connect a session. Codex still requires
a separate assigned route: the [Codex 0.162.1 bounded ordinary profile](harness-connect.md#codex-01621-bounded-ordinary-profile)
or the explicitly selected [Codex 0.163.0 bounded ordinary profile](harness-connect.md#codex-01630-bounded-ordinary-profile).
It is not the assignment-free ordinary Claude mode. The version selector lists both;
saved settings stay on the saved version.

### Prepare and check a comparison file

Only continue here for A/B work. In **2. Prepare comparison settings**, choose how
the harness is applied. **Only the instructions changed** delivers selected
instructions; **An agent must apply it** requires the separate application procedure.
This choice is not an A/B arm selection.

Enter the prepared candidate's project-relative path, plus any supporting files
and README source. Select **Copy agent request** and review the agent's proposed
registration inputs before it creates a comparison file. If clipboard access fails,
the UI offers text to copy manually; copying never runs an agent.

![Application method and candidate inputs](../guide/images/settings-08-comparison-method.png)

Enter the returned comparison JSON's absolute path and select **Check comparison
file**. **Comparison file verified · not saved yet** shows the ordered A/B pair.
The request for measurement settings and remaining choices appear below it.
Checking a file neither saves a setting nor proves B is applied.

![Verified comparison and remaining setup decisions](../guide/images/settings-09-comparison-checked.png)

### Load the bundle and review the conditions

Use **Copy measurement request** to obtain the still-missing reviewed decisions
from your agent. Under **Load prepared settings**, choose its single setup bundle.
This is different from importing an existing UI manifest under **Have an existing
settings file?**; a comparison descriptor alone is not a measurement bundle.

![Loaded bundle, confirmation still unchecked — synthetic example](../guide/images/settings-10-review-ready.png)

Check project, ordered A/B pair, application method, purpose, participants,
recruitment dates, sample rules, allowed work, criteria, follow-up, missingness,
prices and source scope. **Technical details and complete conditions** expands
the full inputs. In this example the purpose is visibly **Synthetic validation**.

If the selected application method differs from the file, a warning appears.
Loading a bundle does not choose a method for you. Select the matching method or
prepare a new reviewed comparison; do not change the method merely to bypass the warning.
Review changed inputs again before saving.

![Application-method mismatch warning](../guide/images/settings-11-mode-mismatch.png)

### Confirm, save and reuse

Select **I confirm these conditions for new tasks** only after review.
**Confirm and save settings** becomes available when both the confirmation and
application method match. Select it once. Review alone has not saved anything.

![Confirmation enables saving — synthetic example](../guide/images/settings-12-confirm-save.png)

The saved comparison appears under **Saved comparison and measurement settings**.
Expand **Review saved conditions** to see its task types and sizes.
The saved card identifies the same A/B pair by variant IDs (`variant-a` / `variant-b`)
rather than the reviewed names (`baseline` / `candidate`). It is reusable;
do not import it again for each task. Saving creates no task and starts no agent
or measurement.

![Saved comparison and expanded conditions — synthetic example](../guide/images/settings-13-saved-conditions.png)

Select **New task with this setting**. The form opens in comparison mode with the
project and setting already selected. In this example **recruitment has not started**
because its dates are deliberately in 2099, so task preparation is blocked.
This is not a connection failure or a reason to copy the example dates.

![Prefilled task form and recruitment gate — synthetic example](../guide/images/settings-14-new-task-prefilled.png)

### Inspect the price basis

Expand **Price basis details** on the right to read the cached catalog version and
provider-price check date. **Refresh prices** is an explicit online update attempt,
not a guarantee that a new catalog exists. This capture only expanded the details;
it did not run a price refresh. Existing task price pins are not replaced.

![Cached price basis details](../guide/images/settings-15-price-details.png)

## Local deletion and private metadata

The CLI's task/project deletion and retention commands also scrub registered private
UI task/source records and cached responses. Consumed action keys stay blocked, so
retrying an old request cannot recreate a deleted task. Cleanup uses a durable journal
after measurement deletion commits; the two database files are not one atomic transaction.
`ui_metadata_cleanup_pending` means deletion authority is committed but private
cleanup is unfinished. Restore access to the same metadata file and retry the command.
Store startup also retries pending cleanup; replaced or unsafe files are not modified.

The UI registers its metadata files when opened, including a custom `--metadata`
path. After upgrading, open each previously used custom UI metadata file once before
relying on CLI deletion to erase it. An unopened, previously unregistered custom
file cannot be discovered by the CLI. Opening it reconciles existing tombstones
before exposing private records. Previously exported files and native transcripts
remain outside local task deletion.

## Measurement criteria for tasks

In **Setup**, select a project directory. Registration reads Git HEAD and does not
create a repository or commit. The code baseline is read again when preparing a
new task. Uncommitted edits are preserved; HEAD identifies the committed baseline,
not a snapshot of uncommitted files.

If the project already has saved settings, select **New task with this setting**;
the new-task form opens with that project and setting selected. To connect a
reviewed file that is not saved yet, expand **Have an existing settings file?**
and select **Import existing settings file**, or pass the file through `--setup`. The
private manifest has `schema_version: 1` and `profiles`, each with `id`, `name`,
`setup`, and `execution`. `setup` uses the shared `ExternalTaskSetupSchema`;
`execution` contains the reviewed binary, Codex home, recorder, sandbox, timeout,
and poll interval. Session identity and source paths are chosen later, not preset.
See the [external workflow](external-session-workflow.md) for its source contract.

Templates must already refer to a registered project, frozen schema-2 protocol,
reviewed harness pair and fixed completion criteria. The shared selection builder
checks those references. The UI does not invent comparison rules, pricing,
completion criteria, or source admission. Unsupported type/size choices stay
disabled. The form offers feature/fix/infra/chore/docs/ci and small/medium/large.
Model and effort remain flexible choices in your native agent.

The **Saved comparison and measurement settings** section shows only the selected
project's settings. Cards retain each comparison's fixed A/B pair; expanded
conditions show allowed task types and sizes. Reusing a saved setting requires
no re-import. An empty list directs you to prepare and review a new comparison
above. The comparison recruitment period belongs to the frozen protocol, not
to an individual task's observation window. The file does not grant collection
access.
A new or mixed import shows **Reviewed setup connected.** An identical repeat
shows **This setup is already connected.** It creates no duplicate settings or
tasks. A same-ID content conflict rejects the whole file and preserves existing
settings. Cancelling the picker leaves settings unchanged.

### Prepare a settings file

For skill-generated snapshots, use **2. Prepare with your agent** instead of
assembling and registering every input through separate CLI commands:

Connect the project before preparing its harness. Select a registered project,
then enter the prepared candidate instruction/application-procedure path and any
supporting script/document paths relative to that project. The copied agent
request includes its registered directory and these explicit candidate inputs;
it does not require manually filling every ID and version. The agent inspects
the current applied baseline, proposes registration inputs and groups unresolved
choices for confirmation. If skills are unavailable, it asks for the tool
checkout location instead of inventing a machine-specific path.

A is the currently applied configuration and B is the prepared improvement,
with common rules preserved. A/B are roles, not permanent version names. After
human adoption and actual application, the resulting configuration can become
the next comparison's A. Registration, task success and lower partial cost do
not automatically adopt a candidate. Old comparisons and assignments stay fixed.

1. Connect and select the Git project in **1. Register and select a project**. In
   **How is the harness applied?**, choose **Only the instructions changed** or
   **An agent must apply it**. This choice is separate from A/B assignment: it
   decides whether an assigned harness is delivered as instructions or applied to
   a checkout by an agent. The request cannot be copied before you choose, and
   the choice is sent to the agent as `application_mode`. Later steps show the
   method stored in the comparison file; a different selection is reported and
   cannot be saved. Loading a setup bundle never selects or changes the method. Provide the
   candidate files and copy the generated request into your agent. Confirm its
   proposed baseline/candidate files before `harness-register` registration and
   `harness-compare-config` comparison creation. The agent returns the verified
   comparison JSON absolute path. If clipboard access fails, manually copy the
   displayed request.
2. Enter the comparison JSON's absolute local path and select **Check comparison
   file**. A sole registered project is selected automatically; choose a project
   first when several are registered. The path input explains why checking is
   unavailable until a project and path are present. This requires no profile
   or identifier and saves nothing. The server
   verifies the selected project's ordered A/B manifests, shows the remaining
   decisions and proposes a technical setting identifier. You may edit that
   identifier. File integrity does not establish policy eligibility, application
   or measurement support. Select **Reuse registered measurement settings**
   when available; the server resolves its existing profile, frozen protocol and
   price table without duplicating them.
3. When no reviewed setting exists, select **Copy measurement request** after
   checking the comparison and paste it into your agent. No additional skill is
   required. The agent reuses verified references and asks only for missing human
   decisions. Confirm its proposals; participants, dates, criteria, sample rules,
   source scope and prices are never invented.
4. Under the request, use **Load prepared settings** to select the agent's single
   private JSON bundle, stored in the Harness Delta checkout's Git-ignored
   `.harness-delta/setup-drafts/` directory. Verify that Git ignores it before
   writing; never put private paths or participant IDs in a public artifact.
   Its envelope is `kind: "harness-delta.measurement-setup"`,
   `schema_version: 1`, and `input` following `SetupReviewInputSchema` in
   `src/local-web-setup-review.ts`. Include verified `comparison_path` and
   `project_id`, a reviewed `profile` (or registered `template_id`), complete
   schema-2 `protocol`, approved `policy_status` or `variants` (not both),
   and `price_table` only if needed. The embedded documents use the existing
   production schemas. Import checks the inputs without saving and fills any
   supplied decisions. Correct only the reported missing or invalid fields.
5. Review the readable project, A/B pair, purpose, participants, recruitment,
   task count, completion criteria, observation scope and price summary. Expand
   technical details for the complete conditions. Check the confirmation and
   select **Confirm and save settings** once. This registers the reviewed inputs
   and connects the private comparison; there is no second connection screen.
   Bundles reject `freeze_at`; the server records the actual confirmation time
   for an unfrozen protocol. It must precede recruitment; a passed start date
   requires a newly reviewed correction, never a silent date change. Existing
   frozen protocols keep their original time. Review rolls back tentative DB
   writes; save revalidates inputs under writer locks. Binding errors roll back
   tentative registrations and remove only newly created uncommitted snapshots.
   The two databases and private files do not form a crash-atomic transaction;
   retained committed snapshots support recovery without changing prior pins.
6. The connected setting is available for **New task with this setting**. Its
   private JSON is saved under `.harness-delta/setup`; new tasks pin it. Saving
   does not create a task, run an agent or start observation. Application,
   connection, installation/trust and source admission remain separate.

**Advanced: individual files and technical values** retains individual JSON
upload/paste and an optional explicit UTC confirmation time. This is not needed
for the bundle path. An omitted profile ID in individual input uses the verified
suggestion; an explicit profile ID and edited identifier must match. Choosing a
registered template reuses it rather than the retained profile draft. Project,
protocol, variants, prices and ordered manifest references must agree in either
path. Standalone comparison-file import still uses its existing explicit
project/template connection preview.

The file-import and CLI routes also remain available:

1. Follow steps 3–4 of the [workflow quickstart](workflow-quickstart.md) to
   register the reviewed project, price table, A/B variants and schema-2 protocol,
   then freeze the protocol in the same measurement database. Replace synthetic
   example choices before registration. Writing a settings file does not create
   those registrations.
2. In a text editor, create a private JSON manifest with `schema_version: 1` and
   `profiles`. Give each profile a unique `id` and recognizable `name`. Put the
   reviewed workflow input in `setup.workflow`, runtime input in `setup.runtime`,
   and preparation spec in `setup.preparation`. For the manual CLI handoff,
   include the reviewed `setup.native_binary` described in the
   [external workflow](external-session-workflow.md). Use your accepted inputs;
   do not infer criteria, protocol or price defaults.
3. Put only `binary`, `codex_home`, `hook_recorder`, `sandbox`, `timeout_ms`
   and `poll_ms` from the reviewed execution input in `execution`. Do not copy
   an entire launch/session input. Optional session binding must match the
   [UI manifest schema](../../src/local-web-domain.ts). Keep the file private.
4. After building, check its structure with the loader below, then select
   **Import existing settings file**. This check reads the selected file only; it does not
   register dependencies, launch an agent or qualify collection support.

```sh
node --input-type=module <<'JS'
import { readLocalWebManifest } from './dist/local-web-domain.js';
readLocalWebManifest('reviewed-ui-setup.json');
console.log('Setup file structure is valid.');
JS
```

Expected: **Setup file structure is valid.** Registration references and source
gates remain separate checks when choosing and preparing a task.

## Choose a connection path

The numbered steps below describe the exact Codex 0.160.0 ticket path. For ordinary
terminal sessions and family collection, use [Harness Connect](harness-connect.md).
Assignment-free ordinary Claude observation is admitted for normal use under the
configured profile's exact source version and binary hash: Claude Code 2.1.296
by default, or explicitly configured Claude Code 2.1.301. Native qualification
remains pending (`qualified: false`). It requires no pilot flag or
`allowCandidateProfiles: true`.
Codex 0.162.1 and explicitly selected Codex 0.163.0 bounded ordinary collection
still use a frozen `functional_pilot` protocol and assignment; neither is an
assignment-free ordinary task mode.
The separately authorized Codex root-only and Claude human-operated pilot routes
retain their own gates. The Claude comparison/pilot provider still requires
`allowCandidateProfiles: true`; its bounded print-mode qualification is not
interactive qualification or ordinary admission. Historical labels
`native_unverified_pilot`, `legacy_unverified` and `candidate_pilot` remain.
Installing a skill alone does not enable collection, and file or launch-workflow
compatibility windows do not widen these source gates.

Setup, task details and Getting started show route-specific descriptions derived
from the configured product/version and code-owned readiness metadata, not from
installed-version discovery. Verified exact launch sources and
`compatibility_unverified` references are separate from candidate ordinary-family
pilots. Unsupported routes stay unsupported; no description grants collection authority.

Synthetic tasks show **Validation-only context** instead of native-family connection
instructions. Prepare and inspect the fixture only. Do not launch or connect native
agents for it; actual work needs a separately reviewed real protocol and route.
Absent usage/cost remains unavailable, not zero.

## Prepare, connect and observe

### Guided Claude connection

After configuration preparation and, where required, verified harness application,
real Claude family tasks show **Claude connection** in task details. The card
follows **Check installation → Connect → Measure**, with one primary next action.
Synthetic validation and ticket tasks retain their separate existing flows.

The installation check reads only the expected bundled skill files in the selected
project or application workspace. It does not execute Claude, inspect transcripts,
change files, or grant observation authority. Missing installations offer a quoted,
project-only command; existing, different, incomplete or symlinked installations
are preserved and need review. Expand **View installation command** to inspect it.
Installation is checked again on the normal UI refresh; copying is not confirmation.

For an already authorized route, **Copy connection prompt** fills the selected
project ID, task ID and current local server origin. Invoke it in a separate fresh
Claude working session. Hooks register on invocation, so current-session evidence
is pending beforehand; users do not supply receipts. The server separately confirms
native identity, durable task binding and active collection. A family connection
already starts authorized observation, so there is no second start button.

**Installation and connection diagnostics** separates configured version, unknown
installed version, project package, session, task binding, collection and source
trust. Installation does not widen the admitted ordinary Claude source/binary scope
or establish native qualification.
Failed connection attempts retain a sanitized blocker code in the local task UI.
No command or project path is included in measurement records or shared reports.

Starting, measuring, paused, revoked and ended remain distinct. Active collection
without usage shows **waiting for first usage**, with unknown cost rather than zero.
Pause/resume uses the existing binding controls; a required reconnect provides the
parent prompt only if authorized. Claude and metadata hooks may continue while
paused. Revoked authority cannot be restored by this card, and paused/offline usage
is never backfilled. Desktop behavior is the validation target for this flow.

1. In **Tasks**, select **New task**. Enter a recognizable name and project, then
   select **Measurement criteria for tasks**.
   Optional settings contain type, size and the automatically read baseline.
2. Select **Prepare measurement**. The task is registered and automatically
   assigned to A/B. Internal IDs are generated; no observation interval starts.
   The task detail always shows **Assigned harness**: the A/B role, harness
   version, application method and the connection steps for that method. For
   family and agent-applied routes it also shows a copyable `harness-connect`
   request and the reason when connection is not yet available. Showing these
   steps grants no source authority.
3. Apply the prepared configuration. Only the reviewed managed instruction file
   can change; unapproved existing contents and common-file drift block writes.
   The task list and detail show **Waiting for session**, not **Draft**, for real tasks.
   Synthetic tasks instead show **Validation configuration ready** and a validation-only
   next action; their outcome blockers do not request a native connection.
   Next action follows the enabled preparation, ticket or connection step;
   measurement controls appear after connection. Candidate family pilots use their
   separate authorized harness-connect path, not an external ticket.
4. Get new-session instructions. Copy them to your usual terminal and open a
   fresh session yourself. Production handoff requires the reviewed canonical
   Codex 0.160.0 binary hash; it never falls back to an older PATH binary.
5. Select the exact session file and connect it. A one-use ticket binds the fresh
   root and native developer fragment to this preparation. Prior usage is excluded.
6. Start observation and wait for the in-progress state before doing the work.
   Pause stops observation and active time, not the external AI. Resume establishes
   another future-only baseline; usage during pauses is not backfilled.

The operative deadline starts at the first verified connection and survives
reconnection and rework. Active measurement time is not human labor time.
File preparation, native input evidence and actual tool use are separate facts.
The actual native startup order before work remains unverified. This ticket path does not support external Claude
or IDE collection; the admitted tool-launched Claude parent
workflow is a separate path.

## Agent names in the session family

For linked families, the agent column shows verified Codex nicknames with roles,
or Claude agent types and configured names. Models from eligible observed usage
appear in a separate column; no observed model displays **Unknown**. A model
change can show several models for the same session.

Missing names display **Child N** (or **Parent** for roots). Child numbering
counts children only. Duplicate names receive a short identifier derived from the
full session identity. UUID/member identifiers still control relations and usage
aggregation. Labels never merge sessions.

Names are saved when the member is linked and survive restart. Existing records
without names remain usable and retain their fallback labels. No conversation,
response, file content, title or historical name search supplies a label. These
local binding fields are outside measurement exchange. Existing source admission,
partial-cost and collection-scope limits still apply. See the
[metadata source evidence](../validation/agent-display-metadata.md).

## Decide the result

After observation settles, decide success, same-request rework, failure or
abandonment in the detail view. Successful confirmation records the reviewed
criteria as fulfilled; optional details expose per-criterion assessment. Success
is final for this task. Rework before finalization keeps the assignment, window,
previous usage and attempt history. Added requirements belong in a new task.
Leaving the page keeps the result undecided. Agent exit never records success.

Before preparing another task in the same project, stop the external AI yourself
and confirm it stopped. This releases preparation ownership; the UI does not kill
that process or silently replace its harness. Existing preimage checks still apply.

## Prices, recovery and local boundaries

Reference prices use the tool-owned approved update source. Configured does not
mean reachable or latest; refresh failure retains cached prices and pinned task
bases. Cost is only the partial estimate for observed, matched usage. Unknown
prices retain usage observations. Complete cost and inferential adoption remain
unavailable. See [reference prices](reference-price-catalog.md).

Reload restores saved tasks and user-confirmed results. A disconnected browser
shows stale values and disables writes until a fresh read succeeds. Service
restart does not automatically resume an observer. Explicit recovery fences an
abandoned collector and records a gap before a new baseline. Confirm the previous
observer is no longer running before using that action.

The initial render shows loading while bootstrap is pending, with writes disabled.
Only a successful empty read shows the first-task prompt. A failed read shows the
service warning; retained results remain stale until a fresh read succeeds.

Task writes check the current control version against concurrent CLI/window
changes. Usage updates do not invalidate pause controls. Durable action keys
prevent repeated clicks from performing the same action twice. Ambiguous actions
are reported rather than automatically retried.

The service binds only 127.0.0.1 and checks Host, Origin, CSRF and bounded typed
request bodies. No arbitrary shell or browser-supplied source URL exists. Native
pickers use constant local dialogs; cancellation makes no task transition. Private
names, setup paths and start commands live in a separate UI database, outside
measurement exports. Keep that database with the measurement Store when moving
this local installation; do not share it as a measurement report.

Portable harness pairs use the separate [harness configuration workflow](harness-config.md). Select the shared comparison file, then explicitly bind an existing reviewed local template. Import creates no measurement registration.

## Agent application comparisons

An assigned task from an instruction-only comparison can receive agent-application
authority with `POST /api/tasks/<task-id>/application-mode` and
`{"mode":"agent_applied"}`, using the same CSRF, `If-Match` and idempotency guards
as other task actions. It is accepted only before start instructions, connection,
observation or an outcome exist. The comparison file, shared setup, frozen protocol
and assignment are not rewritten; the task gains its own application record and a
private `mode-change.json` note, and its earlier instruction preparation becomes
unverified. Files written by that earlier preparation, such as
`.harness-delta-managed/active-instructions.md`, stay in place and are no longer
used for this task. Repeating the request finishes a change that was interrupted
after its record was reserved. Source gates are unchanged and the change cannot be
reversed.

Explicit format-2 `agent_applied` comparisons preserve assignment and select an
existing checkout/worktree and agent. Select **Check current branch/worktree** to
inspect the branch and path. Select **Apply**, review the branch, worktree, harness
and agent in the dialog, then confirm with **Apply**. Any installed agent may
apply the harness; it does not have to be the task's measured agent. The measured
working session is still connected with the task's agent. When the same agent
applies, the application session must have a verified identity so it can be
told apart from the measured session. A different agent can never be the
measured session, so its application identity is not required. In both cases
only a fresh session opened after the application can be connected.
Successful preparation
requests a fresh application session when automatic opening is supported.
Otherwise, copy the application context and open the agent yourself. Let its agent apply the
procedure directly with native permissions. The UI reviews actual files afterward;
there is no server publish approval or agent execution control.
Returning from the applying agent immediately refreshes the selected task. The
working-session dialog opens once per completed attempt; ordinary polling does
not reopen a dismissed dialog. Its guidance identifies missing application
identity and qualification before suggesting a connection. File verification
alone does not enable collection.

macOS Terminal opening with an installed CLI has synthetic wiring coverage and
unverified native acceptance. Other platforms and desktop prompt deep links are
unsupported. Checks remain agent reported and file verification covers the reported
set. Abandonment invalidates the attempt; stop the agent in the native window.
Existing edits remain. Copy populated harness-connect guidance to a separate fresh
working session. Identity/loading/source gates remain explicit and qualification
pending. See [the flow and limits](harness-config.md#6-agent-application-format-2).
