import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { loadPinnedConfigSnapshot } from "../kernel/config.ts";
import { HarnessError, InputError } from "../kernel/errors.ts";
import { deepFreeze } from "../kernel/integrity.ts";
import { createProviderAdapter, resolveApiKey } from "../runtime/provider-adapter.ts";
import { resolveModel, resolveProvider, resolveRuntimeConfig } from "../runtime/runtime-config.ts";
import { createTimelineRecorder } from "../timeline/timeline-recorder.ts";
import { createTimelineStore } from "../timeline/timeline-store.ts";
import type { TimelineRecorder } from "../timeline/timeline-recorder.ts";
import { calculateBudget, formatBudgetReport } from "./budget-calculator.ts";
import { executeMatrix } from "./matrix-executor.ts";
import {
  buildScenarioPromptIndex,
  createDevelopmentConfig,
  createProductionConfig,
  generateMatrix,
} from "./matrix-generator.ts";
import { createScenarioRunner } from "./scenario-runner.ts";
import { SEED_PROJECTS, SEED_SCENARIOS } from "./scenarios.ts";
import type { CellExecutionRequest, CellRecord, MatrixDocument } from "./types.ts";
import { CHEP_MODELS } from "./types.ts";
import { createResultsWriter } from "./results-writer.ts";
import { buildCellToArmMap } from "./matrix-executor.ts";
import { validateMatrix, validateMatrixPayloadHash } from "./semantic-validators.ts";
import { wrapResult, type CommandAnswer } from "../workflow/command-result.ts";

/**
 * `harness eval` — execute the full CHEP-1.0 evaluation matrix against the
 * real Makora endpoint (or any configured OpenAI-compatible provider).
 *
 * Usage:
 * MAKORA_API_KEY=$MAKORA_API_KEY npx tsx src/cli.ts harness eval \
 * --output-dir verification/benchmarks/evaluation/runs \
 * --concurrency 3 \
 * --matrix production
 *
 * The command requires `MAKORA_API_KEY` (read only from the environment
 * variable named by the makora provider config's `apiKeyEnvVar`). It is
 * never hardcoded, logged, or persisted.
 *
 * It answers like every harness verb: the envelope (`--json`, the default)
 * or the plan and the summary (`--text`), the harness CLI's one output
 * option; the plan and the progress lines go to the caller's progress sink
 * (stderr) while it runs, and a refusal is typed (`evaluation_*`).
 */

const DEFAULT_OUTPUT_DIR = "verification/benchmarks/evaluation/runs";
const DEFAULT_CONCURRENCY = 3;

export type EvalCliOptions = Readonly<{
  outputDir: string;
  concurrency: number;
  matrix: "production" | "development";
  resume: boolean;
  budgetTokens: number | null;
  budgetWallTimeSeconds: number | null;
  dryRun: boolean;
  limitScenarios: number | null;
  limitCells: number | null;
  maxRunsPerCell: number | null;
  providerId: string | null;
  models: readonly string[] | null;
}>;

