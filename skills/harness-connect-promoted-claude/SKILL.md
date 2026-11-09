---
name: harness-connect
description: Explicitly select a promoted Claude pending receipt with the installed scripts/connect-promoted.mjs helper.
disable-model-invocation: true
hooks:
  SessionStart:
    - hooks:
        - type: command
          command: 'node "$CLAUDE_PROJECT_DIR/.claude/skills/harness-connect/scripts/claude-promoted-session-hook.mjs"'
          timeout: 10
  SubagentStart:
    - hooks:
        - type: command
          command: 'node "$CLAUDE_PROJECT_DIR/.claude/skills/harness-connect/scripts/claude-promoted-session-hook.mjs"'
          timeout: 10
  SubagentStop:
    - hooks:
        - type: command
          command: 'node "$CLAUDE_PROJECT_DIR/.claude/skills/harness-connect/scripts/claude-promoted-session-hook.mjs"'
          timeout: 10
---

# Harness Connect

Use Node 24 or 26 and the explicit installed skill directory:

```sh
node <skill-dir>/scripts/connect-promoted.mjs connect --origin <origin> --project <project-id> --task <task-id> --receipt <pending-receipt>
```

The installer preserves historical helper bytes, installs this bundle's
`scripts/connect.mjs` as `scripts/connect-promoted.mjs` and
`scripts/claude-session-hook.mjs` as `scripts/claude-promoted-session-hook.mjs`,
and replaces only the owned skill registration at the confirmed cutover.

The recorder accepts six explicit arguments (`--receipt-directory`,
`--project-root`, `--product-version` with values), or imports installer-owned
`scripts/claude-promoted-connect-config.mjs` setting `HARNESS_DELTA_PROMOTED_RECEIPT_DIR`,
`HARNESS_DELTA_PROMOTED_PROJECT_ROOT`, and
`HARNESS_DELTA_PROMOTED_PRODUCT_VERSION`. It reads only bounded owned control and
receipt storage. Even stale active control emits only unverified local schema-3
`promotion_pending` metadata tagged `promoted-payload-v1`; it never grants native
access or proves product version, child parentage, executable or source identity.
Root-only subagent metadata does not enroll a child or authorize source access.

Supply the local origin, registered project, active task and opaque receipt
explicitly. Never search native sources, receipts, processes, images or vendor
configuration. Local pending hints are not portable authority or usage.
The HTTP-only helper forwards the explicit receipt to the selected local server.
Only its live provider can authorize native verification and collection; the
helper never reads native hints. It requires server proof and an observing
readback before reporting connection. Missing grants, denials and stale scope
remain blocked; verification means session identity, not qualification. Do not substitute
historical helpers, install registrations, start tasks or retry implicitly.
Fresh roots and separately confirmed quiescent cutover are required.
Report categorical blockers only, never local hints or raw diagnostics.
