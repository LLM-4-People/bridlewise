import { InputError } from "../kernel/errors.ts";
import { bestEffort } from "../shared/best-effort.ts";
import { canonicalHash, deepFreeze, generateId } from "../kernel/integrity.ts";
import type { PerformanceConfig } from "./performance-config.ts";
import { isForbiddenLabelText, redactLabelValue } from "./performance-config.ts";
import { schemaId } from "../kernel/product-identity.ts";

/**
 * Low-overhead always-on metrics collector.
 *
 * Aggregates call count, error count, cancellation count, and duration
 * histograms (p50/p95/p99) per correlated scope. The hot path (recordCall)
 * uses pre-allocated numeric counters and fixed-bucket histograms with O(1)
 * insertion — no string building, no object allocation, no synchronous I/O.
 *
 * Sampled call traces are configurable and off by default (samplingRate=0).
 * When enabled, a trace is only allocated when the sampling decision fires.
 *
 * Correlation IDs span run, turn, task, agent, provider, model, tool, commit,
 * tree, config, test, and timeline. No raw credentials, PII, prompts, file
 * contents, or unbounded labels enter metrics or labels.
 */

export type MetricCorrelation = Readonly<{
  runId?: string;
  turnId?: string;
  taskId?: string;
  attemptId?: string;
  agentId?: string;
  providerId?: string;
  modelId?: string;
  toolName?: string;
  commitSha?: string;
  treeHash?: string;
  configHash?: string;
  testId?: string;
  timelineId?: string;
}>;

export type MetricScopeKey = Readonly<{
  module: string;
  function: string;
  scope: string;
}>;

export type DurationHistogramSnapshot = Readonly<{
  bucketCount: number;
  bucketStrategy: string;
  bounds: readonly number[];
  counts: readonly number[];
  totalCount: number;
  minMs: number;
  maxMs: number;
  sumMs: number;
}>;

/**
 * What one measured window cost the process: CPU time consumed (user +
 * system, in ms) and the heap growth it caused (in bytes — NEGATIVE when the
 * window released more than it allocated, which is a normal, meaningful
 * reading, not an error).
 */
export type ResourceDelta = Readonly<{
  cpuMs: number;
  heapDeltaBytes: number;
}>;

/**
 * Measure a resource delta across a window of work.
 *
 * THE one owner of the "what did this window cost" measurement — the effect
 * wrapper and the metrics call sites both start one of these beside their
 * wall-clock start, so no second implementation of the cpuUsage/memoryUsage
 * arithmetic can drift. `stop()` is called once, when the window settles; the
 * pair of process reads costs on the order of a microsecond, which is why the
 * measurement can sit unconditionally at choke points (the config contract's
 * `resourceDeltas.enabled` governs whether the RESULT is recorded, not
 * whether a cheap read happens).
 */
export function startResourceDeltaProbe(): Readonly<{ stop(): ResourceDelta }> {
  const startCpu = process.cpuUsage();
  const startHeap = process.memoryUsage().heapUsed;
  return {
    stop(): ResourceDelta {
      return {
        cpuMs: cpuDeltaMs(startCpu),
        heapDeltaBytes: heapDelta(startHeap),
      };
    },
  };
}

/** CPU time (user + system) since `start`, in ms — 0 when the kernel refuses. */
function cpuDeltaMs(start: NodeJS.CpuUsage): number {
  // Passing the start value makes the kernel report the DELTA directly.
  try {
    const delta = process.cpuUsage(start);
    return (delta.user + delta.system) / 1000;
  } catch {
    return 0;
  }
}

/** Heap growth since `start`, in bytes (negative = net release) — 0 when the kernel refuses. */
function heapDelta(start: number): number {
  try {
    return process.memoryUsage().heapUsed - start;
  } catch {
    return 0;
  }
}

export type MetricEntrySnapshot = Readonly<{
  key: MetricScopeKey;
  correlation: MetricCorrelation;
  callCount: number;
  errorCount: number;
  cancellationCount: number;
  durationHistogram: DurationHistogramSnapshot;
  /** Sum of the CPU time (ms) the recorded calls consumed. 0 when no call
   *  carried a resource delta (capture disabled or not supplied). */
  totalCpuMs: number;
  /** Sum of the heap growth (bytes) across the recorded calls — negative
   *  when the scope released more than it allocated. 0 when no call carried
   *  a resource delta. */
  totalHeapDeltaBytes: number;
  attribution: "exact" | "shared" | "estimated";
}>;

