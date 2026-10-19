/**
 * Metrics bridge — the server-side adapter to the canonical harness
 * performance metrics collector. Exposes a live snapshot (call/error/
 * cancellation counts, duration histograms) from the real collector.
 *
 * Also exposes system resource metrics (CPU, memory, event-loop, uptime)
 * via Node's built-in `os`/`process` APIs — no new runtime deps.
 *
 * Recording hooks live in `metrics-recorder.ts` (which does NOT import the
 * canonical chain at module load) so `tool-executor.ts` and `llm-bridge.ts`
 * can record calls without triggering the harness integration's circular-
 * dependency TDZ. This module injects the collector into the recorder on
 * first use.
 */

import { cpus, freemem, totalmem, loadavg, uptime as osUptime } from "node:os";
import { performance } from "node:perf_hooks";

import {
  createMetricsCollector,
  bestEffort,
  quantileFromHistogram,
  installPerformanceMetricsSource,
  type MetricsCollector,
  type DurationHistogramSnapshot,
  guarded,
} from "../kernel/canonical.ts";
import type { MetricsSnapshot } from "../kernel/canonical.ts";
import { setMetricsCollector, getTokenThroughput } from "./metrics-recorder.ts";
import { getTimelineRecorder, timelineReadiness } from "./timeline-bridge.ts";
import { clientTelemetrySummary } from "../blocks/client-telemetry.ts";
import { configuredPerformance, resourceSamplerConfig } from "../kernel/harness-config.ts";
import { registerComponent } from "./component-registry.ts";
import { computeSelfImprovementSuggestions } from "./self-improving.ts";

// Re-export the recording hooks + token throughput so callers can import
// everything from the single metrics-bridge owner if they don't have the
// circular-dependency constraint (server-side only).
export { recordLlmCall, recordToolCall } from "./metrics-recorder.ts";
export { getTokenThroughput };

let collector: MetricsCollector | undefined;

function getMetricsCollector(): MetricsCollector {
  if (collector !== undefined) return collector;
  // Built once from the CONFIGURED section (a change takes effect on restart).
  collector = createMetricsCollector({ config: configuredPerformance() });
  // Inject the collector into the recorder so recordLlmCall/recordToolCall
  // (imported by tool-executor/llm-bridge without the canonical chain) can
  // record into the real collector.
  setMetricsCollector(collector);
  return collector;
}

export function getMetricsSnapshot(): MetricsSnapshot {
  return getMetricsCollector().snapshot();
}

// ── System resource metrics (no new deps — node:os + node:perf_hooks) ──

// SPO: `SystemMetrics` is owned by `shared/wire-types.ts` (single
// wire-shape owner, imported by both server + client — no drift). Re-
// exported here so existing `import { type SystemMetrics } from
// "./metrics-bridge.ts"` paths are unchanged.
import type { SystemMetrics } from "../../shared/wire-types.ts";
export type { SystemMetrics };
// The unit conversions this module performs — one owner each, shared across
// the engine↔server seam: seconds→ms for the uptime readouts, microseconds→ms
// for the CPU deltas `process.cpuUsage()` reports.
import { MS_PER_SECOND, MICROSECONDS_PER_MILLISECOND } from "../../shared/constants.ts";

/**
 * Capture a live system resource snapshot: process memory (RSS/heap),
 * system memory, CPU count + 1-min load average, event-loop utilization,
 * and process/system uptimes. All from Node built-ins (no deps).
 */
export function getSystemMetrics(): SystemMetrics {
  const mem = process.memoryUsage();
  const elu = performance.eventLoopUtilization();
  return {
    capturedAt: new Date().toISOString(),
    processUptimeMs: process.uptime() * MS_PER_SECOND,
    osUptimeMs: osUptime() * MS_PER_SECOND,
    cpuCount: cpus().length,
    loadAverage1m: loadavg()[0] ?? 0,
    memory: {
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      external: mem.external,
      arrayBuffers: mem.arrayBuffers,
      systemFree: freemem(),
      systemTotal: totalmem(),
    },
    eventLoop: {
      utilization: elu.idle + elu.active > 0 ? elu.active / (elu.idle + elu.active) : 0,
      delayMin: 0,
      delayMax: 0,
      delayMean: 0,
      delayStddev: 0,
    },
  };
}

