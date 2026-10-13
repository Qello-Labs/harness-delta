# ADR 015: Native-session harness application

Status: Accepted responsibility split; native acceptance and measurement qualification pending.

## Context

Portable format-2 comparisons may contain a reusable application procedure and
scripts rather than ready-to-load working instructions. The stored A/B assignment
must survive retries. A procedure can adapt domain-specific rules only after the
applying agent investigates the selected project.

## Decision

The UI preserves assignment and selects an existing checkout/worktree and native
product. The applying product is the user's choice and need not equal the task's
measured product; working-session guidance and connection always use the task's
product, and application identity is registered only through that product's
provider. It prepares an immutable task-scoped application context. The fresh native
session's own agent invokes harness-apply, reads the assigned bundle, investigates
project structure, runs its scripts and edits the selected workspace directly.
Native tools decide permissions in that native window.

The server owns assignment, target inspection, context, explicitly scoped file
checkpoints and result verification. It has no applying agent runner, app-server
owner, tool/permission proxy, execution timer, process termination or publisher.
`application-prepare` does not execute an agent. `application-open` requests one
interactive native opening; acknowledgement does not prove a session started.

On macOS the opening adapter uses a private executable command file and one
`open -a Terminal` request. Individual CLI arguments and cwd are literal POSIX
quoted values. The CLI is interactive with an initial prompt; there are no model,
trust, auth or permission overrides, resume flags or stdin drivers. No agent PID
is retained. The private command file lives under the attempt so deletion can
remove its context along with checkpoints. Other platforms, missing executables and failed opening expose
copyable context. Desktop prompt deep links are unsupported. CLI grammar was
checked using Codex CLI 0.161.0 and Claude Code 2.1.295 help and official references;
synthetic opening tests do not establish native opening or application acceptance.

## File evidence and privacy

The agent requests checkpoints immediately before editing each discovered output.
No complete file list is required in advance. A checkpoint records the actual
dirty preimage or absent state; Git HEAD is never a replacement baseline. Repeated
requests cannot replace the baseline, and drift requires explicit investigation.
Relative paths must stay inside the inspected target; symlinks, hardlinks,
nonregular files, hidden paths, registered bundle storage, node_modules and known
secret paths are excluded. Configured private data paths and DB sidecars are also
excluded. Files are bounded to 1 MiB and 256 checkpointed paths per attempt.

The report contains only file/checkpoint identifiers, expected present/absent
hashes and bounded named check outcomes. Wrong target, bundle, stale attempt,
missing checkpoint and mismatched bytes cannot complete application. The server
reads current files independently and revalidates hashes when results are reused.
Checks remain `agent_reported`; file verification covers the reported set, not
all tool actions or every filesystem change. Missing/refused/failed checks remain
visible and block readiness even if the reported file hashes match.

Before bytes are private ignored review artifacts. Actual after bytes are read
transiently for UI review. File content, prompts, raw command output and secrets
never enter measurement records, mutation response journals, reports or exports.
The UI review is post-application confirmation. There is no second publish approval
and no automatic rollback. Abandonment invalidates helper operations and does not
stop the external agent; stop it in its native window.

## Session separation and compatibility

Application files, reported tool evidence, native identity, instruction loading
and measurement eligibility are independent facts. A metadata-only root identity
provider may register the application role before any transcript access. Codex's
existing exact-version native root receipt path supplies this integration; no
new product/version admission is created. Claude application identity currently
has no metadata-only resolver and remains unavailable. Never infer identity from
cwd or agent claims or inspect unlinked sessions to identify them.

Reject registered application identities and their evidenced immediate parent
relations before working-session source access. Unsupported broader ancestry
remains subject to existing family/source gates. An application-required task
also needs a fresh working root created after completion, and verified
application identity when the applying product equals the working session's
product. A different applying product can never be the working session, so its
identity is not required; exclusion of registered identities, freshness and
epoch checks are unchanged. In that case separation rests on product inequality
and freshness alone: a task-product session that the applying agent itself
starts after completion is not detected, as was already true for any
independently started same-product session. The UI supplies populated target, assignment and harness-connect
context for a separate session. Native instruction-loading and source qualification
remain pending; this feature does not enable unsupported measurement sources.

Migrations 029–030 add external attempts, checkpoints, roles, opaque exclusion
tombstones and a private-artifact cleanup journal without altering
026–028 history. Old managed jobs/receipts are never interpreted as native direct
application. Unfinished external attempts fail closed after restart; neither
restart nor deletion relaunches/stops an agent, rolls back files, starts collection
or recreates deleted records. Task/project deletion schedules cleanup of product-owned
review and launch artifacts after the database transaction commits. Pinned roots
and no-follow directory checks protect unrelated workspace files; unsafe paths
remain durably `application_cleanup_pending` and explicit deletion retries can
complete cleanup. Opaque application identity exclusions survive independently
of deleted tasks to keep still-running applying sessions excluded. Normal task-workflow process ownership is unchanged.

## Validation boundary

Synthetic tests establish API, assignment, file integrity, privacy and lifecycle
behavior. Actual native opening, project adaptation, script execution, permissions
and fresh working-session loading require separately authorized human/native
acceptance for each product. Historical managed-runner tests are not evidence for
this design. See [the user flow](../runbooks/harness-config.md#6-agent-application-format-2).
