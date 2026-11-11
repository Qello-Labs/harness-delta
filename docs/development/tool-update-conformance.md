# Admitted Claude localhost conformance runner

[한국어](tool-update-conformance.ko.md)

This developer runner ports the bounded synthetic print-mode scenario for the
already-admitted Claude Code 2.1.306 image. The code and synthetic tests are
available; actual-binary acceptance of this repository-owned runner is pending.
It does not admit an unregistered version or change defaults, ordinary
qualification, interactive support, authenticated support or complete-cost claims.
See [discovery and static assessment](tool-update-pipeline.md) for the first stage.

## Execution requires separate approval

### Execution-disabled Codex root-window preparation

`scripts/tool-update/codex-window-conformance.mjs` is a separate private
development command for Codex 0.167.0, `codex_binding`, collect/root,
`codex-binding-root-window-v1`, macOS arm64 and Node 24. It is not an admitted
target or an extension of the Claude runner below. Execution is disabled
unconditionally. No B1 issuer or vendor spawn is enabled:

This is execution-disabled preparation, not B1 readiness. Correcting offline
defects does not authorize any vendor attempt, including `--version`.

```sh
node scripts/tool-update/codex-window-conformance.mjs execute
```

Expected: exit 2 and a fixed JSON refusal with `code:b1_execution_disabled`,
`execution_attempted:false` and `actual_qualification:false`. Supplying consent
JSON, an intent, an approval flag or an expired/reused packet cannot unlock it.
`verify-cleanup` is only the read-only registry audit described below; it never
launches a vendor process.

Offline preparation accepts an explicit private plan and an existing empty case
directory, using canonical absolute paths. Both parent directories must be owned
0700 directories; the plan must be a regular exclusive 0600 file, at most 16 KiB.
It writes `intent.json` exclusively and does not inspect a vendor image or source.

```sh
node scripts/tool-update/codex-window-conformance.mjs prepare \
  --plan "$plan_file" --case normal --out "$owned_case"
```

The strict plan has `schema_version:1`, `product:codex`, `version:0.167.0`,
`commit:086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a`, `route:codex_binding`,
`policy_id:codex-binding-root-window-v1`, `operation:collect`, `topology:root`,
`runtime:node24`, `platform:darwin_arm64`, `model:gpt-6.1-sol`, `effort:high`
and `pins`. The eleven SHA-256 pin names are `native`, `host`, `source`, `build`,
`instrument`, `runtime`, `lockfile`, `config`, `environment`, `egress`, `quota`.
Preparation records these claims; it does not validate actual inputs, qualify
containment or issue authority. It returns `prepared_execution_disabled`.
An optional strict `inputs` object supplies `batch_root`, `prefix_root`,
`native_path`, `host_path`, `config_path`, `environment_path`, `profile_path` and
`quota_packet_path`, `native_manifest_path`, `native_manifest_sha256` and
`native_manifest_identity` for separate input preflight. Prefix and case paths must be
`batch_root/prefix` and `batch_root/cases/<case_id>`.

The separate verifier consumes an operator-supplied private packet; it never
issues consent or launches a process:

```sh
node scripts/tool-update/codex-window-conformance.mjs verify-consent \
  --intent "$intent_file" --consent "$consent_file"
```

The strict packet binds its UUID and approval-reference hash to the exact intent
bytes, case/root, eleven pins, collect/root scope and a lifetime of at most
1200000 ms. Intent and consent are owned single-link no-follow 0600 files in the
same canonical 0700 case directory, each at most 64 KiB. Verification consumes an
exclusive case-root reservation before input preflight; failure does not permit
retry with another nonce. Real preflight hashes the scoped files and current
source/build/runtime/instrument closure without executing the vendor.
Capabilities recheck expiry, file identity, unchanged packet/reservation bytes
and pins at use. The operator-owned packet is the approval trust boundary, not a
cryptographic human-identity assertion. No real B1 packet is shipped. Success is
`reserved_execution_disabled`, never permission to run this incomplete runner.

