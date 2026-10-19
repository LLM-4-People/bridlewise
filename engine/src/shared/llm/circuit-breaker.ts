import { InputError } from "../../kernel/errors.ts";
/**
 * Circuit breaker — opens after `threshold` consecutive failures, fails fast
 * for `resetMs`, then enters HALF_OPEN and lets one trial request through.
 *
 * States: CLOSED → (threshold consecutive failures) → OPEN → (resetMs) →
 * HALF_OPEN → (success) CLOSED | (failure) OPEN
 *
 * Exposes observation accessors so the LLM client can publish circuit state
 * as a signal without leaking internal mutation.
 */

export type CircuitState = "closed" | "open" | "half-open";

export type CircuitSnapshot = Readonly<{
  state: CircuitState;
  consecutiveFailures: number;
  openedAtMs: number;
  threshold: number;
  resetMs: number;
}>;

export class CircuitBreaker {
  private state: CircuitState = "closed";
  private consecutiveFailures = 0;
  private openedAtMs = 0;
  private readonly threshold: number;
  private readonly resetMs: number;

  constructor(threshold: number, resetMs: number) {
    if (!Number.isInteger(threshold) || threshold < 1) throw new InputError("CircuitBreaker threshold must be an integer >= 1");
    if (!Number.isFinite(resetMs) || resetMs < 1) throw new InputError("CircuitBreaker resetMs must be >= 1");
    this.threshold = threshold;
    this.resetMs = resetMs;
  }

  allow(now: number = Date.now()): boolean {
    if (this.state === "closed") return true;
    if (this.state === "open") {
      if (now - this.openedAtMs >= this.resetMs) {
        this.state = "half-open";
        return true;
      }
      return false;
    }
    return true;
  }

  recordSuccess(): void {
    if (this.state === "half-open") this.state = "closed";
    this.consecutiveFailures = 0;
  }

  recordFailure(now: number = Date.now()): void {
    this.consecutiveFailures++;
    if (this.state === "half-open") {
      this.state = "open";
      this.openedAtMs = now;
      return;
    }
    if (this.consecutiveFailures >= this.threshold) {
      this.state = "open";
      this.openedAtMs = now;
    }
  }

  getState(): CircuitState {
    return this.state;
  }

  isOpen(now: number = Date.now()): boolean {
    if (this.state === "open" && now - this.openedAtMs >= this.resetMs) {
      this.state = "half-open";
      return false;
    }
    return this.state === "open";
  }

  snapshot(): CircuitSnapshot {
    return Object.freeze({
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      openedAtMs: this.openedAtMs,
      threshold: this.threshold,
      resetMs: this.resetMs,
    });
  }

  resetForTest(): void {
    this.state = "closed";
    this.consecutiveFailures = 0;
    this.openedAtMs = 0;
  }
}
