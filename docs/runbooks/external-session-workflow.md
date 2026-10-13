# User-opened external session: preparation and first verified connection

[한국어](external-session-workflow.ko.md). Register the project, variants, reviewed execution setup and frozen protocol with the [workflow quickstart](workflow-quickstart.md). The local browser routes reuse the typed external service; the advanced CLI below still reads reviewed setup files. Display names and private template records are separate from measurement metadata.

For the separate ordinary-session skill and bounded Claude human pilot, see
[Harness Connect](harness-connect.md). Conditional file/native-launch versions do
not expand this ticket-based coordinator's exact source guard.

## Support and evidence

The production source guard remains the exact Codex 0.160.0 own-response profile with independent `cli`/`exec` roots. The new manual coordinator has offline synthetic coverage. Actual startup-before-work timing is pending separately approved native verification. IDE/app/MCP, fork, compaction and children are not admitted here. Claude manual support is pending its own external-process/telemetry qualification; the admitted Claude 2.1.296 tool-owned workflow (2.1.288 and 2.1.291 retired) is a different path, not evidence for a manually opened source. Do not silently admit a newer installed version.

Keep these evidence levels separate:

| Field | Meaning |
| --- | --- |
| `configuration_evidence` | Managed and declared common file hashes matched at preparation; a snapshot |
| `native_context_evidence: native_developer_context_observed` | The supplied ticket-delimited fragment matched in a validated native developer response item |
| `freshness_evidence: fresh_root_after_ticket` | Supported root creation timestamp followed ticket issuance and the identity has not consumed another ticket |
| `tool_use_evidence: unavailable` | No claim that the model followed the instructions or used a tool |

A ticket, warning, file or source discovery alone supplies no native context proof. Missing native context leaves the window unstarted and rejects connection. The native CLI might persist developer context only after a first turn; that timing is unverified. Do not ask the model to self-attest loading or silently start implementation work to manufacture proof. Old adapter receipts retain `harness_application: external_unverified`; the new context evidence is separate. Mandatory common files are preserved and checked; their actual native loading is not established by a file hash.

## Prepare a new task

A reviewed template names existing registered A/B variants, frozen protocol, project, runtime and criterion IDs. The simple-task builder selects only that template's project and criteria and generates opaque task IDs. It does not invent protocol, pricing or admission defaults. Criteria remain fixed for the created task.

The preparation spec is:

```json
{
  "schema_version": 1,
  "common_artifacts": [],
  "common_manifest_hash": null,
  "allowed_preimage_hashes": []
}
```

For mandatory common rules, list canonical regular UTF-8 files as `{ "artifact_id": "common", "path": "/absolute/project/AGENTS.md" }`. Their manifest is SHA-256 of the artifact-ID-sorted compact JSON array of `{artifact_id,sha256}` entries. A null hash requires an empty list. Common files remain unchanged.

Only `<registered canonical root>/.harness-delta-managed/active-instructions.md` may be applied. The chosen variant's sorted contents replace the whole managed file; B is not appended to A. A matching file needs no write, an absent target may be created, and other bytes require an explicitly reviewed raw SHA-256 preimage. Unknown user edits and unsafe/symlink targets fail without overwriting them. AGENTS, hooks, native settings, trust, credentials and project scripts are untouched.

For a new task with no previous activation, session or usage:

```sh
node dist/cli.js --db .harness-delta/local.sqlite workflow external prepare \
  --config workflow.json --runtime runtime.json --spec preparation.json \
  --first-connection-clock --apply-managed-file
```

Expected: `configuration_verified`, no active interval, and `window.started_at`/`ends_at` both null. Preparation/assignment do not start the new observation window. Omitting `--apply-managed-file` checks only. Without `--first-connection-clock`, the existing legacy flow keeps its assignment clock and does not gain the new context/ticket contract; historical tasks cannot be converted retroactively.

## Open a fresh native session and connect

The start command requires a reviewed canonical binary record:

```json
{
  "path": "/absolute/path/to/codex-0.160.0",
  "version": "0.160.0",
  "sha256": "112fae7a5a1223e673c8a1791d32338f37df8b527ff1159bb8adac6c4dbf1b4b"
}
```

The tool checks the exact binary file hash without invoking it. It never chooses a PATH upgrade, installs a binary or changes a native account.

```sh
node dist/cli.js --db .harness-delta/local.sqlite workflow external start \
  --config workflow.json --runtime runtime.json --spec preparation.json \
  --native-binary native-binary.json
```

Expected: a private copyable command and one-use ticket. The user runs that ordinary native CLI command in their terminal. The command supplies the selected fragment through per-invocation `developer_instructions`; it installs no hook and changes no trust. Treat the command as private configuration content, never a measurement export. It selects this invocation's additional developer instructions; any required existing additional rules must already be represented in the operator-reviewed setup. Built-in model instructions are not replaced.