export function parseEvalArgs(argv: readonly string[]): EvalCliOptions {
  const opts: {
    outputDir: string;
    concurrency: number;
    matrix: "production" | "development";
    resume: boolean;
    budgetTokens: number | null;
    budgetWallTimeSeconds: number | null;
    dryRun: boolean;
    limitScenarios: number | null;
    limitCells: number | null;
    maxRunsPerCell: number | null;
    providerId: string | null;
    models: string[] | null;
  } = {
    outputDir: DEFAULT_OUTPUT_DIR,
    concurrency: DEFAULT_CONCURRENCY,
    matrix: "production",
    resume: false,
    budgetTokens: null,
    budgetWallTimeSeconds: null,
    dryRun: false,
    limitScenarios: null,
    limitCells: null,
    maxRunsPerCell: null,
    providerId: null,
    models: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = (): string => {
      const v = argv[i + 1];
      if (v === undefined) throw new InputError(`flag ${arg} requires a value`, "input_error");
      i += 1;
      return v;
    };
    const nextInt = (name: string): number => {
      const raw = next();
      const n = Number.parseInt(raw, 10);
      if (!Number.isFinite(n) || n < 0) throw new InputError(`${name} must be a non-negative integer`, "input_error");
      return n;
    };
    switch (arg) {
      case "--output-dir": opts.outputDir = next(); break;
      case "--concurrency": opts.concurrency = nextInt("--concurrency"); break;
      case "--matrix": {
        const v = next();
        if (v !== "production" && v !== "development") throw new InputError(`--matrix must be 'production' or 'development', got '${v}'`, "input_error");
        opts.matrix = v; break;
      }
      case "--resume": opts.resume = true; break;
      case "--budget-tokens": opts.budgetTokens = nextInt("--budget-tokens"); break;
      case "--budget-wall-time-seconds": opts.budgetWallTimeSeconds = nextInt("--budget-wall-time-seconds"); break;
      case "--dry-run": opts.dryRun = true; break;
      case "--limit-scenarios": opts.limitScenarios = nextInt("--limit-scenarios"); break;
      case "--limit-cells": opts.limitCells = nextInt("--limit-cells"); break;
      case "--limit-runs": opts.maxRunsPerCell = nextInt("--limit-runs"); break;
      case "--provider": opts.providerId = next(); break;
      case "--models": {
        const v = next();
        const parts = v.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
        if (parts.length === 0) throw new InputError(`--models must contain at least one model id`, "input_error");
        opts.models = parts; break;
      }
      default: throw new InputError(`unknown eval flag: ${arg}`, "input_error");
    }
  }

  if (opts.concurrency < 1) throw new InputError("--concurrency must be >= 1", "input_error");
  return deepFreeze(opts);
}

/** What `harness eval` reports: the plan, and the outcome of the run (none for a `--dry-run`). */
export type EvalCliReport = Readonly<{ plan: EvalPlan; outcome: EvalOutcome | null }>;

