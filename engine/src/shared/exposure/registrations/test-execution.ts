/**
 * Shared exposure registrations — `testExecution` module.
 *
 * The harness's own test machinery: the engine runner's run bounds (how many
 * lanes a phase gets, how long one test may run) and — shown read-only — the
 * CPU budgets the suites' own gates judge by.
 *
 * THE DISPOSITION DOCTRINE (this class's census, tests/prevention/
 * exposure-reachable.test.ts): the section declares 19 leaves. Five are run
 * bounds with contract defaults — the pytest-xdist lane-count class, knobs
 * the operator tunes per machine — and register as writable rows. The nine
 * budget leaves (the web suite's rolling CPU baseline — its recorded floor,
 * its population, its window, the drift tolerance, the noise band and the
 * ratchet count — plus the per-file worker-time share cap, the flaky-test
 * lookback window, and the engine suite's own budget phase) are the gates'
 * OWN verdict numbers: each decides what a green run MEANS, and a settings
 * write that loosened one would silently weaken the verdict — so each is
 * served as a READ-ONLY
 * signal and pinned never-writable, the same doctrine the benchmark budgets
 * and the web performance ceilings follow. The remaining leaves are FILED
 * by the census with their reasons: the `concurrency` union ("auto" | false
 * | a bounded integer) is a value space no scalar sheet row can spell
 * honestly (a number-typed row could write one spelling, and its
 * return-to-default "auto" would fail the row's own validation);
 * `parallelConcurrency`'s designed default is derived from the machine's
 * own parallelism at run time, so a row would present a host-derived number
 * as a contract default; and the compile-cache pruning bounds are
 * default-less BY DESIGN in their consuming owner ("a bound nobody chose is
 * not a bound") — a settings row must declare a default, and the
 * omit-on-default write would prune the key, presenting the file's current
 * choice as the contract's default.
 *
 * THE HONEST TIMING: every row's consumer is a fresh runner process that
 * resolves the pinned config document once per invocation, so a settings
 * write lands in the file and the NEXT test run reads it. The signals read
 * the live config on every poll.
 */

import {
  registerCustomization,
  registerExposureModule,
  registerSignal,
} from "../index.ts";
import { readConfigCustomization, readNumberCustomization, writeConfigCustomization } from "../config-binding.ts";
import {
  DEFAULT_ENGINE_SUITE_WATCHDOG,
  DEFAULT_TEST_RUNTIME_BUDGET_MS,
  DEFAULT_SERIAL_PHASE_CONCURRENCY,
  DEFAULT_FULL_SUITE_SERIAL_PHASE_CONCURRENCY,
  DEFAULT_FULL_SUITE_IN_PROCESS_SERIAL_PHASE_CONCURRENCY,
  DEFAULT_FULL_SUITE_PARALLEL_CONCURRENCY,
} from "../../../workflow/workflow-config.ts";

/**
 * The honest absence for the budget readings. These leaves are deliberately
 * default-less in their consuming owners (a budget nobody chose is not a
 * budget), so an absent key is a first-class state the gate reports loudly —
 * the signal states it in words, the same honest-absence contract as a
 * pinned executable the machine has not named.
 */
const NOT_DECLARED = "not declared — the gate that reads it refuses to judge a run until it is measured and set in the config file";

