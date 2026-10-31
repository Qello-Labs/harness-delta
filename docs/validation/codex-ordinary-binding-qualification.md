# Isolated ordinary Codex binding qualification

This checkout provides a bounded qualification runner for the ordinary interactive
Codex CLI candidate, separate from production admission. Preparation runs no native
product or model. Execution requires explicit consent for the frozen intent and an
interactive terminal. The public command has no synthetic-mode switch.

The historical candidate is Codex 0.160.0 on macOS arm64, binary SHA256
`112fae7a5a1223e673c8a1791d32338f37df8b527ff1159bb8adac6c4dbf1b4b`.
The separate 0.162.1 candidate pins macOS arm64 binary SHA256
`74c6a6d263f40d65f99c27a815275f5b4ed0bcc2baecc396b4cf3255498bdfc0`.
Select it explicitly with `--product-version 0.162.1`; omitting that option
retains 0.160.0. The target version is frozen in the intent, protocol, workflow,
metadata recorder and lease. The 0.162.1 ordinary TUI uses `--no-daemon` so the
owned trial does not attach to a shared background server. Neither candidate
opens ordinary admission beyond the separately qualified 0.162.1 bounded profile
described below.

The `--route ordinary_admission` option selects the qualified exact
`codex-binding-01621-direct-family-v1` functional-pilot profile and the code-owned
ordinary provider. It passes no qualification lease to the domain or binding
service; the runner retains separate owned-run safety guards for limits,
immutable intent, task scope and emergency termination. Those guards never grant
source access. The default `--route qualification` retains the historical route.
Select the exact registered version with the ordinary option; the default remains unchanged.

