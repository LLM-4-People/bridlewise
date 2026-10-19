import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteFile } from "../filesystem/atomic-write.ts";
import { HarnessError, InputError } from "../kernel/errors.ts";
import { canonicalJson, deepFreeze, sha256 } from "../kernel/integrity.ts";
import type { BudgetEstimate, CellRunResult, ChepModelId, MatrixDocument } from "./types.ts";

/**
 * CHEP-1.0 progressive results writer.
 *
 * Owns the on-disk evaluation results format. All writes are atomic
 * (write-temp-then-rename via `atomicWriteFile`) so a crash or interrupt
 * never corrupts a results file; the previous good file survives.
 *
 * Files written to `outputDir`:
 * matrix.json — the frozen matrix document (preregistration truth)
 * budget-report.md — human-readable budget estimate (written once)
 * progress.json — resume checkpoint (completed/skipped cell IDs, tokens)
 * results.json — full structured results (every cell, every run)
 * final-report.md — human-readable final report with aggregates
 *
 * The writer is the single owner of the on-disk results schema. The matrix
 * executor and CLI consume it; they do not write files directly.
 */

export type CellResultRecord = Readonly<{
  cellId: string;
  modelId: ChepModelId;
  testId: string;
  scenarioId: string;
  conditionArm: string;
  runs: readonly CellRunResult[];
  allOraclesPassed: boolean;
  identityAttested: boolean;
  error: string | null;
  totalTokens: number;
  totalDurationMs: number;
}>;

export type SkippedCellRecord = Readonly<{
  cellId: string;
  reason: string;
}>;

export type MatrixExecutionState =
  | "executing"
  | "complete"
  | "budget-exhausted"
  | "interrupted"
  | "error"
  | "benchmark-restart-required";

export type MatrixState = "preregistered" | "frozen" | "executing" | "complete";

export type PauseReason = Readonly<{
  code: "identity-failure-threshold";
  consecutiveIdentityFailures: number;
  threshold: number;
  recommendation: string;
}>;

export type ReconciliationReport = Readonly<{
  plannedCells: number;
  completedCells: number;
  skippedCells: number;
  missingCells: number;
  cellsWithFewerRuns: number;
  cellsWithFourthRun: number;
  cellsWithWrongReplicates: number;
  expectedRunsPerCell: number;
  discrepancies: readonly string[];
  allConsistent: boolean;
}>;

export type ProgressState = Readonly<{
  matrixId: string;
  completedCellIds: readonly string[];
  skippedCellIds: readonly string[];
  tokensUsed: number;
  startedAt: string;
  pauseReason?: string;
}>;

export type MatrixExecutionResults = Readonly<{
  matrixId: string;
  startedAt: string;
  completedAt: string | null;
  state: MatrixExecutionState;
  matrixState: MatrixState;
  pauseReason: PauseReason | null;
  totalCells: number;
  completedCells: number;
  skippedCells: number;
  failedCells: number;
  identityUnverifiedCells: number;
  cellResults: readonly CellResultRecord[];
  skipped: readonly SkippedCellRecord[];
  budget: Readonly<{
    tokensUsed: number;
    tokensBudget: number | null;
    wallTimeUsedSeconds: number;
    wallTimeBudgetSeconds: number | null;
  }>;
  aggregates: ExecutionAggregates;
  reconciliation: ReconciliationReport;
}>;

export type ExecutionAggregates = Readonly<{
  perModel: readonly ModelAggregate[];
  perScenario: readonly ScenarioAggregate[];
  perTopology: readonly TopologyAggregate[];
}>;

export type ModelAggregate = Readonly<{
  modelId: ChepModelId;
  cells: number;
  runs: number;
  passed: number;
  identityAttested: number;
  identityUnverified: number;
  failed: number;
  totalTokens: number;
  totalDurationMs: number;
}>;

