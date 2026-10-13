---
name: harness-register
description: Use when a user wants to package explicitly selected existing harness instructions and related tool files as an immutable harness-config version.
---

# Register a harness version

Use a built Harness Delta checkout with Node 24 or 26. This reference package can be
copied to a skill directory; it requires no personal plugin or installed global CLI.

Inspect the explicit project root and user-prepared candidate instruction and
optional script/document paths first. Propose missing harness IDs, versions,
policy versions, selected files and README sources from that evidence; label new
names as proposals. Group unresolved choices into one confirmation instead of
asking the user to fill every field individually. Keep the selection explicit.
An instruction mentioning a tool
does not authorize running it. Choose the primary instruction's target as
`harness.md`; preserve relevant relative file layout. Do not generate a replacement
harness, modify original files, infer a dependency closure or install the skill.

## Current baseline and prepared candidate

A and B are roles in one comparison, not permanent version names. A represents
the project's currently applied instructions and tools; B is the prepared
improvement while preserving the common rules. A candidate file merely existing
in the checkout does not make it part of the applied baseline. Inspect the actual
entry instructions and application evidence, then ask the user to confirm any
ambiguous inclusion. Never infer adoption from the newest manifest, a successful
task, lower partial cost or an earlier B assignment.

Reuse an existing immutable baseline only after checking that its selected
artifacts match the confirmed current configuration. Otherwise propose a new
baseline version and explicitly selected files. Registration snapshots selected
artifacts, not the entire checkout or native configuration. Missing baseline
instructions, README or a composed candidate procedure require a separate
creation request; do not silently fabricate a no-op baseline or replace common
project policies with the candidate document.

Review the candidate instruction, optional supporting files, README and local
references as a proposed selection before registering. Ask before adding
referenced files. Select `snapshot` for prepared instructions or `agent_applied`
for an explicit application procedure; executable examples alone do not choose
the mode. If the requested composition cannot be represented by existing files,
explain the missing preparation and obtain approval before creating it.

After a person chooses and actually applies an improvement, that verified current
configuration can be A in a new comparison against the next prepared candidate.
Use new version/comparison IDs where contents change, preserve historical bundles
and assignments, and never rename the former B to A. Registration does not choose,
apply or persist an adopted winner.

Create an input JSON file from the explicit selection:

```json
{
  "schema_version": 1,
  "harness_id": "search",
  "version": "baseline",
  "policy_version": "policy-v1",
  "readme_path": "harness-notes.md",
  "artifacts": [
    {"artifact_id":"instruction","role":"instruction","source_path":"policy.md","target_path":"harness.md"},
    {"artifact_id":"search-tool","role":"tool","source_path":"scripts/search.py","target_path":"scripts/search.py"}
  ]
}
```

All source_path and target_path values are relative to the explicit project root.
For a derived version, add `"base":{"path":"harness-config/baseline/manifest.json"}`.
The README must explain purpose, application from the project root, manual
prerequisites, selected-file limits and manual verification. Original commands
and references are preserved. Unselected dependencies remain manual prerequisites.

Run the helper using the location of this skill's script:

```sh
node scripts/run.mjs --harness-delta /path/to/harness-delta --root /path/to/project --input /path/to/register-input.json
```

The command writes `harness-config/<version>/harness.md`, `README.md`,
`manifest.json` and only selected supporting files. Same inputs return
`already_registered`; changed bytes under an existing version fail with
`harness_version_conflict`. Choose a new explicit version for changed contents.
Missing files, unsafe paths, symlinks and unresolved inline local Markdown links
block publication. The supported inline link check is conservative and does not
validate command strings, reference-style links, dependencies or executable behavior.

Report the generated relative paths and integrity hashes. Explain that snapshot
integrity does not prove native instruction loading or tool execution. No
measurement registration, DB operation, session access or model call is performed.

For agent application, the selected `harness.md` is the application procedure and
included tools are executed from the pinned bundle in a qualified confined draft.
They are not automatically copied back to `source_path`. Registration keeps the
original files; it does not run the procedure or validate native execution safety.
Use an explicit version-2 `agent_applied` comparison for this mode.

For initial local UI setup, continue with `harness-compare-config` using these
two explicitly selected immutable snapshots. Registration here still performs
no measurement DB writes. The UI's guided input review can reuse reviewed local
measurement inputs or validate explicit production registration JSON before the
user confirms it; it does not turn snapshot integrity into source authorization.
