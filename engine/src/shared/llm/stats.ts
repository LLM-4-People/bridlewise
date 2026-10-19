/**
 * Stats + token accounting — one canonical owner of cumulative LLM usage
 * counters. The hot path uses plain numeric fields (no object allocation in
 * record*). Tokens are tracked per request and cumulatively; errors by
 * `ErrorType`; latency feeds an average. Per-model and per-provider
 * breakdowns back the exposure signals.
 *
 * No PII, prompts, or credentials enter stats — only counts and durations.
 */

import type { ErrorType } from "./errors.ts";
import { observeProviderLabel } from "./provider-observation.ts";

export type TokenUsage = Readonly<{
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}>;

type LabelTotals = Readonly<{
  requests: number;
  retries: number;
  errors: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencySumMs: number;
  latencyCount: number;
}>;

export type LLMStats = Readonly<{
  totalRequests: number;
  totalRetries: number;
  totalErrors: number;
  totalTokens: Readonly<{ prompt: number; completion: number; total: number }>;
  errorsByType: Readonly<Record<string, number>>;
  avgLatencyMs: number;
  circuitOpen: boolean;
  lastErrorType: string | undefined;
  byModel: Readonly<Record<string, LabelTotals>>;
  byProvider: Readonly<Record<string, LabelTotals>>;
  failovers: number;
  lastFailoverReason: string | undefined;
}>;

function emptyTotals(): {
  requests: number; retries: number; errors: number;
  promptTokens: number; completionTokens: number; totalTokens: number;
  latencySumMs: number; latencyCount: number;
} {
  return { requests: 0, retries: 0, errors: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, latencySumMs: 0, latencyCount: 0 };
}

export class LLMStatsCollector {
  private totalRequests = 0;
  private totalRetries = 0;
  private totalErrors = 0;
  private promptTokens = 0;
  private completionTokens = 0;
  private totalTokens = 0;
  private readonly errorsByType: Record<string, number> = Object.create(null);
  private latencySumMs = 0;
  private latencyCount = 0;
  private lastErrorType: string | undefined;
  private readonly byModel: Record<string, ReturnType<typeof emptyTotals>> = Object.create(null);
  private readonly byProvider: Record<string, ReturnType<typeof emptyTotals>> = Object.create(null);
  private failovers = 0;
  private lastFailoverReason: string | undefined;

  recordRequest(model: string | undefined, provider: string): void {
    this.totalRequests++;
    if (model !== undefined) this.bump(this.byModel, model).requests++;
    this.bump(this.byProvider, provider).requests++;
  }

  recordRetry(model: string | undefined, provider: string): void {
    this.totalRetries++;
    if (model !== undefined) this.bump(this.byModel, model).retries++;
    this.bump(this.byProvider, provider).retries++;
  }

  recordError(errorType: ErrorType, model: string | undefined, provider: string): void {
    this.totalErrors++;
    this.errorsByType[errorType] = (this.errorsByType[errorType] ?? 0) + 1;
    this.lastErrorType = errorType;
    if (model !== undefined) this.bump(this.byModel, model).errors++;
    this.bump(this.byProvider, provider).errors++;
  }

  recordTokens(usage: TokenUsage | undefined, model: string | undefined, provider: string): void {
    if (usage === undefined || !Number.isFinite(usage.promptTokens)) return;
    this.promptTokens += usage.promptTokens;
    this.completionTokens += usage.completionTokens;
    this.totalTokens += usage.totalTokens;
    if (model !== undefined) {
      const m = this.bump(this.byModel, model);
      m.promptTokens += usage.promptTokens; m.completionTokens += usage.completionTokens; m.totalTokens += usage.totalTokens;
    }
    const p = this.bump(this.byProvider, provider);
    p.promptTokens += usage.promptTokens;
    p.completionTokens += usage.completionTokens;
    p.totalTokens += usage.totalTokens;
  }

  recordLatency(ms: number, model: string | undefined, provider: string): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.latencySumMs += ms;
    this.latencyCount++;
    if (model !== undefined) this.bump(this.byModel, model).latencySumMs += ms;
    if (model !== undefined) this.bump(this.byModel, model).latencyCount++;
    this.bump(this.byProvider, provider).latencySumMs += ms;
    this.bump(this.byProvider, provider).latencyCount++;
  }

  recordFailover(reason: string): void {
    this.failovers++;
    this.lastFailoverReason = reason;
  }

  snapshot(circuitOpen: boolean): LLMStats {
    const avg = this.latencyCount > 0 ? this.latencySumMs / this.latencyCount : 0;
    return Object.freeze({
      totalRequests: this.totalRequests,
      totalRetries: this.totalRetries,
      totalErrors: this.totalErrors,
      totalTokens: Object.freeze({ prompt: this.promptTokens, completion: this.completionTokens, total: this.totalTokens }),
      errorsByType: Object.freeze({ ...this.errorsByType }),
      avgLatencyMs: avg,
      circuitOpen,
      lastErrorType: this.lastErrorType,
      byModel: Object.freeze(this.snapshotLabels(this.byModel)),
      byProvider: Object.freeze(this.snapshotLabels(this.byProvider)),
      failovers: this.failovers,
      lastFailoverReason: this.lastFailoverReason,
    });
  }

  private snapshotLabels(map: Record<string, ReturnType<typeof emptyTotals>>): Record<string, LabelTotals> {
    const out = new Map<string, ReturnType<typeof emptyTotals>>();
    for (const [k, v] of Object.entries(map)) {
      const label = observeProviderLabel(k), prior = out.get(label) ?? emptyTotals();
      for (const field of Object.keys(v) as (keyof typeof v)[]) prior[field] += v[field];
      out.set(label, prior);
    }
    return Object.fromEntries([...out].map(([key, value]) => [key, Object.freeze(value)]));
  }

  private bump(map: Record<string, ReturnType<typeof emptyTotals>>, key: string): ReturnType<typeof emptyTotals> {
    key = observeProviderLabel(key);
    let entry = map[key];
    if (entry === undefined) {
      entry = emptyTotals();
      map[key] = entry;
    }
    return entry;
  }
}
