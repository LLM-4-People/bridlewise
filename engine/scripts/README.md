# Engine scripts

The engine's build, verification, and inventory tooling — the programs the
`harness` commands and the test runner execute. These are operator tooling;
nothing here is imported by the runtime source.

## What each file does

- `build-bundle.ts` — bundles `src/bundle-entry.ts` and its whole import
  graph into the single self-contained `dist/bundle.js` the Landlock
  payload reads, and writes its sha256 and the guardian spec schema.
- `bootstrap-hooks.ts` — points a repository's git at its tracked hooks
  (`core.hooksPath` is per-clone and cannot be tracked, so this one command
  closes the gap). Idempotent.
- `commit-guard.ts` — the program every `pre-commit` hook runs: refuses a
  commit that would silently drop a tracked file from the index (unless the
  deletion was declared deliberate: `harness deletions declare`, which it
  reports as accepted).
- `post-commit.ts` — the program the `post-commit` hook runs: consumes the
  deletion declarations the commit just used and expires the ones whose path
  is on disk again (`src/git/declared-deletions.ts`), in the git that
  committed.
  git ignores its exit status; a declaration it misses is stale and refused,
  never re-used.
- `pin-authority-regeneration.ts` — the pin-authority driver the
  `harness regenerate` / `harness sync` choke point runs as a MANDATORY
  subprocess: it re-derives every `{path, byteLength, sha256}` object pin the
  hash-binding registry cannot carry (the handoff semantic owners, the
  planned-node-test source authority) plus their content projections. It must
  stay master-runtime — a testing-only authority with no subject on a product
  tree is converged by absence inside the driver.
- `regenerate-handoff-manifest.ts` — re-derives the canonical handoff
  protocol manifest from its authority; the pin-authority driver invokes it
  for the handoff projection so the authority and its manifest can never
  drift apart.
- `test-inventory.ts` — the recursive test inventory: discovers the test
  universe and binds every test to its source ID and hash. Every test name
  must be decidable from the test file's own bytes: a literal, or a template
  over the bindings of `for...of` loops (nested loops model their cartesian
  product) whose iterables are literal arrays, a local literal binding, or
  `Object.keys(<local catalog>)`. String, integer, boolean and `null` values
  render as the runtime template would. Imported constants, spreads, computed
  values, calls, ternaries and `new` expressions are refused, because a name
  that moves when another file changes breaks the inventory's identity: keep
  the loop over static labels and derive the runtime value inside the test
  body. An inner loop whose iterable reads an OUTER loop binding is refused
  (it would be evaluated against the file-level name the loop variable
  shadows). Subtests through the test context — `t.test(...)`, or
  `({ test: sub }) => sub(...)` — are refused too, with the context binding
  tracked by the same shadow-aware visitor that finds registrations (a regex
  named `t` inside a test body is not a context): the accountant cannot
  inventory them and the run ends `lifecycle-invalid`; register each case at
  the top level instead. To cover every member of an owner's list (e.g.
  `CORRELATION_FIELD_NAMES`) without restating it, register ONE test that
  loops over the imported list inside its body. The AST child walk and its
  metadata-key list are the shared `astChildren`
  (`src/quality-packs/prevention/ast-helpers.ts`), the same walk the
  architecture analyzer uses.
  `recursive-test-inventory.test.ts` checks every canonical test source
  against this rule, so a violation names its file in a targeted run instead
  of stopping the full-suite auto-heal.

## The subfolders

- `generation/` — generators that derive tracked artifacts from their
  sources.
- [`tooling/`](tooling/README.md) — operator commands: the candidate checkout
  (qualify a dirty tree outside a workspace), the test runners and their
  receipts, run-diff, the lessons queue. Isolated feature work itself is
  `harness workspace` (the development root `ws` script, `src/workflow/`).
- `verification/` — the verification library the `harness check` gates and
  the test runner's auto-heal preflight execute.

Execution terminal v3 retains observed native completion facts alongside raw
worker status, output references and typed results. Live completion and persisted
loading use the same decision in `tooling/test-execution.ts`, consuming the shared
command-terminal policy in `src/shared/run-history.ts`. A raw worker exit 0 with
forced descendant cleanup is an execution refusal; an ordinary failed test with
raw exit 1 and clean completion remains complete failed evidence. Scanning and
loading both replay the decision. The records prove self-integrity, not producer
authenticity. Historical v2 artifacts remain retained and are refused by the
current reader; no native proof is invented for them. Maintenance commands remain
explicitly separate from suites that failed before producing an execution.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `engine/scripts/`.

- `bootstrap-hooks.ts` is consumed by nothing yet.
- `build-bundle.ts` is consumed by nothing yet.
- `commit-guard.ts` is consumed by nothing yet.
- `pin-authority-regeneration.ts` is consumed by nothing yet.
- `post-commit.ts` is consumed by nothing yet.
- `regenerate-handoff-manifest.ts` is consumed by `engine/scripts/pin-authority-regeneration.ts`.
- `test-inventory.ts` is consumed by `engine/scripts/tooling/coverage.ts`, `engine/scripts/tooling/inventory-test-run.ts`, `engine/scripts/tooling/planned-node-test-evidence.ts`, `engine/scripts/tooling/run-tests.ts`, `engine/scripts/tooling/s1-verification.ts`, `engine/scripts/tooling/test-receipt.ts` and 4 more.

<!-- /consumers:generated -->
