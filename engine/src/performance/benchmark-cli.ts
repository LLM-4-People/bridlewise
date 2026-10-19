import { loadPinnedConfigSnapshot } from "../kernel/config.ts";
import { extractErrorMessage, HarnessError, InputError } from "../kernel/errors.ts";
import { wrapResult, type CommandAnswer } from "../workflow/command-result.ts";
import { deepFreeze, sha256Bytes } from "../kernel/integrity.ts";
import {
  createBenchmarkRunner,
  type BenchmarkResult,
  type BenchmarkTarget,
} from "./benchmark-runner.ts";
import { parsePerformanceConfig, type PerformanceConfig } from "./performance-config.ts";
import { configuredPerformanceConfig } from "./configured-performance.ts";
import { schemaId } from "../kernel/product-identity.ts";
// The config door to a policy birth: the document's `privacy` section,
// resolved to policy options once per invocation (a fresh process per run)
// so the error-message redactor runs under the configured policy — and a
// hand-edited section that would weaken redaction is refused here, loudly,
// rather than honored.
import { resolvePrivacyPolicyOptions } from "../privacy/privacy-config-section.ts";
import { createPrivacyPolicy, type PrivacyPolicy } from "../privacy/privacy-policy.ts";

/**
 * `harness benchmark` — run built-in performance benchmarks and report
 * p50/p95/p99 results: the harness envelope (`--json`, the default) or the
 * results table (`--text`), the harness CLI's one output option.
 *
 * Usage:
 * node src/cli.ts harness benchmark [--repetitions N] [--json|--text]
 *
 * The command does not require a provider or API key: every benchmark
 * target is a self-contained CPU/heap operation measured by the central
 * {@link createBenchmarkRunner}. The config is sourced from the pinned
 * central config document's `performance` section
 * ({@link configuredPerformanceConfig}), so budgets and repetition ceilings are
 * centrally owned — not hardcoded here.
 */

export type BenchmarkCliOptions = Readonly<{
  repetitions: number | null;
}>;

export function parseBenchmarkArgs(argv: readonly string[]): BenchmarkCliOptions {
  const opts: { repetitions: number | null } = {
    repetitions: null,
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
      if (!Number.isFinite(n) || n <= 0) throw new InputError(`${name} must be a positive integer`, "input_error");
      return n;
    };
    switch (arg) {
      case "--repetitions": opts.repetitions = nextInt("--repetitions"); break;
      default: throw new InputError(`unknown benchmark flag: ${arg}`, "input_error");
    }
  }
  return deepFreeze(opts);
}

/**
 * Built-in benchmark targets. Each is a self-contained operation that does
 * not touch the network or the filesystem, so the benchmark is deterministic
 * and reproducible across machines (modulo hardware). Real CPU/heap work
 * is exercised, not a no-op, so the numbers reflect actual harness cost.
 */
function buildBenchmarkTargets(): readonly BenchmarkTarget[] {
  const buffer1mb = Buffer.alloc(1_048_576, 0x61);
  return deepFreeze([
    {
      name: "noop-baseline",
      operation: () => {
        // Measures the benchmark loop overhead itself; subtract from real
        // targets to estimate the harness's own measurement cost.
      },
    },
    {
      name: "sha256-1mb",
      operation: () => {
        sha256Bytes(buffer1mb);
      },
    },
    {
      name: "canonical-json-1k-entries",
      operation: () => {
        const obj: Record<string, unknown> = {};
        for (let i = 0; i < 1000; i++) obj[`key${i}`] = i;
        JSON.stringify(obj);
      },
    },
  ]);
}

function resolvePerformanceConfig(repetitions: number | null): PerformanceConfig {
  const base = configuredPerformanceConfig();
  if (repetitions === null) return base;
  // Override the repetition ceilings so the --repetitions flag is honored
  // without exceeding the central policy's safety ceiling.
  return parsePerformanceConfig({
    ...base,
    budgets: { ...base.budgets, maxBenchmarkRepetitions: repetitions, minBenchmarkRepetitions: repetitions },
  });
}

/**
 * The document's `privacy` section as a policy, resolved once per
 * invocation. The config load is not best-effort (a refused configuration
 * propagates, as for the performance section), and neither is the POLICY
 * resolution —
 * a section that violates the redaction floors throws (fail closed,
 * naming the refused values) rather than degrading to defaults over an
 * operator's configured weakening.
 */
function resolvePrivacyPolicy(): PrivacyPolicy {
  const document = loadPinnedConfigSnapshot().document;
  return createPrivacyPolicy(resolvePrivacyPolicyOptions(document.privacy));
}

/** What `harness benchmark` reports: the results, under the hardware they were measured on. */
export type BenchmarkCliReport = Readonly<{ schemaVersion: string; hardwareFingerprint: unknown; results: readonly BenchmarkResult[] }>;

/** Runs every built-in target; its answer passes iff no repetition failed (a target that throws is a typed refusal, `benchmark_target_failed`). */
export async function runBenchmarkCli(argv: readonly string[]): Promise<CommandAnswer<BenchmarkCliReport>> {
  const opts = parseBenchmarkArgs(argv);
  const config = resolvePerformanceConfig(opts.repetitions);
  const runner = createBenchmarkRunner({ config, privacyPolicy: resolvePrivacyPolicy() });
  const targets = buildBenchmarkTargets();
  const results: BenchmarkResult[] = [];
  for (const target of targets) {
    try {
      const result = await runner.run(target);
      results.push(result);
    } catch (error) {
      throw new HarnessError(`benchmark '${target.name}' failed: ${extractErrorMessage(error)}`, "benchmark_target_failed");
    }
  }
  const report: BenchmarkCliReport = deepFreeze({
    schemaVersion: schemaId("benchmark-cli", 1),
    hardwareFingerprint: runner.fingerprint(),
    results: deepFreeze(results),
  });
  return deepFreeze({
    result: wrapResult("benchmark", report, { status: results.every((r) => r.failedRepetitions === 0) ? "pass" : "fail" }),
    text: () => `${formatBenchmarkReport(results)}\n`,
  });
}

function formatBenchmarkReport(results: readonly BenchmarkResult[]): string {
  const lines: string[] = [];
  lines.push("=== Harness Benchmark Results ===");
  for (const result of results) {
    lines.push(`  ${result.benchmarkName}:`);
    lines.push(`    reps=${result.totalRepetitions} failed=${result.failedRepetitions}`);
    lines.push(`    cold:  p50=${result.coldPercentiles.p50.toFixed(3)}ms p95=${result.coldPercentiles.p95.toFixed(3)}ms p99=${result.coldPercentiles.p99.toFixed(3)}ms`);
    lines.push(`    warm:  p50=${result.warmPercentiles.p50.toFixed(3)}ms p95=${result.warmPercentiles.p95.toFixed(3)}ms p99=${result.warmPercentiles.p99.toFixed(3)}ms`);
    lines.push(`    min=${result.minMs.toFixed(3)}ms max=${result.maxMs.toFixed(3)}ms mean=${result.meanMs.toFixed(3)}ms stddev=${result.standardDeviationMs.toFixed(3)}ms`);
    if (result.regressionDetected) lines.push(`    REGRESSION detected (budget ${result.regressionBudgetPercent}%)`);
  }
  lines.push("=================================");
  return lines.join("\n");
}
