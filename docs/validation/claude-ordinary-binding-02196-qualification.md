# Claude Code 2.1.296 ordinary transcript profile qualification

The ordinary Claude session-binding provider lists exact transcript profiles in
`src/session-binding-claude.ts`. The 2.1.296 profile is `qualified` only for the
bounded native print-mode evidence below: transcript layout, project-skill hook
loading, family membership and own-request counters. It is not interactive
qualification or production admission. 2.1.291, 2.1.293 and 2.1.294
remain `candidate` profiles with synthetic evidence only.

This qualification does not open ordinary production collection. Every ordinary
Claude profile, including `qualified`, requires `allowCandidateProfiles: true`;
without that explicit provider authority, version refusal remains closed.
The Claude service admission remains limited to its human-pilot scope or a synthetic
task; the qualification lease is Codex-only. The provider keeps reporting
`productionSupported: false`. A
real ordinary Claude session can be collected only for a prepared `functional_pilot`
task that uses the `claude-ordinary-human-pilot` source profile, as described in
[Harness Connect](../runbooks/harness-connect.md#claude-human-operated-ui-pilot). An
ordinary production admission needs its own code-owned admission change and
evidence; see [ADR 012](../decisions/012-session-family-bindings.md). Requirements:
[R01, R02, R04 and R05](../requirements.md).

## What changed in the code

| Area | Before | Now |
| --- | --- | --- |
| `claudeBindingProfiles` 2.1.296 | `candidate` | `qualified` |
| Provider without `allowCandidateProfiles: true` | Rejects 2.1.296 rows with `claude_source_version_unsupported` | Still rejects every ordinary profile, including qualified 2.1.296 |
| `capabilities().productionSupported` | `false` | `false`; the reason `claude_transcript_profile_unqualified` is no longer reported |
| Claude service source admission | Human pilot or synthetic task; ordinary production closed | Unchanged; ordinary production closed |

Evidence status does not change current UI or observation labels:
`native_unverified_pilot`, `legacy_unverified` and `candidate_pilot` remain.

## Offline actual-binary rehearsal

The real 2.1.296 binary (SHA-256
`c9b5341637becbd423ddffc5b254afb645682a3868cb708bbc6cc0e7bb419937`) ran as an ordinary,
persistent print-mode session against a localhost stub Messages API, with an isolated
configuration directory and kernel-enforced network denial except localhost. The
pilot was prepared through the shipped CLI and local HTTP API, with the unmodified
project skill copied into the disposable project. Three repeats had the same
structure.

| Boundary | Observed result |
| --- | --- |
| Skill | The project skill was discovered and its connect call ran through the packaged helper, which reported a connection |
| Receipts | One `connect` receipt and one `subagent_start` receipt per member, with allowlisted metadata keys only |
| `SubagentStop` | The skill-scoped hook wrote no stop receipt in any repeat, although the native event occurred. Discovery and usage do not depend on it |
| Transcript layout | `<encoded-project>/<root>.jsonl` and `<encoded-project>/<root>/subagents/agent-<member>.jsonl`; the project encoding replaces every character outside ASCII letters and digits with `-` |
| Ownership | Root rows carry the root session ID and no agent ID; member rows carry the same session ID, their own agent ID and the sidechain marker |
| Version | Every assistant row is `2.1.296` |
| Family | One root and two members, flattened under the root |
| Requests | The stub served root 4, members 1 each; the connecting root request was excluded at the baseline; 5 requests were retained |
| Counters | Each request was served input 101, cache read 23, cache creation 11, output 17; retained totals were input 675 and output 85, with no component counted twice |
| Lifecycle | Pause kept the counts, same-live-root resume kept them, the next root request was added, and human completion finalized the task |

The helper's same-command receipt lookup needs a runnable `ps` for process ancestry;
without it the helper reports `hook_receipt_missing`.

## Counter finality

A further localhost-only rehearsal with the same pinned binary observed an own
child thinking row with output 16 and `message.stop_reason: null`, followed by a
row with output 111 and `message.stop_reason: "tool_use"`. Both rows retained the
same request ID and message ID. The provisional row remained in the transcript;
it was not a second billable request. This is synthetic stream-format evidence,
not an additional authenticated pilot or interactive qualification.

For 2.1.296, the provider requires a valid message ID and a recognized
`stop_reason`. Null-stop rows remain provisional even after a user/tool row or a
quiet interval. A correlated terminal row supplies the counters and retains the
first row's occurrence time. Contradictory message IDs or terminal counters are
excluded; changed committed counters still raise `binding_request_conflict`.
Missing or unrecognized finality metadata remains incomplete.

A pending request rewinds the existing cursor across polls and provider restart.
Its forward scan is bounded to 16 MiB, including read-window splits; requests
observed at a baseline stay permanently excluded. Cursor version 3, committed
fingerprints, production admission and cost-coverage labels are unchanged.
The synthetic candidate versions retain their prior unverified trailing-row
policy; this observation does not qualify their native finality semantics.

## Native pilot

One separately approved native session ran on 2026-10-13 (UTC) on macOS arm64 with
Node 24.21.0, the same binary, the existing login and a disposable synthetic project.
It was an ordinary persistent print-mode session driven by an operator script, not an
interactive terminal session operated by a person. The model was
`claude-sonnet-5-5`; the turn limit was 4 and the process deadline 280 s. MCP
servers were excluded with an empty strict configuration, and only the packaged
helper's connect and inspect commands and the Agent tool were allowed. The session
was not retried.

| Boundary | Observed result |
| --- | --- |
| Skill and hooks | The skill was discovered; one `connect` receipt and two `subagent_start` receipts were written; no stop receipt |
| Connection | The packaged helper connected the session to the prepared task; the task view reported `native_unverified_pilot` |
| Family | One root and two members, flattened under the root |
| Transcript | Same layout, row ownership and consumed key names as offline; every assistant row is `2.1.296` with model `claude-sonnet-5-5`; no compaction boundary |
| First turn | The root made 4 requests and each member 1. The connecting root request was excluded at the baseline. The start of the second member made the service wait for its source and rebaseline the family, which excluded one more root request and recorded `unobserved_interval`. 4 requests were retained: root 2, members 1 each |
| Pause and resume | Pause kept 4 requests; same-live-root resume kept 4 |
| Second turn | One more root request was retained: 5 in total |
| Completion | Human completion finalized the task as `success` with 5 requests |
| Counters | Every retained request equals its transcript row: root input 31842, 32728 and 32773 with output 181, 3 and 3; members input 21035 and output 4 each |
| Product totals | The product's own result totals for each turn equal the sum of that turn's root transcript rows |
| Gaps | `binding_partial_usage` (the real session wrote one-hour cache entries) and `unobserved_interval` |
| Cost and trust | Verified partial amount null; a separate legacy-unverified reference estimate only; `complete_cost` null; inference false |
| Processes | No leftover processes or listeners |

The metadata-only evidence record has SHA-256
`d5f567366064b400e03077fe2f45ce6beaf8004531af73a83df4bcc72761af88`. Prompts, responses,
transcript text, paths, session and request identifiers and credentials are omitted.
The session left its ordinary transcript in the user's Claude configuration, which is
the product's own storage; the receipts stayed in a private scratch directory.

## Remaining limits

- Ordinary production admission, complete task cost, billing and inference remain
  unavailable. Usage is partial and carries explicit gaps.
- The evidence covers one print-mode session, one model, one root and two members. An
  interactive terminal session operated by a person, nested direct parents, more than
  two members, compaction, long sessions, restart and relaunch are not established.
- The skill-scoped `SubagentStop` hook produced no receipt offline or natively.
- A member whose source is not ready when it starts leads to a family rebaseline;
  requests in flight at that boundary are excluded and reported as
  `unobserved_interval`, never backfilled.
- One-hour cache writes are reported as `binding_partial_usage`.
