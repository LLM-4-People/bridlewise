/**
 * nanostores shared state: metrics snapshot + derived summary.
 *
 * Plain.ts — Node-testable via Vitest. Fed ONLY by client.ts (setMetrics).
 *
 * Percentile computation is a pure function over a DurationHistogramSnapshot.
 * The histogram bucket layout is strategy-dependent; this module assumes
 * `bounds[i]` is the upper bound of bucket `i` (bounds.length === counts.length)
 * and falls back to a linear min/max interpolation otherwise. The fallback is
 * honest — it does not fabricate precision the distribution does not provide.
 *
 * @global-store server-wide system metrics (not chat-scoped; reflects the whole server process)
 */

import { atom, computed, type ReadableAtom, type WritableAtom } from "nanostores";

import type {
  MetricsSnapshot,
  MetricEntrySnapshot,
  DurationHistogramSnapshot,
} from "../../shared/types";

import { metricsConfig } from "./web-ui-config";
import { registerReset } from "./store-registry";

// ── System resource metrics (web-UI specific; from server metrics-bridge) ──
//
// SPO: `SystemMetrics` is owned by `shared/wire-types.ts` (single
// wire-shape owner, imported by both server + client — no drift). Re-
// exported here so existing `import { type SystemMetrics } from
// "./state/metrics"` paths are unchanged.
import type { SystemMetrics } from "../../shared/wire-types";
export type { SystemMetrics };

export type TokenThroughput = Readonly<{
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  tokensPerSecond: number;
}>;

// ── Stores ──

export const metricsSnapshot: WritableAtom<MetricsSnapshot | null> = atom<MetricsSnapshot | null>(null);
export const systemMetrics: WritableAtom<SystemMetrics | null> = atom<SystemMetrics | null>(null);
export const tokenThroughput: WritableAtom<TokenThroughput | null> = atom<TokenThroughput | null>(null);

export const metricEntries: ReadableAtom<readonly MetricEntrySnapshot[]> = computed(
  metricsSnapshot,
  (s) => (s ? s.entries : []),
);

export type MetricsSummary = Readonly<{
  readonly totalCalls: number;
  readonly totalErrors: number;
  readonly totalCancellations: number;
  readonly entryCount: number;
  readonly topEntry: MetricEntrySnapshot | null;
  readonly topPercentiles: Readonly<{ readonly p50: number; readonly p95: number; readonly p99: number }> | null;
}>;

const EMPTY_SUMMARY: MetricsSummary = Object.freeze({
  totalCalls: 0,
  totalErrors: 0,
  totalCancellations: 0,
  entryCount: 0,
  topEntry: null,
  topPercentiles: null,
});

export const metricsSummary: ReadableAtom<MetricsSummary> = computed(
  metricsSnapshot,
  (s) => {
    if (!s) return EMPTY_SUMMARY;
    const topEntry = pickTopEntry(s.entries);
    const topPercentiles = topEntry
      ? {
          p50: percentileFromHistogram(topEntry.durationHistogram, 50),
          p95: percentileFromHistogram(topEntry.durationHistogram, 95),
          p99: percentileFromHistogram(topEntry.durationHistogram, 99),
        }
      : null;
    return {
      totalCalls: s.totalCallCount,
      totalErrors: s.totalErrorCount,
      totalCancellations: s.totalCancellationCount,
      entryCount: s.entryCount,
      topEntry,
      topPercentiles,
    };
  },
);

// ── Pure helpers (exported for testing) ──

export function percentileFromHistogram(
  hist: DurationHistogramSnapshot,
  p: number,
): number {
  if (hist.totalCount === 0) return 0;
  if (hist.bounds.length !== hist.counts.length) {
    // Layout does not match the upper-bound assumption; fall back to a
    // min..max linear interpolation. Honest, not precise.
    return hist.minMs + (p / 100) * (hist.maxMs - hist.minMs);
  }
  const target = (p / 100) * hist.totalCount;
  let cumulative = 0;
  for (let i = 0; i < hist.counts.length; i++) {
    const prev = cumulative;
    const count = hist.counts[i] ?? 0;
    cumulative += count;
    if (cumulative >= target) {
      const lower = i === 0 ? hist.minMs : (hist.bounds[i - 1] ?? hist.minMs);
      const upper = hist.bounds[i] ?? hist.maxMs;
      const bucket = cumulative - prev;
      if (bucket <= 0) return upper;
      const frac = (target - prev) / bucket;
      return lower + frac * (upper - lower);
    }
  }
  return hist.maxMs;
}

