/**
 * Worker pool — the owner of backend `node:worker_threads` spawning for every
 * bridge and service. No bridge or service creates a `new Worker(...)` of its
 * own; they call `runWorkerTask(...)`, and the `worker-thread-owner`
 * prevention test enforces that mechanically.
 *
 * IT IS ONE OF TWO DECLARED OWNERS, NOT THE ONLY ONE. `db/thread-backend.ts`
 * creates the database worker, because the database thread is started before
 * this pool exists and outlives every task it would run. That is a real second
 * owner, it is named in the guard's `WORKER_OWNERS`, and the guard asserts each
 * declared owner really does create a worker — so the pair cannot drift into a
 * stale exemption. This paragraph exists because the header used to say
 * "SINGLE" and "ONLY" in capitals while the guard it names checked two, and a
 * reader who believed the header would have deleted the second owner's
 * exemption and made the guard weaker while it still read as stricter.
 *
 * The pool owns the concerns that were previously duplicated (near-
 * identical boilerplate) across the intelligence bridge (repository-map +
 * quick-view workers) and the awareness bridge (awareness worker):
 *
 * 1. Spawning — where `new Worker(...)` is called for every pooled backend
 * worker. Bridges call `runWorkerTask(...)`; the database worker is the one
 * declared exception above.
 * 2. Caching (same-key dedup) — concurrent calls for the same `dedupKey`
 * share ONE worker (the pending-entry pattern centralized, relieving
 * each bridge of implementing its own dedup — "Relieve
 * Responsibilities": forgetting is impossible because the pool always
 * dedups; a bridge no longer has to remember to set a pending entry).
 * 3. Timeout — a configurable per-spawn timeout (from the config owner
 * `getWorkerTimeoutMs`). A worker that doesn't post a result within
 * the timeout is terminated + the promise rejects with the caller's
 * typed error. Fixes the "worker-hang → permanent 'not ready'" bug
 * (a hung worker previously left the pending cache entry forever;
 * the pool reclaims it).
 * 4. Error handling — wraps `new Worker(...)` in try/catch consistently
 * (previously only the quick-view bridge did — the map + awareness
 * bridges let a synchronous `new Worker` throw propagate as an
 * unhandled rejection / raw Error) + maps worker `error`/`exit`
 * events to the caller's typed error class. typed errors,
 * no `throw new Error(...)`.
 * 5. Cleanup — tracks all active workers + registers process shutdown
 * handlers (SIGTERM/SIGINT/beforeExit) that terminate every active
 * worker so none are orphaned on shutdown. Workers are `unref`ed so
 * a fire-and-forget build doesn't keep a dying process alive.
 * 6. Concurrency cap — bounds the number of concurrent worker threads
 * (from `getWorkerMaxConcurrent`) so a multi-project server cannot
 * exhaust file descriptors / memory by spawning unbounded workers.
 *
 * The pool is GENERIC over the success payload type `T` (each worker
 * returns a different shape: RepositoryMap / QuickViewBuiltState /
 * AwarenessSnapshot). The caller supplies a `validateOk` extractor + a
 * typed `errorClass` so the pool throws the RIGHT typed error per worker.
 *
 * No new deps (node:worker_threads). The frontend graph worker
 * (the old tree's graph worker, deleted at the cutover) was a BROWSER Web
 * Worker, NOT a node:worker_threads Worker — outside this pool's scope
 * (different runtime, different lifecycle).
 *
 * Web research: the Node.js `worker_threads` documentation states
 * "In practice, use a pool of Workers for these kinds of tasks. Otherwise,
 * the overhead of creating Workers would likely exceed their benefit." —
 * validating the single-owner pool pattern over ad-hoc per-call spawning.
 */

import { Worker } from "node:worker_threads";
import { bootstrappedWorker, guarded } from "../kernel/canonical.ts";
import { webWarn } from "../observability/debug-bridge.ts";
import { registerComponent } from "../observability/component-registry.ts";
import type { WebError } from "../kernel/errors.ts";
import { getWorkerTimeoutMs, getWorkerMaxConcurrent } from "../kernel/harness-config.ts";

