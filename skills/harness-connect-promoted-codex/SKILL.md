---
name: harness-connect
description: Explicitly select a promoted Codex pending receipt with the installed scripts/connect-promoted.mjs helper.
disable-model-invocation: true
---

# Harness Connect

Use Node 24 or 26 and the explicit installed skill directory:

```sh
node <skill-dir>/scripts/connect-promoted.mjs connect --origin <origin> --project <project-id> --task <task-id> --receipt <pending-receipt>
```

The source bundle's `scripts/connect.mjs` is installed separately as
`scripts/connect-promoted.mjs`. Preserve the historical helper. Never substitute
it when the promoted helper reports a blocker.

Supply the local origin, registered project, active task and opaque receipt
explicitly. Never discover receipts, native sources, processes, images or vendor
configuration. Local schema-3 `promotion_pending` metadata with contract
`promoted-payload-v1` is not portable authority, identity, admission or usage.

The HTTP-only helper forwards the explicit receipt to the selected local server.
Only its live provider can authorize native verification and collection; the
helper never reads native hints. It requires server proof and an observing
readback before reporting connection. Missing grants, denials and stale scope
remain blocked; verification means session identity, not qualification.
Installation requires a separately confirmed quiescent cutover and fresh roots.
Do not install, change registrations, start a task or retry mutations implicitly.
Report categorical blockers only, never local path hints or raw diagnostics.
