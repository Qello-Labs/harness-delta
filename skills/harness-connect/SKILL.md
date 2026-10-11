---
name: harness-connect
description: Use when a user wants to connect or reconnect a selected Codex or Claude Code session to a logical task already prepared in the local Harness Delta UI.
disable-model-invocation: true
hooks:
  PreToolUse:
    - matcher: Bash
      hooks:
        - type: command
          command: 'node "$CLAUDE_PROJECT_DIR/.claude/skills/harness-connect/scripts/claude-session-hook.mjs" record'
          timeout: 10
  SubagentStart:
    - hooks:
        - type: command
          command: 'node "$CLAUDE_PROJECT_DIR/.claude/skills/harness-connect/scripts/claude-session-hook.mjs" record'
          timeout: 10
  SubagentStop:
    - hooks:
        - type: command
          command: 'node "$CLAUDE_PROJECT_DIR/.claude/skills/harness-connect/scripts/claude-session-hook.mjs" record'
          timeout: 10
---

# Harness Connect

The helper uses the local server's source admission. Installing the skill starts
nothing. A native metadata receipt can bind a normally opened session and begin
family observation. This path currently has synthetic end-to-end validation;
ordinary production sources still require qualification. Preserve server blockers.

1. Obtain the user-selected UI origin (`http://127.0.0.1:PORT`). Locate this skill
   directory from the host's loaded skill path. Run with Node 24 or 26:
   `node <skill-dir>/scripts/connect.mjs inspect --origin <origin> --product codex`
   (use `claude_code` for Claude). Return unsupported/unavailable blockers.
2. Select an explicit registered project ID and logical task ID from that result.
   Ask which task if the user did not specify it. A shared cwd, filename, or the
   agent's own statement does not select a task or prove linkage. Preserve the
   task's existing A/B assignment.
3. For Claude's project-local installation, this explicitly invoked skill registers
   session hooks. They record only allowlisted metadata for the connect Bash call
   and future subagent start/stop events, with no tool-permission allowlist. The
   installed package, hook directory and trust must be reviewed first; do not
   install or expand trust automatically. In the same Bash tool call run:
   `node <skill-dir>/scripts/connect.mjs connect --origin <origin> --product claude_code --project <id> --task <id>`
   The helper locates the fresh hook receipt using OS process ancestry; the native
   session environment narrows candidates but never proves identity. Missing or
   mixed root/member receipts block. No hook at startup is needed for this candidate
   Claude invocation path; already running sessions may require approved reload.
   Live registration, source format and invocation remain qualification-pending.
   Claude's documented hooks prove root-family membership for recorded members;
   direct nested parents are not proven, so members are flattened under the root.
   A child re-call confirms an active independently discovered family, never creates
   another root. A paused child returns `binding_reconnect_required`; reconnect in
   the parent. Earlier members have explicit missing-interval gaps.

   For Codex, prefer the opaque receipt delivered by the current session's trusted native
   hook or validated host integration. Run:
   `node <skill-dir>/scripts/connect.mjs connect --origin <origin> --product codex --project <id> --task <id> --receipt <native-receipt>`
   An explicit Claude receipt may use this same route when the server supports it. The server
   resolves identity and exact source, preserves the assigned arm and price pin,
   checks existing binding and begins observation. Verified children inherit
   automatically; users do not invoke the skill separately in each child. The UI
   refreshes family counts and partial usage. After pause/server restart, invoke
   once again in the parent for a fresh baseline. A new parent may retain the same
   selected task and its open window. Never invent a receipt or substitute a
   UUID/model statement/cwd for native evidence. If the hook was not installed or
   trusted before session start, report `binding_provider_unavailable` or the
   server's qualification blocker. Do not install or trust instrumentation as an
   implicit fallback. See [support.md](references/support.md) for setup boundaries.
4. When using the legacy ticket path, identify the user-selected session. Codex's
   `CODEX_THREAD_ID` and Claude's skill-content `${CLAUDE_SESSION_ID}` are hints,
   not current-session binding evidence. Do not search session directories or
   guess source paths. An explicitly selected UUID is only selected-session
   linkage; it does not become a verified current identity.
5. For a supported root already opened with the UI's existing startup ticket
   command, run:
   `node <skill-dir>/scripts/connect.mjs connect --origin <origin> --product codex --project <id> --task <id> --session <uuid>`
   Select that exact session file in the UI picker. The helper compares its UUID,
   delegates source/content validation to the server, and re-reads current
   preparation, context, source and open-window evidence. It never launches
   an agent, applies instructions, installs hooks or starts observation. If the
   session was opened normally, explain the startup-ticket limitation; do not
   silently restart it or claim past harness application. Existing CLI alternatives
   need explicitly reviewed inputs; see [support.md](references/support.md).
6. Report status (`connected`, `already_connected`, or the fixed blocker code),
   project/task/session IDs, selected arm, evidence, identity basis and whether
   collection is active. The UI uses the same server state and will see this
   connection on refresh. Ask the user to use its observation control when needed.
   Connection is separate from collection, tool compliance and complete cost.

On another invocation, server evidence wins. Receipt connections return
`already_connected` without another binding or task reassignment. The legacy
helper can confirm only its latest selected source and reports unsupported child
inheritance; it does not acquire family support merely because the receipt API
exists. Missing or unsupported family intervals remain partial, not observed zero.

Do not edit the target project's AGENTS, settings, authentication or trust. Claude
metadata hooks continue for the rest of the session even while server collection
is paused; deletion forgets that native family and suppresses later receipts. Never
print bootstrap CSRF, startup command/instructions, source paths, prompts,
responses or code. Stop on identity conflicts, unsupported contracts, changed
state or uncertain mutation results; re-read state before an explicitly requested
retry. Respond in the user's language; Korean installation and invocation examples
are in the repository's paired runbook.

For agent-applied tasks, use a separate fresh working session after verified files.
The server rejects registered application roots and evidenced parent relations
before source access. File application does not establish native loading/source
qualification. Missing application identity after a same-agent application, drift,
abandonment and stale epochs remain blockers. Never connect the applying session or bypass those blockers.
