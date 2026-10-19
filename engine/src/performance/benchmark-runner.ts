import { cpus, totalmem, platform, arch, release, hostname } from "node:os";

import { canonicalHash, deepFreeze, generateId } from "../kernel/integrity.ts";
import { extractErrorMessage } from "../kernel/errors.ts";
import { redactText } from "../privacy/redaction-engine.ts";
import { DEFAULT_PRIVACY_POLICY, type PrivacyPolicy } from "../privacy/privacy-policy.ts";
import { percentile } from "../shared/numeric-helpers.ts";
import type { PerformanceConfig } from "./performance-config.ts";
import { schemaId } from "../kernel/product-identity.ts";

/**
 * Benchmark runner for performance and resource observability qualification.
 *
 * Runs repeated cold and warm benchmarks with hardware and runtime
 * fingerprints, p50/p95/p99 comparisons, regression budgets, and
 * instrumentation-overhead budgets. No vendor default, paper, single run,
 * or self-report selects the strategy; missing mandatory benchmark lanes
 * block claims.
 *
 * No raw credentials, PII, prompts, file contents, or unbounded labels.
 */

export const BENCHMARK_RESULT_SCHEMA_VERSION =
  schemaId("benchmark-result", 1);

export type HardwareFingerprint = Readonly<{
  cpuModel: string;
  cpuCount: number;
  cpuSpeedMhz: number;
  totalMemoryBytes: number;
  platform: string;
  arch: string;
  osRelease: string;
  hostname: string;
  nodeVersion: string;
  fingerprintHash: string;
}>;

export type BenchmarkPercentiles = Readonly<{
  p50: number;
  p95: number;
  p99: number;
}>;

export type BenchmarkRepetition = Readonly<{
  repetition: number;
  mode: "cold" | "warm";
  durationMs: number;
  succeeded: boolean;
  errorMessage: string | null;
}>;

export type BenchmarkResult = Readonly<{
  schemaVersion: typeof BENCHMARK_RESULT_SCHEMA_VERSION;
  benchmarkId: string;
  benchmarkName: string;
  hardwareFingerprint: HardwareFingerprint;
  configHash: string;
  repetitions: readonly BenchmarkRepetition[];
  coldPercentiles: BenchmarkPercentiles;
  warmPercentiles: BenchmarkPercentiles;
  minMs: number;
  maxMs: number;
  meanMs: number;
  standardDeviationMs: number;
  regressionBudgetPercent: number;
  regressionDetected: boolean;
  overheadBudgetPercent: number;
  overheadMeasuredPercent: number;
  overheadBudgetExceeded: boolean;
  totalRepetitions: number;
  succeededRepetitions: number;
  failedRepetitions: number;
  wallTime: string;
  totalDurationMs: number;
}>;

export type BenchmarkRunnerOptions = Readonly<{
  config: PerformanceConfig;
  clock?: () => number;
  hardwareFingerprint?: HardwareFingerprint;
  /**
   * The privacy policy the error-message redactor runs under. The CLI
   * resolves it once per invocation from the config document's `privacy`
   * section; omitted means the defaults-only policy (what this runner used
   * before the section was wired).
   */
  privacyPolicy?: PrivacyPolicy;
}>;

export type BenchmarkTarget = Readonly<{
  name: string;
  operation: () => void | Promise<void>;
  coldSetup?: () => void | Promise<void>;
}>;

export type BenchmarkRunner = Readonly<{
  run(target: BenchmarkTarget, baseline?: BenchmarkResult, signal?: AbortSignal): Promise<BenchmarkResult>;
  fingerprint(): HardwareFingerprint;
}>;

/**
 * THE ERROR MESSAGE IS FOREIGN TEXT, AND IT WAS THE ONE FIELD NOTHING TOUCHED.
 *
 * This module's header claims "no raw credentials". `errorMessage` is whatever
 * the benchmarked operation threw — a provider rejection, a driver error, a
 * remote endpoint's wording — and it went into the frozen result verbatim.
 *
 * DRIVEN, before this function existed: an operation throwing
 * `auth failed: sk-PLANT-4d9a1f7e0c2b6853` put the WHOLE canary into
 * `JSON.stringify(result)`, while the test named *"hostile: benchmark result
 * does not contain credentials"* stayed green — because it planted nothing.
 * An absence assertion with no canary was standing in for a claim that was
 * false.
 *
 * The benchmark NAME is deliberately NOT redacted. A target name is chosen by
 * the caller in its own source, not worded by a foreign system, and masking it
 * would destroy the only label a reader has to tell two lanes apart. A caller
 * that puts a secret in a benchmark name has put it in its own source, which is
 * a different problem with a different owner.
 *
 * Fails CLOSED: if the canonical detector cannot run, the message is dropped
 * rather than passed through, because the field exists to be diagnostic and the
 * module exists not to leak.
 */
