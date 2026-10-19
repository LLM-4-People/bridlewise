---
id: FLAKE-REPRO
date: 2026-10-08
by: coordinator
group: process
status: in-force
implementation: partial
route: FLAKE-REPRO-REDECLARE
acted_in: [engine/src/shared/run-history.ts, engine/src/git/flake-cause-fixes.ts, engine/src/shared/flake-reproduction.ts, engine/src/workflow/flake-cli.ts, engine/src/workflow/flaky-burn-down.ts, engine/scripts/commit-guard.ts, engine/src/quality/languages/semantic-form.ts]
---
# A flake cause needs a recorded reproduction

The coordinator's decisions of 2026-10-08 (LAND-OC-FIX round 5 §3, refined
in rounds 6, 9, 11 and 12). They carry out the user's 2026-10-07 rule that a
flaky failure is never forgiven by re-running it or by waiting for it to age
out.

- **No window, no aging out (rounds 11 to 13, design NH-E).** Both suites'
  flaky memories judge every failing row through the one judgement
  (`judgeFlakyMemory`, engine/src/workflow/flaky-burn-down.ts); there is no
  lookback window. The run history may be compacted (it keeps its newest
  `HISTORY_KEPT` rows), the suspects never: a failing row it trims moves to
  the ledger's never-trimmed suspect archive (`flaky-suspects.json` beside
  it), which the memory reads before the ledger (round 13, design HIGH 2).
  A red suspect stays red until it is explained below, or until a
  shrink-only burn-down entry names it with an open owning task row — an
  owned red, never a pass. No run is ever made to push a failure out of
  anything, and the guard never advises it.
- **When a suspect stops indicting.** A flaky-memory suspect is explained by a
  declared and reproduced fix only when all of the following hold:
  - a commit declares that it fixed the cause, in a `Flake-cause:` trailer
    (`<ledger identity> => <paths>[ @ <fix commit>]`); the test's own file
    may be a declared cause;
  - the fix's change to the declared causes is SEMANTIC: at least one cause's
    semantic form differs between the fix's parent and the fix. The form is
    the AST without comments and layout, read by the parser that already owns
    the kind: Babel for JavaScript and TypeScript (with TYPES ERASED: a
    type-only edit changes no behaviour, round 12; the type-only modifiers
    too — an optional `?`, an accessibility, `readonly`, `override`, a
    definite `!` — round 13), tree-sitter for C, the
    canonical value for JSON (engine/src/quality/languages/semantic-form.ts).
    Markdown is never a semantic change. A comment-only, format-only or
    type-only edit is refused by name, and so is a cause whose kind no reader
    judges. This is the strict direction: a failure that depends on types
    alone can never be explained by a type-only fix (round 12's "a type-only
    edit counts if the failure depends on types" is not implemented; such a
    suspect stays red, owned);
  - a recorded reproduction of that test and fix exists, and it ran the
    parent and the fix under the SAME conditions (environment, setup command,
    command run alongside, preloaded shim module, order seed);
  - every indicting failure measured the fix's parent bytes at every declared
    path, the test's own file keyed WHOLE (round 12: the per-test closure
    parser was deleted — a sibling test that pollutes module state, a sibling
    suite body, a hoisted mock, an import kept for its side effects all live
    in the file, so the whole file is the strict and simple key);
  - every indicting failure said what the reproduction's parent runs said
    (its digest) AND happened where they did: its LOCATION — the assertion's
    operator and the function names of the first frames of the test's own
    file, never line numbers (`failureLocation`, engine/src/shared/run-history.ts;
    a failure that names neither is compared by its digest alone);
  - the fix has not RECURRED: a digest its reproduction saw, failing on bytes
    other than the fix's parent's for ANY identity the fix is declared for,
    voids the fix for that digest for all of them (design NH-D). Bytes OLDER
    than the parent count too: content keys carry no order, so the rule errs
    strict (correctness F-L4; ordering by ancestry: FLAKE-RECURRENCE-ORDER).
- **The bar is a probability, from config (round 12, design F-N3).** A fix is
  accepted only if a fix that changed nothing would show the counts — the
  parent failing `f` of `N` runs, the fix none of `N` — with probability at
  most α: the one-sided Fisher exact probability C(N, f) / C(2N, f) ≤ α
  (`testExecution.flakeReproduction.significance`, 0.01;
  `noOpFixProbability`, `reproductionStrength`). The runs per side a failure
  rate needs follow from it (`runsNeeded`; at least
  `testExecution.flakeReproduction.statisticalRuns`, and `--runs` asks for
  more, never fewer). N is NOT derived from the observed rate before the
  runs (design 8e): the door runs the configured minimum or what `--runs`
  asks, and the bar is applied to the counts those runs OBSERVED; a rate too
  low for that N is refused with the runs it would need (`runsNeeded`, in the
  refusal), which the next attempt asks for — and pays for as one more look. **Every look counts (round 13):** a (test, fix) claim
  attempted `k` times — the refused attempts included, read from the kept
  attempts — is judged at α / k, by the door and by the verdict alike, so
  re-attempting until one attempt passes never inflates the claim's error.
  One run per side is strong only for a deterministic shim REGISTERED in
  config (`testExecution.flakeReproduction.deterministicShims`) whose parent
  run failed; any other preload needs the runs an all-failing parent needs.
  The web runner takes a preload too, pinned and recorded exactly like the
  engine's: the door sets `NODE_OPTIONS` for it, and a request's own
  `NODE_OPTIONS` is a door-owned variable, refused. A weaker record is
  reported with the runs it needed, and explains nothing.
