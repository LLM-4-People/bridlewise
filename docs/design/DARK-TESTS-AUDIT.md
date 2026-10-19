---
layout: default
title: 'Dark-tests audit — how much of the green number is real'
---

# Dark-tests audit — how much of the green number is real

Read-only analysis. Neither suite was run. Every count in this document was taken by reading
bytes in node (`readFileSync(f, "utf8")` + match in process), never by `grep`, per the NUL-byte
rule in §8b.5.

**Provenance for live-defect claims** (a writing agent is active; two claims in an earlier
report were true when written and false six minutes later):

| Repo | HEAD at analysis |
|---|---|
| `harness-main-v1` (outer) | `acb13db3dd81faf46874f775b618c9c3ea9a8e5f` |
| `harness-main-v1/integration` (nested repo) | `cebe0f4fcd29a8a34d9a06beafe4e0dee6742e7c` |
| `web-interface-foundation-v1` | `0c7e5363687f5d434796f5bec3d4296910365814` |

mtimes of every file a live claim rests on are recorded inline at the claim.

---

## 0. LADDER VERDICT (for §5, the fix)

> **Rung reached: 4**, at two doors that already exist and that no test file can bypass.
>
> **Rung 1 (physically impossible):** unavailable. "This test executed an assertion" is a
> property of a JavaScript call sequence. No filesystem permission, read-only connection or
> SQLite trigger can express it, because no engine or OS object is touched by a test that
> asserts nothing — that is precisely its defect.
>
> **Rung 2 (unrepresentable):** available in principle, rejected under §9. Typing a test body
> as `() => readonly Assertion[]` (it must RETURN its assertions) makes the empty case a type
> error. It also means abandoning vitest's `expect` and rewriting all 6,150 web test
> declarations — 200 lines of custom machinery and a bespoke assertion library for the last
> 20%, which §9 prohibits by name.
>
> **Rung 3 (unreachable by shape):** available for the SCAN half and recommended as step 2.
> `walk()` returning a branded `NonEmptySourceSet`, or taking a required `minimum: number`
> argument, makes forgetting the liveness check a compile error at one door covering 129 web
> test files. Not sufficient alone: it says nothing about a test that skips.
>
> **Rung 4 (runtime choke point):** where I land. Two assertions at two existing single doors —
> `tests/setup/test-setup.ts` (vacuity) and the runner's passing gate (skipping). Detail in §5.
>
> **Rung 5 (source-scan guard):** the current state for vacuity in both repos, i.e. nothing.
> An inventory of known-dark tests is rung 5 and will rot; this document is that inventory and
> should be read as evidence for §5, not as the deliverable.

---

## 1. THE DARK INVENTORY

### 1a. Method, and what "dark" means here

Three populations were scanned by walking the tree in node and matching against a
comment-and-string-blanked view of each file (a raw match finds `it.skipIf` inside a docstring
and manufactures a finding — this happened once during the audit and is corrected below):

- web: 446 `*.test.ts`/`*.spec.ts` under `tests/`, of which **439** are matched by
  `vite.config.ts`'s `test.include` globs (`tests/unit` 99, `tests/component` 11,
  `tests/prevention` 208, `tests/cockpit` 120, `tests/performance` 1). The 7 `*.spec.ts` are
  Playwright's and are not in the vitest run.
- integration: 411 `*.test.ts` under `test/` + 2 under `verification/`.

**"Dark on a fresh checkout"** means: both repos cloned side by side (the web suite cannot run
otherwise — see §3a), `npm install` run in each, and nothing else. No profile run, no prior
suite run, no generated caches.

### 1b. Skip-family mechanisms — the complete universe, and it is small

Measured across both repos. This is an exhaustive enumeration, not a sample: the raw
(comment-inclusive) scan found only 24 skip-family occurrences in total across ~857 test files,
so the universe is small enough to have been read individually.

| Mechanism | web | integration |
|---|---|---|
| `it.skip` / `test.skip` | 1 (in a Playwright spec — not in the vitest run) | 0 |
| `describe.skip` | 0 | 0 |
| `it.todo` / `describe.todo` | 0 | 0 |
| `it.skipIf` | **20** | 0 |
| `describe.skipIf` | **1** | 0 |
| `runIf` | 0 | 0 |
| `this.skip()` / `t.skip()` | 0 | 0 |
| node:test `{ skip: … }` option | n/a | **1** |
| `expect.hasAssertions()` / `expect.assertions(n)` | **0** | n/a |

Two corrections to the brief's framing, both mechanical:

- The brief states "22 further `it.skipIf`s nested beneath it". The byte count is **20**
  (`tests/performance/regression.test.ts` lines 47, 53, 58, 63, 68, 77, 84, 92, 99, 104, 113,
  125, 139, 154, 163, 169, 175, 183, 192, 204). Plus one plain `it` at line 43 that is also
  dark because the enclosing `describe.skipIf` fires. **21 tests in the gate, not 23.**
- A `describe.skipIf` I first reported at `tests/prevention/test-naming-structure.test.ts:69`
  is **inside a docstring** describing the parser's supported syntaxes. Not a finding.

### 1c. THE CONFIRMED-DARK GATE (web) — `tests/performance/regression.test.ts`

mtime `2026-07-25 11:52:50`. Not touched by the concurrent writer.

```
:39  describe.skipIf(!existsSync(REPORT_PATH))("web UI performance regression gate", …)
```

`REPORT_PATH` is owned by `tests/performance/lib/perf-harness.ts` and resolves to
`tests/performance/.report.json`. That path is **gitignored at `.gitignore:13`**, with a comment
naming the generating step (`playwright test --config=playwright.perf.config.ts`).

**Verified absent on this machine now** (`ls tests/performance/` — the directory holds
`profile.spec.ts`, `regression.test.ts`, `lib/`, `cockpit/`, `scale/`, `.gitignore` and
`.cockpit-report/`; there is no `.report.json`). It is therefore dark **both** on a fresh
checkout and right now.