/**
 * Combined metrics payload: the canonical per-function snapshot (call/error/
 * cancellation counts, duration histograms) PLUS system resource metrics
 * (CPU, memory, event-loop, uptime) and token throughput (tokens/s).
 *
 * The Metrics tab renders both: per-function latency histograms for the
 * hottest entry, and a compact system-resource + throughput grid.
 */
export type CombinedMetrics = Readonly<{
  snapshot: MetricsSnapshot;
  system: SystemMetrics;
  tokens: Readonly<{ inputTokens: number; outputTokens: number; totalTokens: number; tokensPerSecond: number }>;
}>;

export function getCombinedMetrics(): CombinedMetrics {
  return {
    snapshot: getMetricsSnapshot(),
    system: getSystemMetrics(),
    tokens: getTokenThroughput(),
  };
}

// ── The process resource sampler (the time-series lane) ─────────────────────
//
// getSystemMetrics above is PULL-based: it answers "what is the process doing
// right now" only while someone is looking at the Metrics tab. The sampler is
// the PUSH half: a periodic, best-effort tick that writes the process's own
// footprint into the ledger's existing `resource` lane (the recorder's
// recordResource — one metric per event: {metric, value, unit}), so the
// time series survives regardless of whether a dashboard was open.
//
// Lifecycle contract:
//   - started once by the server bootstrap after the socket listens, stopped
//     in the shutdown block;
//   - the interval timer is unref()'d, so the sampler can never be the thing
//     keeping the process alive;
//   - a tick failure is best-effort (the same contract as the effect sink):
//     a ledger hiccup must not throw out of a timer callback;
//   - the interval and the on/off switch are the config contract's
//     `performance.resourceSampler` fields, read through the single config
//     owner — nothing here is hardcoded.

let samplerTimer: NodeJS.Timeout | undefined;
let samplerUnregister: (() => void) | undefined;
let lastSampledCpu: NodeJS.CpuUsage | undefined;
let lastSampledElu: ReturnType<typeof performance.eventLoopUtilization> | undefined;

/**
 * The sampler's own last tick — the live head of the resource series it
 * writes to the ledger. Null before the first tick (a disabled or freshly
 * started sampler has measured nothing yet), which is the honest absence
 * the performance exposure signals serve: zero until a sample lands.
 */
let lastSample: Readonly<{
  rssBytes: number;
  heapUsedBytes: number;
  eventLoopUtilization: number;
}> | null = null;

/** The sampler's last measured tick, or null before the first one. */
export function lastResourceSample(): Readonly<{
  rssBytes: number;
  heapUsedBytes: number;
  eventLoopUtilization: number;
}> | null {
  return lastSample;
}

/** Whether the resource sampler's timer is currently running. */
export function resourceSamplerActive(): boolean {
  return samplerTimer !== undefined;
}

