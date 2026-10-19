import { extractErrorMessage, InputError } from "../kernel/errors.ts";
import { IDENTITY_FAILURE_THRESHOLD } from "./evaluation-config.ts";
import { deepFreeze } from "../kernel/integrity.ts";
import type { TimelineRecorder } from "../timeline/timeline-recorder.ts";
import type { CellExecutionRequest, CellRecord, CellRunResult, MatrixDocument } from "./types.ts";
import { seededShuffle } from "../shared/stats.ts";
import type { ScenarioRunner } from "./scenario-runner.ts";
import type {
  CellResultRecord,
  MatrixExecutionState,
  ProgressState,
  ResultsWriter,
} from "./results-writer.ts";

/**
 * CHEP-1.0 matrix executor.
 *
 * Executes the full preregistered factorial evaluation matrix against a
 * provider via the scenario runner. Enforces:
 *
 * - Deterministic cell ordering (seeded Fisher-Yates shuffle, stable for
 * a given matrix payload hash).
 * - Configurable concurrency (bounded parallel cell execution).
 * - Budget enforcement (token and wall-time caps). When a budget is
 * exceeded, remaining cells are recorded as skipped with a reason —
 * they are never silently dropped (DER-017).
 * - Progressive durable writes via the results writer (results survive a
 * crash or interrupt).
 * - Resume from a prior `progress.json` (skip already-completed cells).
 * - Per-cell error isolation: a single cell failure is recorded and the
 * matrix continues.
 * - Optional scenario/cell/run limits for smoke-testing the live
 * endpoint without burning the full budget.
 *
 * State machine: preregistered → frozen (matrix written to disk) →
 * executing → complete | budget-exhausted | interrupted | error.
 */

export type ProgressUpdate = Readonly<{
  completedCells: number;
  totalCells: number;
  currentScenarioId: string | null;
  currentModelId: string | null;
  elapsedMs: number;
  estimatedRemainingMs: number | null;
  tokensUsed: number;
  state: MatrixExecutionState;
}>;

export type MatrixExecutorOptions = Readonly<{
  matrix: MatrixDocument;
  runner: ScenarioRunner;
  resolvePrompt: (cellId: string) => string;
  buildCellRequest: (cell: CellRecord, scenarioPrompt: string) => CellExecutionRequest;
  resultsWriter: ResultsWriter;
  timeline?: TimelineRecorder;
  concurrency?: number;
  budgetTokens?: number;
  budgetWallTimeSeconds?: number;
  limitScenarios?: number;
  limitCells?: number;
  maxRunsPerCell?: number;
  resume?: boolean;
  onProgress?: (update: ProgressUpdate) => void;
  signal?: AbortSignal;
}>;

export type MatrixExecutorOutcome = Readonly<{
  state: MatrixExecutionState;
  completedCells: number;
  skippedCells: number;
  failedCells: number;
  identityFailureCells: number;
  totalCells: number;
  tokensUsed: number;
  elapsedMs: number;
}>;

