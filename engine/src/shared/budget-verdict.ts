/**
 * The runtime budget's DECISION, as a pure function of a recorded summary.
 *
 * ── THE ONE OWNER FOR BOTH SUITES ────────────────────────────────────────
 *
 * This module is the runtime-budget verdict for BOTH repositories: the web-UI
 * suite consumes it through a re-exporting shim at the path where it used to
 * live (`web/tests/helpers/budget-verdict.ts`), and the integration suite's
 * runner (`scripts/run-tests.ts`) consumes it directly. It was hoisted here
 * because the two suites were growing two verdicts for one question — the
 * web side had CPU-based, population-anchored, sustained-condition judgment
 * while the integration side still judged a bare wall clock against an
 * absolute cap with three silent refusal-scored-as-pass paths. Two verdicts
 * drift; one owner cannot.
 *
 * PURITY IS THE CONTRACT: zero import statements, data in and a verdict out.
 * Persistence, config reading and measurement are the runner-bound halves and
 * live beside each runner (web: `tests/reporters/budget-reporter.ts` +
 * `tests/helpers/budget-history.ts`; integration: `scripts/run-tests.ts` +
 * `scripts/compile-cache.ts` + `src/workflow/test-result-collector.ts`).
 * That is what made the hoist a move rather than a rewrite, and it is what
 * keeps every branch here drivable with fabricated evidence.
 *
 * Split out of `tests/prevention/web-ui-runtime-budget.test.ts` for one
 * reason: a guard whose decision only runs against whatever last happened to
 * be on disk is a guard whose interesting branches are never exercised. The
 * refusal path in particular fires rarely by design, so it would sit untested
 * until the day it silently swallowed a real regression.
 * `web/tests/prevention/web-ui-runtime-budget-verdict.test.ts` drives every
 * branch of the summary judgment with fabricated summaries;
 * `test/prevention/suite-cpu-budget.test.ts` drives the suite-CPU door below.
 *
 * WHAT A REFUSAL MEANS. `unmeasurable` is not "skip because it is awkward". It
 * is DESIGN-PERFORMANCE L3 applied to a guard: a budget with no valid
 * measurement behind it must SAY it could not judge, naming what was missing,
 * rather than reporting a pass that reads as "the suite is fast". The refusal
 * causes are all about the evidence, never about the result:
 *
 *   - there is no summary, or it is corrupt / from an older reporter;
 *   - the recorded run did not cover the suite. This one is not theoretical:
 *     `npx vitest run <one-file>` invokes the same reporter and overwrote the
 *     summary with that file's duration. Proved directly — a summary reading
 *     `{"wallClockMs":174}` was then compared against a 35,000ms budget by the
 *     next FULL run and passed. The guard was disarmed by the most ordinary
 *     developer action there is, and nothing said so;
 *   - the run's CPU cost could not be read, so there is nothing to judge.
 *
 * **AND A REFUSAL IS NOW REPORTED AS A SKIP, NOT AS A PASS.** It used to
 * `return` out of the test body, which vitest scores as green — so the three
 * gates here reported exactly the same colour whether they had judged the
 * suite or had no evidence at all. A guard with no evidence is OFF, and the
 * run must say so in the one place everybody reads: the summary line.
 *
 * ── WHY THE SUITE BUDGET IS A CPU BUDGET, NOT A WALL CLOCK ───────────────
 *
 * The wall-clock gate here was the sole red in three consecutive steps while
 * finding no regression at all. Its cap (35,000 ms) had been measured against
 * a 433-file suite; the suite grew to 451 files and the cap did not move, so
 * it ended up inside the run-to-run noise band of a tree nobody had changed —
 * ten idle runs of one unchanged tree spanned 32.73–36.58 s. Its own failure
 * message says *"Fix the regression — do not raise the budget to meet it"*,
 * which is right, and which the gate itself made impossible to obey.
 *
 * **THE OBVIOUS REPAIR DOES NOT WORK, AND IT WAS MEASURED.** The gate already
 * printed `ambient load ${load1PerCpuAtStart}/cpu` in that message, so
 * dividing by it looks like the fix. But `loadavg()[0]` is a one-minute
 * exponentially decaying average sampled BEFORE the run starts, so right
 * after a previous suite run it mostly reports that run's ghost. Measured
 * here, same unchanged tree:
 *
 *     recorded load 0.598/cpu, idle box          → wall clock 35.6 s
 *     recorded load 0.678/cpu, 8 real burners    → wall clock 60.5 s
 *
 * Two nearly identical recorded loads, a 70% difference in outcome. Ambient
 * load as recorded cannot separate them — which is exactly why the historical
 * failures correlated with nothing.
 *
 * **Wall-clock occupancy per file does not work either**, and it is the
 * tempting one because the sibling per-file gate is built from it. Under
 * those same eight burners it moved **724 → 1240 ms/file (+71%)**, tracking
 * the wall clock almost exactly. Occupancy IS wall time; it inherits every
 * contention effect the wall clock has. A share of occupancy is invariant
 * because numerator and denominator inflate together — a TOTAL is not.
 *
 * **CPU time is the invariant — APPROXIMATELY, AND THE BOUND IS NOW
 * MEASURED.** Contention makes a runnable process wait for
 * a core; it does not make it execute more instructions — under MILD
 * contention. Measured on the same unchanged tree, idle versus eight burners
 * on twelve cores:
 *
 *     wall clock                35,304 →  61,144 ms   (+73.2%)
 *     wall-clock occupancy     325,892 → 562,633 ms   (+72.6%)
 *     CPU                      377,316 → 387,186 ms   ( +2.6%)
 *
 * But the +2.6% does NOT survive SATURATION, and pretending it did cost this
 * gate its credibility (the 2026-09-01 flag): five full runs of one unchanged
 * tree read 1667.3 → 2024.7 ms/file (+21%) while the recorded ambient load
 * climbed to 1.33/cpu (load average 18 at peak) — cache thrashing,
 * memory-bandwidth contention and scheduling pressure add real work to the
 * same instructions. So the suite budget bounds the WORK the suite asks of
 * the machine, per test file, and every reading is judged against a baseline
 * scaled by the EMPIRICAL AMBIENT-INFLATION ADJUSTMENT (see
 * `ambientInflationFraction`): sustained ambient load inflates the CPU figure
 * measurably, the adjustment expands the allowance by exactly the measured
 * envelope, and nothing anywhere waits for a quiet box. The wall clock stays
 * recorded and REPORTED — never judged. A real regression adds instructions
 * beyond the ambient-adjusted line and is caught at ANY ambient; a busy box
 * is adjusted for, never excluded. One judged run over the cap fails that run
 * (the 3-consecutive ratchet that once absorbed a box loading AFTER the run's
 * start-sample is deleted: UR-24-BUDGETS, round 12).
 *
 * ── AND THE BUDGET NAMES THE POPULATION IT BOUNDS ────────────────────────
 *
 * Per test file rather than per suite, because the defect that produced all
 * of this was a total measured against 433 files still being enforced against
 * 451. A per-file figure does not silently loosen when the suite grows. That
 * is necessary and not sufficient: the number is still a claim measured
 * against a particular tree, so the config states the population it was
 * derived against, and `judgePopulationDrift` fails when the tree has moved
 * far enough that the claim needs re-measuring. The budget cannot be written
 * down without its population — the config schema requires both fields.
 */

/**
 * Fraction of a full run's test files a summary must cover to be evidence.
 *
 * Not 1.0: a file can legitimately be skipped, and vitest's module count
 * moves by one or two as files are added within a session. 0.9 is far above
 * any such drift and far below any subset run a developer would type.
 */
export const MIN_COVERAGE_FRACTION = 0.9;

/**
 * The largest share of a run's WALL CLOCK a single file may spend outside its
 * tests.
 *
 * `collectDuration` is vitest's own "time to import the test module,
 * including executing suite callbacks" — and vitest orders files by their
 * TEST duration, so this cost is invisible to the sequencer. A file with a
 * large one gets scheduled by a number that excludes its actual cost and
 * lands anywhere, which is how `no-unused-exports.test.ts` (14ms of tests,
 * **15.41s of collect**) came to sit at the end of the run as a naked 15s
 * tail and made the suite's wall clock bimodal.
 *
 * ── WHY THIS IS A SHARE NOW, AND NOT 3,000 ms ─────────────────────────────
 *
 * It was `COLLECT_TAIL_BUDGET_MS = 3_000`, an absolute cap over a WALL-CLOCK
 * quantity — the same defect its own sibling gate in `web-ui-runtime-budget`
 * already carried a comment about. Two things move it, and they compound:
 *
 *   | condition            | worst collect | wall clock | share  |
 *   |----------------------|---------------|------------|--------|
 *   | warm, idle           |      1,372 ms |    38.2 s  | 0.0359 |
 *   | warm, idle           |      1,581 ms |    37.2 s  | 0.0425 |
 *   | warm, 8 CPU burners  |      2,532 ms |    58.3 s  | 0.0434 |
 *   | COLD, idle           |      4,828 ms |    42.0 s  | 0.1150 |
 *   | COLD, idle           |      4,421 ms |    44.4 s  | 0.0996 |
 *
 * Contention alone is +60% in milliseconds and **~2% as a share** — the share
 * is invariant to load by construction, because numerator and denominator move
 * together. That is S13's finding pointed at this gate. Cold is a different
 * animal: +205%, and still 2.7× as a share, because a cold cache is real
 * transform work rather than waiting for a core. **Normalisation does not fix
 * cold**, so cold is handled by declining to judge (see `moduleCacheEntries`),
 * not by a bigger number.
 *
 * 0.08 sits in the gap the measurements leave: 1.8× the worst warm reading and
 * BELOW the lowest cold one, so a cold run that somehow reached this gate reds
 * rather than passing quietly. The defect it exists to catch measured
 * 15.41 s over a 41.5 s run — a share of **0.371**, still 4.6× above the cap.
 *
 * POPULATION: the full web suite, 457 test files, on a 12-core box. Produced
 * by `npx vitest run` (warm) and `npx vitest --clearCache && npx vitest run`
 * (cold), reading `.bridlewise/web-test-results/latest-summary.json`.
 * It is a CEILING to lower, not a floor to defend.
 */
export const COLLECT_TAIL_SHARE_MAX = 0.08;

