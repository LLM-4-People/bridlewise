---
layout: default
title: 'Guard universe audit — where every guard stops looking'
---

# Guard universe audit — where every guard stops looking

**Agent:** read-only. Nothing in either repo was modified; no test suite was run.
**Method:** every COUNT in this report was produced by `readFileSync(f,"utf8")` and matching
in-process under node. No count came from `grep`. (§8b.5 — eight first-party files carry a NUL
byte, which makes GNU grep print nothing and exit 0.)

**Provenance at time of writing:**

| repo | HEAD | working tree |
|---|---|---|
| `web-interface-foundation-v1` | `0c7e5363687f5d434796f5bec3d4296910365814` | clean (0 modified) |
| `harness-main-v1` | `e3e036a15cf9f1924275aa7fb9ad3a5d92c9d968` at session start | `TIER1-PLAN.md` modified |

A writing agent is active in `harness-main-v1`. Two of my subagents observed
`integration` HEAD as `cebe0f4fcd29a8a34d9a06beafe4e0dee6742e7c` — i.e. **the writer committed
during this audit**. Every live-defect claim below carries the mtime of the file it rests on,
and every harness claim was re-derived by me after the subagents reported. All the web claims
rest on a clean tree at a single sha.

---

## LADDER VERDICT (§0)

**Rung reached: 5 (source scan) for essentially the entire guard estate — by construction.**
This audit produces no code, so the verdict here is about *what the guards themselves reached*
and what is available to them. The finding is that **rungs 1–4 were never unavailable; they
were never attempted.** Specifics are in §5.

- **Rung 1 (physically impossible):** unavailable to a *test*, but NOT unavailable to the
  system — a CSS build step that refuses to compile a hex literal, or a checked-in perf
  baseline, are both rung-1 answers that were skipped in favour of a scan.
- **Rung 2 (unrepresentable):** available and unused. The clearest case: `tests/**` in the web
  repo is in **no tsconfig at all**, so the 439 guard files are never typechecked — the guards
  are the least type-protected code in the repository.
- **Rung 3 (unreachable by shape):** available and unused. `walk()` returning `string[]` is why
  105 guards cannot tell "clean" from "empty".
- **Rung 4 (runtime choke point):** available, unused, and **one line from existing** —
  see §5.1.

---

## 0. THE HEADLINE

The thesis I was asked to test is **confirmed, and it is now mechanical rather than
rhetorical.** Three independent measurements, each reproduced from bytes:

1. The cockpit token guard checks only the `<style>` block of `.svelte` files. **18 literal
   colours** live in `src/cockpit/**` — 3 in `.svelte` outside `<style>`, 15 in `.ts`. Exactly
   the region the guard's universe stops at. (§1.3)
2. The dead-token guard's universe is the single hardcoded path `src/styles/tokens.css`. The
   repo has **two** token files. In the other one — `src/cockpit/tokens.css`, the **larger** at
   925 lines — there are **18 dead tokens**, including `--t-3`, the exact token a guard asserts
   *exists*. (§1.2, §2.1)
3. `no-dead-css-selectors.test.ts` contains a second test named *"the scanner itself is
   precise"* whose body is a loop over the findings array. Today that array is empty, so the
   test **executes zero assertions** — and it can only ever execute one in a state where the
   first test has already failed. It is structurally incapable of failing. (§3.2)

But the deeper result is not any of those three. It is this:

> **The single most consequential line in the entire guard estate is
> `tests/helpers/source-scan.ts:68` — `if (!existsSync(root)) return out;`.**
> 105 web guards call this walker. **72 of them assert no floor on what it returned.** If a
> scanned directory is renamed, those 72 guards — holding **2,161 assertions** — go green
> having read nothing. The same shape, hand-written, covers 13 harness guards and 244 more
> assertions.

That is not 85 separate bugs. It is **one bug, in one line, inherited 85 times** — and it is
fixable at rung 4 by changing that line to throw.

---

## 1. THE EXCLUSION MAP

### 1.1 Inventory

I found guards in **more places than the brief's two directories**. Searching by shape rather
than path:

| repo | directory | test files | note |
|---|---|---|---|
| web | `tests/prevention/` | 208 | the known set |
| web | `tests/cockpit/` | **120** | **a second guard estate**, in the vitest include (`vite.config.ts:120`) |
| web | `tests/unit/` | 99 | contains real source-scanning guards (`hardcoded-values`, `token-resolution`, `sole-writer`) |
| web | `tests/component/` | 11 | |
| web | `tests/performance/` | 2 | one of them is dark (§3.1) |
| web | `tests/cockpit/e2e/` | 5 `.spec.ts` | **not matched** by the vitest include (`*.test.ts` only) — Playwright only |
| harness | `test/prevention/` | 47 | the known set |
| harness | `test/{architecture,workflow,verification,mcp}` | 37 | includes `test/filesystem/self-protection/prevention/` — **a `prevention/` directory outside `test/prevention/`** |

**523 test files inventoried, 17,013 assertions.** `cockpit-tokens-owner.test.ts` — the file the
brief named — is in `tests/cockpit/`, which is *why* an audit scoped to `tests/prevention/`
would have declared it absent. That is the exclusion map applied to the audit itself.

Excluded with reason, not silently: `experiments/`, `candidate/`, `large-codebases/`,
`mutant-tests/`, `probes/`, `research/`, `detect-secrets/` are all gitignored forks or vendored
trees, not this product's source.

### 1.2 Exclusion by EXTENSION

Across all 439 web guard files, counting how many scan each extension:

| extension | guards scanning it | first-party files under `src/`+`server/` |
|---|---|---|
| `.ts` | 86 | 326 |
| `.svelte` | 78 | 150 |
| `.css` | **2** | **2** |
| `.html` | **0** | 1 |
| `.json` / `.md` | **0** | — |

Two `.css` files exist. `src/styles/tokens.css` (514 lines) is covered for deadness.
**`src/cockpit/tokens.css` (925 lines) is covered by no deadness guard at all** — and it is the
one holding the dead tokens.

**A latent extension hole, honestly bounded.** `tests/helpers/source-scan.ts:32` exports
`SOURCE_EXTS = [".ts",".svelte",".mjs",".cjs",".js"]`, documented as *"the single owner of the
extension set so a new executable extension … auto-covers every prevention test that imports
it (deny-by-default: a bypass cannot hide in a non-TS extension)"*. But:

- `walk()`'s own default (`source-scan.ts:65`) is `[".ts",".svelte"]` — **not** `SOURCE_EXTS`.
- **Only 3 guards import it**: `async-db-facade-owner.test.ts:37`,
  `db-transaction-owner.test.ts:27`, `no-raw-sql-outside-db.test.ts:36`.
- **3 more re-declare the identical literal locally** — `centralized-config.test.ts:61`,
  `config-handler-dedup.test.ts:23`, `no-hardcoded-config-values.test.ts:49`. That is a second
  source of truth for one question (§1): adding `.mts` to the declared owner silently fails to
  reach these three, and the docstring's promise is already false for them.
- 31 guards rely on the default and therefore exclude `.js/.mjs/.cjs`.

**Do not overstate this one.** The currently-excluded population is **2 files**
(`scripts/generate-pwa-icons.mjs`, `scripts/sd.mjs`), neither under `src/` or `server/`. The
live defect here is the **duplicated declaration**, not a hidden bypass. The extension hole is
latent, not exploited.

### 1.3 Exclusion by REGION — the confirmed defect

`tests/cockpit/cockpit-tokens-owner.test.ts:31-38` defines the scanned region:

```ts
function styleBlock(src: string): string {
  const start = src.indexOf("<style");
  const end = src.indexOf("</style>");
  if (start === -1 || end === -1) return "";
```

Checks A (no literal colours), B (no literal durations) and F (no literal lengths) run on this
substring only, over `.svelte` files only. So two regions are excluded where the invariant
plainly still applies: **the `<script>` block and template of a `.svelte` file**, and **every
`.ts` file in `src/cockpit/`** (96 of them).

I re-ran the guard's own `findColorLiterals` regex over exactly those excluded regions.
**18 literal colours, all in the excluded regions, zero in the guarded region:**

| file:line | literal | region |
|---|---|---|
| `src/cockpit/rooms/MicroSweep.svelte:63` | `tokenColor(el, "--ink-4", "#4d545e")` | `.svelte`, outside `<style>` |
| `src/cockpit/rooms/MicroSweep.svelte:64` | `tokenColor(el, "--alarm", "#e26a5f")` | `.svelte`, outside `<style>` |
| `src/cockpit/rooms/Spark.svelte:97` | `tokenColor(el, "--ink-3", "#79818d")` | `.svelte`, outside `<style>` |
| `src/cockpit/sweep/categories.ts:48-55` | 8 × `fallbackDark: "#…"` | `.ts` |
| `src/cockpit/sweep/categories.ts:195-201` | `alarm/beam/ground1/ground2/line1/ink2/ink3` hexes | `.ts` |

mtimes: `categories.ts` 2026-07-26 09:55, `MicroSweep.svelte` 2026-07-26 15:11,
`Spark.svelte` 2026-07-26 13:08 — all older than HEAD `0c7e536`, tree clean.

**This reproduces the count the earlier audit reported (18), from an independent measurement,
and establishes it is still open today.** I am not claiming a new finding; I am closing the
question of whether it was fixed. It was not.

**The sharper framing nobody has applied.** These are not merely style violations. Every one is
a *fallback*: `tokenColor(el, "--ink-4", "#4d545e")` and `fallbackDark: "#dc8b8b"` are second
sources of truth for a question the token file already answers. §5b prohibits exactly this —
"THERE IS NO FALLBACK SOURCE … a fallback is a second source of truth for one question, and it
will drift — and the drift is invisible precisely because the fallback only fires when the real
source is missing, which is the moment nobody is looking." A colour-literal guard reads this as
a lint issue. The contract reads it as a correctness issue.

### 1.4 Region treatment across the estate

| region handling | guards |
|---|---|
| code with comments removed, strings **kept** | 45 |
| code with comments **and strings** removed | 34 |
| `<style>` block extracted | 25 |
| `<script>` block extracted | 16 |
| line-based with strings blanked | 1 |