export type MetricsSnapshot = Readonly<{
  schemaVersion: string;
  snapshotId: string;
  wallTime: string;
  entryCount: number;
  entries: readonly MetricEntrySnapshot[];
  totalCallCount: number;
  totalErrorCount: number;
  totalCancellationCount: number;
  configHash: string;
}>;

export type SampledTrace = Readonly<{
  traceId: string;
  key: MetricScopeKey;
  correlation: MetricCorrelation;
  startMs: number;
  endMs: number;
  durationMs: number;
  outcome: "succeeded" | "failed" | "cancelled";
  attribution: "exact" | "shared" | "estimated";
}>;

type MutableMetricEntry = {
  key: MetricScopeKey;
  correlation: MetricCorrelation;
  callCount: number;
  errorCount: number;
  cancellationCount: number;
  histogram: DurationHistogram;
  totalCpuMs: number;
  totalHeapDeltaBytes: number;
  attribution: "exact" | "shared" | "estimated";
};

class DurationHistogram {
  readonly bucketCount: number;
  readonly bucketStrategy: string;
  readonly bounds: Float64Array;
  readonly counts: Float64Array;
  totalCount = 0;
  minMs = Number.POSITIVE_INFINITY;
  maxMs = 0;
  sumMs = 0;

  constructor(config: PerformanceConfig) {
    this.bucketCount = config.histograms.bucketCount;
    this.bucketStrategy = config.histograms.bucketStrategy;
    this.bounds = computeBounds(config);
    this.counts = new Float64Array(this.bucketCount);
  }

  record(durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    this.totalCount++;
    if (durationMs < this.minMs) this.minMs = durationMs;
    if (durationMs > this.maxMs) this.maxMs = durationMs;
    this.sumMs += durationMs;
    const bucketIndex = this.bucketIndex(durationMs);
    this.counts[bucketIndex]!++;
  }

  private bucketIndex(value: number): number {
    const max = this.bounds.length;
    let lo = 0;
    let hi = max;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (value <= this.bounds[mid]!) hi = mid;
      else lo = mid + 1;
    }
    return Math.min(lo, this.bucketCount - 1);
  }

  quantile(q: number): number {
    if (this.totalCount === 0) return 0;
    const target = q * this.totalCount;
    let cumulative = 0;
    for (let i = 0; i < this.bucketCount; i++) {
      cumulative += this.counts[i]!;
      if (cumulative >= target) {
        if (i === 0) return this.bounds[0]! * q * this.totalCount / (cumulative || 1);
        return this.bounds[i - 1]! + (this.bounds[i]! - this.bounds[i - 1]!) * (target - (cumulative - this.counts[i]!)) / (this.counts[i]! || 1);
      }
    }
    return this.maxMs;
  }

  snapshot(): DurationHistogramSnapshot {
    return deepFreeze({
      bucketCount: this.bucketCount,
      bucketStrategy: this.bucketStrategy,
      bounds: [...this.bounds],
      counts: [...this.counts],
      totalCount: this.totalCount,
      minMs: this.totalCount === 0 ? 0 : this.minMs,
      maxMs: this.maxMs,
      sumMs: this.sumMs,
    });
  }
}

function computeBounds(config: PerformanceConfig): Float64Array {
  const count = config.histograms.bucketCount;
  const maxMs = config.histograms.maxDurationMs;
  const bounds = new Float64Array(count);
  if (config.histograms.bucketStrategy === "linear") {
    const step = maxMs / count;
    for (let i = 0; i < count; i++) bounds[i] = (i + 1) * step;
  } else if (config.histograms.bucketStrategy === "log-linear") {
    const logMax = Math.log(maxMs + 1);
    for (let i = 0; i < count; i++) bounds[i] = Math.exp((i + 1) * logMax / count) - 1;
  } else if (config.histograms.explicitBounds !== undefined) {
    const explicit = config.histograms.explicitBounds;
    for (let i = 0; i < count; i++) bounds[i] = i < explicit.length ? explicit[i]! : maxMs;
  } else {
    const step = maxMs / count;
    for (let i = 0; i < count; i++) bounds[i] = (i + 1) * step;
  }
  return bounds;
}

export type MetricsCollectorOptions = Readonly<{
  config: PerformanceConfig;
  clock?: () => number;
}>;

