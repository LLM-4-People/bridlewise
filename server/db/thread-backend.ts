/**
 * THE SHAPE UNDERNEATH THE FACADE: a read pool and one writer.
 *
 * SQLite in WAL mode supports concurrent readers alongside a single writer, so
 * that is what this builds — N reader threads on read-only connections, one
 * writer thread on a read-write connection. The request thread issues calls
 * and awaits promises; it never runs SQL, never decrypts a field, never
 * validates a row.
 *
 * ── The three orderings, re-established rather than inherited ──
 *
 * Everything used to be synchronous, so ordering came free and nobody had to
 * state it. Across a thread boundary none of it is free, so each is stated
 * here, implemented deliberately, and tested in
 * `tests/prevention/async-db-ordering.test.ts`.
 *
 * **W1 — WRITE ORDERING.** Writes execute in the order the caller issued them.
 * There is exactly one writer thread, its `message` handler is synchronous,
 * and a `MessagePort` delivers in send order; so issue order is post order is
 * execution order. This is the guarantee the ledger's chain hash rests on, and
 * it is why the writer must never become a pool "for throughput" — two writers
 * would make "the entry before this one" ambiguous.
 *
 * **W2 — READ-YOUR-WRITES.** A read observes every write issued before it by
 * the same process, whether or not the caller awaited them. Reads and writes
 * run on different threads, so without help a read could overtake a write that
 * is still queued and honestly report the older state. Each write takes a
 * sequence number; each read records the highest sequence issued so far and is
 * not dispatched until every earlier write has settled, including refusals.
 * Successful writes have committed; a failed later send cannot skip an earlier
 * pending write. WAL supplies the reader's next committed snapshot.
 *
 * The barrier is program-order across the process, which is stronger than the
 * per-request guarantee §2 asks for. Stronger is the right side to err on and
 * it is nearly free — a write is ~100–300µs, and a read issued while no write
 * is in flight waits for nothing at all.
 *
 * **W3 — LEDGER SEQUENCE MONOTONICITY.** No worker may touch the ledger; it
 * has one writer, on the main thread. Enforced in `timeline-bridge.ts` by
 * `HARNESS_DB_WORKER`, which is set for exactly these threads.
 *
 * ── Checkpointing, designed for rather than inherited ──
 *
 * At `synchronous=NORMAL` the WAL grows until something checkpoints it, and
 * the classic failure of this exact architecture is a passive checkpoint that
 * can never complete because some reader always holds a read transaction open.
 * Three things make that not happen here, and they are load-bearing:
 *
 *  - the checkpoint runs on the WRITER connection, which is the only one that
 *    can, and it is PASSIVE, so it never blocks a reader or a writer;
 *  - the readers hold NO long-lived transactions. `pageAllRows` opens one per
 *    call and closes it; there is no connection sitting in `BEGIN` between
 *    requests, which is what would pin the WAL forever;
 *  - it is measured, not assumed. `walBytes()` reports the live size, and
 *    `tests/prevention/async-db-ordering.test.ts` drives thousands of writes
 *    through the facade and fails if the WAL does not stay bounded.
 *
 * ── A thread that dies is replaced, never mourned forever (SCALE-CR1 C4) ──
 *
 * One dead thread used to disable the database for the life of the process
 * (`failAll` was permanent) — and a reader that runs out of memory on a huge
 * history read is exactly how a thread dies. Once the facade is open, each
 * thread is SUPERVISED:
 *
 *  - a dead READER is respawned; the reads it held are idempotent, so each is
 *    retried once on a live reader (a read that loses its reader twice is
 *    `db_read_lost`, typed and retryable — it may be the read that kills it);
 *  - a dead WRITER is respawned (its open re-runs the migrations and the
 *    schema assertions, so the schema is re-verified); the writes it held
 *    are answered `db_write_outcome_unknown` — they may or may not have
 *    committed, and nothing claims either — and writes issued meanwhile wait,
 *    in issue order (W1), for the new writer;
 *  - restarts are counted in a window (`HARNESS_WEB_DB_THREAD_RESTART_MAX`
 *    per `HARNESS_WEB_DB_THREAD_RESTART_WINDOW_MS`); past it the CIRCUIT
 *    OPENS: calls that need the missing thread are answered `db_unavailable`
 *    (retryable) for one window, then a respawn is tried again. The state is
 *    the `database.threads.state` signal; it is never permanent.
 *
 * A failure while OPENING is still the open's failure (every acquired thread
 * is joined and the open rejects): there is no running facade to supervise.
 */

