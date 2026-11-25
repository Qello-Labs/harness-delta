# Tool release checklist

Use this checklist for Harness Delta tool releases. Price catalogs follow the
separate [price release checklist](price-catalog-releases.md). Preparing notes
does not authorize a tag, publication, collection activation or a support change.
Read [CONTRIBUTING](../../CONTRIBUTING.md) and the
[development workflow](workflow.md).

Tool tags use `vMAJOR.MINOR.PATCH`, such as `v0.1.0`; price tags use
`reference-prices-*`. Never reuse or move an existing release tag. Under 0.x,
minor releases may break compatibility. Announce breaking changes in the release
notes only; no long-term support is offered.

## 1. Select the reviewed commit

- Select an independently reviewed commit on main whose exact-commit remote CI
  has passed. Record the full commit, CI run and review disposition.
- Choose the tool tag, preview label, delivery form and release scope explicitly.
  A source-tag release does not authorize an npm package, registry publication,
  separately uploaded tarball or prebuilt binary.
- Preserve existing activation, qualification, version caps, defaults and pins
  unless a separate decision authorizes changing them.
- Record the current price release's manifest identity, digest and artifact
  identity before publishing. For v0.1.0 the expected price release is
  [reference-prices-2026-11-25-v5](https://github.com/Qello-Labs/harness-delta/releases/tag/reference-prices-2026-11-25-v5);
  its [notes](../release-notes/reference-prices-2026-11-25-v5.md) give the identities.

## 2. Verify the selected source

- Run `npm run check` locally on Node 26.
- Select Node 24, install matching dependencies, build, then run the focused
  suites appropriate to the release scope.
- Record runtime, platform, exact source commit, commands, exit codes and test
  counts. Follow the native ABI instructions in
  [CONTRIBUTING](../../CONTRIBUTING.md#development-environment).
- Keep local checks separate from exact-commit remote CI. Neither replaces the
  other, independent review or a clean-install check.

## 3. Check clean installations

Use separate fresh clones and fresh synthetic databases for Node 24 and Node 26.
Check out the exact selected commit before tagging; the eventual tag must resolve
to that same tested commit. If the tag already exists, verify its commit first.
Do not use a historical measured database or start an agent/model request.

For each runtime, from its clean checkout:

```sh
npm ci
npm run build
node scripts/hm.mjs --help
node scripts/hm.mjs --db :memory: compatibility status
node scripts/hm.mjs --db release-price-check.sqlite price-table refresh-catalog --online
npm start -- --db release-ui-check.sqlite ui
```

- `node scripts/hm.mjs --help` is the source-checkout invocation of `hm --help`;
  a source release does not install a global command. Check its successful exit.
- The in-memory compatibility status must succeed without collecting usage.
- The online price refresh uses only the new synthetic database. Verify the
  accepted catalog identity matches the current price manifest recorded in step 1.
  Preserve missing/unpriced usage and existing price-policy boundaries.
- After the UI prints its loopback URL, check the built page from another
  terminal:

```sh
curl --fail --silent --show-error --output /dev/null http://127.0.0.1:4318/
```

  Require a successful HTTP response and confirm the UI opens. This is a local
  UI health smoke check, not native collection or source qualification. Stop the
  owned UI with Ctrl+C afterwards.
- Record both runtime results, including failures. A native ABI mismatch must
  fail with `native_dependency` and exit 4; reinstall and rebuild under the chosen
  runtime rather than hiding the mismatch.

## 4. Prepare the release notes

- State the tag, preview status, source-install steps and changes. Claim only the
  capabilities documented by the [README](../../README.md) and
  [support matrix](../support-matrix.md).
- List unsupported routes/conditions, disabled activation, partial cost and
  qualification limits. Delivery alone does not close activation gates or grant
  new support.
- Include forward-only database migration, a consistent backup of `--db` before
  upgrading, the prohibition on opening a database with an older release, Node
  and native ABI requirements, accepted price capability and 0.x breaking changes.
- Prepare a separate ignored release-body file, for example
  `.harness-delta/releases/v0.1.0/release-body.md`, containing the reviewed release
  notes plus the literal full release commit and its passing exact-commit CI URL.
  Keep the placeholder in the tracked release notes; that template alone is not
  the prepared body. Shell variables and unresolved placeholders are not concrete
  commit/CI bindings.
- Keep earlier price release notes as historical records; update current client
  guidance instead of rewriting their original version-floor statements.

## 5. Review the notes and evidence

- Obtain independent review of the exact notes, checklist results and intended
  release commit. Resolve material findings before publication.
- Review the separately prepared release-body file. Its literal full commit must
  match the selected and tested release commit, and its CI URL must identify a
  passing run for that same exact commit. Resolve missing or mismatched bindings
  before publication.
- Check that install, compatibility and clean-database price refresh evidence is
  complete for both Node versions. Mark unrun checks as pending, not passed.
- Keep detailed and sanitized evidence under the ignored local work directory.
  Publish only non-secret release facts, commit/CI references and limitations.

## 6. Publish without replacing the price channel

After explicit tag/publication authorization, create the source tag and GitHub
release at the reviewed commit. Tool releases must use `--latest=false` and must
never be marked latest. For v0.1.0, replace the commit placeholder and use the
release-body file prepared and reviewed in steps 4-5 before running:

```sh
releaseCommit=REVIEWED_FULL_COMMIT_SHA
releaseBody=.harness-delta/releases/v0.1.0/release-body.md
gh release create v0.1.0 --target "$releaseCommit" \
  --title 'Harness Delta v0.1.0 (developer preview)' \
  --notes-file "$releaseBody" --latest=false
```

The prepared body's literal commit must equal `releaseCommit`; do not pass the
unchanged tracked notes directly to `--notes-file`.
Verify the created tag resolves to the reviewed, tested commit. Do not upload
packages or binary assets for a source-tag-only release.

Immediately after the tool release, independently check:

`https://github.com/Qello-Labs/harness-delta/releases/latest/download/manifest.json`

It must still resolve to the current **price** manifest, matching the recorded
publisher/catalog/version/policy and digest identities. Check the digest-named
catalog too, using the [price checklist](price-catalog-releases.md#3-validate-immutable-release-assets).
For v0.1.0, this means the v5 price manifest, not a tool-release asset.
The price client's online source reads `releases/latest`; marking a tool release
latest would break that refresh channel. A successful `gh release create` alone
does not prove the price channel is intact. Record the actual download check and
stop release completion if it fails.

## 7. Verify the published source

- Download GitHub's source archive for the published tool tag into a fresh
  location, verify its tag/commit identity, install dependencies and build it once.
  Record the runtime, archive identity, build command and result.
- Keep this post-publication check distinct from the pre-publication fresh-clone
  checks and the separate latest-price-manifest verification.
- Report publication, installation and price-channel results separately, with
  any remaining limits. Do not claim activation or native qualification from a
  successful source build.
