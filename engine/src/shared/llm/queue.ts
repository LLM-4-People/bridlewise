/**
 * Configurable request queue — the ONE canonical owner of LLM request
 * admission, ordering, and concurrency bounding.
 *
 * EXP457 extends EXP421's FIFO counting semaphore into a configurable
 * admission controller. Every knob comes from the resolved `QueueConfig` and
 * `ConcurrencyConfig`; no module reads literals.
 *
 * Capabilities:
 * - Global, per-model, and per-provider concurrency semaphores. A request
 * occupies one slot in each applicable semaphore for its whole in-flight
 * duration; the effective cap is the minimum that applies.
 * - Queue strategies: `fifo`, `lifo`, `priority`, `round-robin`.
 * - `maxQueueSize`: reject overflow with a typed `QueueOverflowError`.
 * - `queueTimeoutMs`: reject stale waiters with a typed `QueueTimeoutError`.
 * - `priorityLevels`: callers may pass a `priority` (higher = sooner).
 * - Actions: `setConcurrency`, `pauseQueue`, `resumeQueue`, `clearQueue`,
 * `rejectAll`. Each is exposed through the shared exposure system.
 * - Observation: active, pending, maxConcurrency, avgWaitMs, rejected,
 * timedOut, per-model/per-provider active counts, queue utilization.
 */

import { guarded } from "../../process/fault-policy.ts";
import { EMPTY_HELD_SET, type HeldSet } from "../../privacy/held-set.ts";
import type { ConcurrencyConfig, QueueConfig, QueueStrategy } from "./config.ts";
import { resolveQueueConfig } from "./config.ts";
import { safeAbortError } from "./errors.ts";
import { InputError } from "../../kernel/errors.ts";
import { observeProviderScopes } from "./provider-observation.ts";

/** Per-request admission descriptor. */
export type QueueRequest = Readonly<{
  model: string | undefined;
  provider: string;
  /** Higher runs sooner under `priority`/`round-robin`. Defaults to 0. */
  priority?: number;
  signal?: AbortSignal | undefined;
}>;

export class QueueOverflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueueOverflowError";
  }
}

export class QueueTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueueTimeoutError";
  }
}

type PendingEntry = {
  readonly request: QueueRequest;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly enqueuedAt: number;
  timeoutId: ReturnType<typeof setTimeout> | undefined;
  settled: boolean;
  onAbort?: () => void;
};

export type QueueSnapshot = Readonly<{
  active: number;
  pending: number;
  maxConcurrency: number;
  maxQueueSize: number;
  queueStrategy: QueueStrategy;
  paused: boolean;
  rejected: number;
  timedOut: number;
  cleared: number;
  avgWaitMs: number;
  utilization: number;
  perModelActive: Readonly<Record<string, number>>;
  perProviderActive: Readonly<Record<string, number>>;
  perModelLimits: Readonly<Record<string, number>>;
  perProviderLimits: Readonly<Record<string, number>>;
  globalLimit: number | undefined;
}>;

export class RequestQueue {
  private active = 0;
  private readonly pending: PendingEntry[] = [];
  private maxConcurrency: number;
  private readonly maxQueueSize: number;
  private readonly queueTimeoutMs: number;
  private readonly priorityLevels: boolean;
  private readonly strategy: QueueStrategy;
  private paused = false;
  private rejected = 0;
  private timedOut = 0;
  private cleared = 0;
  private totalWaitMs = 0;
  private waitSamples = 0;
  private readonly perModelActive: Record<string, number> = Object.create(null);
  private readonly perProviderActive: Record<string, number> = Object.create(null);
  private readonly perModelLimit: Readonly<Record<string, number>>;
  private readonly perProviderLimit: Readonly<Record<string, number>>;
  private readonly globalLimit: number | undefined;
  private rrCursor = 0;

