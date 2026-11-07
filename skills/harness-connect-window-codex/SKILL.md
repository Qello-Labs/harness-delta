---
name: harness-connect
description: Explicitly connect a selected ordinary Codex root-reference window task using an opaque pending receipt and the local Harness Delta UI.
disable-model-invocation: true
---

# Harness Connect

This Codex window bundle is implemented for offline acceptance. Ordinary-window
collection is disabled pending separate product activation and native acceptance.
Installation, setup, a receipt, and this skill do not activate collection or
attest to a transcript, writer version, executable, publisher, or current process.

Use the user's explicit local origin (`http://127.0.0.1:PORT`), registered project
ID, active task ID, and opaque pending receipt from the selected hook flow.
Never invent a receipt or discover one through files, environment hints, process
ancestry, a shared cwd, vendor configuration, or source directories.

The installer keeps the exact helper at `scripts/connect.mjs` and installs this
bundle's window helper separately at `scripts/connect-window.mjs`. Use Node 24
or 26 and the explicitly supplied installed skill directory:

```sh
node <skill-dir>/scripts/connect-window.mjs inspect --origin <origin> --project <project-id> --task <task-id>
node <skill-dir>/scripts/connect-window.mjs connect --origin <origin> --project <project-id> --task <task-id> --receipt <pending-receipt>
```

`inspect` reads only that selected versioned task view, never bootstrap or task
inventories. `connect` requires a live enabled task, sends a same-origin CSRF
request with its current version, then checks the selected root and active
linkage again. Stop on fixed blockers or an uncertain result. Do not retry a
mutation automatically; a later explicitly requested attempt must re-read state.
The helper has no filesystem, locator, native source, or child-process access and
emits no pending metadata or controls.

The retained exact command remains available for an explicitly selected exact
task under its existing admission and receipt contract:

```sh
node <skill-dir>/scripts/connect.mjs connect --origin <origin> --product codex --project <project-id> --task <task-id> --receipt <native-receipt>
```

Do not substitute this exact command for a blocked window operation or migrate
an existing exact task implicitly. The source bundle's `scripts/connect.mjs` is
the window implementation; the separate installed filename is an installer
transformation, not a second exact implementation.

Report only fixed statuses and allowlisted project/task/session IDs. A successful
window result is `source_only`, `compatibility_unverified`, and partial cost
coverage, with `automatic_children:false`. It is a root-reference estimate, not
attributable root-own usage: root ownership is unverified, possible child
contribution is unknown, and child usage/cost are unobserved, never zero.
`collection_active:true` describes only the server's separately authorized
connection, not general product support or an activation granted by the helper.
Never print raw server errors, source hints or paths, CSRF, prompts, responses,
or code. Do not change configuration, trust, task assignment, or price pins.
