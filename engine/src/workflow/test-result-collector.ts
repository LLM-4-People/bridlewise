import { existsSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { run } from "node:test";
import { z } from "zod";
import { redactForLLMContext } from "../privacy/redaction-engine.ts";

import { canonicalJson, deepFreeze, sha256, type DeepReadonly } from "../kernel/integrity.ts";
import { atomicWriteFile } from "../filesystem/atomic-write.ts";
import { HarnessError, InputError, extractErrorSourceLocation } from "../kernel/errors.ts";
import { bestEffort } from "../shared/best-effort.ts";
import { ROOT_POLICY } from "../kernel/root-policy.ts";
import { loadPinnedConfigSnapshot } from "../kernel/config.ts";
import type { TestExecutionConfig } from "../kernel/config-contracts.ts";
import type { FailureStatement } from "../shared/run-history.ts";
import {
  assertTestInventoryBindingSourceSnapshot,
  assertTestRunMatchesInventory,
  loadTestInventoryBinding,
} from "./test-inventory-binding.ts";

export const TEST_RESULT_COLLECTION_SCHEMA_VERSION = schemaId("test-result-collection", 2);
export const TEST_RESULT_COLLECTION_PATH = statePath("state", "test-results", "latest-collection.json");
export const TEST_RESULT_COLLECTION_DIRECTORY = statePath("state", "test-results");

/**
 * Per-file wall-clock durations observed by the most recent test run,
 * persisted so the next run can schedule the parallel phase longest-first.
 * Lives under the same private state directory as the run summary; the file
 * is a cache — absence or corruption degrades to deterministic path order,
 * never to a failure.
 */
const TEST_FILE_DURATIONS_SCHEMA_VERSION = schemaId("test-file-durations", 1);
export const TEST_FILE_DURATIONS_PATH = statePath("state", "test-results", "file-durations.json");

/**
 * Longest-processing-time-first ordering for parallel lane scheduling:
 * files with a recorded prior duration sort by descending duration; ties
 * and unknown files fall back to ascending path order so the result is
 * fully deterministic for a given durations map.
 */
export function sortTestFilesLongestFirst(
  files: readonly string[],
  durationsMs: ReadonlyMap<string, number>,
): string[] {
  return [...files].sort((left, right) => {
    const delta = (durationsMs.get(right) ?? 0) - (durationsMs.get(left) ?? 0);
    if (delta !== 0) return delta;
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

/**
 * Load per-file durations recorded by the previous run. Primary source is
 * the dedicated durations cache (full file coverage); when it is absent the
 * persisted result collection's `slowestFiles` report (top-20) is mined so
 * `harness test` runs also seed the scheduler. Any read/parse/shape problem
 * yields an empty map — scheduling is an optimization, not a gate.
 */
export function loadPriorTestFileDurations(root: string): ReadonlyMap<string, number> {
  const durations = new Map<string, number>();
  // A missing durations file is the expected state for a fresh workspace (no
  // prior run has written it yet), NOT an error. Check existence first so the
  // expected-absent path does not log an ENOENT best-effort warning to stderr
  // (which would pollute subprocess stderr contracts that assert stderr is
  // empty).
  if (existsSync(resolve(root, TEST_FILE_DURATIONS_PATH))) {
    bestEffort(() => {
      const parsed: unknown = JSON.parse(readFileSync(resolve(root, TEST_FILE_DURATIONS_PATH), "utf8"));
      if (typeof parsed === "object" && parsed !== null &&
        (parsed as Record<string, unknown>).schemaVersion === TEST_FILE_DURATIONS_SCHEMA_VERSION &&
        Array.isArray((parsed as Record<string, unknown>).files)) {
        for (const entry of (parsed as { files: unknown[] }).files) {
          if (typeof entry === "object" && entry !== null) {
            const record = entry as Record<string, unknown>;
            if (typeof record.file === "string" && typeof record.durationMs === "number" &&
              Number.isFinite(record.durationMs) && record.durationMs >= 0) {
              durations.set(record.file, record.durationMs);
            }
          }
        }
      }
    });
  }
  if (durations.size > 0) return durations;
  if (existsSync(resolve(root, TEST_RESULT_COLLECTION_PATH))) {
    bestEffort(() => {
      const collection = parseTestResultCollection(
        JSON.parse(readFileSync(resolve(root, TEST_RESULT_COLLECTION_PATH), "utf8")),
      );
      for (const entry of collection.summary.slowestFiles) durations.set(entry.file, entry.durationMs);
    });
  }
  return durations;
}

/**
 * Persist the per-file durations observed during a run for consumption by
 * the next run's longest-first scheduler. Deterministic content: entries
 * are de-duplicated by path (last wins) and sorted by path so identical
 * observations produce identical bytes.
 */
export function writeTestFileDurations(
  root: string,
  durations: readonly TestFileDuration[],
  filePath: string = TEST_FILE_DURATIONS_PATH,
): string {
  const absolutePath = isAbsolute(filePath) ? filePath : resolve(root, filePath);
  const directory = absolutePath.slice(0, absolutePath.lastIndexOf(sep));
  ensurePrivateStateDirectory(directory);
  // Merge with prior durations rather than replacing them, so a partial run
  // (a single file, a subset under `node --test`) does not erase the timings
  // the scheduler uses for every other file. Files measured this pass
  // overwrite their prior entry; the rest keep theirs; entries for deleted
  // files are harmless, since only the current inventory is ever scheduled.
  //
  // This cache is now a SCHEDULING input only. It used to decide which files
  // ran at all, which made a gitignored file the difference between two
  // machines running different suites and both calling it passed.
  const byPath = new Map<string, number>();
  for (const [file, durationMs] of loadPriorTestFileDurations(root)) byPath.set(file, durationMs);
  for (const entry of durations) byPath.set(entry.file, entry.durationMs);
  const files = [...byPath.entries()]
    .map(([file, durationMs]) => ({ file, durationMs }))
    .toSorted((left, right) => left.file < right.file ? -1 : left.file > right.file ? 1 : 0);
  const content = `${canonicalJson({ schemaVersion: TEST_FILE_DURATIONS_SCHEMA_VERSION, files })}\n`;
  const result = atomicWriteFile(absolutePath, content);
  if (!result.success) {
    throw new HarnessError(`Failed to write test file durations to ${absolutePath}: ${result.reason ?? "unknown error"}`, "test_file_durations_write_failed");
  }
  return absolutePath;
}

export type TestResultStatus = "pass" | "fail" | "skip" | "cancel" | "todo";

// Both test runners project native failures through this schema/owner.
// Known diagnostic fields only: arbitrary assertion payloads never enter a
// receipt, and diagnostic text passes the canonical secret redactor.
const TEST_ERROR_CAUSE_SCHEMA = z.strictObject({
  name: z.string().nullable(),
  code: z.string().nullable(),
  failureType: z.string().nullable(),
  message: z.string(),
  stack: z.string(),
  failureFile: z.string().nullable(),
  failureLine: z.number().int().nonnegative().nullable(),
  failureColumn: z.number().int().nonnegative().nullable(),
  assertion: z.string().nullable(),
});
export const TEST_RESULT_ERROR_SCHEMA = TEST_ERROR_CAUSE_SCHEMA.extend({
  /** Legacy first-cause message; derived from the same native cause chain. */
  cause: z.string().nullable(),
  /** Native nested Error causes in outer-to-inner order; cycles terminate. */
  causes: z.array(TEST_ERROR_CAUSE_SCHEMA),
});
export type TestResultError = DeepReadonly<z.infer<typeof TEST_RESULT_ERROR_SCHEMA>>;

export type TestResultEntry = Readonly<{
  name: string;
  file: string;
  status: TestResultStatus;
  error: TestResultError | null;
  durationMs: number;
  line: number | null;
  column: number | null;
}>;

export type TestFileDuration = Readonly<{
  file: string;
  durationMs: number;
}>;

export type TestResultSummary = Readonly<{
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  todo: number;
  cancelled: number;
  durationMs: number;
  slowestFiles: readonly TestFileDuration[];
}>;

export type ConcurrencyReport = Readonly<{
  mode: "auto";
  parallel: readonly string[];
  serial: readonly string[];
  serialReasons: Readonly<Record<string, readonly string[]>>;
  parallelConcurrency: number;
}>;

export type TestResultCollection = Readonly<{
  schemaVersion: typeof TEST_RESULT_COLLECTION_SCHEMA_VERSION;
  status: "passed" | "failed";
  summary: TestResultSummary;
  tests: readonly TestResultEntry[];
  generatedAt: string;
  concurrencyReport: ConcurrencyReport | null;
  integrityHash: string;
  deterministicHash: string;
}>;

type TestEvent = Readonly<{
  type: string;
  data?: Readonly<{
    name?: string;
    file?: string;
    skip?: unknown;
    todo?: unknown;
    success?: unknown;
    line?: number;
    column?: number;
    duration_ms?: number;
    details?: Readonly<{
      duration_ms?: number;
      error?: unknown;
    }>;
    counts?: Readonly<{
      tests?: unknown;
      failed?: unknown;
      passed?: unknown;
      cancelled?: unknown;
      skipped?: unknown;
      todo?: unknown;
    }>;
  }>;
}>;

export type TestResultCollector = Readonly<{
  observe: (event: TestEvent) => void;
  complete: (root: string, concurrencyReport?: ConcurrencyReport | null) => TestResultCollection;
}>;

export type ConcurrencyMode = boolean | number | "auto";

export type CollectTestResultsOptions = Readonly<{
  files?: readonly string[];
  concurrency?: ConcurrencyMode;
  parallelConcurrency?: number;
  fullSuiteParallelConcurrency?: number;
  /**
   * Concurrency for the serial phase. 1 (or undefined) preserves the
   * original fully sequential behavior; values >1 run that many serial
   * files at once. See {@link InventoryTestRunOptions.serialPhaseConcurrency}
   * in `scripts/inventory-test-run.ts` for the rationale.
   */
  serialPhaseConcurrency?: number;
  /**
   * When true, the run is bound to the pinned test inventory: the inventory
   * source snapshot is asserted before and after execution, the executed file
   * list is derived from the inventory (not from a filesystem walk), and the
   * executed tests are reconciled against the inventoried identities so a
   * dynamically-disappearing, duplicated, or un-inventoried test fails the
   * command. Binding requires a full-suite run; it cannot be combined with
   * `files`.
   */
  inventoryBinding?: boolean;
}>;

/**
 * Resolve the central config document's `testExecution` section into the
 * {@link CollectTestResultsOptions} consumed by {@link collectTestResults}.
 *
 * Single owner of the testExecution→collectTestResults wiring so `harness test`
 * and `scripts/test-worker.ts` cannot drift. The pinned config snapshot is
 * repository-scoped: when `root` does not match the snapshot's
 * `repositoryRoot` (e.g. a temp dir in tests), the function returns `{}` so
 * a foreign config is never applied. A configuration the loader REFUSES
 * (an alternate `*.config.json` beside the real one, an unsafe link, a mode
 * or identity violation) propagates: it used to be caught here and answered
 * with the defaults, so a stray config document silently dropped every
 * declared concurrency, budget and pruning value from `npm test`.
 */
export function readTestExecutionConfig(root: string): Readonly<{
  concurrency?: ConcurrencyMode;
  parallelConcurrency?: number;
  fullSuiteParallelConcurrency?: number;
  runtimeBudgetMs: number;
  /** The engine suite's stall/ceiling watchdog (see `DEFAULT_ENGINE_SUITE_WATCHDOG`). */
  engineSuiteWatchdog: SuiteWatchdog;
  serialPhaseConcurrency: number;
  fullSuiteSerialPhaseConcurrency: number;
  fullSuiteInProcessSerialPhaseConcurrency: number;
  /**
   * The integration suite's CPU budget declaration — either the accumulation
   * phase or a derived cap (see the schema owner). DELIBERATELY NO DEFAULT:
   * a budget nobody chose is not a budget, so an absent declaration reaches
   * the gate as absent and the gate says so loudly (not-judged) instead of
   * judging against a number no operator ever set. This is what replaced
   * `suiteRuntimeBudgetMs`, whose silent 120s default was exactly that
   * defect wearing a wall clock.
   */
  integrationSuiteCpuBudget?: TestExecutionConfig["integrationSuiteCpuBudget"];
  /**
   * The compile-cache pruning policy — same no-default discipline as the
   * budget above: absent means the runner prints that no bound is declared
   * and prunes nothing, never a guessed bound.
   */
  compileCachePruning?: TestExecutionConfig["compileCachePruning"];
  /** The host's one instrument lock (src/process/instrument-lock.ts); absent only for a foreign root: a heavy run refuses to start. */
  instrumentLock?: TestExecutionConfig["instrumentLock"];
  /** The flaky-cause reproduction door's statistical N (src/workflow/flake-cli.ts); absent only for a foreign root: a statistical reproduction refuses. */
  flakeReproduction?: TestExecutionConfig["flakeReproduction"];
}> {
  // The numeric defaults are ALWAYS present: they are the answer for a
  // foreign root and for keys the document leaves undeclared, and the
  // snapshot OVERRIDES them. They are never the answer to a REFUSED snapshot:
  // `loadPinnedConfigSnapshot` refusing is a finding the caller must see, so
  // it propagates rather than degrading the run to values nobody chose.
  const defaults = {
    runtimeBudgetMs: DEFAULT_TEST_RUNTIME_BUDGET_MS,
    engineSuiteWatchdog: DEFAULT_ENGINE_SUITE_WATCHDOG,
    serialPhaseConcurrency: DEFAULT_SERIAL_PHASE_CONCURRENCY,
    fullSuiteSerialPhaseConcurrency: DEFAULT_FULL_SUITE_SERIAL_PHASE_CONCURRENCY,
    fullSuiteInProcessSerialPhaseConcurrency: DEFAULT_FULL_SUITE_IN_PROCESS_SERIAL_PHASE_CONCURRENCY,
  };
  const snapshot = loadPinnedConfigSnapshot();
  if (resolve(snapshot.repositoryRoot) !== resolve(root)) return deepFreeze(defaults);
  const testExecution = snapshot.document.testExecution;
  if (testExecution === undefined) return deepFreeze(defaults);
  return deepFreeze({
    ...defaults,
    concurrency: testExecution.concurrency,
    ...(testExecution.parallelConcurrency !== undefined
      ? { parallelConcurrency: testExecution.parallelConcurrency }
      : {}),
    ...(testExecution.fullSuiteParallelConcurrency !== undefined
      ? { fullSuiteParallelConcurrency: testExecution.fullSuiteParallelConcurrency }
      : {}),
    runtimeBudgetMs: testExecution.runtimeBudgetMs ?? DEFAULT_TEST_RUNTIME_BUDGET_MS,
    engineSuiteWatchdog: testExecution.engineSuiteWatchdog ?? DEFAULT_ENGINE_SUITE_WATCHDOG,
    serialPhaseConcurrency: testExecution.serialPhaseConcurrency ?? DEFAULT_SERIAL_PHASE_CONCURRENCY,
    fullSuiteSerialPhaseConcurrency: testExecution.fullSuiteSerialPhaseConcurrency ?? DEFAULT_FULL_SUITE_SERIAL_PHASE_CONCURRENCY,
    fullSuiteInProcessSerialPhaseConcurrency: testExecution.fullSuiteInProcessSerialPhaseConcurrency ?? DEFAULT_FULL_SUITE_IN_PROCESS_SERIAL_PHASE_CONCURRENCY,
    // No `?? default` here, deliberately — see the field's own comment.
    ...(testExecution.integrationSuiteCpuBudget !== undefined
      ? { integrationSuiteCpuBudget: testExecution.integrationSuiteCpuBudget }
      : {}),
    // Same discipline: absent stays absent (the runner prints the note).
    ...(testExecution.compileCachePruning !== undefined
      ? { compileCachePruning: testExecution.compileCachePruning }
      : {}),
    instrumentLock: testExecution.instrumentLock,
    flakeReproduction: testExecution.flakeReproduction,
  });
}

// `classifySlowTestFiles` used to live here: given the per-file durations
// cache and a threshold, it named the files the default suite would not
// dispatch. It is deleted rather than left unused, because the set it
// produced was subtracted from the expected count instead of being reported
// as skipped, and a run that never dispatched 696 tests still called itself
// passed. Nothing computes a withheld set now, so nothing can subtract one.
// The durations themselves are still read — by `sortTestFilesLongestFirst`
// and the serial-tier split, which change the ORDER files run in and never
// which files run.

export type ConcurrencyMarker = Readonly<{
  id: string;
  pattern: RegExp;
}>;

export type ConcurrencyClassification = Readonly<{
  parallel: readonly string[];
  serial: readonly string[];
  serialReasons: Readonly<Record<string, readonly string[]>>;
}>;

export const SHARED_RESOURCE_MARKERS: readonly ConcurrencyMarker[] = deepFreeze([
  { id: "evidence-worker", pattern: /runWorkerWithEvidence|runTestsWithEvidence|runCheckWithEvidence|runPlannedNodeTestSuiteWithEvidence/u },
  { id: "execution-operation", pattern: /TEST_EXECUTION_OPERATION|CHECK_EXECUTION_OPERATION/u },
  { id: "evidence-session-import", pattern: /planned-node-test-evidence/u },
  // The runner module moved under scripts/tooling/; match it by path at any
  // depth below scripts/ (`scripts/run-tests`, `scripts/tooling/run-tests.ts`,
  // `../scripts/tooling/run-tests.ts`) — never the bare basename (a
  // `run-tests.spec` or a `run-check` is a different module). The leading
  // boundary accepts start-of-string or any path/space delimiter.
  { id: "test-runner-import", pattern: /(?:^|[\s/.])scripts(?:\/[\w.-]+)*\/run-tests\b/u },
  // Tests that run harnessRegenerate/harnessRegister/harnessCheck against the
  // live repository ROOT read every src/*.ts and compute every binding. They
  // are deterministic only when no parallel test is mutating the repo. Mark
  // them serial so they run in the serial phase (after parallel tests finish)
  // and never race with repo-mutating parallel tests.
  { id: "harness-live-root", pattern: /harnessRegenerate\(ROOT|harnessRegister\(ROOT|harnessCheck\(ROOT/u },
  // S1 scenario + forensics tests call verifyS1Structure / makeRuntimeCandidate
  // which walk the ENTIRE repository tree and copy it to temp dirs. Under 8-way
  // parallel load these CPU/IO-heavy operations contend for resources, causing
  // the slowest files (S1-B08-FAILURE ~95s, S1-B02-FAILURE ~43s) to exceed
  // their budget and fail. Marking them serial gives each file full system
  // resources in the serial phase (after parallel tests finish).
  { id: "s1-verification-root", pattern: /verifyS1Structure\(|makeRuntimeCandidate\(/u },
  // A preflight context BINDS THE LIVE REPOSITORY: it canonicalises the root,
  // reads the pinned policy and authenticates against the tree as it stands.
  // Every one of those is a statement about a repository nobody is writing to,
  // so the file is deterministic alone and intermittent beside a parallel test
  // that touches the root. Observed exactly that way — `inspectPath allows the
  // repository root`, then `inspectPath allows a real file (package.json)`,
  // one per run, never the same one twice, all passing in isolation. It became
  // visible when the suite stopped withholding files and the parallel phase
  // grew; the race was always there and the smaller phase was hiding it.
  //
  // A PATTERN rather than a filename, like every marker above: a future test
  // that binds a preflight context is classified because of what it does, not
  // because somebody remembered to add it to a list.
  { id: "preflight-live-root", pattern: /createPreflightContext\(/u },
] as const);

// Markers that detect subprocess spawning within a serial file. A serial file
// that matches any of these causes real OS subprocess creation (directly or via
// the evidence pipeline) and must run at a LOWER concurrency than in-process
// serial files to avoid subprocess oversubscription. The classification is
// DYNAMIC (a source scan, not a hardcoded file list) so a file that grows
// subprocess usage is automatically reclassified.
export const SUBPROCESS_SPAWNING_MARKERS: readonly ConcurrencyMarker[] = deepFreeze([
  // Direct subprocess spawning via node:child_process import
  { id: "child-process-import", pattern: /from\s+["'`"]node:child_process["'`"]/u },
  // Direct spawn/exec calls (function-call form, not bare identifier refs)
  { id: "subprocess-spawn-call", pattern: /\bspawnSync\s*\(|\bexecSync\s*\(|\bexecFileSync\s*\(/u },
  // Evidence pipeline spawns a real node subprocess via runRecordedCommand
  { id: "evidence-pipeline", pattern: /runPlannedNodeTestSuiteWithEvidence|runWorkerWithEvidence|runTestsWithEvidence|runCheckWithEvidence/u },
] as const);

export type SerialConcurrencyTier = Readonly<{
  inProcess: readonly string[];
  subprocessSpawning: readonly string[];
}>;

/**
 * Classify serial files into two concurrency tiers based on whether they
 * spawn subprocesses. Files that import node:child_process, call
 * spawnSync/execSync/execFileSync, or use the evidence pipeline (which spawns
 * a real node subprocess) go to the subprocess-spawning tier (lower
 * concurrency to avoid oversubscription). Files that only do in-process work
 * (verifyS1Structure Babel parsing, makeRuntimeCandidate file copies,
 * architecture scans) go to the in-process tier (higher concurrency is safe).
 *
 * Dynamic discovery (no hardcoded file list): a file that gains subprocess
 * usage is automatically reclassified on the next run.
 */
export function classifySerialConcurrencyTier(
  files: readonly string[],
  root: string,
  markers: readonly ConcurrencyMarker[] = SUBPROCESS_SPAWNING_MARKERS,
): SerialConcurrencyTier {
  if (!Array.isArray(files)) {
    throw new InputError("files must be an array", "input_error");
  }
  const inProcess: string[] = [];
  const subprocessSpawning: string[] = [];
  for (const file of files) {
    if (typeof file !== "string" || file.length === 0) {
      throw new InputError("file path must be a non-empty string", "input_error");
    }
    const absolute = isAbsolute(file) ? file : resolve(root, file);
    const relativePath = relative(resolve(root), absolute).replaceAll("\\", "/");
    let source: string;
    try {
      source = readFileSync(absolute, "utf8");
    } catch (e) {
      handleError(e, { module: "workflow-test-result-collector", operation: "classify-serial-concurrency-tier" });
      // An unreadable serial file is conservatively placed in the
      // subprocess-spawning tier (lower concurrency, safer if it does spawn).
      subprocessSpawning.push(relativePath);
      continue;
    }
    let spawns = false;
    for (const marker of markers) {
      if (marker.pattern.test(source)) {
        spawns = true;
        break;
      }
    }
    if (spawns) {
      subprocessSpawning.push(relativePath);
    } else {
      inProcess.push(relativePath);
    }
  }
  return deepFreeze({
    inProcess: deepFreeze(inProcess.toSorted()),
    subprocessSpawning: deepFreeze(subprocessSpawning.toSorted()),
  });
}

export type SerialPhaseSpec = Readonly<{
  files: readonly string[];
  concurrency: boolean | number;
  isolation?: "process";
}>;

/**
 * Build the serial phase list split into two tiers: in-process files at a
 * higher concurrency (no subprocess oversubscription) and subprocess-spawning
 * files at a lower concurrency. Both tiers use process isolation when
 * concurrency > 1. The tiers run sequentially within the serial phase (after
 * the parallel phase) to avoid cross-tier CPU contention.
 *
 * This is the single shared owner of the two-tier serial-phase construction so
 * `executeInventoryTestRun` (npm test) and `collectTestResults` (harness test)
 * cannot drift. Returns an empty array when there are no serial files.
 */
export function buildSerialPhases(
  serialFiles: readonly string[],
  root: string,
  priorDurations: ReadonlyMap<string, number>,
  options: Readonly<{
    inProcessConcurrency: number;
    subprocessConcurrency: number;
    isolation: "process" | undefined;
  }>,
): readonly SerialPhaseSpec[] {
  const tier = classifySerialConcurrencyTier(serialFiles, root);
  const phases: SerialPhaseSpec[] = [];
  if (tier.inProcess.length > 0) {
    const concurrency = options.inProcessConcurrency <= 1 ? false : options.inProcessConcurrency;
    phases.push({
      files: deepFreeze(sortTestFilesLongestFirst(tier.inProcess, priorDurations).map((file) => resolve(root, file))),
      concurrency,
      ...(options.isolation !== undefined && concurrency !== false ? { isolation: options.isolation } : {}),
    });
  }
  if (tier.subprocessSpawning.length > 0) {
    const concurrency = options.subprocessConcurrency <= 1 ? false : options.subprocessConcurrency;
    phases.push({
      files: deepFreeze(sortTestFilesLongestFirst(tier.subprocessSpawning, priorDurations).map((file) => resolve(root, file))),
      concurrency,
      ...(options.isolation !== undefined && concurrency !== false ? { isolation: options.isolation } : {}),
    });
  }
  return deepFreeze(phases);
}
export { MAXIMUM_PARALLEL_CONCURRENCY, MINIMUM_PARALLEL_CONCURRENCY, DEFAULT_SERIAL_PHASE_CONCURRENCY, DEFAULT_FULL_SUITE_SERIAL_PHASE_CONCURRENCY, DEFAULT_FULL_SUITE_IN_PROCESS_SERIAL_PHASE_CONCURRENCY, DEFAULT_FULL_SUITE_PARALLEL_CONCURRENCY } from "./workflow-config.ts";

import { numericOption, MAXIMUM_PARALLEL_CONCURRENCY, MINIMUM_PARALLEL_CONCURRENCY, DEFAULT_ASSERTION_VALUE_MAX_LENGTH, DEFAULT_ENGINE_SUITE_WATCHDOG, DEFAULT_TEST_RUNTIME_BUDGET_MS, DEFAULT_SERIAL_PHASE_CONCURRENCY, DEFAULT_FULL_SUITE_SERIAL_PHASE_CONCURRENCY, DEFAULT_FULL_SUITE_IN_PROCESS_SERIAL_PHASE_CONCURRENCY, type SuiteWatchdog } from "./workflow-config.ts";
import { handleError } from "../shared/debug/debug-system.ts";
import { schemaId, statePath } from "../kernel/product-identity.ts";
import { ensurePrivateStateDirectory } from "../filesystem/private-state.ts";

/**
 * Default parallelism for the auto-concurrency parallel phase, derived from
 * the host's available parallelism and clamped to [2, 16]: at least two lanes
 * to keep the phase meaningful on small hosts, at most sixteen so test
 * subprocesses do not oversubscribe larger machines. The central config
 * (`testExecution.parallelConcurrency`) overrides this when declared.
 */
export function resolveDefaultParallelConcurrency(): number {
  return Math.min(MAXIMUM_PARALLEL_CONCURRENCY, Math.max(MINIMUM_PARALLEL_CONCURRENCY, availableParallelism()));
}

export function classifyTestConcurrency(
  files: readonly string[],
  root: string,
  markers: readonly ConcurrencyMarker[] = SHARED_RESOURCE_MARKERS,
): ConcurrencyClassification {
  if (!Array.isArray(files)) {
    throw new InputError("files must be an array", "input_error");
  }
  const parallel: string[] = [];
  const serial: string[] = [];
  const serialReasons: Record<string, readonly string[]> = {};
  for (const file of files) {
    if (typeof file !== "string" || file.length === 0) {
      throw new InputError("file path must be a non-empty string", "input_error");
    }
    const absolute = isAbsolute(file) ? file : resolve(root, file);
    const relativePath = relative(resolve(root), absolute).replaceAll("\\", "/");
    let source: string;
    try {
      source = readFileSync(absolute, "utf8");
    } catch (e) {handleError(e, { module: "workflow-test-result-collector", operation: "catch" });
      serial.push(relativePath);
      serialReasons[relativePath] = ["unreadable-source"];
      continue;
    }
    const reasons: string[] = [];
    for (const marker of markers) {
      if (marker.pattern.test(source)) {
        reasons.push(marker.id);
      }
    }
    if (reasons.length === 0) {
      parallel.push(relativePath);
    } else {
      serial.push(relativePath);
      serialReasons[relativePath] = deepFreeze(reasons);
    }
  }
  return deepFreeze({
    parallel: deepFreeze(parallel.toSorted()),
    serial: deepFreeze(serial.toSorted()),
    serialReasons: deepFreeze(serialReasons),
  });
}

export function createTestResultCollector(): TestResultCollector {
  const entries: TestResultEntry[] = [];
  const fileSummaryDurations = new Map<string, number>();
  let totalDurationMs = 0;
  let summaryDurationMs = 0;
  let summaryCount = 0;
  let allSummariesSuccess = true;

  const observe = (event: TestEvent): void => {
    if (event.type === "test:pass" || event.type === "test:fail" || event.type === "test:cancel") {
      const data = event.data;
      if (!data?.name || !data.file) return;
      const status: TestResultStatus = event.type === "test:pass"
        ? (data.skip !== undefined ? "skip" : data.todo !== undefined ? "todo" : "pass")
        : event.type === "test:fail"
          ? (data.todo !== undefined ? "todo" : isCancelledTestFailure(data.details?.error) ? "cancel" : "fail")
          : "cancel";
      const durationMs = typeof data.details?.duration_ms === "number" ? data.details.duration_ms : 0;
      if (status !== "skip" && status !== "todo") totalDurationMs += durationMs;
      const error = status === "fail" || status === "cancel" ? extractTestResultError(data.details?.error) : null;
      entries.push(deepFreeze({
        name: data.name,
        file: data.file,
        status,
        error,
        durationMs,
        line: typeof data.line === "number" ? data.line : null,
        column: typeof data.column === "number" ? data.column : null,
      }));
    }
    if (event.type === "test:summary" && event.data?.file !== undefined) {
      // Per-file summary: carries the file's wall-clock duration. This is the
      // primary per-file duration source for the slowestFiles report. The
      // duration lives at data.duration_ms (top level), not
      // data.details.duration_ms (which is per-test, not per-file).
      const durationMs = typeof event.data.duration_ms === "number"
        ? event.data.duration_ms
        : (typeof event.data.details?.duration_ms === "number" ? event.data.details.duration_ms : 0);
      fileSummaryDurations.set(event.data.file, durationMs);
    }
    if (event.type === "test:summary" && event.data?.file === undefined) {
      summaryCount += 1;
      if (event.data?.success !== true) allSummariesSuccess = false;
      const globalDurationMs = typeof event.data?.duration_ms === "number"
        ? event.data.duration_ms
        : event.data?.details?.duration_ms;
      if (typeof globalDurationMs === "number") {
        summaryDurationMs += globalDurationMs;
      }
    }
  };

  const complete = (root: string, concurrencyReport: ConcurrencyReport | null = null): TestResultCollection => {
    const tests = entries.map((entry) => ({
      ...entry,
      file: normalizeFile(root, entry.file),
      error: entry.error === null || entry.error.failureFile === null
        ? entry.error
        : deepFreeze({ ...entry.error, failureFile: normalizeFile(root, entry.error.failureFile) }),
    }));
    const passed = tests.filter((entry) => entry.status === "pass").length;
    const failed = tests.filter((entry) => entry.status === "fail").length;
    const skipped = tests.filter((entry) => entry.status === "skip").length;
    const todo = tests.filter((entry) => entry.status === "todo").length;
    const cancelled = tests.filter((entry) => entry.status === "cancel").length;
    const total = tests.length;
    const durationMs = summaryCount > 0 && summaryDurationMs > 0 ? summaryDurationMs : totalDurationMs;
    const status: "passed" | "failed" = summaryCount > 0
      ? (allSummariesSuccess && failed === 0 ? "passed" : "failed")
      : (failed === 0 ? "passed" : "failed");
    // Deterministic hash: excludes timestamps and durations which vary
    // between runs. Covers test names, files, statuses, error messages,
    // and summary counts (passed/failed/cancelled/skipped/todo) only.
    const deterministicTests = tests
      .map((entry) => ({
        name: entry.name,
        file: entry.file,
        status: entry.status,
        error: entry.error === null ? null : { message: entry.error.message },
      }))
      .toSorted((left, right) => {
        if (left.file < right.file) return -1;
        if (left.file > right.file) return 1;
        if (left.name < right.name) return -1;
        if (left.name > right.name) return 1;
        return 0;
      });
    const deterministicInput = {
      tests: deterministicTests,
      summary: { passed, failed, cancelled, skipped, todo },
    };
    const deterministicHash = sha256(canonicalJson(deterministicInput));
    // slowestFiles is derived from per-file durations (wall-clock from the
    // per-file test:summary events; falling back to summed per-test durations
    // when no per-file summary was observed). Durations vary between runs, so
    // this list is intentionally EXCLUDED from deterministicHash above.
    const durationsByFile = new Map<string, number>();
    if (fileSummaryDurations.size > 0) {
      for (const [file, durationMs] of fileSummaryDurations) {
        durationsByFile.set(normalizeFile(root, file), durationMs);
      }
    } else {
      for (const entry of tests) {
        durationsByFile.set(entry.file, (durationsByFile.get(entry.file) ?? 0) + entry.durationMs);
      }
    }
    const slowestFiles = [...durationsByFile.entries()]
      .map(([file, durationMs]) => deepFreeze({ file, durationMs }))
      .toSorted((left, right) => right.durationMs - left.durationMs || left.file.localeCompare(right.file))
      .slice(0, 20);
    const unsigned = {
      schemaVersion: TEST_RESULT_COLLECTION_SCHEMA_VERSION,
      status,
      summary: deepFreeze({ total, passed, failed, skipped, todo, cancelled, durationMs, slowestFiles: deepFreeze(slowestFiles) }),
      tests: deepFreeze(tests),
      generatedAt: new Date().toISOString(),
      concurrencyReport,
      deterministicHash,
    } as const;
    return deepFreeze({ ...unsigned, integrityHash: sha256(canonicalJson(unsigned)) } as TestResultCollection);
  };

  return Object.freeze({ observe, complete });
}

export async function collectTestResults(
  root: string,
  options: CollectTestResultsOptions = {},
): Promise<TestResultCollection> {
  if (typeof root !== "string" || root.length === 0) {
    throw new InputError("root must be a non-empty string", "input_error");
  }
  const inventoryBinding = options.inventoryBinding === true
    ? loadAndAssertInventoryBinding(root, options.files)
    : null;
  const collector = createTestResultCollector();
  const resolvedFiles = options.files !== undefined
    ? resolveFileList(root, options.files)
    : inventoryBinding !== null
      ? inventoryBinding.sourceIds.map((sourceId) => resolve(root, sourceId))
      : await discoverTestFiles(root);
  const concurrency = options.concurrency ?? false;
  if (concurrency === "auto") {
    const classification = classifyTestConcurrency(resolvedFiles, root);
    const parallelConcurrency = numericOption(
      options.parallelConcurrency,
      resolveDefaultParallelConcurrency(),
      "parallelConcurrency",
      "positive",
    );
    // Longest-first (LPT) scheduling of the parallel phase using durations
    // persisted by the previous run; see executeInventoryTestRun.
    const priorDurations = loadPriorTestFileDurations(root);
    const serialPhaseConcurrency = options.serialPhaseConcurrency ?? 1;
    const serialStreamConcurrency: boolean | number = serialPhaseConcurrency <= 1 ? false : serialPhaseConcurrency;
    const phases: { files: readonly string[]; concurrency: boolean | number; isolation?: "process" }[] = [];
    if (classification.parallel.length > 0) {
      phases.push({
        files: sortTestFilesLongestFirst(classification.parallel, priorDurations).map((file) => resolve(root, file)),
        concurrency: parallelConcurrency,
        isolation: "process",
      });
    }
    if (classification.serial.length > 0) {
      // Two-tier serial model: in-process serial files (no subprocess spawning)
      // and subprocess-spawning serial files run as separate tiers. When the
      // concurrency is 1 (sequential), both tiers collapse into a single
      // sequential phase. The shared buildSerialPhases owner prevents drift
      // between this path (harness test) and executeInventoryTestRun (npm test).
      const serialPhases = buildSerialPhases(classification.serial, root, priorDurations, {
        inProcessConcurrency: serialPhaseConcurrency,
        subprocessConcurrency: serialPhaseConcurrency,
        isolation: serialStreamConcurrency === false ? undefined : "process",
      });
      for (const phase of serialPhases) {
        phases.push({
          files: phase.files,
          concurrency: phase.concurrency,
          ...(phase.isolation !== undefined ? { isolation: phase.isolation } : {}),
        });
      }
    }
    const drain = async (phase: { files: readonly string[]; concurrency: boolean | number; isolation?: "process" }): Promise<void> => {
      if (phase.files.length === 0) return;
      const stream = run({ cwd: root, files: phase.files, concurrency: phase.concurrency, ...(phase.isolation !== undefined ? { isolation: phase.isolation } : {}) });
      for await (const value of stream) {
        collector.observe(normalizeTestEvent(value));
      }
    };
    // Run phases sequentially (parallel first, then serial). The serial phase
    // exists because its files share process-level resources; running it
    // concurrently with the parallel phase contradicts the marker's intent
    // and causes I/O contention. This mirrors executeInventoryTestRun.
    for (const phase of phases) {
      await drain(phase);
    }
    const report: ConcurrencyReport = deepFreeze({
      mode: "auto",
      parallel: classification.parallel,
      serial: classification.serial,
      serialReasons: classification.serialReasons,
      parallelConcurrency,
    });
    return completeBound(root, collector, inventoryBinding, report);
  }
  const streamConcurrency: boolean | number = concurrency as boolean | number;
  const stream = run({ cwd: root, files: resolvedFiles, concurrency: streamConcurrency });
  for await (const value of stream) {
    collector.observe(normalizeTestEvent(value));
  }
  return completeBound(root, collector, inventoryBinding, null);
}

function loadAndAssertInventoryBinding(
  root: string,
  files: readonly string[] | undefined,
): ReturnType<typeof loadTestInventoryBinding> {
  if (files !== undefined) {
    throw new InputError("inventoryBinding cannot be combined with an explicit files list", "input_error");
  }
  const binding = loadTestInventoryBinding(root);
  assertTestInventoryBindingSourceSnapshot(root, binding);
  return binding;
}

function completeBound(
  root: string,
  collector: TestResultCollector,
  inventoryBinding: ReturnType<typeof loadTestInventoryBinding> | null,
  concurrencyReport: ConcurrencyReport | null,
): TestResultCollection {
  const collection = collector.complete(root, concurrencyReport);
  if (inventoryBinding !== null) {
    assertTestInventoryBindingSourceSnapshot(root, inventoryBinding);
    assertTestRunMatchesInventory(root, inventoryBinding, collection);
  }
  return collection;
}

function resolveFileList(root: string, files: readonly string[]): string[] {
  if (!Array.isArray(files) || files.length === 0) {
    throw new InputError("files must be a non-empty array", "input_error");
  }
  return files.map((file) => {
    if (typeof file !== "string" || file.length === 0) {
      throw new InputError("file path must be a non-empty string", "input_error");
    }
    return isAbsolute(file) ? file : resolve(root, file);
  });
}

export function writeTestResultCollection(
  collection: TestResultCollection,
  root: string,
  filePath: string = TEST_RESULT_COLLECTION_PATH,
): string {
  const absolutePath = isAbsolute(filePath) ? filePath : resolve(root, filePath);
  const directory = absolutePath.slice(0, absolutePath.lastIndexOf(sep));
  ensurePrivateStateDirectory(directory);
  const content = `${canonicalJson(collection)}\n`;
  const result = atomicWriteFile(absolutePath, content);
  if (!result.success) {
    throw new HarnessError(`Failed to write test result collection to ${absolutePath}: ${result.reason ?? "unknown error"}`, "test_result_write_failed");
  }
  return absolutePath;
}

/**
 * Schema version for the automatic test-run summary written by `npm test`.
 * Distinct from {@link TEST_RESULT_COLLECTION_SCHEMA_VERSION} (which is the
 * canonical collection produced by `collectTestResults`/`harness test`) so
 * consumers can distinguish the two formats by schema version.
 */
export const TEST_RUN_SUMMARY_SCHEMA_VERSION = schemaId("test-run-summary", 1);
export const TEST_RUN_SUMMARY_PATH = statePath("state", "test-results", "latest-summary.json");

export type TestRunSummary = Readonly<{
  schemaVersion: typeof TEST_RUN_SUMMARY_SCHEMA_VERSION;
  resultIntegrityHash: string;
  deterministicHash: string;
  status: "passed" | "failed";
  exitCode: 0 | 1;
  failures: readonly string[];
  reasons: readonly string[];
  timestamp: string;
  testCount: number;
  passCount: number;
  failCount: number;
  /**
   * Wall-clock duration of the full `npm test` run in milliseconds, measured
   * by `scripts/run-tests.ts` around the test-worker subprocess. RECORDED
   * AND REPORTED, NEVER JUDGED: the suite budget is a CPU budget now
   * (`judgeSuiteCpu`, judged by the runner at end-of-run), because wall
   * clock moves +73% under contention while CPU moves +2.6% on the same
   * unchanged tree — a wall-clock cap reds on the box, not on the suite.
   */
  wallClockMs?: number;
  /**
   * Whether the run had `RUN_SLOW=1` set (the full slow suite). The
   * test-runtime regression test skips budget enforcement for slow runs
   * (they are expected to take minutes, not seconds).
   */
  runSlow?: boolean;
}>;

/**
 * Plain-data input for {@link writeTestRunSummary}. Kept free of
 * `TestResultReceipt` (which lives in `scripts/`) so this module can write the
 * summary without a `src/ → scripts/` dependency cycle.
 */
export type TestRunSummaryInput = Readonly<{
  resultIntegrityHash: string;
  deterministicHash: string;
  status: "passed" | "failed";
  exitCode: 0 | 1;
  failures: readonly string[];
  reasons: readonly string[];
  testCount: number;
  passCount: number;
  failCount: number;
  wallClockMs?: number;
  runSlow?: boolean;
}>;

/**
 * Write a deterministic-path summary of the test-worker execution so the user
 * can compare runs without capturing output manually. Each run overwrites
 * `latest-summary.json`. The `deterministicHash` is stable across two runs of the
 * same suite with the same outcomes (excludes timestamps, durations, and
 * candidate worktree state).
 */
export function writeTestRunSummary(
  root: string,
  input: TestRunSummaryInput,
  filePath: string = TEST_RUN_SUMMARY_PATH,
): string {
  const absolutePath = isAbsolute(filePath) ? filePath : resolve(root, filePath);
  const directory = absolutePath.slice(0, absolutePath.lastIndexOf(sep));
  ensurePrivateStateDirectory(directory);
  const summary: TestRunSummary = deepFreeze({
    schemaVersion: TEST_RUN_SUMMARY_SCHEMA_VERSION,
    resultIntegrityHash: input.resultIntegrityHash,
    deterministicHash: input.deterministicHash,
    status: input.status,
    exitCode: input.exitCode,
    failures: input.failures,
    reasons: input.reasons,
    timestamp: new Date().toISOString(),
    testCount: input.testCount,
    passCount: input.passCount,
    failCount: input.failCount,
    ...(input.wallClockMs !== undefined ? { wallClockMs: input.wallClockMs } : {}),
    ...(input.runSlow !== undefined ? { runSlow: input.runSlow } : {}),
  });
  const content = `${canonicalJson(summary)}\n`;
  const writeResult = atomicWriteFile(absolutePath, content);
  if (!writeResult.success) {
    throw new HarnessError(`Failed to write test run summary to ${absolutePath}: ${writeResult.reason ?? "unknown error"}`, "test_summary_write_failed");
  }
  return absolutePath;
}

export function parseTestResultCollection(value: unknown): TestResultCollection {
  if (typeof value !== "object" || value === null) {
    throw new InputError("test result collection must be an object", "input_error");
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== TEST_RESULT_COLLECTION_SCHEMA_VERSION) {
    throw new InputError("test result collection schema version is invalid", "input_error");
  }
  if (record.integrityHash === undefined || typeof record.integrityHash !== "string") {
    throw new InputError("test result collection integrity hash is invalid", "input_error");
  }
  if (record.deterministicHash === undefined || typeof record.deterministicHash !== "string") {
    throw new InputError("test result collection deterministic hash is invalid", "input_error");
  }
  const { integrityHash, ...unsigned } = record;
  if (sha256(canonicalJson(unsigned)) !== integrityHash) {
    throw new InputError("test result collection integrity is invalid", "input_error");
  }
  return deepFreeze(record as unknown as TestResultCollection);
}

export function parseConcurrencyReport(value: unknown): ConcurrencyReport | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") {
    throw new InputError("concurrency report must be an object or null", "input_error");
  }
  const record = value as Record<string, unknown>;
  if (record.mode !== "auto") {
    throw new InputError("concurrency report mode must be \"auto\"", "input_error");
  }
  if (!Array.isArray(record.parallel) || !Array.isArray(record.serial)) {
    throw new InputError("concurrency report parallel and serial must be arrays", "input_error");
  }
  if (typeof record.parallelConcurrency !== "number" || !Number.isFinite(record.parallelConcurrency) || record.parallelConcurrency <= 0) {
    throw new InputError("concurrency report parallelConcurrency must be a positive finite number", "input_error");
  }
  for (const entry of record.parallel) {
    if (typeof entry !== "string") throw new InputError("concurrency report parallel entries must be strings", "input_error");
  }
  for (const entry of record.serial) {
    if (typeof entry !== "string") throw new InputError("concurrency report serial entries must be strings", "input_error");
  }
  if (record.serialReasons !== undefined && record.serialReasons !== null) {
    if (typeof record.serialReasons !== "object") {
      throw new InputError("concurrency report serialReasons must be an object", "input_error");
    }
    for (const [key, reasons] of Object.entries(record.serialReasons as Record<string, unknown>)) {
      if (typeof key !== "string" || !Array.isArray(reasons)) {
        throw new InputError("concurrency report serialReasons entries must be string to string array", "input_error");
      }
      for (const reason of reasons) {
        if (typeof reason !== "string") throw new InputError("concurrency report serial reasons must be strings", "input_error");
      }
    }
  }
  return deepFreeze(record as unknown as ConcurrencyReport);
}

/** Node 24 emits these cancellation outcomes as test:fail events, while
 * its summary counts them as cancelled. Both runners use the same native
 * discriminator so a timeout is never counted as two terminal tests. */
export function isCancelledTestFailure(error: unknown): boolean {
  const failureType = typeof error === "object" && error !== null
    ? (error as { failureType?: unknown }).failureType : undefined;
  return failureType === "testTimeoutFailure" || failureType === "cancelledByParent" || failureType === "testAborted";
}

/** Shared native failure projection for inventory receipts and collections. */
/**
 * WHAT A RECORDED TEST ERROR SAID AND WHERE (the one projection both the
 * ledger rows and the reproduction reporter read): its name and message (the
 * digest's), every stack of its cause chain (the location's frames: a
 * node:test failure's own frames are in the assertion it wraps), and the
 * assertion's operator when the runner kept it (`strictEqual: expected…`).
 */
export function testErrorStatement(error: TestResultError): FailureStatement {
  const operator = [error.assertion, ...error.causes.map((cause) => cause.assertion)]
    .map((assertion) => assertion === null ? null : /^([A-Za-z]+): expected /u.exec(assertion)?.[1] ?? null)
    .find((found) => found !== null) ?? null;
  return { name: error.name, message: error.message, stack: [error.stack, ...error.causes.map((cause) => cause.stack)].join("\n"), operator };
}

export function extractTestResultError(error: unknown): TestResultError | null {
  if (typeof error !== "object" || error === null) return null;
  const chain: z.infer<typeof TEST_ERROR_CAUSE_SCHEMA>[] = [];
  const seen = new Set<object>();
  let current: unknown = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    const err = current as { name?: unknown; code?: unknown; failureType?: unknown; message?: unknown; stack?: unknown; cause?: unknown };
    const location = extractErrorSourceLocation(current);
    const text = (value: unknown): string | null => typeof value === "string" ? redactForLLMContext(value) : null;
    chain.push({
      name: text(err.name),
      code: text(err.code),
      failureType: text(err.failureType),
      message: text(err.message) ?? "unknown error",
      stack: text(err.stack) ?? "",
      failureFile: text(location.file),
      failureLine: location.line,
      failureColumn: location.column,
      assertion: text(extractAssertionSummary(current)),
    });
    current = err.cause;
  }
  const firstCause = (error as { cause?: unknown }).cause;
  return deepFreeze({
    ...chain[0]!,
    cause: chain[1]?.message ?? (typeof firstCause === "string" ? redactForLLMContext(firstCause) : null),
    causes: chain.slice(1),
  });
}

const ASSERTION_VALUE_MAX_LENGTH = DEFAULT_ASSERTION_VALUE_MAX_LENGTH;

/**
 * Compose the human-readable assertion summary for a failed test. Walks the
 * `cause` chain (cycle-safe) because the node:test runner wraps assertion
 * failures in an `ERR_TEST_FAILURE` envelope whose own properties carry no
 * assertion detail — the AssertionError lives in `cause`. When the assertion
 * error exposes `expected`/`actual` (in-process assertions) the summary is
 * `operator: expected X, got Y`; when those are stripped by the runner event
 * serialization, the assertion error's own message (whitespace-collapsed and
 * bounded) is the actionable form. `null` for non-assertion failures.
 */
function extractAssertionSummary(error: unknown): string | null {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    const err = current as { expected?: unknown; actual?: unknown; operator?: unknown; code?: unknown; name?: unknown; message?: unknown };
    if (err.expected !== undefined || err.actual !== undefined) {
      const summary = `expected ${formatAssertionValue(err.expected)}, got ${formatAssertionValue(err.actual)}`;
      return typeof err.operator === "string" ? `${err.operator}: ${summary}` : summary;
    }
    if (err.code === "ERR_ASSERTION" || err.name === "AssertionError") {
      if (typeof err.message !== "string") return null;
      const collapsed = redactForLLMContext(err.message).replaceAll(/\s+/gu, " ").trim();
      return collapsed.length > ASSERTION_VALUE_MAX_LENGTH
        ? `${collapsed.slice(0, ASSERTION_VALUE_MAX_LENGTH)}...`
        : collapsed;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

function formatAssertionValue(value: unknown): string {
  let rendered: string;
  if (typeof value === "string") {
    rendered = value;
  } else {
    try {
      rendered = JSON.stringify(value) ?? String(value);
    } catch (e) {handleError(e, { module: "workflow-test-result-collector", operation: "catch" });
      // Circular or otherwise unserializable values fall back to String.
      rendered = String(value);
    }
  }
  rendered = redactForLLMContext(rendered);
  return rendered.length > ASSERTION_VALUE_MAX_LENGTH
    ? `${rendered.slice(0, ASSERTION_VALUE_MAX_LENGTH)}...`
    : rendered;
}

function normalizeTestEvent(value: unknown): TestEvent {
  if (typeof value !== "object" || value === null || !("type" in value) || typeof value.type !== "string") {
    throw new InputError("test runner emitted an invalid event", "input_error");
  }
  const data = "data" in value && typeof value.data === "object" && value.data !== null
    ? value.data as TestEvent["data"]
    : undefined;
  return Object.freeze({ type: value.type, ...(data === undefined ? {} : { data }) });
}

function normalizeFile(root: string, file: string): string {
  const relativePath = isAbsolute(file) ? relative(resolve(root), resolve(file)) : file;
  return relativePath.replaceAll("\\", "/");
}

async function discoverTestFiles(root: string): Promise<string[]> {
  const { readdirSync, statSync } = await import("node:fs");
  const { join, relative, resolve } = await import("node:path");
  const patterns = ROOT_POLICY.verification.testDiscovery.qualifiedSourcePatterns;
  const matchers = patterns.map(compileTestGlob);
  const files: string[] = [];
  // Collect the top-level directory of each qualified pattern (e.g. "test"
  // from "test/**/*.test.ts", "verification" from "verification/..."). Only
  // those directories are walked, keeping discovery bounded to the canonical
  // source set declared in ROOT_POLICY.
  const rootDirs = new Set(patterns.map((pattern) => pattern.split("/")[0]!));
  for (const dir of rootDirs) {
    const absDir = join(root, dir);
    try {
      statSync(absDir);
    } catch (e) {handleError(e, { module: "workflow-test-result-collector", operation: "catch" });
      continue;
    }
    walk(absDir);
  }
  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && /\.(?:test|spec)\.(?:ts|js|mjs|cts|mts)$/u.test(entry.name)) {
        const rel = relative(resolve(root), fullPath).replaceAll("\\", "/");
        if (matchers.some((matcher) => matcher.test(rel))) {
          files.push(fullPath);
        }
      }
    }
  }
  return files.toSorted();
}

/**
 * Compile a restricted test-source glob pattern (as declared in
 * `ROOT_POLICY.verification.testDiscovery.qualifiedSourcePatterns`) into a
 * anchored RegExp. Supports `**` (any number of intermediate directories)
 * and `*` (any characters except `/`). The patterns are validated at the
 * policy level; this compiler applies no additional validation.
 */
function compileTestGlob(pattern: string): RegExp {
  const segments = pattern.split("/");
  let source = "^";
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    if (segment === "**") {
      source += "(?:[^/]+/)*";
      continue;
    }
    source += segment.split("*").map(escapeRegExpChar).join("[^/]*");
    if (index < segments.length - 1) source += "/";
  }
  return new RegExp(`${source}$`, "u");
}

function escapeRegExpChar(value: string): string {
  return value.replace(/[.*+^${}()|[\]\\]/gu, "\\$&");
}
