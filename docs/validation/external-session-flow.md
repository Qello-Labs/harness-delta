# External first-connection flow: verification boundary

The [user-opened session procedure](../runbooks/external-session-workflow.md) ([한국어](../runbooks/external-session-workflow.ko.md)) now has an opt-in `external-first-connection-v1` clock and descriptive `external-observation-v1` result. Existing assignment deadlines and historical report bytes remain immutable. New tasks cannot be retroactively converted after sessions, activation or usage, and cannot enter legacy randomized comparison capture. No statistical method or production source profile is newly admitted.

| Acceptance | Focused synthetic evidence |
| --- | --- |
| Reviewed project/setup selection and opaque task creation | external-session-service template/builder tests; no invented protocol or criterion |
| Prepare/apply preserves common and user bytes; no clock yet | external-session-workflow managed-file/preimage/symlink/lease tests and external-session-service preparation tests |
| One ticket, exact fresh source and native developer fragment precede first clock | external-session-service root, stale/duplicate/user-role/changed-fragment rejection and connection tests |
| Prior usage stays excluded; task/coverage/result share one fixed window | external-session-service synthetic preconnection events and window-mismatch tests |
| Reconnect, replay, rework and human outcomes retain eligible totals | external-session-service and external-session-cli tests |
| Pause/deadline/drift stop observation without automatic success | external-session-service and existing Codex workflow adapter tests |
| Legacy workflow/report gates remain intact | task-workflow and external-session-workflow tests; `timing_contract_mismatch` assertion |
| Deleted task cannot regain its contract/ticket | external-session-service cascading deletion test |

Node24 focused commands:

```sh
npm test -- tests/qualification/external-session-claude-candidate.test.ts tests/external-session-service.test.ts tests/external-session-workflow.test.ts tests/cli/external-session-cli.test.ts tests/task-workflow.test.ts tests/codex-workflow-adapter.test.ts tests/qualification/claude-probe-coordinator.test.ts
npm test -- tests/qualification/external-session-claude-candidate.test.ts
npm test -- tests/external-session-service.test.ts
npm run typecheck
npm run build
```

The seven-file run passed93/93. The subsequently added non-launching Claude preparation test passed in the13/13 candidate run; no earlier assertion or timeout changed. The final service10/10 rerun also covers drift between a validated baseline and clock commit: rollback leaves the window/ticket uncommitted, then a durable recheck pauses time and preserves user bytes. Typecheck, scoped lint, build and local document links/examples passed; eight EN/KO code blocks are identical. The earlier sandbox-only adapter run could not bind loopback; the same24 adapter tests passed with local-port permission, and the final seven-file run used that permission. This is local synthetic verification, not native qualification or remote CI.

Tests use synthetic product metadata, source files, process observations and local fixture processes/HTTP. The preparation test writes only temporary synthetic private settings/mediator credentials without executing a hook or native process. Native Codex/Claude/model calls, actual native PID inspection, trust/auth changes, credential copying and persistent hook installation were not performed.

Migration019 adds the opt-in contract and ticket tables after existing017/018. Integration owns the sequential Store registry and combined historical downgrade prefix; standalone focused tests bootstrap019 without modifying that shared registry. The old immutable snapshot regression and one bundled independent review/default full check belong to integration. Do not equate focused success with that integration check.

The exact Codex0.160.0 root source admission is preserved, but actual developer-context serialization before the first model turn remains unverified for this coordinator. The [manual Claude candidate](claude-manual-external-candidate.md) is a separate synthetic qualification path, not a production admission or proof of IDE support. Configuration bytes, handed-off invocation, observed native context and actual tool compliance remain separate evidence. Same-store leases do not cover other stores or unmanaged processes; use separate registered checkouts for parallel variants. Results remain descriptive time and partial reference cost; complete cost and inferential A/B effectiveness are outside this batch.