The private native manifest binds the full prefix inventory, the launcher and
sibling CLI/host, explicit process/runtime/system-tool sets, argv, configuration,
environment, profile and quota files. Revalidation checks bounded regular-file
bytes, hashes, modes, device/inode identities and directory entries, including
unselected resources. The pinned B0 inventory retains the recorded CDHashes and
signing metadata without executing a component or proving source attestation.
Runtime link records also bind declared dependency symlink identities and targets;
they do not make the host namespace immutable or replace independent closure review.
The sandbox process set contains only the native `codex` and
`codex-code-mode-host`; controller runtimes and system tools are separate
out-of-sandbox identities. The frozen entry argv starts with native `codex`,
not Node or `bin/codex.js`. A strict `launcher_input` freezes `argv_tail` and the
base environment. The static recipe preserves argument boundaries, resolves the
inventoried macOS arm64 platform package, replaces the four inherited package
manager markers and sets `CODEX_MANAGED_PACKAGE_ROOT`; its result must match the
frozen argv and environment file. The launcher is read and hashed, never run.
Ambient package-manager ownership heuristics, alternative vendor roots and the
required default `SIGXFSZ` handoff are explicit unqualified residuals, not reasons
to permit an interpreter. No live launch or launcher equivalence is authorized.

The byte oracle also has a real HTTP/1.1/SSE transport bound only to `127.0.0.1`.
Case listeners created from one batch share its counters and connection admission.
An unexpected refusal, deadline or protocol failure terminally stops the batch,
closes every associated listener/socket and refuses future cases or work.
Ordinary successful case closure does not stop the remaining cases.
It refuses Upgrade, CONNECT, HTTP/2, nonidentity compression and chunked
framing before body allocation. Header/body/request/response limits are
16/64/80/256 KiB, with at most 16 connections/requests per case, 112 per batch,
eight response slots and 32000 synthetic input-plus-output units. Cache and
reasoning are subsets, not additional usage. Interrupted terminal usage is missing,
not zero. No wire text is included in its numeric summary.

The synthetic metadata reservation is opaque and single-use. Only its fresh owned
`project/.harness-delta/window-receipts` path is writable: 0700 directories and an
exclusive no-follow 0600 control with the hook's exact seven keys, at most 4096
bytes. A consent-bound writer reuses that metadata-only lifecycle and revalidates
its opaque reservation. Every check/close also validates the original directory
and control device/inode, private mode/owner and bounded exact control bytes/size.
Substituted paths or symlinks refuse before enumeration. Stop/expiry inactivates
only proven original storage: `receipt_storage_changed` or `control_storage_changed`
reports unproven replacement rather than overwriting a foreign file or claiming
successful inactivation. Directory entry-count/size changes from legitimate
receipts are not mistaken for directory identity changes.
Receipt admission scans at most seventeen entries and refuses above sixteen;
this does not prevent the unchanged hook from creating a seventeenth file.
The production publisher is unchanged and remains inactive without a decision.

The synthetic-only collection bootstrap uses genuine project/task, exact-root
trial, connect/baseline and collect APIs in an isolated in-memory Store. It accepts
only a synthetic reservation, creates no product decision or comparison assignment,
and cannot authorize real collection. The unchanged hook emits metadata without
reading the synthetic native source. Collection begins only after its exact-root
trial and active task exist; replay does not double-charge usage.

The script-local TUI adapter runs only the fixed nonvendor test helper through the
unchanged Python PTY owner. Tests subscribe before spawn/input, distinguish normal
quit from control EOF, and retain only fixed statuses. Native TUI launch remains
disabled. The nonvendor path checks the owned launch's PID, parent, foreground
group, session, UID and start time again before one OS SIGINT; mismatches refuse.
A separate prearmed output event witnesses the fixture handler acknowledgement.
The correlation fixture releases a second fixed input through a separate barrier;
forced `write(false)` tests retain the real PTY and callbacks and verify no resend.
Owner, adapter, copied fixture, signal helper and process-tool pins are checked
before use. These checks do not claim atomic PID-reuse protection for a vendor.

Opt-in native exec/mapping qualification on macOS arm64/Node 24 is image-free
and generates a hashed deny-default inherited `sandbox-exec` profile. Writes stay
inside owned case roots; reads and executable paths are allow-listed; only
outbound IPv4 localhost TCP to the frozen oracle port is allowed; DNS and Mach
services are denied. An owned empty OpenSSL configuration avoids reading the
operator's global configuration. No sudo or global firewall rule is used.
Runtime files and dependency links receive literal permissions rather than
runtime-directory subtrees. Vendor execution is restricted to native
`codex` and `codex-code-mode-host`; Node, Python, other interpreters and the JS
launcher cannot execute inside this profile. All other vendor executable mappings are
denied, including `rg` and the voice components. Writable case roots cannot
supply executable mappings. Nonvendor copies qualify these denial paths.