export async function executeMatrix(options: MatrixExecutorOptions): Promise<MatrixExecutorOutcome> {
  const concurrency = options.concurrency ?? 3;
  const budgetTokens = options.budgetTokens;
  const budgetWallTimeSeconds = options.budgetWallTimeSeconds;
  const startTime = performance.now();
  const startIso = new Date().toISOString();

  const lookups = buildCellLookups(options.matrix);
  const scoredScenarios = lookups.scoredScenarioOrder;
  const limitScenariosSet = options.limitScenarios !== undefined
    ? new Set(scoredScenarios.slice(0, options.limitScenarios))
    : null;

  let eligible = [...options.matrix.cells];
  if (limitScenariosSet !== null) {
    eligible = eligible.filter((c) => limitScenariosSet.has(lookups.cellToScenario.get(c.cell_id) ?? ""));
  }
  const shuffled = seededShuffle(eligible, seedOf(options.matrix.matrix_payload_sha256));
  const limited = options.limitCells !== undefined ? shuffled.slice(0, options.limitCells) : shuffled;

  const completedCellIds = new Set<string>();
  let tokensUsed = 0;
  if (options.resume) {
    const progress = options.resultsWriter.loadProgress();
    if (progress !== null) {
      // MAJ-3: verify the frozen matrix matches the one in progress.json. If
      // the matrix has changed since the previous run, abort rather than
      // silently pooling unlike runs.
      if (progress.matrixId !== options.matrix.matrix_id) {
        throw new InputError(
          `matrix identity mismatch on resume: progress.json records matrixId '${progress.matrixId}' ` +
          `but the current matrix is '${options.matrix.matrix_id}'. The matrix has changed since the previous run.`,
          "evaluation_matrix_identity_mismatch",
        );
      }
      for (const id of progress.completedCellIds) completedCellIds.add(id);
      tokensUsed = progress.tokensUsed;
    }
  }

  const pending = limited.filter((c) => !completedCellIds.has(c.cell_id));
  const totalCells = limited.length;
  // MAJ-5: transition the matrix into "executing" before processing cells so
  // the state machine is explicit (frozen → executing → complete) and a
  // 0-cell run can still reach "complete".
  options.resultsWriter.beginExecution();
  let completedCount = completedCellIds.size;
  let skippedCount = 0;
  let failedCount = 0;
  let consecutiveIdentityFailures = 0;
  let identityFailureCells = 0;
  let state: MatrixExecutionState = "executing";
  let stopRequested = false;
  let pausedForRestart = false;


  const budgetExceeded = (): boolean => {
    if (budgetTokens !== undefined && tokensUsed >= budgetTokens) return true;
    if (budgetWallTimeSeconds !== undefined && (performance.now() - startTime) / 1000 >= budgetWallTimeSeconds) return true;
    return false;
  };

  const reportProgress = (currentCell: CellRecord | null): void => {
    if (options.onProgress === undefined) return;
    const elapsedMs = performance.now() - startTime;
    const remaining = totalCells - completedCount - skippedCount;
    const avgPerCell = completedCount > 0 ? elapsedMs / completedCount : 0;
    options.onProgress(deepFreeze({
      completedCells: completedCount,
      totalCells,
      currentScenarioId: currentCell !== null ? lookups.cellToScenario.get(currentCell.cell_id) ?? null : null,
      currentModelId: currentCell !== null ? currentCell.model_id : null,
      elapsedMs,
      estimatedRemainingMs: completedCount > 0 ? Math.round(avgPerCell * remaining) : null,
      tokensUsed,
      state,
    }));
  };

  async function processCell(cell: CellRecord): Promise<void> {
    if (stopRequested) return;
    if (options.signal?.aborted) {
      stopRequested = true;
      state = "interrupted";
      return;
    }
    if (budgetExceeded()) {
      stopRequested = true;
      state = "budget-exhausted";
      return;
    }

    reportProgress(cell);

    let scenarioPrompt: string;
    try {
      scenarioPrompt = options.resolvePrompt(cell.cell_id);
    } catch (error) {
      const message = extractErrorMessage(error);
      options.resultsWriter.recordCellResult(deepFreeze({
        cellId: cell.cell_id,
        modelId: cell.model_id,
        testId: cell.test_id,
        scenarioId: lookups.cellToScenario.get(cell.cell_id) ?? "unknown",
        conditionArm: lookups.cellToArm.get(cell.cell_id) ?? "unknown",
        runs: [],
        allOraclesPassed: false,
        identityAttested: false,
        error: `prompt-resolution-error: ${message}`,
        totalTokens: 0,
        totalDurationMs: 0,
      }));
      completedCount++;
      failedCount++;
      return;
    }

    const request = options.buildCellRequest(cell, scenarioPrompt);
    const runOptions: {
      timeline?: TimelineRecorder;
      maxRuns?: number;
      signal?: AbortSignal;
      budgetExceeded?: () => boolean;
      onRunComplete?: (result: CellRunResult) => void;
    } = {};
    if (options.timeline !== undefined) runOptions.timeline = options.timeline;
    if (options.maxRunsPerCell !== undefined) runOptions.maxRuns = options.maxRunsPerCell;
    if (options.signal !== undefined) runOptions.signal = options.signal;
    // MAJ-3 / MAJ-4: report each run's tokens immediately to both the executor
    // (for budget enforcement) and the results writer (for durable progress),
    // and let the runner check the budget after each run.
    runOptions.onRunComplete = (r: CellRunResult) => {
      const runTokens = (r.usage?.totalTokens ?? 0) + (r.capabilityProbe?.usage?.totalTokens ?? 0);
      tokensUsed += runTokens;
      options.resultsWriter.recordRunProgress(runTokens);
    };
    runOptions.budgetExceeded = budgetExceeded;

    let result;
    try {
      result = await options.runner.runCell(request, runOptions);
    } catch (error) {
      const message = extractErrorMessage(error);
      result = deepFreeze({
        cellId: cell.cell_id,
        modelId: cell.model_id,
        runs: [],
        allOraclesPassed: false,
        identityAttested: false,
        error: message,
      });
    }

    // M8: the cell's consumed total (main + probe tokens) is reported per-run
    // via onRunComplete so the budget and progress are updated immediately.
    // cellTokens is still computed for the results record.
    const cellTokens = result.runs.reduce((sum, r) => {
      const mainTokens = r.usage?.totalTokens ?? 0;
      const probeTokens = r.capabilityProbe?.usage?.totalTokens ?? 0;
      return sum + mainTokens + probeTokens;
    }, 0);

    // M2 / CRIT-2: track consecutive identity failures across cells. A run
    // is an identity failure when its finishReason is "identity_not_established"
    // (hard block: wrong probe content, probe-call failure, or model mismatch)
    // OR when the x-model-id header was absent/mismatched (mappingStatus
    // "not-returned" or "mismatch-blocked"). Any run with a verified identity
    // (mappingStatus "exact"/"preregistered-provider-alias") resets the
    // consecutive counter. If the threshold is exceeded, pause execution and
    // require a benchmark restart (DER-014).
    const isIdentityFailure = (r: { finishReason: string; modelRevision: { mappingStatus: string } }): boolean =>
      r.finishReason === "identity_not_established" ||
      r.modelRevision.mappingStatus === "not-returned" ||
      r.modelRevision.mappingStatus === "mismatch-blocked";
    const identityFailedRuns = result.runs.filter(isIdentityFailure).length;
    const cellHadIdentityVerifiedRun = result.runs.some(
      (r) => r.modelRevision.mappingStatus === "exact" ||
              r.modelRevision.mappingStatus === "exact-body" ||
              r.modelRevision.mappingStatus === "preregistered-provider-alias",
    );
    if (identityFailedRuns > 0 && !cellHadIdentityVerifiedRun) {
      consecutiveIdentityFailures++;
      identityFailureCells++;
    } else if (cellHadIdentityVerifiedRun) {
      consecutiveIdentityFailures = 0;
    }
    if (consecutiveIdentityFailures > IDENTITY_FAILURE_THRESHOLD && !stopRequested) {
      stopRequested = true;
      state = "benchmark-restart-required";
      pausedForRestart = true;
    }

    options.resultsWriter.recordCellResult(deepFreeze({
      cellId: cell.cell_id,
      modelId: cell.model_id,
      testId: cell.test_id,
      scenarioId: lookups.cellToScenario.get(cell.cell_id) ?? "unknown",
      conditionArm: lookups.cellToArm.get(cell.cell_id) ?? "unknown",
      runs: result.runs,
      allOraclesPassed: result.allOraclesPassed,
      identityAttested: result.identityAttested,
      error: result.error,
      totalTokens: cellTokens,
      totalDurationMs: result.runs.reduce((sum, r) => sum + r.durationMs, 0),
    }));

    completedCount++;
    // C10: a cell is failed when it has an error OR any oracle failed.
    if (result.error !== null || !result.allOraclesPassed) failedCount++;
  }

  let cursor = 0;
  async function runWorker(): Promise<void> {
    while (cursor < pending.length && !stopRequested) {
      const idx = cursor++;
      await processCell(pending[idx]!);
    }
  }

  const workerCount = Math.min(concurrency, pending.length);
  const workers: Promise<void>[] = [];
  for (let i = 0; i < workerCount; i++) workers.push(runWorker());
  await Promise.all(workers);

  if (stopRequested) {
    for (let i = cursor; i < pending.length; i++) {
      const cell = pending[i]!;
      options.resultsWriter.recordSkipped(cell.cell_id, `stopped: ${state}`);
      skippedCount++;
    }
  }

  if (!stopRequested) state = "complete";

  reportProgress(null);
  const elapsedMs = performance.now() - startTime;
  // EVAL-3: when pausing for a benchmark restart, pass the structured pause
  // reason so the results writer can record it in results.json, final-report.md,
  // and progress.json (explaining WHY the matrix paused). `pausedForRestart`
  // is tracked as a boolean because `state` is assigned inside the processCell
  // closure and TypeScript's control-flow analysis ignores closure assignments
  // (it would narrow `state` to "complete" | "executing" and reject the
  // `=== "benchmark-restart-required"` comparison).
  const pauseReason = pausedForRestart
    ? deepFreeze({
        code: "identity-failure-threshold" as const,
        consecutiveIdentityFailures,
        threshold: IDENTITY_FAILURE_THRESHOLD,
        recommendation: "Verify the provider/model configuration (endpoint URL, model ID, API key) and restart the benchmark after resolving the identity issue.",
      })
    : undefined;
  options.resultsWriter.finalize(state, startIso, elapsedMs, pauseReason);

  return deepFreeze({
    state,
    completedCells: completedCount,
    skippedCells: skippedCount,
    failedCells: failedCount,
    identityFailureCells,
    totalCells,
    tokensUsed,
    elapsedMs,
  });
}