/**
 * How much of its final module cache a run may WRITE and still be judged.
 *
 * The population it bounds is this suite's own runs, and the two regimes are
 * far apart rather than adjacent: a warm run re-transforms only what changed —
 * a handful of entries against thousands — while a run after
 * `npx vitest --clearCache` builds essentially all of it. Half is chosen
 * because it sits in the empty middle of that gap and no run has ever landed
 * near it; it is not a tuned number and it must not become one. Tightening it
 * makes the gate refuse to judge more often, which is the safe direction;
 * loosening it lets a genuinely cold run be judged against a warm cap, which
 * is the red this whole arm exists to stop.
 *
 * ── THE NUMERATOR IS MTIME-BASED NOW, AND THE COUNT DELTA IT REPLACES IS
 *    THE HOLE IT CLOSES ─────────────────────────────────────────────────
 *
 * Warmth used to be judged from `(entriesAtEnd − entriesAtStart) / entriesAtEnd`
 * — a COUNT delta. A count delta cannot see a write that does not change the
 * count: a cache whose entries are REPLACED IN PLACE reads `1489 → 1489` and
 * "0.0 built" while every one of those files was transform work this run paid
 * for. That exact pair — 1489 → 1489, judged warm — is on the record of the
 * investigation that exonerated a suspected regression: the instrument could
 * not have told a rebuilt cache from an untouched one. So the reporter now
 * counts cache files whose mtime is AT OR AFTER the run's own start
 * (`moduleCacheEntriesWrittenDuringRun`), which is the transform work itself:
 * a full rebuild, a partial rebuild and an in-place replacement all surface,
 * because every one of them is a write and every write moves an mtime.
 *
 * The entry-count pair is still recorded — it is provenance, and its
 * disagreement with the mtime count is precisely the in-place-replacement
 * signature — but it decides nothing.
 *
 * ── THE MEASUREMENTS, AND THE GAP THE NUMBER SITS IN ─────────────────────
 *
 *   | regime                  | written fraction | worst collect share |
 *   |-------------------------|------------------|---------------------|
 *   | warm                    |      0.0000      |       0.0368        |
 *   | 45% of the cache deleted|      0.4478      |       0.0634        |
 *   | COLD (`--clearCache`)   |      0.9978      |       0.1073        |
 *
 * (Measured with the count method, which for pure-growth rebuilds — nothing
 * replaced, only added — is byte-for-byte the same quantity the mtime count
 * reads: every entry a growth rebuild writes is a new file.)
 *
 * The middle row is the load-bearing one: a run that rebuilt nearly half its
 * cache still produced a collect share of 0.0634, comfortably under
 * `COLLECT_TAIL_SHARE_MAX` — so it must still be JUDGED, and the constant must
 * therefore sit strictly ABOVE 0.4478. The cold row must be REFUSED, so the
 * constant must sit strictly BELOW 0.9978. Both ends are asserted in
 * `web-ui-runtime-budget.test.ts`; before that, this constant was bounded by
 * nothing and 0.999 (never refuse) or 0.001 (always refuse) were both silent.
 *
 * POPULATION: the full web suite, 458 modules, on a 12-core box. Produced by
 * `npx vitest run` (warm) and `npx vitest --clearCache && npx vitest run`
 * (cold), reading `.bridlewise/web-test-results/latest-summary.json`.
 *
 * ── DENY BY DEFAULT ──────────────────────────────────────────────────────
 *
 * A summary that shows a populated cache but carries NO mtime reading is
 * REFUSED, not judged: a reporter that computed the measurement and dropped
 * it (the wired-but-inert shape) must not be able to produce a judged pass,
 * and neither may a summary written by a reporter that predates the field.
 */
export const COLD_MODULE_CACHE_FRACTION = 0.5;

/**
 * THE EMPIRICAL AMBIENT-INFLATION ADJUSTMENT — how much of a run's recorded
 * CPU cost the box's sustained ambient load explains, as a fraction of the
 * baseline. Declared in the config (slope + cap) beside the budget it
 * modifies; derived from the ledger's own recorded pairs, never fitted by
 * taste.
 *
 * ── WHY THE 5-MINUTE LEG, AND NOT THE 1-MINUTE LEG THE THRESHOLD USED ─────
 *
 * The 1-minute leg is sampled BEFORE the run starts and decays within
 * minutes, so it measures the minute BEFORE launch, not the run: a prior
 * suite's load reads high on an idle box (the ghost — the 2026-09-04
 * 04:11-04:15 cohort recorded 1.32-1.94/cpu while reading the quiet center,
 * 1595-1605 ms/file), and load that arrives after the sample reads low on
 * a busy one. Regressing the ledger's own 55 recorded rows of
 * cpuMsPerTestFile against the 1-minute leg gives r = 0.172 — no
 * relationship. The whole 1736-1936 inflation cohort of that day sat at
 * recorded-QUIET 1-minute ambients (0.069-0.148/cpu). A covariate that
 * blind cannot adjust anything.
 *
 * The 5-minute leg is the one the ghost cannot inflate: one 80s suite at
 * load ~10 on 12 cores leaves the 5-minute average at ~0.2/cpu, so a
 * back-to-back cadence — the ordinary shape of a budget-watch round —
 * records at most ~0.3-0.35/cpu while the box is actually quiet. Real
 * sustained load (the acceptance hogs, stacked gates, a busy afternoon)
 * sits on the 5-minute leg honestly. The 2026-09-04 12:18-12:23 cohort —
 * four runs recorded at amb5 0.557-1.263 — is the calibration pair set:
 * against their quiet same-sha neighbour (1661.5) they read +2.0% to
 * +5.5% CPU, monotonically ordered by nothing but noisy in aggregate, mean
 * ≈ +3.9%. The sibling measurement (eight burners on twelve cores, the
 * whole run, 2026-09-03) read +2.6% CPU at a 1-minute ambient of ~0.67/cpu
 * — the 5-minute leg of a burner pair that has run long enough to register
 * lands at the same figure. The slope 0.05/cpu is the envelope through the
 * reliable pairs: it covers the burner anchor (+2.6% at amb5 ≈ 0.5-0.67,
 * allowance +2.5-3.4%) and the cohort's worst pair (+5.5% at amb5 1.092,
 * allowance +5.5%) with margin, and it covers nothing the record does not
 * show. A busy row feeds the rolling window at its ADJUSTED reading
 * (raw / (1 + adjustment)), so the window stays a quiet-equivalent centre
 * — the 12:18-12:23 cohort's adjusted readings (1594-1703) land inside the
 * quiet band (1550-1660) the same day recorded.
 *
 * ── THE CAP, AND THE RESIDUAL IT DELIBERATELY LEAVES OUT ────────────────
 *
 * The cap 0.12 bounds the adjustment: the gate may never loosen by more
 * than 12% for ambient reasons. It is anchored on the 2026-09-03
 * stacked-saturation measurement (eight stacked saturations took a
 * byte-unchanged tree 1509.1 → 1625.6, +7.7%, at sustained 5-minute
 * ambients around 1.0-1.5/cpu) plus the same-tree spread that rides on
 * top: everything the reliable record shows at ANY sustained ambient
 * (7.7% + 2.6% = 10.3%) sits inside the capped line (12% + 2.6% =
 * 14.9%). The 2026-09-01 incident (+21% CPU on an unchanged tree at
 * recorded 1-minute ambients 0.88-1.66/cpu, load average 18 at peak) is
 * deliberately BEYOND the envelope: covering it would require an allowance
 * 4× the reliable cohort's worst realized inflation at the same recorded
 * ambient, emptying the teeth exactly where stacked gates make regressions
 * likely. Such a reading FAILS its run, printed with its ambient and the
 * capped arithmetic — the gate refusing to loosen itself into blindness is
 * the honest verdict at an ambient its measured envelope cannot speak to. The teeth scale
 * with ambient and hold at every one: a regression beyond the
 * ambient-adjusted line fails at ANY ambient, which is what the
 * under-load acceptance arms pin.
 *
 * ── NO READING IS EVER EXCLUDED FOR BUSYNESS ────────────────────────────
 *
 * This mechanism REPLACES the quiet-ambient deferral the threshold used to
 * carry (a would-be red recorded at a busy ambient printed PROVISIONAL —
 * re-run when the box is quiet — failing nothing and counting toward no
 * streak). That design demanded a quiet box this machine does not have:
 * rounds stalled waiting for an ambient that never arrives, and a red
 * deferred is a red not delivered. Ambient is now a recorded covariate
 * every verdict consumes, never a gate: a clean run at a busy ambient
 * judges CLEAN (the adjustment does its work), a regressed run at a busy
 * ambient judges REGRESSED (the teeth hold under load), and both
 * arithmetic on the gate line.
 *
 * ABSENCE, NEVER ZERO-AND-NOT-AN-ADJUSTMENT: a row with no recorded 5-minute
 * leg (a legacy entry, an unreadable loadavg) takes NO adjustment — the
 * lean every marker in the ledger takes, and the safe one here, because a
 * missing covariate must never loosen a line. A negative or non-finite
 * reading adjusts nothing either.
 */
export interface AmbientInflationDeclaration {
  /**
   * CPU inflation per unit of recorded 5-minute ambient load per CPU — the
   * measured envelope through the reliable pairs (see the block above for
   * the derivation). 0.05/cpu: +2.5% at amb5 0.5, +5% at amb5 1.0.
   */
  readonly ambientInflationSlopePerCpu: number;
  /**
   * The bound on the whole adjustment, as a fraction of the baseline. The
   * gate never loosens by more than this for ambient reasons, so the teeth
   * hold at every ambient.
   */
  readonly ambientInflationCapFraction: number;
}

/**
 * THE AMBIENT ALLOWANCE, SAID NUMERICALLY IN EVERY VERDICT. The user removed
 * it on 2026-10-07 (UD-AUDIT-NO-FORGIVENESS); it is still applied here until
 * AMBIENT-ALLOWANCE-REMOVE lands (the web writer's first item after the
 * engine merge, D-17, UR-24-BUDGETS). Until then every verdict says the
 * allowance in force and what it added, so no pass reads as a strict one.
 */
function ambientAllowanceStatement(budget: AmbientInflationDeclaration, inflation: number): string {
  return ` [ambient allowance in force until AMBIENT-ALLOWANCE-REMOVE: +${(budget.ambientInflationSlopePerCpu * 100).toFixed(1)}% per unit of 5-minute load per CPU, ` +
    `capped at +${(budget.ambientInflationCapFraction * 100).toFixed(1)}%; this verdict: +${(inflation * 100).toFixed(1)}%]`;
}

/**
 * The ambient-inflation adjustment for one recorded 5-minute ambient load
 * per CPU: `min(cap, slope × ambient)`, and 0 for an absent, negative or
 * non-finite reading. Pure, total, and the ONE spelling — the one-run cap,
 * the rolling feed filter, the gate messages and the disclosures all call
 * this, so the arithmetic cannot drift between the places a reading is
 * judged.
 */
export function ambientInflationFraction(
  ambientLoad5PerCpu: number | null | undefined,
  declaration: Readonly<Pick<AmbientInflationDeclaration, "ambientInflationSlopePerCpu" | "ambientInflationCapFraction">>,
): number {
  if (
    typeof ambientLoad5PerCpu !== "number" ||
    !Number.isFinite(ambientLoad5PerCpu) ||
    ambientLoad5PerCpu <= 0
  ) {
    return 0;
  }
  return Math.min(
    declaration.ambientInflationCapFraction,
    ambientLoad5PerCpu * declaration.ambientInflationSlopePerCpu,
  );
}

export interface CollectCost {
  readonly file: string;
  readonly ms: number;
}

export type BudgetVerdict =
  | { readonly kind: "unmeasurable"; readonly why: string }
  | {
      readonly kind: "measured";
      /** Recorded and REPORTED so a real regression stays visible. Not judged
       *  — see the header for the measurements that rule it out as a gate. */
      readonly wallClockMs: number;
      /** The run's CPU cost: the reporter's process plus every reaped pool
       *  worker. This is what the suite budget judges. */
      readonly runCpuMs: number;
      /** `runCpuMs / testModuleCount` — the figure the budget bounds. */
      readonly cpuMsPerTestFile: number;
      readonly testModuleCount: number;
      readonly slowestCollects: readonly CollectCost[];
      /** Every file's `collectDuration` summed — reported for diagnosis. */
      readonly totalCollectMs: number;
      /**
       * `slowestCollects[0].ms / wallClockMs` — the figure the collect gate
       * bounds, and the reason it survives a busy machine.
       */
      readonly worstCollectShare: number;
      /** Worst TOTAL per-file occupancy (collect + setup + env + tests). */
      readonly slowestFiles: readonly CollectCost[];
      /** Every file's occupancy summed, or 0 when the reporter predates it. */
      readonly totalOccupancyMs: number;
      readonly load1PerCpuAtStart: number;
      /**
       * The run-start loadavg snapshot's longer legs, per CPU — the
       * 15-minute ghost's witnesses. Same `-1` unreadable sentinel as the
       * 1-minute leg.
       */
      readonly load5PerCpuAtStart: number;
      readonly load15PerCpuAtStart: number;
      /**
       * When the judged run FINISHED, ISO-8601, or null when absent.
       *
       * Carried so the failure message can name WHICH run it is judging. The
       * one-run lag is unavoidable — a test inside a run cannot read that
       * run's own total — and it cost real diagnosis time when a transient
       * spike reddened the next, otherwise-clean run. It cannot be removed,
       * so it is stated: every message names the run and its age.
       */
      readonly summaryTimestamp: string | null;
    };

export interface JudgeOptions {
  /** Test files a full run covers, discovered from the config's own globs. */
  readonly fullRunModuleCount: number;
}

