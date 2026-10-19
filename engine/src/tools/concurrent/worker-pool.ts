/**
 * Concurrent tool dispatch — worker thread pool for CPU-bound handlers.
 *
 * Spawns N `worker_threads` running a worker entry script that exposes a
 * fixed registry of pure CPU-bound handlers. The main thread handles
 * I/O-bound work on its event loop while workers parse/analyze in
 * parallel — this breaks the single-threaded Amdahl ceiling for the
 * CPU-bound fraction of a batch.
 *
 * The pool is a fixed-size queue. Each worker processes one call at a
 * time. Calls are dispatched to the first idle worker. The pool is
 * configurable: worker count, worker script path, workerData root, and a
 * spawn timeout all come from the caller (the dispatcher sources them
 * from ROOT_POLICY). No hardcoded limits live here.
 *
 * Lifecycle:
 * const pool = new WorkerPool({ size, workerScript, root });
 * await pool.start;
 * const r = await pool.exec({ id, name, args, contents? });
 * await pool.shutdown;
 */

import { Worker } from "node:worker_threads";
import type { Transferable as NodeTransferable } from "node:worker_threads";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { extractErrorMessage, HarnessError, InputError } from "../../kernel/errors.ts";
import { bestEffort, bestEffortAsync } from "../../shared/best-effort.ts";
import { guarded } from "../../process/fault-policy.ts";
import { bootstrappedWorker } from "../../process/worker-bootstrap.ts";

/** Default worker spawn timeout (ms) — named so it is not an inline literal. */
import { DEFAULT_SPAWN_TIMEOUT_MS } from "../tools-config.ts";

export type WorkerPoolOptions = Readonly<{
  /** Number of worker threads to spawn. Caller-derived (e.g. from ROOT_POLICY). */
  size: number;
  /** Absolute path to the worker entry script. */
  workerScript: string;
  /** Root directory passed to each worker via `workerData.root`. */
  root: string;
  /** Per-worker spawn timeout in ms (the worker must signal ready within this). */
  spawnTimeoutMs?: number;
}>;

export type WorkerCall = Readonly<{
  id: string;
  name: string;
  args: Readonly<Record<string, unknown>>;
  /**
   * Optional pre-read file contents (one per `paths` entry). When present,
   * the worker skips disk reads and operates purely on CPU — this overlaps
   * the main thread's libuv I/O with the worker's CPU work.
   */
  contents?: readonly string[];
  /**
   * Optional list of Transferable objects (ArrayBuffer, MessagePort, etc.)
   * to pass to `postMessage`'s `transferList`. When present, the listed
   * objects are transferred zero-copy (the main thread loses ownership).
   * This eliminates the structured-clone overhead for large payloads —
   * e.g., transferring 40MB of file contents takes ~0ms instead of ~300ms.
   */
  transferList?: readonly NodeTransferable[];
}>;

export type WorkerCallResult = Readonly<{
  ok: boolean;
  result?: unknown;
  error?: string;
  durationMs: number;
}>;

export class WorkerPoolError extends HarnessError {
  constructor(message: string, code = "worker_pool_error") {
    super(message, code);
  }
}

interface PendingCall {
  call: WorkerCall;
  resolve: (r: WorkerCallResult) => void;
}

export class WorkerPool {
  readonly size: number;
  readonly workerScript: string;
  readonly root: string;
  readonly spawnTimeoutMs: number;
  private workers: Worker[] = [];
  private queue: PendingCall[] = [];
  private busy = new Set<number>();
  private pending = new Map<number, PendingCall>();
  private started = false;
  private shutdownRequested = false;

  constructor(options: WorkerPoolOptions) {
    if (!Number.isInteger(options.size) || options.size <= 0) {
      throw new InputError(
        `WorkerPool size must be a positive integer (got ${options.size})`,
        "worker_pool_size_invalid",
      );
    }
    if (typeof options.workerScript !== "string" || options.workerScript.length === 0) {
      throw new InputError(
        "WorkerPool workerScript must be a non-empty path",
        "worker_pool_script_invalid",
      );
    }
    // A ROOT THAT DOES NOT EXIST IS REFUSED HERE, NOT WAITED ON.
    //
    // Driven at the monorepo assembly (2026-07-30): the fixture corpus this
    // pool's callers walk (`large-codebases/`) is gitignored, so a history
    // preserving migration did not carry it — and the pool did not fail, it
    // HUNG. Two runs of the whole engine suite died in `epoll_wait` with zero
    // CPU: 18 minutes and then 3, both ending with no receipt at all, because
    // a per-test timeout cannot reap a worker thread that keeps the loop
    // alive. Absence of a root is knowable BEFORE any thread is spawned, and
    // the only honest answer to it is a refusal that names the path.
    //
    // The constructor is the one door every pool user passes, so the check
    // lives here rather than in each caller's setup.
    if (typeof options.root !== "string" || options.root.length === 0) {
      throw new InputError(
        "WorkerPool root must be a non-empty path",
        "worker_pool_root_invalid",
      );
    }
    const resolvedRoot = resolve(options.root);
    if (!existsSync(resolvedRoot)) {
      throw new InputError(
        `WorkerPool root does not exist: ${resolvedRoot}. A pool whose corpus is absent cannot ` +
          `answer anything, and waiting on it produces a run with no result rather than a failure.`,
        "worker_pool_root_absent",
      );
    }
    this.size = options.size;
    this.workerScript = resolve(options.workerScript);
    this.root = options.root;
    this.spawnTimeoutMs = options.spawnTimeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS;
  }