Codex 0.163.0 is a separate exact bounded ordinary profile, pinned to macOS arm64
binary SHA256 `8813367285524ac798dd96d1b071aea30d58708c7226fd236cd275cf1cfdee31`.
Its same-release executable sibling `codex-code-mode-host` is also required,
SHA256 `79f123a85dbc61e8f5d0f0c050dfc3f4b81a8305d33a32b41e008b7f6e035698`.
The official platform package ships both; the standalone Codex archive does not.
Preparation refuses a missing, non-executable, symlinked, writable-by-others or
unreviewed host before creating the intent. Its canonical path and hash are frozen
in the intent and rechecked before execution. `--no-daemon` does not remove this
owned execution-host requirement.
Select `--product-version 0.163.0 --route qualification`. It uses the reviewed
staged connection recipe, one-command network approval, notification handling
and 900-second / ten-observed-request / 200,000-observed-token envelope described
below. It does not use the failed external `sandbox-exec` startup environment.
The native CLI's read-only sandbox and on-request approvals remain in effect.
Its qualification-route native trial passed fresh receipt/family usage reconciliation
and owned termination on 2026-10-16: three exact linked sources, six observed requests,
and three connection-baseline requests excluded. The separate
`--product-version 0.163.0 --route ordinary_admission` trial subsequently passed
without collection qualification authority; see [the exact acceptance below](#2026-10-16-ordinary-route-acceptance).
Only future observations under this exact binding profile receive verified provenance.
Earlier candidate observations, file/workflow compatibility, existing versions,
defaults and historical evidence remain unchanged. Preparation, synthetic regressions
and the earlier ephemeral startup smoke are not substitutes for either native trial.

The [2026-10-13 ordinary-route acceptance](#2026-10-13-ordinary-route-acceptance)
proves that exact route on the pinned native binary, with independent review.
The earlier lease-gated evidence and Node fixtures cannot substitute for this run
or qualify a different ordinary profile.
Synthetic results may set `ordinary_path_verified`, but only real execution can
set `ordinary_admission_verified`; preparation always reports the latter false.
All such observation still has partial cost. No successful family reconciliation
establishes all attempted requests, durable final delivery or complete task cost.

The 0.162.1 argv also supplies a session-only `projects` inline table marking only
the new canonical disposable project as trusted. It does not save folder trust
in user configuration or change the read-only sandbox/on-request approval policy.
Execution rejects any `.codex` entry inside that project before reservation,
because trusting it could load project configuration that the intent did not freeze.
This exact flag is frozen with the implementation; an older consumed intent
cannot be reused after changing it.
The new 0.162.1 plan also enables `exec_permission_approvals` for that session
only. This feature is default-off and `UnderDevelopment` in the
[pinned source](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/features/src/lib.rs#L1284-L1307).
Its frozen `helper_network_permission` is `single_command_network_only`.
The frozen `connect-once.mjs` program inspects and then connects only if inspection
succeeds, in one command requesting
`sandbox_permissions: "with_additional_permissions"` and
`additional_permissions: {"network":{"enabled":true}}`. Omit `file_system`;
the [network overlay preserves the existing filesystem policy](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/sandboxing/src/policy_transforms.rs#L582-L643).
Approve only that execution, with no reusable prefix, turn or session grant.
This is command-wide networking, not a host/port restriction; without proxy
enforcement macOS permits inbound and outbound networking for that execution.
The reviewed helper itself targets only the fixed loopback UI and rejects redirects.
Managed proxy/local-binding restrictions can still block it. Do not fall back to
`require_escalated`, which removes the filesystem sandbox, or change proxy policy.
The 2026-10-13 accepted trial observed the exact network-only command approval
and successful loopback connection on the pinned target binary.
The historical 0.160.0 plan does not enable this feature and records permission `none`.
Preparation freezes the connector path and SHA alongside the installed package.
The only runtime argument is `--receipt` with the current native opaque UUID.
At the native approval screen, approve only the pinned Node executable running
that exact connector and receipt, with no extra flags or chained commands.
The human approver is the only control over the number and kind of grants:
deny a second network request, filesystem grant, unsandboxed escalation or
reusable grant, and stop the owner if work/children continue after a blocked
connection. The prompt and source-side request ledger cannot enforce these
rules before a session is linked.
This qualification pins root and both children to `gpt-6.1-sol` / `high`; it does not change
the portable skill's model policy or require contributors to install that version.
A different binary/runtime needs separate qualification. Claude ordinary-session
binding remains a separate candidate; this command does not qualify it.

## Prepare and review

From this checkout, use Node 24 and an existing Python 3 with its standard library.
Build the checkout before preparation. No new Python package is required.

```sh
npm run build
node scripts/codex-session-binding-qualification-command.mjs prepare \
  --directory /private/tmp/harness-delta-binding-qualification-unique \
  --product-version 0.162.1 \
  --binary /absolute/path/to/reviewed/codex \
  --codex-home /absolute/path/to/existing/codex-home
```

Paths must be canonical (on macOS, `/private/tmp` rather than its `/tmp` alias).
The directory must not exist. Preparation creates a private disposable Git project,
empty baseline commit, installed skill copy, exact hook wrapper/recorder, fresh
measurement/UI stores, and `execution-intent.json`. It registers one draft
functional-pilot task with a fixed assignment and price table. The protocol's
allocation boilerplate does not authorize multiple native runs or statistical use.
Preparation leaves configuration application to the browser, outside the native
frozen native clock. Preparation only checks the existing native sessions directory's path; it does not
scan it, read conversations/credentials, or launch Codex.

Review the entire intent and printed ordinary CLI arguments. The intent freezes
binary, Node, Python, independent PTY worker, recorder, installed package tree and
implementation hashes. Execution rechecks those bytes before consuming a one-use
reservation. A changed helper or recorder is drift even when its wrapper is unchanged.
The same reservation cannot be retried; another attempt needs a new reviewed intent.

Before requesting native approval, start the narrow preparation UI:

```sh
node scripts/codex-session-binding-qualification-command.mjs prepare-ui \
  --intent /private/tmp/harness-delta-binding-qualification-unique/execution-intent.json
```

Open `http://127.0.0.1:4319`, select the exact draft task and apply its configuration.
Only that task's Apply action is permitted; no source picker, connection, launch,
extra task or online price refresh is enabled. Stop this server before execution.
The intent stays unreserved and no native process starts. Task creation was done
by preparation, not by this browser click. Execution rejects an unapplied task.
The default 0.162.1 qualification route retains compatibility-unverified
own-response parser provenance from 0.160.0. The accepted ordinary profile uses
separate `codex_binding` provenance. Preparation does not promote historical
observations or broaden the ordinary root-only human pilot.
A functional-pilot protocol with this exact version and single own-response
profile may also create and apply a source-free task through ordinary preparation.
That preparation grants neither ordinary binding nor ticket collection authority.

For 0.162.1 qualification, each source is projected with only its proved ancestry:
the root alone, or the root and that direct child. This preserves the existing
two-member forward-parser bound per source; the separate lease and receipt
metadata enforce the total one-root/two-child trial ceiling. An ancestor copy is
ignored, but a row naming a sibling is a scope conflict and invalidates the
candidate tuple. This does not extend the ordinary compatibility topology or
admit descendants.

After explicit approval, create a private consent JSON file (`chmod 600`) with:

```json
{
  "intent_sha256": "<exact prepared intent digest>",
  "approval_reference": "<human approval reference>",
  "actual_model_run": true,
  "transient_hooks": true,
  "native_source_reads": true,
  "owned_process_termination": true,
  "network_command_permission": true
}
```

Do not create a consent witness before receiving that approval.
For the new 0.162.1 plan, approval must explicitly include the one-command
network scope and the witness must contain `network_command_permission: true`.
The historical 0.160.0 plan does not require that field. Metadata preparation
and approval of code/plan changes are not exact-intent native execution approval.

Before starting a new 0.162.1 execution, subscribe to creation of
`native-attention.json` in the prepared directory. Do not wait for newline output
from the TUI: approval screens may render without any newline.
This candidate freezes session-only `tui.notifications=["approval-requested","agent-turn-complete"]`,
`tui.notification_method="osc9"` and `tui.notification_condition="always"`.
An existing attention path is refused before consuming the reservation.
The owned raw PTY stream observes complete OSC9 framing across chunks and
discards its message bytes. It writes only the intent digest and notification
count in a private metadata file; ordinary text and OSC9 progress do not wake it.
After each notification, inspect the current terminal screen. Relay a pending
command, receipt and permission scope to the human immediately. For a completed
turn, verify connection and the idle composer before submitting the fixed work
input, or separately verify all three sessions' usage before normal quit. Do not
infer event type or usage from the notification message, which is discarded.
Arm a modify
subscription before responding so a later notification also wakes the operator.
The file is an untrusted attention hint, not proof of a particular pending command
or authority to approve it. Do not send Yes/Enter without explicit human approval
of the current native permission screen, and deny broader, repeated or off-plan
requests. File publication failure stops the owned trial; it does not grant anything.
The frozen deadline continues while approval is pending: 900 seconds for 0.162.1,
120 seconds for 0.160.0. A new duration requires a fresh reviewed intent and consent.
Synthetic PTY tests establish delivery mechanics only; the target's notification
and effective permission behavior still require the separately approved native trial.

In a terminal:

```sh
node scripts/codex-session-binding-qualification-command.mjs execute \
  --intent /private/tmp/harness-delta-binding-qualification-unique/execution-intent.json \
  --consent /absolute/path/to/approved-consent.json
```

The runner opens the ordinary interactive CLI under a controlling PTY, using
transient `-c` SessionStart/SubagentStart hooks and the canonical trusted-hash shape
for those exact session flags. It writes no permanent project hook/trust or global
configuration. If native startup still requests persistent folder trust, quit
instead of saving it. Authentication prompts are not bypassed or evidence of a
successful connection. Outside the separately reviewed one-command network scope,
do not broaden permissions or change permanent settings to make the smoke succeed.

In the new disposable root, observe the automatically submitted `harness-connect`
input for origin `http://127.0.0.1:4319`, project `qualification-project`, and the
exact prepared `task_id`, followed by the two fresh direct children. Do not submit
another connect or child-creation request. If permission, inspection or connection
is denied, unavailable or blocked, stop without retrying or starting children.
Exit normally after the bounded work
completes. Do no other work. The child does not invoke the skill. The installed helper uses the
native opaque receipt; cwd, guessed UUIDs or model self-report are not identity.
Open that loopback UI to inspect automatic family/partial usage updates.

## Bounds and ownership

### Manual first input in a human terminal

Preparation accepts `--start-mode manual` to freeze an explicitly manual startup.
This mode is available only for historical 0.160.0. The new permission-enabled
0.162.1 plan rejects manual mode before creating its workspace, since only
automatic mode freezes its bounded connector and permission instructions.
Omitting the option retains `automatic`. The selected `start_mode` is included in
the intent digest and printed preparation metadata; it cannot be switched at
execute time under the old consent. Old intents without this field parse as
automatic, while their existing implementation-drift checks still apply.

Manual mode removes only the positional startup prompt. The same ordinary TUI,
model/effort, transient hooks, source admission, owned PTY, lease, identity checks,
deadlines and teardown verification apply. It does not execute `codex exec`,
attach to an independently started process, or enable production binding.
The runner submits no initial model prompt. Native startup activity is not
established as zero account usage by this statement.

After fresh exact-intent execution approval and narrow folder-trust approval, the human
starts the existing `execute --intent ... --consent ...` command in their own
interactive terminal with Node24 and `TERM=xterm-256color`. Its inherited stdin
and stdout forward keys and screen output to the owned PTY. The human enters
`$harness-connect` with the exact prepared task/origin and hook-provided receipt;
the UI operator uses Chrome only. Do not enter additional model requests beyond
the approved recipe, reconnect twice, or start extra children. Preparation-mode
selection alone does not approve a model run or trust/configuration change.

Prepare the command, first input, browser and approval before execution. The
version-specific deadline starts at reservation, before TUI startup and human typing
(900 seconds for 0.162.1, 120 seconds for historical 0.160.0);
measurement pause does not pause that deadline or change physical usage limits.
The reviewed 0.162.1 stop envelope is root8/child1each/total10; the historical 0.160.0
envelope remains root4/child1each/total6. Both include excluded setup and resumed
baselines. The intended new work uses at most three root requests for connection
and three for a separate work turn, plus one request from each child,
not a request to use the extra stop headroom. A human
message is not necessarily one native model request. A connect-confirmation then
separate child-work turn may exhaust these stops before completion; sufficient
budget for arbitrary human flows is unverified. Do not silently extend limits.
Review the exact interaction and version-specific bounds separately
if complete human-flow validation needs more time or requests.

The human controls input, while the owner still stops on its safety/error/deadline
conditions. The 0.162.1 protocol's first-connection-relative collection window
is 900 seconds; the historical 0.160.0 window remains 180 seconds.
The independent native deadline is still 900 seconds from launch (120 seconds
historically), with no reset on connection, input or resume. Collection may not
continue past that deadline even when its own window ends later.
Chrome measurement pause stops collection without terminating the
agent. Emergency stop revokes the owned qualification; termination confirmation
failure remains a failed trial. After positively verified teardown, `results-ui`
supports human outcome/reload without native source reads.

In automatic 0.162.1 mode, the ordinary TUI receives a fixed connection-only prompt
naming the prepared task and `$harness-connect`. After successful connection and
completion of that turn, the operator submits the intent's frozen
`post_connect_input` once as a separate TUI turn. Do not append it to the
connection context: responses from that context remain excluded baselines.
Paste without a submit key (bracketed paste when supported), inspect the draft,
then press Enter in a separate action. The target's paste-burst detector can
treat a rapid text-plus-Enter stream as pasted text with a newline instead of
submission. Observe the sent turn and active work; composer text alone is not
evidence that the request started. Do not send a second work prompt.
The work turn requests two fresh children in parallel and one wait. After each
of the three linked sessions has measured own usage and the work turn has ended,
exit the idle TUI through its normal quit path; "stop" in a model prompt does not
exit the process. Enter the quit command and submit key separately, then verify
actual exit. The historical automatic 0.160.0 prompt remains single-turn.
Codex submits the automatic
startup input after session configuration; no long manual composer paste is
required. Preparation prints the exact argv for review and freezes the
implementation bytes. This is still the ordinary TUI, not `codex exec`.
Native submission, skill activation and hook execution must be observed in the
approved trial; source compatibility and synthetic argv checks do not prove them.
Offline late-row regressions use a trusted fixture callback after verified owned
exit and immediately before final projection. This makes the last-tick boundary
deterministic; the public CLI exposes no fixture switch or callback.

The in-process opaque lease is tied to the fresh reserved store/task/project,
assignment, price pin, new root/child identities and deadline. Browser/profile
fields cannot supply it. Native events keep their native product and the runner's
evidence says `real_operations`; controlled Node fixtures say `synthetic`.
Default ordinary production binding remains gated, and existing admitted workflow
profiles are unchanged.

This smoke permits one root, two direct children and depth one as test bounds.
The product still targets multiple verified descendants. The new 0.162.1 stop
limits are root eight, each child one and total ten observed own request IDs;
0.160.0 retains root four, each child one and total six.
The 0.162.1 token stop is 200,000; 0.160.0 retains 100,000 input-plus-output tokens.
Both count all own requests,
including excluded pre-connect/restart baselines and continued old contexts. Cached input and reasoning
are not added again. The native owner has a 900-second deadline for 0.162.1
(120 seconds for 0.160.0) and at most a
five-second teardown budget, with up to two seconds TERM grace followed by KILL. Cleanup
discovery, identity checks and disappearance checks share that original budget.
Discovery and TERM authorization also consume the TERM grace measured from
cleanup entry; they do not start an additional grace clock afterward.
Queries use its remaining time; exhaustion or query failure leaves termination
unverified. A final nonblocking root reap also runs when polling time is exhausted.
Operating-system scheduling can delay returning the failure result. Observed limits
can overshoot because logs/backend requests are asynchronous. There is no hard
subscription, billing or dollar cap and no guarantee about backend cancellation.

The Python standard-library PTY owner survives observer exit through control-pipe
EOF and enforces its own deadline. It samples only fresh owned descendants' scoped
PID/PPID/PGID/UID/start metadata, never command arguments or unrelated sessions.
It retains the exact parent PID/UID/start identity that established each fresh
descendant, rechecking that parent around admission. Multiple groups are supported
only for these proved descendants. Before a group signal, scoped membership queries
must agree and every returned member must match an established PID/UID/start
identity and its current group. Only a proved current leader permits the group
signal; without a leader, only individually verified members may be signaled.
Unknown members, reused/conflicting identities, failed queries and incomplete
coverage fail qualification. No executable purpose or benign helper role is inferred
from ancestry. This is sampled OS evidence, not an atomic guarantee against every
future unobserved process or backend operation.
It positively checks root exit, all observed groups' disappearance and known members'
disappearance within the unchanged budget. Positively absent identities are not
queried or signaled again; a reused PID is foreign. A proved member changing its
group alone does not force failure. `ownershipVerified` states the proof result;
the historical `escapedMemberObserved` field retains the observation of a non-root
group. Historical failed trials are not reclassified by this prospective contract.
Private evidence distinguishes fixed-deadline termination from observer failure.
It also preserves the first observer stop reason separately from the final result,
and the first background collector error as a fixed allowlisted code or
`unknown_collector_error`. Arbitrary error text, stack traces and source bodies
are never retained; a later termination failure does not erase these diagnostics.
The first monitor stop also retains `stop_witness`: a fixed predicate and the
in-memory root/each-child/total own-request counts, excluded-baseline counts and
input-plus-output tokens. All simultaneously reached limits are listed. A collector
rejecting an over-limit record retains its first attempted counters separately from
the accepted ledger. This does not admit that rejected record, change any limit,
reset authorization, or reread paused sources. Missing witnesses remain null;
measurement rows and these safety counts do not establish whole-account usage.
It retains at most 16 group transitions from already sampled owned-member
PID/PPID/PGID/UID/start metadata, established parent identity and relative sample
time, with an explicit truncation flag. Membership queries are limited to those
observed groups; no command arguments or session content are added. A recorded
group transition does not identify a benign helper or bypass ownership checks.
A failed ownership/teardown check cannot count as a successful run. Unknown escapes
or provider-side work are outside this process proof. UI pause/receiver close alone
is not proof that native work ended.

Normal measurement pause retains the owned CLI and its original wall-clock
watchdog. It closes the active observation interval and prohibits source-body
reads. The separate emergency-stop action terminates the owned native process.
Resume revalidates only the same live owned root's stored receipt, preserves task,
assignment/price pins and cumulative safety ledger, and baselines all known members.
Repeated cycles never reset the frozen native clock or request/token limits.
A continued pre-baseline context is excluded from measurement and retained as
separate safety metadata on the next authorized active read. Faults still stop the
owner; expected pause gaps remain partial.

Source-derived safety counters cannot be monitored while paused. Resume baselines
or final active-source reconciliation include excluded requests in safety bounds.
If the CLI exits while paused, no final body read is allowed: evidence reports
`safety_usage_verification: unverified` and `task_paused_no_source_read`. No hard
counter/billing guarantee is claimed. A smoke may pause/resume without issuing
extra work during pause; that proves UI transitions, not actual paused-usage exclusion.

The collector reads only exact new hook-supplied sources in the frozen root scope:
one root plus two child files, with the metadata ceiling checked before any
fourth header/body read (including conflicting receipt renewals); first header at
most 64 KiB, each source at most 8 MiB. It never scans old transcripts
or queries the native state database. After owned termination, a separate provider
projection of those exact three sources checks identity/ancestry, final gaps, every
own request's model/effort/counters, request/token bounds, and agreement with stored
observations or explicitly excluded baseline IDs. Late unmatched usage fails;
Coordinator-added source compatibility must match the code-owned decision and
every immutable session pin before final source reads. Reconciliation compares
native readings with that expected provenance, not by ignoring stored provenance
or depending on JSON property order.
pre-connect baseline usage stays excluded from measured usage. No prompt, response,
source code or raw rows enter measurement/report diagnostics.

`evidence.json` records fixed failure reasons, phase, source/counter reconciliation,
family counts and verified process result. It is immutable and private. Human
completion remains separate. After positively verified teardown, reopen only
source-free records and human outcome actions:

```sh
node scripts/codex-session-binding-qualification-command.mjs results-ui \
  --intent /private/tmp/harness-delta-binding-qualification-unique/execution-intent.json
```

Per-session and sum rows show eligible own requests, input/output and pinned partial
estimated cost. Missing, observed zero and unpriced values remain distinct. This
results server cannot read native sources, launch or reconnect. Refreshing it
retains the recorded outcome. The accepted ordinary route attests only this exact CLI
root/direct-child acquisition case: it does not admit other ordinary routes, wider topology,
Claude, IDE/MCP/system agents, complete cost or inferential adoption decisions.

## Local verification

Measurement pause stops binding collection before writing interval diagnostics.
If a clock regression prevents a valid gap or lifecycle transition, bindings stay
stopped with an unknown interval, the operation reports its error, and the task
may still display its previous lifecycle state. No timestamp is clamped and no
interval is backfilled. Retry the pause after resolving the clock error before
reconnecting. An in-flight read or child discovery cannot restore collection.
Normal measurement pause keeps the owned agent alive; the qualification owner's
separate deadline and emergency/fault controls still apply.

Lease generation and family pins are adopted only after the corresponding binding
transaction commits. Failed binding writes cannot advance those pins. Qualification
evidence retains the first fixed diagnostic stage/code separately from overall
termination failure; arbitrary error messages and stacks are excluded.

The measurement product has no qualification request limit. The new 0.162.1
qualification owner stops at observed root8 or total10; 0.160.0 retains root4/total6.
The 0.162.1 token stop is 200000 input/output tokens; 0.160.0 retains 100000, including excluded setup
requests. These are conservative stop thresholds, not promises that every workflow
within those counts will complete. The collector can accept the boundary record
while the next owner monitor sample stops execution. The fixed two-turn plan does
not remove the version-specific stop rule or establish a minimum native
request path. A different trial budget/interaction recipe requires separate review
and approval; do not change `>=` to `>` to claim native success.

An independently started human terminal cannot issue the qualification route's
lease. That route remains gated to the isolated owner and frozen one-use intent;
the accepted ordinary profile uses its separate code-owned authority instead.
Human terminal operation through the qualification owner would retain
its fixed initial prompt, stop thresholds and verified cleanup; it is not a
general user-managed-terminal admission or a way to bypass production gates.

Before native approval, run harmless fixtures on Node 24:

```sh
npm test -- tests/owned-cli-invocation.test.ts \
  tests/codex-binding-qualification-versions.test.ts \
  tests/codex-session-binding-qualification.test.ts \
  tests/session-binding-service.test.ts tests/session-binding-api.test.ts
npm run lint
npm run typecheck
npm run build
```

The fixtures use Node payloads and fresh synthetic transcripts through the actual
recorder, portable helper, loopback server and leased collector. They cover positive
controlling-terminal behavior, ignoring/escaped children, observer exit, deadline,
replay/consent/package drift, excluded baseline and late requests/runtime/token/gap
writes. They make no native/model calls and do not establish native qualification.
Independent review is required under the repository workflow.

See [source acquisition evidence](codex-ordinary-hook-source-acquisition.md),
[the portable runbook](../runbooks/harness-connect.md), and
[the binding decision](../decisions/012-session-family-bindings.md).

## 2026-10-16 ordinary-route acceptance

The separate Codex 0.163.0 ordinary-route trial completed on macOS arm64 / Node 24,
using the exact CLI and code-mode host hashes above. Its immutable intent SHA256 is
`a8add9d20b6c7c7845090c70b4896d0b6922acfdb916495b81ec71dc4281683e`.
The ordinary domain and binding service received no `qualificationLease`,
`humanPilot` or `nativePilot` collection authority. Code-owned exact protocol and
provider gates, frozen configuration, registered scope and owned safety observation
remained active.

After one human-approved network-only connector, a fresh root and two fresh direct
children used gpt-6.1-sol/high. Independent post-exit reconciliation matched all six
observed own requests (root four, children one each) from three exact linked sources:
nine native-owned requests minus three excluded connection-baseline requests.
Observed input was 129848 tokens and output 227; the trial's frozen-price partial
reference estimate was USD 0.0995084, not vendor billing.
Native exit was 0; ownership, controlling terminal and termination were verified
for thirteen owned members. Result fields were `status=completed`,
`ordinary_admission_verified=true`, `ordinary_path_verified=true` and
`safety_usage_verification=verified`, without collector or observer errors.

The trial ran with the new record still unqualified. Its original unverified pins
and observations remain immutable; they are not rewritten by the later exact
`codex-binding-01630-direct-family-v1` admission. Only new ordinary observations
under that profile use verified provenance. The earlier qualification-route trial,
synthetic regressions and startup-only smoke are separate evidence.

The retained `binding_unobserved_context` gap is not backfilled. Costs remain
partial, `complete_cost=null`, with no inference or whole-task completeness.
Resume, deeper/additional descendants, incomplete-response completeness and
tool-owned launch are not admitted. File/workflow compatibility windows, historical
0.162.1 evidence/defaults, task/price pins and global installations are unchanged.

The 2026-10-31 synthetic guard regression enforces this profile's existing
paginated inherited-history exclusion, including a verifiable direct-child own
suffix: no child usage is persisted, and `candidate_unsupported_history` is
recorded at family enrollment, observer reconnect and every later read.
Fresh-child collection and known partial usage after a compaction boundary with
new runtime context retain their existing semantics. This is not a new native
trial, history qualification or change to the shared 0.160.0 suffix parser.

## 2026-10-13 ordinary-route acceptance

An explicitly approved fresh `ordinary_admission` intent passed on the pinned
macOS arm64 Codex 0.162.1 binary with `gpt-6.1-sol/high`, read-only/no-daemon
invocation, one fresh CLI root and two fresh direct children without inherited
history. The domain and binding service received ordinary source authority, not
a qualification lease; separate owned-run guards enforced the frozen trial limits.
This controlled synthetic work used the actual native backend, not a mock executable.
It qualifies only `codex-binding-01621-direct-family-v1`.

The accepted intent SHA256 is
`bc6a3cdca7f0750c901e3f95087f63b34e5ecd6c1584fdae78f2729145f9fc2e`;
its frozen implementation SHA256 is
`8d6afc8d788d9967f34782f9b1b89247d3a285b0c9b62beb6f036e27115cd312`.
The code-owned admission cites this ordinary-route intent, not the earlier
lease-route intent. Historical evidence, frozen intents and measured provenance
are unchanged.

SessionStart delivered the verified root receipt; the root connected once through
the pinned helper after separate human approval of its current network-only
command screen. SubagentStart receipts and materialized native sources linked both
fresh direct children automatically. No child invoked the skill, no second helper
grant was requested, and no permanent trust or global configuration was changed.
The pinned native OSC9 approval and turn-complete notifications were observed.

| Measured source | Own requests | Input tokens | Output tokens |
| --- | ---: | ---: | ---: |
| Root | 4 | 89616 | 193 |
| Direct child A | 1 | 19995 | 22 |
| Direct child B | 1 | 19998 | 21 |
| Observed sum | 6 | 129609 | 236 |

Independent final reconciliation covered exactly these three newly linked
sources: nine native own requests, six measured request matches and three
explicitly excluded pre-connect baseline requests. The database retained six
request keys and six distinct event IDs, matching the six observations; refresh
and collection did not duplicate them. Every measured payload matched its own
native source, runtime and immutable compatibility pin. The baseline exclusion
remains `binding_unobserved_context`; it was not recovered or counted as zero.
All native own requests, including excluded setup, passed the frozen request/token
checks. Normal TUI quit produced exit 0 with ownership and termination verified,
and `ordinary_admission_verified` and `safety_usage_verification` passed.

Source-free results UI QA confirmed the desktop per-session counts and sum,
partial estimated cost USD 0.0577764, no native launch/resume authority and no
fabricated human task outcome. At a 390px mobile viewport, all three session
counts and the sum rendered, but the page overflowed horizontally to 499px
(425px family table). This is a recorded nonblocking results-layout limitation.
Independent review accepted the bounded ordinary evidence and replacement of
the historical citation with no new material source/authority finding.

This evidence does not qualify another version, model, effort, platform, IDE/MCP
source, resumed/history-bearing family, third child or nested topology. Other
file/launch observations keep their previous trust. Ordinary cost remains partial,
complete cost and inferential adoption remain unavailable, and observed thresholds
are not hard request, token or billing caps.