/** Options for spawning a worker task through the pool. */
export interface RunWorkerTaskOptions<TOk> {
  /** The worker entry-point module URL (e.g.
   * `new URL("../intelligence/repository-map-worker.ts", import.meta.url)`). */
  readonly workerUrl: URL;
  /** Data passed to the worker via `workerData` (structured-cloned). */
  readonly workerData: unknown;
  /** The typed error constructor for failures (MapNotReadyError or
   * AwarenessNotReadyError). The pool throws `new errorClass(msg, code)`. */
  readonly errorClass: new (message: string, code: string) => WebError;
  /** A short label for the worker kind (e.g. "repository-map"). Used in
   * error messages, debug logs, and the dedup key. */
  readonly label: string;
  /** Optional override for the timeout (ms). Defaults to
   * `getWorkerTimeoutMs`. A non-positive value disables the timeout
   * (the worker may run unbounded — NOT recommended; only for tests). */
  readonly timeoutMs?: number;
  /** Dedup key for concurrent-spawn sharing (typically the projectPath).
   * Concurrent calls with the same `workerUrl` + `dedupKey` share ONE
   * worker. When omitted, every call spawns a fresh worker (no dedup). */
  readonly dedupKey?: string;
  /** Extract + validate the worker's `ok` payload from the raw message.
   * The worker posts `{ ok: true, <payloadKey>: <value> }`; this extracts
   * the value (e.g. `(msg) => (msg as {map?}).map`). Return `undefined`
   * when the payload field is missing — the pool rejects with a
   * `${label}_worker_bad_payload` typed error (never resolves with
   * `undefined`, which would crash downstream). A throw is also caught +
   * mapped to the same error (for an unexpected message shape). */
  readonly validateOk: (rawMessage: unknown) => TOk | undefined;
}

/** Active worker threads (for shutdown cleanup + observability). */
const activeWorkers = new Set<Worker>();
/** The component-registry unregister for each active worker — the anatomy
 * registry entry lives exactly as long as the worker it describes (set at
 * spawn inside this owner, removed on the same cleanup path that retires
 * the worker, so a worker cannot exist unregistered and a registry entry
 * cannot outlive its worker). */
const workerRegistrations = new Map<Worker, () => void>();
/** In-flight worker promises keyed by `${workerUrl.href}::${dedupKey}` for
 * concurrent-spawn dedup. The pool is the SINGLE owner of this pending
 * cache — the entry is set BEFORE the worker starts (via the deferred
 * pattern), so NO caller can forget to dedup. A bridge that calls
 * `runWorkerTask` gets automatic dedup without any manual pending-entry
 * code (the "Relieve Responsibilities" principle: forgetting is impossible
 * because the caller NEVER HAD TO REMEMBER). */
const inflight = new Map<string, Promise<unknown>>();
let shutdownHandlerRegistered = false;

/** A controlled promise (deferred) — the resolve/reject callbacks are
 * available outside the Promise constructor so the inflight entry can be
 * set BEFORE the worker spawns (the promise exists before `new Worker()`
 * runs). This makes the "pending entry before spawn" guarantee explicit. */
interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (error: unknown) => void;
}
function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Register process shutdown handlers ONCE so every active worker is
 * terminated on SIGTERM/SIGINT/beforeExit (no orphaned threads). Idempotent
 * safe to call on every `runWorkerTask`. */
function ensureShutdownHandler(): void {
  if (shutdownHandlerRegistered) return;
  shutdownHandlerRegistered = true;
  const shutdown = guarded("server.worker-pool.shutdown", (): void => {
    for (const w of activeWorkers) {
      try {
        void w.terminate();
      } catch (err) {
        // terminate can throw if the worker is already gone. Route
        // through the centralized debug bridge.
        webWarn("worker-pool", "worker terminate() threw during shutdown (worker already gone?)", () => ({ error: err instanceof Error ? err.message : String(err) }));
      }
    }
    activeWorkers.clear();
    inflight.clear();
    unregisterAllWorkerComponents();
  });
  // SIGTERM/SIGINT: explicit shutdown (the server's handlers in index.ts
  // also listen; Node runs all listeners — the pool's handler terminates
  // workers BEFORE the server's handler calls process.exit). beforeExit:
  // the event loop emptied normally (e.g. between requests in a test) —
  // terminate any fire-and-forget builds so they don't keep the process
  // alive (workers are unrefed, but terminate is still explicit cleanup).
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  process.once("beforeExit", shutdown);
}

