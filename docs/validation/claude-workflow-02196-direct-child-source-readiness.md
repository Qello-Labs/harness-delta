# Claude Code 2.1.296 single direct-child workflow source admission

The code-owned registry admits `claude_code / 2.1.296 /
claude-workflow-direct-child-v1`, evidence ID
`claude-workflow-02196-direct-child-native-v1`, `validation_kind: real_operations`
and `complete_cost: false`. This separate profile supports a fresh read-only root
with at most one fresh, read-only direct child of agent type `workflow-child`, and
partial per-request usage collection for both. The
[parent-only profile](claude-workflow-02196-source-readiness.md) and its restrictions
remain separate. This profile has no conditional window: only the exact version is
eligible.

## Native evidence

One separately approved launch completed on 2026-10-12 (UTC) on macOS arm64 with Node
24.21.0 and the 2.1.296 binary (SHA-256
`c9b5341637becbd423ddffc5b254afb645682a3868cb708bbc6cc0e7bb419937`). It used the
ordinary CLI path, the existing login, a disposable synthetic project and a
`functional_pilot` protocol. The executed code was this change's build with a
metadata-only log audit (event name, sequence, request ID hash) added in a scratch
copy; nothing else differed. The launch was not retried. Limits: 300 s timeout,
`max_turns` 12, `request_limit` 24.

| Boundary | Observed result |
| --- | --- |
| Root and direct child | Both `claude-sonnet-5-5` / `high`, `read-only` |
| Run | `completed`; 4 requests in 8.0 s: root 2, child 2. The child read the synthetic file, then answered |
| Sessions | Two sessions, the child linked to the root |
| Labels | Both sessions and all four usage records are `verified`, `claude-workflow-direct-child-v1`, 2.1.296 |
| Usage | 4 distinct native request IDs; reasoning output missing, never 0 |
| Terminal delivery | 4 native `api_request` log request IDs, 4 with a stored usage record. Log events included `subagent_completed` |
| Project files | No file was created or changed in the project |
| Human outcome and report | `success` before the follow-up deadline; the report after the deadline shows `deadline_status: success`, `usage_complete: false` and `complete_amount: null` |
| Processes | No leftover processes |

Observed counters per request (session 1 is the root, session 2 the child):

| Session | Effort | `input_total` | `cached_input` | `output_total` | `reasoning_output` |
| --- | --- | --- | --- | --- | --- |
| session-1 | high | 6530 | 0 | 162 | missing |
| session-2 | high | 3672 | 0 | 90 | missing |
| session-2 | high | 3820 | 3670 | 46 | missing |
| session-1 | high | 6955 | 6528 | 3 | missing |

The metadata-only evidence record has SHA-256 `dfe01a0be5489858a2d60cf2dc0076073296e2f34d11ca62f5b184e4b37690d8`, used as the
registry's `semantics_digest`. The executed source diff of tracked files against base
commit `24c2458` has SHA-256
`e675d32a2b5562cdee220c2209582103e6d75a04bd975cfcebbdf1d865d14304`. Prompts,
responses, paths, session and request identifiers and credentials are omitted.

An offline run of the ordinary CLI with the real 2.1.296 binary and a localhost stub
(no Anthropic traffic) completed a direct child that reads a file: 5 usage records,
root 3 and child 2, the child session linked, both pinned to the direct-child
profile. The [offline comparison with 2.1.291](claude-workflow-02196-source-readiness.md#offline-comparison-with-21291)
covers the child scenarios and the Agent tool input change.

## Production connection and supported boundary

The [assigned workflow CLI](../runbooks/task-native-workflow.md#claude-parent-only-workflow)
selects this profile when the launch execution carries `child_runtime`. A protocol
lists one profile per product and version, so a direct-child protocol is separate
from a parent-only protocol. Every launch on a direct-child protocol carries
`child_runtime: { model, effort }` and `permissions: "read-only"`.

| Condition | Result before assignment |
| --- | --- |
| `permissions: "workspace-edit"` with `child_runtime` | `claude_workflow_child_read_only_required` |
| Parent-only execution on a direct-child protocol, or a child execution on a parent-only protocol | `workflow_adapter_mismatch` |
| Conditional child execution on an own-trace protocol | `workflow_adapter_mismatch` |

The assigned CLI compares the selected profile before adapter preflight. Conditional
protocols can hold only own-trace, while `child_runtime` selects direct-child.
Direct adapter preflight for a version without the direct-child admission may
instead give `claude_workflow_child_unadmitted`.

The root gets the Agent tool and exactly one agent type, `workflow-child`. That agent
has the tools Read, Glob and Grep; Agent, Bash, Write, Edit, WebFetch and WebSearch
are disallowed. Its `maxTurns` equals the run's `max_turns`, it is not a background
agent, and the selected instructions are also appended to the child. Runtime values
are user choices; the pair above is qualification evidence, not product policy or
proof that every model and effort combination is available. The model may or may not
use the child. A run without a child still completes.

Only one child is admitted. A second Agent call stops the run with
`claude_probe_child_limit`. Another agent type, a resume request, a background
request, an `isolation` request, a model different from `child_runtime.model`, or an
`effort` different from `child_runtime.effort` in the Agent tool input stops the run
with `claude_probe_child_scope`. Each stop records a gap. These are fail-closed checks
performed at hooks, and hooks may fail open: they are not a guarantee that a request
was never sent.

Child usage is stored on its own session row linked to the root through `parent_id`.
Each child request records the child's model and effort. Membership comes from the
`SubagentStart` hook's `agent_id`, which every child request span carries.

`compatibility inspect` without `--profile` shows the own-trace row for 2.1.296. Pass
the profile to inspect this one:

```sh
node dist/cli.js --db .harness-delta/local.sqlite compatibility inspect \
  --product claude_code --version 2.1.296 --source claude_workflow \
  --profile claude-workflow-direct-child-v1
```

## What stays unsupported

Usage remains an observed subset: complete task cost, billing and inference remain
unavailable, and `real_allocation` readiness does not imply them. Every trace batch
still has no trace sequence or terminal watermark.

Deeper descendants, more than one child, background children and isolated children
are not admitted. A child that can edit files is not admitted. Resume is parent-only:
it cannot be combined with `child_runtime`, a direct-child run cannot be kept with
`resumable`, and a session with a child cannot be resumed. Versions other than
2.1.296, including the conditional own-trace window, cannot start a child.

Timeouts, turn and request limits and `max_budget_usd` are not provider or
subscription spending caps. The evidence used one model and one effort value for
root and child; it does not establish other models or providers. Hook failure
behaviour and delayed exports beyond teardown are not established.