**Assertions hidden: 21 tests.** Counted individually:

| line | test | assertions hidden | second mechanism |
|---|---|---|---|
| 43 | report present and parseable | 1 | — |
| 47 | LCP within budget | 2 | — |
| 53 | CLS within budget | 1 | — |
| 58 | worst long task | 1 | — |
| 63 | total long-task time | 1 | — |
| 68 | every tab switch | 1 + loop | loop over `r.tabs`, `continue` on `!t.ok` |
| 77 | tab DOM node count | loop only | **vacuous if `r.tabs` is `[]`** |
| 84 | typing latency | 1 | **early `return` at :87 and :88** |
| 92 | slowest API response | 1 | **early `return` at :95** |
| 99 | heap growth | 1 | — |
| 104 | DOM growth | 1 | — |
| 113 | interactive elements | loop only | **early `return` at :115** |
| 125 | routes discovered | 1 + loop | **early `return` at :127** |
| 139 | profiled routes in budget | loop only | **early `return` at :141 and :148** |
| 154 | slowest route | 1 | **early `return` at :156** |
| 163 | long-chat render | 1 | **early `return` at :165** |
| 169 | long-chat scroll | 1 | **early `return` at :171** |
| 175 | 10k-projects render | 1 | **early `return` at :177** |
| 183 | viewport LCP | loop only | **early `return` at :185** |
| 192 | every viewport profiled | 1 + loop | **early `return` at :194** |
| 204 | report freshness | 2 | — |

This gate is **doubly dark**. Even after someone runs the profile and `.report.json` appears,
**12 of the 21 tests carry an early `return` that skips their assertion when the corresponding
report section is empty**, and 5 more assert only inside a `for` loop that is vacuous over an
empty array. A profile run that measured nothing would light the gate up green.

### 1d. THE SECOND CONFIRMED-DARK GATE (web) — the runtime budget itself

`tests/prevention/web-ui-runtime-budget.test.ts`, mtime `2026-07-27 15:07:11`. 7 tests.

```
:180  test("the previous vitest run stayed under the configurable budget (one-run lag)")
        if (verdict.kind === "unmeasurable") { console.info("[runtime-budget] NOT JUDGED — …"); return; }
:196  test("no test file carries a multi-second cost the scheduler cannot see")   — same shape
:217  test("no single test file occupies a disproportionate share of the pool")   — same shape
```

The input is `BUDGET_SUMMARY_PATH`, owned by `tests/helpers/budget-paths.ts`:
`.bridlewise/web-test-results/latest-summary.json`. `.bridlewise/` is **gitignored at
`.gitignore:4`**.

**Verified absent on this machine now.** `.bridlewise/web-test-results/` exists and is
**empty** (`total 12`, only `.` and `..`), directory mtime `2026-07-25 05:57:01`.

So **3 of the 7 tests in the file that guards the 35-second budget are NOT JUDGED right now**,
and were also NOT JUDGED on a fresh checkout's first run by design (the one-run lag). This is
the guard behind the contract's "under the **35s** wall-clock budget… Both are real guards"
baseline line.

To the file's credit, it does not fabricate: it prints `NOT JUDGED` and names what was missing,
which is §5 applied correctly. But **it still reports PASS**, and a pass is what the quoted
green number counts.

**A live hypothesis I could not close** (stated as a hypothesis, not a finding): the writer at
`tests/reporters/budget-reporter.ts:216–222` wraps the summary write in

```ts
try { mkdirSync(SUMMARY_DIR, { recursive: true }); writeFileSync(SUMMARY_PATH, JSON.stringify(summary)); }
catch { /* A write failure must not break the test run; the budget test refuses to judge … */ }
```