/**
 * A finite number, or null — the one reader every piece of budget evidence
 * comes through. Exported because the run-history ledger parses its records
 * with exactly this rule, and two spellings of "is this reading a number"
 * would eventually disagree about what enters a verdict.
 */
export function finiteNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function collectCosts(v: unknown): CollectCost[] {
  if (!Array.isArray(v)) return [];
  const out: CollectCost[] = [];
  for (const entry of v as unknown[]) {
    if (typeof entry !== "object" || entry === null) continue;
    const rec = entry as { file?: unknown; ms?: unknown };
    const ms = finiteNumber(rec.ms);
    if (ms === null || typeof rec.file !== "string") continue;
    out.push({ file: rec.file, ms });
  }
  return out.sort((a, b) => b.ms - a.ms);
}

/**
 * Decide what the recorded summary supports. Never throws: a malformed
 * summary is a refusal, not a crash, because a reporter writing garbage must
 * not be able to fail the suite it was measuring.
 */
export function judgeRuntimeBudget(summary: unknown, opts: JudgeOptions): BudgetVerdict {
  if (typeof summary !== "object" || summary === null) {
    return { kind: "unmeasurable", why: "no budget summary on disk yet (first run)" };
  }
  const rec = summary as Record<string, unknown>;

  const wallClockMs = finiteNumber(rec.wallClockMs);
  if (wallClockMs === null) {
    return { kind: "unmeasurable", why: "the summary carries no finite wallClockMs" };
  }

  const testModuleCount = finiteNumber(rec.testModuleCount);
  if (testModuleCount === null) {
    // Written by a reporter that predates the coverage field. Refusing for
    // one run is right: believing it is what let a 174ms subset run pass.
    return {
      kind: "unmeasurable",
      why: "the summary predates testModuleCount — it cannot say what it timed",
    };
  }

  const floor = opts.fullRunModuleCount * MIN_COVERAGE_FRACTION;
  if (testModuleCount < floor) {
    return {
      kind: "unmeasurable",
      why:
        `the recorded run covered ${String(testModuleCount)} test files, not the ` +
        `${String(opts.fullRunModuleCount)} a full run covers — a subset run is not ` +
        `evidence about the suite's runtime. Run the whole suite to re-arm this budget.`,
    };
  }

  // A zero module count would divide the CPU cost by nothing. It cannot reach
  // here (the coverage floor is derived from a count the caller asserts is
  // above 300), but the budget is judged on this quotient and a guard must not
  // be one refactor away from producing Infinity.
  if (testModuleCount <= 0) {
    return {
      kind: "unmeasurable",
      why: "the summary reports zero test modules — there is no population to divide by",
    };
  }

  // ABSENCE, NEVER ZERO. A summary from a reporter that could not read the
  // run's CPU (or from one written before it did) has no cost evidence in it,
  // and a zero would read as "the suite did no work" — the most permissive
  // possible answer, arriving from a missing field.
  const runCpuMs = finiteNumber(rec.runCpuMs);
  if (runCpuMs === null || runCpuMs <= 0) {
    return {
      kind: "unmeasurable",
      why:
        "the summary carries no positive runCpuMs — the run's CPU cost is what this " +
        "budget bounds, and it was not recorded. One full run re-arms it.",
    };
  }

  // A COLD MODULE CACHE IS NOT A MEASUREMENT OF THIS TREE, and this arm is
  // why the gate no longer punishes correct work.
  //
  // `npx vitest --clearCache` is MANDATORY after any edit in the sibling
  // repository — without it the suite happily validates a stale copy of the
  // backend. The very next run therefore transforms everything from scratch,
  // and the run AFTER that judges it, because a test inside a run cannot read
  // its own totals. So one guard's required remedy reliably reddened another,
  // four times, until the trigger was named.
  //
  // The honest answer is the verdict this type already had: say it cannot be
  // measured, and say why. Raising the cap would have been the cheap repair
  // the old message invited, and would have vacated the gate for warm runs too.
  //
  // ── HOW COLDNESS IS ASKED — TRANSFORM WORK, MEASURED DIRECTLY ────────────
  //
  // Two spellings of this question have already died, each by not measuring
  // the thing itself. `moduleCacheEntriesAtStart === 0` could never fire: a
  // reporter's `onInit` runs after vitest has transformed its own config
  // graph, so a genuinely absent cache still recorded 4 entries. Its
  // replacement, the count delta `(end − start) / end`, could not see a write
  // that does not change the count: a cache REPLACED IN PLACE reads
  // `1489 → 1489` and "warm" while every entry was rewritten during the run —
  // the pair that sat on the record while a regression hunt exonerated the
  // tree and indicted the instrument.
  //
  // So the reporter now counts the cache files whose mtime is at or after the
  // run's own start. That IS the transform work: every rebuild, partial
  // rebuild or in-place replacement is a write, and every write moves an
  // mtime. The count pair stays recorded as provenance; it decides nothing.
  const cacheAtStart = finiteNumber(rec.moduleCacheEntriesAtStart);
  const cacheAtEnd = finiteNumber(rec.moduleCacheEntriesAtEnd);
  const writtenDuringRun = finiteNumber(rec.moduleCacheEntriesWrittenDuringRun);
  // ABSENCE IS NOT WARMTH. A start reading of `null` means the reporter could
  // not read the cache directory at all — and the commonest way to reach that
  // state is the one that matters: the directory did not exist yet, because
  // the run was about to build it from nothing. Pairing a missing start with a
  // populated end and then declining to refuse is the permissive direction
  // arriving from a missing field, which is the shape of every gate in this
  // tree that has gone quiet.
  if (cacheAtStart === null && cacheAtEnd !== null && cacheAtEnd > 0) {
    return {
      kind: "unmeasurable",
      why:
        `the module cache could not be read when the run STARTED but held ${String(cacheAtEnd)} ` +
        `entries when it finished. That pair cannot say the run was warm, and a run that built ` +
        `its cache is transform work rather than this tree's shape. Run the suite once more ` +
        `against the same cache to re-arm this gate.`,
    };
  }
  if (cacheAtEnd !== null && cacheAtEnd > 0) {
    // LIVENESS ON THE END READING, floored by the run's own population. If
    // that reading were ever moved to `onInit` too, start and end would agree
    // and every run would look warm — the arm dying silently a second time. A
    // finished run has transformed at least one module per test file, so
    // anything less is a broken reading, not a warm cache.
    if (cacheAtEnd < testModuleCount) {
      return {
        kind: "unmeasurable",
        why:
          `the module cache held ${String(cacheAtEnd)} entries at the END of a run over ` +
          `${String(testModuleCount)} test files. A finished run has transformed at least one ` +
          `module per file, so this reading was taken before the run did its work and cannot ` +
          `say whether the cache was cold.`,
      };
    }
    // DENY BY DEFAULT: a populated cache with no mtime reading beside it is a
    // summary that cannot prove the run was warm — either the reporter
    // predates the measurement or it computed the measurement and dropped it
    // (the wired-but-inert shape). Neither may produce a judged pass.
    if (writtenDuringRun === null) {
      return {
        kind: "unmeasurable",
        why:
          `the summary shows a module cache of ${String(cacheAtEnd)} entries but carries no ` +
          `moduleCacheEntriesWrittenDuringRun reading, so it cannot say how much of that ` +
          `cache was transform work this run paid for. An entry COUNT cannot answer this — ` +
          `a cache replaced in place reads the same count while every file was rewritten. ` +
          `Run the suite once with the current reporter to re-arm this gate.`,
      };
    }
    // THE COUNT MUST CARRY ITS WITNESS. A written count of 0 is the most
    // permissive possible reading, and it is exactly what an instrument that
    // computed the walk and DISCARDED its result would report — the inert
    // shape, proven reachable here: a mutant returning 0 from the mtime walk
    // let a fully cold run be judged into the ledger while every guard stayed
    // green. So the reporter records, from the SAME walk, the newest entry
    // mtime it observed and the run-start reference it compared against, and
    // the verdict refuses a count that has no witness beside it. An absence
    // assertion needs a witness, or it proves nothing.
    const newestEntryMtimeMs = finiteNumber(rec.moduleCacheNewestEntryMtimeMs);
    const runStartedAtMs = finiteNumber(rec.runStartedAtMs);
    if (newestEntryMtimeMs === null || runStartedAtMs === null) {
      return {
        kind: "unmeasurable",
        why:
          `the summary carries a moduleCacheEntriesWrittenDuringRun reading over a cache of ` +
          `${String(cacheAtEnd)} entries but no newest-entry-mtime sample and run-start ` +
          `reference beside it (moduleCacheNewestEntryMtimeMs / runStartedAtMs), so the walk ` +
          `that produced the count cannot be shown to have happened. A count without its ` +
          `witness cannot prove the run was warm. Run the suite once with the current ` +
          `reporter to re-arm this gate.`,
      };
    }
    if (writtenDuringRun === 0 && newestEntryMtimeMs >= runStartedAtMs) {
      return {
        kind: "unmeasurable",
        why:
          `the summary claims ZERO cache entries were written during the run, yet the newest ` +
          `entry in that cache carries an mtime at or after the run's own start ` +
          `(${String(newestEntryMtimeMs)} >= ${String(runStartedAtMs)}). Those two readings ` +
          `come from the same walk and contradict each other: either the count was computed ` +
          `and discarded (the wired-but-inert shape) or the walk read a different directory ` +
          `than the one being written. A contradiction is not warmth. Run the suite once ` +
          `more to re-arm this gate.`,
      };
    }
    const writtenFraction = writtenDuringRun / cacheAtEnd;
    if (writtenFraction >= COLD_MODULE_CACHE_FRACTION) {
      return {
        kind: "unmeasurable",
        why:
          `the judged run WROTE ${(writtenFraction * 100).toFixed(1)}% of the module cache it ` +
          `finished with (${String(writtenDuringRun)} of ${String(cacheAtEnd)} entries carry ` +
          `an mtime at or after the run's start; the entry count read ` +
          `${String(cacheAtStart)} → ${String(cacheAtEnd)}), so every file's collect time is ` +
          `transform work rather than this tree's shape (measured: ~2.7× the warm share). A ` +
          `count that did not move beside a written fraction this high is a cache REPLACED IN ` +
          `PLACE — the same transform cost wearing a warm-looking count. Run the suite once ` +
          `more to re-arm this gate.`,
      };
    }
  }

  const slowestCollects = collectCosts(rec.slowestCollects);
  const worstCollectMs = slowestCollects[0]?.ms ?? 0;

  return {
    kind: "measured",
    wallClockMs,
    runCpuMs,
    cpuMsPerTestFile: runCpuMs / testModuleCount,
    testModuleCount,
    slowestCollects,
    totalCollectMs: finiteNumber(rec.totalCollectMs) ?? 0,
    // Wall clock is the denominator rather than total collect: the question is
    // "can the sequencer hide this file's cost inside the run", and the run's
    // length is what decides whether a tail is absorbed or exposed.
    worstCollectShare: wallClockMs > 0 ? worstCollectMs / wallClockMs : 0,
    slowestFiles: collectCosts(rec.slowestFiles),
    totalOccupancyMs: finiteNumber(rec.totalOccupancyMs) ?? 0,
    load1PerCpuAtStart: finiteNumber(rec.load1PerCpuAtStart) ?? -1,
    load5PerCpuAtStart: finiteNumber(rec.load5PerCpuAtStart) ?? -1,
    load15PerCpuAtStart: finiteNumber(rec.load15PerCpuAtStart) ?? -1,
    summaryTimestamp: typeof rec.timestamp === "string" ? rec.timestamp : null,
  };
}

/** A configured number, or the plain-words reason it could not be read. */
export type Missing = { readonly missing: string };

/**
 * One JUDGED run, as the ledger remembers it.
 *
 * Only runs the verdict MEASURED enter this record — a refused run (subset,
 * cold cache, missing CPU) proved nothing about the tree, so it must never
 * feed the rolling baseline. The values are kept
 * raw rather than pre-classified, so a change to the declared budget
 * re-evaluates the whole window under the new declaration instead of trusting
 * verdicts a different budget produced.
 */