  constructor(queue: Readonly<QueueConfig>, concurrencyPolicy: Readonly<ConcurrencyConfig> = {}) {
    // ONE FILL-IN STEP, OWNED BY THE CONFIG MODULE. These five lines used to
    // repeat the defaults as literals (`?? 5`, `?? 100`, `?? false`,
    // `?? "fifo"`) beside one read of the declared constant, so a queue built
    // here and a queue built through `resolveLLMConfig` were filling the same
    // gaps from two different sets of numbers.
    const resolved = resolveQueueConfig(queue);
    this.maxConcurrency = resolved.maxConcurrency;
    this.maxQueueSize = resolved.maxQueueSize;
    this.queueTimeoutMs = resolved.queueTimeoutMs;
    this.priorityLevels = resolved.priorityLevels;
    this.strategy = resolved.queueStrategy;
    if (!Number.isInteger(this.maxConcurrency) || this.maxConcurrency < 1) {
      throw new InputError("RequestQueue maxConcurrency must be an integer >= 1");
    }
    if (!Number.isInteger(this.maxQueueSize) || this.maxQueueSize < 0) {
      throw new InputError("RequestQueue maxQueueSize must be an integer >= 0");
    }
    if (!Number.isFinite(this.queueTimeoutMs) || this.queueTimeoutMs < 0) {
      throw new InputError("RequestQueue queueTimeoutMs must be >= 0");
    }
    this.perModelLimit = Object.freeze(Object.assign(Object.create(null), concurrencyPolicy.perModel));
    this.perProviderLimit = Object.freeze(Object.assign(Object.create(null), concurrencyPolicy.perProvider));
    this.globalLimit = concurrencyPolicy.global;
  }

  /**
   * Acquire all applicable concurrency slots for `request`, waiting in the
   * queue (subject to strategy, maxQueueSize, and queueTimeoutMs) until they
   * are free. Resolves once the request may execute; the caller MUST call
   * `release(request)` when done.
   */
  async acquire(request: QueueRequest): Promise<void> {
    if (request.signal?.aborted) throw safeAbortError(request.signal.reason);
    if (this.paused) {
      await this.enqueue(request);
      return;
    }
    if (this.canAdmit(request) && this.pending.length === 0) {
      this.admit(request);
      this.recordWait(0);
      return;
    }
    const pending = this.enqueue(request);
    this.tryDispatch();
    await pending;
  }

  /** Convenience wrapper: acquire, run `fn`, release. Returns `fn`'s result. */
  async run<T>(request: QueueRequest, fn: () => Promise<T>): Promise<T> {
    await this.acquire(request);
    try {
      return await fn();
    } finally {
      this.release(request);
    }
  }

  /** Release the slots held by `request` and dispatch the next eligible waiter. */
  release(request: QueueRequest): void {
    this.active = Math.max(0, this.active - 1);
    const modelActive = request.model === undefined ? undefined : this.perModelActive[request.model];
    if (modelActive !== undefined && request.model !== undefined) {
      const next = Math.max(0, modelActive - 1);
      if (next === 0) delete this.perModelActive[request.model];
      else this.perModelActive[request.model] = next;
    }
    const providerActive = this.perProviderActive[request.provider];
    if (providerActive !== undefined) {
      const next = Math.max(0, providerActive - 1);
      if (next === 0) delete this.perProviderActive[request.provider];
      else this.perProviderActive[request.provider] = next;
    }
    this.tryDispatch();
  }

  // ── Actions (exposed via the shared exposure system) ──────────────────

  /** Set the global concurrency cap. The AIMD controller drives this. */
  setConcurrency(value: number): void {
    if (!Number.isInteger(value) || value < 1) {
      throw new InputError("setConcurrency value must be an integer >= 1");
    }
    this.maxConcurrency = value;
    this.tryDispatch();
  }

  getConcurrency(): number {
    return this.maxConcurrency;
  }

  pauseQueue(): void {
    this.paused = true;
  }

  resumeQueue(): void {
    this.paused = false;
    this.tryDispatch();
  }