/** Plans the matrix, then (unless `--dry-run`) executes it; the plan and the progress go to `onProgress` as it runs. */
export async function runEvalCli(argv: readonly string[], onProgress: (line: string) => void): Promise<CommandAnswer<EvalCliReport>> {
  const opts = parseEvalArgs(argv);
  const root = process.cwd();

  // A configuration the loader refuses propagates, typed.
  const document = loadPinnedConfigSnapshot().document;
  const runtime = resolveRuntimeConfig(document);
  // AGN-1: the eval CLI is provider-agnostic. The provider is resolved from
  // --provider, falling back to the central config's defaultProvider.
  const providerId = opts.providerId ?? runtime.defaultProvider;
  // `resolveProvider` refuses typed (`runtime_provider_not_found`) when no
  // provider was named and none is configured — the checked-in config ships
  // none, so an unconfigured run ends here with the remedy, never at a
  // bundled vendor. The resolved provider's own id indexes the env-var map
  // so the two lookups cannot disagree.
  const provider = resolveProvider(runtime, providerId);
  const apiKeyEnvVar = runtime.apiKeyEnvVars[provider.id];
  if (apiKeyEnvVar === undefined) {
    throw new InputError(`provider '${provider.id}' has no apiKeyEnvVar`, "evaluation_api_key_unconfigured");
  }
  let apiKey: string;
  try {
    apiKey = resolveApiKey(apiKeyEnvVar, process.env);
  } catch {
    throw new InputError(`environment variable ${apiKeyEnvVar} is not set or empty — set it before running the full matrix`, "evaluation_api_key_missing");
  }

  // AGN-4: the model set is configurable via --models, defaulting to the
  // canonical CHEP-1.0 Makora qualification pair.
  const models = opts.models ?? [...CHEP_MODELS];
  const config = opts.matrix === "production"
    ? createProductionConfig(SEED_SCENARIOS, SEED_PROJECTS, undefined, models, provider.baseUrl)
    : createDevelopmentConfig(SEED_SCENARIOS, SEED_PROJECTS, undefined, models, provider.baseUrl);
  const matrix: MatrixDocument = generateMatrix(config);
  // CRIT-4 / MAJ-14: validate the matrix structurally and semantically before
  // any execution. This is non-bypassable: if the matrix is schema-invalid or
  // any semantic invariant fails, abort with a clear error.
  const validatorReport = validateMatrix(matrix);
  if (!validatorReport.allPassed) {
    const failed = validatorReport.findings.filter((f) => !f.passed).map((f) => `${f.invariant}: ${f.detail}`);
    throw new HarnessError(`matrix failed semantic validation (${String(failed.length)} invariant(s) failed): ${failed.join("; ")}`, "evaluation_matrix_invalid");
  }
  if (!validateMatrixPayloadHash(matrix)) {
    throw new HarnessError("matrix payload hash mismatch — the matrix_payload_sha256 does not recompute correctly", "evaluation_matrix_hash_mismatch");
  }
  const promptIndex = buildScenarioPromptIndex(config);
  const budget = calculateBudget(matrix, { maxConcurrency: opts.concurrency });

  const plan = evalPlan(matrix, budget, opts);
  for (const line of planLines(plan)) onProgress(line);

  if (opts.dryRun) {
    return evalAnswer({ plan, outcome: null });
  }

  const outputDir = resolve(root, opts.outputDir);
  mkdirSync(outputDir, { recursive: true });

  const resultsWriter = createResultsWriter({
    outputDir,
    matrix,
    budgetEstimate: budget,
    budgetTokens: opts.budgetTokens,
    budgetWallTimeSeconds: opts.budgetWallTimeSeconds,
  });
  resultsWriter.writeMatrixDocument();
  resultsWriter.writeBudgetReport(formatBudgetReport(budget));

  const dbFilename = document.timeline?.dbFilename ?? "timeline.db";
  const dbPath = resolve(outputDir, dbFilename);
  const store = createTimelineStore({
    path: dbPath,
    ledgerId: `eval-${matrix.matrix_id}`,
    ...(document.timeline !== undefined ? { timelineConfig: document.timeline } : {}),
  });
  let timeline: TimelineRecorder;
  try {
    timeline = createTimelineRecorder({ store });
  } catch (error) {
    store.close();
    throw error;
  }

  const adapter = createProviderAdapter({
    provider,
    apiKey,
    ...(document.runtime?.limits?.sseLimits !== undefined ? { sseLimits: document.runtime.limits.sseLimits } : {}),
  });
  const runner = createScenarioRunner({
    adapter,
    ...(document.evaluation?.identityAttestationTimeoutMs !== undefined ? { identityAttestationTimeoutMs: document.evaluation.identityAttestationTimeoutMs } : {}),
  });

  const testToScenario = new Map(matrix.tests.map((t) => [t.test_id, t.scenario_id]));
  const resolvePrompt = (cellId: string): string => {
    const cell = matrix.cells.find((c) => c.cell_id === cellId);
    if (cell === undefined) throw new InputError(`cell not found: ${cellId}`, "evaluation_cell_not_found");
    const test = matrix.tests.find((t) => t.test_id === cell.test_id);
    if (test === undefined) throw new InputError(`test not found for cell: ${cellId}`, "evaluation_test_not_found");
    const scenarioId = testToScenario.get(test.test_id) ?? test.scenario_id;
    const prompt = promptIndex.get(scenarioId);
    if (prompt === undefined) throw new InputError(`prompt not found for scenario: ${scenarioId}`, "evaluation_prompt_not_found");
    return prompt;
  };

  const maxTokens = resolveModel(runtime, providerId, matrix.models[0]!).maxTokens;

  const cellToArm = buildCellToArmMap(matrix);

  const buildCellRequest = (cell: CellRecord, scenarioPrompt: string): CellExecutionRequest => deepFreeze({
    matrix,
    cellId: cell.cell_id,
    scenarioPrompt,
    providerConfig: deepFreeze({
      id: provider.id,
      baseUrl: provider.baseUrl,
      apiKeyEnvVar: apiKeyEnvVar,
      timeoutMs: provider.timeoutMs,
      retries: provider.retries,
      ...(provider.responsesPath !== undefined ? { responsesPath: provider.responsesPath } : {}),
      ...(provider.responses !== undefined ? { responses: provider.responses } : {}),
    }),
    apiKey,
    maxTokens,
    runReferenceTransport: cellToArm.get(cell.cell_id) === "R1-reference",
  });

  const executorOptions = {
    matrix,
    runner,
    resolvePrompt,
    buildCellRequest,
    resultsWriter,
    timeline,
    concurrency: opts.concurrency,
    ...(opts.budgetTokens !== null ? { budgetTokens: opts.budgetTokens } : {}),
    ...(opts.budgetWallTimeSeconds !== null ? { budgetWallTimeSeconds: opts.budgetWallTimeSeconds } : {}),
    ...(opts.limitScenarios !== null ? { limitScenarios: opts.limitScenarios } : {}),
    ...(opts.limitCells !== null ? { limitCells: opts.limitCells } : {}),
    ...(opts.maxRunsPerCell !== null ? { maxRunsPerCell: opts.maxRunsPerCell } : {}),
    resume: opts.resume,
    onProgress: printProgress,
  };

  let lastProgressMs = 0;
  function printProgress(update: Readonly<{
    completedCells: number;
    totalCells: number;
    currentScenarioId: string | null;
    currentModelId: string | null;
    elapsedMs: number;
    estimatedRemainingMs: number | null;
    tokensUsed: number;
    state: string;
  }>): void {
    const now = performance.now();
    if (now - lastProgressMs < 1000 && update.completedCells < update.totalCells) return;
    lastProgressMs = now;
    const pct = update.totalCells > 0 ? Math.round((update.completedCells / update.totalCells) * 100) : 0;
    const elapsedS = Math.round(update.elapsedMs / 1000);
    const remainingS = update.estimatedRemainingMs !== null ? Math.round(update.estimatedRemainingMs / 1000) : null;
    const model = update.currentModelId ?? "-";
    const scenario = update.currentScenarioId ?? "-";
    onProgress(
      `[${update.state}] ${update.completedCells}/${update.totalCells} (${pct}%) ` +
      `elapsed=${elapsedS}s remaining=${remainingS ?? "?"}s ` +
      `tokens=${update.tokensUsed.toLocaleString()} model=${model} scenario=${scenario.slice(0, 24)}`,
    );
  }

  let outcome;
  try {
    outcome = await executeMatrix(executorOptions);
  } finally {
    timeline.close();
  }

  return evalAnswer({
    plan,
    outcome: deepFreeze({
      state: outcome.state, completedCells: outcome.completedCells, skippedCells: outcome.skippedCells, failedCells: outcome.failedCells,
      identityFailureCells: outcome.identityFailureCells, totalCells: outcome.totalCells, tokensUsed: outcome.tokensUsed, elapsedMs: outcome.elapsedMs,
      results: `${resolve(opts.outputDir)}/results.json`, report: `${resolve(opts.outputDir)}/final-report.md`,
    }),
  });
}