- **Every attempt is kept; a record counts only when an attempt shows it
  (round 12, design B4; round 13, R3-2).** The door writes every attempt —
  refused ones included — as ONE FILE per attempt in `attempts/` beside the
  records (engine/traceability/flake-reproductions/), NAMED BY THE SHA256 OF
  ITS BYTES: its conditions, mode, runs, the evidence-store digests of every
  run's output (the outputs are KEPT as evidence) and the sha256 of each
  record it wrote. A record whose bytes no attempt recorded — written or
  edited by hand — explains nothing. Each attempt is checked on its own: one
  whose name is not its hash, whose bytes are not the one serializer's, or
  whose id another attempt also claims is refused ALONE, and every other
  attempt still holds. Two branches' attempts are two files, so a merge is
  their union and never breaks the store (round 12's single hash-chained
  log broke on the first two-branch append). **What it proves, exactly:** a
  record's bytes are the bytes an attempt names, and an attempt was not
  edited after it was named. It is NOT signed: a same-user process can write
  a well-formed attempt and record on purpose (the lock token's limit), and
  a committed attempt's removal is seen only by git, and an UNCOMMITTED
  attempt's removal is seen by nothing: a claim's look count (α / k) is read
  from the attempt files present, so deleting an uncommitted refused attempt
  lowers it unseen. An attempt a later schema refuses is still a look (round
  14). Records made before the attempts were kept (schema v2) are ignored by
  name.
- **An entry nothing can explain.** A burn-down entry whose failures this rule
  can never explain (they measured other bytes, or no reproduction exists) is
  owned by a row naming E-01 (GC-0, the coordinator's decision). That
  decision may: keep it owned; close it with a recorded reason in its row
  (the commit removing the entry names the decision); or re-record it under
  the door. It never clears by itself.
- **A test that moved.** A suspect whose identity left the hermetic suite
  clears only by a recorded move (`harness flake move`): the door reads the
  move commit's and its parent's test inventories, and the verdict checks the
  destination against the live suite's manifest. A test that merely vanished
  has no move, and stays red.
- **How a record is written.** There is one door, `harness flake`. `reproduce`
  runs the tests on the fix's parent and then on the fix, each in a private
  worktree that the one checkout setup prepares, inside the host's one
  instrument lock. Only a test that failed on the parent and passed every run
  on the fix gets a record. The conditions never carry a credential (D-09).
- **Every run is in a fresh world (round 6 §S0, §S4).** The door creates a
  private folder per run under the run's temp root (D-19, refused inside the
  safety floor) holding the run's HOME and TMPDIR, and refuses to run
  anything unless both resolve strictly inside it. The variables the door
  owns — HOME, TMPDIR, its output folder and ANY `GIT_*` — are never a
  request's `--env` and never a record's condition: one predicate,
  `isDoorOwnedVariable` (round 12, security F-2, F-3). The recorded conditions
  pass the one persistence redaction (UR-21): a credential reaches the run,
  never the record. The refusal of a setup or alongside command that
  recursively removes `$HOME`, `~` or a variable it did not make with
  `mktemp -d`, and the whole-tree guard holding every recorded shim, npm
  script, shell script and test string to the same rule
  (engine/test/prevention/no-unconfined-recursive-removal.test.ts), are a
  LINT over the text, not the boundary: the fresh world is the boundary
  (security F-1).
- **A reproduction runs the named commit's code.** Like `ws validate`, it
  installs and runs the parent's and the fix's trees unconfined, as the
  operator. Name only a commit whose code you would run.
- **The syntax is judged at commit time.** The commit-msg door checks every
  `Flake-cause:` trailer. A malformed trailer already in pushed history is
  reported, with its commit, and ignored; it is never thrown.
- **The one other explanation: a regenerated artifact.** The coordinator-filed
  sidecar is deleted. The regression gate suite's arms judge the profile
  report, which is an artifact, not source, so no tree's bytes reproduce it: a
  failure of those arms recorded strictly before the regeneration instant the
  profile step wrote INTO a report that can be judged (`generatedAt`, read
  through the one predicate `judgeableProfileReport`) judged a report that no
  longer exists. Never the file's mtime (a `touch` proves nothing; design F6).
- **The limits, stated (design F5, security T-3).** A declared cause outside
  the test's file is keyed by its declared paths only: a module the test
  imports is held when it is declared, not because it is imported. Code the
  test reaches through `eval` or a computed import is the declared paths'
  business too.
- **Status.** The status is `partial` until every suspect is re-declared under
  these rules with a record the log shows, or owned by a burn-down entry
  (FLAKE-REPRO-REDECLARE).