function pickTopEntry(
  entries: readonly MetricEntrySnapshot[],
): MetricEntrySnapshot | null {
  let best: MetricEntrySnapshot | null = null;
  for (const e of entries) {
    if (best === null || e.callCount > best.callCount) best = e;
  }
  return best;
}

// ── Ingestion (called only by client.ts) ──

/**
 * Shallow equality for the snapshot's identity fields. Two snapshots with
 * the same totals + entry count + id are treated as identical so a poll
 * that returns unchanged data does NOT trigger a store notification (the
 * dashboard re-renders only when metrics actually change — no wasted
 * re-renders while idle). This is a shallow compare by design: the entries
 * array is not deep-compared (it is large); the scalar totals + entryCount
 * are a sufficient change signal (call/error/cancellation counts move on
 * any real activity).
 */
function snapshotIdentical(a: MetricsSnapshot, b: MetricsSnapshot): boolean {
  return (
    a.snapshotId === b.snapshotId &&
    a.entryCount === b.entryCount &&
    a.totalCallCount === b.totalCallCount &&
    a.totalErrorCount === b.totalErrorCount &&
    a.totalCancellationCount === b.totalCancellationCount
  );
}

function systemMetricsIdentical(a: SystemMetrics, b: SystemMetrics): boolean {
  return (
    a.capturedAt === b.capturedAt &&
    a.processUptimeMs === b.processUptimeMs &&
    a.loadAverage1m === b.loadAverage1m &&
    a.memory.rss === b.memory.rss &&
    a.memory.heapUsed === b.memory.heapUsed &&
    a.eventLoop.utilization === b.eventLoop.utilization
  );
}

function throughputIdentical(a: TokenThroughput, b: TokenThroughput): boolean {
  return (
    a.inputTokens === b.inputTokens &&
    a.outputTokens === b.outputTokens &&
    a.totalTokens === b.totalTokens &&
    a.tokensPerSecond === b.tokensPerSecond
  );
}

export type MetricsHistoryPoint = Readonly<{
  readonly at: number;
  readonly tokensPerSecond: number;
  readonly totalCalls: number;
  readonly totalErrors: number;
  readonly loadAverage1m: number;
  readonly heapUsed: number;
  readonly eventLoopUtil: number;
}>;

export const metricsHistory = atom<readonly MetricsHistoryPoint[]>([]);

function appendHistoryPoint(point: MetricsHistoryPoint): void {
  const max = metricsConfig.get().historyMax;
  const next = [...metricsHistory.get(), point];
  if (next.length > max) next.splice(0, next.length - max);
  metricsHistory.set(next);
}

export function setMetrics(snapshot: MetricsSnapshot): void {
  // Dedup: skip the set + history append when the poll returned identical
  // per-function metrics (idle harness). Prevents duplicate sparkline
  // points and unnecessary re-renders.
  const prev = metricsSnapshot.get();
  if (prev !== null && snapshotIdentical(prev, snapshot)) return;
  metricsSnapshot.set(snapshot);
  const tp = tokenThroughput.get();
  const sys = systemMetrics.get();
  appendHistoryPoint({
    at: Date.now(),
    tokensPerSecond: tp?.tokensPerSecond ?? 0,
    totalCalls: snapshot.totalCallCount,
    totalErrors: snapshot.totalErrorCount,
    loadAverage1m: sys?.loadAverage1m ?? 0,
    heapUsed: sys?.memory.heapUsed ?? 0,
    eventLoopUtil: sys?.eventLoop.utilization ?? 0,
  });
}

export function setSystemMetrics(metrics: SystemMetrics): void {
  const prev = systemMetrics.get();
  if (prev !== null && systemMetricsIdentical(prev, metrics)) return;
  systemMetrics.set(metrics);
}

export function setTokenThroughput(throughput: TokenThroughput): void {
  const prev = tokenThroughput.get();
  if (prev !== null && throughputIdentical(prev, throughput)) return;
  tokenThroughput.set(throughput);
}

export function resetMetrics(): void {
  metricsSnapshot.set(null);
  systemMetrics.set(null);
  tokenThroughput.set(null);
  metricsHistory.set([]);
}

registerReset("metrics", resetMetrics);