/** The plan of a run: what the matrix holds and what it may cost. */
export type EvalPlan = Readonly<{
  matrixId: string; matrixState: string; protocol: string; schemaVersion: string; preset: string; models: readonly string[];
  repetitionsPerCell: number; conditions: number; scenarios: number; scoredScenarios: number; tests: number; cells: number;
  totalRuns: unknown; tokensExpected: number; tokensWorst: number; wallTimeSecondsExpected: number; wallTimeSecondsWorst: number;
  concurrency: number; outputDir: string; budgetTokens: number | null; budgetWallTimeSeconds: number | null;
  limitScenarios: number | null; limitCells: number | null; maxRunsPerCell: number | null; resume: boolean; dryRun: boolean;
}>;

/** How a run ended. */
export type EvalOutcome = Readonly<{
  state: string; completedCells: number; skippedCells: number; failedCells: number; identityFailureCells: number;
  totalCells: number; tokensUsed: number; elapsedMs: number; results: string; report: string;
}>;

function evalPlan(matrix: MatrixDocument, budget: Readonly<Record<string, unknown>>, opts: EvalCliOptions): EvalPlan {
  return deepFreeze({
    matrixId: matrix.matrix_id, matrixState: matrix.matrix_state, protocol: matrix.protocol_id, schemaVersion: matrix.schema_version,
    preset: opts.matrix, models: [...matrix.models], repetitionsPerCell: matrix.repetitions_per_model_test_cell,
    conditions: matrix.conditions.length, scenarios: matrix.scenarios.length, scoredScenarios: matrix.scenarios.filter((s) => s.scored).length,
    tests: matrix.tests.length, cells: matrix.cells.length, totalRuns: budget.totalRuns,
    tokensExpected: Number(budget.totalTokensExpected), tokensWorst: Number(budget.totalTokensWorst),
    wallTimeSecondsExpected: Number(budget.totalWallTimeSecondsExpected), wallTimeSecondsWorst: Number(budget.totalWallTimeSecondsWorst),
    concurrency: opts.concurrency, outputDir: opts.outputDir, budgetTokens: opts.budgetTokens, budgetWallTimeSeconds: opts.budgetWallTimeSeconds,
    limitScenarios: opts.limitScenarios, limitCells: opts.limitCells, maxRunsPerCell: opts.maxRunsPerCell, resume: opts.resume, dryRun: opts.dryRun,
  });
}