/** Current-invocation evidence. Historical numeric/test rows may predate it. */
export type RunQualificationTerminal = Readonly<{
  invocationId: string;
  treeId: string;
  ending: "exited" | "stalled" | "ceiling" | "stopped" | "signal" | "unverified" | "launcher-exited";
  exitCode: number;
  status: number | null;
  signal: string | null;
  outputComplete: boolean;
  receiptPresent: boolean;
  noOwnedChildren: boolean;
  timedOut: boolean;
  interrupted: boolean;
  commandKilled: boolean;
  killedDescendants: number;
  orphanedGroupKilled: boolean;
}>;

export type RunQualification = Readonly<{
  schemaVersion: 1;
  invocationId: string;
  treeId: string;
  producer: "web" | "engine";
  /** Every expected terminal result channel was read; false is incomplete. */
  producerComplete: boolean;
  outcomes: readonly GateOutcome[];
  /** Added by the wrapper only after actual supervised completion/cleanup. */
  terminal?: RunQualificationTerminal;
}>;

export type JudgedRunRecord = {
  readonly qualification?: RunQualification;
  readonly timestamp: string | null;
  readonly cpuMsPerTestFile: number;
  readonly testModuleCount: number;
  /**
   * TREE IDENTITY — the repository's own HEAD commit when the run was
   * measured. Optional because the ledger predates it: entries written
   * before this field exist and stay valid; entries written after carry it.
   * It exists because the accumulation ledger was measured CROSS-CONDITION
   * (a solo idle run and a busy-day run over the same 407 files landed
   * 1287.6 vs ~2060 ms/file, same day) and cross-COMMIT (five samples over
   * four commits) — a spread derived from such a ledger encodes the
   * confound, not the tree. A cap may only ever be derived from samples
   * sharing one `headSha` under comparable conditions.
   */
  readonly headSha?: string;
  /**
   * THE TREE THE RUN MEASURED — the id of the tree `git add -A` would have
   * committed in the checkout the run was taken in (`workingTreeId`,
   * src/git/working-copy.ts, through `measuredTreeMark` in tree-identity.ts):
   * HEAD's tree for a clean checkout, the dirty tree's own id otherwise. A
   * commit whose tree is this id is the tree this run qualified, wherever the
   * run was taken (a candidate, a workspace) — the like-for-like key a
   * baseline is found by. Read at the start and at the end of the run and
   * recorded only when the two agree. Optional: rows written before it, runs
   * whose tree could not be read and runs whose tree changed while they ran
   * carry none and cannot serve as exact-tree test references. `headSha`
   * remains provenance for numeric calibration, never a substitute tree key.
   */
  readonly treeId?: string;
  /**
   * CONDITION AT MEASUREMENT — `loadavg()[0] / cpuCount` sampled at run
   * start. Pure provenance now: the 1-minute decaying average is blind to
   * the run's own conditions (regressing the ledger's own 55 recorded rows
   * against it gives r = 0.172 — the whole 2026-09-04 inflation cohort sat
   * at recorded-quiet 1-minute ambients), so NO consumer judges by it. It
   * is recorded because a number without its machine conditions is not
   * evidence, and because a reader of the row can see the launch-minute
   * context beside the leg that actually adjusts.
   */
  readonly ambientLoadPerCpu?: number;
  /**
   * THE PRE-LAUNCH SNAPSHOT'S LONGER LEGS — the 5- and 15-minute averages
   * from the SAME run-start `loadavg()` read, per CPU. The 5-MINUTE leg is
   * the covariate the ambient-inflation adjustment consumes
   * (`ambientInflationFraction`): it is the leg a single prior suite's
   * ghost cannot inflate (one 80s suite leaves it at ~0.2/cpu while the
   * 1-minute leg reads 0.8-1.9), so a recorded amb5 is sustained load,
   * not the previous run's echo. The 15-minute leg stays recorded as the
   * long-context witness. Optional for the same reason every identity
   * field is: entries written before the fields exist stay valid (and take
   * no adjustment — absence never loosens a line), and an unreadable
   * reading is absent, never a fabricated zero.
   */
  readonly ambientLoad5PerCpu?: number;
  readonly ambientLoad15PerCpu?: number;
  /**
   * The run's WALL CLOCK and POOL OCCUPANCY, recorded so a future
   * calibration can separate cohorts the ambient legs cannot: the pair
   * 2026-09-04 measured (1559.2 vs 1669.7 ms/file) shows
   * occupancy/CPU ≈ 0.99 in BOTH — the round-68 anomaly burned 7% more
   * CPU at full parallelism with no wait signature, which no recorded
   * covariate separates, so the fields ride the row for the day a
   * during-run contention index is calibrated from them. Optional: rows
   * that predate the fields stay valid, and the verdict consumes neither
   * today.
   */
  readonly wallClockMs?: number;
  readonly totalOccupancyMs?: number;
  /**
   * The web-UI performance budgets' measurements of the profile the run
   * judged (`webPerformanceBudgets.ledgerField`): each budget's value, null
   * when the profile did not measure it. Absent when no profile was judged.
   * The workspace's ledger judge reads a breach's value and the target's
   * slotted ones from here (the ONE budget judgement).
   */
  readonly performanceMeasurements?: Readonly<Record<string, number | null>>;
  /**
   * The run's own recorded FAILURE ROWS (its failing tests' identities) —
   * parsed from the ledger row so the rolling baseline's feed filter can
   * refuse a row whose failures carry the budget gate's own face: such a
   * run's budget state was not trustworthy, so its reading must not move
   * the baseline (the self-normalizing loop). Optional for the same reason
   * every identity field is: entries written before failure recording stay
   * valid, and a row that recorded no failures is a clean-reading run
   * whose cost is still its cost.
   */
  readonly failures?: readonly string[];
  /**
   * WHAT EACH FAILURE SAID — identity → a digest of its normalized first
   * error ({@link failureDigest}, run-history.ts), so a comparison can tell
   * a persisting identity that now fails DIFFERENTLY (a guard that went red
   * for one offender and now has three: sec-e-correctness M-2) from one that
   * fails the same way. Optional: rows written before it, and failures whose
   * error the runner could not read, carry no digest (never compared).
   */
  readonly failureDigests?: Readonly<Record<string, string>>;
  /**
   * Where each failure happened (identity → `failureLocation`, run-history.ts:
   * the assertion's operator and the names of its test file's own frames):
   * compared beside the digest, where both runs recorded it (design NH-D).
   */
  readonly failureLocations?: Readonly<Record<string, string>>;
  /** The checkout whose run this row is, when it was imported from a candidate (`importJudgedRuns`). */
  readonly importedFrom?: string;
  /**
   * Whether the measurement held the host's one instrument lock (src/process/instrument-lock.ts).
   * Absent on rows recorded before the slot existed; an `unslotted` row never
   * feeds a budget's baseline.
   */
  readonly heavySlot?: "held" | "unslotted";
  /** True when the run measured a tracked-dirty (mid-edit) tree. */
  readonly provisionalFailures?: boolean;
  /**
   * True when the run was launched as a DELIBERATE MUTATION-VERIFICATION
   * run (the operator planted a defect, ran the suite to watch it red,
   * restored). Its reading measured a deliberately-wrong tree, so the
   * rolling baseline never feeds from it. Strictly-true only: an unmarked
   * row counts as an ordinary run — the lean every marker in the ledger
   * takes — and the harm direction is blocked anyway, because a mutation
   * run that reads high lands beyond the allowance and never feeds.
   */
  readonly mutation?: boolean;
};

export interface RunCostInputs {
  readonly cpuBudget: RollingCpuBudget | Missing;
  readonly fileShareMax: number | Missing;
  /** Previously JUDGED full runs, oldest first (append order). */
  readonly priorRuns: readonly JudgedRunRecord[];
  /**
   * Which suite the verdict is about, in the failure prose ("web-UI",
   * "integration"). Required, not defaulted: this module serves two suites,
   * and a message that names the wrong one sends the reader to the wrong
   * repository.
   */
  readonly suiteLabel: string;
  /**
   * The ledger identities of the budget gate's OWN faces — a row whose
   * recorded failures include one of these ran under a budget state the
   * verdict could not trust, so its reading must never move the baseline
   * (the self-normalizing loop: a bad run raising the bar for future bad
   * runs). Required, not defaulted: an empty default would silently include
   * exactly the rows this filter exists to refuse, and the two suites spell
   * their budget doors differently, so the shared derivation must not
   * hardcode either.
   */
  readonly budgetFailureIdentities: readonly string[];
}

/**
 * ── THE ROLLING BASELINE: THE CAP DERIVED FROM THE LEDGER'S OWN HISTORY ──
 *
 * The hand-re-derivation treadmill this replaces is on the record: a
 * static, hand-derived cap that the suite's measured per-file cost kept
 * approaching as the surface grew — re-derived by a full round of measured
 * runs + derivation + mirror updates in 2026-09-02/03 (1552 → 1564), again
 * in 2026-09-04 (1564 → 1615), and due again at round 70 (the round-69
 * triple-check read 1614.7 against the 1615.0 cap — the margin zero). Each
 * re-derivation was honest, and each was maintenance the machinery can do
 * itself: the ledger ALREADY records every judged run's cpuMsPerTestFile,
 * its population, its ambient condition and its tree identity.
 *
 * THE MECHANISM: the cap is the declared FLOOR. A judged run feeds the
 * rolling window only when its own CPU outcome passed — its reading at or
 * below the cap in force at its moment (ambient-adjusted at its own recorded
 * 5-minute leg while the allowance stands, AMBIENT-ALLOWANCE-REMOVE), over the
 * same population, not a deliberate mutation run, not a row carrying the
 * budget gate's own failure — so the window's median never rises above the
 * floor and the baseline IS the floor. GROWTH IS NOT ABSORBED: a suite that
 * grew (or got slower) fails the cap, and the floor moves only through its
 * measuring tool, with the derivation recorded beside the declaration
 * (`npm run budget:measure`, D-17).
 *
 * WHAT THE WINDOW STILL DOES: it is the stale-floor disclosure's sample.
 * When the clean median sits more than the same-tree spread BELOW the floor,
 * the gate is looser than the tree it bounds: the baseline line SAYS SO on
 * every run (`floorStaleBeyondSpread`) and demands the floor's re-derivation.
 * A regression never feeds (a run over the cap fails and is not clean), so
 * the window can never carry the cap upward: the climb that seven failing
 * runs once made is gone (design HIGH 1).
 *
 * THE COLD START: an empty ledger has no clean runs, so the recorded floor
 * IS the initial baseline — the seed is the last measured derivation of
 * the quiet center (the 1614 of 2026-09-04). The first runs after a floor
 * change bootstrap the same way: the floor holds the baseline until the
 * window fills with clean readings under the new declaration.
 *
 * WHAT STAYS DECLARED, AND WHY EACH IS A NUMBER THE OPERATOR OWNS: the
 * floor (the cap), the window K (12 — the stale-floor disclosure's sample,
 * the same sample size the measuring tool derives the floor from), the drift
 * fraction, the spread (the same-tree noise: how far below the floor the
 * clean median may sit before the floor is reported stale, and the measuring
 * tool's outlier line — never a verdict's allowance), and the
 * ambient-inflation envelope (slope + cap — the measured CPU inflation of
 * sustained ambient load, and the bound that keeps the teeth at every
 * ambient). The population drift guard is untouched: it still refuses past
 * 3% population movement and still demands the re-derivation ritual at the
 * population marks — but the ritual is now cheap, because the evidence it
 * needs is already recorded in the ledger.
 */