export type MetricsCollector = Readonly<{
  recordCallStart(key: MetricScopeKey, correlation: MetricCorrelation, attribution?: "exact" | "shared" | "estimated"): () => void;
  recordCall(
    key: MetricScopeKey,
    correlation: MetricCorrelation,
    durationMs: number,
    outcome?: "succeeded" | "failed" | "cancelled",
    attribution?: "exact" | "shared" | "estimated",
    resource?: ResourceDelta,
  ): void;
  recordError(key: MetricScopeKey, correlation: MetricCorrelation): void;
  recordCancellation(key: MetricScopeKey, correlation: MetricCorrelation): void;
  snapshot(): MetricsSnapshot;
  /**
   * Emit the current snapshot to an exporter without clearing state. Called
   * by the chat runtime on a configured interval (performance.exporters.exportIntervalMs)
   * and on shutdown so metrics survive session end. The exporter decides
   * where the snapshot goes (timeline event, file, OTLP, prometheus).
   */
  flush(exportFn: (snapshot: MetricsSnapshot) => void): void;
  sampledTraces(): readonly SampledTrace[];
  entryCount(): number;
  reset(): void;
  close(): void;
}>;

export function createMetricsCollector(options: MetricsCollectorOptions): MetricsCollector {
  const config = options.config;
  if (!config.enabled) {
    return createNoopMetricsCollector(config);
  }
  const clock = options.clock ?? (() => performance.now());
  const entries = new Map<string, MutableMetricEntry>();
  const traces: SampledTrace[] = [];
  const maxTraces = config.sampling.maxTracesPerScope;
  const samplingRate = config.sampling.traceSamplingRate;
  const maxSeries = config.cardinality.maxTotalSeries;
  let totalCallCount = 0;
  let totalErrorCount = 0;
  let totalCancellationCount = 0;
  let closed = false;

  function entryKey(key: MetricScopeKey, correlation: MetricCorrelation): string {
    return canonicalHash({ key, correlation: sanitizeCorrelation(correlation, config) });
  }

  function getOrCreateEntry(
    key: MetricScopeKey,
    correlation: MetricCorrelation,
    attribution: "exact" | "shared" | "estimated",
  ): MutableMetricEntry | undefined {
    const id = entryKey(key, correlation);
    let entry = entries.get(id);
    if (entry === undefined) {
      if (entries.size >= maxSeries) return undefined;
      entry = {
        key,
        correlation: sanitizeCorrelation(correlation, config),
        callCount: 0,
        errorCount: 0,
        cancellationCount: 0,
        histogram: new DurationHistogram(config),
        totalCpuMs: 0,
        totalHeapDeltaBytes: 0,
        attribution,
      };
      entries.set(id, entry);
    }
    return entry;
  }

  function shouldSample(): boolean {
    if (samplingRate <= 0) return false;
    if (samplingRate >= 1) return true;
    return Math.random() < samplingRate;
  }

  /** The one write path into an entry — both recordCall and recordCallStart's
   *  completion callback land here, so the aggregates can never diverge. */
  function recordInto(
    key: MetricScopeKey,
    correlation: MetricCorrelation,
    durationMs: number,
    outcome: "succeeded" | "failed" | "cancelled",
    attribution: "exact" | "shared" | "estimated",
    resource?: ResourceDelta,
  ): void {
    if (closed) return;
    const entry = getOrCreateEntry(key, correlation, attribution);
    if (entry === undefined) return;
    entry.callCount++;
    totalCallCount++;
    entry.histogram.record(durationMs);
    if (resource !== undefined) {
      // Only finite readings move the aggregates: a probe that could not
      // measure (its catch paths report 0) must not be distinguishable from
      // a window that genuinely cost nothing, and a NaN must never poison a
      // sum.
      if (Number.isFinite(resource.cpuMs)) entry.totalCpuMs += resource.cpuMs;
      if (Number.isFinite(resource.heapDeltaBytes)) entry.totalHeapDeltaBytes += resource.heapDeltaBytes;
    }
    if (outcome === "failed") {
      entry.errorCount++;
      totalErrorCount++;
    } else if (outcome === "cancelled") {
      entry.cancellationCount++;
      totalCancellationCount++;
    }
    if (shouldSample() && traces.length < maxTraces) {
      traces.push(deepFreeze({
        traceId: generateId("trace"),
        key,
        correlation: entry.correlation,
        startMs: clock() - durationMs,
        endMs: clock(),
        durationMs,
        outcome,
        attribution,
      }));
    }
  }

  return deepFreeze({
    recordCallStart(key, correlation, attribution = "shared") {
      const startMs = clock();
      return () => {
        const endMs = clock();
        const durationMs = endMs - startMs;
        recordInto(key, correlation, durationMs, "succeeded", attribution);
      };
    },
    recordCall(key, correlation, durationMs, outcome = "succeeded", attribution = "shared", resource) {
      recordInto(key, correlation, durationMs, outcome, attribution, resource);
    },
    recordError(key, correlation) {
      if (closed) return;
      const entry = getOrCreateEntry(key, correlation, "shared");
      if (entry === undefined) return;
      entry.errorCount++;
      totalErrorCount++;
    },
    recordCancellation(key, correlation) {
      if (closed) return;
      const entry = getOrCreateEntry(key, correlation, "shared");
      if (entry === undefined) return;
      entry.cancellationCount++;
      totalCancellationCount++;
    },
    snapshot() {
      const entrySnapshots: MetricEntrySnapshot[] = [];
      for (const entry of entries.values()) {
        entrySnapshots.push(deepFreeze({
          key: entry.key,
          correlation: entry.correlation,
          callCount: entry.callCount,
          errorCount: entry.errorCount,
          cancellationCount: entry.cancellationCount,
          durationHistogram: entry.histogram.snapshot(),
          totalCpuMs: entry.totalCpuMs,
          totalHeapDeltaBytes: entry.totalHeapDeltaBytes,
          attribution: entry.attribution,
        }));
      }
      return deepFreeze({
        schemaVersion: schemaId("metrics-snapshot", 1),
        snapshotId: generateId("snap"),
        wallTime: new Date().toISOString(),
        entryCount: entrySnapshots.length,
        entries: entrySnapshots,
        totalCallCount,
        totalErrorCount,
        totalCancellationCount,
        configHash: canonicalHash(config),
      });
    },
    flush(exportFn) {
      if (closed) return;
      bestEffort(() => exportFn(this.snapshot()));
    },
    sampledTraces() {
      return [...traces];
    },
    entryCount() {
      return entries.size;
    },
    reset() {
      entries.clear();
      traces.length = 0;
      totalCallCount = 0;
      totalErrorCount = 0;
      totalCancellationCount = 0;
    },
    close() {
      closed = true;
      entries.clear();
      traces.length = 0;
    },
  });
}

