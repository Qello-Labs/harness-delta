---
name: harness-connect
description: Explicitly connect a selected ordinary Claude root-reference window task using an opaque pending receipt and the local Harness Delta UI.
disable-model-invocation: true
hooks:
  SessionStart:
    - hooks:
        - type: command
          command: 'node "$CLAUDE_PROJECT_DIR/.claude/skills/harness-connect/scripts/claude-window-session-hook.mjs" record'
          timeout: 10
  SubagentStart:
    - hooks:
        - type: command
          command: 'node "$CLAUDE_PROJECT_DIR/.claude/skills/harness-connect/scripts/claude-window-session-hook.mjs" record'
          timeout: 10
  SubagentStop:
    - hooks:
        - type: command
          command: 'node "$CLAUDE_PROJECT_DIR/.claude/skills/harness-connect/scripts/claude-window-session-hook.mjs" record'
          timeout: 10
---

# Harness Connect

This independent Claude bundle (`ordinary_window`, `claude-window-bundle-v1`) is
implemented for offline acceptance. Ordinary-window collection is disabled pending
separate product activation and native acceptance. Installing or invoking it does
not activate collection or establish hook delivery.

Use the user's explicit local origin (`http://127.0.0.1:PORT`), registered project
ID, active prepared task ID, and opaque pending receipt from the selected hook
flow. Never invent a receipt, search for one, inspect native sources, discover a
process, or substitute cwd/session statements for server evidence.

The one explicit owned-copy mode migration uses installer preview/apply at
`.claude/skills/harness-connect`. It preserves the exact helper and recorder for
exact tasks, adds the window helper as `scripts/connect-window.mjs` and the window
recorder as `scripts/claude-window-session-hook.mjs`, and records mode/revision.
The raw bundle's corresponding files are `scripts/connect.mjs` and
`scripts/claude-session-hook.mjs`; these installed names are installer
transformations. There are no per-patch rewrites, automatic task migrations, or
fallbacks from a failed exact identity check.

With Node 24 or 26 and the explicitly supplied installed skill directory:

```sh
node <skill-dir>/scripts/connect-window.mjs inspect --origin <origin> --project <project-id> --task <task-id>
node <skill-dir>/scripts/connect-window.mjs connect --origin <origin> --project <project-id> --task <task-id> --receipt <pending-receipt>
```

The helper reads only the selected versioned task view. Connection uses CSRF,
If-Match and a fresh idempotency UUID, then checks active root linkage and the
returned version again. It never starts a task. Stop on fixed blockers or an
uncertain result; do not retry mutations automatically.

The recorder accepts bounded SessionStart/SubagentStart/SubagentStop payloads.
Only owned private control and receipt storage may be read. Installer configuration
sets `HARNESS_DELTA_CLAUDE_WINDOW_RECEIPT_DIR`; no vendor or source path is inspected.
Missing, closed, malformed or mismatched control emits nothing. Even a forged or
stale active control allows only unverified pending metadata. Session/PID/path
hints are not identity, collection authority, usage, mapping, or version proof.
Subagent events retain only root-linked metadata, never child files or enrollment.

Successful server results remain `publisher_verified_local_pin`,
`compatibility_unverified`, partial cost coverage and `automatic_children:false`.
Publisher/local-pin identity concerns checked disk bytes, not vendor version or
the mapped running image. A root reference is not attributable root-owned usage:
root ownership is unverified, possible child contribution is unknown, and child
usage/cost remain unobserved, not zero. `collection_active:true` describes only a
separately authorized server connection, not general support.

Report only categorical results and allowlisted IDs. Never print CSRF, raw errors,
source hints, paths, prompts, responses or code. Keep existing task, assignment,
price pins, trust and configuration; this skill supplies no activation command.