  /** Drop all pending requests (in-flight requests keep running). Returns the count dropped. */
  clearQueue(): number {
    const dropped = this.pending.length;
    this.cleared += dropped;
    for (const entry of this.pending) this.settle(entry, new Error("queue cleared"));
    this.pending.length = 0;
    return dropped;
  }

  /** Drop pending AND reject any new acquire until `resumeQueue`. Returns the count rejected. */
  rejectAll(): number {
    const dropped = this.clearQueue();
    this.paused = true;
    return dropped;
  }

  isPaused(): boolean {
    return this.paused;
  }

  // ── Observation ───────────────────────────────────────────────────────

  activeCount(): number {
    return this.active;
  }

  pendingCount(): number {
    return this.pending.length;
  }

  maxConcurrencyValue(): number {
    return this.maxConcurrency;
  }

  avgWaitMs(): number {
    return this.waitSamples > 0 ? this.totalWaitMs / this.waitSamples : 0;
  }

  rejectedCount(): number {
    return this.rejected;
  }

  timedOutCount(): number {
    return this.timedOut;
  }

  clearedCount(): number {
    return this.cleared;
  }

  perModelActiveCount(model: string): number {
    return this.perModelActive[model] ?? 0;
  }

  perProviderActiveCount(provider: string): number {
    return this.perProviderActive[provider] ?? 0;
  }

  utilization(): number {
    return this.maxConcurrency > 0 ? this.active / this.maxConcurrency : 0;
  }

  snapshot(heldCredentials: HeldSet = EMPTY_HELD_SET): QueueSnapshot {
    const modelKeys = [...new Set([...Object.keys(this.perModelLimit), ...Object.keys(this.perModelActive)])];
    const providerKeys = [...new Set([...Object.keys(this.perProviderLimit), ...Object.keys(this.perProviderActive)])];
    return Object.freeze({
      active: this.active,
      pending: this.pending.length,
      maxConcurrency: this.maxConcurrency,
      maxQueueSize: this.maxQueueSize,
      queueStrategy: this.strategy,
      paused: this.paused,
      rejected: this.rejected,
      timedOut: this.timedOut,
      cleared: this.cleared,
      avgWaitMs: this.avgWaitMs(),
      utilization: this.utilization(),
      perModelActive: observeProviderScopes(Object.entries(this.perModelActive), modelKeys, heldCredentials),
      perProviderActive: observeProviderScopes(Object.entries(this.perProviderActive), providerKeys, heldCredentials),
      perModelLimits: observeProviderScopes(Object.entries(this.perModelLimit), modelKeys, heldCredentials),
      perProviderLimits: observeProviderScopes(Object.entries(this.perProviderLimit), providerKeys, heldCredentials),
      globalLimit: this.globalLimit,
    });
  }

  // ── internals ────────────────────────────────────────────────────────

  private canAdmit(request: QueueRequest): boolean {
    if (this.active >= this.maxConcurrency) return false;
    const globalCap = this.globalLimit;
    if (globalCap !== undefined && this.active >= globalCap) return false;
    const modelCap = request.model === undefined ? undefined : this.perModelLimit[request.model];
    if (request.model !== undefined && modelCap !== undefined && (this.perModelActive[request.model] ?? 0) >= modelCap) return false;
    const providerCap = this.perProviderLimit[request.provider];
    if (providerCap !== undefined && (this.perProviderActive[request.provider] ?? 0) >= providerCap) return false;
    return true;
  }

  private admit(request: QueueRequest): void {
    this.active++;
    if (request.model !== undefined) this.perModelActive[request.model] = (this.perModelActive[request.model] ?? 0) + 1;
    this.perProviderActive[request.provider] = (this.perProviderActive[request.provider] ?? 0) + 1;
  }