/** The answer: it passes for a dry run, and for a run that reached `complete`. */
function evalAnswer(report: EvalCliReport): CommandAnswer<EvalCliReport> {
  return deepFreeze({
    result: wrapResult("eval", report, { status: report.outcome === null || report.outcome.state === "complete" ? "pass" : "fail" }),
    text: () => [...planLines(report.plan), ...(report.outcome === null ? [] : summaryLines(report.outcome))].join("\n").concat("\n"),
  });
}

function planLines(plan: EvalPlan): readonly string[] {
  return [
    "=== CHEP-1.0 Evaluation Plan ===",
    `Matrix ID:         ${plan.matrixId}`,
    `Matrix state:      ${plan.matrixState}`,
    `Protocol:          ${plan.protocol} (schema ${plan.schemaVersion})`,
    `Matrix preset:     ${plan.preset}`,
    `Models:            ${plan.models.join(", ")}`,
    `Repetitions/cell:  ${String(plan.repetitionsPerCell)}`,
    `Conditions:        ${String(plan.conditions)}`,
    `Scenarios:         ${String(plan.scenarios)} (scored: ${String(plan.scoredScenarios)})`,
    `Tests:             ${String(plan.tests)}`,
    `Cells:             ${String(plan.cells)}`,
    `Total runs:        ${String(plan.totalRuns)}`,
    `Tokens (expected):  ${plan.tokensExpected.toLocaleString()}`,
    `Tokens (worst):     ${plan.tokensWorst.toLocaleString()}`,
    `Wall time (exp):    ${plan.wallTimeSecondsExpected.toLocaleString()} s`,
    `Wall time (worst):  ${plan.wallTimeSecondsWorst.toLocaleString()} s`,
    `Concurrency:       ${String(plan.concurrency)}`,
    `Output dir:        ${plan.outputDir}`,
    ...(plan.budgetTokens !== null ? [`Token budget:      ${plan.budgetTokens.toLocaleString()}`] : []),
    ...(plan.budgetWallTimeSeconds !== null ? [`Wall-time budget:   ${String(plan.budgetWallTimeSeconds)} s`] : []),
    ...(plan.limitScenarios !== null ? [`Limit scenarios:    ${String(plan.limitScenarios)}`] : []),
    ...(plan.limitCells !== null ? [`Limit cells:       ${String(plan.limitCells)}`] : []),
    ...(plan.maxRunsPerCell !== null ? [`Max runs/cell:      ${String(plan.maxRunsPerCell)} (smoke-test mode — violates CHEP 3-runs invariant)`] : []),
    ...(plan.resume ? ["Resume:            enabled"] : []),
    ...(plan.dryRun ? ["Dry-run:           true (no execution)"] : []),
    "=================================",
  ];
}

function summaryLines(outcome: EvalOutcome): readonly string[] {
  return [
    "",
    "=== Evaluation Complete ===",
    `State:            ${outcome.state}`,
    `Completed cells:  ${String(outcome.completedCells)}/${String(outcome.totalCells)}`,
    `Skipped cells:    ${String(outcome.skippedCells)}`,
    `Failed cells:     ${String(outcome.failedCells)}`,
    `Identity failures: ${String(outcome.identityFailureCells)}`,
    `Tokens used:      ${outcome.tokensUsed.toLocaleString()}`,
    `Elapsed:          ${String(Math.round(outcome.elapsedMs / 1000))} s`,
    `Results:          ${outcome.results}`,
    `Report:           ${outcome.report}`,
    ...(outcome.state === "benchmark-restart-required"
      ? ["", `NOTE: execution paused after ${String(outcome.identityFailureCells)} identity-failed cells (> 5 consecutive). Restart the benchmark after resolving the provider/identity issue.`]
      : outcome.state !== "complete"
        ? ["", `NOTE: matrix did not reach 'complete' state (${outcome.state}). Re-run with --resume to continue from where it stopped.`]
        : []),
    "===========================",
  ];
}
