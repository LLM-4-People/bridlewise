---
layout: default
title: 'Unwired findings — the single ranked list'
---

# Unwired findings — the single ranked list

**Date:** 2026-07-27 · **Status:** research only, nothing edited or wired.

This is the one list. Two sweeps and three verification passes produced two evidence
documents; this file is the authority over both, and exists because leaving two documents
answering one question is the same "one question, two paths" defect the doctrine forbids.

- Evidence, sweep 1 (57 sibling workspaces + `harness-main-v1`): `UNWIRED-INVENTORY.md`
- Evidence, sweep 2 (all 481 `experiments/` dirs) + three verification addenda:
  `UNWIRED-INVENTORY-EXPERIMENTS.md`

**Two conclusions the evidence documents establish before any item below matters:**

1. **The 57 sibling workspaces hold almost nothing.** Total salvage from all of them: one
   25-line mutex, one uncommitted test-classification idea, one research document. The real
   mass is inside `harness-main-v1`.
2. **No experiment anywhere contains work newer than live's version of a file they share.**
   Measured over 79,694 same-path content comparisons: zero. So the only genuine gaps are
   things *absent* from live, never things *stranded* in a snapshot.

---

## Tier 1 — do these

### 1. The exposure catalog is fabricated
10 of 11 modules in `integration/src/shared/exposure/registrations/` are per-process mock
state. Their own comments say so (`tools.ts`: *"mirrors what the real tool registry would
expose"*). Zero writers anywhere. `privacy.ts` is the lone real one and is the template.
Live via `routes/schema.ts` → `/api/schema/ui/values` → the client. **This is fabricated
data on a user-facing path** — the first prohibition. Either derive them or delete them;
shipping invented numbers is the one option that is not defensible.

### 2. EXP429 — 306 additive lines into `symbol-search.ts`
`diff live exp429` = **0 removed, 306 added**. A literal drop-in adding BM25, query
specificity, `hybridSearchSymbols`, bias detection. Live's `memory-search.ts` header
advertises the plug-in point this was written for. **~1 hour**, and it may make item 3
unnecessary.
`experiments/exp429-improve-core/src/intelligence/symbol-search.ts`

**Verified directly, not taken from the agent's report** (this is the top recommendation, so
its central claim should not rest on someone else's diff): `diff` of live against the
experiment gives **0 lines present only in live** and **306 present only in the experiment**,
and every symbol live exports is still exported by the experiment version. The
additive-superset claim is exact. What remains unverified is the *quality* number
(88-100% top-1) — that is self-reported and nothing was executed.

### 3. `search_code` is a recursive regex grep
`web-interface-foundation-v1/server/tool-executor.ts:335` — `readdirSync` walk plus
`regex.test(line)`. No index, no ranking, no natural language. EXP398's recorded decision
was to replace it with BM25 + re-ranker; **the other half of that same decision landed**
(`quick_view`, `slice`, `viewport`, `skeleton` are live). The model's only way to find code
by description is a regex it has to guess. Do item 2 first.

### 4. Landlock never reaches the web UI
`experiments/exp486-landlock-folder/server/landlock-runner.ts` — 475 lines, 15 tests,
designed, with the guardian it depends on already ADMIT-reviewed twice and byte-identical to
live. `grep -rniE "landlock|guardian"` across the web server and cockpit returns **zero**.
Highest-confidence, lowest-risk item in the inventory. **Small-medium.**

---

## Tier 2 — real capability, real cost

### 5. Trace mode (USR-057) is two-thirds built, and both governing documents deny it
`integration/src/performance/` — 8 modules, ~65 KB, landed 2026-07-24.
`metrics-collector.ts` and `performance-config.ts` are **built and wired**
(`server/metrics-bridge.ts:33`), with the config carrying the exact USR-057 key list.
The gaps are narrow and specific:
- `function-manifest.ts` — built, **zero production callers**, never regenerated, never
  blocking on staleness. This is the requirement's mechanical answer to "I want everything".
- `diagnostic-modes.ts` — CPU / memory / I/O / event-loop / process / cgroup, **CLI only**.
- always-on aggregation — **already live**; stop planning it as missing.

### 6. The harness cannot tell whether the model did what it said
Plan-adherence: parse the plan the model states in prose, compare to the tool calls it
actually emits, classify divergence four ways, feed a correction back. Two SHIP-IT
experiments, 100% drift detection, 18/18 tests, integration already designed against a
session loop. `grep -rli adherence integration/src` → **zero**. Live's deviation-detector
answers a different question ("did it wander off-topic?"). Caveat: its tool vocabulary is
CLI-era and must be re-derived from the live registry.
`experiments/llm-adherence-live/`, `experiments/adherence-automatic/`

### 7. `tool-call-gate.ts` — a capability regression inside a *wired* module
Live is a 297-line rewrite of a 792-line version; live's header still reads `(EXP485, )`
with a dangling comma. Missing: `invalid_json`, `all_blocked` incoherence, pluggable rules,
strict extra-args, structured schema issues, an exposure surface, and **Levenshtein "did you
mean?"** — which turns a dead-end block into a self-correcting one. Port the behaviours onto
the live file; do not blind-replace.

### 8. `_experiments/llm-beyond-max/` — 2,985 lines, no live counterpart
Chunking, continuation, map-reduce, sliding window. Live handling of the same concern is
**one line** surfacing `finish_reason === "length"` as an error. Only matters if you want
outputs longer than one model response — but there is no alternative in the tree.

### 9. Multi-agent orchestration and MCP have no web surface
`integration/src/agents/**` (2,793 lines, 464 tests) — bridge is 50 lines that only *lists*
agents; the four delegation tools are absent from the web manifest.
`integration/src/mcp/**` (20 modules, 161 tests) — bridge is 78 lines: *"Does NOT connect to
servers."* The UI lists servers it cannot reach.

---

## Tier 3 — cheap, unglamorous, worth doing

- **Nine D3 normalization regression tests were dropped in the merge.** The features landed;
  their only executable proof did not. ~2 hours.
- **EXP377's mutant restructure landed at 63%** — 32 of 51 pairs, 13 of 29 types, and **all
  three verification runners lost**, including the one that produced its own 37/37
  zero-regression result. A restructure that verified itself and then lost its verifier.
- **The tree-sitter parse mutex** — 25 lines converting a documented convention
  ("parse sequentially") into an enforced one. Value rises sharply if item 5's quality work
  ever hosts parsing in a request path.
  `exp482-clean-verify/src/quality/languages/shared/tree-sitter-loader.ts`
- **`integration/src/quality/**` — 60 checks, 7 languages** vs the live 5-term heuristic
  score. Blocker verified real: tree-sitter is genuinely not installed in the web UI.

---

## Delete, do not wire

- `_experiments/unified/` — 5,229 lines. Zero signals exist only there; **38 exist only in
  live**. A live DRY hazard.
- `integration/src/memory/tool-result-*.ts` — superseded by `memory/unified/`, which is wired.
- `candidate/` — 627 files, identical to live but for two CLI files.

---

## The finding that is not a module

**The mandated entry-point document is stale in the direction that suppresses search.**
`integration/AGENTS.md` says "read this file completely before taking any action", and:

| Claim | Measured |
|---|---|
| ~323 modules registered | **526** manifest rows / 509 files |
| ~6,949 tests across ~229 files | **403** test files |
| 10 open-blocking findings | **12** |
| performance observability: "research not started" | 8 modules, one wired |

Every agent starts from a picture wrong in the same direction — it under-reports what
exists. An agent told there is no performance work will not go looking for
`function-manifest.ts`. That is very likely why USR-057 was carried as unstarted while
two-thirds built. All four numbers are derivable, so a generated status block compared on
every check run turns this from something someone must notice into something that fails a
gate — the same move `function-manifest.ts` already implements for functions, and is never
called.

---

## What no pass would have caught

Three passes ran: path-set difference, file size, and tree-wide exported-symbol names. Two
false finds were produced and killed, both the same shape — a symbol absent from the path it
used to occupy but present elsewhere in live (`createMcpToolAdapter` → `mcp/tool-adapter.ts`;
`proactiveRetrieve` → `proactivelyInject`). **Relocation is the normal outcome of a refactor
here, so a name-grep scoped to an old path manufactures findings.**

### The fourth pass closed that blind spot

The three passes above compare by path, by size, and by symbol name. I claimed a capability
renamed *and* moved *and* rewritten in one change would escape all of them. A fourth pass was
run to test that claim, comparing **content** rather than identity: every experiment `src`
path with no live counterpart was scored by normalized line-set Jaccard against all 509 live
files, and the best match reported.

It works, and it caught exactly the case I said it would miss —
`memory/unified/inverted-index.ts` matches live `memory/unified/unified-inverted-index.ts`
at **0.96**: renamed, and still found. Others resolve at 1.00, i.e. an identical body under a
different path:

| Experiment path (flagged "absent") | Live file | Overlap |
|---|---|---|
| `unified/awareness/signals/risk.ts` | `awareness/signals/risk.ts` | 1.00 |
| `unified/awareness/signals/trending.ts` | `awareness/signals/trending.ts` | 1.00 |
| `quality-packs/multi-lang/checks/complex-condition.ts` | `quality/checks/complex-condition.ts` | 1.00 |
| `quality-packs/multi-lang/checks/duplicate-imports.ts` | `quality/checks/duplicate-imports.ts` | 1.00 |
| `memory/unified/inverted-index.ts` | `memory/unified/unified-inverted-index.ts` | 0.96 |

**This corrects a number in the evidence.** Sweep 1 reported "335 distinct `src/**.ts` paths
absent from live". That figure counts relocations as absences. Measured by content, the
genuinely-absent set is **259** — and the relocated remainder independently confirms two
"delete, do not wire" verdicts above, since `_experiments/unified/` and
`quality-packs/multi-lang/` turn out to be the *same bodies* live already carries, not merely
the same concerns.

### What is still not closed

Nothing was executed. Every performance figure quoted from an experiment
(`EXP429`'s 88–100% top-1, `EXP460`'s 71.4%, `EXP449`'s 97 tps) is self-reported by that
experiment and has not been reproduced. Believing the ranking above means believing those
numbers; confirming any single item means running it. That is the honest boundary of a
read-only sweep, and no further static pass can move it.

---

## 2026-07-29 — DECLARED-BUT-UNREACHED, found by the silent-universe work

**The unifying shape: a declaration with nothing behind it, where the guard cannot tell.**

| # | declared | reached | how it stayed green |
|---|---|---|---|
| U-01 | `RoomId` included `"memory"` and `"tools"` | **no `MemoryRoom.svelte` / `ToolsRoom.svelte`** | all 9 consumer tests **stubbed** `roomExists`/`outletExists`; the real glob was never asserted non-empty. **2 of 7 rooms permanently dead.** **FIXED (S16)** — removed at rung 2, `openRoom(id: RoomId)` made the empty state representable |
| U-02 | `tests/e2e/` in `playwright.config.ts` `testMatch` | **the directory does not exist** | all 5 specs live in `tests/cockpit/e2e/` and matched only because **`e2e` is a bare SUBSTRING** of the surviving alternative. **FIXED (S17)** — anchored at `^`, and its first anchor `(?:^|/)e2e/` **still matched inside `cockpit/e2e` and was caught by a plant** |
| U-03 | `ToolResultStore.configure` | **zero callers** | it assigned into a **deep-frozen object**, so it would have thrown for every caller on every path. **FIXED (S14)** — removed |
| U-04 | `JudgeOptions.budgetMs` | declared, passed by **every** caller, **read by nothing** | **FIXED (S13)** — removed; 0 occurrences across 975 web source files afterwards |
| U-05 | `integration/src/self-improving/` — 9 files | **reached by NOTHING**, runtime OR type level, from **281 entry points** | no consumer-count rule sees it, and it **collides by name** with `web/server/self-improving.ts`. **OPEN — dead-domain finding for the user** |
| U-06 | `stripCommentsKeepStrings` | **byte-identical to `stripCommentsOnly`** | two names for one function; 11 callers. **FIXED (S17)** — callers moved, function gone |
| U-07 | `OUTLET_IDS` (`room-door-owner.test.ts:77`) | a **hand-written literal** typed `readonly OutletId[]` | **a subset array is assignable**, so a seventh outlet with a dead glob gives **6 passed, 0 tsc errors**. **OPEN — the guard built to end U-01 contains U-01** |
| U-08 | `webUiTestRuntimeBudgetMs` | replaced | **FIXED (S13)** — 0 hits repo-wide after |

**The rule these produce → contract §31b:** *derive the universe from the declaration; a guard that
lists its own universe by hand contains the defect it exists to end.*

## 2026-07-29 (later) — GUARDS THAT WERE UNWIRED FROM THEIR OWN SUBJECT

| # | guard | what it could not see |
|---|---|---|
| U-09 | `frontend-contracts-owner` §D | matched an import specifier against a stripper that **blanks string interiors** — **5 tests passing unconditionally** |
| U-10 | `static-literal-extraction-cache` | `assert.equal(new Set([...aSet]).size, arr.length)` — **true by construction**; a planted duplicate is certified unique |
| U-11 | `dead-export-scanner` | **0 dead of 2,833** — the file is inside its **own** reference surface and its 315 baseline strings held every baselined export alive. Removing the baseline: **0 → 124**; excluding itself: **127** |
| U-12 | same | **140 of 315 baseline entries MALFORMED** (whole source lines from a listing and a diff), landing in a set discarded via `void missingBaseline` |
| U-13 | `filesystem-owner:641` etc. | **no floor at all** — rename one symbol and the loop enumerates nothing, body never runs, **green in 0 ms** |
| U-14 | `declared-universe` reason hatch | **no member-count check of any kind** — 7 planted exemptions all silenced it |
| U-15 | `room-door-owner` `OUTLET_IDS` | a **hand-written** universe typed `readonly OutletId[]` — a subset array stays assignable, so a 7th member arrives with no floor |
| U-16 | the `.gitignore` guard | **its own REMEDY TEXT** printed a pattern that reproduces the defect it rejects |
| U-17 | `shared-primitive-bindable-contract:162` | globs `src/lib/shared/*.svelte` — **after the cutover it matches an empty directory: zero tests generated, green.** **OPEN — must be floored BEFORE the cutover runs** |

**The shape: a guard whose universe comes from the tree can be unwired by the tree.** §31b (derive the
universe), §31 (a partial loss is invisible), and the new door rule — **a count is the wrong floor,
because zero is often correct; what a count cannot separate is whether the TERM still means anything.**

## 2026-07-29 (S24) — U-17 REFUTED, and the finding underneath it

**U-17 as recorded is WRONG, and it was wrong about the mechanism, not just the severity.** It said
`shared-primitive-bindable-contract:162` globs `src/lib/shared/*.svelte` so that "after the cutover it
matches an empty directory: zero tests generated, green." Driven in both post-cutover states:

| state | result |
|---|---|
| `src/lib/shared/` absent | **rc 1**, `ENOENT scandir` at collection, `Tests no tests` |
| dir present, `.svelte` gone from disk AND index | **rc 1**, `3 failed` — all three floors fired |

The cases were generated by **`readdirSync` (line 72)**, not by the glob; the glob only resolved
module paths for loading. The file already carried three non-emptiness floors. **It could not pass
vacuously. U-17 is CLOSED as REFUTED, not as fixed.**

| # | guard | what it could not see |
|---|---|---|
| **U-18** | `shared-primitive-bindable-contract` | **a LIVE member of its own class, permanently.** `$bindable` is declared in **2** of 150 tracked `.svelte` files; the guard enumerated a DIRECTORY and could only ever see one. `src/cockpit/shell/Desk.svelte` (`text = $bindable()`, consumed by `Cockpit.svelte`) is in the UI that **survives** the cutover and was never covered. **FIXED (S24)** — retargeted at the component tree |
| **U-19** | same, its RULE | the rule was **fitted to the single instance it could see**: it matched `bind:{prop}`, conflating the DIRECTIVE NAME with the BOUND EXPRESSION. It passed only because `SearchInput`'s prop is `value` and its element's directive is also `value`. **`Desk.svelte`'s correct `bind:value={text}` is REJECTED by it.** **FIXED (S24)** |
| **U-20** | the ten in the sweep below | **generate cases from an enumeration of the doomed tree with no non-emptiness floor at all.** OPEN |

**THE SWEEP, and the sample was the population.** 508 tracked test-tree files → 149 call an
enumerator → 130 generate cases from it → **35 name the doomed `src/lib`**, of which **10 have no
floor**. Spellings [UNIT=files]: `walk` **84**, `readdirSync` **45**, `walkTs` 20, `sourceFiles` 18,
`sourceFilesReachableFrom` 5, `ls-files` 4, `nonEmptySourceFilesUnder` 3, `gitTrackedPaths` 3,
`sourceFilesMentioning` 2, `reachableFilesImporting` 2, `globSync` 2, **`import.meta.glob` 1**, `glob` 1.
> **`import.meta.glob` — the spelling U-17 named — occurs in exactly ONE file in the whole test tree.**
> The real population is `walk` and `readdirSync`. And **`walk`'s `assertIndexCoverage` does not help
> here**: after a real `git rm` the index agrees with disk and the empty walk is legitimate.

**THE RESIDUAL NO RUNG CATCHES:** a deleted specifier is `TS2307`; a deleted scan root is refused by
`walk()`. **`import.meta.glob` with a non-matching pattern is silent at every rung** — not a
specifier, not a scan root, and it yields `{}` rather than an error. *That is why the floor must be on
the SUBJECT and not on the count.*

## 2026-07-29 (product round) — DECLARED-BUT-UNREACHED, and one DECLARED-BUT-UNSTYLED

| # | declared | reached | how it stayed green |
|---|---|---|---|
| U-18 | `.absent` in `RoomHost`/`ScopeHost`/`Desk` | **the rule carried ONLY `margin`** | *"nothing to inspect yet"* was **typeset identically to ordinary content.** FIXED (S26) |
| U-19 | the desk's *"reading the recorded trip"* | **byte-identically styled to *"carries nothing"*** | pending and absence were indistinguishable. FIXED (S26) |
| U-20 | the three-colour status scheme | **reached exactly ONE element in ONE room** | `[data-state="ok"] .beat-card` + 3 siblings; any other surface had to re-derive the hue. FIXED (S26) |
| U-21 | GRAVITY-WELL's motion vocabulary | **9 of 9 tokens exist in NEITHER `tokens.css`** | re-measured independently by S28 (all nine, both files) plus the four conflicting axes. §7, §7b and the §11 `src/styles/tokens.css` line are now **marked SUPERSEDED in the doc itself**, with the axis table and the withdrawal. **CLOSED (S28)** |
| U-22 | which `tokens.css` supersedes which | **no design document decides** | **DECIDED in `DESIGN-COCKPIT-V2.md` §12 + §13** on a measurement nobody had taken — the CONSUMER CENSUS: `src/styles/tokens.css` has **zero** readers in `src/cockpit/**` and 225 distinct names read by `src/lib/**` (+7 by `App.svelte`), so its entire readership is the tree §13 deletes. Intersection re-measured at **0** (208 vs 230). **CLOSED (S28)** |
| U-23 | `--beam` in the sweep canvas | **captured ONCE at mount** | fixed at `src/cockpit/paint/design-tokens.ts` — reader revoked when the paint ends, plus a NAMED signal (`designConditions`) the repaint binds to. **The class was bigger than `--beam`: all 15 `SweepPalette` values are re-declared by the light theme, and three more canvases read fresh but re-ran on nothing.** Sweep/MicroSweep/Spark/SwitchRoom converted; guard `toEqual([])`. **CLOSED (S28)** |
| U-24 | enum setting options | **raw server values on screen** — and it was **FOUR sites, not one**: the segmented control, the index row's reading, the provenance line and the reset button | derived through `humanizeId`, the id→words owner the project already had; `SettingRow` no longer carries a `readonly string[]`. **The `"short-term"` specimen is not a served enum member** — the real ones are `round-robin`, `oldest`, `tfidf`, `fifo`. **CLOSED for the ~27 members whose token carries its words; the 3 acronyms need the WIRE to carry declared words → new row U-27** |
| U-25 | the motion half of #94 | **the prescribed mechanism does not exist** | built at `src/cockpit/motion/motion.ts`: a motion cannot start without a `MotionCause`, no factory takes a clock, `becauseChanged` REFUSES an unchanged pair, and a cause is spent when used. All **3 of 3** self-starting `animation:` declarations converted; guard is `toEqual([])`, not a ratchet. **CLOSED (S28)** |
| U-26 | `redactedValues` success counter | **increments on a 3-of-48-character mask** | the redactor **masks the NOUN, leaves the VALUE, and reports success.** **FIXED — S29 (`47edef0`: a redaction that did not remove the value can no longer report success) + S32 (the counter counts VALUES → U-30)** |
| **U-27** | an enum member whose TOKEN does not carry its words (`fifo`, `lifo`, `tfidf`) | **no derivation over the token can invent them** — `humanizeId("fifo")` is `"Fifo"`, and nothing can tell `fifo` from `oldest` by inspection | the words must come from the DECLARATION (`makeEnumCustomization` + the literal registrations beside it), which means the wire carrying words per member — a contract change across both repos. **OPEN — S28-01** |
| **U-28** | `src/lib/intelligence/DependencyGraph.svelte` + `src/lib/timeline/HorizontalTimeline.svelte` | read design tokens and **re-run on nothing** — the same class as U-23 | deliberately NOT fixed: both are in `src/lib/**`, the tree `COCKPIT-V2` §13 deletes, and the tokens they read have no theme variant today. **OPEN by decision — S28-02** |

## 2026-07-29 (security + gate round)

| # | declared | reached | how it stayed green |
|---|---|---|---|
| U-29 | *"a sensitive KEY NAME discards the whole value **whatever it looks like**"* | **gated on `typeof v === "string"`** | arrays and nested objects kept their secrets, **and both counters read exactly like the inert control**. **FIXED (S32)** |
| U-30 | `redactedValues` — *"EVENTS in which at least one secret was… removed — a SUCCESS CLAIM"* | **counted per SPAN** | one droppable key + one surviving secret incremented the success claim. **FIXED — it now counts VALUES** |
| U-31 | both counters: *"re-observed absent by the **canonical oracle**"* | **the file imports no privacy module at all** | residue of a reverted wiring, left in a security control's contract. **FIXED — claim DELETED, and the honesty test uses the oracle as its own witness** |
| U-32 | `enabledSinks` / `redaction.kinds` | **declared in the contract, SET in the shipped config, READ BY NOTHING** | and `DEBUG_SINK_KINDS` declared `file` and `timeline`, **neither implemented anywhere**. **`enabledSinks` now READ; the two unimplemented kinds REMOVED. `redaction.kinds` still unread — stated, not faked** |
| U-33 | `VITEST_MODULE_CACHE_DIR` | **a hardcoded constant naming the default directory** | a redirected run built its cache elsewhere while the reporter counted an untouched one — **a fully cold run recorded as WARM**. **FIXED (S31)** |
| U-34 | `set-cookie` under the forbidden-pattern list | **matches none of the eight patterns** | never reaches the key-name decision. **FIXED (S33) at the key-name gate — dropped in all four casings (T-check A: each +1/+0). The regex LIST itself survives as `performance.labelSchema.forbiddenLabelPatterns` → U-36** |
| U-35 | the absence-witness classifier | **accepts a constant, an unused `const`, a different subject, and a witness that passes with the subject EMPTY** | *§36's own failure mode inside the guard enforcing §36.* Ratchet **28 → 21** after a missing presence spelling was added — *it had been charging debt for compliance.* **LINKAGE still OPEN and recorded in source** |

## 2026-07-30 (S33 triple-check — two independent read-only checkers)

| # | declared | reached | how it stayed green |
|---|---|---|---|
| **U-36** | *"a single-casing pattern is UNREPRESENTABLE"* (S33) | **true only for `debug.redaction.additionalSensitiveKeyNames`** — one subsystem over, `performance.labelSchema.forbiddenLabelPatterns` still holds **13 single-casing regexes** (`bridlewise.config.json:580`) behind plain `z.string().min(1).max(512)` (`performance-config.ts:90`) | **and the one list is compiled TWO WAYS:** `isLabelAllowed` (`performance-config.ts:270`) compiles `"u"` — `[Ss]ecret` cannot match `SECRET`, so driven, `SECRET`/`TOKEN`/`API_KEY`/`PASSWORD`/`AUTHORIZATION`/`SK-` values were **ALL ALLOWED through the gate** — while `redactLabelValue` (`:282`) compiles the same list `"giu"` and drops all seven. The two gates disagree about SCREAMING credential material; any consumer of `isLabelAllowed` alone admits it. Found INDEPENDENTLY by both checkers. **FIXED (S34 `2c3a844`): field → `forbiddenLabelNames` (names only, `.regex` refuses — all 13 shipped patterns fail config load, driven); ONE predicate `isForbiddenLabelText` serves both gates (a second compilation site has nothing left to compile), backed by a one-interpreting-reader tree guard; the credential half is ALWAYS-ON from the declared owner, so emptying the config field cannot re-admit credentials. 9 mutations, 9 killed** |
| **U-37** | `DATABASE_URL` / `SK_` | **survive in every casing** (all four rows +0/+0) — shape-invariance proves a VOCABULARY gap in `SENSITIVE_KEY_PARTS` (no part matches `databaseurl`/`sk`), not casing | closing it from config was **DECLINED (§37)**: the config field covers one of four consumers, restoring exactly the two-owners drift `secret-signals.ts` exists to end. **HALF-CLOSED (S34, precision corrected by its check): `SK_` now caught in the four `isSensitiveKeyName` consumers — debug gate, perf label gates, web redactor, web write gate, ALL FOUR DRIVEN — via the owner pattern `/(?:^|[^\p{L}\p{N}])sk[_-]/iu`; the egress classifier (`classifyData`) is parts-only and does NOT catch it (→ U-42, driven: `SK_TEST` → `public, signals=[]`), nor does web's `harnessOwnSecrets` (→ U-44) — separator-decided, so it cannot match `disk_`/`task-` (both pinned as negative fixtures; the old `[Ss]k[-_]` bigram had been redacting them). Residual is `DATABASE_URL` ALONE, mechanism recorded: `databaseUrl` is a legitimate writable config-field name, so classifying the NAME sensitive would make the web write gate refuse it — the trade belongs to that gate's owner. OPEN** |
| **U-38** | `no-temp-dir-leaks.test.ts:75` — *"aliasing cannot evade it"* | **the import-edge branch is `[^\n]*`-bounded** | witnessed: single-line `import { tmpdir as t } from "node:os"` detected `true`, the multi-line aliased form detected **`false`** — and the `t()` call site never matches `\btmpdir\b`. The same `\n`-exclusion class S33 fixed in `importSpecifiers`. **FIXED (S34 `37573cd`): bound `[^\n]*` → `[^;]*` (an import clause can span lines but never contains `;`); the guard now reads through the sanctioned `SourceView` — a NEW view `codeWithStringsAndTemplates()`, because `codeWithStrings()` would have gone silently blind to hardcoded `` `/tmp/…` `` template interiors (a shrink the agent refused). Class-swept: 26 + 33 candidate lines, no further import-scan member** |
| **U-39** | `importedNeighbours` (`module-load-order.test.ts:91`) | derives neighbours **only from `from "…"` clauses** | a side-effect `import "./x.ts"` or a dynamic import would not join the 21-entry population. None exist in the guarded subtrees today (positive witness: grep finds only comment text). **OPEN — latent, filed** |

## 2026-07-30 (S34 round — found and FILED, not fixed; each with its mechanism reason)

| # | declared | reached | how it stayed green |
|---|---|---|---|
| **U-40** | `token-prefix` value detector (`secret-signals.ts:74`) | **compiles without `i`** — an uppercase `SK_AAAA…` (20+ tail) VALUE carries no signal from that detector | the key-name gates now cover the common case, but the data classifier's VALUE channel doesn't; admission semantics reach the web config write gate, so it is an owner-vocabulary decision. **OPEN — filed (S34-01)** |
| **U-41** | the secret-shape catalog vs connection strings | **`postgres://user:password@host` matches NOTHING in `SECRET_TEXT_SIGNAL_CATALOG`** — no URL-userinfo detector exists | a `DATABASE_URL` VALUE has no shape signal at all, compounding U-37's name gap. **OPEN — filed (S34-02)** |
| **U-42** | `SENSITIVE_KEY_PATTERNS` (the `auth` word rule, now the `sk-` prefix) | **`classifyData` (`data-policy.ts:44`) consumes `normalizedKeyHasSensitivePart` ONLY** — the patterns never apply to the egress classifier's key gate | that path deliberately matches DECODED keys while the patterns are documented as needing the key "AS WRITTEN" — reconciling the two views is a semantics decision, not a one-liner. **FIXED (S36 `722fe2d`): the decode stays the classifier's duty, the owner is asked the WHOLE question on decoded AND raw spellings — and `normalizedKeyHasSensitivePart` is now MODULE-PRIVATE, so the narrower question cannot be asked from outside the owner. Probe folded into `S1-B05-CONTROL` (the spec's closed world is three scenario kinds — folded, not widened); mutation killed** |
| **U-43** | `neverPush.additiveRules[].pattern` (`git-adapter.ts:1012`, config:491) | **compiled `"u"` without `i`** in a security DENY gate: `\.(env\|key\|pem\|p12\|pfx\|keystore)$` misses `.PEM`/`.ENV` | one compilation site (not a U-36 member), but single-casing-adjacent; case-folding PATHS has its own false-positive surface, so the decision is filed rather than assumed. **OPEN — filed (S34-04). Also the next candidate for the one-interpreting-reader guard (T1-S34-W1)** |
| **U-44** | web `harnessOwnSecrets` (`server/config.ts:1112`) — env-credential discovery | **a FIFTH parts-only consumer** — driven: of `{SK_TEST, harmless_note, SECRET_THING}` only `SECRET_THING` is discovered as an own-credential | same class as U-42/U-37-residual; an env var named `SK_…` is invisible to the harness's own-secret discovery. **FIXED (S36 web `b32c2f9`): discovery asks `isSensitiveKeyName` on the AS-WRITTEN name and the local normalization re-spelling is deleted; first-ever direct test of the function, driven with a synthetic env, mutation killed — after the first fixture (`SK_LIVE_TOKEN`, whose `token` satisfied the parts half) SURVIVED the mutation and was replaced (`SK_LIVE_9Q7`)** |
| **U-45** | the one-interpreting-reader guard (S34's rung-5 backstop) | **matches `\bforbiddenLabelNames\b` in the `code()` view only** — driven: both `config.labelSchema["forbiddenLabelNames"]` and `"forbidden"+"LabelNames"` pass the guard GREEN | catches the natural identifier spelling, not a deliberately string-keyed reader. A limit of the rung, recorded; the T1-S34-W1 dynamic discoverer should close it for the class. **OPEN — filed (S34-check)** |