function safeErrorMessage(config: PerformanceConfig, policy: PrivacyPolicy, error: unknown): string {
  const raw = extractErrorMessage(error);
  if (!config.privacy.redactCredentials) return raw;
  try {
    const engine = redactText(raw, policy);
    return engine.spanCount === 0 ? raw : engine.redactedText;
  } catch {
    return "[redacted: error message could not be screened]";
  }
}

export function createBenchmarkRunner(options: BenchmarkRunnerOptions): BenchmarkRunner {
  const config = options.config;
  const policy = options.privacyPolicy ?? DEFAULT_PRIVACY_POLICY;
  const clock = options.clock ?? (() => performance.now());
  const fingerprintValue = options.hardwareFingerprint ?? captureHardwareFingerprint();

  async function runTarget(
    target: BenchmarkTarget,
    mode: "cold" | "warm",
    repetition: number,
    signal?: AbortSignal,
  ): Promise<BenchmarkRepetition> {
    try {
      if (mode === "cold" && target.coldSetup) await target.coldSetup();
      const startMs = clock();
      await target.operation();
      const durationMs = clock() - startMs;
      if (signal?.aborted) {
        return deepFreeze({
          repetition,
          mode,
          durationMs,
          succeeded: false,
          errorMessage: "cancelled",
        });
      }
      return deepFreeze({ repetition, mode, durationMs, succeeded: true, errorMessage: null });
    } catch (error) {
      return deepFreeze({
        repetition,
        mode,
        durationMs: 0,
        succeeded: false,
        errorMessage: safeErrorMessage(config, policy, error),
      });
    }
  }

  async function runInternal(
    target: BenchmarkTarget,
    baseline: BenchmarkResult | undefined,
    signal?: AbortSignal,
  ): Promise<BenchmarkResult> {
    const minReps = config.budgets.minBenchmarkRepetitions;
    const maxReps = config.budgets.maxBenchmarkRepetitions;
    const maxDurationMs = config.budgets.maxBenchmarkDurationMs;
    const totalStartMs = clock();
    const repetitions: BenchmarkRepetition[] = [];
    const coldReps = Math.max(minReps, Math.min(maxReps, Math.ceil(minReps)));

    for (let i = 0; i < coldReps; i++) {
      if (signal?.aborted) break;
      if (clock() - totalStartMs > maxDurationMs) break;
      repetitions.push(await runTarget(target, "cold", i + 1, signal));
    }
    const warmReps = Math.max(minReps, Math.min(maxReps - coldReps, coldReps));
    for (let i = 0; i < warmReps; i++) {
      if (signal?.aborted) break;
      if (clock() - totalStartMs > maxDurationMs) break;
      repetitions.push(await runTarget(target, "warm", i + 1, signal));
    }

    const coldDurations = repetitions.filter((r) => r.mode === "cold" && r.succeeded).map((r) => r.durationMs);
    const warmDurations = repetitions.filter((r) => r.mode === "warm" && r.succeeded).map((r) => r.durationMs);
    const allDurations = [...coldDurations, ...warmDurations];
    const coldPercentiles = computePercentiles(coldDurations);
    const warmPercentiles = computePercentiles(warmDurations);
    const minMs = allDurations.length > 0 ? Math.min(...allDurations) : 0;
    const maxMs = allDurations.length > 0 ? Math.max(...allDurations) : 0;
    const meanMs = allDurations.length > 0 ? allDurations.reduce((a, b) => a + b, 0) / allDurations.length : 0;
    const standardDeviationMs = allDurations.length > 1
      ? Math.sqrt(allDurations.reduce((sum, d) => sum + Math.pow(d - meanMs, 2), 0) / allDurations.length)
      : 0;

    const regressionBudgetPercent = config.budgets.regressionBudgetPercent;
    const regressionDetected = baseline !== undefined &&
      regressionBudgetPercent > 0 &&
      warmPercentiles.p50 > baseline.warmPercentiles.p50 * (1 + regressionBudgetPercent / 100);

    const overheadBudgetPercent = config.budgets.overheadBudgetPercent;
    const baselineMeanMs = baseline?.meanMs ?? meanMs;
    const overheadMeasuredPercent = baselineMeanMs > 0
      ? Math.abs((meanMs - baselineMeanMs) / baselineMeanMs) * 100
      : 0;
    const overheadBudgetExceeded = overheadMeasuredPercent > overheadBudgetPercent;

    const succeededReps = repetitions.filter((r) => r.succeeded).length;
    const failedReps = repetitions.filter((r) => !r.succeeded).length;

    return deepFreeze({
      schemaVersion: BENCHMARK_RESULT_SCHEMA_VERSION,
      benchmarkId: generateId("bench"),
      benchmarkName: target.name,
      hardwareFingerprint: fingerprintValue,
      configHash: canonicalHash(config),
      repetitions,
      coldPercentiles,
      warmPercentiles,
      minMs,
      maxMs,
      meanMs,
      standardDeviationMs,
      regressionBudgetPercent,
      regressionDetected,
      overheadBudgetPercent,
      overheadMeasuredPercent,
      overheadBudgetExceeded,
      totalRepetitions: repetitions.length,
      succeededRepetitions: succeededReps,
      failedRepetitions: failedReps,
      wallTime: new Date().toISOString(),
      totalDurationMs: clock() - totalStartMs,
    });
  }

  return deepFreeze({
    run: runInternal,
    fingerprint: () => fingerprintValue,
  });
}