function createNoopMetricsCollector(config: PerformanceConfig): MetricsCollector {
  return deepFreeze({
    recordCallStart: () => () => {},
    recordCall: () => {},
    recordError: () => {},
    recordCancellation: () => {},
    snapshot: () => deepFreeze({
      schemaVersion: schemaId("metrics-snapshot", 1),
      snapshotId: generateId("snap"),
      wallTime: new Date().toISOString(),
      entryCount: 0,
      entries: [],
      totalCallCount: 0,
      totalErrorCount: 0,
      totalCancellationCount: 0,
      configHash: canonicalHash(config),
    }),
    flush: () => {},
    sampledTraces: () => [],
    entryCount: () => 0,
    reset: () => {},
    close: () => {},
  });
}

function sanitizeCorrelation(
  correlation: MetricCorrelation,
  config: PerformanceConfig,
): MetricCorrelation {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(correlation)) {
    if (value === undefined) continue;
    // Keys are admitted by default — there is no allowlist to keep in sync
    // with future producers. The ONLY exclusion is the canonical forbidden-
    // text denylist (credential vocabulary + `forbiddenLabelNames`), applied
    // to the KEY here so a credential-named label is excluded even when its
    // value is innocent; the VALUE is masked, not dropped, by
    // `redactLabelValue` below.
    if (isForbiddenLabelText(config, key)) continue;
    if (key.length > config.labelSchema.maxLabelLength) continue;
    sanitized[key] = redactLabelValue(config, value);
  }
  return deepFreeze(sanitized);
}

export function quantileFromHistogram(
  snapshot: DurationHistogramSnapshot,
  q: number,
): number {
  if (q < 0 || q > 1) throw new InputError("Quantile must be in [0, 1]", "metrics_quantile_range");
  if (snapshot.totalCount === 0) return 0;
  const bounds = snapshot.bounds;
  const target = q * snapshot.totalCount;
  let cumulative = 0;
  for (let i = 0; i < snapshot.bucketCount; i++) {
    cumulative += snapshot.counts[i]!;
    if (cumulative >= target) {
      if (i === 0) {
        return bounds[0]! * q * snapshot.totalCount / (cumulative || 1);
      }
      return bounds[i - 1]! + (bounds[i]! - bounds[i - 1]!) * (target - (cumulative - snapshot.counts[i]!)) / (snapshot.counts[i]! || 1);
    }
  }
  return snapshot.maxMs;
}