type CellLookups = Readonly<{
  cellToScenario: ReadonlyMap<string, string>;
  cellToArm: ReadonlyMap<string, string>;
  scoredScenarioOrder: readonly string[];
}>;

export function buildCellToArmMap(matrix: MatrixDocument): ReadonlyMap<string, string> {
  const conditionMap = new Map(matrix.conditions.map((c) => [c.condition_id, c.arm]));
  const cellToArm = new Map<string, string>();
  for (const cell of matrix.cells) {
    const test = matrix.tests.find((t) => t.test_id === cell.test_id);
    if (test !== undefined) {
      cellToArm.set(cell.cell_id, conditionMap.get(test.condition_id) ?? "unknown");
    }
  }
  return cellToArm;
}

function buildCellLookups(matrix: MatrixDocument): CellLookups {
  const cellToScenario = new Map<string, string>();
  for (const cell of matrix.cells) {
    const test = matrix.tests.find((t) => t.test_id === cell.test_id);
    if (test !== undefined) {
      cellToScenario.set(cell.cell_id, test.scenario_id);
    }
  }
  const cellToArm = buildCellToArmMap(matrix);
  const scoredScenarioOrder: string[] = [];
  const seen = new Set<string>();
  for (const test of matrix.tests) {
    if (!seen.has(test.scenario_id)) {
      seen.add(test.scenario_id);
      scoredScenarioOrder.push(test.scenario_id);
    }
  }
  return deepFreeze({
    cellToScenario,
    cellToArm,
    scoredScenarioOrder: deepFreeze(scoredScenarioOrder),
  });
}

/** The matrix's hex seed as the shared seeded source's 32-bit seed (its first 8 hex digits). */
function seedOf(seedHex: string): number {
  return parseInt(seedHex.slice(0, 8), 16) >>> 0;
}

export type { ProgressState, CellResultRecord };