The separate case-state quota qualifier creates a quota-bearing APFS volume
inside an owned image, reattaches only below an owned mount root, and uses a
private case directory on the exact 67108864-byte quota. It exercises direct and
descendant overflow, then positively detaches and deletes its owned image:

```sh
node scripts/tool-update/codex-window-quota-qualification.mjs --local-nonvendor --out "$quota_out"
```

An independent owner retains the live quota object. Before attachment, the
coordinator validates the exact root/image identity and acknowledges ownership;
later writable-path checks use the same owner over IPC. Coordinator loss leaves
that owner alive to verify exact volume/device membership, detach positively and
delete only its owned image. Private mounted/cleanup receipts record the result.
Under IPC supervision, `quota-mounted` is emitted only after attachment and path
verification; `quota-continue` releases the prearmed barrier. Local qualification
witnesses cleanup before terminating only the owned coordinator with SIGKILL.
This covers the finite post-attach path, not every interrupted initialization,
owner-SIGKILL takeover or simultaneous loss of all cleanup processes.

Its default tests use fakes and never mount images. This finite quota result
does not prove the separate evidence/overhead budgets, preventive process or
exec counts, receipt-creation count, or universal loss cleanup.

The following commands require a new canonical owned output path and explicit
local authorization. They execute only nonvendor probes, not a Codex image:

```sh
node scripts/tool-update/codex-window-qualification.mjs qualify-native --out "$qualification_out"
node scripts/tool-update/codex-window-image-owner.mjs qualify-loss --out "$loss_out"
```

Native qualification compiles owned C probes at the two selected native paths.
It checks native positive controls and direct/descendant Node, Python, writable
Node-script, Node-spawn, unselected vendor exec and native mapping denials.
It makes no network or oracle request and deletes its owned probe binaries.
Its `native_exec_mapping_verified` result is distinct from
`containment_verified`, which remains false: the historical sixteen Node-based
network/filesystem/quota controls do not qualify the tightened native profile.
The old `qualify` command is not an interpreter-allowing compatibility path.

The separate image-loss qualifier creates an owned 4 GiB APFS image.
The independent image owner uses an identity-checked attach handshake and verifies
detachment after normal close, control EOF and owned-owner SIGKILL. The actual
quota qualification entry uses its independent quota owner, so a surviving peer
can detach and delete after post-attach coordinator SIGKILL. Image mounting clears
the image owner's startup watchdog; its lifetime watchdog uses the original
remaining authorized deadline.
The legacy image-loss qualification covers those post-attach paths. The separate
guardian-first startup qualifier below covers finite initialization phases;
neither proves every interleaving or simultaneous loss of all cleanup processes.
Packets contain bounded metadata/statuses and always set actual-target
qualification false. Image-loss artifacts and failed packets remain private for inspection;
default tests use fakes and do not create or mount images.

The G1-G6 detect-and-stop guard modules below keep every preventive control above
and add no vendor execution path. `codex-window-case-guards.mjs` composes them for
one fixed synthetic `normal`/`hold` case: reserve the existing batch budget without
resetting its start, carry the observed exec total, durably register resources,
use genuine trial/source authorization, arm the watcher before fixture release,
then verify cleanup against the sealed registry. This pipe fixture does not
qualify vendor containment, PTY or native recipe composition, and issues no grant.