import type { AdmittedKeyHome, PersistedKey } from "../kernel/canonical.ts";
import { bootstrappedWorker, describeFaultLine, guarded } from "../kernel/canonical.ts";
import { resolveDatabaseKey } from "./db-crypto.ts";
import { Worker } from "node:worker_threads";
import { cpus } from "node:os";

import { decodeError, type DbCall, type DbReady, type DbReply, type DbFailedToOpen } from "./wire.ts";
import type { DbWorkerData } from "./db-worker.ts";
import { methodKind } from "./method-kinds.ts";
import { ValidationError, WebError } from "../kernel/errors.ts";
import { registerComponent } from "../observability/component-registry.ts";
import { webAlwaysOn } from "../observability/debug-bridge.ts";
import {
  dbWorkerEnv,
  DB_READ_POOL_MIN,
  DB_READ_POOL_MAX,
  DB_READ_POOL_RESERVED_CORES,
  DEFAULT_DB_THREAD_RESTART_MAX,
  DEFAULT_DB_THREAD_RESTART_WINDOW_MS,
} from "../kernel/config.ts";

/** Facts about the connections, read once when they open. */
export type DbConnectionFacts = DbReady;

type Role = "writer" | "reader";

const WORKER_URL = new URL("./db-worker.ts", import.meta.url);

/**
 * How many reader threads to run.
 *
 * Reads are CPU-bound here — SQLite's own work is the small part, and AES
 * decryption plus Zod validation is the rest — so the useful number is bounded
 * by cores, not by how many requests are in flight. Leaving headroom for the
 * main thread, the writer, and libuv's pool is what stops the pool competing
 * with the loop it exists to free.
 */
export function defaultReadPoolSize(): number {
  const cores = cpus().length;
  return Math.max(DB_READ_POOL_MIN, Math.min(DB_READ_POOL_MAX, cores - DB_READ_POOL_RESERVED_CORES));
}

type WorkerHandle = {
  readonly worker: Worker;
  readonly role: Role;
  /** Calls posted to this worker and not yet answered. */
  inFlight: number;
  /**
   * Set once the thread answered `ready: true`. Only a LIVE thread is
   * supervised: a failure before readiness belongs to the spawn's promise
   * alone (its caller decides — the open fails, or `restart()` tries again),
   * so one failed respawn can never start two replacements (SCALE-CR1-FIX N1).
   */
  live: boolean;
  /** Set once the thread is gone (it exited, errored, or was replaced). */
  lost: boolean;
};

/** One call in flight or waiting for a thread: what is needed to answer it, and to retry a read. */
type PendingCall = {
  readonly call: DbCall;
  readonly role: Role;
  readonly resolve: (v: unknown) => void;
  readonly reject: (e: unknown) => void;
  handle: WorkerHandle | undefined;
  retried: boolean;
};

/** The supervision state the `database.threads.*` signals read. */
export type DbThreadSupervision = Readonly<{
  state: "unopened" | "ready" | "restarting" | "circuit-open" | "closed";
  restarts: number;
  readers: number;
  /** The restart circuit's budget in force (restarts per window, and the window). */
  restartMax: number;
  restartWindowMs: number;
}>;

let latestSupervision: (() => DbThreadSupervision) | undefined;

/** The supervision state of this process's open facade (`unopened` before one opens). */
export function databaseThreadSupervision(): DbThreadSupervision {
  return latestSupervision?.() ?? Object.freeze({ state: "unopened", restarts: 0, readers: 0, restartMax: 0, restartWindowMs: 0 });
}