/** The number of active worker threads (for observability — all
 * backend signals should be exposed). The web UI can surface this as a
 * "worker threads" signal. */
export function activeWorkerCount(): number {
  return activeWorkers.size;
}

/**
 * Check whether a worker for the given `workerUrl` + `dedupKey` is already
 * in flight. Returns the shared promise if yes (so the caller can await
 * the same worker — dedup), or `undefined` if no worker is in flight.
 *
 * This lets bridges check the pool's in-flight state WITHOUT maintaining
 * their own "pending" cache entries. A bridge's synchronous accessor can
 * call `getInFlightWorker(url, key)` — if it returns a promise, a worker
 * is already building (return "not ready"); if it returns undefined, no
 * worker is in flight (kick one off). The pool owns the in-flight state at
 * the lowest level — a new bridge that uses `runWorkerTask` gets automatic
 * dedup, and a new bridge that uses `getInFlightWorker` for its sync path
 * gets automatic "is a worker in flight?" detection, with zero manual
 * pending-entry code.
 */
export function getInFlightWorker<TOk>(
  workerUrl: URL,
  dedupKey?: string,
): Promise<TOk> | undefined {
  const key = `${workerUrl.href}::${dedupKey ?? ""}`;
  return inflight.get(key) as Promise<TOk> | undefined;
}

/**
 * Spawn (or reuse) a Worker thread for a one-shot task. This is the SINGLE
 * entry point for backend worker spawning — bridges call this instead of
 * `new Worker(...)` (mechanically enforced by the worker-thread-owner
 * prevention test). Returns a Promise resolving with the worker's `ok`
 * payload (extracted by `validateOk`). Concurrent calls with the same
 * `workerUrl` + `dedupKey` share ONE worker (the in-flight promise).
 *
 * When the pool is at capacity (`getWorkerMaxConcurrent`), a NEW spawn (a
 * dedup hit already returned the shared promise above) rejects with the
 * caller's typed error so the bridge can degrade ("not ready" / retry)
 * instead of exhausting resources.
 */
export async function runWorkerTask<TOk>(opts: RunWorkerTaskOptions<TOk>): Promise<TOk> {
  // ASYNC, so this promise-returning door cannot throw synchronously (a
  // refused config read here used to escape a timer callback and exit the
  // server; wf1c-design M-6). Everything up to the spawn still runs in the
  // caller's turn, so dedup and the capacity check stay synchronous.
  ensureShutdownHandler();
  const dedupKey = `${opts.workerUrl.href}::${opts.dedupKey ?? ""}`;
  const existing = inflight.get(dedupKey);
  if (existing !== undefined) {
    // Dedup: a worker for this key is already in flight — share it
    // (one worker per dedup key, not N — relieves bridges of this concern).
    return existing as Promise<TOk>;
  }
  // Concurrency cap: when at capacity, reject a NEW spawn. The caller's
  // typed error lets the bridge treat this as "not ready" (degrade) rather
  // than spawning unbounded workers (resource exhaustion on a multi-
  // project server).
  const maxConcurrent = getWorkerMaxConcurrent();
  if (activeWorkers.size >= maxConcurrent) {
    throw new opts.errorClass(
      `${opts.label} worker pool is at capacity (${maxConcurrent} concurrent). Retry shortly.`,
      `${opts.label}_worker_pool_full`,
    );
  }
  // Set the inflight entry BEFORE spawning the worker (deferred pattern).
  // The promise exists before `new Worker()` runs, so a concurrent call
  // (even a re-entrant one) sees the entry and dedups instead of spawning
  // a second worker. This is the lowest-level "pending entry before spawn"
  // guarantee — no caller can forget because the pool handles it.
  const deferred = createDeferred<TOk>();
  inflight.set(dedupKey, deferred.promise);
  spawnWorker<TOk>(opts, dedupKey, deferred.resolve, deferred.reject);
  return deferred.promise;
}