export function captureHardwareFingerprint(): HardwareFingerprint {
  const cpuList = cpus();
  const firstCpu = cpuList[0];
  const core: Omit<HardwareFingerprint, "fingerprintHash"> = deepFreeze({
    cpuModel: firstCpu?.model ?? "unknown",
    cpuCount: cpuList.length,
    cpuSpeedMhz: firstCpu?.speed ?? 0,
    totalMemoryBytes: totalmem(),
    platform: platform(),
    arch: arch(),
    osRelease: release(),
    hostname: hostname(),
    nodeVersion: process.version,
  });
  return deepFreeze({ ...core, fingerprintHash: canonicalHash(core) });
}

export function computePercentiles(durations: readonly number[]): BenchmarkPercentiles {
  if (durations.length === 0) return deepFreeze({ p50: 0, p95: 0, p99: 0 });
  // The rank rule lives in `src/shared/numeric-helpers.ts`. This was a
  // byte-identical private copy of it — the second owner of one question,
  // which is how the two drifted contracts above it came to exist.
  const sorted = [...durations].sort((a, b) => a - b);
  return deepFreeze({
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
  });
}

export function validateBenchmarkResult(
  result: BenchmarkResult,
  config: PerformanceConfig,
): readonly string[] {
  const violations: string[] = [];
  if (result.totalRepetitions < config.budgets.minBenchmarkRepetitions) {
    violations.push("benchmark_result_insufficient_repetitions");
  }
  if (result.totalRepetitions > config.budgets.maxBenchmarkRepetitions) {
    violations.push("benchmark_result_excessive_repetitions");
  }
  if (result.totalDurationMs > config.budgets.maxBenchmarkDurationMs) {
    violations.push("benchmark_result_duration_exceeds_budget");
  }
  const coldCount = result.repetitions.filter((r) => r.mode === "cold").length;
  const warmCount = result.repetitions.filter((r) => r.mode === "warm").length;
  if (coldCount === 0) violations.push("benchmark_result_no_cold_repetitions");
  if (warmCount === 0) violations.push("benchmark_result_no_warm_repetitions");
  if (result.failedRepetitions === result.totalRepetitions) {
    violations.push("benchmark_result_all_repetitions_failed");
  }
  if (result.regressionDetected) {
    violations.push("benchmark_result_regression_detected");
  }
  if (result.overheadBudgetExceeded) {
    violations.push("benchmark_result_overhead_budget_exceeded");
  }
  return [...new Set(violations)].toSorted();
}