export type ThreadBackendConfig = Readonly<{
  path: string;
  admittedKey?: PersistedKey;
  readers?: number;
  passphrase?: string;
  keyHome?: AdmittedKeyHome;
  synchronous?: string;
  busyTimeoutMs?: number;
  durabilityWindowMs?: number;
  /** Restarts allowed per window before the circuit opens (`HARNESS_WEB_DB_THREAD_RESTART_MAX`). */
  restartMax?: number;
  /** The circuit's window and open time (`HARNESS_WEB_DB_THREAD_RESTART_WINDOW_MS`). */
  restartWindowMs?: number;
}>;

export class ThreadBackend {
  private readonly pending = new Map<number, PendingCall>();
  private nextId = 1;
  private writer: WorkerHandle | undefined;
  private readers: WorkerHandle[] = [];
  private readerTarget = 0;
  private facts!: DbConnectionFacts;
  private opened = false;
  private closed = false;
  private closing = false;
  private closePromise: Promise<void> | undefined;
  private readonly admittedCalls = new Set<Promise<unknown>>();
  private readonly owned = new Set<WorkerHandle>();
  private readonly readiness = new Set<(error: unknown) => void>();
  private failure: unknown;
  private termination: Promise<void> | undefined;

  /** Calls waiting for a thread of their role (a respawn in progress), in issue order. */
  private readonly deferred: Readonly<Record<Role, PendingCall[]>> = { writer: [], reader: [] };
  private readonly respawning: Record<Role, number> = { writer: 0, reader: 0 };
  private readonly restartTimes: number[] = [];
  private restarts = 0;
  private circuitOpenUntil = 0;

  /**
   * W2's barrier. `writeSeq` counts writes issued; `committedSeq` is the
   * contiguous settled prefix, including failed calls. A read captures
   * `writeSeq` at issue time and waits for that entire prefix to settle.
   */
  private writeSeq = 0;
  private committedSeq = 0;
  private readonly settledWrites = new Set<number>();
  private readonly barrierWaiters: Array<{ upTo: number; release: () => void }> = [];

  private readonly config: ThreadBackendConfig & { readonly admittedKey: PersistedKey };

  private constructor(config: ThreadBackendConfig) {
    const admittedKey = config.admittedKey ?? resolveDatabaseKey({
      dbPath: config.path,
      ...(config.passphrase !== undefined ? { passphrase: config.passphrase } : {}),
      ...(config.keyHome !== undefined ? { keyHome: config.keyHome } : {}),
    });
    this.config = { ...config, admittedKey };
  }

  static async open(config: ThreadBackendConfig): Promise<ThreadBackend> {
    const readers = config.readers ?? defaultReadPoolSize();
    if (!Number.isSafeInteger(readers) || readers <= 0) {
      throw new ValidationError("Database reader count must be a positive safe integer.", "db_reader_count_invalid");
    }
    const backend = new ThreadBackend(config);
    backend.readerTarget = readers;
    // The WRITER opens first and alone, because it is the connection that runs
    // the migrations. A reader opened alongside it would race the schema it is
    // about to read — and a read-only connection cannot migrate, so it would
    // not race loudly, it would simply believe an older version.
    try {
      backend.writer = await backend.spawn("writer");
      const starts: Promise<WorkerHandle>[] = [];
      // Register rejection ownership immediately, including a synchronous later
      // Worker constructor failure before the whole start list exists.
      for (let index = 0; index < readers; index += 1) {
        const pending = backend.spawn("reader");
        void pending.catch(() => undefined);
        starts.push(pending);
      }
      backend.readers = await Promise.all(starts);
      if (backend.failure !== undefined) throw backend.failure;
    } catch (error) {
      backend.failAll(error);
      await backend.terminateOwned();
      throw backend.failure;
    }
    backend.opened = true;
    latestSupervision = () => backend.supervision();
    return backend;
  }

