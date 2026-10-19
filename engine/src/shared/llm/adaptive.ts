/**
 * Adaptive concurrency controller — AIMD (Additive Increase, Multiplicative
 * Decrease), the congestion-control rule TCP uses.
 *
 * The controller observes completed requests (latency + whether the request
 * ended in a rate-limit/429 error) over a sliding window. After each full
 * window it decides:
 *
 * - DECREASE: if the weighted error rate exceeds `errorThreshold` OR the
 * average latency exceeds `slowLatencyMs`. The current concurrency is
 * multiplied by `decreaseFactor` (rounded down, floored at
 * `minConcurrency`). Multiplicative so a sudden 429 storm sheds load fast.
 * - INCREASE: if the error rate is zero AND the average latency is below
 * `fastLatencyMs`. The current concurrency is increased by `increaseStep`
 * (capped at `maxConcurrency`). Additive so recovery is cautious.
 * - HOLD: otherwise (latency in the calm band, or a tolerable error rate).
 *
 * The controller NEVER goes below `minConcurrency` or above `maxConcurrency`.
 * It reports the computed value; the queue applies it via `setMaxConcurrency`.
 *
 * Off by default (the user opts in via `adaptive.enabled`). When disabled,
 * `record` is a no-op and `current` returns the initial concurrency so the
 * queue runs deterministically.
 */

import type { AdaptiveConfig } from "./config.ts";
import type { ErrorType } from "./errors.ts";

export type AdaptiveSample = Readonly<{
  /** Request wall-time duration in ms. */
  durationMs: number;
  /** The error type the request ended in, or `undefined` on success. */
  errorType: ErrorType | undefined;
}>;

export type AdaptiveDecision = "increase" | "decrease" | "hold" | "disabled";

export type AdaptiveSnapshot = Readonly<{
  enabled: boolean;
  concurrency: number;
  minConcurrency: number;
  maxConcurrency: number;
  decisions: Readonly<{ increase: number; decrease: number; hold: number }>;
  windowSamples: number;
  windowErrors: number;
  windowLatencyMs: number;
  lastDecision: AdaptiveDecision;
}>;

export class AdaptiveController {
  private enabled: boolean;
  private concurrency: number;
  private readonly min: number;
  private readonly max: number;
  private readonly increaseStep: number;
  private readonly decreaseFactor: number;
  private readonly errorThreshold: number;
  private readonly sampleWindow: number;
  private readonly fastLatencyMs: number;
  private readonly slowLatencyMs: number;
  private readonly rateLimitWeight: number;
  private readonly samples: AdaptiveSample[] = [];
  private increaseCount = 0;
  private decreaseCount = 0;
  private holdCount = 0;
  private lastDecision: AdaptiveDecision = "disabled";

  constructor(resolved: Readonly<Required<AdaptiveConfig>>, initialConcurrency: number) {
    this.enabled = resolved.enabled;
    this.min = resolved.minConcurrency;
    this.max = resolved.maxConcurrency;
    this.increaseStep = resolved.increaseStep;
    this.decreaseFactor = resolved.decreaseFactor;
    this.errorThreshold = resolved.errorThreshold;
    this.sampleWindow = resolved.sampleWindow;
    this.fastLatencyMs = resolved.fastLatencyMs;
    this.slowLatencyMs = resolved.slowLatencyMs;
    this.rateLimitWeight = resolved.rateLimitWeight;
    this.concurrency = clampConcurrency(initialConcurrency, this.min, this.max);
  }

  /** Feed a completed request. Returns the decision taken this sample (or "disabled"/"hold"). */
  record(sample: AdaptiveSample): AdaptiveDecision {
    if (!this.enabled) return "disabled";
    this.samples.push(sample);
    if (this.samples.length < this.sampleWindow) return "hold";
    return this.evaluate();
  }

  /** Current computed concurrency the queue should apply. */
  current(): number {
    return this.concurrency;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Force a concurrency value (e.g. from the `setConcurrency` action). Respects bounds. */
  setConcurrency(value: number): void {
    this.concurrency = clampConcurrency(value, this.min, this.max);
  }

  /** Reset the window + counts (test hook). */
  resetForTest(): void {
    this.samples.length = 0;
    this.increaseCount = 0;
    this.decreaseCount = 0;
    this.holdCount = 0;
    this.lastDecision = this.enabled ? "hold" : "disabled";
  }

  snapshot(): AdaptiveSnapshot {
    const windowErrors = this.countWeightedErrors(this.samples);
    const windowLatencyMs = this.averageLatency(this.samples);
    return Object.freeze({
      enabled: this.enabled,
      concurrency: this.concurrency,
      minConcurrency: this.min,
      maxConcurrency: this.max,
      decisions: Object.freeze({ increase: this.increaseCount, decrease: this.decreaseCount, hold: this.holdCount }),
      windowSamples: this.samples.length,
      windowErrors,
      windowLatencyMs,
      lastDecision: this.lastDecision,
    });
  }

  private evaluate(): AdaptiveDecision {
    const windowSamples = this.samples.splice(0, this.sampleWindow);
    const errorRate = this.countWeightedErrors(windowSamples) / windowSamples.length;
    const avgLatency = this.averageLatency(windowSamples);
    let decision: AdaptiveDecision;
    if (errorRate > this.errorThreshold || avgLatency > this.slowLatencyMs) {
      const decreased = Math.max(this.min, Math.floor(this.concurrency * this.decreaseFactor));
      if (decreased < this.concurrency) {
        this.concurrency = decreased;
        decision = "decrease";
      } else {
        decision = "hold";
      }
    } else if (errorRate === 0 && avgLatency < this.fastLatencyMs) {
      const increased = Math.min(this.max, this.concurrency + this.increaseStep);
      if (increased > this.concurrency) {
        this.concurrency = increased;
        decision = "increase";
      } else {
        decision = "hold";
      }
    } else {
      decision = "hold";
    }
    if (decision === "increase") this.increaseCount++;
    else if (decision === "decrease") this.decreaseCount++;
    else this.holdCount++;
    this.lastDecision = decision;
    return decision;
  }

  private countWeightedErrors(samples: readonly AdaptiveSample[]): number {
    let weighted = 0;
    for (const s of samples) {
      if (s.errorType === undefined) continue;
      weighted += s.errorType === "rate-limit" ? this.rateLimitWeight : 1;
    }
    return weighted;
  }

  private averageLatency(samples: readonly AdaptiveSample[]): number {
    if (samples.length === 0) return 0;
    let sum = 0;
    for (const s of samples) sum += s.durationMs;
    return sum / samples.length;
  }
}

function clampConcurrency(value: number, min: number, max: number): number {
  if (!Number.isFinite(value) || value < 1) return min;
  const rounded = Math.floor(value);
  return Math.min(max, Math.max(min, rounded));
}