Choose the exact source/session with the [existing execution schema](task-native-workflow.md#codex-launch-resume-link-and-collection), a fresh `run_id`, `operation: link`, native UUID and source path. UI routes may hide those technical handles behind explicit source selection; a source is never guessed from recent activity.

```sh
node dist/cli.js --db .harness-delta/local.sqlite workflow external connect \
  --config workflow.json --runtime runtime.json --spec preparation.json \
  --execution link.json --ticket TICKET_ID
node dist/cli.js --db .harness-delta/local.sqlite workflow external state TASK_ID
```

Expected: exact root scope/identity and baseline validation precede the bounded native developer-fragment projector. It excludes prior usage. Only a completed matching source/context connection consumes the ticket and starts `external-first-connection-v1` once. Failed/pending connections set neither window endpoint. A stale root, changed fragment, reused ticket or changed preparation revision fails. No source prompt, response, source-code content or instructions are retained in evidence tables.

## Observe, pause, reconnect and assess

Supply a fresh run ID with `operation: collect` and the already verified session:

```sh
node dist/cli.js --db .harness-delta/local.sqlite workflow external collect \
  --config workflow.json --runtime runtime.json --spec preparation.json --execution collect.json
node dist/cli.js --db .harness-delta/local.sqlite workflow external pause TASK_ID
```

Collection is foreground and future-only. Every new collection baselines again; stopped/offline usage is not backfilled. Scope, source continuity, managed/common byte checks, deduplication and the operative deadline guard each boundary. Collector termination pauses active time, leaves the user's native process under their control and never supplies success. Pause requests durable collector stop. Use the existing run recovery procedure after a crash; in-flight uncertainty remains a gap.

Resume an unchanged linked native source with another collect. For a fresh native session on the same task, issue another ticket and connect. The arm, first window and accumulated eligible usage stay fixed across sessions and rework. The deadline closes observation; it is not a human success decision.

Stop the observer and native agent before releasing the managed surface:

```sh
node dist/cli.js --db .harness-delta/local.sqlite workflow external release TASK_ID --external-session-stopped
```

The acknowledgement is not process verification. Release requires no running observer, pauses time and frees only the same-store lease. It neither restores nor deletes the managed file. Reprepare with reviewed hashes if needed; a new preparation revision requires a fresh matching ticket/source. Use separate registered checkouts for parallel A/B. Separate stores and unmanaged native processes are outside this lease.

The human chooses one result after stopping the collector:

```sh
node dist/cli.js --db .harness-delta/local.sqlite workflow external outcome TASK_ID rework
node dist/cli.js --db .harness-delta/local.sqlite workflow external outcome TASK_ID success --criteria CRITERION_ID
node dist/cli.js --db .harness-delta/local.sqlite workflow external outcome TASK_ID failed
node dist/cli.js --db .harness-delta/local.sqlite workflow external outcome TASK_ID aborted
node dist/cli.js --db .harness-delta/local.sqlite workflow external result TASK_ID
```

These are alternative choices. Success requires every fixed criterion ID. Rework keeps the same task and totals before finalization. Finalized success is immutable under R03; the returned guidance asks for a followup task for additional work. A late outcome remains stored but is excluded from this contract's deadline status. New tasks use this outcome API, not legacy `workflow finish`.

## One clock, partial results and recovery

`external-observation-v1` returns one window, effective cutoff, elapsed/active time, explicit outcome and partial reference cost. The first verified connection is its start; the frozen followup duration supplies its end. Reconnect/rework never move either. Report capture checks the task/coverage start equals this connection start and excludes earlier usage. Cost retains the assigned price pin and partial/missing distinctions; unavailable price is not zero. Complete cost and inference remain disabled.

Old protocol/assignment deadlines and historical report bytes remain unchanged. New-clock tasks cannot enter legacy randomized comparison reports: `timing_contract_mismatch` rejects mixed clock protocols. The new task status and UI expose only the new operative deadline. Historical report read endpoints retain their original contracts.

Drift stops before the next source boundary, pauses time and exposes `configuration_changed`. Unknown bytes remain intact. Preparation failure exposes `recovery_needed` and retains ownership; interrupted `applying` is not success. There is no automatic rollback over user changes. Inspect, stop/acknowledge external work and reprepare only against reviewed bytes. Missing sources, uncertainty and incomplete coverage remain partial, not observed zero.

The [verification note](../validation/external-session-flow.md) distinguishes offline tests from native qualification. The official [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference) and [CLI reference](https://learn.chatgpt.com/docs/cli/reference) document per-invocation instructions. The [Claude CLI reference](https://code.claude.com/docs/en/cli-reference) documents append-file/session flags; those flags alone do not qualify an external source.