34 guards deliberately blank string literals before matching. That is correct for finding
*code*, and it means **no guard in that group can see a violation expressed as a string
literal** — which is precisely how the 15 `.ts` colours above are written.

### 1.5 Ranked exclusion risk

| rank | excluded region | invariant still applies? | evidence |
|---|---|---|---|
| 1 | `src/cockpit/**/*.ts` + `.svelte` outside `<style>` | **yes** | 18 live colour literals (§1.3) |
| 2 | `src/cockpit/tokens.css` for deadness | **yes** | 18 dead tokens (§2.1) |
| 3 | `tests/**` for typechecking (no tsconfig covers it) | **yes** | 439 guard files, 0 typechecked |
| 4 | `bench/**` (13 files, no runner) | yes | no npm script invokes it |
| 5 | `.js/.mjs/.cjs` under default `walk()` | latent | only 2 files today |

---

## 2. PRESENCE VS CONSUMPTION

The class: a guard asserts a thing *is declared* and nothing asserts a thing *reads it*.

### 2.1 The confirmed instance, verified independently

`tests/cockpit/cockpit-tokens-owner.test.ts:156-182`, test **E**, holds a hardcoded array of 20
strings and asserts each appears in the token file:

```ts
const missing = required.filter((token) => !css.includes(token));
```

Line **170** is `"--t-3:"`. `css.includes("--t-3:")` is satisfied by the declaration alone.
Nothing in the file — or in any other guard — asserts `--t-3` is read.

**Absence of consumption established two ways, independently:**

- *Mine:* every consumption form the sibling guard recognises (`var()`, `readCssVar`,
  `readCssPx`, `readToken`, `getPropertyValue`, `setProperty`) searched across 1,583 files in
  **both repos**, 10 extensions, reading bytes. Zero consumers.
- *Subagent, independently:* 4,407 files with **no** extension filter (so `dist/` and `.md`
  included). 6 occurrences of `--t-3` total — two declarations in
  `src/cockpit/tokens.css:365,624`, two in the built bundle
  `dist/client/assets/main-BvbVT859.css` (`--t-3:.24s`, `--t-3:1ms` — again both declarations),
  one prose mention, one the guard itself. `var(--t-3)` matches nowhere, including in the
  shipped bundle.
- *Control:* `--t-1` and `--t-2` both resolve as consumed. `--t-3` is the only one of the three
  that does not — so this is not an artefact of the search.

**`--t-3` is declared twice, asserted to exist by a guard, shipped in the production CSS
bundle, and read by nothing.** It is the CSS form of wired-but-inert, and it survives because
the guard that would catch deadness (`no-dead-css-tokens.test.ts`) hardcodes a different file.

### 2.2 The whole class in that file

`src/cockpit/tokens.css` holds **18 tokens declared with zero consumers**, confirmed against
all consumption forms across both repos:

`--on-cat-turn`, `--on-cat-tool`, `--on-cat-effect`, `--on-cat-check`, `--on-cat-finding`,
`--on-cat-steer`, `--on-cat-anomaly`, `--on-cat-heal` (`:81-88`, redeclared `:555-562`),
`--f-hero-size` (`:109`), `--f-hero-weight` (`:110`), `--verbs-pad-y` (`:164`),
`--tick-w` (`:265`), `--bead-glow` (`:281`), `--t-3` (`:365`, `:624`), `--ease-exit` (`:367`),
`--density-type-delta` (`:372`, `:515`), `--stream-rate-w` (`:437`), `--editor-page-h` (`:478`).

Deliberately excluded from that list: the 8 `--cat-*` tokens, which *are* consumed dynamically
via `src/cockpit/sweep/categories.ts:219`
(`pick(c.cssVar, pick(c.aliasVar, c.fallbackDark))`, reached from `Sweep.svelte:350`). A naive
`var()` scan would have called those dead too. Both my pass and the subagent's caught this
independently — worth recording because it is the shape that manufactures a false finding.

### 2.3 The rest of the class

| guard:line | asserted to exist | consumption asserted? | actually consumed? |
|---|---|---|---|
| `cockpit-tokens-owner.test.ts:170` | `--t-3:` | **none** | **NO** — §2.1 |
| `exposure-registry-counts.test.ts:97,104,111` | registry sizes ≥ 119 / 61 / 96 | partial — `:163,173,184` prove entries reach `buildUiSchema()`, a *projection* | reaches the schema; runtime effect unverified |
| `sse-connection-limit.test.ts:802` | `DEFAULT_SUBPROCESS_ENV_ALLOWLIST` exists | none | yes — `server/config.ts:833`. Weak guard, not a defect |
| `r73-config-contract.test.ts:68,74` | two `DEFAULT_*_TIMEOUT_MS` match config | none *for these two* (the same file **does** assert consumers at `:109,113,117,130,134,147`) | yes — `src/tools/concurrent/long-task-runner.ts:308,321`. Asymmetric, not a defect |
| `frontend-stores-deep.test.ts:103,104` | `registeredResetNames`, `clearResetRegistry` exported | yes, test-side | no product consumer — but these are by-design test-hermeticity exports, **not** a defect |

**Honest bound:** 180 declaration-presence assertions of this shape exist across the two
prevention directories. **43 were audited; ~137 were not.** One live defect (`--t-3`) was found
in the 43. The class is confirmed and its full size is unmeasured.

**One incidental finding worth a task:** `exposure-registry-counts.test.ts:61-63` carries a
comment saying "88 -> 80" while the constant on `:64` is `96`. The comment and the code
disagree; not investigated.

---

## 3. SILENT SKIPS

### 3.1 Dark on a fresh checkout TODAY — the number

**27 assertions across 21 tests, in exactly one file.**

`tests/performance/regression.test.ts:39`:

```ts
describe.skipIf(!existsSync(REPORT_PATH))("web UI performance regression gate", () => {
```

Derivation, without running the suite:

1. `REPORT_PATH` resolves to `tests/performance/.report.json`.
2. `git check-ignore -v` returns `.gitignore:12` → the path is **gitignored**, so it is never
   in a checkout. Confirmed absent on disk right now.
3. The file is inside the vitest include (`vite.config.ts:124`), so it *is* collected — it
   collects and skips, which is why it is invisible rather than missing.
4. Reading the file's bytes: **1** outer `describe.skipIf`, **20** inner `it.skipIf`,
   **21** `it` blocks, **27** `expect(` calls.

So on a fresh checkout the entire performance budget — LCP, CLS, long tasks, tab switch, DOM
node counts, typing latency, API response, heap growth, DOM growth, route discovery, viewport
coverage, and report freshness — is enforced by nothing.

**Correction to the brief.** I was told "22 inner skips". My byte-derived count is **20** inner
`it.skipIf` plus 1 outer `describe.skipIf`. I report my number and flag the discrepancy rather
than reconciling to the one I was given.

**A third darkness layer nobody has counted.** Even *with* a report present, 13 of the 21 tests
begin with a bare `if (…) return;` on a missing report field (`:87, 88, 95, 115, 127, 141, 148,
156, 165, 171, 177, 185, 194`). A profile that ran but measured nothing produces a green gate.
Per §8's cost-guard rule — "a guard about the COST of an operation must first assert the
operation happened" — these needed a liveness precondition and have an early return instead.

**Census basis:** across all 439 web test files, only 3 contain any skip construct.
`profile.spec.ts` is Playwright (`.spec.ts`, outside the vitest include) and
`test-naming-structure.test.ts`'s hit is a comment. So this is the **only** unconditionally
dark guard in the web repo — a genuinely good result, and it should be said plainly.

### 3.2 Dark by construction — a guard that cannot fail

`tests/prevention/no-dead-css-selectors.test.ts`, second test:

```ts
test("the scanner itself is precise — no false-positive classes flagged", () => {
  for (const d of dead) { … expect(nonStyle).not.toContain(d.cls); }
});
```

`dead` is the findings array. If it is non-empty the **first** test throws, so the suite is
already red. If it is empty this loop body never runs. I replicated the scanner's exact logic
over its own universe (150 `.svelte` files under `src/`): **`dead.length === 0`**, so this test
executes **zero assertions** and always passes. A test that presents itself as the scanner's
own precision self-check is, structurally, incapable of ever failing.

### 3.3 Conditionally dark — the 2,405-assertion inheritance

`tests/helpers/source-scan.ts:68`:

```ts
export function walk(root, opts = {}, visited = new Set()) {
  …
  if (!existsSync(root)) return out;   // ← returns []
```