  private supervision(): DbThreadSupervision {
    const state = this.closed || this.closing ? "closed"
      : Date.now() < this.circuitOpenUntil ? "circuit-open"
      : this.respawning.writer + this.respawning.reader > 0 || this.writer === undefined || this.readers.length < this.readerTarget ? "restarting"
      : "ready";
    return Object.freeze({
      state, restarts: this.restarts, readers: this.readers.length,
      restartMax: this.config.restartMax ?? DEFAULT_DB_THREAD_RESTART_MAX,
      restartWindowMs: this.config.restartWindowMs ?? DEFAULT_DB_THREAD_RESTART_WINDOW_MS,
    });
  }

  private spawn(role: Role): Promise<WorkerHandle> {
    const workerData: DbWorkerData = {
      path: this.config.path,
      role,
      admittedKey: this.config.admittedKey,
      ...(this.config.busyTimeoutMs !== undefined ? { busyTimeoutMs: this.config.busyTimeoutMs } : {}),
      ...(this.config.synchronous !== undefined ? { synchronous: this.config.synchronous } : {}),
      ...(this.config.durabilityWindowMs !== undefined
        ? { durabilityWindowMs: this.config.durabilityWindowMs }
        : {}),
    };
    // Started on the prelude, which installs the fault policy before the
    // thread's entry loads: a supervised thread lives on a lost fault; an
    // uncaught one ends it (exit 70) and this facade respawns it.
    const worker = new Worker(...bootstrappedWorker(WORKER_URL, "server-thread", {
      workerData,
      // W3: this is what makes the ledger refuse to open on this thread. The
      // environment is assembled by the config owner, at the one place worker
      // threads are created, so a new worker cannot be added without the flag.
      env: dbWorkerEnv(),
    }));
    const handle: WorkerHandle = { worker, role, inFlight: 0, live: false, lost: false };
    this.owned.add(handle);
    // ANATOMY REGISTRATION — at the owner, on the spawn path: every db
    // thread is a registry component for exactly its lifetime. The exit
    // event fires on close()'s terminate() and on any crash, so the entry
    // leaves with the thread — and while a worker lingers (a failed open
    // leaves the thread object alive), the entry lingers with it, which is
    // the honest description of what is really running.
    const unregister = registerComponent({
      kind: "db-thread",
      label: `db ${role}`,
      provenance: "server/db/thread-backend.ts ThreadBackend.open",
      facts: { role, threadId: worker.threadId },
    });
    worker.once("exit", guarded("db.thread.unregister", () => { unregister(); this.owned.delete(handle); }));

    return new Promise<WorkerHandle>((resolve, reject) => {
      let settled = false;
      const refuseReady = (error: unknown) => { if (!settled) { settled = true; this.readiness.delete(refuseReady); reject(error); } };
      this.readiness.add(refuseReady);
      worker.on("message", guarded("db.thread.message", (msg: DbReply | DbReady | DbFailedToOpen) => {
        if ("ready" in msg) {
          if (settled) return;
          settled = true;
          this.readiness.delete(refuseReady);
          if (msg.ready) {
            if (role === "writer") this.facts = msg;
            handle.live = true;
            resolve(handle);
          } else {
            const error = decodeError(msg.error);
            reject(error);
            if (!this.opened) this.failAll(error);
            else void worker.terminate();
          }
          return;
        }
        this.settle(msg);
      }));
      worker.on("error", guarded("db.thread.error", (error: Error) => {
        refuseReady(error);
        if (this.opened) { if (handle.live) this.lose(handle); else void worker.terminate(); }
        else if (!this.closed) this.failAll(error);
      }));
      worker.on("exit", guarded("db.thread.exit", (code: number) => {
        const error = new WebError(
          `db ${role} thread exited unexpectedly (code ${code})`, "db_worker_exited", true,
        );
        refuseReady(this.failure ?? error);
        if (this.opened) { if (handle.live) this.lose(handle); }
        else if (!this.closed) this.failAll(error);
      }));
    });
  }

  private settle(msg: DbReply): void {
    const pending = this.pending.get(msg.id);
    if (pending === undefined) return;
    this.pending.delete(msg.id);
    if (pending.handle !== undefined) pending.handle.inFlight -= 1;
    if (msg.ok) pending.resolve(msg.value);
    else pending.reject(decodeError(msg.error));
  }

