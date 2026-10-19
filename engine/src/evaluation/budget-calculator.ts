import { deepFreeze } from "../kernel/integrity.ts";
import type {
  BudgetEstimate,
  ChepModelId,
  MatrixDocument,
  RateLimitProfile,
} from "./types.ts";

/**
 * CHEP-1.0 budget calculator.
 *
 * Before execution, calculates the complete planned cell/run count plus
 * worst/expected provider tokens, wall time, storage, indexing, process/
 * agent concurrency, rate limits, cost, and human review load.
 *
 * Per DER-017: the budget may schedule/cap concurrency and pause safely,
 * but cannot silently remove cells or stop only unfavorable conditions.
 */

const DEFAULT_TOKEN_ESTIMATES = deepFreeze({
  promptTokensPerCall: { min: 200, expected: 800, max: 4000 },
  completionTokensPerCall: { min: 100, expected: 1200, max: 8192 },
} as const);

const DEFAULT_WALL_TIME_PER_CALL_MS = deepFreeze({
  min: 1000,
  expected: 15000,
  max: 120000,
} as const);

import {
  DEFAULT_HUMAN_REVIEW_SAMPLE_RATE,
  DEFAULT_INDEX_OVERHEAD_FACTOR,
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_TIMELINE_RECORD_BYTES,
  DEFAULT_TIMELINE_RECORDS_PER_CELL,
} from "./evaluation-config.ts";
const TIMELINE_RECORDS_PER_CELL = DEFAULT_TIMELINE_RECORDS_PER_CELL;
const TIMELINE_RECORD_BYTES = DEFAULT_TIMELINE_RECORD_BYTES;
const INDEX_OVERHEAD_FACTOR = DEFAULT_INDEX_OVERHEAD_FACTOR;

export type TokenEstimates = Readonly<{
  promptTokensPerCall: Readonly<{ min: number; expected: number; max: number }>;
  completionTokensPerCall: Readonly<{ min: number; expected: number; max: number }>;
}>;

export type WallTimeEstimates = Readonly<{ min: number; expected: number; max: number }>;

export type BudgetCalculationOptions = Readonly<{
  tokenEstimates?: TokenEstimates;
  wallTimePerCallMs?: WallTimeEstimates;
  maxConcurrency?: number;
  pricePerTokenUsd?: number;
  humanReviewSampleRate?: number;
}>;