- G1 counts: `codex-window-watch.mjs` arms a native kqueue watcher before the
  owned launch and drains it in a dedicated native process that runs at
  `QOS_CLASS_USER_INTERACTIVE`. It counts execs, forks/live processes (with
  owned-tree reconciliation) and created receipts (vnode watch plus directory
  reconciliation). Every count is an observed lower bound (`lower_bound:true`):
  `NOTE_EXEC` can coalesce (a nonvendor probe saw 17 execs, one notification), so
  there is no at-most-one-extra guarantee. The first observed overrun triggers an
  identity-checked teardown of the owned tree, fails the case and stops the batch;
  the observed overshoot is recorded (`exec_overshoot`, `live_overshoot`,
  `receipt_overshoot`) and is a lower bound on the true overshoot. Any overrun
  fails the case. Watcher loss is guard loss and stops the batch.
  Spawned descendants are charged one exec when first seen (the kernel's
  has-exec'd flag, read after the watch is armed), in addition to later
  `NOTE_EXEC` notifications, so the 15-exec budget counts the first exec of every
  discovered child; a child that ended before it could be inspected is charged
  conservatively. A charge can therefore exceed the true exec count (a forked child
  that then execs in place is charged twice), while coalescing and undiscovered
  processes make it smaller; the figure is an estimate, not an exact count. The
  target runs in its own session and process group. Besides parentage
  reconciliation the guard sweeps that group and session every cycle, and sweeps
  the user's recently started processes that carry a per-run environment marker
  (`HARNESS_DELTA_WINDOW_OWNER`, injected into the target environment) about once a
  second and again before it declares cleanup. A live process whose ancestry does
  not reach the owned tree (for example one reparented to launchd before it was
  listed) is killed, counted as `unaccounted`, fails the case and denies
  `cleanup_verified`. A process that scrubs its environment, leaves the session and
  is reparented before discovery, or a platform binary that hides its environment,
  is not covered. The only permitted preexisting entry is `ordinary-window-control.json`, bound
  explicitly by device, inode, UID and birth time. It is not counted as a receipt;
  a missing or replaced control identity is guard loss.
- G2 timing: coordinator deadlines read a native `mach_continuous_time` clock
  (`codex-window-clock.mjs`). TERM/KILL dispatch latency and time to verified
  disappearance are measured; a measurement over its bound is a failed case, not a
  real-time guarantee. The protected PTY owner keeps its own local clocks, which
  this change does not replace.
- G3 consent fence: consent and trial authority are revalidated through the
  existing public seams before each source read and before commit. These checks
  are not atomic with the read or the protected Store transaction.
- G4 startup loss: the quota guardian starts before image creation and writes a
  hashed, append-only startup journal of create/attach phases, so loss in a
  journaled phase detaches and deletes by recorded identity. Recovery does not
  depend on the guardian: when the guardian exits without a receipt, the
  coordinator reads the journal and the pinned root, refuses an edited, moved or
  missing journal or an image whose identity differs, detaches only the whole disk
  whose mounts are all under the owned mount root (forcing only if a plain detach
  fails), and deletes the image. The same logic is the standalone entry
  `node scripts/tool-update/codex-window-quota-recovery.mjs recover ABS_ROOT`, for
  when the coordinator is gone too; run it only after the guardian and coordinator
  have exited. Guardian loss still fails the case. Local nonvendor qualification
  covers a finite set of coordinator kill points, a guardian kill with a live
  coordinator, and a double kill followed by `recover`, not every interleaving. The synthetic coordinator also waits for owner registration before
  image creation, image registration before attach, and device/path registration
  before admitting work.
- G5 overhead: evidence and case state use distinct 67108864-byte APFS quota
  volumes. Overhead accounting conservatively sums every explicit guard root and
  the whole allocated image, payload included, against a 134217728-byte hard stop,
  so a case that fills both quotas stops. Local nonvendor qualification checks both.
  Register every additional guard root explicitly; quota-root accounting alone
  does not prove total coverage. Closing the image deletes its evidence volume, so
  when an export root is supplied the executor first copies the bounded evidence
  out (`codex-window-evidence-export.mjs`): only plain, single-link JSON-object
  files of at most 65536 bytes with safe names, at most 67108864 bytes in total,
  into an empty private directory outside the image, with a manifest of sizes and
  hashes. Anything else refuses the whole export and fails the case. No export
  happens unless a destination is supplied.
- G6 cleanup audit: `codex-window-registry.mjs` keeps a hashed per-case registry
  of owned PIDs, images and paths. `verify-cleanup --batch <root> --consent <file>`
  checks positive closure read-only against it and refuses an edited or missing
  registry. It needs a separate external cleanup consent and a frozen native
  clock identity; no such packet is shipped.

Synthetic deadline checks use immutable `B=T0+1200000`, reserve 5000 ms teardown
and 10000 ms audit, admit only full cases, and shorten work on expiry. Final audit
uses its existing reserve without a second teardown window. Positive disappearance,
closed resources and restored terminal are separate from KILL delivery. These are
arithmetic/state checks; native clock semantics and measured dispatch require
separate nonvendor qualification.

Run the synthetic checks after the normal build:

```sh
npm test -- tests/tool-update-codex-window*.test.ts
```

For this work the local gate runs these focused suites on Node 24 and the full
`npm run check` on Node 26. The remote CI Node 24 full run is separate evidence.

The integrated local qualifier compiles only repository fixtures and creates an
owned APFS image. Run it only on macOS arm64 with Node 24 and a fresh owned
directory after the primitive prerequisites have been checked:

```sh
node scripts/tool-update/codex-window-case-guards-qualify.mjs --qualify-nonvendor --prerequisites-ready ABS_FRESH_OWNED_DIRECTORY
```

The guardian-loss recovery qualifier (a guardian kill with a live coordinator, and a
double kill followed by the standalone `recover`) uses the same preconditions and a
directory that does not exist yet:

```sh
node scripts/tool-update/codex-window-recovery-qualification.mjs qualify ABS_NEW_DIRECTORY
```

The readiness flag is a development precondition, not B1 consent. Default tests
use fakes and never mount an image or invoke `sandbox-exec`.

This is not native acceptance or B1 readiness. SBPL/APFS enforces the tested
filesystem/network boundaries. The fifteen-exec, sixteen-process and
sixteen-receipt budgets are detect-and-stop limits, not preventive ones. No
independent qualification review, complete vendor TUI/input sequence or
real consent-to-source commit integration is claimed.
The real execution command remains disabled, and no issuer or B1 approval exists. Default tests
use synthetic inputs and real loopback/nonvendor PTY fixtures only. Synthetic or
local nonvendor results never close actual-target qualification gates.
Real consent/source integration, independent input/runtime/system-tool closure review,
live admission/dispatch/termination/loss/broker/escape qualification against a
vendor, actual vendor executor/guard composition, and an externally authorized
real-batch cleanup audit remain prerequisites
to any vendor attempt, including `--version`. Consent does not implement those
missing guarantees. Preventing a seventeenth receipt from being created also
remains distinct from the tested admission refusal.

Known residuals of the guard modules, stated so they are not read as closed:

- The native qualifier is credit-paced for the exec, fork and receipt scenarios, so
  its small overshoot is produced by construction. The escape and spawn scenarios
  (reparent, setsid, posix_spawn and fork plus exec) run free, but no scenario
  proves free-running overshoot or coalescing under every load.
- `createWindowWatch` and the native `LAUNCH` start any absolute executable with
  the guard's own environment (plus the owned marker) and working directory, and
  need no consent capability. Only the synthetic case calls them, with its compiled
  fixture. A vendor composition must pin the executable to a registered identity
  and set its environment and directory independently. The development consent
  writer used by the synthetic qualifier unlocks nothing: non-synthetic origins and
  every scenario other than `hold` are refused.
- The native guard is compiled and exercised only by the Node 24 local qualifiers,
  not by default tests, so a regression in the C file is not caught by CI.
- The image owner now reports a positive detach by recorded identity even when the
  mount was never acknowledged (`image-owner`: `detached` without `mounted`). A
  loss before the mount still deletes nothing it did not verify, and `ready` still
  rejects.

Do not execute the runner merely because discovery found a candidate. A human
must approve the exact image, runtime, scope, model, pins and stopping budgets.
The runner does not create or refresh an approval record. An `approved: true`
field is not a substitute for that human decision.

The only lane is macOS arm64, Node 24, manual localhost synthetic print mode:

- Claude Code 2.1.306, SHA-256
  `b5d795b7760032d79954b55a9cd1876dcf3a8dc9608fd6bb9f618593f69fd44b`.
- Executable size 272984176 bytes, exact existing ordinary profile
  `claude-binding-2-1-306-family-v1`.
- One root, two members, model `claude-sonnet-5-5`, normal then SIGINT.
- Duration per scenario 10000-120000 ms, termination 1000-10000 ms, TERM grace
  100-2000 ms and strictly below the termination budget.

Manual approval explicitly acknowledges `localhost_only_not_isolated: true`.
The runner configures loopback destinations and synthetic credentials but does
not claim OS-level egress isolation. Every unattended request is rejected with
`unattended_isolation_unverified`; adding an arbitrary isolation claim cannot
unlock it. Verified disposable-runner automation needs a later reviewed design.

## Approval and local inputs

`approvalSchema` in `scripts/tool-update/conformance.mjs` is the strict contract.
Unknown fields, an unregistered version, wrong image/runtime or mismatched pins
are rejected before candidate execution. The record has:

| Field | Required value |
| --- | --- |
| `schema_version`, `approved`, `run_id` | `1`, `true`, unique UUID |
| `approved_at`, `expires_at` | UTC instants, currently valid, at most one hour apart |
| `product`, `version`, `route`, `profile_id` | Exact lane above; product `claude_code`, route `claude_binding` |
| `binary_sha256`, `binary_size` | Exact values above |
| `runtime` | Selected Node's exact `version` and `sha256`, `platform: darwin`, `arch: arm64` |
| `scope` | `kind: localhost_synthetic_print`, `roots: 1`, `members: 2`, `scenarios: [normal, sigint]`, exact model above |
| `mode`, `localhost_only_not_isolated` | `manual`, `true` |
| `budgets` | Bounded `duration_ms`, `termination_ms`, `term_grace_ms` |
| `pins` | Exact SHA-256 for `binary`, `runtime`, `source`, `build`, `instrument`, `skill`, `lockfile`, `package`, `supervisor`, `python`, `ps`, `pgrep`, `git` |

Review the actual source/build/packaged helper and compute the pins before
approving; exported `snapshotPins(binary)` computes them without executing the
vendor image. Build with the same selected Node runtime. Source, build,
instrument or runtime changes invalidate the approval. The runtime uses
`process.execPath`, not a private cache path or a downloaded helper.
The source/build digests detect drift, not derivation: the approver attests that
the build was freshly produced from that source with the selected runtime.
The run ID prevents reuse within one output root, not across all output roots.
Issue a fresh approval for each trial; expiry is not permission for automatic retries.

Approval and output directories must already exist, be owned by the operator,
be private, and have canonical absolute paths. The approval file is private.
The executable path must be canonical and absolute. These paths are local inputs
and never portable evidence fields.

## Run only the approved trial

The following paths are placeholders; replace them only with the reviewed inputs.

```sh
approval_file="/absolute/private/reviewed-approval.json"
binary_file="/absolute/reviewed/claude"
out_dir="/absolute/private/conformance-output"
node scripts/tool-update/conformance.mjs \
  --approval "$approval_file" --binary "$binary_file" --out "$out_dir"
```

The real fixture registers an isolated project, configures/previews/installs the
shipped helper, creates both Store and UI task metadata, and activates the task.
Root/member receipts authorize each source before reading. The shipped collector
is reconciled with an independent numeric oracle. Synthetic partial-response
delivery triggers SIGINT; elapsed time or exit zero does not prove completeness.

The supervisor reclaims observed owned identities, including observed group
escapes. It cannot prove the absence of unobserved escapes or backend cancellation.
Unconfirmed ownership, cleanup or executable drift fails the run.

## Evidence and remaining limits

Success writes private `<run_id>/evidence.json` and prints `conformance_passed`.
Failures after output establishment write strict `failure-<UUID>.json` records
and a fixed failure code. Raw paths, native content, credentials and stderr are
not evidence. Failed temporary fixtures can remain private when safe cleanup is
unverified; a failure must not be relabeled as success.

The historical oracle is normal 6 served/6 terminal, baseline 1 excluded,
retained 3/1/1 and input/output 675/555; SIGINT 6 served/5 terminal, baseline 1
excluded, retained 2/1/1 and 540/444. One interrupted request is missing, not zero.
These are expected scenario values, not a claim that a new trial has passed.

Record actual-binary normal/SIGINT, receipt, finality, collector, drift, privacy
and cleanup evidence before claiming this runner's native acceptance. Independent
review and [the development workflow](workflow.md) still apply. No support,
admission, default, price catalog, remote CI or publication change is implicit.
