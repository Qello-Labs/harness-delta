---
name: harness-compare-config
description: Use when a user wants a portable baseline-versus-modified comparison file from two existing immutable harness-config versions.
---

# Generate a portable comparison

Use a built Harness Delta checkout with Node 24 or 26. Read both version manifests
under the explicit project root. Select distinct existing versions with baseline
as A and the prepared improvement as B. Verify the user's confirmed current
baseline rather than assuming the latest registered version is applied. Propose
a comparison ID and display name from the selected versions and group missing
choices for confirmation. Do not create a new harness or invent variants, statistical settings,
prices, completion criteria, credentials or runtime defaults.

## Successive improvement cycles

A/B describe this comparison's roles. For example, an initial comparison may use
versions `baseline` and `search-v2`. If a person later adopts and actually applies
`search-v2`, the next comparison may use `search-v2` as A and `search-v3` as B.
Require confirmation and evidence of the current applied configuration before
reusing the earlier candidate as the new baseline. A registered bundle, assigned
arm, completed task or partial cost estimate is not adoption evidence.

Keep original version IDs, comparisons, task assignments and historical snapshots
unchanged. Generate a new comparison ID for the new pair. If no registered version
matches the current configuration, return to `harness-register` for an explicit
baseline selection rather than changing an old bundle. Comparison generation
neither applies the candidate nor records or automatically decides adoption.

Create this input JSON with the user's selected IDs:

```json
{
  "schema_version": 1,
  "id": "baseline-vs-v2",
  "name": "Baseline vs v2",
  "arm_a": "baseline",
  "arm_b": "v2"
}
```

Run the helper using the location of this skill's script:

```sh
node scripts/run.mjs --harness-delta /path/to/harness-delta --root /path/to/project --input /path/to/comparison-input.json
```

The command verifies both snapshots and writes
`harness-config/comparisons/<id>.json`. It includes ordered relative references,
whole-bundle hashes and a deterministic settings_hash; it contains no absolute
paths, DB identity, model choice or machine binding. Same inputs return
`already_generated`. A changed descriptor under an existing ID fails with
`shared_settings_conflict`; use a new explicit ID for a different comparison.

To connect on another PC, copy the repository's harness-config files, then use
Local UI → Setup → Guided setup and input review. Connect the Git project first,
enter the generated comparison JSON path and explicitly select an existing
reviewed measurement template. If none exists, ask for the missing local inputs:
one production LocalWebProfile, the ordered schema-2 variant registrations, a
complete schema-2 protocol, its price table and an explicit freeze timestamp.
Use selected manifests for hashes and policy versions; eligibility and all
measurement choices must be explicitly reviewed, not invented. Individual JSON
objects can be pasted or chosen as files in the guided form. Reuse registered
references rather than asking the user to duplicate them.

Review lists missing fields/registrations and performs rollback-only validation.
The user reviews project, A/B, criterion IDs, runtime/source scope and full frozen
protocol/price/private configuration before confirming registration. Then select
the project and template in the comparison preview and confirm the separate
private binding step. Missing or conflicting registration remains a blocker.
The UI writes private immutable JSON under
`.harness-delta/setup`; new tasks pin that revision. Import does not start tasks,
execute tools, access sessions or launch agents/models. Snapshot integrity,
registration compatibility and native execution support remain separate facts.

Report relative output paths, hashes and manual prerequisites. Tool-only changes
affect bundle identity even if instruction hashes are unchanged. Original tools
stay in the project and are checked for the assigned arm before use; this feature
never installs or restores them. Complete costs and statistical adoption remain
unavailable under existing support gates.

## Copyable result path

The helper returns `{status, descriptor}`, not a file path. After `generated` or
`already_generated`, take the returned `descriptor.id` and construct
`harness-config/comparisons/<descriptor.id>.json`. Resolve this relative path
against the explicitly selected project root. Verify that the saved JSON exists
and its descriptor matches the returned result before reporting its absolute path.
Do not guess a path or show a success result after a failed command.

In the final response, show the actual absolute JSON file path on one line in a
standalone plain-text code block. Put no command, quotation marks, label, hash or
other text inside that block. Follow it with a short instruction in the user's
language: paste this path into **Comparison JSON file path** in the local UI.
Other result details can follow separately.

This absolute path is only a local copy/paste aid in the response. Keep the saved
comparison JSON's references relative and portable; do not add an absolute-path
field or relocate the file. On another PC, verify and show that PC's actual path.

## Explicit agent application

For project-specific agent application, select a new comparison ID and use
`"schema_version": 2` with `"application": "agent_applied"` in the input above.
The saved procedure and included scripts guide the applying agent; generated
project instructions have a separate output manifest. Original-tool matching is
retained for version 1 only. Existing descriptors are never migrated in place.
Use `harness-apply` after assignment. Current native execution and working-session
loading remain qualification-pending and fail closed.