export function calculateBudget(
  matrix: MatrixDocument,
  options: BudgetCalculationOptions = {},
): BudgetEstimate {
  const tokenEst = options.tokenEstimates ?? DEFAULT_TOKEN_ESTIMATES;
  const wallTime = options.wallTimePerCallMs ?? DEFAULT_WALL_TIME_PER_CALL_MS;
  const maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
  const pricePerTokenUsd = options.pricePerTokenUsd ?? 0;
  const reviewSampleRate = options.humanReviewSampleRate ?? DEFAULT_HUMAN_REVIEW_SAMPLE_RATE;

  const totalCells = matrix.cells.length;
  const totalRuns = totalCells * matrix.repetitions_per_model_test_cell;
  const totalTests = matrix.tests.length;
  const totalScenarios = matrix.scenarios.length;
  const scoredScenarios = matrix.scenarios.filter((s) => s.scored).length;

  const promptPerCall = tokenEst.promptTokensPerCall;
  const completionPerCall = tokenEst.completionTokensPerCall;

  const totalTokensExpected = totalRuns * (promptPerCall.expected + completionPerCall.expected);
  const totalTokensMax = totalRuns * (promptPerCall.max + completionPerCall.max);

  const wallTimeMsExpected = (totalRuns * wallTime.expected) / maxConcurrency;
  const wallTimeMsMax = (totalRuns * wallTime.max) / maxConcurrency;
  const wallTimeMsMin = (totalRuns * wallTime.min) / maxConcurrency;

  const estimatedTimelineRecords = totalRuns * TIMELINE_RECORDS_PER_CELL;
  const estimatedStorageBytes = estimatedTimelineRecords * TIMELINE_RECORD_BYTES;

  const models: readonly ChepModelId[] = matrix.models;

  const estimatedCostUsd = totalTokensExpected * pricePerTokenUsd;
  const estimatedIndexingBytes = Math.ceil(estimatedStorageBytes * INDEX_OVERHEAD_FACTOR);
  const rateLimitProfile: RateLimitProfile | null = null;
  const estimatedHumanReviewLoad = Math.ceil(totalCells * reviewSampleRate);

  return deepFreeze({
    totalCells,
    totalRuns,
    totalTests,
    totalScenarios,
    scoredScenarios,
    estimatedTokensPerCall: deepFreeze({
      min: promptPerCall.min + completionPerCall.min,
      expected: promptPerCall.expected + completionPerCall.expected,
      max: promptPerCall.max + completionPerCall.max,
    }),
    estimatedWallTimeSeconds: deepFreeze({
      min: Math.ceil(wallTimeMsMin / 1000),
      expected: Math.ceil(wallTimeMsExpected / 1000),
      max: Math.ceil(wallTimeMsMax / 1000),
    }),
    totalTokensExpected,
    totalTokensWorst: totalTokensMax,
    totalWallTimeSecondsExpected: Math.ceil(wallTimeMsExpected / 1000),
    totalWallTimeSecondsWorst: Math.ceil(wallTimeMsMax / 1000),
    estimatedStorageBytes,
    estimatedTimelineRecords,
    maxConcurrency,
    models,
    conditions: matrix.conditions.length,
    repetitions: matrix.repetitions_per_model_test_cell,
    estimatedCostUsd,
    estimatedIndexingBytes,
    rateLimitProfile,
    estimatedHumanReviewLoad,
  });
}

export function formatBudgetReport(budget: BudgetEstimate): string {
  const lines = [
    "CHEP-1.0 Budget Report",
    "======================",
    "",
    `Total scenarios:       ${budget.totalScenarios}`,
    `Scored scenarios:      ${budget.scoredScenarios}`,
    `Total tests:           ${budget.totalTests}`,
    `Total cells:           ${budget.totalCells}`,
    `Total runs:            ${budget.totalRuns}`,
    `Repetitions per cell:  ${budget.repetitions}`,
    `Conditions:            ${budget.conditions}`,
    `Models:                ${budget.models.join(", ")}`,
    "",
    "Token Estimates (per call):",
    `  Min:      ${budget.estimatedTokensPerCall.min.toLocaleString()}`,
    `  Expected: ${budget.estimatedTokensPerCall.expected.toLocaleString()}`,
    `  Max:      ${budget.estimatedTokensPerCall.max.toLocaleString()}`,
    "",
    `Total tokens (expected): ${budget.totalTokensExpected.toLocaleString()}`,
    `Total tokens (worst):    ${budget.totalTokensWorst.toLocaleString()}`,
    "",
    "Wall Time Estimates:",
    `  Min (s):      ${budget.estimatedWallTimeSeconds.min.toLocaleString()}`,
    `  Expected (s):  ${budget.estimatedWallTimeSeconds.expected.toLocaleString()}`,
    `  Max (s):      ${budget.estimatedWallTimeSeconds.max.toLocaleString()}`,
    "",
    `Max concurrency:       ${budget.maxConcurrency}`,
    `Estimated timeline records: ${budget.estimatedTimelineRecords.toLocaleString()}`,
    `Estimated storage (bytes): ${budget.estimatedStorageBytes.toLocaleString()}`,
    `Estimated indexing (bytes): ${budget.estimatedIndexingBytes.toLocaleString()}`,
    `Estimated cost (USD):  ${budget.estimatedCostUsd.toFixed(6)}`,
    `Rate-limit profile:    ${budget.rateLimitProfile === null ? "unknown until execution" : "observed"}`,
    `Estimated human review load: ${budget.estimatedHumanReviewLoad.toLocaleString()} cells`,
  ];
  return lines.join("\n");
}