export type ScenarioAggregate = Readonly<{
  scenarioId: string;
  cells: number;
  runs: number;
  passed: number;
  failed: number;
  identityUnverified: number;
}>;

export type TopologyAggregate = Readonly<{
  conditionArm: string;
  cells: number;
  runs: number;
  passed: number;
  failed: number;
  identityUnverified: number;
}>;

const RESULTS_FILENAME = "results.json";
const PROGRESS_FILENAME = "progress.json";
const MATRIX_FILENAME = "matrix.json";
const BUDGET_REPORT_FILENAME = "budget-report.md";
const FINAL_REPORT_FILENAME = "final-report.md";

export type ResultsWriterOptions = Readonly<{
  outputDir: string;
  matrix: MatrixDocument;
  budgetEstimate: BudgetEstimate;
  budgetTokens: number | null;
  budgetWallTimeSeconds: number | null;
}>;

export type ResultsWriter = Readonly<{
  readonly outputDir: string;
  writeMatrixDocument(): void;
  writeBudgetReport(reportText: string): void;
  beginExecution(): void;
  recordCellResult(record: CellResultRecord): void;
  recordSkipped(cellId: string, reason: string): void;
  recordRunProgress(runTokens: number): void;
  loadProgress(): ProgressState | null;
  finalize(state: MatrixExecutionState, startedAt: string, elapsedMs: number, pauseReason?: PauseReason): MatrixExecutionResults;
  getResults(): MatrixExecutionResults;
}>;

