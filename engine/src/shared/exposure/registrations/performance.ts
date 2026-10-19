/**
 * Shared exposure registrations — `performance` module.
 *
 * The observability surfaces: the knobs of the canonical performance config
 * section (resource deltas, the process sampler, the benchmark command's run
 * bounds, the diagnostic command's mode timeout), the LIVE metrics signals
 * the server's metrics bridge measures, and the benchmark tool's two
 * detection budgets served READ-ONLY (a budget that decides a tool's verdict
 * is that tool's contract — the room shows it, the room does not write it).
 *
 * THE STATE-SOURCE SEAM (the pattern `safety.ts` established for the
 * event-feed detectors): the engine registration owns the SIGNALS; their
 * values read through an installable source. The web server's metrics owner
 * (`server/observability/metrics-bridge.ts`) installs one at boot that
 * reads the SAME bridge `/api/metrics` serves — the collector's per-scope
 * snapshot folded to the registry's declared quantities, the token
 * throughput, the self-improving analyzer's count, and the resource
 * sampler's own last tick. No second fetch path exists: the signal `value`
 * reads the bridge through the source, never a parallel HTTP client.
 *
 * HONEST ABSENCE: with no source installed (engine tests, a host that has
 * not booted the metrics bridge) every signal reads its zero — no
 * measurement was taken in this process — and `samplerActive` reads false,
 * which is itself the honest statement that the resource rows are not live.
 */

import {
  registerCustomization,
  registerExposureModule,
  registerSignal,
} from "../index.ts";
import {
  readBooleanCustomization,
  readNumberCustomization,
  writeConfigCustomization,
} from "../config-binding.ts";
import {
  DEFAULT_PERFORMANCE_CONFIG,
  DEFAULT_RESOURCE_DELTAS_ENABLED,
  DEFAULT_RESOURCE_SAMPLER_ENABLED,
  DEFAULT_RESOURCE_SAMPLER_INTERVAL_MS,
} from "../../../performance/performance-config.ts";

// ── The live metrics state source (installed by the server's bridge) ────────

/**
 * The measured performance facts the signals serve. Every number is
 * MEASURED by the metrics bridge (the collector's snapshot, the token
 * accumulator, the self-improving analyzer over the same snapshot, the
 * sampler's last tick) — nothing here is synthesized, and a lane that
 * recorded nothing reads zero.
 */
export type PerformanceMetricsState = Readonly<{
  /** Totals across every recorded scope (the collector's snapshot). */
  callCount: number;
  errorCount: number;
  cancellationCount: number;
  /** The llm lane's own counts (scope keys with module "llm"). */
  llmCalls: number;
  llmErrors: number;
  llmCancellations: number;
  /** The tool lane's own counts (scope keys with module "tool"). */
  toolCalls: number;
  toolErrors: number;
  toolCancellations: number;
  /** Duration quantiles over every recorded call, in ms (0 when none). */
  durationP50Ms: number;
  durationP95Ms: number;
  /** Summed resource aggregates of the recorded calls. */
  cpuTimeMs: number;
  heapDeltaBytes: number;
  /** Token throughput since the server started. */
  tokensPerSecond: number;
  /** The self-improving analyzer's suggestion count over the same snapshot. */
  selfImprovingSuggestions: number;
  /** Whether the resource sampler's timer is running in this process. */
  samplerActive: boolean;
  /**
   * The resource sampler's own last tick — the live head of the resource
   * series — or null before the first tick (a disabled or freshly started
   * sampler has measured nothing yet).
   */
  lastSample: Readonly<{
    rssBytes: number;
    heapUsedBytes: number;
    eventLoopUtilization: number;
  }> | null;
  /**
   * Browser errors this process ingested through the client-telemetry
   * door (uncaught page exceptions + unhandled promise rejections the
   * pages reported). Zero until the first batch lands.
   */
  clientErrors: number;
  /**
   * The worst main-thread long task any browser reported through the
   * client-telemetry door, in ms. Zero until a page reports one — the
   * honest absence, same contract as the sampler's last tick.
   */
  clientWorstLongTaskMs: number;
}>;

export type PerformanceMetricsStateSource = () => PerformanceMetricsState;

let metricsSource: PerformanceMetricsStateSource | null = null;

/**
 * Install the live metrics source (the web metrics-bridge owner installs
 * this once at boot). Replaces any previous source — the owner is singular.
 */