  /**
   * A supervised thread is gone (C4). Its calls are answered or retried, and
   * a replacement is started (or the circuit opens). Idempotent per thread;
   * a thread lost while the facade closes is the close's.
   */
  private lose(handle: WorkerHandle): void {
    if (handle.lost || this.closed) return;
    handle.lost = true;
    if (handle.role === "writer") {
      if (this.writer === handle) this.writer = undefined;
    } else {
      this.readers = this.readers.filter((reader) => reader !== handle);
    }
    void handle.worker.terminate();
    for (const [id, entry] of [...this.pending]) {
      if (entry.handle !== handle) continue;
      entry.handle = undefined;
      if (this.closing) {
        // The facade is closing: nothing is retried or restarted, but every
        // call the thread held is answered, or the close would wait forever.
        this.pending.delete(id);
        entry.reject(new WebError("the database facade closed while this call was in flight on a thread that stopped", "db_closed"));
        continue;
      }
      if (handle.role === "reader" && !entry.retried) {
        entry.retried = true;
        this.route(entry);
        continue;
      }
      this.pending.delete(id);
      entry.reject(handle.role === "writer"
        ? new WebError("the database writer stopped while this write was in flight; it may or may not have been committed", "db_write_outcome_unknown", false)
        : new WebError("the database reader stopped twice while serving this read", "db_read_lost", true));
    }
    if (!this.closing) this.restart(handle.role);
  }

  /** Start a replacement for a lost thread, unless the circuit is (or now becomes) open. */
  private restart(role: Role): void {
    if (this.closed || this.closing) { this.refuseDeferredClosed(); return; }
    const now = Date.now();
    const window = this.config.restartWindowMs ?? DEFAULT_DB_THREAD_RESTART_WINDOW_MS;
    while (this.restartTimes.length > 0 && now - this.restartTimes[0]! > window) this.restartTimes.shift();
    if (this.restartTimes.length >= (this.config.restartMax ?? DEFAULT_DB_THREAD_RESTART_MAX)) {
      this.circuitOpenUntil = now + window;
      webAlwaysOn("db", "database thread restart circuit opened", { role, restarts: this.restartTimes.length, windowMs: window });
      // What waits for this role is answered now, not held for a whole window.
      for (const entry of this.deferred[role].splice(0)) this.refuseUnavailable(entry);
      setTimeout(guarded("db.thread.circuit-retry", () => this.restart(role)), window).unref();
      return;
    }
    this.restartTimes.push(now);
    this.restarts += 1;
    this.respawning[role] += 1;
    webAlwaysOn("db", "restarting a lost database thread", { role, restarts: this.restarts });
    let spawning: Promise<WorkerHandle>;
    // A synchronous spawn failure (the Worker constructor) takes the same path as an asynchronous one.
    try { spawning = this.spawn(role); } catch (error) { spawning = Promise.reject(error); }
    spawning.then((handle) => {
      this.respawning[role] -= 1;
      if (this.closed || this.closing) { void handle.worker.terminate(); this.refuseDeferredClosed(); return; }
      // W1 has ONE writer and the pool its target: a replacement that finds
      // the role already filled is surplus, never a second live thread.
      const filled = role === "writer"
        ? this.writer !== undefined && !this.writer.lost
        : this.readers.length >= this.readerTarget;
      if (filled) { handle.lost = true; void handle.worker.terminate(); }
      else if (role === "writer") this.writer = handle;
      else this.readers.push(handle);
      for (const entry of this.deferred[role].splice(0)) this.route(entry);
    }, (error: unknown) => {
      this.respawning[role] -= 1;
      if (this.closed || this.closing) { this.refuseDeferredClosed(); return; }
      webAlwaysOn("db", "a database thread failed to restart", { role, fault: describeFaultLine(error) });
      this.restart(role);
    });
  }

