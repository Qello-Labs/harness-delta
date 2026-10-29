# Admitted Claude localhost conformance runner

[한국어](tool-update-conformance.ko.md)

This developer runner ports the bounded synthetic print-mode scenario for the
already-admitted Claude Code 2.1.306 image. The code and synthetic tests are
available; actual-binary acceptance of this repository-owned runner is pending.
It does not admit an unregistered version or change defaults, ordinary
qualification, interactive support, authenticated support or complete-cost claims.
See [discovery and static assessment](tool-update-pipeline.md) for the first stage.

## Execution requires separate approval

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