export interface RollingCpuBudget {
  /**
   * The recorded floor: the baseline is never derived below this number
   * without an explicit, measured re-derivation recorded beside the
   * declaration. Seeded from the last hand derivation of the quiet center
   * (1615, derived 2026-09-04: median 1610.0 plus the measured quiet
   * excursion 4.6 over four settled-launch same-sha quiet judged runs).
   */
  readonly baselineFloorMsPerTestFile: number;
  readonly derivedAtTestFileCount: number;
  readonly maxPopulationDriftFraction: number;
  /**
   * The boundary a ledger reading must sit at or under (relative to the
   * baseline in force at its moment) to count toward the rolling window and
   * the measuring tool's window (D-17). It never widens a verdict: one judged
   * run over the cap fails. Derivation lives with the declaration in the
   * config schema.
   */
  readonly sameTreeSpreadFraction: number;
  /**
   * The window K: how many recent CLEAN judged runs (each one passed its own
   * cap) the stale-floor disclosure's median is computed over; the same K the
   * measuring tool derives the floor from. The baseline itself is the floor.
   */
  readonly baselineWindowRuns: number;
  /**
   * The ambient-inflation envelope the gate and the feed both consume —
   * the recorded 5-minute ambient leg's measured CPU-inflation slope, and
   * the cap that bounds the whole adjustment so the teeth hold at every
   * ambient. Derivation at `ambientInflationFraction`.
   */
  readonly ambientInflationSlopePerCpu: number;
  readonly ambientInflationCapFraction: number;
}

/** What the rolling derivation found, with its own evidence attached. */
export interface BaselineDerivation {
  /** The cap in force: max(floor, median of the clean window). */
  readonly baselineMsPerTestFile: number;
  readonly floorMsPerTestFile: number;
  /** The clean window's median, or null when the ledger holds no clean run. */
  readonly medianMsPerTestFile: number | null;
  /** The clean window's readings, oldest first — the evidence the cap is made of. */
  readonly windowReadings: readonly number[];
  /** The declared K, restated so every disclosure names it. */
  readonly windowRuns: number;
  /** True when the median sat below the floor, so the floor held the baseline. */
  readonly floorBound: boolean;
  /**
   * True when the floor is provably STALE-HIGH: it binds AND the clean
   * median sits more than the declared spread below it, so the gate is
   * looser than the tree it bounds. Disclosed on every run; the remedy is
   * a measured floor re-derivation, never a silent benefit.
   */
  readonly floorStaleBeyondSpread: boolean;
}

/** What {@link measureBudgetFloor} found: a measured floor, or why the ledger cannot give one yet. */
export type BudgetFloorMeasurement =
  | Readonly<{ status: "measured"; floorMsPerTestFile: number; derivedAtTestFileCount: number; readings: readonly number[]; windowRuns: number }>
  | Readonly<{ status: "unmeasurable"; reason: string; eligibleRuns: number; windowRuns: number; derivedAtTestFileCount: number }>;

/**
 * THE MEASURING TOOL'S ARITHMETIC (D-17): the floor a budget is re-derived
 * to, from the ledger's own clean judged runs of the population as it is now
 * — never a hand-set number. The rows are the rolling baseline's eligible
 * ones ({@link eligibleBudgetReadings}: one rule for both), and the one
 * allowance line drops an outlier against the latest window's own median
 * (WF-1b3b design M5: the tool had re-spelled the rules and dropped the
 * allowance, so an overloaded outlier fed the "measured" floor). The floor
 * is the median of the last `baselineWindowRuns` readings within it,
 * rounded up to a whole millisecond. Fewer clean rows than the window is `unmeasurable` —
 * reported, never guessed and never tuned.
 */
export function measureBudgetFloor(
  budget: RollingCpuBudget,
  priorRuns: readonly JudgedRunRecord[],
  currentTestModuleCount: number,
  budgetFailureIdentities: readonly string[],
): BudgetFloorMeasurement {
  const eligible = eligibleBudgetReadings(budget, priorRuns, currentTestModuleCount, budgetFailureIdentities);
  const reference = eligible.length === 0 ? 0 : suiteCpuMedian(eligible.slice(-budget.baselineWindowRuns));
  const readings = eligible.filter((reading) => withinAllowance(reading, reference, budget)).slice(-budget.baselineWindowRuns);
  if (readings.length < budget.baselineWindowRuns) {
    return {
      status: "unmeasurable",
      reason: `${String(readings.length)} of the ${String(budget.baselineWindowRuns)} clean judged full runs of the current ${String(currentTestModuleCount)}-file population are recorded; run the full suite until the window is filled, then measure again`,
      eligibleRuns: readings.length,
      windowRuns: budget.baselineWindowRuns,
      derivedAtTestFileCount: currentTestModuleCount,
    };
  }
  return {
    status: "measured",
    floorMsPerTestFile: Math.ceil(suiteCpuMedian(readings)),
    derivedAtTestFileCount: currentTestModuleCount,
    readings,
    windowRuns: budget.baselineWindowRuns,
  };
}

/**
 * THE ONE ELIGIBILITY RULE of a rolling CPU budget's evidence, shared by the
 * rolling baseline and the measuring tool ({@link deriveRollingBaseline},
 * {@link measureBudgetFloor}): a row counts when it is not a deliberate
 * mutation run, measured the CURRENT population (within the declared
 * drift; a malformed count is invalid, never the permissive direction), and
 * carries none of the budget gate's own failures (it ran under a budget
 * state the verdict could not trust) — the population arm aside
 * ({@link BUDGET_POPULATION_ARM}: the failure a re-measurement clears). Its reading is AMBIENT-ADJUSTED — the
 * one envelope, `ambientInflationFraction`: raw / (1 + adjustment), so a
 * busy row reads what a quiet one would. Oldest first.
 *
 * A deliberate mutation-verification run measured a tree the operator
 * deliberately broke: its reading is evidence about the planted defect,
 * never about the real tree's cost. An unmarked row predates the marker and
 * counts as an ordinary run — the lean every marker in the ledger takes; the
 * harm direction is blocked anyway, because a mutation run that reads high
 * lands beyond the allowance and never feeds.
 */
/**
 * THE ONE ARM A RE-MEASUREMENT CLEARS. A budget gate's population arm fails
 * when the suite has grown past the population the declared floor was derived
 * at. That failure says the DECLARATION is stale, not that the run's reading
 * is untrusted, and it fails on EVERY run until the measuring tool re-derives
 * the floor: disqualifying it made the floor unmeasurable exactly when it had
 * to be re-measured (measured on the web suite: 12 judged full runs of the
 * 521-file population, 0 eligible, every one failing only this arm). Every
 * budget gate titles its population arm with this name, so the one rule finds
 * it; every other face of the gate still disqualifies its run.
 */
export const BUDGET_POPULATION_ARM = "the budget's population is still the one the budget was derived against";

/** A recorded failure that makes a run's reading untrusted: one of the gate's faces, other than its population arm. */
function disqualifiesReading(failure: string, budgetFailureIdentities: readonly string[]): boolean {
  if (!budgetFailureIdentities.some((id) => failure.startsWith(id))) return false;
  if (!failure.endsWith(BUDGET_POPULATION_ARM)) return true;
  const before = failure.slice(0, failure.length - BUDGET_POPULATION_ARM.length);
  return !(before.endsWith("::") || before.endsWith(" > "));
}

/** The eligible rows and their ambient-adjusted readings, in ledger order (see {@link eligibleBudgetReadings}). */
function eligibleBudgetRows(
  budget: RollingCpuBudget,
  priorRuns: readonly JudgedRunRecord[],
  currentTestModuleCount: number,
  budgetFailureIdentities: readonly string[],
): readonly Readonly<{ row: JudgedRunRecord; reading: number }>[] {
  return priorRuns.flatMap((r) => {
    // Only a reading taken inside the host's one instrument lock feeds a baseline: an unslotted row, or a legacy row with no stamp, may have shared the cores (D-17, design M-B).
    if (r.mutation === true || r.heavySlot !== "held") return [];
    const populationDrift = Math.abs(r.testModuleCount - currentTestModuleCount) / currentTestModuleCount;
    if (!(populationDrift <= budget.maxPopulationDriftFraction)) return [];
    if ((r.failures ?? []).some((f) => disqualifiesReading(f, budgetFailureIdentities))) return [];
    return [{ row: r, reading: r.cpuMsPerTestFile / (1 + ambientInflationFraction(r.ambientLoad5PerCpu, budget)) }];
  });
}

/** The eligible readings (the measuring tool's window, D-17): in the lock, the population in force, no disqualifying failure. */
function eligibleBudgetReadings(
  budget: RollingCpuBudget,
  priorRuns: readonly JudgedRunRecord[],
  currentTestModuleCount: number,
  budgetFailureIdentities: readonly string[],
): readonly number[] {
  return eligibleBudgetRows(budget, priorRuns, currentTestModuleCount, budgetFailureIdentities).map((entry) => entry.reading);
}

/** The CPU outcome a row recorded for itself, when it recorded one (its qualification's `cpu-per-test-file` gate). */
function recordedCpuOutcome(row: JudgedRunRecord): GateOutcome["kind"] | undefined {
  return row.qualification?.outcomes.find((outcome) => outcome.gate === "cpu-per-test-file")?.kind;
}

/**
 * THE ALLOWANCE LINE (`sameTreeSpreadFraction`), the measuring tool's one
 * outlier rule: in a re-measurement window an adjusted reading beyond
 * `median × (1 + spread)` is an outlier and counts toward nothing (a stale
 * floor cannot be the reference of its own re-derivation). D-17. It has no
 * role in the rolling baseline, which only a passing run feeds.
 */
function withinAllowance(reading: number, reference: number, budget: RollingCpuBudget): boolean {
  return reading <= reference * (1 + budget.sameTreeSpreadFraction);
}

/**
 * Derive the rolling baseline from the ledger's own rows, pure over the
 * recorded evidence. Never throws and never invents: a ledger it cannot
 * read is an empty one, which is the cold start, and the only number that
 * can come from anywhere but the ledger is the declared floor.
 *
 * THE FOLD (the baseline must never climb on runs
 * that failed): an eligible row ({@link eligibleBudgetReadings}, shared with
 * the measuring tool) feeds ONLY IF ITS OWN CPU OUTCOME PASSED — the outcome
 * it recorded, when it recorded one, AND its reading within the cap in force
 * at its moment (the baseline then; the reading is already ambient-adjusted,
 * as the cap was). A run over the cap fed the old fold whenever it lay within
 * the spread of the baseline (seven failing +2.5% runs lifted the cap until
 * the eighth passed: the deleted streak at length 7). The spread has no role
 * here; with the floor as the lower bound, the baseline therefore never rises
 * above the floor, and a change of the floor goes through its measuring tool
 * (D-17).
 */
export function deriveRollingBaseline(
  budget: RollingCpuBudget,
  priorRuns: readonly JudgedRunRecord[],
  currentTestModuleCount: number,
  budgetFailureIdentities: readonly string[],
): BaselineDerivation {
  const floor = budget.baselineFloorMsPerTestFile;
  // Each eligible reading is judged against the cap in force at its own moment
  // (the floor when no clean row precedes it, else the median of the clean
  // rows that do): a row whose own CPU outcome failed — recorded, or over that
  // cap — feeds nothing.
  const clean: number[] = [];
  for (const { row, reading } of eligibleBudgetRows(budget, priorRuns, currentTestModuleCount, budgetFailureIdentities)) {
    const recorded = recordedCpuOutcome(row);
    if (recorded !== undefined && recorded !== "pass") continue;
    const inForce = clean.length === 0 ? floor : Math.max(floor, suiteCpuMedian(clean.slice(-budget.baselineWindowRuns)));
    if (reading <= inForce) clean.push(reading);
  }
  const window = clean.slice(-budget.baselineWindowRuns);
  const median = window.length > 0 ? suiteCpuMedian(window) : null;
  const baseline = median === null ? floor : Math.max(floor, median);
  return {
    baselineMsPerTestFile: baseline,
    floorMsPerTestFile: floor,
    medianMsPerTestFile: median,
    windowReadings: window,
    windowRuns: budget.baselineWindowRuns,
    floorBound: median !== null && median < floor,
    floorStaleBeyondSpread:
      median !== null &&
      median < floor &&
      (floor - median) / floor > budget.sameTreeSpreadFraction,
  };
}

/** The clean window's readings as one readable list, for the disclosures. */
function formatReadings(readings: readonly number[]): string {
  return readings.map((r) => r.toFixed(1)).join(", ");
}