export function createResultsWriter(options: ResultsWriterOptions): ResultsWriter {
  const { outputDir, matrix, budgetTokens, budgetWallTimeSeconds } = options;
  void options.budgetEstimate;
  const cellResults: CellResultRecord[] = [];
  const skipped: SkippedCellRecord[] = [];
  const completedCellIds: string[] = [];
  const skippedCellIds: string[] = [];
  let startedAt: string | null = null;
  let tokensUsed = 0;
  let matrixState: MatrixState = "preregistered";
  let currentPauseReason: PauseReason | null = null;
  let finalized: MatrixExecutionResults | null = null;

  function ensureStartedAt(): string {
    if (startedAt === null) startedAt = new Date().toISOString();
    return startedAt;
  }

  function pauseReasonText(pr: PauseReason | null): string | undefined {
    if (pr === null) return undefined;
    return `${pr.code}: ${pr.consecutiveIdentityFailures} consecutive identity failures (threshold ${pr.threshold}). ${pr.recommendation}`;
  }

  function buildResults(state: MatrixExecutionState, completedAt: string | null, elapsedMs: number): MatrixExecutionResults {
    const failedCells = cellResults.filter((r) => r.error !== null || !r.allOraclesPassed).length;
    const identityUnverifiedCells = cellResults.filter((r) => r.error === null && r.allOraclesPassed && !r.identityAttested).length;
    const aggregates = computeAggregates(cellResults, matrix);
    // MAJ-5: enforce the state machine. finalize("complete") is only valid from
    // the "executing" state; preregistered/frozen must not jump to complete.
    let finalMatrixState: MatrixState;
    if (state === "complete") {
      if (matrixState !== "executing") {
        throw new InputError(
          `Cannot finalize('complete') from matrixState '${matrixState}' — the matrix must be in the 'executing' state (preregistered → frozen → executing → complete)`,
          "evaluation_matrix_state_invalid",
        );
      }
      finalMatrixState = "complete";
    } else {
      finalMatrixState = matrixState;
    }
    return deepFreeze({
      matrixId: matrix.matrix_id,
      startedAt: startedAt ?? new Date().toISOString(),
      completedAt,
      state,
      matrixState: finalMatrixState,
      pauseReason: currentPauseReason,
      totalCells: matrix.cells.length,
      completedCells: cellResults.length,
      skippedCells: skipped.length,
      failedCells,
      identityUnverifiedCells,
      cellResults: deepFreeze([...cellResults]),
      skipped: deepFreeze([...skipped]),
      budget: deepFreeze({
        tokensUsed,
        tokensBudget: budgetTokens,
        wallTimeUsedSeconds: Math.round(elapsedMs / 1000),
        wallTimeBudgetSeconds: budgetWallTimeSeconds,
      }),
      aggregates,
      reconciliation: reconcileExecution(matrix, cellResults, skipped),
    });
  }

  function writeResults(state: MatrixExecutionState, completedAt: string | null, elapsedMs: number): void {
    const results = buildResults(state, completedAt, elapsedMs);
    writeAtomic(join(outputDir, RESULTS_FILENAME), JSON.stringify(results, null, 2) + "\n");
  }

  function writeProgress(): void {
    const prText = pauseReasonText(currentPauseReason);
    const progress: ProgressState = deepFreeze({
      matrixId: matrix.matrix_id,
      completedCellIds: deepFreeze([...completedCellIds]),
      skippedCellIds: deepFreeze([...skippedCellIds]),
      tokensUsed,
      startedAt: startedAt ?? new Date().toISOString(),
      ...(prText !== undefined ? { pauseReason: prText } : {}),
    });
    writeAtomic(join(outputDir, PROGRESS_FILENAME), JSON.stringify(progress, null, 2) + "\n");
  }

  return deepFreeze({
    outputDir,

    writeMatrixDocument(): void {
      writeAtomic(join(outputDir, MATRIX_FILENAME), canonicalJson(matrix) + "\n");
      if (matrixState === "preregistered") matrixState = "frozen";
    },

    writeBudgetReport(reportText: string): void {
      writeAtomic(join(outputDir, BUDGET_REPORT_FILENAME), reportText);
    },

    beginExecution(): void {
      // MAJ-5: transition the matrix into the "executing" state before any
      // cells are processed. This makes the state machine explicit
      // (preregistered/frozen → executing → complete) and ensures a 0-cell
      // run can still reach "complete" without skipping the executing phase.
      ensureStartedAt();
      if (matrixState === "complete") {
        throw new InputError("Cannot begin execution — matrix is already complete", "evaluation_matrix_already_complete");
      }
      matrixState = "executing";
      writeProgress();
    },

    recordCellResult(record: CellResultRecord): void {
      ensureStartedAt();
      if (matrixState === "preregistered" || matrixState === "frozen") matrixState = "executing";
      cellResults.push(record);
      completedCellIds.push(record.cellId);
      // MAJ-3: per-run tokens are added immediately via recordRunProgress, so
      // the cell-level total is NOT re-added here (avoids double-counting).
      writeResults("executing", null, 0);
      writeProgress();
      finalized = null;
    },

    recordSkipped(cellId: string, reason: string): void {
      ensureStartedAt();
      skipped.push(deepFreeze({ cellId, reason }));
      skippedCellIds.push(cellId);
      writeResults("executing", null, 0);
      writeProgress();
      finalized = null;
    },

    recordRunProgress(runTokens: number): void {
      ensureStartedAt();
      // MAJ-3: update the token total immediately after each run so a crash
      // mid-cell does not lose that run's token spend. Progress is persisted
      // atomically so resume reads an accurate token count.
      tokensUsed += runTokens;
      writeProgress();
    },

    loadProgress(): ProgressState | null {
      const path = join(outputDir, PROGRESS_FILENAME);
      if (!existsSync(path)) return null;
      try {
        const text = readFileSync(path, "utf8");
        const parsed = JSON.parse(text) as Partial<ProgressState>;
        if (typeof parsed !== "object" || parsed === null) return null;
        if (!Array.isArray(parsed.completedCellIds)) return null;
        if (!Array.isArray(parsed.skippedCellIds)) return null;
        if (typeof parsed.tokensUsed !== "number") return null;
        if (typeof parsed.startedAt !== "string") return null;
        if (typeof parsed.matrixId !== "string") return null;
        const parsedPauseReason = typeof parsed.pauseReason === "string" ? parsed.pauseReason : undefined;
        return deepFreeze({
          matrixId: parsed.matrixId,
          completedCellIds: deepFreeze(parsed.completedCellIds),
          skippedCellIds: deepFreeze(parsed.skippedCellIds),
          tokensUsed: parsed.tokensUsed,
          startedAt: parsed.startedAt,
          ...(parsedPauseReason !== undefined ? { pauseReason: parsedPauseReason } : {}),
        });
      } catch {
        return null;
      }
    },

    finalize(state: MatrixExecutionState, startIso: string, elapsedMs: number, pauseReason?: PauseReason): MatrixExecutionResults {
      startedAt = startIso;
      currentPauseReason = pauseReason ?? null;
        const completedAt = state === "complete" || state === "budget-exhausted" || state === "interrupted" || state === "error" || state === "benchmark-restart-required"
          ? new Date().toISOString()
          : null;
      const results = buildResults(state, completedAt, elapsedMs);
      writeAtomic(join(outputDir, RESULTS_FILENAME), JSON.stringify(results, null, 2) + "\n");
      writeAtomic(join(outputDir, FINAL_REPORT_FILENAME), formatFinalReport(results));
      // MAJ-10: when execution reaches "complete", rewrite matrix.json with
      // matrix_state="complete" and a recomputed matrix_payload_sha256 so the
      // on-disk artifact reflects the final execution state.
      if (state === "complete" && results.matrixState === "complete") {
        writeAtomic(join(outputDir, MATRIX_FILENAME), canonicalJson(advanceMatrixState(matrix, "complete")) + "\n");
      } else if (state !== "complete" && state !== "executing") {
        // EVAL-2: for paused/interrupted/budget-exhausted/error runs, advance
        // matrix.json from "preregistered"/"frozen" to the current matrixState
        // ("executing") with a recomputed matrix_payload_sha256. Previously
        // matrix.json stayed "preregistered" for any non-complete finalize,
        // hiding that execution had started. The pause reason (EVAL-3) is
        // captured in results.json, final-report.md, and progress.json.
        writeAtomic(join(outputDir, MATRIX_FILENAME), canonicalJson(advanceMatrixState(matrix, results.matrixState)) + "\n");
      }
      writeProgress();
      finalized = results;
      return results;
    },

    getResults(): MatrixExecutionResults {
      if (finalized !== null) return finalized;
      return buildResults("executing", null, 0);
    },
  });
}