export function installPerformanceMetricsSource(source: PerformanceMetricsStateSource): void {
  metricsSource = source;
}

/** Remove the live metrics source (test/reset hook). */
export function clearPerformanceMetricsSource(): void {
  metricsSource = null;
}

/** The honest fallback when no source is installed: nothing was measured. */
const NO_MEASUREMENTS: PerformanceMetricsState = Object.freeze({
  callCount: 0,
  errorCount: 0,
  cancellationCount: 0,
  llmCalls: 0,
  llmErrors: 0,
  llmCancellations: 0,
  toolCalls: 0,
  toolErrors: 0,
  toolCancellations: 0,
  durationP50Ms: 0,
  durationP95Ms: 0,
  cpuTimeMs: 0,
  heapDeltaBytes: 0,
  tokensPerSecond: 0,
  selfImprovingSuggestions: 0,
  samplerActive: false,
  lastSample: null,
  clientErrors: 0,
  clientWorstLongTaskMs: 0,
});

function metricsState(): PerformanceMetricsState {
  return metricsSource?.() ?? NO_MEASUREMENTS;
}

// ── Registration ────────────────────────────────────────────────────────────

let performanceRegistered = false;
export function registerPerformanceExposure(): void {
  if (performanceRegistered) return;
  performanceRegistered = true;

  registerExposureModule({
    id: "performance",
    title: "What the harness measures about itself",
    purpose:
      "The dials and switches of the harness's own observability: what each recorded call cost in time, CPU and memory, how fast tokens flow, what the process resource sampler keeps an eye on, and how long the harness's own benchmark and diagnostic probes may run.",
  });

  // --- Signals (23: the live metrics + the read-only detection budgets) ---
  registerSignal({
    id: "performance.callCount",
    module: "performance",
    name: "Recorded calls",
    description: "Total measured calls across every scope the collector recorded.",
    type: "counter",
    unit: "calls",
    value: () => metricsState().callCount,
  });
  registerSignal({
    id: "performance.errorCount",
    module: "performance",
    name: "Failed calls",
    description: "Recorded calls that failed, across every scope.",
    type: "counter",
    unit: "count",
    value: () => metricsState().errorCount,
  });
  registerSignal({
    id: "performance.cancellationCount",
    module: "performance",
    name: "Cancelled calls",
    description: "Recorded calls that were cancelled before finishing, across every scope.",
    type: "counter",
    unit: "count",
    value: () => metricsState().cancellationCount,
  });
  registerSignal({
    id: "performance.llmCalls",
    module: "performance",
    name: "Model calls",
    description: "Recorded model stream calls, per the llm lane of the collector.",
    type: "counter",
    unit: "calls",
    value: () => metricsState().llmCalls,
  });
  registerSignal({
    id: "performance.llmErrors",
    module: "performance",
    name: "Failed model calls",
    description: "Model stream calls that failed.",
    type: "counter",
    unit: "count",
    value: () => metricsState().llmErrors,
  });
  registerSignal({
    id: "performance.llmCancellations",
    module: "performance",
    name: "Cancelled model calls",
    description: "Model streams abandoned or stopped before their natural end.",
    type: "counter",
    unit: "count",
    value: () => metricsState().llmCancellations,
  });
  registerSignal({
    id: "performance.toolCalls",
    module: "performance",
    name: "Tool calls",
    description: "Recorded tool executions, per the tool lane of the collector.",
    type: "counter",
    unit: "calls",
    value: () => metricsState().toolCalls,
  });
  registerSignal({
    id: "performance.toolErrors",
    module: "performance",
    name: "Failed tool calls",
    description: "Tool executions that failed.",
    type: "counter",
    unit: "count",
    value: () => metricsState().toolErrors,
  });
  registerSignal({
    id: "performance.toolCancellations",
    module: "performance",
    name: "Cancelled tool calls",
    description: "Tool executions cancelled before finishing.",
    type: "counter",
    unit: "count",
    value: () => metricsState().toolCancellations,
  });
  registerSignal({
    id: "performance.durationP50Ms",
    module: "performance",
    name: "Half of calls finished within",
    description: "The median duration of every recorded call, from the collector's histograms.",
    type: "timer",
    unit: "ms",
    value: () => metricsState().durationP50Ms,
  });
  registerSignal({
    id: "performance.durationP95Ms",
    module: "performance",
    name: "19 of 20 calls finished within",
    description: "The 95th-percentile duration of every recorded call — the slow tail the median hides.",
    type: "timer",
    unit: "ms",
    value: () => metricsState().durationP95Ms,
  });
  registerSignal({
    id: "performance.cpuTimeMs",
    module: "performance",
    name: "CPU time spent by recorded calls",
    description: "Sum of the CPU time the recorded calls consumed, when resource deltas are captured.",
    type: "counter",
    unit: "ms",
    value: () => metricsState().cpuTimeMs,
  });
  registerSignal({
    id: "performance.heapDeltaBytes",
    module: "performance",
    name: "Memory growth of recorded calls",
    description: "Sum of heap growth across the recorded calls — negative when they released more than they allocated.",
    type: "gauge",
    unit: "bytes",
    value: () => metricsState().heapDeltaBytes,
  });
  registerSignal({
    id: "performance.tokensPerSecond",
    module: "performance",
    name: "Tokens per second",
    description: "Token throughput since the server started, from the metrics recorder's accumulator.",
    type: "gauge",
    unit: "tokens/s",
    value: () => metricsState().tokensPerSecond,
  });
  registerSignal({
    id: "performance.selfImprovingSuggestions",
    module: "performance",
    name: "Self-improving suggestions",
    description: "Improvement suggestions the analyzer found in the live measurements — failing tools, slow models, heavy cancellations.",
    type: "counter",
    unit: "count",
    value: () => metricsState().selfImprovingSuggestions,
  });
  registerSignal({
    id: "performance.samplerActive",
    module: "performance",
    name: "Resource sampler running",
    description: "Whether the process resource sampler is ticking in this server right now.",
    type: "boolean",
    value: () => metricsState().samplerActive,
  });
  registerSignal({
    id: "performance.processRssBytes",
    module: "performance",
    name: "Process memory held resident",
    description: "The server process's resident set size as the resource sampler last measured it. Zero until the first sample lands.",
    type: "gauge",
    unit: "bytes",
    value: () => metricsState().lastSample?.rssBytes ?? 0,
  });
  registerSignal({
    id: "performance.processHeapUsedBytes",
    module: "performance",
    name: "Process heap in use",
    description: "The server process's used heap as the resource sampler last measured it. Zero until the first sample lands.",
    type: "gauge",
    unit: "bytes",
    value: () => metricsState().lastSample?.heapUsedBytes ?? 0,
  });
  registerSignal({
    id: "performance.eventLoopUtilization",
    module: "performance",
    name: "Event loop busy share",
    description: "How busy the event loop was since the previous sample, as the resource sampler last measured it. Zero until the first sample lands.",
    type: "gauge",
    unit: "ratio",
    value: () => metricsState().lastSample?.eventLoopUtilization ?? 0,
  });
  registerSignal({
    id: "performance.resourceDeltasEnabled",
    module: "performance",
    name: "Measuring what each call costs",
    description: "Whether every recorded effect also measures the CPU time and memory growth it caused.",
    type: "boolean",
    value: () => readBooleanCustomization("performance.resourceDeltas.enabled", DEFAULT_RESOURCE_DELTAS_ENABLED),
  });
  registerSignal({
    id: "performance.resourceSamplerEnabled",
    module: "performance",
    name: "Watching the process's own footprint",
    description: "Whether the process resource sampler writes a periodic sample of memory, CPU and event-loop load to the ledger.",
    type: "boolean",
    value: () => readBooleanCustomization("performance.resourceSampler.enabled", DEFAULT_RESOURCE_SAMPLER_ENABLED),
  });
  registerSignal({
    id: "performance.clientErrors",
    module: "performance",
    name: "Browser errors received",
    description: "Uncaught page exceptions and unhandled promise rejections browsers have sent through the telemetry door. Zero until the first batch lands.",
    type: "counter",
    unit: "count",
    value: () => metricsState().clientErrors,
  });
  registerSignal({
    id: "performance.clientWorstLongTaskMilliseconds",
    module: "performance",
    name: "Worst browser long task",
    description: "The longest main-thread block any browser has reported through the telemetry door. Zero until a page reports one.",
    type: "timer",
    unit: "ms",
    value: () => metricsState().clientWorstLongTaskMs,
  });

  // --- Customizations (7) ---
  // Read by the effect wrapper at every wrapped effect (the resource delta
  // probe's result is recorded or skipped by this switch), so a change lands
  // on the very next recorded effect — which is what `immediate` states.
  registerCustomization({
    id: "performance.resourceDeltas",
    module: "performance",
    name: "Measure what each recorded call costs",
    description:
      "On: every recorded effect also measures the CPU time it consumed and the memory growth it caused, beside its duration. Off: recorded effects keep their timing only, and the CPU and memory signals stop moving.",
    type: "boolean",
    default: DEFAULT_RESOURCE_DELTAS_ENABLED,
    current: () => readBooleanCustomization("performance.resourceDeltas.enabled", DEFAULT_RESOURCE_DELTAS_ENABLED),
    set: (v) => writeConfigCustomization("performance.resourceDeltas.enabled", v),
    contract: { effect: "immediate" },
    measuredBy: "performance.resourceDeltasEnabled",
    configPath: "performance.resourceDeltas.enabled",
  });
  // The sampler resolves its config once, at server start — the declared
  // timing says so honestly instead of pretending a live switch.
  registerCustomization({
    id: "performance.resourceSamplerEnabled",
    module: "performance",
    name: "Watch the process's own footprint",
    description:
      "On: the server samples its own memory, CPU and event-loop load on a timer and writes each sample to the recorded ledger. Off: no samples are taken. Takes effect after a restart.",
    type: "boolean",
    default: DEFAULT_RESOURCE_SAMPLER_ENABLED,
    current: () => readBooleanCustomization("performance.resourceSampler.enabled", DEFAULT_RESOURCE_SAMPLER_ENABLED),
    set: (v) => writeConfigCustomization("performance.resourceSampler.enabled", v),
    contract: { effect: "restart" },
    measuredBy: "performance.resourceSamplerEnabled",
    configPath: "performance.resourceSampler.enabled",
  });
  registerCustomization({
    id: "performance.resourceSamplerIntervalMs",
    module: "performance",
    name: "How often the process footprint is sampled",
    description:
      "How often the resource sampler takes a sample of the process's memory, CPU and event-loop load. Lower = a finer-grained record of what the server was doing, at the cost of more ledger rows. Takes effect after a restart.",
    type: "number",
    default: DEFAULT_RESOURCE_SAMPLER_INTERVAL_MS,
    min: 1,
    max: 3_600_000,
    unit: "milliseconds",
    current: () => readNumberCustomization("performance.resourceSampler.intervalMs", DEFAULT_RESOURCE_SAMPLER_INTERVAL_MS),
    set: (v) => writeConfigCustomization("performance.resourceSampler.intervalMs", v),
    contract: { effect: "restart" },
    configPath: "performance.resourceSampler.intervalMs",
  });
  // --- Customizations (the benchmark and diagnostic doors) ---
  // The benchmark and diagnostic commands resolve the performance section
  // from the config file once per invocation (each command run is a fresh
  // process), so a settings write lands in the file and the NEXT run of the
  // command reads it — which is what each row's `next-run` effect states.
  registerCustomization({
    id: "performance.benchmarkMinRepetitions",
    module: "performance",
    name: "Fewest times each benchmark target runs",
    description:
      "How many cold and how many warm repetitions the built-in benchmark command runs each target at minimum when it measures the harness's own costs (hashing, canonical JSON, the no-op baseline). Higher = steadier percentiles from more samples, at the cost of a longer benchmark. Takes effect on the next benchmark run.",
    type: "number",
    default: DEFAULT_PERFORMANCE_CONFIG.budgets.minBenchmarkRepetitions,
    min: 1,
    max: 100,
    unit: "repetitions",
    current: () =>
      readNumberCustomization(
        "performance.budgets.minBenchmarkRepetitions",
        DEFAULT_PERFORMANCE_CONFIG.budgets.minBenchmarkRepetitions,
      ),
    set: (v) => writeConfigCustomization("performance.budgets.minBenchmarkRepetitions", v),
    contract: { effect: "next-run" },
    configPath: "performance.budgets.minBenchmarkRepetitions",
  });
  registerCustomization({
    id: "performance.benchmarkMaxRepetitions",
    module: "performance",
    name: "Most times each benchmark target runs",
    description:
      "The ceiling on how many times the built-in benchmark command repeats each target. Higher = more reliable percentiles and a longer benchmark; lower = a quicker run with noisier numbers. Takes effect on the next benchmark run.",
    type: "number",
    default: DEFAULT_PERFORMANCE_CONFIG.budgets.maxBenchmarkRepetitions,
    min: 1,
    max: 10_000,
    unit: "repetitions",
    current: () =>
      readNumberCustomization(
        "performance.budgets.maxBenchmarkRepetitions",
        DEFAULT_PERFORMANCE_CONFIG.budgets.maxBenchmarkRepetitions,
      ),
    set: (v) => writeConfigCustomization("performance.budgets.maxBenchmarkRepetitions", v),
    contract: { effect: "next-run" },
    configPath: "performance.budgets.maxBenchmarkRepetitions",
  });
  registerCustomization({
    id: "performance.benchmarkMaxDurationMs",
    module: "performance",
    name: "Longest one benchmark target may run",
    description:
      "The benchmark command stops adding repetitions for a target once it has run longer than this many milliseconds, so one slow measurement cannot stretch the whole run without bound. Takes effect on the next benchmark run.",
    type: "number",
    default: DEFAULT_PERFORMANCE_CONFIG.budgets.maxBenchmarkDurationMs,
    min: 1,
    max: 3_600_000,
    unit: "milliseconds",
    current: () =>
      readNumberCustomization(
        "performance.budgets.maxBenchmarkDurationMs",
        DEFAULT_PERFORMANCE_CONFIG.budgets.maxBenchmarkDurationMs,
      ),
    set: (v) => writeConfigCustomization("performance.budgets.maxBenchmarkDurationMs", v),
    contract: { effect: "next-run" },
    configPath: "performance.budgets.maxBenchmarkDurationMs",
  });
  registerCustomization({
    id: "performance.diagnosticModeTimeoutMs",
    module: "performance",
    name: "How long one diagnostic mode may run",
    description:
      "Each mode of the diagnostic command (CPU, memory, I/O, event loop, process, cgroup) is reported as timed out — and the command exits with a failure — once its collection runs longer than this many milliseconds, so a slow probe cannot pass unnoticed. Takes effect on the next diagnostic run.",
    type: "number",
    default: DEFAULT_PERFORMANCE_CONFIG.diagnosticModes.modeTimeoutMs,
    min: 1,
    max: 3_600_000,
    unit: "milliseconds",
    current: () =>
      readNumberCustomization(
        "performance.diagnosticModes.modeTimeoutMs",
        DEFAULT_PERFORMANCE_CONFIG.diagnosticModes.modeTimeoutMs,
      ),
    set: (v) => writeConfigCustomization("performance.diagnosticModes.modeTimeoutMs", v),
    contract: { effect: "next-run" },
    configPath: "performance.diagnosticModes.modeTimeoutMs",
  });
  // --- Signals (the benchmark tool's own detection budgets, read-only) ---
  // A budget that decides a tool's verdict is the tool's detection contract:
  // writable from a settings cookie it could be loosened silently, which
  // would quietly weaken what the report's REGRESSION/overhead flags mean.
  // The registry's read-only primitive is the signal, so these two budgets
  // are served as signals — visible beside the rows that tune the tool's
  // run bounds, never writable from the settings room.
  registerSignal({
    id: "performance.benchmarkRegressionBudgetPercent",
    module: "performance",
    name: "Benchmark regression budget",
    description:
      "The percent by which a warm run's median must exceed the recorded baseline's median before the benchmark report says a regression was detected. Shown read-only: this budget is the benchmark tool's own detection contract, and loosening it would quietly weaken what the report's verdict means.",
    type: "gauge",
    unit: "percent",
    value: () =>
      readNumberCustomization(
        "performance.budgets.regressionBudgetPercent",
        DEFAULT_PERFORMANCE_CONFIG.budgets.regressionBudgetPercent,
      ),
  });
  registerSignal({
    id: "performance.benchmarkOverheadBudgetPercent",
    module: "performance",
    name: "Benchmark overhead budget",
    description:
      "The percent of drift the benchmark report tolerates between a run and its baseline before it flags the measurement overhead as exceeded. Shown read-only: the budget decides the tool's own verdict, not a preference the settings room tunes.",
    type: "gauge",
    unit: "percent",
    value: () =>
      readNumberCustomization(
        "performance.budgets.overheadBudgetPercent",
        DEFAULT_PERFORMANCE_CONFIG.budgets.overheadBudgetPercent,
      ),
  });
}

/** Reset the per-module registration flag (test-only). */
export function resetPerformanceRegistration(): void {
  performanceRegistered = false;
}