/** One sampler tick: write this instant's footprint + the deltas since the previous tick. */
export function sampleResourceOnce(): void {
  // A ledger still migrating (SCALE-CR1 C10) takes no samples: one refusal per
  // tick for minutes would be noise, and its gap event says what was not kept.
  if (timelineReadiness().state === "migrating" || timelineReadiness().state === "failed") return;
  bestEffort(() => {
    const recorder = getTimelineRecorder();
    const mem = process.memoryUsage();
    const cpu = process.cpuUsage();
    const prevCpu = lastSampledCpu;
    const prevElu = lastSampledElu;
    lastSampledCpu = cpu;
    lastSampledElu = performance.eventLoopUtilization();
    const correlation = {};
    recorder.recordResource({ metric: "process.rss", value: mem.rss, unit: "bytes", correlation });
    recorder.recordResource({ metric: "process.heapUsed", value: mem.heapUsed, unit: "bytes", correlation });
    // The tick's own live head — what the performance exposure signals read.
    // Set from the SAME reads the ledger rows were written from, so the
    // signal and the record can never disagree.
    lastSample = Object.freeze({
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      eventLoopUtilization:
        prevElu !== undefined
          ? performance.eventLoopUtilization(prevElu).utilization
          : 0,
    });
    // Deltas need a previous sample; the very first tick after start() has
    // baselines set, so only a tick before any baseline (never in practice)
    // reports levels only.
    if (prevCpu !== undefined) {
      // Passing the previous sample makes the kernel report the DELTA.
      const d = process.cpuUsage(prevCpu);
      recorder.recordResource({ metric: "cpu.user", value: d.user / MICROSECONDS_PER_MILLISECOND, unit: "ms", correlation });
      recorder.recordResource({ metric: "cpu.system", value: d.system / MICROSECONDS_PER_MILLISECOND, unit: "ms", correlation });
    }
    if (prevElu !== undefined) {
      const elu = performance.eventLoopUtilization(prevElu);
      recorder.recordResource({ metric: "eventLoop.utilization", value: elu.utilization, unit: "ratio", correlation });
    }
  });
}

/**
 * Start the sampler, when the config contract's `resourceSampler.enabled`
 * gate is on. Idempotent: a second call while running is a no-op, so a
 * bootstrap that races itself cannot stack timers.
 */
export function startResourceSampler(): void {
  if (samplerTimer !== undefined) return;
  const cfg = resourceSamplerConfig();
  if (!cfg.enabled) return;
  // Baselines so the FIRST tick already carries CPU + event-loop deltas.
  lastSampledCpu = process.cpuUsage();
  lastSampledElu = performance.eventLoopUtilization();
  samplerTimer = setInterval(guardedSample, cfg.intervalMs);
  // UNREF, AND IT IS NOT A DETAIL: a standing timer is exactly the kind of
  // handle that keeps a process alive after its work is done. The sampler
  // must never be the reason this server does not exit.
  samplerTimer.unref();
  // ANATOMY REGISTRATION — at the owner, on the start path: the sampler
  // timer is a registry component for exactly its lifetime (removed by the
  // stopResourceSampler below; a disabled sampler registers nothing, which
  // is the honest description of a process running without one).
  samplerUnregister = registerComponent({
    kind: "sampler-timer",
    label: "resource sampler",
    provenance: "server/observability/metrics-bridge.ts startResourceSampler",
    facts: { intervalMs: cfg.intervalMs },
  });
}

/** Stop the sampler. Called from the shutdown block; safe to call when never started. */
export function stopResourceSampler(): void {
  if (samplerTimer === undefined) return;
  clearInterval(samplerTimer);
  samplerTimer = undefined;
  samplerUnregister?.();
  samplerUnregister = undefined;
  lastSampledCpu = undefined;
  lastSampledElu = undefined;
}

// ── The performance exposure source ──────────────────────────────────────────
//
// The engine's performance registration declares the `performance.*` signals
// the instruments room renders; their values read through an installable
// source. THIS module is the metrics owner, so it installs the source —
// reading the SAME bridge `/api/metrics` serves (the collector's snapshot,
// the token accumulator, the self-improving analyzer, the sampler's last
// tick). One measurement path; the signal `value` never fetches anything
// the bridge does not already own.

/**
 * Fold every per-scope histogram of the snapshot into ONE combined
 * histogram. All the collector's histograms are built from the same config
 * (same bucketCount/strategy/bounds — one collector per process), so
 * per-bucket counts are real counts over the same boundaries and summing
 * them is aggregation, never invention. Null when no scope recorded a call.
 */