function writeAtomic(path: string, content: string): void {
  const result = atomicWriteFile(path, content);
  if (!result.success) {
    throw new HarnessError(`Failed to write ${path}: ${result.reason ?? "unknown error"}`, "evaluation_write_failed");
  }
}

/**
 * MAJ-10 / EVAL-2: returns a copy of the matrix with `matrix_state` advanced
 * to `state` and `matrix_payload_sha256` recomputed over the new payload.
 * The on-disk matrix.json is rewritten with this document at finalization
 * (both for "complete" and for non-complete terminal states like
 * "benchmark-restart-required"/"interrupted", so the artifact reflects that
 * execution started even when it did not finish).
 */
function advanceMatrixState(matrix: MatrixDocument, state: MatrixState): MatrixDocument {
  const { matrix_payload_sha256: _omitted, ...rest } = matrix;
  const updated = { ...rest, matrix_state: state };
  const payloadHash = sha256(canonicalJson(updated));
  return deepFreeze({ ...updated, matrix_payload_sha256: payloadHash });
}

function computeAggregates(cellResults: readonly CellResultRecord[], matrix: MatrixDocument): ExecutionAggregates {
  const cellToScenario = new Map<string, string>();
  const cellToArm = new Map<string, string>();
  for (const cell of matrix.cells) {
    const test = matrix.tests.find((t) => t.test_id === cell.test_id);
    if (test !== undefined) {
      cellToScenario.set(cell.cell_id, test.scenario_id);
      const condition = matrix.conditions.find((c) => c.condition_id === test.condition_id);
      if (condition !== undefined) cellToArm.set(cell.cell_id, condition.arm);
    }
  }

  const modelMap = new Map<ChepModelId, ModelAggregate>();
  const scenarioMap = new Map<string, ScenarioAggregate>();
  const topologyMap = new Map<string, TopologyAggregate>();

  for (const r of cellResults) {
    const scenarioId = cellToScenario.get(r.cellId) ?? "unknown";
    const arm = cellToArm.get(r.cellId) ?? "unknown";
    // MAJ-1: three categories. A cell is exactly one of:
    // passed: error null, all oracles passed, identity attested
    // failed: error set OR any oracle failed
    // identity-unverified: error null, all oracles passed, identity NOT attested
    const isPassed = r.error === null && r.allOraclesPassed && r.identityAttested;
    const isFailed = r.error !== null || !r.allOraclesPassed;
    const isIdentityUnverified = r.error === null && r.allOraclesPassed && !r.identityAttested;

    const ma = modelMap.get(r.modelId) ?? deepFreeze({
      modelId: r.modelId, cells: 0, runs: 0, passed: 0, identityAttested: 0, identityUnverified: 0, failed: 0, totalTokens: 0, totalDurationMs: 0,
    });
    modelMap.set(r.modelId, deepFreeze({
      modelId: r.modelId,
      cells: ma.cells + 1,
      runs: ma.runs + r.runs.length,
      passed: ma.passed + (isPassed ? 1 : 0),
      identityAttested: ma.identityAttested + (r.identityAttested ? 1 : 0),
      identityUnverified: ma.identityUnverified + (isIdentityUnverified ? 1 : 0),
      failed: ma.failed + (isFailed ? 1 : 0),
      totalTokens: ma.totalTokens + r.totalTokens,
      totalDurationMs: ma.totalDurationMs + r.totalDurationMs,
    }));

    const sa = scenarioMap.get(scenarioId) ?? deepFreeze({ scenarioId, cells: 0, runs: 0, passed: 0, failed: 0, identityUnverified: 0 });
    scenarioMap.set(scenarioId, deepFreeze({
      scenarioId,
      cells: sa.cells + 1,
      runs: sa.runs + r.runs.length,
      passed: sa.passed + (isPassed ? 1 : 0),
      failed: sa.failed + (isFailed ? 1 : 0),
      identityUnverified: sa.identityUnverified + (isIdentityUnverified ? 1 : 0),
    }));

    const ta = topologyMap.get(arm) ?? deepFreeze({ conditionArm: arm, cells: 0, runs: 0, passed: 0, failed: 0, identityUnverified: 0 });
    topologyMap.set(arm, deepFreeze({
      conditionArm: arm,
      cells: ta.cells + 1,
      runs: ta.runs + r.runs.length,
      passed: ta.passed + (isPassed ? 1 : 0),
      failed: ta.failed + (isFailed ? 1 : 0),
      identityUnverified: ta.identityUnverified + (isIdentityUnverified ? 1 : 0),
    }));
  }

  const byModel = [...modelMap.values()].toSorted((a, b) => a.modelId.localeCompare(b.modelId));
  const byScenario = [...scenarioMap.values()].toSorted((a, b) => a.scenarioId.localeCompare(b.scenarioId));
  const byTopology = [...topologyMap.values()].toSorted((a, b) => a.conditionArm.localeCompare(b.conditionArm));

  return deepFreeze({
    perModel: deepFreeze(byModel),
    perScenario: deepFreeze(byScenario),
    perTopology: deepFreeze(byTopology),
  });
}