/** Read a leaf that is a number when declared, absent otherwise. */
function readBudgetNumber(path: string): number | undefined {
  const value = readConfigCustomization(path);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * The engine suite's watchdog bound as served: the declared value, or — the
 * watchdog has a default, like its sibling per-test kill timeout — the default
 * the runner applies, SAID to be the default.
 */
function engineWatchdogFace(path: string, fallbackMs: number, face: (seconds: string) => string): string {
  const declared = readBudgetNumber(path);
  return declared === undefined ? `not declared — the default applies: ${face(String(fallbackMs / 1000))}` : face(String(declared / 1000));
}

/** A fraction (0..1) rendered as a percentage without float noise. */
function asPercent(fraction: number): string {
  return `${Math.round(fraction * 1000) / 10}%`;
}

const ROWS = [
  {
    id: "runtimeBudgetMs",
    configPath: "testExecution.runtimeBudgetMs",
    name: "How long one test may run before it fails",
    description:
      "Every test gets this many milliseconds to settle; a test that never does is killed and FAILS instead of stalling the whole suite. Lower = a stuck test ends sooner; higher = a slow but legitimate test still finishes. Takes effect on the next test run.",
    default: DEFAULT_TEST_RUNTIME_BUDGET_MS,
    min: 1,
    max: 600_000,
    unit: "milliseconds",
  },
  {
    id: "serialPhaseConcurrency",
    configPath: "testExecution.serialPhaseConcurrency",
    name: "How many serial-phase tests run at once",
    description:
      "Files that must not run in parallel still run several at a time inside the serial phase. Lower = less interference between them; higher = the serial phase finishes sooner on a big machine. Takes effect on the next test run.",
    default: DEFAULT_SERIAL_PHASE_CONCURRENCY,
    min: 1,
    max: 16,
    unit: "lanes",
  },
  {
    id: "fullSuiteSerialPhaseConcurrency",
    configPath: "testExecution.fullSuiteSerialPhaseConcurrency",
    name: "How many serial-phase tests a full run starts at once",
    description:
      "The full suite's serial phase runs this many files concurrently. Lower = shared resources contend less; higher = the full run's serial tail is shorter. Takes effect on the next full test run.",
    default: DEFAULT_FULL_SUITE_SERIAL_PHASE_CONCURRENCY,
    min: 1,
    max: 16,
    unit: "lanes",
  },
  {
    id: "fullSuiteInProcessSerialPhaseConcurrency",
    configPath: "testExecution.fullSuiteInProcessSerialPhaseConcurrency",
    name: "How many in-process serial tests a full run shares",
    description:
      "Serial files that spawn no subprocess of their own run together in one process, this many at a time. Lower = less memory pressure; higher = the in-process tier drains faster. Takes effect on the next full test run.",
    default: DEFAULT_FULL_SUITE_IN_PROCESS_SERIAL_PHASE_CONCURRENCY,
    min: 1,
    max: 16,
    unit: "lanes",
  },
  {
    id: "fullSuiteParallelConcurrency",
    configPath: "testExecution.fullSuiteParallelConcurrency",
    name: "How many parallel lanes a full suite run uses",
    description:
      "The full suite's parallel phase gets this many worker lanes. Lower = a loaded machine breathes; higher = independent tests finish sooner. Takes effect on the next full test run.",
    default: DEFAULT_FULL_SUITE_PARALLEL_CONCURRENCY,
    min: 1,
    max: 64,
    unit: "lanes",
  },
] as const;

let testExecutionRegistered = false;
export function registerTestExecutionExposure(): void {
  if (testExecutionRegistered) return;
  testExecutionRegistered = true;

  registerExposureModule({
    id: "testExecution",
    title: "How the harness runs its own tests",
    purpose:
      "How many tests run at once, how long one may run, and the CPU budgets the harness's own test gates judge every run by.",
  });

  // --- Customizations (5: the runner's run bounds, contract defaults) ---
  for (const spec of ROWS) {
    registerCustomization({
      id: `testExecution.${spec.id}`,
      module: "testExecution",
      name: spec.name,
      description: spec.description,
      type: "number",
      default: spec.default,
      min: spec.min,
      max: spec.max,
      unit: spec.unit,
      current: () => readNumberCustomization(spec.configPath, spec.default),
      set: (v) => writeConfigCustomization(spec.configPath, v),
      contract: { effect: "next-run" },
      configPath: spec.configPath,
    });
  }

  // --- Signals (9: the gates' own verdict numbers, read-only) ---
  // Each budget decides what a suite gate's green MEANS: the web suite's
  // CPU-per-file floor (the rolling cap's recorded anchor) and population,
  // the window the rolling median is taken over, the drift tolerance, the
  // noise band, the ratchet count, the share of the pool one file may
  // occupy, the flaky memory's lookback window, and the engine suite's own
  // budget phase. They are the round-39 doctrine's class — shown read-only,
  // pinned never-writable by the census — and they carry no default on
  // purpose: an absent key is the gate's own loud refusal, so the signal
  // states it in words instead of inventing a number (the honest-absence
  // contract).
  const BUDGET_PATH = "testExecution.webUiSuiteCpuBudget";
  registerSignal({
    id: "testExecution.webSuiteCpuCap",
    module: "testExecution",
    name: "CPU cost one web-suite test file may reach",
    description:
      "The web-UI suite's CPU cap: the recorded floor itself. Only a run that passed its own cap feeds the rolling window, so the window's median never rises above the floor; a grown or slower suite fails the cap until the measuring tool re-derives the floor (npm run budget:measure). Every judgement line scales by the measured ambient-inflation envelope (see the ambient signals). Shown read-only: a settings write that loosened it would silently weaken what a green run means.",
    type: "string",
    value: () => {
      const floor = readBudgetNumber(`${BUDGET_PATH}.baselineFloorMsPerTestFile`);
      const window = readBudgetNumber(`${BUDGET_PATH}.baselineWindowRuns`);
      if (floor === undefined) return NOT_DECLARED;
      return window === undefined
        ? `${floor} ms of CPU per test file — the cap, the recorded floor (the stale-floor window is not declared)`
        : `${floor} ms of CPU per test file — the cap, the recorded floor; re-derived only by its measuring tool`;
    },
  });
  registerSignal({
    id: "testExecution.webSuiteBaselineWindow",
    module: "testExecution",
    name: "Clean runs the rolling CPU baseline's median is taken over",
    description:
      "How many recent clean judged runs (each one passed its own cap) the stale-floor check's median is computed over. The cap itself is the floor: a grown suite fails it until the measuring tool re-derives the floor. Shown read-only: widening or shrinking the window from the settings room would change what the gate reports.",
    type: "string",
    value: () => {
      const window = readBudgetNumber(`${BUDGET_PATH}.baselineWindowRuns`);
      return window === undefined ? NOT_DECLARED : `the stale-floor check reads the median of the last ${String(window)} clean judged runs`;
    },
  });
  registerSignal({
    id: "testExecution.webSuiteCpuPopulation",
    module: "testExecution",
    name: "Test files the web-suite budget was measured against",
    description:
      "The suite size the budget's recorded floor was derived on. The gate refuses when the suite grows or shrinks past its declared drift tolerance, so the population and the floor move together or not at all. Shown read-only: a settings write here would decouple the floor from the tree it was measured on.",
    type: "string",
    value: () => {
      const count = readBudgetNumber(`${BUDGET_PATH}.derivedAtTestFileCount`);
      return count === undefined ? NOT_DECLARED : `measured against ${count} test files`;
    },
  });
  registerSignal({
    id: "testExecution.webSuitePopulationDriftTolerance",
    module: "testExecution",
    name: "Suite-size drift the web-suite budget tolerates",
    description:
      "How far the suite may grow or shrink before the CPU cap must be re-derived on the tree as it now is. Shown read-only: widening this from the settings room would let a cap govern a suite it never measured.",
    type: "string",
    value: () => {
      const drift = readBudgetNumber(`${BUDGET_PATH}.maxPopulationDriftFraction`);
      return drift === undefined ? NOT_DECLARED : `${asPercent(drift)} suite-size drift before re-deriving`;
    },
  });
  registerSignal({
    id: "testExecution.webSuiteNoiseSpread",
    module: "testExecution",
    name: "Same-tree spread that decides which runs feed the web-suite baseline",
    description:
      "How far a judged run's reading may sit above the baseline in force and still feed the rolling baseline and the measuring tool's window — the measured run-to-run spread of an unchanged tree. It never widens a verdict: one judged run over the cap fails. Shown read-only: widening it from the settings room would let regressed readings feed the baseline.",
    type: "string",
    value: () => {
      const spread = readBudgetNumber(`${BUDGET_PATH}.sameTreeSpreadFraction`);
      return spread === undefined ? NOT_DECLARED : `${asPercent(spread)} same-tree spread decides which runs feed the baseline`;
    },
  });
  registerSignal({
    id: "testExecution.webSuiteAmbientInflationSlope",
    module: "testExecution",
    name: "CPU inflation paid per unit of sustained ambient load",
    description:
      "How much of a run's recorded CPU cost the box's sustained ambient load explains, per recorded 5-minute load unit per CPU — the measured envelope every judgement line scales by, so a clean run at a busy ambient judges clean and nothing anywhere waits for a quiet box. Shown read-only: the slope is the gate's own measured calibration (the ledger's recorded busy-vs-quiet pairs), and a settings write that steepened it would loosen what a green run means.",
    type: "string",
    value: () => {
      const slope = readBudgetNumber(`${BUDGET_PATH}.ambientInflationSlopePerCpu`);
      return slope === undefined
        ? NOT_DECLARED
        : `the gate pays ${(slope * 100).toFixed(1)}% more allowance per unit of recorded 5-minute ambient load per CPU`;
    },
  });
  registerSignal({
    id: "testExecution.webSuiteAmbientInflationCap",
    module: "testExecution",
    name: "Bound on the ambient allowance the gate may pay",
    description:
      "The largest fraction of the baseline the ambient-inflation allowance may ever expand a judgement line by, so the gate's teeth hold at every ambient: a regression beyond the capped line fails at any load the box is under. Shown read-only: the cap is the gate's own bound, and a settings write that raised it would let a busy box hide a regression.",
    type: "string",
    value: () => {
      const cap = readBudgetNumber(`${BUDGET_PATH}.ambientInflationCapFraction`);
      return cap === undefined
        ? NOT_DECLARED
        : `the ambient allowance is capped at ${(cap * 100).toFixed(1)}% of the baseline`;
    },
  });
  registerSignal({
    id: "testExecution.webTestFileCostShareMax",
    module: "testExecution",
    name: "Worker-time share one web-suite test file may take",
    description:
      "The largest share of the whole pool's worker time one test file may occupy — a share rather than a duration, so contention moves the numerator and denominator together. Shown read-only: loosening it would let one file eat the suite unnoticed.",
    type: "string",
    value: () => {
      const share = readBudgetNumber("testExecution.webUiTestFileCostShareMax");
      return share === undefined ? NOT_DECLARED : `one test file may take at most ${asPercent(share)} of the pool's worker time`;
    },
  });
  // THE HOST'S ONE INSTRUMENT LOCK (src/process/instrument-lock.ts): served
  // read-only, like every suite-gate number — a settings write that moved the
  // lock's file or raised the heavy threshold would let two instruments overlap.
  registerSignal({
    id: "testExecution.instrumentLockFile",
    module: "testExecution",
    name: "The host's one instrument lock file (under the host user's cache folder)",
    description:
      "Every heavy instrument — a whole suite, a coverage or browser run, a workspace validation, an ad-hoc load run through `harness slot run` — holds this one lock of the host; a second one waits, naming the holder. Shown read-only.",
    type: "string",
    value: () => {
      const path = readConfigCustomization("testExecution.instrumentLock.cacheRelativeLockPath");
      return typeof path === "string" ? `<cache>/${path}` : NOT_DECLARED;
    },
  });
  registerSignal({
    id: "testExecution.instrumentLockHeavyAt",
    module: "testExecution",
    name: "Test files that make a run heavy",
    description:
      "A run of this many test files or more is heavy and holds the host's instrument lock; a targeted run of fewer takes nothing. Shown read-only.",
    type: "string",
    value: () => {
      const files = readBudgetNumber("testExecution.instrumentLock.minimumTestFiles");
      return files === undefined ? NOT_DECLARED : `a run of ${files} or more test files is heavy`;
    },
  });
  registerSignal({
    id: "testExecution.instrumentLockPoll",
    module: "testExecution",
    name: "How often a waiting heavy run looks at the instrument lock again",
    description:
      "A heavy run that waits for the host's instrument lock looks at it again at this interval (and says who holds it whenever the holder changes). Shown read-only.",
    type: "string",
    value: () => {
      const ms = readBudgetNumber("testExecution.instrumentLock.pollIntervalMs");
      return ms === undefined ? NOT_DECLARED : `a waiting run looks again every ${ms} ms`;
    },
  });
  registerSignal({
    id: "testExecution.instrumentLockWholeInstruments",
    module: "testExecution",
    name: "Instruments that are heavy whatever they run",
    description:
      "These whole instruments hold the host's instrument lock by kind, whatever files they name (the one definition of heavy). Shown read-only: dropping one from a settings write would let it share the cores with a measured run.",
    type: "string",
    value: () => {
      const kinds = readConfigCustomization("testExecution.instrumentLock.wholeInstruments");
      return Array.isArray(kinds) ? `heavy by kind: ${kinds.join(", ")}` : NOT_DECLARED;
    },
  });
  // THE FLAKY-CAUSE REPRODUCTION DOOR's statistical N (`harness flake reproduce
  // --statistical`, FLAKE-REPRO): served read-only — a smaller N written from a
  // settings cookie would let fewer runs explain a flaky suspect.
  registerSignal({
    id: "testExecution.flakeReproductionRuns",
    module: "testExecution",
    name: "Runs on each side of a statistical flake reproduction",
    description:
      "A cause that needs load or a race is reproduced statistically: at least this many runs on each side, the fix passing every one of them, under the same condition. Shown read-only.",
    type: "string",
    value: () => {
      const runs = readBudgetNumber("testExecution.flakeReproduction.statisticalRuns");
      return runs === undefined ? NOT_DECLARED : `${runs} runs on each side of a statistical reproduction`;
    },
  });
  registerSignal({
    id: "testExecution.flakeReproductionSignificance",
    module: "testExecution",
    name: "How strong a flake reproduction must be",
    description:
      "The most probability a reproduction's counts may leave that a fix which changed nothing shows them (one-sided Fisher); the door derives the runs per side a failure rate needs from it. Shown read-only: a settings write that raised it would let a lucky run explain a flaky suspect.",
    type: "string",
    value: () => {
      const significance = readBudgetNumber("testExecution.flakeReproduction.significance");
      return significance === undefined ? NOT_DECLARED : `a reproduction counts only when a no-op fix shows its counts at most ${String(significance)} of the time`;
    },
  });
  registerSignal({
    id: "testExecution.flakeReproductionShims",
    module: "testExecution",
    name: "Preloads whose one run per side is a reproduction",
    description:
      "The deterministic shims: the only preloaded modules whose single failing parent run and single passing fix run count as a reproduction. Shown read-only: a shim added from a settings write would let one run explain a flaky suspect.",
    type: "string",
    value: () => {
      const shims = readConfigCustomization("testExecution.flakeReproduction.deterministicShims");
      return Array.isArray(shims) ? (shims.length === 0 ? "no deterministic shim: every reproduction needs its runs" : `deterministic shims: ${shims.join(", ")}`) : NOT_DECLARED;
    },
  });
  // The web suite's supervisor (`scripts/run-tests.ts`): served read-only,
  // like every other suite-gate number — loosening a stall limit or the
  // hard ceiling from a settings cookie would change what a green run means.
  registerSignal({
    id: "testExecution.webSuiteStallTimeout",
    module: "testExecution",
    name: "Silence after which the web-suite supervisor kills a run",
    description:
      "A synchronous spin cannot be interrupted from inside the runtime, so a process outside it ends a run that has printed nothing for this long — a slow run keeps printing and is never killed. Shown read-only.",
    type: "string",
    value: () => {
      const ms = readBudgetNumber("testExecution.webSuiteWatchdog.stallTimeoutMs");
      return ms === undefined ? NOT_DECLARED : `a run that prints nothing for ${ms / 1000} s is killed`;
    },
  });
  registerSignal({
    id: "testExecution.webSuiteHardCeiling",
    module: "testExecution",
    name: "Hard ceiling at which the web-suite supervisor kills a run",
    description:
      "Whatever the machine's load, a run still going after this long is killed with every process it started, detached ones included — a run that keeps printing forever still ends. Performance is the CPU budget's verdict, not this. Shown read-only.",
    type: "string",
    value: () => {
      const ms = readBudgetNumber("testExecution.webSuiteWatchdog.hardCeilingMs");
      return ms === undefined ? NOT_DECLARED : `a run still going after ${ms / 1000} s is killed`;
    },
  });
  registerSignal({
    id: "testExecution.webSuiteKillGrace",
    module: "testExecution",
    name: "Grace a stopped web-suite run has before it is killed",
    description:
      "A run the supervisor stops (a stall, the ceiling, Ctrl-C, its launcher exiting) is told first (SIGTERM) and gets this long to report on its way out; then it and every process it started are killed. Shown read-only.",
    type: "string",
    value: () => {
      const ms = readBudgetNumber("testExecution.webSuiteWatchdog.killGraceMs");
      return ms === undefined ? NOT_DECLARED : `a stopped run has ${ms / 1000} s before it is killed`;
    },
  });
  // The ENGINE suite's watchdog (`scripts/tooling/inventory-test-run.ts`):
  // served read-only for the same reason as the web suite's.
  registerSignal({
    id: "testExecution.engineSuiteStallTimeout",
    module: "testExecution",
    name: "Silence after which the engine-suite watchdog kills a phase",
    description:
      "A test file whose cancelled test left something open never exits, and the runner would wait for it forever; a phase that reports no test event for this long is aborted, and every file still running is killed and reported failed. Shown read-only.",
    type: "string",
    value: () => engineWatchdogFace("testExecution.engineSuiteWatchdog.stallTimeoutMs", DEFAULT_ENGINE_SUITE_WATCHDOG.stallTimeoutMs, (seconds) => `a phase that reports nothing for ${seconds} s is killed`),
  });
  registerSignal({
    id: "testExecution.engineSuiteHardCeiling",
    module: "testExecution",
    name: "Hard ceiling at which the engine-suite watchdog kills a run",
    description:
      "Whatever the machine's load, an engine test run still going after this long is aborted, and every file still running is killed and reported failed. Performance is the CPU budget's verdict, not this. Shown read-only.",
    type: "string",
    value: () => engineWatchdogFace("testExecution.engineSuiteWatchdog.hardCeilingMs", DEFAULT_ENGINE_SUITE_WATCHDOG.hardCeilingMs, (seconds) => `a run still going after ${seconds} s is killed`),
  });
  registerSignal({
    id: "testExecution.engineSuiteKillGrace",
    module: "testExecution",
    name: "Grace a stopped engine-suite run has before it is killed",
    description:
      "The engine test worker told to stop (its ceiling, Ctrl-C, its launcher exiting) gets this long to abort its test files and report; then it and every process it started are killed. Shown read-only.",
    type: "string",
    value: () => engineWatchdogFace("testExecution.engineSuiteWatchdog.killGraceMs", DEFAULT_ENGINE_SUITE_WATCHDOG.killGraceMs, (seconds) => `a stopped run has ${seconds} s before it is killed`),
  });
  registerSignal({
    id: "testExecution.integrationSuiteBudgetPhase",
    module: "testExecution",
    name: "Phase the engine suite's own CPU budget is in",
    description:
      "The engine suite's budget is either accumulating evidence (every run's CPU reading is recorded, no cap in force) or derived (a cap governs, with its population and spread declared beside it). Shown read-only: the phase and its numbers are the gate's own contract, changed through the config file with the derivation recorded there.",
    type: "string",
    value: () => {
      const budget = readConfigCustomization("testExecution.integrationSuiteCpuBudget");
      if (budget === null || typeof budget !== "object" || Array.isArray(budget)) return NOT_DECLARED;
      const record = budget as Record<string, unknown>;
      if (record.phase === "accumulation") {
        return `accumulation — at least ${String(record.minimumJudgedRuns)} judged runs before the cap is derived`;
      }
      if (record.phase === "derived") {
        return `derived — ${String(record.msPerTestFile)} ms of CPU per test file over ${String(record.derivedAtTestFileCount)} files`;
      }
      return NOT_DECLARED;
    },
  });
}

/** Reset the per-module registration flag (test-only). */
export function resetTestExecutionRegistration(): void {
  testExecutionRegistered = false;
}