function combinedHistogram(snapshot: MetricsSnapshot): DurationHistogramSnapshot | null {
  let active: DurationHistogramSnapshot | undefined = undefined;
  let totalCount = 0;
  let minMs = Number.POSITIVE_INFINITY;
  let maxMs = 0;
  let sumMs = 0;
  const counts: number[] = [];
  for (const entry of snapshot.entries) {
    const h = entry.durationHistogram;
    if (h.totalCount === 0) continue;
    if (active === undefined) {
      active = h;
      for (let i = 0; i < h.bucketCount; i += 1) counts[i] = 0;
    }
    for (let i = 0; i < h.bucketCount && i < counts.length; i += 1) {
      counts[i] = (counts[i] ?? 0) + h.counts[i]!;
    }
    totalCount += h.totalCount;
    minMs = Math.min(minMs, h.minMs);
    maxMs = Math.max(maxMs, h.maxMs);
    sumMs += h.sumMs;
  }
  if (active === undefined) return null;
  return Object.freeze({
    bucketCount: active.bucketCount,
    bucketStrategy: active.bucketStrategy,
    bounds: active.bounds,
    counts: Object.freeze(counts),
    totalCount,
    minMs: totalCount === 0 ? 0 : minMs,
    maxMs,
    sumMs,
  });
}

/**
 * Install the live performance metrics source (called once at server boot).
 * Every quantity is MEASURED by this bridge's own owners — the lane folds
 * and the histogram combination are projections of the same snapshot
 * `/api/metrics` serves, recomputed per read so a poll can never serve a
 * stale copy of a live collector.
 *
 * The install also PRIMES the collector: it is created lazily on first read,
 * and the recording hooks (metrics-recorder) drop their samples while no
 * collector exists — a call recorded before anyone first polled metrics was
 * silently lost. Installing the source is the moment the bridge becomes the
 * exposure surface's owner, so the collector exists from boot, not from the
 * first curious read.
 */
export function installPerformanceMetricsExposureSource(): void {
  getMetricsSnapshot();
  installPerformanceMetricsSource(() => {
    const snapshot = getMetricsSnapshot();
    let llmCalls = 0;
    let llmErrors = 0;
    let llmCancellations = 0;
    let toolCalls = 0;
    let toolErrors = 0;
    let toolCancellations = 0;
    let cpuTimeMs = 0;
    let heapDeltaBytes = 0;
    for (const entry of snapshot.entries) {
      if (entry.key.module === "llm") {
        llmCalls += entry.callCount;
        llmErrors += entry.errorCount;
        llmCancellations += entry.cancellationCount;
      } else if (entry.key.module === "tool") {
        toolCalls += entry.callCount;
        toolErrors += entry.errorCount;
        toolCancellations += entry.cancellationCount;
      }
      cpuTimeMs += entry.totalCpuMs;
      heapDeltaBytes += entry.totalHeapDeltaBytes;
    }
    const combined = combinedHistogram(snapshot);
    const tokens = getTokenThroughput();
    // The browser's own health — read from the client-telemetry ingestion
    // door's counters, the same door the ledger rows came through, so the
    // signal and the record cannot disagree.
    const client = clientTelemetrySummary();
    return {
      callCount: snapshot.totalCallCount,
      errorCount: snapshot.totalErrorCount,
      cancellationCount: snapshot.totalCancellationCount,
      llmCalls,
      llmErrors,
      llmCancellations,
      toolCalls,
      toolErrors,
      toolCancellations,
      durationP50Ms: combined !== null ? quantileFromHistogram(combined, 0.5) : 0,
      durationP95Ms: combined !== null ? quantileFromHistogram(combined, 0.95) : 0,
      cpuTimeMs,
      heapDeltaBytes,
      tokensPerSecond: tokens.tokensPerSecond,
      // The analyzer is a PURE fold over the same snapshot — the count the
      // metrics route serves, never a second recording pass.
      selfImprovingSuggestions: computeSelfImprovementSuggestions(snapshot).length,
      samplerActive: resourceSamplerActive(),
      lastSample: lastResourceSample(),
      clientErrors: client.clientErrors,
      clientWorstLongTaskMs: client.worstLongTaskMs,
    };
  });
}

/** The sampler's tick as the event loop runs it: a fault in one sample is counted and logged, never fatal (SCALE-CR1 C3). */
const guardedSample = guarded("metrics.resource-sampler", sampleResourceOnce);