  async start(): Promise<void> {
    if (this.started) return;
    const promises: Promise<void>[] = [];
    for (let i = 0; i < this.size; i++) {
      promises.push(this.spawnWorker(i));
    }
    await Promise.all(promises);
    this.started = true;
  }

  private spawnWorker(idx: number): Promise<void> {
    return new Promise<void>((spawnResolve, spawnReject) => {
      let settled = false;
      const timer = setTimeout(guarded("tools.worker-pool.spawn-timeout", () => {
        if (!settled) {
          settled = true;
          bestEffort(() => this.workers[idx]?.terminate().catch(() => undefined));
          spawnReject(new WorkerPoolError(
            `worker ${idx} did not signal ready within ${this.spawnTimeoutMs}ms`,
            "worker_pool_spawn_timeout",
          ));
        }
      }), this.spawnTimeoutMs);
      let w: Worker;
      try {
        // Started on the prelude: the fault policy before the worker's entry loads (SCALE-CR1-FIX H2).
        w = new Worker(...bootstrappedWorker(this.workerScript, "worker", {
          workerData: { root: this.root, idx, ready: true },
        }));
      } catch (e) {
        clearTimeout(timer);
        spawnReject(new WorkerPoolError(
          `failed to spawn worker ${idx}: ${extractErrorMessage(e)}`,
          "worker_pool_spawn_failed",
        ));
        return;
      }
      this.workers[idx] = w;
      const onReady = guarded("tools.worker-pool.ready", (msg: unknown): void => {
        if (settled) return;
        if (msg && typeof msg === "object" && (msg as { ready?: boolean }).ready === true) {
          settled = true;
          clearTimeout(timer);
          w.off("message", onReady);
          spawnResolve();
        }
      });
      w.on("message", onReady);
      w.on("message", guarded("tools.worker-pool.message", (msg: unknown) => this.onMessage(idx, msg)));
      w.on("error", guarded("tools.worker-pool.error", (err: Error) => this.onError(idx, err)));
    });
  }

  private findIdle(): number {
    for (let i = 0; i < this.size; i++) {
      if (!this.busy.has(i) && this.workers[i]) return i;
    }
    return -1;
  }

  private drain(): void {
    while (this.queue.length > 0) {
      const idx = this.findIdle();
      if (idx < 0) break;
      const entry = this.queue.shift()!;
      this.dispatchTo(idx, entry);
    }
  }

  private dispatchTo(idx: number, entry: PendingCall): void {
    this.busy.add(idx);
    this.pending.set(idx, entry);
    const w = this.workers[idx];
    if (!w) {
      this.busy.delete(idx);
      this.pending.delete(idx);
      entry.resolve({ ok: false, error: `worker ${idx} not available`, durationMs: 0 });
      return;
    }
    const msg = { id: entry.call.id, name: entry.call.name, args: entry.call.args, contents: entry.call.contents };
    // Zero-copy transfer: when transferList is provided, the listed
    // ArrayBuffers are transferred (not cloned) to the worker. This
    // eliminates the structured-clone overhead for large payloads.
    if (entry.call.transferList !== undefined && entry.call.transferList.length > 0) {
      w.postMessage(msg, [...entry.call.transferList]);
    } else {
      w.postMessage(msg);
    }
  }

  private onMessage(idx: number, msg: unknown): void {
    const entry = this.pending.get(idx);
    if (!entry) return;
    this.pending.delete(idx);
    this.busy.delete(idx);
    const m = msg as { id?: string; ok?: boolean; result?: unknown; error?: string; durationMs?: number };
    if (entry.call.id !== m.id) return;
    entry.resolve({
      ok: m.ok === true,
      ...(m.result !== undefined ? { result: m.result } : {}),
      ...(typeof m.error === "string" ? { error: m.error } : {}),
      durationMs: typeof m.durationMs === "number" ? m.durationMs : 0,
    });
    if (!this.shutdownRequested) this.drain();
  }

  private onError(idx: number, err: unknown): void {
    const entry = this.pending.get(idx);
    this.pending.delete(idx);
    this.busy.delete(idx);
    if (entry) {
      entry.resolve({ ok: false, error: `worker ${idx} error: ${extractErrorMessage(err)}`, durationMs: 0 });
    }
  }

  exec(call: WorkerCall): Promise<WorkerCallResult> {
    return new Promise<WorkerCallResult>((resolve) => {
      const entry: PendingCall = { call, resolve };
      const idx = this.findIdle();
      if (idx >= 0) {
        this.dispatchTo(idx, entry);
      } else {
        this.queue.push(entry);
      }
    });
  }

  async shutdown(): Promise<void> {
    this.shutdownRequested = true;
    while (this.busy.size > 0 || this.queue.length > 0) {
      await new Promise((r) => setTimeout(r, 10));
    }
    for (const w of this.workers) {
      await bestEffortAsync(() => w.terminate());
    }
    this.workers = [];
    this.started = false;
  }
}

export { fileURLToPath, dirname, performance };