/** The derivation's core sentence — shared by the standing line and the note. */
function baselineCore(d: BaselineDerivation): string {
  if (d.windowReadings.length === 0) {
    return (
      `the cold start — the ledger holds no clean judged run yet, so the declared ` +
      `floor ${d.floorMsPerTestFile.toFixed(1)} ms/file is the baseline`
    );
  }
  const floorLeg = d.floorBound
    ? `, held at the declared floor ${d.floorMsPerTestFile.toFixed(1)} (the median sat below it)`
    : `, above the declared floor ${d.floorMsPerTestFile.toFixed(1)}`;
  const staleLeg = d.floorStaleBeyondSpread
    ? ` — the floor is STALE-LOOSE: the clean median sits more than the same-tree spread below it, so the gate is looser than the tree it bounds; re-derive the floor from the measured clean window and record the derivation beside the declaration`
    : "";
  return (
    `the median of the last ${String(d.windowReadings.length)} clean judged run(s) in the ` +
    `${String(d.windowRuns)}-run window (${formatReadings(d.windowReadings)}) = ` +
    `${d.medianMsPerTestFile === null ? "—" : d.medianMsPerTestFile.toFixed(1)}` +
    floorLeg +
    staleLeg
  );
}

/**
 * The standing disclosure — printed on every measured run, so the baseline's
 * movement is visible the moment it happens: which baseline is in force,
 * from what evidence, at what floor. A baseline that moved and said nothing
 * would be the silent climb the rolling design exists to prevent. The
 * window's readings are AMBIENT-ADJUSTED (each at its own recorded 5-minute
 * leg), so the sentence says so — an operator must not read the numbers as
 * raw costs.
 */
export function baselineLine(d: BaselineDerivation): string {
  return (
    `[runtime-budget] baseline: ${d.baselineMsPerTestFile.toFixed(1)} ms/file — ` +
    `${baselineCore(d)}; window readings are ambient-adjusted (each at its own recorded 5-minute load)`
  );
}

/**
 * The note every cpu-gate outcome carries, pass included: an operator
 * reading any verdict line can see WHICH baseline judged the run, HOW it
 * was derived — the K, the window's readings, the median, the floor — and
 * the ambient adjustment THIS run earned, with the arithmetic that made
 * the line: a red the reader can act on without re-running anything.
 */
export function baselineNote(
  d: BaselineDerivation,
  ambientInflation: number,
  ambientLoad5PerCpu: number | null | undefined,
): string {
  const adjustmentLeg =
    ambientInflation > 0
      ? ` The ambient adjustment this run earned: 5-minute load ` +
        `${typeof ambientLoad5PerCpu === "number" ? ambientLoad5PerCpu.toFixed(3) : "?"}/cpu × the ` +
        `declared envelope = +${(ambientInflation * 100).toFixed(1)}% — every line above scales by it.`
      : ` No ambient adjustment was earned (the 5-minute load leg recorded ` +
        `${typeof ambientLoad5PerCpu === "number" ? ambientLoad5PerCpu.toFixed(3) : "no"} /cpu).`;
  return (
    ` Judged against the rolling baseline ${d.baselineMsPerTestFile.toFixed(1)} ms/file — ` +
    `${baselineCore(d)}.${adjustmentLeg}`
  );
}

/**
 * One gate's outcome on one run.
 *
 * `not-judged` is a first-class result and never a pass: a budget with no
 * valid measurement behind it must SAY it could not judge (DESIGN-PERFORMANCE
 * L3). Three gates here used to `return` out of a test body on that state,
 * which vitest scores green — so "the suite is within budget" and "there was
 * no evidence" reported the same colour. There is no softer colour: one
 * judged run over a cap is a fail (UR-24-BUDGETS; the "warn" band is deleted).
 */
export interface GateOutcome {
  readonly gate: string;
  readonly kind: "pass" | "fail" | "not-judged";
  /** The failure message, the reason it was not judged, or the reading. */
  readonly message: string;
}

/** How old a run is, in plain words, so a lag is never implicit. Module-
 * private: every consumer is a gate message in this file, and the
 * dead-export scanner is right that an export nobody imports is a door
 * nobody uses. */
function ageOf(timestamp: string | null): string {
  if (timestamp === null) return "of unknown age (the summary carries no timestamp)";
  const then = Date.parse(timestamp);
  if (!Number.isFinite(then)) return `stamped ${timestamp}, which is not a parseable time`;
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  return `which finished ${String(seconds)}s ago, at ${timestamp}`;
}

/**
 * Everything a judged run recorded, on one line.
 *
 * The wall clock is no longer a gate, and a number that is neither judged nor
 * printed is a number that has been deleted. This is where it stays visible:
 * a real regression shows up here as a moved wall clock next to a moved CPU
 * cost, and a busy box shows up as a moved wall clock beside a still one.
 */
export function provenanceLine(v: Extract<BudgetVerdict, { kind: "measured" }>): string {
  return (
    `[runtime-budget] this run: cpu ${(v.runCpuMs / 1000).toFixed(1)}s over ` +
    `${String(v.testModuleCount)} test files = ${v.cpuMsPerTestFile.toFixed(1)} ms/file · ` +
    `wall clock ${(v.wallClockMs / 1000).toFixed(2)}s (reported, not judged) · pool occupancy ` +
    `${(v.totalOccupancyMs / 1000).toFixed(1)}s · worst collect ` +
    `${(v.worstCollectShare * 100).toFixed(1)}% of wall · ambient load ` +
    `${String(v.load1PerCpuAtStart)}/cpu (5-minute leg ${v.load5PerCpuAtStart.toFixed(3)}/cpu)`
  );
}

/**
 * THE THREE RUN-COST GATES, AS A PURE FUNCTION OF ONE RUN'S OWN NUMBERS.
 *
 * ── WHY THIS IS NOT A TEST ANY MORE ──────────────────────────────────────
 *
 * These three judgements used to live in `web-ui-runtime-budget.test.ts`, and
 * they judged THE PREVIOUS RUN — a lag the file's own header called
 * unavoidable, correctly, *for a test*. A test executes inside the run it
 * would be measuring, and the numbers it needs are a MAXIMUM and two TOTALS
 * over all 466 modules. At the moment the test body runs, the modules
 * scheduled after it have not been collected: the datum does not exist yet.
 * Handing the test a channel to the reporter would deliver a partial maximum
 * and two partial totals — all three smaller than the truth, all three in the
 * permissive direction, silently. It is not a plumbing problem.
 *
 * So the judge moved out of the subject. The reporter's `onTestRunEnd` holds
 * every module's diagnostics for THE RUN IT IS ENDING, which is the first
 * moment the quantities exist and the last moment the run is still alive. The
 * one-run lag is not fixed there; it is unrepresentable, because there is no
 * previous run anywhere in the data path.
 *
 * That it can fail the run was driven, not assumed: `process.exitCode = 7` set
 * from a reporter's `onTestRunEnd` reached the shell as **rc 7**
 * (`npx vitest run tests/unit/when-eval.test.ts --reporter=<probe>`).
 *
 * ── AND WHY THE REPORTER RATHER THAN `scripts/run-tests.ts` ──────────────
 *
 * The watchdog also sits outside the run and could read the summary the child
 * just wrote. But it is reachable only through `npm test`: `npm run test:raw`,
 * a bare `npx vitest run` and watch mode all bypass it, and each of those is
 * an ordinary thing to type. The reporter is named in `vitest.config.ts`, so
 * every one of those paths loads it. §3 — the lowest choke point, so it cannot
 * be bypassed and is de facto.
 */
export function judgeRunCosts(
  verdict: BudgetVerdict,
  inputs: RunCostInputs,
): readonly GateOutcome[] {
  if (verdict.kind === "unmeasurable") {
    return [
      { gate: "cpu-per-test-file", kind: "not-judged", message: verdict.why },
      { gate: "collect-tail-share", kind: "not-judged", message: verdict.why },
      { gate: "per-file-pool-share", kind: "not-judged", message: verdict.why },
    ];
  }
  return [
    rollingCpuGate(verdict, inputs),
    collectTailGate(verdict),
    perFileShareGate(verdict, inputs.fileShareMax),
  ];
}

/**
 * The web door's CPU gate: derive the rolling baseline from the ledger, hand
 * the SAME one-run cap the static door uses the effective baseline, and carry
 * the derivation's note on every outcome. One cap, two declaration shapes —
 * the rolling door only changes where the cap comes from.
 */
function rollingCpuGate(
  v: Extract<BudgetVerdict, { kind: "measured" }>,
  inputs: RunCostInputs,
): GateOutcome {
  const gate = "cpu-per-test-file";
  const budget = inputs.cpuBudget;
  if ("missing" in budget) return { gate, kind: "not-judged", message: budget.missing };
  const derivation = deriveRollingBaseline(
    budget,
    inputs.priorRuns,
    v.testModuleCount,
    inputs.budgetFailureIdentities,
  );
  const effective: DeclaredCpuBudget = {
    msPerTestFile: derivation.baselineMsPerTestFile,
    derivedAtTestFileCount: budget.derivedAtTestFileCount,
    maxPopulationDriftFraction: budget.maxPopulationDriftFraction,
    ambientInflationSlopePerCpu: budget.ambientInflationSlopePerCpu,
    ambientInflationCapFraction: budget.ambientInflationCapFraction,
  };
  const outcome = cpuGate(v, effective, inputs.suiteLabel);
  return {
    ...outcome,
    message: `${outcome.message}${baselineNote(
      derivation,
      ambientInflationFraction(v.load5PerCpuAtStart, budget),
      v.load5PerCpuAtStart,
    )}`,
  };
}

/**
 * THE ONE CPU DECISION, shared by both suites' gates: ONE judged run against
 * the cap in force (UR-24-BUDGETS; the user's decision of 2026-10-07: no
 * forgiveness). A run over the cap FAILS that run: there is no streak, no
 * "recorded, not red" band and no re-run. The one allowance left is the
 * stated ambient adjustment (AMBIENT-ALLOWANCE-REMOVE owns its removal),
 * printed numerically on every verdict.
 */
function cpuCap(current: JudgedRunRecord, budget: DeclaredCpuBudget): Readonly<{ pass: boolean; cap: number }> {
  const cap = budget.msPerTestFile * (1 + ambientInflationFraction(current.ambientLoad5PerCpu, budget));
  return { pass: current.cpuMsPerTestFile <= cap, cap };
}

/**
 * ── ONE JUDGED RUN IS THE VERDICT ──
 *
 * A run beyond the cap in force (its ambient adjustment stated) fails, in
 * that run. The gate once forgave an over-cap run inside a "same-tree spread"
 * band and waited for three consecutive runs beyond it; both are deleted
 * (UR-24-BUDGETS, UD-AUDIT-NO-FORGIVENESS): a cap a single run may not cross
 * is the only cap that bounds anything. The spread fraction survives in one
 * role only — which ledger readings count toward the rolling baseline and the
 * measuring tool's window (D-17) — and never widens a verdict.
 */