  /** The facade is closing: a call held for a respawn is answered, or the close would wait on it forever (N2). */
  private refuseDeferredClosed(): void {
    for (const entry of [...this.deferred.writer.splice(0), ...this.deferred.reader.splice(0)]) this.refuseClosed(entry);
  }

  private refuseClosed(entry: PendingCall): void {
    this.pending.delete(entry.call.id);
    entry.reject(new WebError("the database facade is closed", "db_closed"));
  }

  private refuseUnavailable(entry: PendingCall): void {
    this.pending.delete(entry.call.id);
    entry.reject(new WebError(`the database ${entry.role} is unavailable: its threads kept stopping, so restarts pause for a while`, "db_unavailable", true));
  }

  /** Post a call to a live thread of its role, or hold it (in issue order) for the respawn in progress. */
  private route(entry: PendingCall): void {
    const handle = entry.role === "writer" ? this.writer : this.pickReader();
    if (handle === undefined) {
      if (this.closing || this.closed) this.refuseClosed(entry);
      else if (this.respawning[entry.role] === 0 && Date.now() < this.circuitOpenUntil) this.refuseUnavailable(entry);
      else this.deferred[entry.role].push(entry);
      return;
    }
    entry.handle = handle;
    handle.inFlight += 1;
    try { handle.worker.postMessage(entry.call); }
    catch (error) {
      handle.inFlight -= 1;
      entry.handle = undefined;
      this.pending.delete(entry.call.id);
      entry.reject(error);
    }
  }

  private failAll(err: unknown): void {
    this.failure ??= err;
    for (const refuse of this.readiness) refuse(this.failure);
    void this.terminateOwned();
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
    // Waiters would otherwise block on a barrier no surviving writer can
    // advance. Release them so their reads fail on the same error rather than
    // hanging behind a write that is never coming back.
    this.committedSeq = this.writeSeq;
    this.settledWrites.clear();
    this.releaseBarrier();
  }

  private terminateOwned(): Promise<void> {
    if (this.termination !== undefined) return this.termination;
    this.closed = true;
    for (const entry of [...this.deferred.writer.splice(0), ...this.deferred.reader.splice(0)]) {
      this.pending.delete(entry.call.id);
      entry.reject(this.failure ?? new WebError("the database facade is closed", "db_closed"));
    }
    this.termination = Promise.allSettled([...this.owned].map((handle) => handle.worker.terminate())).then(() => undefined);
    return this.termination;
  }

  private dispatch(role: Role, call: DbCall): Promise<unknown> {
    if (this.failure !== undefined) return this.terminateOwned().then(() => { throw this.failure; });
    if (this.closed) return Promise.reject(new WebError("the database facade is closed", "db_closed"));
    return new Promise((resolve, reject) => {
      const entry: PendingCall = { call, role, resolve, reject, handle: undefined, retried: false };
      this.pending.set(call.id, entry);
      this.route(entry);
    });
  }

  /** Post straight to one thread (the close handshake): never retried, never held. */
  private post(handle: WorkerHandle, call: DbCall): Promise<unknown> {
    if (this.failure !== undefined) return this.terminateOwned().then(() => { throw this.failure; });
    if (this.closed) return Promise.reject(new WebError("the database facade is closed", "db_closed"));
    return new Promise((resolve, reject) => {
      const entry: PendingCall = { call, role: handle.role, resolve, reject, handle, retried: true };
      this.pending.set(call.id, entry);
      handle.inFlight += 1;
      try { handle.worker.postMessage(call); }
      catch (error) { handle.inFlight -= 1; this.pending.delete(call.id); reject(error); }
    });
  }

  /** Least-loaded live reader. Round-robin would be worse here because read costs
   * differ by orders of magnitude — one 26,000-message history behind a queue
   * of point reads is precisely the pile-up to avoid. */
  private pickReader(): WorkerHandle | undefined {
    let best: WorkerHandle | undefined;
    for (const r of this.readers) if (best === undefined || r.inFlight < best.inFlight) best = r;
    return best;
  }

