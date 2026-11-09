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

The offline helper validates explicit selection and reports
`promoted_provider_unavailable`; the live authorized provider is not implemented
by this bundle. It makes no HTTP requests and cannot activate collection.
Installation requires a separately confirmed quiescent cutover and fresh roots.
Do not install, change registrations, start a task or retry mutations implicitly.
Report categorical blockers only, never local path hints or raw diagnostics.