function cpuGate(
  v: Extract<BudgetVerdict, { kind: "measured" }>,
  budget: DeclaredCpuBudget | Missing,
  suiteLabel: string,
): GateOutcome {
  const gate = "cpu-per-test-file";
  if ("missing" in budget) return { gate, kind: "not-judged", message: budget.missing };
  const current: JudgedRunRecord = {
    timestamp: v.summaryTimestamp,
    cpuMsPerTestFile: v.cpuMsPerTestFile,
    testModuleCount: v.testModuleCount,
    ...(v.load5PerCpuAtStart >= 0 ? { ambientLoad5PerCpu: v.load5PerCpuAtStart } : {}),
  };
  const { pass, cap } = cpuCap(current, budget);
  const inflation = ambientInflationFraction(v.load5PerCpuAtStart, budget);
  const arithmetic =
    inflation > 0
      ? ` = baseline ${budget.msPerTestFile.toFixed(1)} × ${(1 + inflation).toFixed(3)} ambient ` +
        `adjustment (5-minute load ${v.load5PerCpuAtStart.toFixed(3)}/cpu × the declared envelope)`
      : ` (no ambient adjustment earned: 5-minute load ` +
        `${v.load5PerCpuAtStart >= 0 ? v.load5PerCpuAtStart.toFixed(3) : "not recorded"}/cpu)`;
  const allowance = ambientAllowanceStatement(budget, inflation);
  if (pass) {
    return {
      gate,
      kind: "pass",
      message: `${v.cpuMsPerTestFile.toFixed(1)} ms/file within ${cap.toFixed(1)}${arithmetic}${allowance}`,
    };
  }
  const failMessage =
    `The ${suiteLabel} suite cost ${v.cpuMsPerTestFile.toFixed(1)} ms of CPU per test file in ` +
    `THIS run — over the ${cap.toFixed(1)} ms/file cap in force${arithmetic}${allowance}. One ` +
    `judged run over the cap is the verdict: no streak, no band, no re-run.\n\n` +
    `That run (${ageOf(v.summaryTimestamp)}): ${(v.runCpuMs / 1000).toFixed(1)}s of CPU across ` +
    `${String(v.testModuleCount)} test files, wall clock ` +
    `${(v.wallClockMs / 1000).toFixed(2)}s (reported, not judged), pool occupancy ` +
    `${(v.totalOccupancyMs / 1000).toFixed(1)}s, ambient load ` +
    `${String(v.load1PerCpuAtStart)}/cpu (5-minute leg ${v.load5PerCpuAtStart.toFixed(3)}/cpu).\n\n` +
    `Fix the regression — do not raise the budget to meet it (a budget changes only through ` +
    `its measuring tool, D-17).\n\nWorst files by pool occupancy: ` +
    v.slowestFiles.map((f) => `${f.file} ${(f.ms / 1000).toFixed(1)}s`).join(", ");
  return { gate, kind: "fail", message: failMessage };
}

function collectTailGate(v: Extract<BudgetVerdict, { kind: "measured" }>): GateOutcome {
  const gate = "collect-tail-share";
  const worst = v.slowestCollects[0];
  if (worst === undefined) {
    return { gate, kind: "not-judged", message: "vitest reported no per-module diagnostics" };
  }
  if (v.worstCollectShare <= COLLECT_TAIL_SHARE_MAX) {
    return {
      gate,
      kind: "pass",
      message:
        `${worst.file} ${(v.worstCollectShare * 100).toFixed(1)}% of wall, within ` +
        `${(COLLECT_TAIL_SHARE_MAX * 100).toFixed(1)}%`,
    };
  }
  return {
    gate,
    kind: "fail",
    message:
      `${worst.file} spends ${(worst.ms / 1000).toFixed(2)}s OUTSIDE its tests — ` +
      `${(v.worstCollectShare * 100).toFixed(1)}% of this run's ` +
      `${(v.wallClockMs / 1000).toFixed(1)}s wall clock (vitest's collectDuration: import + ` +
      `suite callbacks; ${(v.totalCollectMs / 1000).toFixed(1)}s across all files).\n\n` +
      `Vitest orders files by TEST duration, so this cost is invisible to the scheduler: the ` +
      `file gets sorted by a number that does not include it, and lands wherever — sometimes ` +
      `overlapping the run, sometimes as a naked tail at the end. That is exactly what made ` +
      `this suite's wall clock bimodal (~31s vs ~43s) and its old budget a coin flip. Move ` +
      `the work into a test, or make it cheap.\n\nThis is a SHARE and not a duration, so a ` +
      `busy machine is not an explanation and raising the cap is not the repair.\n\n` +
      `BEFORE YOU LOOK FOR A REGRESSION, CHECK THE CACHE LINE PRINTED ABOVE. A run that had ` +
      `to build its module cache produces ~2.7× the warm share (measured: worst collect 1,545 ` +
      `ms warm against 4,553 ms cold, same tree), and such a run is supposed to be refused ` +
      `rather than judged. If it was judged, the cache reading is wrong before this number ` +
      `is.\n\nThis run: ${ageOf(v.summaryTimestamp)}.\n\nWorst offenders: ` +
      v.slowestCollects.map((c) => `${c.file} ${String(c.ms)}ms`).join(", "),
  };
}

function perFileShareGate(
  v: Extract<BudgetVerdict, { kind: "measured" }>,
  fileShareMax: number | Missing,
): GateOutcome {
  const gate = "per-file-pool-share";
  if (typeof fileShareMax !== "number") {
    return { gate, kind: "not-judged", message: fileShareMax.missing };
  }
  if (v.totalOccupancyMs <= 0) {
    // Refusing to judge is right; inventing a share from a zero denominator
    // is not.
    return { gate, kind: "not-judged", message: "the run recorded no pool total" };
  }
  const worst = v.slowestFiles[0];
  if (worst === undefined) {
    return { gate, kind: "not-judged", message: "vitest reported no per-module diagnostics" };
  }
  const share = worst.ms / v.totalOccupancyMs;
  if (share <= fileShareMax) {
    return {
      gate,
      kind: "pass",
      message:
        `${worst.file} ${(share * 100).toFixed(1)}% of the pool, within ` +
        `${(fileShareMax * 100).toFixed(1)}%`,
    };
  }
  return {
    gate,
    kind: "fail",
    message:
      `${worst.file} occupies ${(share * 100).toFixed(1)}% of the whole suite's worker time ` +
      `(${(worst.ms / 1000).toFixed(1)}s of ${(v.totalOccupancyMs / 1000).toFixed(1)}s across ` +
      `${String(v.testModuleCount)} files), over the ${(fileShareMax * 100).toFixed(1)}% cap.\n\n` +
      `The suite is throughput-bound: every second one file spends is a second of the whole ` +
      `pool's budget, so a file this size sets the wall clock no matter where it is ` +
      `scheduled. The usual cause is a fixed setup cost paid once per TEST instead of once ` +
      `per file — a real threaded DB facade, a spawned server, a compiled fixture. Hoist it ` +
      `into beforeAll and isolate the tests by their DATA, or split the file.\n\n` +
      `This run: ${ageOf(v.summaryTimestamp)}.\n\nWorst files: ` +
      v.slowestFiles.map((f) => `${f.file} ${(f.ms / 1000).toFixed(1)}s`).join(", "),
  };
}

/** What the config declares: a number, and the population it was measured on. */
export interface DeclaredCpuBudget {
  readonly msPerTestFile: number;
  readonly derivedAtTestFileCount: number;
  readonly maxPopulationDriftFraction: number;
  /**
   * The ambient-inflation envelope — see `ambientInflationFraction`. The cap
   * scales by the adjustment the run's recorded 5-minute ambient leg earns,
   * stated numerically on every verdict (AMBIENT-ALLOWANCE-REMOVE owns its
   * removal).
   */
  readonly ambientInflationSlopePerCpu: number;
  readonly ambientInflationCapFraction: number;
}

export type PopulationVerdict =
  | { readonly kind: "current"; readonly driftFraction: number }
  | { readonly kind: "stale"; readonly driftFraction: number; readonly why: string };

/**
 * Has the suite moved far enough that the budget's derivation is stale?
 *
 * **THIS IS THE DELIVERABLE THAT OUTLIVES THE FIX.** The wall-clock cap was
 * derived against 433 test files and was still being enforced against 451,
 * because nothing anywhere connected the number to the population it bounded.
 * A per-file figure survives growth far better than a total, but it is still
 * a measurement taken on one tree, and a tree that has grown by a fifth is a
 * different tree. So the number and its population are declared together and
 * a large enough drift REFUSES rather than quietly carrying on.
 *
 * The tolerance is a configurable, and the incident sets its scale: the drift
 * that went unnoticed was 433 → 451, **+4.2%**. A tolerance that would not
 * have fired on that drift would be a tolerance that admits the exact defect
 * it exists to prevent, so the configured value must sit below it.
 */