/**
 * Reconciles planned vs executed runs after execution (C8 / DER-018).
 *
 * Verifies that every completed cell has the configured number of replicate
 * runs, detects cells with fewer runs (missing replicates) or a retained
 * fourth run (no_selective_retained_fourth_run), and reports any missing
 * cells (planned but neither completed nor skipped).
 */
export function reconcileExecution(
  matrix: MatrixDocument,
  cellResults: readonly CellResultRecord[],
  skipped: readonly SkippedCellRecord[],
): ReconciliationReport {
  const plannedCells = matrix.cells.length;
  const expectedRunsPerCell = matrix.repetitions_per_model_test_cell;
  const completedCells = cellResults.length;
  const skippedCells = skipped.length;
  const discrepancies: string[] = [];

  let cellsWithFewerRuns = 0;
  let cellsWithFourthRun = 0;
  let cellsWithWrongReplicates = 0;
  for (const cr of cellResults) {
    if (cr.runs.length < expectedRunsPerCell) {
      cellsWithFewerRuns++;
      discrepancies.push(`cell ${cr.cellId} has ${cr.runs.length} runs (expected ${expectedRunsPerCell})`);
    } else if (cr.runs.length > expectedRunsPerCell) {
      cellsWithFourthRun++;
      discrepancies.push(`cell ${cr.cellId} has ${cr.runs.length} runs (no_selective_retained_fourth_run)`);
    }
    // MAJ-13: verify replicate identity — the run replicates must be exactly
    // {1, 2, 3} (no duplicates, no missing, no extra). A cell with 3 runs all
    // replicate=1 must fail reconciliation.
    const replicates = cr.runs.map((r) => r.replicate).sort((a, b) => a - b);
    const expectedReplicates = Array.from({ length: expectedRunsPerCell }, (_, i) => i + 1);
    const replicatesMatch = replicates.length === expectedRunsPerCell &&
      replicates.every((v, i) => v === expectedReplicates[i]);
    if (!replicatesMatch) {
      cellsWithWrongReplicates++;
      discrepancies.push(`cell ${cr.cellId} has replicates [${replicates.join(",")}] (expected [${expectedReplicates.join(",")}])`);
    }
  }

  const knownCellIds = new Set<string>([...cellResults.map((c) => c.cellId), ...skipped.map((s) => s.cellId)]);
  const missingCellIds = matrix.cells.filter((c) => !knownCellIds.has(c.cell_id)).map((c) => c.cell_id);
  const missingCells = missingCellIds.length;
  if (missingCells > 0) {
    discrepancies.push(`${missingCells} planned cells have no completed or skipped record: ${missingCellIds.slice(0, 5).join(", ")}${missingCellIds.length > 5 ? " ..." : ""}`);
  }

  return deepFreeze({
    plannedCells,
    completedCells,
    skippedCells,
    missingCells,
    cellsWithFewerRuns,
    cellsWithFourthRun,
    cellsWithWrongReplicates,
    expectedRunsPerCell,
    discrepancies: deepFreeze(discrepancies),
    allConsistent: discrepancies.length === 0,
  });
}

