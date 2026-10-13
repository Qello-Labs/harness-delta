# Offline comparison analysis validation

Developer-only synthetic method study. It does not enable production inference.
For ordinary task work, use [the task procedure](workflow-quickstart.md).

Select Node.js 24 or 26, then run from a Git checkout:

```sh
npm ci
npm test -- tests/comparison-analysis-design.test.ts tests/comparison-analysis-statistics.test.ts tests/comparison-analysis-evidence.test.ts
npm run analysis:validate
npm run check
```

The command compiles its dedicated study and independent oracle using the locked
local TypeScript dependency. Generated files stay under ignored
`.harness-delta/analysis-validation-build/`. It never runs product CLIs, live
conformance, session readers, or collection. No external case, DB, session or
input path argument is supported; unknown arguments fail before compilation.
The production build and exports do not include this study.

To save pure JSON without npm's command banner:

```sh
mkdir -p .harness-delta/analysis-validation-results
npm run --silent analysis:validate > .harness-delta/analysis-validation-results/evidence.json
```

Exit 0 means all versioned bounded checks passed; failure exits nonzero. Preserve
failed evidence. Do not delete failing cases or tune thresholds after results.
A material method change requires a new version and independent review. A
compile/setup failure emits a fixed sanitized failure code; run `npm run typecheck`
locally for compiler diagnostics.

Evidence contains expected/executed counts, each case's exact target and
expectation, sharp-null rejection probabilities, explicit rejected domains,
runtime versions and source/settings/design/case hashes. Case classifications and
required check identities are independently pinned, not inferred only from total counts. Fractions are reduced decimal-string
pairs; comparison is exact. Repeated runs with identical source and runtime are
deterministic. The manifest includes candidate, oracle, acceptance tests, wrapper,
compiler settings, package/lock and ADR. Source hashes bind relative filenames and
contents; their ordered list has an aggregate hash. Generated output is excluded.
These hashes describe provenance, not a trusted admission credential.

Read [ADR 009](../decisions/009-comparison-analysis-validation.md) for assumptions
and [the version 1 dossier](../validation/comparison-analysis-validation-v1.md) for
actual results. `status: pass` applies only to these fixtures. `r10_status` remains
`unvalidated` and adoption remains `inconclusive`. These studies do not authorize
real allocation or inference. V1 real allocation remains disabled; V2 allocation
depends on its separate source-readiness gate. Production inference remains
unavailable. Partial report usage remains partial.

## Separate bounded mean-effect and deadline-quality study

The independent confidence study implements [ADR 010](../decisions/010-comparison-confidence-validation.md).
It does not reinterpret the v1 sharp-null tail as an average-effect interval.

```sh
npm test -- tests/comparison-confidence-method.test.ts tests/comparison-confidence-evidence.test.ts
npm run analysis:validate:confidence
mkdir -p .harness-delta/confidence-validation-results
npm run --silent analysis:validate:confidence > .harness-delta/confidence-validation-results/evidence.json
```

This command has its own ignored `.harness-delta/confidence-validation-build/`
output and accepts no arguments (including data, bound, seed or alpha overrides).
Normal tests use bounded anchors, compatibility/registry checks and mutation
checks; the complete confidence calibration is explicitly invoked by this command.
Neither study is exported or built into the product. The original command and
its argument rejection remain supported separately.

The full confidence run checks every potential table for usage {0,1,2} and
binary task deadline success under nine fixed designs with N<=4. It maximizes
a weighted, target-centered tail over every compatible completed schedule,
re-realizing outcomes on each reference assignment. It compares membership,
envelopes and diagnostics to an independent full-table oracle. Exact per-truth
coverage is checked at all five frozen alphas; no pooling can hide a failing truth.
The 108 zipped endpoint pairs provide limited joint stress checks, not exhaustive
usage-by-quality Cartesian coverage. The union-bound argument is stated separately.

Evidence reports expected/executed identities and hashes, worst coverage with
witness table IDs, exact ranges of per-truth miss/empty/no-narrowing probabilities,
weighted expected cardinalities, compatibility widths and confidence widths
conditional on a nonempty set. Empty outcomes are preserved separately. Every
observation's exact envelope/set/diagnostics and every truth/alpha coverage result
contribute to deterministic audit hashes. A table ID decodes base-L digits in
A1,B1,A2,B2 order, first digit least significant. This permits reproducing witnesses.
Source hashes include the independent oracle, wrappers, compiler settings and tests.

Always distinguish KTargets (observational compatibility) from C (post-test
confidence membership). A width reduction from the global lattice to KTargets is
not inferential narrowing. A hull encloses a finite set; it does not establish
interior real-valued membership. Wide or empty sets do not establish savings,
quality noninferiority or adoption. Read the
[confidence dossier](../validation/comparison-confidence-validation-v1.md) for
actual results and precision limitations. Real token scales, ratios, MNAR,
carryover, stopping, practical margins and real admission remain unvalidated.