Plus two more swallows in the same function: `:70-74` `catch { return out; }` on
`realpathSync`, and `:81-85` `catch { continue; }` on `statSync` (a broken symlink or an EACCES
path is dropped from ~every guard's candidate set with no signal).

Measured across the web guard estate:

| | count | assertions |
|---|---|---|
| guards importing the shared walker **and calling it** | 105 | — |
| …asserting a population floor | 33 | — |
| …**asserting no floor** | **72** | **2,161** |

Hand-written equivalents in the harness (`if (!existsSync(dir)) return acc;`): **26** guards,
**13** with no floor, **244** assertions.

**Combined: 2,405 assertions that would survive their subject directory being renamed.**

This is not dark *today* — the directories exist, so these guards are live. I am stating it as
**conditional**, because that is what it is. But "conditional on nobody restructuring a
directory" is precisely the condition the repository violates constantly, and the failure mode
is a green suite.

### 3.4 The worst sub-class: guards with zero `expect()`

**8 guards** produce their verdict solely by `throw new Error(...)` when a findings array is
non-empty — and all 8 use the shared walker:

`no-dead-css-tokens`, `no-duplicate-code`, `no-duplicate-constants`, `no-empty-catch`,
`no-hardcoded-values`, `no-throw-new-error`, `no-unused-exports` (all
`tests/prevention/`), and `tests/unit/hardcoded-values.test.ts`.

These are structurally unable to distinguish **"nothing is wrong"** from **"nothing was
scanned"**, because both produce an empty findings array. And they are all `no-X` deny rules —
the place where a vacuous pass is least affordable.

### 3.5 The self-defeating liveness check

`tests/prevention/integration-rule-refs-ratchet.test.ts` roots its scan at
`"../harness-main-v1/integration/src"` (`:30`) and `".../test/prevention"` (`:37`) — a
**relative path out of the repository**, depending on the two repos being siblings *and* the
harness directory being named exactly `harness-main-v1`. Then:

```ts
test("the integration source is co-located (scan is not vacuous)", () => {
  if (!existsSync(INTEGRATION_SRC)) return;          // :96
  expect(files.length, "…").toBeGreaterThan(100);
});
```

**The test that exists to prove the scan is not vacuous returns early exactly when the scan is
vacuous.** All four tests in the file are gated the same way (`:96, 101, 129, 134`).

Live today: the path resolves, 512 files, count **176** against baseline **178**; the
prevention half is at **238 against a baseline of 238 — zero headroom**. So the guard is real
and tight right now. Rename the harness directory and all four go green in silence.

Two more cross-repo guards share the shape: `centralized-config.test.ts:49` and
`subprocess-confinement-owner.test.ts:1562`
(`join("..","harness-main-v1","integration","src","awareness","engine.ts")`).

### 3.6 Dark by never being invoked

There is a category worse than skipping: never being called at all.

- `integration/scripts/run-prevention-suite.ts` — a runner for the prevention suite. **No
  `package.json` script references it.**
- `integration/scripts/audit-12-point.mjs` (285 lines) and a **duplicate copy** at
  `harness-main-v1/scripts/audit-12-point.mjs`. Neither is referenced by any script, and the
  workspace root **has no `package.json` at all**.
- `integration/guardian/tests/run-tests.sh` — the Landlock guardian's fail-closed contract
  test. A bash script no npm path invokes.
- web `bench/**` — 13 files, no runner, not in the vitest include.
- harness: **20** recognizable test files on disk are absent from the executed inventory; **5**
  are registered `pending-external-qualification` and therefore never execute, including
  `test/improper-usage.test.ts` — the improper-usage suite §8 explicitly asks for.

### 3.7 The rung above all of this does not exist

Verified by me directly, both repos: **no `.github/` directory, no non-sample git hook, no
eslint/biome/oxlint config tracked, no `lint` script.**

```
tracked CI/lint files: 0    (harness-main-v1)
tracked CI/lint files: 0    (web-interface-foundation-v1)
```

**Every guard's entire enforcement is that somebody typed `npm test`.** The 17,013 assertions
have no mechanism compelling them to run before a commit, a merge, or a push. And
`npm run check` (which runs the 2,261-line `s1-verification.ts`) and `npm run typecheck` are
**not** part of `npm test` in either repo — they are separate manual commands.

---

## 4. EXEMPTIONS

§8: *"EVERY EXEMPTION CARRIES THE SAME EVIDENCE BURDEN AS EVERY DETECTION."* Measured against
that standard:

**176 of 255 prevention guards contain no mechanism capable of proving any exemption** — no
fixture write, no synthetic source, no hostile/mutant/sanity test. (147 of 208 web, 29 of 47
harness.)

### 4.1 Staleness — the good news, stated plainly

| allowlist | entries | path refs | stale |
|---|---|---|---|
| `duplicate-bodies-allowlist.json` | 77 rows (44 cross + 33 same-file) | 58 distinct | **0** |
| `duplicated-literals-allowlist.json` | 4 concepts | 30 | **0** |
| `duplicate-basenames-allowlist.json` | 0 (empty) | 0 | 0 |
| **in-source path/basename exemptions** | 73 entities | 73 | **6** |

I verified the 121 external JSON path references resolve on disk myself. **All resolve.** Two
of these guards additionally fail on a stale *hash* at runtime
(`no-duplicate-function-bodies.test.ts:124-130`, `no-duplicated-string-literals.test.ts:97-103`)
— those are the correct design, and they should be the template.

*Not verified:* whether each of the 77 hashes still matches a real clone group. I checked paths,
not hashes.

### 4.2 The six stale in-source exemptions

**`tests/prevention/no-rule-refs.test.ts:40-46`** — `DOCS`, five entries, **all five stale**:

```
AGENTS.md  TASKS.md  WORKFLOW.md  ALL-BUGS-AND-ISSUES.md  ALL-MERGE-MANIFESTS.json
```

I confirmed all five are ABSENT from the web repo. And the exemption is **doubly dead**: `EXTS`
on `:50` is `.ts/.svelte/.mjs/.cjs/.css/.js`, so a `.md` or `.json` basename could never reach
`DOCS.has(basename(file))` even if the files existed. An exemption that has never once fired.

**`test/prevention/integration-awareness-arch-owner.test.ts:51`** — `"tmp-r48"`, a directory
that does not exist. Harmless (fails open), but proof the exclusion was never re-verified.

### 4.3 Live defect: an exemption that is a permanent no-op

**`integration/test/prevention/integration-remaining-owner.test.ts:97`**

```ts
if (shouldExcludeExperiment(entry.name)) continue;
```

`entry.name` is a bare directory name (`"editor"`, `"exp999"`). `isExperimentPath`
(`src/shared/source-scan.ts:88-106`) iterates `scanRoots` and at `:96` does
`if (!relativePath.startsWith(prefix)) continue;` where prefix is `src/`, `test/`, `scripts/`
or `_experiments/`. A bare name matches no prefix, so the function **always returns false** and
the exemption never fires.

**I verified this independently** rather than accepting it: of the 25 `shouldExcludeExperiment(`
call sites in `test/prevention/`, **24 pass `relative(ROOT, full)`** and this one passes a bare
name. It is the sole outlier.

It fails *open* (scans more than intended), so it is not an escape. But it is an exemption that
has never once done anything, in a guard nobody noticed was making a claim it could not honour.
mtime 2026-07-25 02:39; verified by me after the writer's commit.

### 4.4 Top exemptions by risk — unproven, and the invariant still applies

| # | exemption | justification | plant? | assessment |
|---|---|---|---|---|
| 1 | `no-raw-sql-outside-db.test.ts:288` — `if (carriesUserIdInInput(m.body)) continue;`, where the predicate (`:226-228`) is `/\.\buser_id\b/.test(strippedBody)` | "a new method that threads userId via an input object is auto-exempt with no list to update" | **NO** | **Highest risk in the estate.** I verified the source. **Any** DbClient method whose body contains *any* `.user_id` property access — including merely reading `row.user_id` off a result it is returning — is exempted from the cross-tenant scoping requirement. This is a security boundary, and the exemption is a regex on a property access. |
| 2 | `no-raw-sql-outside-db.test.ts:206` — `exemptTables = {users, auth_config, auth_sessions, schema_version}` | "tables that store the user IDENTITY, not tenant data" | **NO** | Tables exist. But table matching is `/(FROM\|INTO\|UPDATE\|DELETE FROM\|JOIN)\s+<table>/` (`:270-277`) — `WITH cte AS`, `REPLACE INTO`, and quoted or aliased names slip past. |
| 3 | `no-raw-sql-outside-db.test.ts:296` — `exemptRowTypes` | none | **NO** | Same shape; additionally `:302` drops any method whose signature fails the `:300` regex, so a **multi-line signature is exempt by accident**. |
| 4 | `source-scan.ts:81-85` — `catch { continue; }` | none | **NO** | Inherited by ~every web guard. Silent per-entry drop. |
| 5 | `source-scan.ts:65-66` — default `exts`/`ignore` | ":57-58" | **NO** | §1.2 |
| 6 | `auth-rendering-owner.test.ts:314` — `if (f.endsWith("Icon.svelte")) continue; // the owner — skip` | "the owner — skip" | **NO** | Matched by **suffix**, not path: any future `FooIcon.svelte` anywhere inherits the owner's exemption. |
| 7 | `rate-limit-security.test.ts:286,89` — `f.endsWith("llm-bridge.ts")` / `"rate-limiter.ts"` | "single owner — dynamic discovery" | partial (`:281` proves the owner *defines* the symbol) | Suffix match on a **security** guard: `server/vendor/llm-bridge.ts` would inherit it. |
| 8 | `plain-language-owner.test.ts:111` — `SCRIPT_SCANNED_DIRS` (4) vs `SCANNED_DIRS` (15) at `:88` | none | **NO** | **11 of 15 scanned directories are silently exempt from the script-scan pass**, undeclared. |
| 9 | `no-scattered-helpers.test.ts:195` — `if (/eventId/.test(line) && file === "timeline.ts") continue; // the documented contract` | 4 words, no link | **NO** | Exempts by regex on the matched line, so **any** inline `sendJson` in `timeline.ts` mentioning `eventId` is exempt — not just the sanctioned one. |
| 10 | `settings-rendering-owner.test.ts:156` — `basename(f) === "CustomizationEditor.svelte"` | none | **NO** | Basename, not path: a second file of that name anywhere is exempt. |
| 11 | `pii-redaction-user-display.test.ts:697,722` — `file === "server/redaction.ts"` | "the owner — allowed" | **NO** | Exact-path (tighter). Risk: the file with the most redaction code is the one place the redaction rule never runs. |
| 12 | `coverage-instrument-owner.test.ts:38` — `ALLOWED_LITERALS = {"tool"}` | ":37 the one registry member the module may name" | **NO** | Nothing asserts `"tool"` is still a registry member; a rename leaves the exemption protecting a stale literal — the exact rot the guard exists to prevent. |
| 13 | `test-helpers-dedup.test.ts:206` — `EXEMPT = {"join"}` | "left to the src/ scanner" | **NO** | The hand-off is asserted nowhere. An unfalsified promise. |
| 14 | harness `no-hardcoded-success.test.ts:41,50` | comments `:38-49` | **NO** | Both targets exist. Two hand-maintained single-element exception sets on a *no-hardcoded-success* guard. |
| 15 | harness `integration-remaining-owner.test.ts:85` — `ALREADY_AUDITED_DIRS` (7 dirs) | ":81-83 already audited elsewhere" | **NO** | All 7 exist with matching owner tests. **But the doc comment at `:77-82` lists 9 dirs while the Set holds 7** — comment and code disagree, and nothing asserts the delegated guards actually cover them. |

### 4.5 The three exemptions that meet the standard

Name them, because they are the template:

- `harness/no-duplicate-function-bodies.test.ts:181-205` — plants an allowlisted pair, asserts
  zero findings; then `:207-229` plants a **stale** entry and asserts it **FAILS**.
- `harness/no-duplicated-string-literals.test.ts:146-162` — the same inversion.
- `web/centralized-config.test.ts:204-212` — asserts its exception set is non-empty **and** that
  every entry resolves on disk. The only guard in either repo that checks its own allowlist for
  staleness.

**3 of 255.**

---

## 5. THE LADDER — what to make impossible

The standing instruction is *"ideally we want these holes to just not be possible in the first
place."* Ranked by (value ÷ effort).

### 5.1 Make a vacuous scan unrepresentable — one line, 2,405 assertions

**Now:** rung 5. `walk()` returns `[]` for a missing root; 72+13 guards cannot tell that from
clean.

**Rung 4 (available immediately).** Change `source-scan.ts:68` from `return out;` to a throw:

```ts
if (!existsSync(root)) throw new Error(`walk(): scan root does not exist: ${root}`);
```

This is the trunk (§3): one assertion at the single door, and every one of the 105 consumers
gains it without being edited. It converts the largest silent-failure class in the estate into
a loud one.

**Rung 3 (better, still small).** Give `walk` a required floor —
`walk(root, { exts, minFiles })` — and throw when the yield is under it. Forgetting the floor
becomes a compile error rather than a habit, which is what §3's "relieve responsibility" asks
for: nobody has to remember.

**Rung 2 (the real answer).** Return a branded `NonEmptyFileSet` that cannot be iterated until
narrowed. Then "I scanned nothing and passed" is not expressible in the type system. This also
retires §3.4 — the 8 zero-`expect()` guards stop being able to confuse empty with clean.

The same edit, applied to the harness's 26 hand-written `if (!existsSync(dir)) return acc;`
walkers, is the argument for hoisting them onto one shared walker first (§14, §16).

### 5.2 Make the token-file universe discovered, not named

**Now:** rung 5 with a hardcoded path. `no-dead-css-tokens.test.ts` names
`src/styles/tokens.css`; a second token file appeared and inherited no guard.

**Fix (still rung 5, but the universe stops being a decision):** discover **every** `.css` file
and **every** `<style>` block, rather than naming one. §6 states it directly — "a test that
needs editing when you add a module is itself a defect". This closes §2.2's 18 dead tokens *and*
any third token file nobody has written yet.

**Rung 2 for the consumption half:** generate a `TokenName` union type from the discovered CSS
at build time and require every read to go through `readToken(name: TokenName)`. A typo'd or
deleted token then fails `tsc`, not a scan. (I found 2 dangling `var(--x)` references with no
declaration anywhere — `src/state/theme.ts:10` and `src/styles/tokens.css:6` — both look like
documentation placeholders, but nothing mechanical distinguishes them from a real typo.)

### 5.3 Make the colour literal unrepresentable — a signature change

**Now:** rung 5, scanning `<style>` blocks. 18 escapes in `<script>` and `.ts`.

The instinct is to widen the scan to `.ts`. **That is the third round of the mistake §0
records** — the scan's universe was wrong in a new way each time.

**Rung 2, and it is one signature.** Every one of the 18 is a *fallback argument*:

```ts
tokenColor(el, "--ink-4", "#4d545e")        // 3 sites
{ …, fallbackDark: "#dc8b8b" }               // 8 sites
```

Delete the third parameter of `tokenColor`, and the `fallbackDark` field from the category
record. A hardcoded colour then has **nowhere to be written** — the bad state is unrepresentable
and every call site that tries is a compile error. This also brings the code into line with
§5b: absence of a token is a guided state, never a silent fallback to a second source of truth.

That is one type-level change replacing a scan whose universe has now been wrong twice.

### 5.4 Make the perf gate refuse to be absent

**Now:** rung 6 (convention: "run Playwright first"). 27 assertions dark on every fresh
checkout.

- **Rung 4:** invert the default. `describe.skipIf(!existsSync(REPORT_PATH) && !process.env.CI)`
  — absent locally is a skip, absent in CI is a **failure**. (This presumes a CI exists; per
  §3.7 none does, which makes this the second-order fix.)
- **Rung 1:** commit a baseline report. The input can then never be absent, and the gate has no
  skip branch to take.
- Independently: replace the 13 bare `if (…) return;` field guards with liveness assertions, per
  §8's cost-guard rule.

### 5.5 Make a stale exemption expire

**Now:** rung 5/6 — prose in a comment, believed.

**Rung 4, and the machinery already exists.** Two harness guards already fail on an allowlist
entry that matches nothing. Generalise it: **every** exemption records whether it fired this
run, and an exemption that fired zero times **fails the suite**. `no-rule-refs.test.ts`'s five
dead `DOCS` entries and the `tmp-r48` exclusion would both have died the day they went stale,
and §4.3's permanent no-op would have been caught the day it was written.

This is the single highest-leverage change to the exemption class, because it converts an
exemption from a permanent claim about the world into one that must keep earning its place.

### 5.6 Typecheck the guards

**Now:** rung 0. `tests/**` is in **no** tsconfig — `tsconfig.json` includes `src`+`contracts`,
`tsconfig.server.json` excludes `tests`, `tsconfig.templates.json` includes `src`+`contracts`.
**439 web guard files, holding 14,364 assertions, are never typechecked.**

**Rung 2, trivially:** add a `tsconfig.tests.json`. The code enforcing every invariant in the
repository is currently the least-protected code in it.

### 5.7 Resolve the cross-repo root by resolution, not by directory name

**Now:** rung 5 depending on a sibling directory literally named `harness-main-v1`.

**Rung 3:** resolve the harness through its package specifier from the importing file (Node's
own resolution — §8b records that a bare specifier resolves from the *file's* directory, not
`process.cwd()`). Resolution then either succeeds or throws; it cannot silently yield an empty
universe. Combined with §5.1, the self-defeating liveness check at
`integration-rule-refs-ratchet.test.ts:96` disappears rather than being fixed.

---

## 6. COVERAGE — what I did NOT verify

Required by the brief, and the most important section for anyone acting on this.

**Not run, not measured:**
- **I ran no test suite** in either repo (read-only). Every "this guard passes vacuously" claim
  is derived from source structure and from re-executing a guard's *own scanning logic* in a
  scratch script — never from an observed pass/fail. I did not mutation-test a single guard,
  which is the only thing that would *prove* a vacuous pass.
- I did not run `tsc --listFiles`. §8b says it *is* the program's file set and my walker is only
  a claim about it. My per-extension population counts (326 `.ts`, 150 `.svelte`, 2 `.css`) are
  therefore a walker's claim, not the compiler's. They are load-bearing for §1.2 and should be
  re-derived with `tsc` before anyone acts on the extension analysis.

**Bounded, not complete:**
- **The per-guard table (Appendix A) is machine-generated by regex**, not hand-read. Its
  "universe" column is extracted from `const … = join(…)` and `SCAN_DIRS`-style array literals;
  a guard that computes its root any other way shows as "named files". Its "plant?" column is a
  vocabulary match (`plant|mutat|synthetic|liveness|self-test`), which **overcounts** (a comment
  mentioning mutation scores as a plant) and **undercounts** (a genuine plant written without
  those words). Treat it as a triage index, not a verdict.
- I read roughly 25 guards in full, out of 523.
- **Exemption counts are lower bounds**, stated as such: 304 single-line
  `if (…) continue/return;` sites were bucketed but not read; multi-line conditions and
  ~485 `.filter()`-based drops were never parsed at all.
- **§2's presence-vs-consumption class is 43 of 180 audited** — ~137 declaration-presence
  assertions are unexamined.
- I verified allowlist **paths** resolve; I did not verify the 77 **hashes** still match real
  clone groups.
- Symbol-level allowlist entries (`"join"`, `"tool"`, `"clean_state_verified"`, the `*Row`
  types) were assessed for plausibility, not resolved to declarations.
- I did not audit `integration/verification/benchmarks/**`, a large tree with its own `.mjs`
  runners that may hold further dark checkers.
- I did not check `core.hooksPath` or any machine-level CI outside these two repos. §3.7's "no
  CI" claim is "no workflow file is tracked in either repo", which is what I verified.

**Concurrency caveat, honoured:** the harness writer committed mid-audit
(`e3e036a` → `cebe0f4`). **Every harness claim in §4.3 and §4.2 I re-derived myself after that
commit.** All web claims rest on a clean tree at `0c7e536`. Anything here about
`harness-main-v1` should still be re-checked against current HEAD before action — §8b's
"true when written, false six minutes later" applies to this document too.

**Claims I deliberately did not make:** I found no evidence that the `.js/.mjs/.cjs` extension
gap has been exploited (2 files, both in `scripts/`), and I say so rather than presenting a
latent hole as a live one. The `--cat-*` tokens look dead to a naive scan and are not; I
excluded them. Several exemptions in §4.4 are *unproven*, which is not the same as *wrong* —
the finding is the missing evidence, not a demonstrated escape.

---

## 7. WORKFLOW FINDING (§20)

**An audit scoped by path inherits the defect it is auditing.**

The brief pointed at `tests/prevention/**` and added "look for them by shape, not just by that
path". Following the path alone would have inventoried 255 files and **missed 268 more** —
including `tests/cockpit/`, which holds 120 guards and the very file the brief cited as its
canonical example. The audit's own universe would have been wrong in exactly the way the thesis
predicts.

**The mechanism, not the moral:** the guard estate has no self-inventory. Nothing asserts "every
file matching a guard shape is inside a directory the runner executes". The web repo happens to
be clean here (zero orphaned `*.test.ts`); the harness is not — 20 recognizable test files are
absent from the executed inventory and 5 more are registered as permanently unqualified.

**Concrete proposal:** a guard whose subject is *the guard estate itself* — discover every file
matching the guard shape, assert each is matched by a configured runner glob, and assert the
count only grows. It is the same deny-by-default discovery the estate already applies to routes
and registrations, turned on itself. This is the finding I would most want to exist next time,
and per §8 ("every issue should be findable by a test next time") it is expressible as one.

**Second-order:** the three subagents I ran disagreed with the brief on two facts — the location
of `cockpit-tokens-owner.test.ts` and the inner-skip count — and were right about the first and
wrong-or-unreconciled about the second. Re-deriving load-bearing subagent claims *personally*
(which I did for four of them, §4.3 especially) changed one from "reported" to "verified" and
would have caught it had it been wrong. Analyst findings should be routed through independent
re-derivation by default, not by exception.

---

## APPENDIX A — per-guard table

Machine-generated over all 258 files in the two prevention directories. Columns: universe
(walker roots / extension filter), instrument (bytes vs shells out), population floor asserted,
plant vocabulary present, and the silent-skip shapes found with line numbers.

**Read the caveat in §6 before using the `plant?` column as a verdict.**

| # | repo | guard file | universe (roots / exts) | instrument | floor? | plant? | can silently skip? |
|---|---|---|---|---|---|---|---|
| 1 | harness | `bundle-staleness.test.ts` | named files / (default .ts,.svelte) | bytes x3 | yes (1) | **NO** | existsSync-return@64/76 |
| 2 | harness | `config-consumption-contract.test.ts` | named files / .ts,.test.ts | bytes x2 | **NO** | **NO** | no |
| 3 | harness | `editor-defaults-ssot-prevention.test.ts` | config-contracts.ts root-policy.ts / .ts,.test.ts,.d.ts | bytes x2 | **NO** | **NO** | existsSync-return@53 |
| 4 | harness | `editor-defaults-ssot.test.ts` | named files / (default .ts,.svelte) | no file read | **NO** | **NO** | no |
| 5 | harness | `embedding-pass3.test.ts` | named files / (default .ts,.svelte) | no file read | **NO** | **NO** | no |
| 6 | harness | `entrypoint-recording-wiring.test.ts` | src / .ts | bytes x5 | yes (5) | yes (3) | existsSync-return@80 |
| 7 | harness | `esm-cjs-mismatch.test.ts` | esm-cjs-hostile src, test, scripts, verification, traceabili / (default .ts,.svelte) | bytes x2 | yes (1) | **NO** | existsSync-return@36 |
| 8 | harness | `filesystem-cache-shared-counter.test.ts` | named files / .json | no file read | **NO** | **NO** | existsSync-return@43 |
| 9 | harness | `git-freshness.test.ts` | named files / (default .ts,.svelte) | SHELLS OUT | yes (2) | **NO** | no |
| 10 | harness | `integration-awareness-arch-owner.test.ts` | awareness architecture-manifest.ts / .ts,.test.ts,.d.ts | bytes x2 + shells | yes (6) | yes (12) | existsSync-return@49; empty-catch x3 |
| 11 | harness | `integration-backend-owner-1.test.ts` | src / .ts,.test.ts | bytes x9 | yes (8) | yes (3) | existsSync-return@125; empty-catch x1 |
| 12 | harness | `integration-intelligence-owner.test.ts` | intelligence / .ts,.test.ts | bytes x2 | yes (1) | yes (13) | existsSync-return@30/124; empty-catch x2 |
| 13 | harness | `integration-manifest-consistency.test.ts` | src/architecture-manifest.ts / (default .ts,.svelte) | bytes x3 | yes (1) | **NO** | existsSync-return@51 |
| 14 | harness | `integration-memory-owner.test.ts` | memory / .ts,.test.ts | bytes x2 | **NO** | yes (12) | existsSync-return@31/138; empty-catch x1 |
| 15 | harness | `integration-remaining-owner.test.ts` | named files / .ts,.test.ts,.d.ts | bytes x4 | yes (2) | **NO** | existsSync-return@61; empty-catch x5 |
| 16 | harness | `integration-safety-runtime-owner.test.ts` | safety runtime / .ts,.test.ts,.d.ts | bytes x2 | yes (3) | yes (9) | existsSync-return@59 |
| 17 | harness | `integration-shared-owner.test.ts` | shared / .ts,.test.ts,.d.ts | bytes x12 | yes (9) | yes (4) | existsSync-return@51/429/439; empty-catch x1 |
| 18 | harness | `integration-smart-edit-legacy-owner.test.ts` | smart-edit / .mjs | bytes x8 | yes (3) | yes (3) | existsSync-return@46/60; empty-catch x4; catch-return x1 |
| 19 | harness | `integration-tools-quality-owner.test.ts` | tools quality / .ts,.test.ts,.d.ts | bytes x5 | yes (3) | yes (5) | existsSync-return@53 |
| 20 | harness | `no-destructive-test-writes.test.ts` | named files / .test.ts,.ts | bytes x4 + shells | yes (1) | yes (4) | existsSync-return@77/243 |
| 21 | harness | `no-duplicate-function-bodies.test.ts` | src duplicate-bodies-allowlist.json duplicate-bodies-hostile / .ts,.mjs,.test.ts,.test.mjs,.d.ts,.d.mts | bytes x4 | yes (6) | yes (1) | existsSync-return@61 |
| 22 | harness | `no-duplicated-string-literals.test.ts` | src duplicated-literals-allowlist.json duplicated-literals-h / .ts,.test.ts,.d.ts,.d.mts,.d.cts | bytes x3 | yes (3) | **NO** | existsSync-return@61 |
| 23 | harness | `no-editor-backup-files.test.ts` | src, test, scripts, guardian, traceability, docs / (default .ts,.svelte) | SHELLS OUT | yes (3) | **NO** | no |
| 24 | harness | `no-empty-catch-blocks.test.ts` | src, scripts, verification / .ts,.test.ts | bytes x2 | yes (2) | **NO** | existsSync-return@12; catch-return x1 |
| 25 | harness | `no-excess-trailing-newlines.test.ts` | src, test, scripts, verification / .ts,.d.ts | bytes x2 | yes (1) | yes (6) | existsSync-return@36 |
| 26 | harness | `no-generic-errors.test.ts` | src / .test.ts,.ts,.mjs | bytes x9 | yes (6) | **NO** | existsSync-return@90 |
| 27 | harness | `no-hardcoded-configurables.test.ts` | src, scripts, verification src / .test.ts,.test.mjs,.d.ts,.d.mts,.d.cts,. | bytes x4 | yes (2) | yes (1) | existsSync-return@138 |
| 28 | harness | `no-hardcoded-success.test.ts` | src, scripts, verification / .ts,.test.ts | bytes x3 | yes (2) | **NO** | existsSync-return@59 |
| 29 | harness | `no-hardcoded-truncation-slices.test.ts` | src / .test.ts,.test.mjs,.ts,.mjs | bytes x2 | yes (1) | **NO** | existsSync-return@77 |
| 30 | harness | `no-source-hardlinks.test.ts` | named files / (default .ts,.svelte) | bytes x2 | yes (2) | **NO** | no |
| 31 | harness | `no-temp-dir-leaks.test.ts` | .. temp-dir.ts / .ts | bytes x5 + shells | yes (3) | **NO** | no |
| 32 | harness | `no-unhandled-errors.test.ts` | src / .ts,.test.ts,.d.ts | bytes x4 | yes (3) | **NO** | existsSync-return@66; catch-return x1 |
| 33 | harness | `prevention-review.test.ts` | traceability/prevention/prevention-retrospective.json docs/r / .md | bytes x4 | **NO** | yes (41) | no |
| 34 | harness | `r73-config-contract.test.ts` | named files / (default .ts,.svelte) | bytes x5 | **NO** | **NO** | no |
| 35 | harness | `refusal-is-not-emptiness.test.ts` | named files / (default .ts,.svelte) | no file read | yes (4) | yes (1) | no |
| 36 | harness | `registration-procedure-doc.test.ts` | registration-procedure.md / .ts,.d.ts,.d.mts,.d.cts | bytes x4 | yes (3) | **NO** | existsSync-return@67 |
| 37 | harness | `resolved-default-not-readable.test.ts` | src / .ts,.mts | bytes x2 | yes (1) | yes (5) | no |
| 38 | harness | `round3-a1-a5-fixes.test.ts` | named files / (default .ts,.svelte) | no file read | **NO** | yes (3) | no |
| 39 | harness | `round4-fixes.test.ts` | named files / (default .ts,.svelte) | no file read | **NO** | yes (3) | no |
| 40 | harness | `round4-residual.test.ts` | named files / (default .ts,.svelte) | no file read | **NO** | yes (1) | no |
| 41 | harness | `serial-concurrency-tier.test.ts` | ../.. / (default .ts,.svelte) | bytes x1 + shells | yes (4) | **NO** | no |
| 42 | harness | `snapshot-working-tree.test.ts` | named files / (default .ts,.svelte) | bytes x5 + shells | **NO** | **NO** | no |
| 43 | harness | `split-idiom-delimiter-mismatch.test.ts` | named files / (default .ts,.svelte) | no file read | yes (5) | **NO** | no |
| 44 | harness | `static-literal-extraction-cache.test.ts` | .. s1-verification.ts / .ts | bytes x5 | **NO** | **NO** | no |
| 45 | harness | `subprocess-mock.test.ts` | named files / (default .ts,.svelte) | SHELLS OUT | **NO** | **NO** | no |
| 46 | harness | `test-runtime-budget.test.ts` | named files / (default .ts,.svelte) | bytes x2 | **NO** | **NO** | existsSync-return@45 |
| 47 | harness | `timeline-intent-recording.test.ts` | interactive-session.ts / (default .ts,.svelte) | bytes x4 | **NO** | yes (1) | no |
| 48 | web | `allowed-commands-config.test.ts` | named files / (default .ts,.svelte) | bytes x2 | yes (2) | yes (14) | no |
| 49 | web | `api-identity-header-owner.test.ts` | named files / (default .ts,.svelte) | bytes x2 | yes (3) | yes (3) | no |
| 50 | web | `artifact-rendering-owner.test.ts` | named files / (default .ts,.svelte) | no file read | **NO** | yes (3) | no |
| 51 | web | `asof-block-split-owner.test.ts` | named files / (default .ts,.svelte) | no file read | yes (2) | yes (2) | no |
| 52 | web | `async-db-facade-owner.test.ts` | db / (default .ts,.svelte) | bytes x8 | yes (2) | yes (1) | no |
| 53 | web | `async-db-ordering.test.ts` | named files / (default .ts,.svelte) | no file read | yes (3) | **NO** | no |
| 54 | web | `async-db-orderings-through-the-server.test.ts` | named files / (default .ts,.svelte) | bytes x3 + shells | yes (3) | yes (3) | no |
| 55 | web | `atomic-write-owner.test.ts` | named files / (default .ts,.svelte) | bytes x3 | yes (2) | yes (2) | no |
| 56 | web | `auth-owner.test.ts` | named files / .ts | bytes x9 | yes (4) | yes (4) | no |
| 57 | web | `auth-rendering-owner.test.ts` | named files / .svelte | no file read | yes (3) | yes (1) | no |
| 58 | web | `auto-heal-owner.test.ts` | named files / (default .ts,.svelte) | bytes x3 | yes (5) | yes (1) | no |
| 59 | web | `auto-reopen-last-chat.test.ts` | named files / (default .ts,.svelte) | bytes x2 | **NO** | **NO** | no |
| 60 | web | `awareness-quality-bridge-owner.test.ts` | routes / .ts | bytes x27 | yes (6) | yes (2) | no |
| 61 | web | `bench-fixture-drift.test.ts` | named files / .bench.ts | bytes x2 | **NO** | yes (5) | no |
| 62 | web | `block-action-owner.test.ts` | named files / (default .ts,.svelte) | bytes x2 + shells | yes (10) | yes (13) | no |
| 63 | web | `block-contract-owner.test.ts` | named files / .ts,.ts,.svelte | no file read | yes (3) | yes (1) | no |
| 64 | web | `block-description-honesty.test.ts` | named files / (default .ts,.svelte) | no file read | yes (1) | yes (1) | no |
| 65 | web | `centralized-config.test.ts` | named files / .test.ts,...SOURCE_EXTS | bytes x9 | yes (5) | **NO** | existsSync-return@283 |
| 66 | web | `chat-history-honest-absence.test.ts` | named files / (default .ts,.svelte) | no file read | yes (3) | yes (9) | no |
| 67 | web | `chat-history-load-race.test.ts` | named files / (default .ts,.svelte) | no file read | yes (5) | yes (1) | no |
| 68 | web | `chat-history-query-bounds.test.ts` | named files / (default .ts,.svelte) | no file read | yes (3) | yes (1) | no |
| 69 | web | `chat-rendering-owner.test.ts` | named files / (default .ts,.svelte) | no file read | yes (7) | yes (1) | no |
| 70 | web | `check-status-history.test.ts` | named files / (default .ts,.svelte) | no file read | **NO** | yes (1) | no |
| 71 | web | `client-api-owner.test.ts` | src client.ts broker.ts auth.ts / .ts,.svelte,.d.ts | bytes x23 | yes (11) | yes (5) | no |
| 72 | web | `config-defaults-owner.test.ts` | named files / .ts | no file read | yes (3) | **NO** | no |
| 73 | web | `config-handler-dedup.test.ts` | server/routes, server / ...SOURCE_EXTS | bytes x9 | yes (1) | **NO** | no |
| 74 | web | `config-write-gate-owner.test.ts` | named files / (default .ts,.svelte) | bytes x4 | yes (4) | yes (13) | no |
| 75 | web | `content-search-deadline.test.ts` | named files / (default .ts,.svelte) | no file read | yes (3) | yes (3) | no |
| 76 | web | `content-search-owner.test.ts` | server src / (default .ts,.svelte) | bytes x13 | yes (15) | yes (24) | no |
| 77 | web | `context-manager-owner.test.ts` | server/routes/run.ts server/context-bridge.ts / .test.ts | bytes x5 | yes (2) | yes (1) | no |
| 78 | web | `context-memory-wired.test.ts` | named files / (default .ts,.svelte) | bytes x2 | **NO** | **NO** | no |
| 79 | web | `context-switch-reset-owner.test.ts` | state store-registry.ts reset-all.ts App.svelte / .ts | bytes x2 | yes (2) | yes (7) | no |
| 80 | web | `conversation-history-loaded.test.ts` | named files / (default .ts,.svelte) | no file read | **NO** | yes (1) | no |
| 81 | web | `cookie-flags.test.ts` | named files / (default .ts,.svelte) | bytes x9 | **NO** | **NO** | no |
| 82 | web | `coverage-instrument-owner.test.ts` | named files / (default .ts,.svelte) | no file read | yes (1) | yes (4) | no |
| 83 | web | `create-message-atomic.test.ts` | named files / (default .ts,.svelte) | no file read | yes (6) | yes (1) | no |
| 84 | web | `credential-surface-owner.test.ts` | named files / (default .ts,.svelte) | no file read | yes (6) | yes (6) | no |
| 85 | web | `cross-user-run-scoping.test.ts` | named files / .ts | bytes x11 | yes (1) | **NO** | no |
| 86 | web | `css-tokens-owner.test.ts` | named files / .svelte,.css | bytes x10 | yes (8) | yes (2) | existsSync-return@244/283 |
| 87 | web | `customization-write-path-owner.test.ts` | named files / (default .ts,.svelte) | bytes x2 | yes (1) | **NO** | no |
| 88 | web | `data-loss-1-reboot.test.ts` | named files / (default .ts,.svelte) | no file read | **NO** | **NO** | no |
| 89 | web | `data-loss-2-crash.test.ts` | named files / (default .ts,.svelte) | no file read | **NO** | **NO** | no |
| 90 | web | `data-loss-3-migration.test.ts` | named files / (default .ts,.svelte) | no file read | **NO** | **NO** | no |
| 91 | web | `data-loss-4-keychange.test.ts` | named files / (default .ts,.svelte) | no file read | **NO** | **NO** | no |
| 92 | web | `data-loss-5-keypersist.test.ts` | named files / (default .ts,.svelte) | bytes x3 | **NO** | **NO** | no |
| 93 | web | `data-loss-6-concurrent.test.ts` | named files / (default .ts,.svelte) | no file read | **NO** | **NO** | no |
| 94 | web | `data-loss-7-large.test.ts` | named files / (default .ts,.svelte) | no file read | **NO** | **NO** | no |
| 95 | web | `data-loss-8-rollback.test.ts` | named files / (default .ts,.svelte) | bytes x2 | **NO** | **NO** | no |
| 96 | web | `db-durability-window.test.ts` | named files / (default .ts,.svelte) | no file read | yes (2) | yes (1) | no |
| 97 | web | `db-transaction-owner.test.ts` | named files / (default .ts,.svelte) | bytes x2 | **NO** | yes (3) | no |
| 98 | web | `db-wal-bounded.test.ts` | named files / (default .ts,.svelte) | no file read | yes (1) | yes (1) | no |
| 99 | web | `dedup-compression-owner.test.ts` | named files / (default .ts,.svelte) | bytes x6 | **NO** | yes (1) | no |
| 100 | web | `dedup-signal-wired.test.ts` | named files / (default .ts,.svelte) | no file read | yes (1) | yes (1) | no |
| 101 | web | `default-chat-and-button-naming.test.ts` | named files / (default .ts,.svelte) | bytes x5 | yes (1) | **NO** | no |
| 102 | web | `editor-bridge-owner.test.ts` | routes / .ts | bytes x19 | yes (8) | yes (5) | no |
| 103 | web | `editor-buffer-owner.test.ts` | named files / (default .ts,.svelte) | no file read | yes (5) | yes (48) | no |
| 104 | web | `editor-data-integrity.test.ts` | named files / .tmp | bytes x5 | **NO** | **NO** | no |
| 105 | web | `editor-rendering-owner.test.ts` | named files / .svelte | no file read | **NO** | yes (1) | no |
| 106 | web | `editor-save-preimage.test.ts` | named files / .svelte | bytes x4 | yes (8) | yes (1) | no |
| 107 | web | `effect-kind-recording.test.ts` | named files / (default .ts,.svelte) | SHELLS OUT | yes (2) | yes (8) | no |
| 108 | web | `egress-redaction-owner.test.ts` | named files / (default .ts,.svelte) | bytes x2 | yes (1) | yes (6) | no |
| 109 | web | `encryption-and-dedup-prevention.test.ts` | named files / (default .ts,.svelte) | bytes x4 | **NO** | **NO** | no |
| 110 | web | `error-debug-owner.test.ts` | named files / .ts | bytes x10 | yes (8) | **NO** | catch-return x1 |
| 111 | web | `error-handling-consistency.test.ts` | src, server tests / (default .ts,.svelte) | bytes x5 | yes (4) | **NO** | catch-return x1 |
| 112 | web | `error-message-projection-owner.test.ts` | named files / .ts,.svelte | no file read | yes (5) | yes (1) | no |
| 113 | web | `exp513-ux-overhaul.test.ts` | named files / (default .ts,.svelte) | no file read | yes (1) | **NO** | no |
| 114 | web | `exp514-resize-timeline-metrics.test.ts` | named files / (default .ts,.svelte) | bytes x27 | yes (1) | **NO** | no |
| 115 | web | `exp515-prevention.test.ts` | named files / (default .ts,.svelte) | bytes x7 | **NO** | **NO** | no |
| 116 | web | `exp516-chat-scroll-tools.test.ts` | named files / (default .ts,.svelte) | no file read | yes (1) | **NO** | no |
| 117 | web | `exp517-metrics-graph.test.ts` | named files / (default .ts,.svelte) | bytes x25 | yes (1) | **NO** | no |
| 118 | web | `exp518-tools-timeline-graph.test.ts` | named files / (default .ts,.svelte) | bytes x34 | yes (4) | yes (1) | no |
| 119 | web | `exp520-graph-persistence-menus.test.ts` | named files / (default .ts,.svelte) | no file read | **NO** | **NO** | no |
| 120 | web | `exp521-graph-evict.test.ts` | named files / (default .ts,.svelte) | bytes x2 | **NO** | **NO** | no |
| 121 | web | `exp522-ux-fixes.test.ts` | named files / (default .ts,.svelte) | no file read | yes (3) | yes (1) | no |
| 122 | web | `exp523-backend-wiring.test.ts` | named files / .ts | bytes x27 | yes (10) | yes (8) | no |
| 123 | web | `exposure-registry-counts.test.ts` | named files / (default .ts,.svelte) | bytes x2 | yes (7) | **NO** | no |
| 124 | web | `field-fold-owner.test.ts` | named files / (default .ts,.svelte) | no file read | yes (2) | yes (1) | no |
| 125 | web | `field-legibility-owner.test.ts` | named files / (default .ts,.svelte) | no file read | yes (8) | yes (2) | no |
| 126 | web | `field-plan-owner.test.ts` | named files / (default .ts,.svelte) | no file read | yes (4) | yes (4) | no |
| 127 | web | `file-effect-recording.test.ts` | named files / .ts | bytes x2 | yes (7) | yes (19) | no |
| 128 | web | `filesystem-owner.test.ts` | routes / .ts | bytes x30 | yes (14) | yes (8) | no |
| 129 | web | `frontend-components-deep.test.ts` | shared client-debug.ts ui-thresholds.ts widgets App.svelte M / .svelte | bytes x38 | yes (3) | yes (1) | no |
| 130 | web | `frontend-contracts-owner.test.ts` | contracts server src constants.ts ui-schema.ts web-ui-types. / (default .ts,.svelte) | no file read | yes (23) | yes (1) | no |
| 131 | web | `frontend-routing-owner.test.ts` | named files / .svelte | no file read | yes (7) | yes (1) | no |
| 132 | web | `frontend-store-owner.test.ts` | src state reset-all.ts client.ts App.svelte / .ts,.d.ts | bytes x11 | yes (8) | yes (1) | no |
| 133 | web | `frontend-stores-deep.test.ts` | src state reset-all.ts store-registry.ts / .ts,.d.ts | bytes x11 | yes (6) | yes (4) | empty-catch x2; catch-return x2 |
| 134 | web | `git-bridge-owner.test.ts` | named files / .d.ts,.ts | bytes x22 + shells | yes (5) | yes (5) | no |
| 135 | web | `graph-label-collision.test.ts` | named files / .ts | no file read | yes (1) | yes (1) | no |
| 136 | web | `graph-metrics-performance.test.ts` | named files / .ts,.svelte | bytes x2 | **NO** | **NO** | no |
| 137 | web | `graph-rendering-owner.test.ts` | named files / .svelte,.ts | no file read | yes (4) | yes (1) | empty-catch x6 |
| 138 | web | `graph-wire-shape.test.ts` | named files / (default .ts,.svelte) | bytes x7 | yes (5) | **NO** | no |
| 139 | web | `hallucination-safety-gate-owner.test.ts` | named files / (default .ts,.svelte) | bytes x2 | yes (2) | yes (2) | no |
| 140 | web | `harvested-fixes-prevention.test.ts` | named files / (default .ts,.svelte) | bytes x4 + shells | **NO** | **NO** | no |
| 141 | web | `history-cursor-owner.test.ts` | named files / (default .ts,.svelte) | bytes x2 | yes (2) | yes (13) | no |
| 142 | web | `history-route-bounded.test.ts` | named files / (default .ts,.svelte) | no file read | yes (3) | yes (5) | no |
| 143 | web | `index-badge-single-source.test.ts` | named files / (default .ts,.svelte) | bytes x4 | **NO** | **NO** | no |
| 144 | web | `input-validation-deny-by-default.test.ts` | routes blocks / .ts | no file read | yes (4) | **NO** | no |
| 145 | web | `integration-rule-refs-ratchet.test.ts` | named files / .ts | bytes x3 | yes (2) | **NO** | existsSync-return@72/96/101/129/134 |
| 146 | web | `intelligence-bridge-owner.test.ts` | routes / .ts | bytes x21 | yes (6) | yes (2) | no |
| 147 | web | `intelligence-panel-composed.test.ts` | intelligence / .svelte | bytes x2 | yes (1) | **NO** | no |
| 148 | web | `lens-provenance-owner.test.ts` | named files / .ts,.svelte,...exts | no file read | yes (4) | yes (2) | no |
| 149 | web | `liveness-stream-owner.test.ts` | named files / (default .ts,.svelte) | bytes x2 | yes (9) | yes (39) | no |
| 150 | web | `map-worker-nonblocking.test.ts` | named files / (default .ts,.svelte) | bytes x7 | **NO** | **NO** | no |
| 151 | web | `mcp-merged-into-tools.test.ts` | named files / (default .ts,.svelte) | bytes x4 | **NO** | **NO** | no |
| 152 | web | `memory-provenance.test.ts` | named files / (default .ts,.svelte) | bytes x7 | yes (2) | **NO** | no |
| 153 | web | `memory-rendering-owner.test.ts` | named files / .svelte | no file read | yes (3) | yes (2) | no |
| 154 | web | `memory-store-owner.test.ts` | server memory-bridge.ts tools-bridge.ts tool-executor.ts run / (default .ts,.svelte) | bytes x9 | yes (1) | yes (1) | no |
| 155 | web | `message-collapse-and-order.test.ts` | named files / (default .ts,.svelte) | bytes x2 | yes (9) | **NO** | no |
| 156 | web | `message-metadata-persistence.test.ts` | named files / (default .ts,.svelte) | no file read | **NO** | **NO** | no |
| 157 | web | `message-persistence-audit.test.ts` | named files / (default .ts,.svelte) | no file read | yes (1) | **NO** | no |
| 158 | web | `metrics-rendering-owner.test.ts` | named files / .svelte | no file read | yes (4) | yes (1) | no |
| 159 | web | `model-prefs-no-clobber.test.ts` | named files / (default .ts,.svelte) | no file read | yes (1) | **NO** | no |
| 160 | web | `model-selection-reaches-provider.test.ts` | llm-api-config.json / (default .ts,.svelte) | no file read | yes (2) | **NO** | no |
| 161 | web | `module-contract-owner.test.ts` | named files / (default .ts,.svelte) | no file read | yes (8) | **NO** | no |
| 162 | web | `module-derivation-owner.test.ts` | named files / (default .ts,.svelte) | bytes x2 | yes (1) | **NO** | no |
| 163 | web | `module-shell-owner.test.ts` | named files / .ts,.svelte | no file read | yes (6) | **NO** | no |
| 164 | web | `no-a11y-warnings.test.ts` | named files / .svelte | bytes x5 | yes (3) | yes (2) | existsSync-return@63 |
| 165 | web | `no-dead-css-selectors.test.ts` | named files / .svelte | bytes x3 | yes (1) | **NO** | no |
| 166 | web | `no-dead-css-tokens.test.ts` | named files / ...SCAN_EXTS | bytes x3 | yes (1) | **NO** | no |
| 167 | web | `no-duplicate-code.test.ts` | src, server / (default .ts,.svelte) | bytes x2 | yes (2) | **NO** | no |
| 168 | web | `no-duplicate-constants.test.ts` | src, server / .ts | bytes x2 | yes (2) | **NO** | no |
| 169 | web | `no-empty-catch.test.ts` | src, server / (default .ts,.svelte) | bytes x2 | yes (1) | **NO** | no |
| 170 | web | `no-fabricated-data.test.ts` | server, src, contracts / (ts\|js\|mjs\|svelte),.ts,.svelte,.mjs | no file read | yes (1) | yes (41) | no |
| 171 | web | `no-hardcoded-config-values.test.ts` | src, server / ...SOURCE_EXTS | bytes x12 | yes (3) | **NO** | no |
| 172 | web | `no-hardcoded-truncation-slices.test.ts` | named files / .test.ts,.ts,.svelte | bytes x10 | **NO** | **NO** | no |
| 173 | web | `no-hardcoded-values.test.ts` | src, server / (default .ts,.svelte) | bytes x5 | yes (4) | **NO** | no |
| 174 | web | `no-liveness-claims.test.ts` | named files / (default .ts,.svelte) | no file read | **NO** | yes (9) | no |
| 175 | web | `no-raw-sql-outside-db.test.ts` | db / (default .ts,.svelte) | bytes x8 | yes (6) | **NO** | no |
| 176 | web | `no-rule-refs.test.ts` | src, server, tests, contracts, scripts node_modules, dist, . / .svelte,...EXTS | bytes x6 | yes (1) | **NO** | no |
| 177 | web | `no-scattered-helpers.test.ts` | routes format.ts auth.ts / .d.ts,.ts | bytes x32 | yes (6) | yes (2) | no |
| 178 | web | `no-throw-new-error.test.ts` | src, server / (default .ts,.svelte) | bytes x2 | yes (2) | **NO** | no |
| 179 | web | `no-unused-exports-index.test.ts` | named files / (default .ts,.svelte) | no file read | **NO** | **NO** | no |
| 180 | web | `no-unused-exports.test.ts` | src, server, tests/helpers src, server, tests, contracts / (default .ts,.svelte) | bytes x2 | yes (1) | **NO** | no |
| 181 | web | `no-unused-imports.test.ts` | src, server, tests, contracts, scripts / (default .ts,.svelte) | bytes x2 | yes (2) | **NO** | no |
| 182 | web | `overflow-menu-virtualization.test.ts` | named files / (default .ts,.svelte) | bytes x2 | **NO** | **NO** | no |
| 183 | web | `persistence-across-restart.test.ts` | named files / (default .ts,.svelte) | no file read | **NO** | **NO** | no |
| 184 | web | `pii-redaction-owner.test.ts` | named files / (default .ts,.svelte) | no file read | **NO** | yes (1) | no |
| 185 | web | `pii-redaction-user-display.test.ts` | server / .ts | bytes x3 | yes (3) | yes (2) | no |
| 186 | web | `plain-language-owner.test.ts` | src/lib/settings, src/lib/metrics, src/lib/chat, src/lib/int / .svelte,.svelte,.ts | bytes x8 | yes (8) | **NO** | no |
| 187 | web | `privacy-layers-owner.test.ts` | named files / (default .ts,.svelte) | SHELLS OUT | yes (8) | yes (8) | no |
| 188 | web | `project-delete-safety.test.ts` | named files / (default .ts,.svelte) | bytes x3 | **NO** | **NO** | no |
| 189 | web | `pwa.test.ts` | named files / (default .ts,.svelte) | bytes x2 | yes (2) | yes (1) | no |
| 190 | web | `quality-payload-completeness.test.ts` | named files / (default .ts,.svelte) | no file read | yes (1) | yes (1) | no |
| 191 | web | `quick-view-slice-wired.test.ts` | named files / (default .ts,.svelte) | no file read | yes (1) | **NO** | no |
| 192 | web | `rail-glyph-distinctness-owner.test.ts` | named files / (default .ts,.svelte) | no file read | yes (9) | **NO** | no |
| 193 | web | `ranking-knobs-are-real.test.ts` | named files / (default .ts,.svelte) | no file read | yes (3) | **NO** | no |
| 194 | web | `rate-limit-http.test.ts` | named files / (default .ts,.svelte) | no file read | yes (3) | yes (2) | no |
| 195 | web | `rate-limit-security.test.ts` | models.ts llm-bridge.ts harness-config.ts / (default .ts,.svelte) | bytes x13 | yes (3) | **NO** | no |
| 196 | web | `readout-projection-owner.test.ts` | named files / (default .ts,.svelte) | no file read | yes (4) | yes (1) | no |
| 197 | web | `recording-choke-points.test.ts` | named files / .ts,.svelte,.ts | SHELLS OUT | yes (2) | yes (1) | no |
| 198 | web | `redaction-reaches-provider.test.ts` | llm-api-config.json / (default .ts,.svelte) | no file read | yes (5) | yes (1) | no |
| 199 | web | `removal-is-recorded.test.ts` | named files / (default .ts,.svelte) | bytes x2 | yes (1) | yes (1) | no |
| 200 | web | `rewind-reaches-provider.test.ts` | llm-api-config.json / (default .ts,.svelte) | no file read | yes (13) | yes (2) | no |
| 201 | web | `right-panel-persistence.test.ts` | named files / (default .ts,.svelte) | no file read | **NO** | **NO** | no |
| 202 | web | `route-registry.test.ts` | named files / .ts | bytes x11 | yes (4) | **NO** | no |
| 203 | web | `secret-intelligence-owner.test.ts` | named files / .d.ts,.ts | bytes x3 | yes (28) | yes (16) | no |
| 204 | web | `selection-persistence.test.ts` | named files / (default .ts,.svelte) | no file read | **NO** | **NO** | no |
| 205 | web | `self-improving.test.ts` | named files / (default .ts,.svelte) | no file read | **NO** | **NO** | no |
| 206 | web | `settings-catalog-gate-owner.test.ts` | named files / .svelte | bytes x2 | yes (3) | **NO** | no |
| 207 | web | `settings-rendering-owner.test.ts` | named files / .svelte | no file read | yes (2) | yes (1) | no |
| 208 | web | `shared-primitive-bindable-contract.test.ts` | named files / .svelte | bytes x4 | yes (4) | yes (1) | no |
| 209 | web | `shared-primitive-prop-contract.test.ts` | named files / .svelte | bytes x6 | yes (3) | **NO** | no |
| 210 | web | `sidebar-content-sync.test.ts` | named files / (default .ts,.svelte) | bytes x8 | **NO** | **NO** | no |
| 211 | web | `sidebar-rework.test.ts` | named files / (default .ts,.svelte) | bytes x4 | **NO** | **NO** | no |
| 212 | web | `sidebar-virtualization.test.ts` | named files / (default .ts,.svelte) | bytes x2 | yes (6) | **NO** | no |
| 213 | web | `sse-connection-limit.test.ts` | named files / (default .ts,.svelte) | bytes x11 | yes (6) | yes (37) | no |
| 214 | web | `sse-error-code-owner.test.ts` | named files / .ts | no file read | yes (1) | yes (1) | no |
| 215 | web | `sse-event-owner.test.ts` | server routes src contracts / .ts | bytes x11 | yes (4) | yes (2) | no |
| 216 | web | `state-imports-resolve.test.ts` | named files / (default .ts,.svelte) | bytes x3 | yes (1) | **NO** | no |
| 217 | web | `subprocess-confinement-owner.test.ts` | engine.ts / (default .ts,.svelte) | bytes x2 + shells | yes (23) | yes (67) | existsSync-return@1794/1936; empty-catch x2 |
| 218 | web | `symbol-search-single-path.test.ts` | server / (default .ts,.svelte) | bytes x6 | yes (5) | yes (3) | no |
| 219 | web | `system-prompt-config.test.ts` | named files / (default .ts,.svelte) | no file read | yes (4) | **NO** | no |
| 220 | web | `tasks-no-stale-duplicates.test.ts` | named files / (default .ts,.svelte) | bytes x2 | **NO** | **NO** | existsSync-return@23 |
| 221 | web | `temp-dir-owner.test.ts` | temp-dir.ts / .ts | bytes x5 | yes (4) | **NO** | no |
| 222 | web | `template-check-wired.test.ts` | named files / (default .ts,.svelte) | bytes x4 | **NO** | **NO** | no |
| 223 | web | `test-helpers-dedup.test.ts` | named files / .ts,.ts,.mjs | bytes x7 | yes (5) | **NO** | no |
| 224 | web | `test-isolation-contract.test.ts` | named files / (default .ts,.svelte) | no file read | **NO** | yes (2) | no |
| 225 | web | `test-isolation-owner.test.ts` | .. ch-isolation-probe- / .test.ts | bytes x2 | yes (2) | yes (1) | no |
| 226 | web | `test-naming-structure.test.ts` | named files / .test.ts,.spec.ts,.ts,.js,.tsx,.mts,.cts | bytes x5 | yes (4) | **NO** | skipIf@69 |
| 227 | web | `test-run-watchdog.test.ts` | named files / .ts | bytes x2 | yes (1) | yes (8) | no |
| 228 | web | `timeline-auto-load.test.ts` | named files / (default .ts,.svelte) | bytes x2 | **NO** | **NO** | no |
| 229 | web | `timeline-no-hardcoded-magic.test.ts` | timeline / .svelte,.ts | bytes x2 | yes (4) | **NO** | existsSync-return@31/54 |
| 230 | web | `timeline-per-chat-scope.test.ts` | named files / (default .ts,.svelte) | bytes x3 | **NO** | **NO** | no |
| 231 | web | `timeline-recording-fidelity.test.ts` | named files / (default .ts,.svelte) | no file read | yes (7) | yes (3) | no |
| 232 | web | `timeline-refresh-on-done.test.ts` | named files / (default .ts,.svelte) | bytes x2 | **NO** | **NO** | no |
| 233 | web | `timeline-rendering-owner.test.ts` | named files / .ts,.svelte | no file read | yes (1) | yes (1) | no |
| 234 | web | `tool-call-by-callid.test.ts` | named files / (default .ts,.svelte) | no file read | **NO** | **NO** | no |
| 235 | web | `tool-call-done-emission.test.ts` | named files / (default .ts,.svelte) | no file read | yes (4) | **NO** | no |
| 236 | web | `tool-call-persistence-db.test.ts` | named files / (default .ts,.svelte) | no file read | **NO** | **NO** | no |
| 237 | web | `tool-duration-owner.test.ts` | named files / (default .ts,.svelte) | no file read | **NO** | **NO** | no |
| 238 | web | `tool-execution-async-owner.test.ts` | named files / .ts | bytes x2 + shells | yes (3) | **NO** | no |
| 239 | web | `tool-manifest-executor-match.test.ts` | named files / (default .ts,.svelte) | bytes x2 | yes (4) | **NO** | no |
| 240 | web | `tool-output-format.test.ts` | named files / (default .ts,.svelte) | no file read | **NO** | **NO** | no |
| 241 | web | `tool-registry-owner.test.ts` | named files / .d.ts,.ts | bytes x7 | yes (4) | yes (1) | no |
| 242 | web | `tool-result-persistence.test.ts` | named files / (default .ts,.svelte) | bytes x4 | **NO** | **NO** | no |
| 243 | web | `tools-rendering-owner.test.ts` | named files / .svelte | no file read | yes (3) | yes (1) | no |
| 244 | web | `ui-control-wiring.test.ts` | named files / (default .ts,.svelte) | no file read | **NO** | yes (4) | no |
| 245 | web | `ui-declaration-bindings-owner.test.ts` | named files / .ts,.ts,.svelte | no file read | yes (7) | **NO** | no |
| 246 | web | `ui-primitives-owner.test.ts` | named files / .svelte | bytes x6 | yes (2) | yes (1) | no |
| 247 | web | `ui-surface-reachability.test.ts` | named files / .ts,.svelte | no file read | yes (4) | **NO** | no |
| 248 | web | `value-reference-scan.test.ts` | named files / (default .ts,.svelte) | bytes x2 | **NO** | **NO** | no |
| 249 | web | `virtualization-owner.test.ts` | named files / (default .ts,.svelte) | no file read | yes (1) | **NO** | no |
| 250 | web | `web-ui-defaults-owner.test.ts` | src, server, contracts / (default .ts,.svelte) | bytes x7 | yes (1) | **NO** | no |
| 251 | web | `web-ui-runtime-budget-verdict.test.ts` | named files / (default .ts,.svelte) | no file read | yes (4) | **NO** | no |
| 252 | web | `web-ui-runtime-budget.test.ts` | named files / (default .ts,.svelte) | bytes x3 | yes (4) | **NO** | existsSync-return@109 |
| 253 | web | `when-predicate-vocabulary.test.ts` | named files / (default .ts,.svelte) | no file read | yes (2) | **NO** | no |
| 254 | web | `worker-thread-owner.test.ts` | worker-pool.ts / (default .ts,.svelte) | bytes x12 | yes (6) | **NO** | no |
| 255 | web | `zero-knowledge-badges.test.ts` | named files / (default .ts,.svelte) | no file read | yes (1) | yes (1) | no |
| 256 | web | `auth-prevention.test.ts` | named files / (default .ts,.svelte) | no file read | yes (1) | **NO** | no |
| 257 | web | `exp496-prevention.test.ts` | named files / (default .ts,.svelte) | no file read | yes (2) | **NO** | no |
| 258 | web | `memory-opt-in-prevention.test.ts` | named files / (default .ts,.svelte) | no file read | **NO** | yes (1) | no |