  private releaseBarrier(): void {
    for (let i = this.barrierWaiters.length - 1; i >= 0; i -= 1) {
      const waiter = this.barrierWaiters[i]!;
      if (waiter.upTo <= this.committedSeq) {
        this.barrierWaiters.splice(i, 1);
        waiter.release();
      }
    }
  }

  /** W2: resolve once every write issued before this point has settled. */
  private awaitWrites(upTo: number): Promise<void> | null {
    if (upTo <= this.committedSeq) return null;
    return new Promise<void>((release) => {
      this.barrierWaiters.push({ upTo, release });
    });
  }

  get connectionFacts(): DbConnectionFacts {
    return this.facts;
  }

  get readPoolSize(): number {
    return this.readers.length;
  }

  private admit<T>(work: () => Promise<T>): Promise<T> {
    if (this.failure !== undefined) return this.terminateOwned().then(() => { throw this.failure; });
    if (this.closed || this.closing) return Promise.reject(new WebError("the database facade is closed", "db_closed"));
    // Invoke immediately: write issue order and read frontiers belong to the
    // caller, not a later microtask. Close drains this exact admitted set.
    const pending = work();
    this.admittedCalls.add(pending);
    return pending.finally(() => { this.admittedCalls.delete(pending); });
  }

  call(method: string, args: readonly unknown[]): Promise<unknown> {
    return this.admit(async () => {
    const kind = methodKind(method);
    if (kind === null) {
      throw new ValidationError(
        `DbClient method "${method}" is not classified as a read or a write ` +
          "(server/db/method-kinds.ts) — refusing to dispatch it.",
        "db_method_unclassified",
      );
    }
    if (kind === "write") return this.callWrite({ id: this.nextId++, method, args });

    // W2: capture the write frontier at ISSUE time, not at dispatch time.
    // Capturing later would let a write issued after this read sneak into the
    // set this read waits for, which is a different (and wrong) guarantee.
    const frontier = this.writeSeq;
    const barrier = this.awaitWrites(frontier);
    if (barrier !== null) await barrier;
    return this.dispatch("reader", { id: this.nextId++, method, args });
    });
  }

  private async callWrite(call: DbCall): Promise<unknown> {
    const seq = ++this.writeSeq;
    try {
      return await this.dispatch("writer", call);
    } finally {
      // The frontier advances on OUTCOME, not on success. A failed write is
      // still a write that is no longer in flight, and leaving it uncommitted
      // would stall every later read behind a call that already finished.
      if (seq > this.committedSeq) this.settledWrites.add(seq);
      while (this.settledWrites.delete(this.committedSeq + 1)) this.committedSeq += 1;
      this.releaseBarrier();
    }
  }

  /** An ordered group run inside ONE transaction on the writer. */
  transaction(
    ops: ReadonlyArray<Readonly<{ method: string; args: readonly unknown[] }>>,
  ): Promise<unknown[]> {
    return this.admit(async () => {
    for (const op of ops) {
      if (methodKind(op.method) === null) {
        throw new ValidationError(
          `DbClient method "${op.method}" is not classified (server/db/method-kinds.ts).`,
          "db_method_unclassified",
        );
      }
    }
    const value = await this.callWrite({ id: this.nextId++, tx: ops });
    return value as unknown[];
    });
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.closing = true;
    this.closePromise = this.closeOwned();
    return this.closePromise;
  }

  private async closeOwned(): Promise<void> {
    // A call held for a respawn is an admitted call: answer it before
    // draining them, since no respawn completes once the facade closes.
    this.refuseDeferredClosed();
    await Promise.allSettled([...this.admittedCalls]);
    if (this.closed) { await this.termination; return; }
    // Healthy connections attempt their own checkpoint/close before joining.
    // A busy checkpoint is reported by its owner, not a durability guarantee.
    try {
      const live = [this.writer, ...this.readers].filter((handle): handle is WorkerHandle => handle !== undefined && !handle.lost);
      await Promise.all(live.map((handle) =>
        this.post(handle, { id: this.nextId++, method: "__close", args: [] }).catch(() => undefined),
      ));
    } finally { await this.terminateOwned(); }
  }
}