/** Spawn a single worker + wire its message/error/exit/timeout handlers.
 * The `resolve`/`reject` callbacks settle the deferred promise exactly once
 * (guarded by `settled`). The `dedupKey` is removed from `inflight` on
 * settle so the next call can retry; the worker is removed from
 * `activeWorkers` + terminated. */
function spawnWorker<TOk>(
  opts: RunWorkerTaskOptions<TOk>,
  dedupKey: string,
  resolve: (value: TOk | PromiseLike<TOk>) => void,
  reject: (error: unknown) => void,
): void {
    const timeoutMs = opts.timeoutMs ?? getWorkerTimeoutMs();
    // Merge the parent's execArgv with --experimental-strip-types so the
    // worker can load.ts files regardless of how the parent was launched
    // (the dev server sets it; vitest does not). Preserve argument pairs:
    // repeatable options such as --conditions and --import cannot be
    // deduplicated as individual strings without changing Node's parsing.
    const execArgv = process.execArgv.includes("--experimental-strip-types")
      ? [...process.execArgv]
      : [...process.execArgv, "--experimental-strip-types"];
    let worker: Worker;
    try {
      // Started on the prelude, which installs the fault policy before the
      // task's entry loads: a task thread fails closed on a lost fault
      // (SCALE-CR1-FIX H2).
      worker = new Worker(...bootstrappedWorker(opts.workerUrl, "worker", {
        workerData: opts.workerData,
        execArgv,
      }));
    } catch (err) {
      // Consistent typed error for a synchronous spawn failure. The
      // inflight entry was set BEFORE spawning (deferred pattern); clean
      // it up so a retry can spawn fresh (otherwise the rejected promise
      // would stay in the map forever — a memory leak + a stuck dedup
      // key that blocks all future spawns for this key).
      inflight.delete(dedupKey);
      reject(new opts.errorClass(
        `${opts.label} worker could not start: ${err instanceof Error ? err.message : String(err)}`,
        `${opts.label}_worker_start`,
      ));
      return;
    }
    // unref so a fire-and-forget build doesn't keep a dying process alive
    // (the shutdown handler terminates it on beforeExit/SIGTERM/SIGINT).
    worker.unref();
    activeWorkers.add(worker);
    // ANATOMY REGISTRATION — at the owner, on the spawn path, so every
    // worker this pool ever creates is visible in the component registry
    // for exactly its lifetime. The unregister is stored beside the worker
    // and called by the SAME cleanup that retires the worker.
    workerRegistrations.set(worker, registerComponent({
      kind: "worker-thread",
      label: opts.label,
      provenance: "server/run/worker-pool.ts runWorkerTask",
      facts: {
        task: opts.dedupKey,
        threadId: worker.threadId,
        workerUrl: opts.workerUrl.pathname,
      },
    }));
    let settled = false;
    let timeoutHandle: NodeJS.Timeout | undefined;
    const cleanup = (): void => {
      if (settled) return;
      settled = true;
      activeWorkers.delete(worker);
      workerRegistrations.get(worker)?.();
      workerRegistrations.delete(worker);
      inflight.delete(dedupKey);
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      void worker.terminate();
    };
    // The timeout bounds the TASK, not the worker's boot. `new Worker()` plus
    // the thread's module load (`--experimental-strip-types` transform of the
    // entry graph) is startup cost, and under a saturated host it can approach
    // a short task deadline before the worker runs a line of the task — so a
    // trivially-fast task reads as a timeout refusal. Start the clock on
    // `online` (the thread is executing), which is the moment the task's own
    // work can begin. A worker that never reaches `online` (a spawn wedge) is
    // still bounded: `error`/`exit` below settle it.
    const armTimeout = guarded("server.worker-pool.arm-timeout", (): void => {
      if (timeoutMs <= 0 || settled) return;
      const handle = setTimeout(guarded("server.worker-pool.timeout", () => {
        if (settled) return;
        webWarn("worker-pool", `${opts.label} worker timed out after ${timeoutMs}ms — terminating`, () => ({ label: opts.label, dedupKey: opts.dedupKey, timeoutMs }));
        cleanup();
        reject(new opts.errorClass(
          `${opts.label} worker timed out after ${timeoutMs}ms.`,
          `${opts.label}_worker_timeout`,
        ));
      }), timeoutMs);
      // Don't let the timeout timer keep the process alive either.
      handle.unref();
      timeoutHandle = handle;
    });
    if (timeoutMs > 0) worker.once("online", armTimeout);
    worker.once("message", guarded("server.worker-pool.message", (msg: unknown) => {
      cleanup();
      const m = msg as { ok?: boolean; error?: Readonly<{ message: string; code?: string }> };
      if (m.ok === true) {
        let payload: TOk | undefined;
        try {
          payload = opts.validateOk(msg);
        } catch (err) {
          // validateOk threw on an unexpected message shape (e.g. a null
          // message). Map to a typed bad-payload error.
          reject(new opts.errorClass(
            `${opts.label} worker returned a malformed ok payload: ${err instanceof Error ? err.message : String(err)}`,
            `${opts.label}_worker_bad_payload`,
          ));
          return;
        }
        if (payload === undefined) {
          // validateOk signalled a missing payload field (returned
          // undefined). Never resolve with undefined — that would crash
          // the bridge's downstream code (a frozen map/snapshot is never
          // undefined). Reject with a typed bad-payload error instead.
          reject(new opts.errorClass(
            `${opts.label} worker returned an ok message with a missing payload`,
            `${opts.label}_worker_bad_payload`,
          ));
          return;
        }
        resolve(payload);
      } else if (m.ok === false) {
        reject(new opts.errorClass(
          m.error?.message ?? `${opts.label} worker returned an error`,
          m.error?.code ?? `${opts.label}_worker_error`,
        ));
      } else {
        reject(new opts.errorClass(
          `${opts.label} worker returned an unrecognized message`,
          `${opts.label}_worker_bad_message`,
        ));
      }
    }));
    worker.once("error", guarded("server.worker-pool.error", (err: Error) => {
      webWarn("worker-pool", `${opts.label} worker error`, () => ({ label: opts.label, dedupKey: opts.dedupKey, error: err.message }));
      cleanup();
      reject(new opts.errorClass(
        `${opts.label} worker failed: ${err.message}`,
        `${opts.label}_worker_error`,
      ));
    }));
    worker.once("exit", guarded("server.worker-pool.exit", (code: number) => {
      // exit fires after message for a normal completion (code 0). Only a
      // non-zero exit WITHOUT a prior message is a failure — `settled`
      // guards against double-settle when message already fired (the
      // prior per-bridge code had no such guard; a crash-after-message
      // would call reject on an already-settled promise, a latent no-op
      // but fragile).
      if (settled) return;
      webWarn("worker-pool", `${opts.label} worker exited (code ${code}) without a message`, () => ({ label: opts.label, dedupKey: opts.dedupKey, code }));
      cleanup();
      reject(new opts.errorClass(
        `${opts.label} worker exited with code ${code}.`,
        `${opts.label}_worker_exit`,
      ));
    }));
}

/** Unregister every live worker's component entry (shutdown paths). */
function unregisterAllWorkerComponents(): void {
  for (const unregister of workerRegistrations.values()) unregister();
  workerRegistrations.clear();
}

/** Terminate all active workers + clear the dedup map. For explicit
 * shutdown (e.g. tests, or a future admin endpoint). Idempotent. The
 * process shutdown handlers also call this implicitly via the shared
 * `shutdown` closure. */
export function shutdownWorkerPool(): void {
  for (const w of activeWorkers) {
    try {
      void w.terminate();
    } catch (err) {
      // Route through the debug bridge.
      webWarn("worker-pool", "worker terminate() threw during shutdownWorkerPool (worker already gone?)", () => ({ error: err instanceof Error ? err.message : String(err) }));
    }
  }
  activeWorkers.clear();
  inflight.clear();
  unregisterAllWorkerComponents();
}
