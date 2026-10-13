---
name: harness-apply
description: Apply the saved A/B harness procedure directly in a selected checkout from a fresh native application session, then report independently verifiable file state.
disable-model-invocation: true
---

# Harness Apply

You are the applying actor. Investigate the project and edit its selected workspace
using your native tools. File and command permissions belong in the native window.
The server supplies context and verifies reported files; it does not execute your
tools or publish a draft. Installation starts nothing. This application session
must remain separate from the later working session using harness-connect.

1. Obtain the UI origin, task ID and attempt ID from the copied/opening context.
   Use Node 24 or 26 and this skill's script path. Retrieve context:
   `node <skill-dir>/scripts/apply.mjs context --origin <origin> --task <task-id> --attempt <attempt-id>`.
   Check the exact assigned variant, bundle hash and target cwd. Never substitute
   another assignment, project, target, or bundle. Unsupported identity is explicit.
2. If the existing native metadata integration can provide a receipt, register it
   with the identity helper before any measurement source access. Its JSON input
   contains attempt_id, product and receipt. Do not invent identity from cwd,
   environment hints or your own claim. When this applying agent is also the
   task's measured agent, unavailable identity prevents later measurement
   connection; it never prevents direct file application.
3. Read the assigned instruction and tool artifacts. Inspect project structure,
   discover domain-specific paths, preserve unrelated dirty/untracked files, and
   use the bundled scripts where the procedure requires them. Keep common
   artifacts in their stated relative scope. There is no advance full file list.
4. Before each output edit, request a checkpoint. Write a small JSON input with
   `{"attempt_id":"<attempt-id>","paths":["domain/AGENTS.md"]}` and run
   `node <skill-dir>/scripts/apply.mjs checkpoint --origin <origin> --task <task-id> --attempt <attempt-id> --input <json-file>`.
   Save the returned checkpoint_id and before_hash. Add newly discovered paths
   as needed. Never replace a dirty baseline with Git HEAD. Repeated checkpoint
   requests retain the original baseline. If a file changed concurrently, inspect
   and preserve it in the native conversation before editing. Recheck context
   before later helper operations; abandoned or restarted attempts are stale.
5. Edit the workspace directly through native tools, run assigned scripts and
   verification commands with native permissions, and report failures/refusals
   honestly. Do not bypass native refusals. Do not place source bytes, prompts,
   command output or secrets in metadata reports or diagnostics.
6. Report bounded file hashes and named check outcomes. The report JSON contains
   attempt_id, bundle_hash, outputs [{path, checkpoint_id, sha256}], and checks
   [{check_id, outcome}]. Use null sha256 for a deleted/absent output; outcomes are
   passed, failed, missing or refused. Send with
   `node <skill-dir>/scripts/apply.mjs report --origin <origin> --task <task-id> --attempt <attempt-id> --input <json-file>`.
   Checks are agent_reported. The server verifies current file bytes independently;
   it verifies only the reported set, not every tool action. A prose success claim
   does not establish completion. Missing checkpoints are rejected explicitly.
7. Return to the UI for actual before/after review. No second publication approval
   is needed because the native tools already edited the target. On failure or
   abandonment, edits remain; stop execution in the native window. After verified
   files, copy the populated working-session guidance and open a separate fresh
   session. Invoke harness-connect there; do not measure this applying session.

Application helper transport never reads a session transcript or executes a tool.
Native opening and identity/source qualification have separate product/version
limits. Synthetic helper tests do not prove that a native agent followed this
procedure. Keep all unsupported loading/source blockers visible.