export function judgePopulationDrift(
  declared: Readonly<
    Pick<DeclaredCpuBudget, "derivedAtTestFileCount" | "maxPopulationDriftFraction">
  >,
  discoveredCount: number,
  /**
   * Where the declaration lives, for the remedy text — e.g.
   * `testExecution.webUiSuiteCpuBudget`. Required, not defaulted: this module
   * serves two suites' budgets in one config file, and a remedy that names
   * the other suite's key sends the operator to fix the wrong declaration.
   */
  configKey: string,
): PopulationVerdict {
  const base = declared.derivedAtTestFileCount;
  const driftFraction = Math.abs(discoveredCount - base) / base;
  if (driftFraction <= declared.maxPopulationDriftFraction) {
    return { kind: "current", driftFraction };
  }
  const direction = discoveredCount > base ? "grown" : "shrunk";
  return {
    kind: "stale",
    driftFraction,
    why:
      `the suite has ${direction} from the ${String(base)} test files this budget was ` +
      `derived against to ${String(discoveredCount)} — a drift of ` +
      `${(driftFraction * 100).toFixed(1)}%, over the ` +
      `${(declared.maxPopulationDriftFraction * 100).toFixed(1)}% a derivation is allowed ` +
      `to survive. A threshold is meaningless without the population it bounds: this one ` +
      `now governs a suite it never measured. Re-base ${configKey}.derivedAtTestFileCount ` +
      `on the current tree, AND re-derive the budget's hand-maintained number beside it — ` +
      `${configKey}.baselineFloorMsPerTestFile under the rolling declaration (judge it ` +
      `against the ledger's own clean window at the new population), or ` +
      `${configKey}.msPerTestFile under a static one — with the derivation recorded beside ` +
      `the declaration. Do not simply move derivedAtTestFileCount — that restates the ` +
      `population without re-deriving the number, which is the defect itself.`,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// THE INTEGRATION SUITE'S DOOR — the same verdict math, over the evidence
// its runner can honestly collect.
//
// The integration runner (`scripts/run-tests.ts`) does not have vitest's
// per-module diagnostics, so the collect-tail and pool-share gates have no
// evidence there. What it has is the run's CPU (self + reaped worker
// subtree), the inventoried test-file population, and the V8 compile
// cache's mtime warmth reading — which is exactly what the CPU gate needs.
// ─────────────────────────────────────────────────────────────────────────

/**
 * The declared ACCUMULATION phase of a CPU budget: no cap exists yet, and
 * none is guessed. The gate records judged runs into the ledger and refuses
 * to judge a cap until the ledger holds enough of them to DERIVE one —
 * the clean window's median, with no headroom (one judged run over the cap
 * fails, UR-24-BUDGETS), the derivation recorded beside the declaration
 * when it is made. "A budget nobody chose is not a budget"
 * cuts both ways: a cap invented before the evidence exists is exactly as
 * unowned as a silent default.
 */
export interface AccumulatingCpuBudget {
  readonly phase: "accumulation";
  /** Judged runs the ledger must hold before the cap is derived. */
  readonly minimumJudgedRuns: number;
  /** Population validation for ledger entries during accumulation — the same
   *  role the rolling budget's field of this name plays in its eligibility rule. */
  readonly maxPopulationDriftFraction: number;
}

/** The compile-cache warmth reading the integration runner takes — the same
 *  mtime-at-or-after-run-start instrument the web reporter uses, pointed at
 *  the V8 compile cache directory the run actually used. */
export interface CacheWarmthReading {
  readonly entriesAtEnd: number | null;
  readonly writtenDuringRun: number | null;
  /** Newest mtime observed across ALL entries — the witness that the walk
   *  behind `writtenDuringRun` genuinely happened (a zero count beside a
   *  newest mtime at or after the run's start is a contradiction). */
  readonly newestEntryMtimeMs: number | null;
  readonly runStartMs: number | null;
}

export interface SuiteCpuEvidence {
  /** CPU the run consumed (runner self + reaped worker subtree), or null
   *  when it could not be measured — absence, never zero. */
  readonly cpuMs: number | null;
  /** Test FILES the run covered — the population the budget is per. */
  readonly testFileCount: number | null;
  /** Recorded and REPORTED, never judged — see the module header. */
  readonly wallClockMs: number | null;
  readonly timestamp: string | null;
  /** Null when the compile cache could not be observed at all — that says
   *  nothing about coldness either way, so the run is still judged. */
  readonly warmth: CacheWarmthReading | null;
  /** The repository's HEAD commit at run time, or null when unreadable —
   *  collected by the runner (the runner-bound half), recorded into the
   *  judged record so cap derivation can demand same-sha samples. */
  readonly headSha: string | null;
  /** `loadavg()[0] / cpuCount` at run start, or null when unreadable. */
  readonly ambientLoadPerCpu: number | null;
  /** The run-start snapshot's 5- and 15-minute legs, per CPU — the
   *  saturation ghost's witnesses (see `JudgedRunRecord`). Null when
   *  unreadable: absence, never a fabricated zero. */
  readonly ambientLoad5PerCpu: number | null;
  readonly ambientLoad15PerCpu: number | null;
}

export type SuiteCpuJudgment = Readonly<{
  outcome: GateOutcome;
  /**
   * The judged record to append to the run-history ledger, or null when the
   * run was refused — a refused run proved nothing about the tree, so it
   * must never feed a baseline, and keeping it out of the ledger entirely is
   * the simplest spelling of that.
   */
  judgedRecord: JudgedRunRecord | null;
}>;

function suiteCpuMedian(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Judge one integration-suite run's CPU cost.
 *
 * Three-valued (`pass | fail | not-judged`), and a `not-judged` is a first-class result the caller must PRINT
 * — the predecessor gate had three refusal paths that scored as PASS
 * (summary absent, wallClockMs absent, corrupt JSON), which is the shape
 * this replaces.
 */
export function judgeSuiteCpu(
  evidence: SuiteCpuEvidence,
  declaration: DeclaredCpuBudget | AccumulatingCpuBudget | Missing,
  priorRuns: readonly JudgedRunRecord[],
  suiteLabel: string,
  configKey: string,
): SuiteCpuJudgment {
  const gate = "cpu-per-test-file";
  const refuse = (why: string): SuiteCpuJudgment => ({
    outcome: { gate, kind: "not-judged", message: why },
    judgedRecord: null,
  });

  // ABSENCE, NEVER ZERO — on both required readings.
  if (evidence.cpuMs === null || evidence.cpuMs <= 0) {
    return refuse(
      "the run's CPU cost could not be read (no positive reading from the runner's " +
        "process accounting), and CPU is what this budget bounds. Absence is not a zero " +
        "and a zero is not a pass.",
    );
  }
  if (evidence.testFileCount === null || evidence.testFileCount <= 0) {
    return refuse(
      "the run's test-file population could not be read from the pinned inventory, so " +
        "there is no population to divide the CPU cost by. A budget without its " +
        "population is not judged.",
    );
  }

  // WARMTH — the same three arms the web verdict applies, over the V8
  // compile cache: deny-by-default on a count without its witness, refuse
  // the fabricated zero, refuse a run that wrote a cold-cache fraction of
  // the cache it finished with. A wholly invisible cache says nothing about
  // coldness and does not block judgment (mirroring the web arm).
  const w = evidence.warmth;
  if (w !== null && w.entriesAtEnd !== null && w.entriesAtEnd > 0) {
    if (w.writtenDuringRun === null || w.newestEntryMtimeMs === null || w.runStartMs === null) {
      return refuse(
        `the compile cache held ${String(w.entriesAtEnd)} entries at the end of the run but ` +
          `the written-during-run count, its newest-mtime witness, or the run-start ` +
          `reference is missing — a warmth claim without its measurement cannot be judged ` +
          `warm. One full run with the current runner re-arms this gate.`,
      );
    }
    if (w.writtenDuringRun === 0 && w.newestEntryMtimeMs >= w.runStartMs) {
      return refuse(
        `the compile-cache scan claims ZERO entries written during the run while the newest ` +
          `entry's mtime is at or after the run's start — the two readings come from the ` +
          `same walk and contradict each other (the computed-then-discarded shape, or a walk ` +
          `over the wrong directory). A contradiction is not warmth.`,
      );
    }
    const writtenFraction = w.writtenDuringRun / w.entriesAtEnd;
    if (writtenFraction >= COLD_MODULE_CACHE_FRACTION) {
      return refuse(
        `the run WROTE ${(writtenFraction * 100).toFixed(1)}% of the compile cache it ` +
          `finished with (${String(w.writtenDuringRun)} of ${String(w.entriesAtEnd)} entries ` +
          `carry an mtime at or after the run's start), so its CPU includes compile work a ` +
          `warm run does not pay. A cold run is not a measurement of this tree. Run the ` +
          `suite once more to re-arm this gate.`,
      );
    }
  }

  const judgedRecord: JudgedRunRecord = {
    timestamp: evidence.timestamp,
    cpuMsPerTestFile: evidence.cpuMs / evidence.testFileCount,
    testModuleCount: evidence.testFileCount,
    // Present only when the runner could read them — an unreadable identity
    // or condition is ABSENT in the record, never a fabricated placeholder.
    ...(evidence.headSha !== null ? { headSha: evidence.headSha } : {}),
    ...(evidence.ambientLoadPerCpu !== null
      ? { ambientLoadPerCpu: evidence.ambientLoadPerCpu }
      : {}),
    ...(evidence.ambientLoad5PerCpu !== null
      ? { ambientLoad5PerCpu: evidence.ambientLoad5PerCpu }
      : {}),
    ...(evidence.ambientLoad15PerCpu !== null
      ? { ambientLoad15PerCpu: evidence.ambientLoad15PerCpu }
      : {}),
    // The during-run calibration fields, same lean as the web ledger's.
    ...(evidence.wallClockMs !== null ? { wallClockMs: evidence.wallClockMs } : {}),
  };

  // MISSING DECLARATION IS A GUIDED STATE, and there is no fallback number.
  // The run's evidence is still recorded — the ledger is what a future
  // declaration will be derived from.
  if ("missing" in declaration) {
    return {
      outcome: { gate, kind: "not-judged", message: declaration.missing },
      judgedRecord,
    };
  }

  if ("phase" in declaration) {
    // ACCUMULATION. Ledger entries are population-validated exactly as the
    // rolling baseline validates them: an entry from a different population is
    // not evidence toward this derivation.
    const valid = priorRuns.filter(
      (r) =>
        Math.abs(r.testModuleCount - judgedRecord.testModuleCount) /
          judgedRecord.testModuleCount <=
        declaration.maxPopulationDriftFraction,
    );
    const samples = [...valid.map((r) => r.cpuMsPerTestFile), judgedRecord.cpuMsPerTestFile];
    const have = samples.length;
    const need = declaration.minimumJudgedRuns;
    // SAME-TREE means SAME COMMIT: how many of the counted samples share
    // THIS run's HEAD. Entries with no recorded sha predate the identity
    // field and cannot claim to be same-tree — they are counted toward the
    // accumulation total (they are real judged runs) but the prescription
    // demands the derivation use only the same-sha subset.
    const sameSha = judgedRecord.headSha === undefined
      ? 0
      : valid.filter((r) => r.headSha === judgedRecord.headSha).length + 1;
    const conditionNote =
      ` A cap is derived ONLY from samples sharing ONE headSha (this run: ` +
      `${judgedRecord.headSha ?? "unrecorded"}; ${String(sameSha)} of the counted samples ` +
      `share it), each judged at its own recorded ambient (the derivation the rolling ` +
      `baseline performs — entries feed at their ambient-adjusted readings, never excluded ` +
      `for busyness): the ledger has already measured a same-day cross-condition spread ` +
      `of ~60% on one tree, and a spread derived across commits or conditions encodes ` +
      `that confound as permanent slack.`;
    if (have < need) {
      return {
        outcome: {
          gate,
          kind: "not-judged",
          message:
            `accumulation phase — judged run ${String(have)} of ${String(need)} recorded ` +
            `(this run: ${judgedRecord.cpuMsPerTestFile.toFixed(1)} ms/file over ` +
            `${String(judgedRecord.testModuleCount)} test files). No cap is in force yet ` +
            `and none is guessed: the cap is DERIVED from the ledger's clean median, with no ` +
            `headroom, once ${String(need)} judged runs exist, and the derivation is recorded ` +
            `beside the declaration in ${configKey}.` + conditionNote,
        },
        judgedRecord,
      };
    }
    const med = suiteCpuMedian(samples);
    const spread = Math.max(...samples.map((s) => Math.abs(s - med) / med));
    return {
      outcome: {
        gate,
        kind: "not-judged",
        message:
          `accumulation complete — the ledger holds ${String(have)} judged runs ` +
          `(>= ${String(need)}). Derive the cap now, from the ledger, not from taste: ` +
          `median ${med.toFixed(1)} ms/file, measured same-tree spread ±` +
          `${(spread * 100).toFixed(1)}% (max |run − median| / median — computed over ALL ` +
          `counted samples; recompute both over the same-sha same-condition subset before ` +
          `deriving). Replace the ` +
          `accumulation declaration at ${configKey} in bridlewise.config.json with the ` +
          `rolling shape: baselineFloorMsPerTestFile (the clean median, no headroom: one ` +
          `judged run over the cap fails), derivedAtTestFileCount ` +
          `(${String(judgedRecord.testModuleCount)}), maxPopulationDriftFraction, ` +
          `sameTreeSpreadFraction and baselineWindowRuns — and ` +
          `record this derivation beside the declaration. Until the cap is declared, every ` +
          `run prints this line and none is judged against a cap.` + conditionNote,
      },
      judgedRecord,
    };
  }

  // DECLARED CAP. Population drift is judged before the cap is applied: a
  // budget whose population has moved governs a suite it never measured,
  // and refusing loudly until it is re-derived is the honest verdict. The
  // run is still recorded — a re-derivation needs exactly this evidence.
  const drift = judgePopulationDrift(declaration, judgedRecord.testModuleCount, configKey);
  if (drift.kind === "stale") {
    return { outcome: { gate, kind: "not-judged", message: drift.why }, judgedRecord };
  }

  const { pass, cap } = cpuCap(judgedRecord, declaration);
  const wallNote =
    evidence.wallClockMs !== null
      ? ` Wall clock ${(evidence.wallClockMs / 1000).toFixed(2)}s (reported, not judged).`
      : "";
  const inflation = ambientInflationFraction(evidence.ambientLoad5PerCpu, declaration);
  const arithmetic =
    inflation > 0
      ? ` = baseline ${declaration.msPerTestFile.toFixed(1)} × ${(1 + inflation).toFixed(3)} ` +
        `ambient adjustment (5-minute load ` +
        `${evidence.ambientLoad5PerCpu !== null ? evidence.ambientLoad5PerCpu.toFixed(3) : "?"}/cpu × ` +
        `the declared envelope)`
      : ` (no ambient adjustment earned: 5-minute load ` +
        `${evidence.ambientLoad5PerCpu !== null ? evidence.ambientLoad5PerCpu.toFixed(3) : "not recorded"}/cpu)`;
  const allowance = ambientAllowanceStatement(declaration, inflation);
  if (pass) {
    return {
      outcome: {
        gate,
        kind: "pass",
        message:
          `${judgedRecord.cpuMsPerTestFile.toFixed(1)} ms/file within ${cap.toFixed(1)}` +
          `${arithmetic}${allowance}.${wallNote}`,
      },
      judgedRecord,
    };
  }
  return {
    outcome: {
      gate,
      kind: "fail",
      message:
        `The ${suiteLabel} suite cost ${judgedRecord.cpuMsPerTestFile.toFixed(1)} ms of CPU per ` +
        `test file in THIS run — over the ${cap.toFixed(1)} ms/file cap in force${arithmetic}${allowance}. ` +
        `One judged run over the cap is the verdict: no streak, no band, no re-run.\n\n` +
        `THIS RUN: ${((evidence.cpuMs ?? 0) / 1000).toFixed(1)}s of CPU across ` +
        `${String(judgedRecord.testModuleCount)} test files.${wallNote}\n\n` +
        `Fix the regression — do not raise the budget to meet it (a budget changes only through ` +
        `its measuring tool, D-17).`,
    },
    judgedRecord,
  };
}