export function formatFinalReport(results: MatrixExecutionResults): string {
  const lines: string[] = [];
  lines.push("# CHEP-1.0 Evaluation Final Report", "");
  lines.push(`Matrix ID: \`${results.matrixId}\``);
  lines.push(`Started: ${results.startedAt}`);
  lines.push(`Completed: ${results.completedAt ?? "(in progress)"}`);
  lines.push(`State: **${results.state}** (matrix: ${results.matrixState})`, "");
  lines.push("## Summary", "");
  lines.push(`- Total cells: ${results.totalCells}`);
  lines.push(`- Completed cells: ${results.completedCells}`);
  lines.push(`- Skipped cells: ${results.skippedCells}`);
  lines.push(`- Failed cells: ${results.failedCells}`);
  lines.push(`- Identity-unverified cells: ${results.identityUnverifiedCells}`);
  lines.push(`- Tokens used: ${results.budget.tokensUsed.toLocaleString()}`);
  lines.push(`- Wall time: ${results.budget.wallTimeUsedSeconds.toLocaleString()} s`, "");

  // EVAL-3: when execution paused for a benchmark restart, explain WHY.
  // Without this section the report only says "State: benchmark-restart-required"
  // with no reason. Include the consecutive identity-failure count, the cells
  // that failed identity, and a recommendation.
  if (results.state === "benchmark-restart-required") {
    lines.push("## Pause Reason", "");
    if (results.pauseReason !== null) {
      lines.push(`Execution paused after **${results.pauseReason.consecutiveIdentityFailures} consecutive identity failures** ` +
        `(threshold: ${results.pauseReason.threshold}).`);
      lines.push("");
      lines.push(`Code: \`${results.pauseReason.code}\``);
    } else {
      lines.push("Execution paused after the consecutive identity-failure threshold was exceeded.");
    }
    const identityFailedCells = results.cellResults.filter((cr) => !cr.identityAttested);
    lines.push("");
    lines.push(`Cells that failed identity (${identityFailedCells.length}):`);
    if (identityFailedCells.length === 0) {
      lines.push("- _(none recorded in completed cells)_");
    } else {
      for (const cr of identityFailedCells) {
        lines.push(`- \`${cr.cellId}\` (model: ${cr.modelId})`);
      }
    }
    lines.push("");
    lines.push("**Recommendation:** Verify the provider/model configuration (endpoint URL, model ID, API key) and restart the benchmark after resolving the identity issue.", "");
  }

  // CRIT-3: DER-014 requires that provider/model metadata not exposed by the
  // provider remains an explicit identity limitation. This section must be
  // present in every final report and state which identity dimensions are
  // unverified. With the response-body `model` fallback (FIX4-IDENTITY),
  // identity may be established via the body even when the header is absent.
  const allRuns = results.cellResults.flatMap((cr) => cr.runs);
  const headerReturned = allRuns.some((r) =>
    r.modelRevision.mappingStatus === "exact" || r.modelRevision.mappingStatus === "mismatch-blocked",
  );
  const bodyVerified = allRuns.some((r) => r.modelRevision.mappingStatus === "exact-body");
  lines.push("## Identity Limitations (DER-014)", "");
  lines.push("The following identity dimensions could not be independently verified because the provider does not expose the corresponding metadata:");
  lines.push("");
  lines.push(`- \`x-model-id\` header: ${headerReturned ? "returned by provider" : "not returned by provider"} → model ID ${headerReturned ? "verified via header when present" : "could not be verified via header"}`);
  lines.push(`- Model identity verified via response body \`model\` field: ${bodyVerified ? "yes (identity established from body when header absent)" : "no"}`);
  lines.push("- `x-deployment-id` header: not returned by provider → deployment/revision could not be verified");
  lines.push("- `x-organization` header: not returned by provider → organization could not be verified");
  lines.push("- Quantization/precision: not exposed by provider");
  lines.push("- Tokenizer/context/tool-call capabilities: not probed");
  lines.push("- Adapter/schema versions: recorded at matrix level, not per-run");
  lines.push("");
  if (results.identityUnverifiedCells > 0) {
    lines.push(`**${results.identityUnverifiedCells} cell(s) completed without verified identity.** All identity-unverified results are excluded from the "passed" count and reported separately. They MUST NOT be pooled with identity-attested runs.`, "");
  } else if (bodyVerified && !headerReturned) {
    lines.push("All completed cells had identity attested via the response body `model` field (x-model-id header not returned by provider).", "");
  } else {
    lines.push("All completed cells had identity attested.", "");
  }

  lines.push("## Reconciliation", "");
  lines.push(`- Planned cells: ${results.reconciliation.plannedCells}`);
  lines.push(`- Completed cells: ${results.reconciliation.completedCells}`);
  lines.push(`- Skipped cells: ${results.reconciliation.skippedCells}`);
  lines.push(`- Missing cells: ${results.reconciliation.missingCells}`);
  lines.push(`- Cells with fewer runs: ${results.reconciliation.cellsWithFewerRuns}`);
  lines.push(`- Cells with a retained fourth run: ${results.reconciliation.cellsWithFourthRun}`);
  lines.push(`- Cells with wrong replicate numbers: ${results.reconciliation.cellsWithWrongReplicates}`);
  lines.push(`- Expected runs per cell: ${results.reconciliation.expectedRunsPerCell}`);
  lines.push(`- All consistent: **${results.reconciliation.allConsistent}**`);
  if (results.reconciliation.discrepancies.length > 0) {
    lines.push("", "Discrepancies:");
    for (const d of results.reconciliation.discrepancies) lines.push(`  - ${d}`);
  }
  lines.push("");

  lines.push("## Per-Model Aggregates", "");
  lines.push("| Model | Cells | Runs | Passed | Identity | Unverified | Failed | Tokens | Duration (ms) |");
  lines.push("|-------|-------|------|--------|----------|------------|--------|--------|---------------|");
  for (const m of results.aggregates.perModel) {
    lines.push(`| ${m.modelId} | ${m.cells} | ${m.runs} | ${m.passed} | ${m.identityAttested} | ${m.identityUnverified} | ${m.failed} | ${m.totalTokens.toLocaleString()} | ${m.totalDurationMs.toLocaleString()} |`);
  }
  lines.push("");

  lines.push("## Per-Topology Aggregates", "");
  lines.push("| Arm | Cells | Runs | Passed | Failed | Unverified |");
  lines.push("|-----|-------|------|--------|--------|------------|");
  for (const t of results.aggregates.perTopology) {
    lines.push(`| ${t.conditionArm} | ${t.cells} | ${t.runs} | ${t.passed} | ${t.failed} | ${t.identityUnverified} |`);
  }
  lines.push("");

  lines.push(`## Per-Scenario Aggregates (${results.aggregates.perScenario.length} scenarios)`, "");
  lines.push("| Scenario | Cells | Runs | Passed | Failed | Unverified |");
  lines.push("|----------|-------|------|--------|--------|------------|");
  for (const s of results.aggregates.perScenario.slice(0, 50)) {
    lines.push(`| ${s.scenarioId} | ${s.cells} | ${s.runs} | ${s.passed} | ${s.failed} | ${s.identityUnverified} |`);
  }
  if (results.aggregates.perScenario.length > 50) {
    lines.push(`| ... (${results.aggregates.perScenario.length - 50} more) | | | | | |`);
  }
  lines.push("");

  if (results.skipped.length > 0) {
    lines.push("## Skipped Cells", "");
    lines.push("| Cell ID | Reason |");
    lines.push("|---------|--------|");
    for (const s of results.skipped) {
      lines.push(`| ${s.cellId} | ${s.reason} |`);
    }
    lines.push("");
  }

  lines.push("## Failed Cells", "");
  const failedCells = results.cellResults.filter((r) => r.error !== null || !r.allOraclesPassed);
  if (failedCells.length === 0) {
    lines.push("_(none)_", "");
  } else {
    lines.push("| Cell ID | Model | Error | Oracles Passed |");
    lines.push("|---------|-------|-------|----------------|");
    for (const r of failedCells) {
      lines.push(`| ${r.cellId} | ${r.modelId} | ${r.error ?? ""} | ${r.allOraclesPassed} |`);
    }
    lines.push("");
  }

  const unverifiedCells = results.cellResults.filter((r) => r.error === null && r.allOraclesPassed && !r.identityAttested);
  if (unverifiedCells.length > 0) {
    lines.push("## Identity-Unverified Cells", "");
    lines.push("_(completed but identity not attested — excluded from passed count)_", "");
    lines.push("| Cell ID | Model | Identity Attested |");
    lines.push("|---------|-------|-------------------|");
    for (const r of unverifiedCells) {
      lines.push(`| ${r.cellId} | ${r.modelId} | ${r.identityAttested} |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