— an **empty catch on the write**. The three most recent web commits (`0c7e536` "Move the
sandbox's scratch out of the sandbox's reach", `4e04c6e`, `5b92cd2` "Confine the model's
commands to the selected project (Landlock)") introduce write confinement. If the confined run
can no longer write `.bridlewise/web-test-results/`, the throw is swallowed here, no summary
lands, and the budget guard reports NOT JUDGED **forever**, silently. That is consistent with
the directory being empty with a Jul 25 mtime. **Verification (which I could not run): execute
the suite and check whether `latest-summary.json` appears.** I am not asserting the cause; I am
asserting the observable — the file is absent and three budget assertions are consequently not
executing.

### 1e. Mechanisms that turned out to be CLEAN (negative results are results)

- **Empty `catch {}` around an assertion: zero real instances in either repo.** A raw scan
  suggested 42 web / 83 integration; a structural scan for `try { …expect|assert… } catch {}`
  narrowed it to 5, and reading all 5 shows every one is a false positive:
  `test/safety/bandaid-harder.test.ts:48`, `test/safety/bandaid-no-static.test.ts:118` and
  `:468`, `test/aux/exp446-checks.test.ts:34` are **adversarial fixture strings** fed to a
  bandaid detector (the empty catch is the payload under test, which is correct); and
  `tests/prevention/subprocess-confinement-owner.test.ts:191` is a `try/finally`, no catch.
- **`import.meta.glob` returning `{}`: one real site, and it is guarded.**
  `tests/prevention/shared-primitive-bindable-contract.test.ts:162` globs
  `../../src/lib/shared/*.svelte`; the file asserts a floor at `:170–171`
  (`expect(valueBindables.length).toBeGreaterThan(0)`), and an empty glob would fail
  `expect(modulePath, …).toBeDefined()` at `:177`. The two hits in
  `tests/prevention/frontend-stores-deep.test.ts:147,151` are the literal string
  `import.meta.glob` inside a test name and an assertion message — my comment-blanker desyncs
  on regex literals containing quotes (`/["']\.\/store-registry["']/` at `:144`), which is how
  they survived. Not findings.
- **A walker rooted at a gitignored path: one, and it is a content-hash cache, not an input.**
  `tests/prevention/no-a11y-warnings.test.ts:53` reads `.bridlewise/svelte-a11y-cache.json`.
  A miss recompiles; the cache key is the file's content hash (`:56–57`), so a stale entry
  cannot mask a changed file. Safe.
- **`expect(x).toBeDefined()` with no real subject:** 151 occurrences in web. I did not
  classify these individually and make **no claim** about them — see COVERAGE.

### 1f. Integration — no skips, but two whole-file dark classes

Integration runs on `node:test` through an inventory (`npm test` → `scripts/run-tests.ts` →
`scripts/test-worker.ts` → `scripts/inventory-test-run.ts`), not on vitest. It has **zero**
`it.skip`/`describe.skip`/`todo`/`skipIf` in 413 test files. Its darkness is at the file level.

**Class A — 19 files, ≥286 test declarations, never run on ANY checkout.**

411 test files exist under `test/`; the canonical inventory
(`traceability/s1-test-inventory.json`, mtime `2026-07-28 05:32:58`) names **394**. The 17-file
gap plus 2 more resolves to 19 files:

- **15 excluded by `experimentSourceExclusions: ["exp*", "auto-learning", "llm-beyond-max",
  "unified"]`** (`src/root-policy.ts`, mtime `2026-07-28 05:33:24`), matched against the first
  path segment under `test/` by `shouldExcludeExperiment` in `src/shared/source-scan.ts`:
  `test/exp420/exp420.test.ts` (8 tests), `test/exp438/exp438-e2e.test.ts` (16),
  `test/exp450/exp450-unified.test.ts` (11), `test/exp464/exp464-e2e.test.ts` (18),
  `test/exp473/harness-regenerate-schema.test.ts` (4), `test/exp473/novel-findings.test.ts`
  (16), `test/exp473/search-fixes.test.ts` (10),
  `test/auto-learning/auto-learning-5-rounds.test.ts` (45),
  `test/auto-learning/cusum-conflation.test.ts` (3),
  `test/auto-learning/exp451-benchmark.test.ts` (25),
  `test/llm-beyond-max/dedup-v2-keywords.test.ts` (4),
  `test/llm-beyond-max/exp449-new-modules.test.ts` (19),
  `test/llm-beyond-max/mock-integration.test.ts` (8),
  `test/llm-beyond-max/new-modules.test.ts` (24), `test/llm-beyond-max/unit.test.ts` (20).
- **4 excluded by a `pending-external-qualification` disposition** in
  `traceability/test-surface-dispositions.json` (mtime `2026-07-28 03:06:45`), each with the
  rationale *"Uses non-standard test patterns (custom assert, vitest, or dynamic test names)
  not modeled by the static test inventory parser"*: `test/conversation-summary.test.ts`,
  **`test/improper-usage.test.ts`**, `test/shared-memory/shared-memory.test.ts` (23),
  `test/shared/dedup-compression/lower-layer.test.ts` (32).

Total counted by static `it(`/`test(` declarations: **286**, and that is a **lower bound** —
`conversation-summary.test.ts` and `improper-usage.test.ts` yielded 0 matches precisely because
they use the non-standard patterns their disposition names, so their real test count is unknown
and non-zero.

Worth flagging on its own: **`test/improper-usage.test.ts` does not run.** §8 makes "tests for
improper usage, unknown results, and things that should NOT work" the assignment rather than an
extra, and the file named for that assignment is outside the executed set.

This class is dark on a fresh checkout, on a warm machine, and in CI. It is the only fully
unconditional dark set found in either repo.

**Class B — 696 tests across 32 files, dark on a WARM machine, not on a fresh checkout.**

This is the inverse of the web case and is the largest single number in this audit.

`scripts/inventory-test-run.ts:201–207` calls `classifySlowTestFiles(sourceIds, priorDurations,
thresholdMs)`. `src/workflow/test-result-collector.ts:342–355` gates out any file whose
**previously measured** wall-clock exceeds `slowFileThresholdMs`, which
`bridlewise.config.json` sets to **8000**. The prior durations come from
`TEST_FILE_DURATIONS_PATH = ".bridlewise/state/test-results/file-durations.json"`
(`test-result-collector.ts:30`) — and **`.bridlewise` is gitignored** at
`integration/.gitignore:6`.

Measured against the file as it stands (mtime `2026-07-28 06:22:56` — written by the concurrent
writer's run 6 minutes before this analysis; the set below moves with it):

- 394 files have a recorded duration; **32 exceed 8000ms**.
- Those 32 files hold **696 of the 8,530 inventory entries — 8.2%**.
- Largest contributors: `test/foundation-slice.test.ts` (194),
  `test/workflow/test-result-collector-concurrency.test.ts` (140),
  `test/evaluation/matrix-executor.test.ts` (119), `test/workflow/harness-commands.test.ts`
  (52), `test/verification/recursive-test-inventory.test.ts` (24),
  `test/candidate-format.test.ts` (22), plus all 15 `test/s1-scenarios/b*.test.ts` files.

**Fresh-checkout behaviour is the opposite:** no durations file ⇒ empty map ⇒
`classifySlowTestFiles` gates nothing (`:349–351` requires a recorded number) ⇒ all 8,530 run.
The comment at `:338–340` states this intent explicitly ("gating requires POSITIVE evidence of
slowness"). A fresh checkout therefore runs *more* tests and would very likely exceed
`suiteRuntimeBudgetMs: 48000`.

**And here is the part that matters most.** Integration already owns the strongest passing gate
in either repo — `scripts/inventory-test-run.ts:543`:

```ts
const passed = normalizedRunnerSummary.successful && failed === 0 && skipped === 0 && todo === 0 &&
  summaryMatches && counts.cancelled === 0 && allUnknownTests.length === 0 &&
  orderedDiscovered.length === expectedCount &&
  orderedPassed.length === expectedCount && counts.discovered === expectedCount &&
  counts.passed === expectedCount;
```

`skipped === 0` is exactly the "CI reports skipped as failed" rung the brief asks about, and it
is already built. **The RUN_SLOW gate walks straight through it**, because the gated tests are
not skipped — they are removed from the *denominator*:

```
:354  const gatedSourceIds = options.gatedSourceIds ?? new Set<string>();
:359  const activeTests = gatedSourceIds.size === 0 ? … : <inventory minus gated>
:376  const expectedIds = activeTests.map((entry) => entry.id);
:529  const expectedCount = activeTests.length;
```

So `counts.passed === expectedCount` is satisfied against a denominator that silently shrank by
696, `skipped` stays 0 because nothing was ever dispatched, and the receipt reports a clean
pass. **The best gate in the codebase is defeated by subtraction rather than by skipping.**
This is §2's "a second undeclared registry that made a mechanical guard pass vacuously" in a
new costume, and §8's "a guard must state its covered population as a runtime number and assert
a floor on it" — the population here is a runtime number and nothing asserts a floor on it.

### 1g. The vacuous-scan class — structurally present, not currently firing

The brief records this as "already known to affect 27 files". My independent count is **26**
web test files that call a scan producer (`walk`, `walkTs`, `sourceFiles`,
`sourceFilesReachableFrom`, `readdirSync`, `globSync`) and contain **no** non-emptiness
assertion anywhere in the file. The one-file difference is heuristic, not substantive; treat 26
as a lower bound because my "has a non-empty assertion" regex over-matches (any
`toBeGreaterThan` or `toHaveLength` in the file counts as protection, wherever it sits).

The 26: `artifact-rendering-owner`, `async-db-facade-owner`, `bench-fixture-drift`,
`chat-rendering-owner`, `config-handler-dedup`, `css-tokens-owner`, `dedup-compression-owner`,
`editor-data-integrity`, `editor-rendering-owner`, `graph-metrics-performance`,
`no-dead-css-selectors`, `no-dead-css-tokens`, `no-duplicate-code`, `no-duplicate-constants`,
`no-empty-catch`, `no-hardcoded-truncation-slices`, `no-hardcoded-values`, `no-liveness-claims`,
`no-throw-new-error`, `no-unused-exports`, `no-unused-imports`, `project-delete-safety`,
`state-imports-resolve`, `tool-duration-owner`, `ui-primitives-owner` (all under
`tests/prevention/`), and `tests/unit/hardcoded-values.test.ts`.

**Are they dark on a fresh checkout? No.** Their literal roots are `src`, `server`, `src/lib`,
`contracts`, `.` and similar — all tracked. The universe is non-empty on any checkout, so these
tests do examine files today. What they are is **structurally capable** of going vacuous the
moment a root is renamed, moved or conditionally absent, with no signal — which is the class
the fix must close, not an active defect I can count into "the number".

**The single choke point is one line.** `tests/helpers/source-scan.ts:68` (mtime `2026-07-28
04:10:53` — edited by the concurrent writer today, so re-read before acting):

```ts
export function walk(root, opts = {}, visited = new Set()): string[] {
  …
  if (!existsSync(root)) return out;      // ← silently returns []
```

and its sibling at `:667`, inside `sourceFilesReachableFrom`:

```ts
  for (const entry of entrypoints) {
    const abs = resolvePath(entry);
    if (!existsSync(abs)) continue;       // ← silently drops a missing entrypoint
```

Every capability guard in the web repo derives its population from one of these two functions.
A missing root produces an empty population and a green run, with no diagnostic. 129 web test
files call a scan producer; 103 happen to contain some non-empty assertion, 26 do not.

**A sub-class my expect-based scan initially missed, and it matters:** **80 web test files use
`throw new Error(...)` as the assertion rather than `expect`**, and **8 of them contain zero
`expect(` in the entire file** — `no-dead-css-tokens`, `no-duplicate-code`,
`no-duplicate-constants`, `no-empty-catch`, `no-hardcoded-values`, `no-throw-new-error`,
`no-unused-exports`, `tests/unit/hardcoded-values`. Their shape is
`for (const f of files) { …collect offenders… } if (offenders.length > 0) throw new Error(...)`.
Seven of those eight are also in the 26. **This shape is invisible to `expect.hasAssertions()`**
— it would report those files as having zero assertions and fail them — so it is a required
migration cost of the §5 fix, and one §8 wants anyway.

### 1h. Loop-generated tests — where the missing ~2,150 come from

Static count: **6,150** `it(`/`test(` declarations across the 439 included web files. The
recorded baseline is 8,288–8,366. The difference is **80 test-declaration sites inside a loop,
across 43 files**, plus 11 `.each` sites. Top generators:
`frontend-components-deep.test.ts:122` (7 sites), `ui-primitives-owner.test.ts:78` (6),
`frontend-routing-owner.test.ts:145` (4), `graph-rendering-owner.test.ts:143` (4).

This is a distinct and worse failure mode than a vacuous assertion. **When the collection is
empty, those tests are not skipped and do not pass vacuously — they are never declared at all.**
The total simply comes out smaller, and nothing compares it to anything. `433 files, 8288
passing` has no floor under it: a run reporting `433 files, 6150 passing` would be reported as
green by every mechanism in the repo except a human noticing the number moved.

The repo already contains the correct antidote, in exactly one place —
`tests/prevention/web-ui-runtime-budget.test.ts:171–178`:

```ts
test("the glob that counts a full run is not vacuous", () => {
  // Everything below leans on this number. If the globs stopped matching,
  // every coverage check would pass trivially against a floor of zero.
  expect(discovered, "test.include matched suspiciously few files — the coverage check would be vacuous")
    .toBeGreaterThan(300);
});
```

That is the pattern §5 generalises. One file has it; 438 do not.

---

## 2. THE NUMBER

### Web — on a fresh checkout, ~24 of ~8,288 execute no assertion (~0.3%)

Derivation, all terms mechanical:

| term | value | source |
|---|---|---|
| `regression.test.ts` — whole gate dark | **21** | 1 `describe.skipIf` + 20 `it.skipIf` + 1 plain `it`, byte-counted; input gitignored `.gitignore:13`, verified absent |
| `web-ui-runtime-budget.test.ts` — unmeasurable branch | **3** | lines 180, 196, 217; input under gitignored `.bridlewise/`, verified absent |
| **Total dark on a fresh checkout** | **24** | |
| Denominator | 8,288 | recorded baseline |
| **Fraction** | **≈ 0.29%** | |

**This is a LOWER BOUND**, for four stated reasons: (i) I did not classify the 151 bare
`.toBeDefined()` calls; (ii) my test-body parser desyncs on regex literals containing braces, so
its 160 "tests with no `expect`" figure is unreliable and is **not** used above; (iii) 12 of the
21 gate tests carry a *second* early-return that would keep them dark even after the profile is
generated, which this number does not double-count; (iv) the 80 loop-generated sites can silently
reduce the total without any test being marked dark.

**The honest headline: the web repo's ~8,300 is ~99.7% real.** The confirmed-dark set is two
files, and both of them *say* they are not judging. The web repo's problem is not a large dark
set — it is that nothing prevents one, and that its two dark gates are the two that guard
performance and the suite's own runtime budget, i.e. exactly the numbers the baseline quotes.

### Integration — the gap is here

| scenario | tests declared | not executed | fraction |
|---|---|---|---|
| Fresh checkout | 8,530 inventory + ≥286 non-inventoried = **≥8,816** | **≥286** (Class A) | **≥3.2%** |
| This machine / any warm or cached CI | ≥8,816 | **≥982** (286 + 696) | **≥11.1%** |

The 696 figure is exact against `file-durations.json` as of mtime `2026-07-28 06:22:56` and
**moves between runs** — it is a function of the last run's measured timings against an 8000ms
threshold, so a file drifting across 8s enters or leaves the dark set with no code change and no
announcement. Per §8 ("do not sample a tree that is still being written"): the writer's run
rewrote this file 6 minutes before I read it; I am reporting the number I measured, and the set
membership is expected to move.

Both figures are **lower bounds**: `conversation-summary.test.ts` and `improper-usage.test.ts`
contribute an unknown, non-zero count that the 286 excludes.

### Combined

Roughly **1,006 of ~17,100 declared tests across both repos do not execute on the machine that
produces the green receipt** (~5.9%), of which **~97.6% of that gap is integration's**, not the
web UI's. The number that has been quoted all session to authorise merges — 433 files, ~8,288
passing — is close to fully real. **The number nobody quotes is the one with the hole in it**,
which is the precise shape of the failure the contract's "Baselines you must not regress"
section already records ("Two rounds ran against a red baseline because the number that failed
was in the repo nobody quoted").

---

## 3. THE GITIGNORE CROSS-CHECK

All `.gitignore` files in both repos were read, including nested ones
(`web/bench/.gitignore`, `web/tests/performance/.gitignore`, `integration/.gitignore`,
`harness-main-v1/.gitignore`, `candidate/.gitignore`, `detect-secrets/.gitignore`).

### 3a. The largest absent-input dependency is not a gitignore at all — it is the sibling repo

**34 web test files reach into `../../../harness-main-v1/integration/`.** The web suite is not
independently checkoutable. Classified by what happens when the sibling is absent:

| behaviour when absent | count | representative sites |
|---|---|---|
| **LOUD** — static import, whole file errors | 19 | `block-description-honesty.test.ts:47`, `credential-surface-owner.test.ts:30`, `egress-redaction-owner.test.ts:47`, `privacy-layers-owner.test.ts:34`, `symbol-search-single-path.test.ts:49`, `tests/unit/context-trimming.test.ts:27`, … |
| **LOUD** — direct `readFileSync` throws | 1 | `tests/unit/cross-user-path-access.test.ts:66` |
| **SILENT-VACUOUS** — `walk()` over the sibling returns `[]` | **6** | `awareness-quality-bridge-owner.test.ts:77`, `content-search-owner.test.ts:78`, `dedup-compression-owner.test.ts:188`, `graph-rendering-owner.test.ts:501`, `intelligence-bridge-owner.test.ts:70`, `subprocess-confinement-owner.test.ts:93` |
| **SILENT-SKIP** — `existsSync` guard + early `return` | **2** | `centralized-config.test.ts:17`, `integration-rule-refs-ratchet.test.ts:30` (4 returns, at `:93`, `:100`, `:128`, `:133`) |
| unclassified by my heuristic | 6 | `exposure-registry-counts.test.ts:77`, `tasks-no-stale-duplicates.test.ts:10`, `coverage-blocks-real-ledger.test.ts:14`, … |

The 20 LOUD files are the honest ones — they make the dependency undeniable. The **8 SILENT
ones are the siblings of the confirmed-dark gate**: they are dark for anyone who checks out only
the web repo, and they go dark *quietly*, while 20 of their neighbours are screaming. Anyone
debugging that state fixes the 20 loud failures, sees green, and never learns that 8 files
examined nothing.

`integration-rule-refs-ratchet.test.ts:93` is candid about it in a comment — *"…vacuous. In the
standard workspace it IS co-located."* — which is a claim about the world of exactly the kind
§8 says must carry evidence, and it carries none.

### 3b. Generated / gitignored test inputs, both repos

| input | gitignored at | consumer | dark for whom |
|---|---|---|---|
| `tests/performance/.report.json` | web `.gitignore:13` | `tests/performance/regression.test.ts:39` | anyone who has not run the Playwright profile — **confirmed, 21 tests** |
| `tests/performance/.run.json` | web `.gitignore:14` | perf harness | same run |
| `.bridlewise/web-test-results/latest-summary.json` | web `.gitignore:4` (`.bridlewise/`) | `web-ui-runtime-budget.test.ts:180,196,217` via `tests/helpers/budget-paths.ts` | anyone on run #1 — **confirmed, 3 tests, and currently absent on this machine** |
| `.bridlewise/state/test-results/file-durations.json` | integration `.gitignore:6` | `test-result-collector.ts:56` → `classifySlowTestFiles` | **inverted** — its PRESENCE darkens 696 tests; its absence lights them |
| `.bridlewise/state/test-results/latest-collection.json` | integration `.gitignore:6` | fallback source at `test-result-collector.ts:83–88` | same |
| `.bridlewise/state/test-results/auto-heal-fingerprint.json` | integration `.gitignore:6` | `run-tests.ts` auto-heal | cache only |
| `.bridlewise/svelte-a11y-cache.json` | web `.gitignore:4` | `no-a11y-warnings.test.ts:53` | **not dark** — content-hash keyed, miss recompiles |
| `bench/.fixtures/`, `bench/.out/`, `bench/.scratch/` | web `bench/.gitignore` | `bench-fixture-drift.test.ts` | **not dark** — it reads `bench/*.bench.ts` (tracked) and builds its own fixture into a temp dir (`:62–64`) |
| `tests/performance/.cockpit-report/` | web `tests/performance/.gitignore:1` | Playwright cockpit perf only | not in the vitest run |
| `*.db`, `*.db-shm`, `*.db-wal` | integration `.gitignore` | — | no vitest/node:test consumer found |

**Note on method, and it is a real trap:** the second confirmed-dark gate (§1d) is **invisible to
a text search of the test files**. `web-ui-runtime-budget.test.ts` never contains the string
`.bridlewise` — the path is assembled in `tests/helpers/budget-paths.ts`, one import away. A
grep of `tests/**` for gitignored path fragments finds `no-a11y-warnings.test.ts` and misses the
gate that actually matters. This is §8b's "a module one import away" failure verbatim, and it is
the workflow finding in §6.

---

## 4. ORDER AND ISOLATION

### 4a. Cross-RUN dependencies (run N's output decides run N+1's behaviour)

1. **Web budget ratchet, one-run lag.** `budget-reporter.ts` writes the summary at
   `onTestRunEnd`; `web-ui-runtime-budget.test.ts` reads it on the *next* run. Run #1 after any
   checkout is structurally NOT JUDGED. The contract already records the consequence: "a cold
   run reds the FOLLOWING run through the one-run-lag budget test."
2. **Web budget ratchet is disarmed by an ordinary single-file run — already documented, still
   live.** `tests/helpers/budget-verdict.ts:18–25` records it: *"`npx vitest run <one-file>`
   invokes the same reporter and overwrote the summary with that file's duration. Proved
   directly — a summary reading `{"wallClockMs":174}` was then compared against a 35,000ms
   budget by the next FULL run and passed."* The mitigation is `MIN_COVERAGE_FRACTION = 0.9`
   plus the coverage floor. **This is why a read-only agent must not run `npx vitest run <file>`
   in this tree**, and it is worth stating in the contract's read-only section, which currently
   does not say it.
3. **Integration slow-file gate, one-run lag with a worse consequence.** Run N writes
   `file-durations.json`; run N+1 uses it to decide **which files to run at all**. A file that
   crosses 8000ms once is removed from the default suite thereafter, and
   `writeTestFileDurations` (`test-result-collector.ts:110–120`) deliberately *merges* prior
   durations forward so a gated file's slowness is never forgotten — which is correct for
   stability and means **a file gated once tends to stay gated**.
4. **Integration auto-heal fingerprint.** `run-tests.ts` runs `autoHealTestInventory()` before
   the suite, keyed on a fingerprint cached under `.bridlewise/`. A cache hit skips
   regeneration.

### 4b. Within-run shared state

`tests/setup/test-setup.ts` is a genuinely good piece of work and closes most of this class at
the right choke point (worker scope, before any test file is read). It records having fixed:
ledger/DB redirection to a worker temp dir (the *"every ledger-touching test appended to the
LIVE dev ledger… grew by hundreds of rows per run"* leak the brief refers to), `process.env`
snapshot/restore, `vi.unstubAllGlobals` + a watchlist compare, temp-dir sweep (*"filled a 36G
tmpfs with 74,476 stale dirs"*), time-travel `returnToLive()` (five files planting a head and
never returning), and `resetUiSchema()`.

Two observations:

- **A stale doc comment, not a defect.** `test-setup.ts`'s header documents "the `isolate: false`
  isolation contract" at length, but `vite.config.ts` now sets **`isolate: true`** with its own
  rationale (`vi.mock` was being silently ignored; `composer-commit-seam`,
  `flow-stream-channels` and `model-provenance-owner` passed in isolation and failed in the
  suite). The setup file's stated premise no longer holds. §1's single-source rule applies: two
  places answer "what is the isolation contract" and they disagree.
- **The live ledger is still 130MB and was written today.** `.bridlewise/timeline.db` mtime
  `2026-07-28 06:01`, 130,859,008 bytes. I did **not** establish that a test wrote it — the dev
  server is the far likelier author and the setup file's redirection looks correct. Recording it
  as an observation, not an accusation.

### 4c. What I did not find

No test in either repo depends on another test **within** a run having executed first (no
module-level mutable fixture shared across files, no ordered suite requirement) that I could
detect statically. The dependencies are all cross-RUN and via disk, which is the more tractable
shape.

---

## 5. THE FIX, AT THE LOWEST CHOKE POINT

Verdict on each candidate the brief names, with the rung it actually reaches.

| candidate | rung | verdict |
|---|---|---|
| `expectNonEmpty(files)` shared helper | 5 | **Reject as stated.** It is a convention every future caller must remember, which §3 names as "a list someone must remember to update". |
| …but its choke point, hardened | **4→3** | **Accept, as step 2.** Not a helper callers invoke — change `walk()` itself at `source-scan.ts:68` to **throw** on a missing root instead of returning `[]`, and `sourceFilesReachableFrom` at `:667` likewise. Callers cannot forget, because they do not own the walker. Push to rung 3 by giving `walk` a required `minimum: number` parameter so omitting the floor is a **compile error** — covering 129 files at one door. |
| `expect.hasAssertions()` globally via setup | **4** | **Accept, as step 1 for web.** The strongest available. |
| assertion-count / coverage ratchet | 5 | **Reject.** A number that drifts, needs a stored baseline (another gitignored artifact — the exact mechanism in §3b), and answers "did the total move" rather than "did this test assert". It is the shape that already failed here. |
| make the skip CONDITION an assertion | **4** | **Accept, as step 3.** A gate that skips must first prove its input is *legitimately* absent. |
| CI reports skipped as failed | **4** | **Accept, as step 1 for integration — and note it already exists there and is bypassed.** |

### What I would actually build, in order

**Step 1a — web: `expect.hasAssertions()` in the one setup file.**

Add to `tests/setup/test-setup.ts`:

```ts
beforeEach(() => { expect.hasAssertions(); });
```

**Why this door.** `vite.config.ts` names `setupFiles: ["./tests/setup/test-setup.ts"]`. Vitest
re-executes it for **every** test file; there is no per-file setup override in this
configuration, so **no test file can opt out**. A test that runs its body and asserts nothing
fails — including a test nobody has written yet, which is §3's "relieve responsibility, make
forgetting impossible". It covers, in one line, the entire early-return class, the empty-loop
class, the empty-glob class and the empty-walk class — because all four have the same
observable, and that observable is now the failure condition rather than the pass condition.

**The migration cost, stated up front so it is not discovered mid-change:** the **80 files using
`throw new Error` as the assertion** — 8 of which contain no `expect` at all (§1g) — must be
converted to `expect(offenders, "<message>").toEqual([])`. That is not incidental work to
absorb; it is the change §8 already asks for, and it is what makes those 8 files' emptiness
detectable. Land it as its own task before flipping the flag.

**What it does NOT cover, and this is why step 1b exists:** a *skipped* test runs no hooks, so
`hasAssertions` never fires for it. `regression.test.ts`'s 21 tests are untouched by this.

**Step 1b — web: skipped is a failure, at the runner.**

`scripts/run-tests.ts` is the single door (`package.json` `"test"` points at it, and it already
owns the wall-clock watchdog and the orphan reaper). Make it fail the run when vitest reports a
non-zero skipped/todo count, with an explicit, declared allowance:

```ts
// A skipped test is a test whose assertions did not execute. It is reported
// as a pass by every downstream number, so it must be refused here — the one
// place every `npm test` passes through.
if (skipped > ALLOWED_SKIPS) { /* name them, exit 1 */ }
```

`ALLOWED_SKIPS` is not a magic number: it is `0`, and gates that legitimately need to skip go
through step 3 instead.

**The one bypass to close:** `package.json` declares `"test:raw": "vitest run"`, which reaches
vitest directly and evades both the watchdog and this gate. §3's *"so it cannot be bypassed and
is de facto"* means `test:raw` must be **deleted**, not documented. It is also the mechanism
behind the documented budget-disarm in §4a.2 — deleting it fixes two things.

**Step 2 — integration: stop shrinking the denominator. This is a deletion.**

`scripts/inventory-test-run.ts:359` builds `activeTests` as *inventory minus gated*. Delete the
subtraction: keep `activeTests = inventory.tests`, and instead **emit the gated entries as
`skipped`**. The existing gate at `:543` — `skipped === 0` — then fires on its own, with no new
mechanism, no new registry, and no new number to maintain.

The consequence is intended: `npm test` on a warm machine stops reporting a clean pass while
696 tests sit undispatched. The operator's real choice becomes explicit — run `RUN_SLOW=1`, or
declare the gated set in the config where §17 says configurables live and where a reviewer can
see 696 written down. This is §0's *"prefer removing the possibility to enumerating its
instances"*: the fix is removing a subtraction, not adding a scanner.

I would build this **first**, before the web work. It is one edit, it needs no migration, it
uses a gate that already exists and is already correct, and it closes the largest hole in this
audit.

**Step 3 — both repos: a skip must PROVE its input is legitimately absent.**

Replace ad-hoc `describe.skipIf(!existsSync(P))` with one shared owner:

```ts
// tests/helpers/generated-input.ts — the ONLY way a suite may gate on a missing input.
export function gateOnGeneratedInput(path: string, generatedBy: string): boolean
```

which, **before** permitting the skip, asserts:
1. `path` is matched by a `.gitignore` rule in this repo (an absent input that is *tracked* is a
   broken checkout, and must fail loudly rather than skip);
2. `generatedBy` names a script that exists and is reachable from `package.json`;
3. the gate registers itself, so `npm test` can print `2 gates dark: <path> (run: <cmd>)` as a
   line in the run output rather than as silence.

This turns "the file is missing" — a fact about a machine — into "the file is *declared*
generated, by a step that *exists*, and its absence is being *announced*" — a claim carrying
evidence, which is §8's exemption rule applied to skips. It is what would have made
§1d's currently-absent budget summary visible instead of a `console.info` nobody reads.

**Step 4 — the shape fix for the scan universe.**

`walk()` at `source-scan.ts:68` throws on a missing root; `sourceFilesReachableFrom` at `:667`
throws on a missing entrypoint (today it `continue`s, so a guard whose every entrypoint moved
reports an empty closure and passes). Then give `walk` a required `minimum: number` so the floor
is part of the call and omitting it is a compile error — rung 3, at a door 129 files already go
through. `web-ui-runtime-budget.test.ts:171–178` is the working prototype; this generalises it.

### Why not just keep an inventory like this document

Because it is rung 5 and it will rot — the brief says so and it is right. Concretely: the 696
figure in §1f is a function of a gitignored file that the concurrent writer rewrote 6 minutes
before I read it. Any list I publish is stale before it is reviewed. Steps 1–4 are all things
that are *true or false at run time*, which is the only property a list cannot have.

---

## 6. COVERAGE — what I verified, read, and did not establish

### Verified mechanically (node, reading bytes)

- Test-file universes: 446 web (439 matched by `vite.config.ts` `test.include`, per-directory
  counts given in §1a); 411 integration under `test/` + 2 under `verification/`.
- The complete skip-family universe in both repos, scanned twice — raw, and against a
  comment-and-string-blanked view — with every one of the 24 raw hits read individually.
- 21 dark tests in `regression.test.ts`, by line number.
- 3 unmeasurable-branch tests in `web-ui-runtime-budget.test.ts`, by line number.
- **Absence of `tests/performance/.report.json`** and **emptiness of
  `.bridlewise/web-test-results/`** on this machine, by directory listing.
- 8,530 inventory entries over 394 canonical integration sources; 411 files on disk; the 19-file
  gap resolved to its two causes with the exact config values behind each.
- 696 gated tests across 32 files, computed from `file-durations.json` against
  `slowFileThresholdMs: 8000` read from `bridlewise.config.json`.
- The denominator-shrinking path, `inventory-test-run.ts:354→359→376→529→543`.
- 6,150 static web test declarations; 80 loop-generated sites across 43 files; 11 `.each` sites.
- 129 web files calling a scan producer, 26 with no non-empty assertion; 80 files using
  `throw new Error` as the assertion, 8 with no `expect` at all.
- 34 web files depending on the sibling repo, classified by failure mode.
- Zero `expect.hasAssertions()`/`expect.assertions()` in either repo.
- Zero real empty-catch-around-assertion (all 5 candidates read and dismissed).

### Read in full or in substantial part

`TIER1-AGENT-CONTRACT.md`; web `vite.config.ts`, `package.json`, `scripts/run-tests.ts`,
`tests/setup/test-setup.ts`, `tests/helpers/source-scan.ts`, `tests/helpers/budget-paths.ts`,
`tests/helpers/budget-verdict.ts`, `tests/reporters/budget-reporter.ts`,
`tests/performance/regression.test.ts`, `tests/prevention/web-ui-runtime-budget.test.ts`,
`tests/prevention/bench-fixture-drift.test.ts`, `tests/prevention/no-a11y-warnings.test.ts`,
and excerpts of ~10 further prevention tests; integration `scripts/run-tests.ts`,
`scripts/inventory-test-run.ts`, `scripts/test-inventory.ts`,
`scripts/verification/test-surface.ts`, `src/workflow/test-result-collector.ts`,
`src/shared/source-scan.ts`, `src/root-policy.ts`, `bridlewise.config.json`,
`traceability/s1-test-inventory.json`, `traceability/test-surface-dispositions.json`;
all six `.gitignore` files across both repos.

### NOT established — do not build on these

1. **Neither suite was run.** Every "dark" verdict is derived from source plus the presence or
   absence of a file on disk. The 21-test and 3-test figures are *predictions* about what a run
   would report. They are strongly founded (the skip conditions are pure `existsSync` on paths I
   listed and verified) but they are not observations of a run.
2. **The 151 bare `.toBeDefined()` calls are unclassified.** I make no claim about how many have
   an always-defined subject. This is the largest un-audited category and the most likely source
   of additional findings.
3. **My test-body parser is unreliable and its numbers are excluded from §2.** It counts braces
   without understanding regex literals, so `/\.board\s*\{([^}]*)\}/` desyncs it. Its outputs —
   "160 tests with no `expect`", "646 tests whose first `expect` is inside a loop" — are
   **discarded**, not reported. A correct version needs a real TS parser.
4. **The 26-file vacuous-scan count is a lower bound with a crude protection test.** Any
   `toBeGreaterThan`/`toHaveLength` anywhere in a file counts as protection, wherever it sits.
   The true count of unprotected scans is ≥26.
5. **I did not establish that the empty catch in `budget-reporter.ts:219` is why the summary is
   absent.** Landlock confinement landing in the three most recent commits makes it plausible
   and the dates fit. It is labelled a hypothesis in §1d with the verification step named.
6. **I did not establish that any test wrote `.bridlewise/timeline.db` today.** The dev server
   is the likelier author. Recorded as an observation only.
7. **Integration's 8,530 is the inventory count, not an observed pass count.** I did not verify
   that a run reports 8,530 minus 696.
8. **The web baseline says 433 files; I count 439 matched by the include globs.** I did not
   determine whether the 6-file difference is the concurrent writer adding files, a stale
   baseline, or files vitest excludes for a reason I did not find. Per §8 ("do not sample a tree
   that is still being written"), I am reporting the discrepancy rather than picking a number.
9. **`test/conversation-summary.test.ts` and `test/improper-usage.test.ts` test counts are
   unknown** — their non-standard patterns are exactly why they are excluded, and they defeat a
   static count too. The 286 figure excludes them.
10. **No CI configuration exists in either repo** (`.github/workflows` absent in both), so
    "dark in CI" throughout means "dark for whoever runs the command", and the "CI reports
    skipped as failed" option in §5 has no CI to plug into — it must go in the runner, which is
    where I put it.

---

## 7. Workflow improvement (§20)

**An absent-input dependency must be asked of the import graph, never of the test file's text —
and this repo already owns the tool to do it.**

The second confirmed-dark gate (§1d) contains no path string at all. `.bridlewise` appears in
`tests/helpers/budget-paths.ts`, one import away, so a text search of `tests/**` for gitignored
path fragments finds only the a11y cache — a false lead — and misses the gate that is actually
dark. I found it by reading the helpers directory, i.e. by luck. This is §8b's "a module one
import away" recorded again, in the auditing method rather than in a guard.

The fix is not more diligence. `tests/helpers/source-scan.ts:658` already exports
`sourceFilesReachableFrom(entrypoints)`, written for precisely this — its docstring says a
capability guard's population is "the transitive closure of its entry points" because "the
module that started the program was ONE IMPORT AWAY". **"Which tests depend on a gitignored
input" is a capability question in exactly that sense**, and it should be a prevention test:
take every test file as an entrypoint, walk the closure, and fail when a reachable module
contains a path matched by a `.gitignore` rule unless that dependency is declared through the
`gateOnGeneratedInput` owner of §5 step 3. Today no audit and no guard uses
`sourceFilesReachableFrom` for this, and the repo's own best instrument sits unused against the
question it was built for — §19's "correct and unplugged", in the test suite itself.