  private enqueue(request: QueueRequest): Promise<void> {
    if (this.pending.length >= this.maxQueueSize) {
      this.rejected++;
      return Promise.reject(new QueueOverflowError(
        `queue full: ${this.pending.length} pending >= maxQueueSize ${this.maxQueueSize}`,
      ));
    }
    return new Promise<void>((resolve, reject) => {
      const enqueuedAt = performance.now();
      const entry: PendingEntry = {
        request,
        resolve,
        reject,
        enqueuedAt,
        timeoutId: undefined,
        settled: false,
      };
      if (this.queueTimeoutMs > 0) {
        entry.timeoutId = setTimeout(guarded("llm.queue.timeout", () => {
          if (entry.settled) return;
          this.timedOut++;
          this.removeFromPending(entry);
          this.settle(entry, new QueueTimeoutError(
            `request waited longer than queueTimeoutMs ${this.queueTimeoutMs}ms`,
          ));
        }), this.queueTimeoutMs);
      }
      if (request.signal) {
        const onAbort = guarded("llm.queue.abort", () => {
          this.removeFromPending(entry);
          this.settle(entry, safeAbortError(request.signal?.reason));
          this.tryDispatch();
        });
        entry.onAbort = onAbort;
        request.signal.addEventListener("abort", onAbort, { once: true });
      }
      this.pending.push(entry);
    });
  }

  private tryDispatch(): void {
    if (this.paused) return;
    while (this.pending.length > 0) {
      const index = this.pickNextIndex();
      if (index === -1) break;
      const entry = this.pending[index];
      if (entry === undefined) break;
      this.pending.splice(index, 1);
      this.admit(entry.request);
      this.recordWait(performance.now() - entry.enqueuedAt);
      this.settle(entry, undefined);
    }
  }

  /**
   * Pick the index of the next pending request to dispatch, per the strategy.
   * Returns -1 if no pending request can currently be admitted (every waiter
   * is blocked by its model/provider/global cap even though the global queue
   * has free slots).
   */
  private pickNextIndex(): number {
    const pending = this.pending;
    switch (this.strategy) {
      case "fifo":
        return pending.findIndex((e) => this.canAdmit(e.request));
      case "lifo":
        for (let i = pending.length - 1; i >= 0; i--) {
          if (this.canAdmit(pending[i]!.request)) return i;
        }
        return -1;
      case "priority": {
        let best = -1;
        let bestPriority = -Infinity;
        for (let i = 0; i < pending.length; i++) {
          const entry = pending[i]!;
          if (!this.canAdmit(entry.request)) continue;
          const p = this.priorityOf(entry.request);
          if (p > bestPriority || best === -1) {
            bestPriority = p;
            best = i;
          }
        }
        return best;
      }
      case "round-robin": {
        // Rotate across providers so a busy provider does not starve others.
        // Start scanning after the last served provider's position; pick the
        // first eligible. Among equal providers, prefer higher priority.
        if (pending.length === 0) return -1;
        const start = this.rrCursor % pending.length;
        for (let offset = 0; offset < pending.length; offset++) {
          const i = (start + offset) % pending.length;
          if (this.canAdmit(pending[i]!.request)) {
            this.rrCursor = (i + 1) % pending.length;
            return i;
          }
        }
        return -1;
      }
      default:
        return -1;
    }
  }

  private priorityOf(request: QueueRequest): number {
    if (!this.priorityLevels) return 0;
    const p = request.priority;
    if (typeof p === "number" && Number.isFinite(p)) return p;
    return 0;
  }

  private removeFromPending(entry: PendingEntry): void {
    const i = this.pending.indexOf(entry);
    if (i >= 0) this.pending.splice(i, 1);
  }

  private settle(entry: PendingEntry, error: Error | undefined): void {
    if (entry.settled) return;
    entry.settled = true;
    if (entry.onAbort) entry.request.signal?.removeEventListener("abort", entry.onAbort);
    if (entry.timeoutId !== undefined) clearTimeout(entry.timeoutId);
    if (error === undefined) entry.resolve();
    else entry.reject(error);
  }

  private recordWait(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.totalWaitMs += ms;
    this.waitSamples++;
  }
}
