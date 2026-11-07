# Agent display metadata

This local display extension implements R02 and R04. It does not admit new
sources, versions, production collection or complete cost. Tests use synthetic
metadata only; no previous conversation or personal session log was inspected.

## Sources and boundaries

- [Codex 0.160.0 protocol source](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/protocol/src/protocol.rs)
  defines optional `SessionMeta.agent_nickname` and `agent_role` for spawned agents.
  The provider reads these two fields from the child's first envelope only, after
  receipt/source/family verification. Root identity remains receipt-only. No
  messages, titles, agent paths or instructions supply display names.
- [Claude hook reference](https://code.claude.com/docs/en/hooks#common-input-fields)
  documents `agent_type` for subagents and sessions configured with `--agent`.
  [SubagentStart](https://code.claude.com/docs/en/hooks#subagentstart) describes
  built-in types, custom frontmatter names and plugin-qualified identifiers.
  The private hook receipt supplies this field; no configuration file is opened
  to infer a name. Discovery prefers the start receipt over the stop receipt.

Names are trimmed, limited to 128 characters and exclude control/format
characters. Invalid or blank fields are unavailable, never a reason to scan
history. An optional, product-specific `agentMetadata` field is persisted in the
existing local binding identity JSON; no database migration is needed. Old
records omit it. The local API projects `agent_metadata` with `agent_type` for
Claude. Measurement exchange contracts do not include this field.

Display metadata is excluded from identity equality. The first stored label is
retained; reconnect does not backfill old labels or rename prior observations.
Relations, replay keys, runtime attribution and aggregation still use session
identifiers. Models are the distinct models of eligible observed events, with an
empty list for unknown. Duplicate display names use a suffix of a hash of the
full identity, extending it if needed. Child ordinals count only linked children
in durable binding order.

## Reproduce verification

From Node 24, build first, then run:

```sh
npm run build
npm test -- tests/sources/agent-metadata.test.ts tests/agent-display.test.ts tests/agent-display-ui.test.ts tests/session-binding-codex.test.ts tests/session-binding-claude.test.ts tests/session-binding-service.test.ts tests/binding/session-binding-human-pilot.test.ts tests/session-binding-api.test.ts tests/session-binding-claude-api.test.ts
npm run check
```

Coverage includes native metadata projection, private-content exclusion,
malformed names, model separation, EN/KO rendered tables, duplicate names,
shared UUID prefixes, legacy records, persistence, replay and same-UUID resume.
Synthetic success does not prove native source admission or remote CI success.
