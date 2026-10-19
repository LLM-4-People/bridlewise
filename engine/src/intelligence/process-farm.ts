/**
 * Parallel process farm — the 100x lever with true crash isolation.
 *
 * Why child processes and not worker_threads: a native/WASM tree-sitter
 * grammar trap must never take down the HTTP/orchestrator process.
 * worker_threads share the process address space, so a native abort kills
 * the main process; child processes have separate address spaces — a trap
 * kills only that child; the orchestrator survives and records the culprit
 * file. Production child is `farm-child.ts` (init tree-sitter at spawn,
 * then sync extract). Tests inject a stub via `childPath`.
 *
 * The 100x comes from:
 *   - N persistent children (one per core), each holding its own Rust
 *     bridge (the native engine), reused across every file it processes.
 *   - A shared pull queue: one file at a time, no fixed batches, so a slow
 *     file never starves a batch.
 *   - Per-file watchdog: each task has a hard deadline; on expiry only the
 *     offending child is SIGKILLed and replaced. Bounds a hang to seconds.
 *   - Crash attribution: the child announces the file it's about to parse
 *     BEFORE parsing, so the file in-flight at exit is the exact culprit.
 *
 * IPC: node IPC (process.send / on('message')) — structured messages, no
 * stdout pipe buffer to deadlock. The per-symbol `detail` is large, so the
 * child writes it directly to a per-file JSONL stream and only the
 * lightweight aggregate crosses IPC.
 *
 * Fidelity: every file goes through the native Rust engine.
 * Parallelism changes scheduling, not semantics.
 */

import { fork, type ChildProcess } from "node:child_process";
import { cpus } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_FARM_INIT_TIMEOUT_MS,
  DEFAULT_FARM_IPC_BATCH,
  DEFAULT_FARM_KILL_ESCALATION_MS,
  DEFAULT_FARM_MAX_INIT_FAILURES,
  DEFAULT_FARM_PER_FILE_TIMEOUT_MS,
  DEFAULT_FARM_RETRY_TIMEOUT_MS,
} from "./intelligence-config.ts";
import { handleError } from "../shared/debug/debug-system.ts";
import { guarded } from "../process/fault-policy.ts";

/** The farm child entry — init at spawn, then sync extract. */
export const FARM_CHILD_PATH = join(dirname(fileURLToPath(import.meta.url)), "farm-child.ts");
const IPC_BATCH = DEFAULT_FARM_IPC_BATCH;
const RETRY_TIMEOUT_MS = DEFAULT_FARM_RETRY_TIMEOUT_MS;
const PER_FILE_TIMEOUT_MS = DEFAULT_FARM_PER_FILE_TIMEOUT_MS;
const KILL_ESCALATION_MS = DEFAULT_FARM_KILL_ESCALATION_MS;
const MAX_INIT_FAILURES = DEFAULT_FARM_MAX_INIT_FAILURES;
const INIT_TIMEOUT_MS = DEFAULT_FARM_INIT_TIMEOUT_MS;

export type FarmFileInput = Readonly<{
  path: string;
  absolutePath: string;
}>;

export type FarmFileResult = Readonly<{
  path: string;
  ok: boolean;
  symbols: number;
  imports: number;
  /** Import classification: dependency edges (relative/internal) vs total. */
  importDepEdges?: number;
  importTotal?: number;
  exports: number;
  lineCount: number;
  byKind: Readonly<Record<string, number>>;
  calls: number;
  docstrings: number;
  signatures: number;
  /** Per-file richness counts. */
  withInherits?: number;
  withDecorators?: number;
  withAttributes?: number;
  withResolvedCalls?: number;
  withVisibility?: number;
  diagnostics: readonly string[];
  detail: readonly unknown[];
  errorName?: string;
  errorMessage?: string;
  /** Present on !ok extract failures that the child classified (e.g. unready). */
  errorCode?: string;
  latencyMs: number;
}>;

type ChildMsg =
  | { type: "ready" }
  | { type: "loading"; language: string }
  | { type: "loaded"; language: string }
  | { type: "starting"; path: string }
  | { type: "result"; result: FarmFileResult }
  | { type: "batch-result"; results: FarmFileResult[] };

type InitOutcome =
  | { ok: true }
  | { ok: false; language: string | null };

// Tuning constants live in ../config.ts (single owner). See IPC_BATCH,
// RETRY_TIMEOUT_MS there.

export async function runIsolatedProcess(
  files: readonly FarmFileInput[],
  languages: readonly string[],
  options: Readonly<{
    workers?: number;
    perFileTimeoutMs?: number;
    onResult?: (r: FarmFileResult) => void;
    /** Test seam: override the child entrypoint (defaults to FARM_CHILD_PATH).
     * Lets a test inject a stub child that hangs/crashes/never-readies to
     * exercise the farm's fault handling deterministically. Not for production
     * use. */
    childPath?: string;
    /** Test seam: override the init-failure cap (defaults to MAX_INIT_FAILURES)
     * and the init handshake timeout (defaults to INIT_TIMEOUT_MS). Lets a test
     * exercise the bounded-respawn / init-hang handling fast and
     * deterministically. Not for production use. */
    maxInitFailures?: number;
    initTimeoutMs?: number;
  }> = {},
): Promise<readonly FarmFileResult[]> {
  if (files.length === 0) return Object.freeze([]);
  const workerCount = Math.max(
    1,
    Math.min(options.workers ?? cpus().length, files.length),
  );
  const perFileTimeoutMs = options.perFileTimeoutMs ?? PER_FILE_TIMEOUT_MS;
  const maxInitFailures = options.maxInitFailures ?? MAX_INIT_FAILURES;
  const initTimeoutMs = options.initTimeoutMs ?? INIT_TIMEOUT_MS;

  const queue: FarmFileInput[] = [...files];
  const results = new Map<string, FarmFileResult>();
  // Files already streamed to the consumer via onResult. onResult is a side
  // channel (extract.ts appends each call to the detail JSONL), so it must fire
  // exactly once per file with the AUTHORITATIVE result. A crash-marked file is
  // deferred by the main loop and emitted by the retry pass with its final
  // outcome; this set guarantees no path is ever streamed twice. The final
  // `ordered` return is independent — built from `results`, always complete.
  const reported = new Set<string>();
  // Languages still asked of each child. A grammar that traps on load is
  // dropped so the rest of the project still maps — one broken WASM cannot
  // fail-closed the whole Isolated run.
  let liveLanguages = [...languages];

  const spawnChild = (): ChildProcess => {
    const c = fork(options.childPath ?? FARM_CHILD_PATH, [], {
      execArgv: ["--experimental-strip-types"],
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
    // The farm attaches one 'exit' + one 'message' listener per task; a
    // long-lived child serving hundreds of tasks would trip the default
    // 10-listener warning. Raise the cap — each listener is removed when
    // its task completes, so this is bounded by in-flight tasks, not total.
    c.setMaxListeners(0);
    return c;
  };

  /** Terminate a child reliably: SIGTERM, escalating to SIGKILL if it does not
   * die within the grace window. A bare SIGTERM is not guaranteed to reap a
   * Node child whose event loop is held open (an open readline on the Rust
   * bridge, a hung native grammar), which is how orphaned/runaway children
   * accumulate. Escalation only fires on a child that ignored SIGTERM. */
  const killChild = (c: ChildProcess): void => {
    if (c.killed || c.exitCode !== null) return;
    c.kill("SIGTERM");
    const escalate = setTimeout(guarded("intelligence.farm.kill-escalation", () => {
      if (!c.killed && c.exitCode === null) c.kill("SIGKILL");
    }), KILL_ESCALATION_MS);
    escalate.unref();
    c.once("exit", guarded("intelligence.farm.kill-escalation-cancel", () => clearTimeout(escalate)));
  };

  const dropPoisonLanguage = (language: string | null): boolean => {
    if (language === null) return false;
    if (!liveLanguages.includes(language)) return false;
    liveLanguages = liveLanguages.filter((id) => id !== language);
    return true;
  };

  /** Ready-wait that SETTLES on child death OR an init timeout — never hangs.
   * Each `loading`/`loaded` resets the timer so N languages do not share one
   * deadline; a single hung grammar still dies in `initTimeoutMs`. The last
   * `loading` language is the poison when the child dies mid-init. */
  const handshake = (c: ChildProcess): Promise<InitOutcome> =>
    new Promise((resolve) => {
      let settled = false;
      let lastLoading: string | null = null;
      let timer: ReturnType<typeof setTimeout>;
      const finish = (out: InitOutcome): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        c.off("message", onMsg);
        c.off("exit", onExit);
        resolve(out);
      };
      const arm = (): void => {
        clearTimeout(timer);
        timer = setTimeout(
          guarded("intelligence.farm.init-timeout", () => finish({ ok: false, language: lastLoading })),
          initTimeoutMs,
        );
      };
      const onMsg = guarded("intelligence.farm.message", (m: ChildMsg): void => {
        if (m.type === "loading") {
          lastLoading = m.language;
          arm();
          return;
        }
        if (m.type === "loaded") {
          arm();
          return;
        }
        if (m.type === "ready") finish({ ok: true });
      });
      const onExit = guarded("intelligence.farm.exit", (): void => finish({ ok: false, language: lastLoading }));
      arm();
      c.on("message", onMsg);
      c.once("exit", onExit);
      c.send({ type: "init", languages: liveLanguages });
    });

  const runChildLoop = async (): Promise<void> => {
    let child = spawnChild();
    let ready = false;
    let currentPath: string | null = null;
    // Consecutive init failures. Bounded by MAX_INIT_FAILURES so a child that
    // can NEVER initialize (a grammar trapping on load, a missing engine
    // binary) cannot respawn forever — the loop drains its remaining files as
    // ParserCrash so the farm terminates and the retry pass re-isolates them.
    // Dropping a poison language is progress, not a failure: the counter
    // resets so remaining grammars still get a child.
    let initFailures = 0;

    // The first child is awaited before the loop; on failure `ready` stays false
    // and the while-loop's respawn branch (bounded by MAX_INIT_FAILURES) owns
    // recovery. No recursion here — a recursive retry would reset the failure
    // counter and defeat the bound, turning a persistent init failure into an
    // unbounded respawn loop.
    const first = await handshake(child);
    if (first.ok) {
      ready = true;
    } else {
      handleError(
        new Error(first.language === null
          ? "child failed init"
          : `child failed init while loading ${first.language}`),
        { module: "intelligence-process-farm", operation: "waitReady" },
      );
      killChild(child);
      ready = false;
      if (!dropPoisonLanguage(first.language)) initFailures = 1;
    }

    const processBatch = (batch: readonly FarmFileInput[]): Promise<FarmFileResult[]> =>
      new Promise((resolve) => {
        let settled = false;
        const byPath = new Map<string, FarmFileResult>();
        const finishAll = (): void => {
          if (settled) return;
          settled = true;
          clearTimeout(watchdog);
          child.off("message", onMsg);
          // Fill any files the child never reported (crash mid-batch).
          for (const f of batch) {
            if (!byPath.has(f.path)) {
              byPath.set(f.path, Object.freeze({
                path: f.path,
                ok: false,
                symbols: 0,
                imports: 0,
                exports: 0,
                lineCount: 0,
                byKind: Object.freeze({}),
                calls: 0,
                docstrings: 0,
                signatures: 0,
                diagnostics: Object.freeze([]),
                detail: Object.freeze([]),
                errorName: "ParserCrash",
                errorMessage: `child died during batch; in-flight file: ${currentPath ?? "unknown"}`,
                latencyMs: 0,
              }));
            }
          }
          resolve(batch.map((f) => byPath.get(f.path)!));
        };
        const onMsg = guarded("intelligence.farm.message", (m: ChildMsg): void => {
          if (m.type === "starting") currentPath = m.path;
          if (m.type === "batch-result") {
            for (const r of m.results) byPath.set(r.path, r);
            finishAll();
          }
        });
        const onExit = guarded("intelligence.farm.exit", (): void => {
          // Hard crash mid-batch: the in-flight file is the culprit, the
          // rest are victims. finishAll fills the missing as ParserCrash.
          finishAll();
          child.off("exit", onExit);
        });
        const watchdog = setTimeout(guarded("intelligence.farm.batch-watchdog", () => {
          child.kill("SIGKILL");
        }), perFileTimeoutMs * batch.length); // batch-scaled deadline
        child.on("message", onMsg);
        child.once("exit", onExit);
        child.send({ type: "parse-batch", files: batch });
      });

    while (queue.length > 0) {
      if (!ready || child.killed || child.exitCode !== null) {
        if (initFailures >= maxInitFailures) {
          // Init is persistently failing: stop fork-bombing replacements and
          // mark every file this loop still holds as crashed so it reaches the
          // retry pass (which isolates one file per child) instead of hanging.
          while (queue.length > 0) {
            const f = queue.shift()!;
            results.set(f.path, Object.freeze({
              path: f.path, ok: false, symbols: 0, imports: 0, exports: 0, lineCount: 0,
              byKind: Object.freeze({}), calls: 0, docstrings: 0, signatures: 0,
              diagnostics: Object.freeze([]), detail: Object.freeze([]),
              errorName: "ParserCrash",
              errorMessage: "child failed to initialize (repeated init failure)",
              latencyMs: 0,
            }));
          }
          break;
        }
        child = spawnChild();
        const again = await handshake(child);
        if (again.ok) {
          initFailures = 0;
          ready = true;
        } else {
          handleError(
            new Error(again.language === null
              ? "child failed init"
              : `child failed init while loading ${again.language}`),
            { module: "intelligence-process-farm", operation: "waitReady" },
          );
          if (!dropPoisonLanguage(again.language)) initFailures += 1;
          killChild(child);
          ready = false;
          continue;
        }
      }
      // Pull up to IPC_BATCH files for this child.
      const batch: FarmFileInput[] = [];
      while (batch.length < IPC_BATCH && queue.length > 0) batch.push(queue.shift()!);
      const batchResults = await processBatch(batch);
      for (const result of batchResults) {
        results.set(result.path, result);
        // onResult is a streaming side channel (extract.ts appends each call to
        // the detail JSONL). Emit exactly once per file with its AUTHORITATIVE
        // result: a crash-marked file is deferred to the retry pass (which
        // re-emits it with its final outcome), so the consumer never sees a
        // transient ParserCrash followed by a corrected retry result.
        if (result.ok || (result.errorName !== "ParserCrash" && result.errorName !== "ParserHang")) {
          if (!reported.has(result.path)) {
            reported.add(result.path);
            options.onResult?.(result);
          }
        }
      }
    }
    killChild(child);
  };

  await Promise.all(Array.from({ length: workerCount }, () => runChildLoop()));

  // Victim-recovery pass: every file blamed as ParserCrash/ParserHang gets one
  // retry, batched at IPC_BATCH=1 so a hang blames exactly that file. We retry
  // ALL crashed files rather than trusting the main loop's `in-flight file`
  // label to skip a "true culprit" — that label is set by an async `starting`
  // message that races the crash, so it can mislabel (blame an innocent file
  // and skip the real culprit, or vice versa). Retrying all crashed files is
  // race-free: the true culprit simply re-hangs and is re-isolated by the
  // retry's own per-file watchdog; the victims parse cleanly and are restored.
  // This runs AFTER the main loops so it never blocks the bulk throughput.
    const crashed = files.filter((f) => {
    const r = results.get(f.path);
    return r !== undefined && !r.ok && (r.errorName === "ParserCrash" || r.errorName === "ParserHang");
  });
  const victims = crashed;
  if (victims.length > 0) {
    // Reuse the loop machinery: a small farm over just the victim files,
    // one file per IPC message for exact attribution.
    const retryQueue = [...victims];
    // Set when ANY lane hits the init-failure cap (persistent init failure).
    // The lanes share one mutable retryQueue, and a lane's check-then-shift is
    // interleaved with other lanes across the await points (waitReady,
    // processSingle) — so a lane must NOT signal "stop" by mutating the shared
    // queue's length (that races a sibling's in-flight shift() into yielding
    // undefined). It sets this flag instead; the remaining victims are drained
    // synchronously below, after all lanes settle, so no shift ever races.
    let retryAborted = false;
    const runRetryLoop = async (): Promise<void> => {
      // The first child is spawned as "not ready" (ready=false) so the loop's
      // respawn-and-wait branch always runs waitReady before any parse-batch —
      // a retry child must never receive work before it has announced "ready".
      // (Spawning eagerly and skipping the wait on the first iteration let a
      // never-initialized child receive a parse-batch.)
      let child: ChildProcess | null = null;
      let currentPath: string | null = null;
      // Ready-wait that SETTLES on child death or a timeout, not just on
      // "ready". A retry child that dies during init must reject (so the caller
      // can spawn another) rather than hang the whole run after the bulk work
      // succeeded. Mirrors the main loop's once("exit") + watchdog.
      const waitReady = (c: ChildProcess): Promise<InitOutcome> => handshake(c);

      const processSingle = (c: ChildProcess, input: FarmFileInput): Promise<FarmFileResult> =>
        new Promise((resolve) => {
          let settled = false;
          const finish = (r: FarmFileResult): void => {
            if (settled) return;
            settled = true;
            clearTimeout(watchdog);
            c.off("message", onMsg);
            resolve(r);
          };
          const onMsg = guarded("intelligence.farm.message", (m: ChildMsg): void => {
            if (m.type === "starting") currentPath = m.path;
            if (m.type === "batch-result" && m.results.length > 0) finish(m.results[0]!);
            if (m.type === "result") finish(m.result);
          });
          const onExit = guarded("intelligence.farm.exit", (): void => {
            finish(Object.freeze({
              path: currentPath ?? input.path, ok: false, symbols: 0, imports: 0, exports: 0, lineCount: 0,
              byKind: Object.freeze({}), calls: 0, docstrings: 0, signatures: 0,
              diagnostics: Object.freeze([]), detail: Object.freeze([]),
              errorName: "ParserCrash", errorMessage: "child exited during retry", latencyMs: 0,
            }));
            c.off("exit", onExit);
          });
          const watchdog = setTimeout(guarded("intelligence.farm.retry-watchdog", () => { c.kill("SIGKILL"); }), RETRY_TIMEOUT_MS);
          c.on("message", onMsg);
          c.once("exit", onExit);
          c.send({ type: "parse-batch", files: [input] });
        });

      // Bound consecutive init failures exactly as in the main loop, so a retry
      // child that can never initialize cannot respawn forever; the lane's
      // remaining victims are left as their main-loop ParserCrash result (the
      // run still terminates, and those files keep an accurate crash verdict).
      let initFailures = 0;
      while (!retryAborted && retryQueue.length > 0) {
        // Spawn + ready the lane's child whenever there isn't a live, readied
        // one — including the FIRST iteration (child starts null), so a retry
        // child is always initialized before it receives a parse-batch.
        if (child === null || child.killed || child.exitCode !== null) {
          if (initFailures >= maxInitFailures) {
            // Init is persistently failing: stop respawning. Signal the other
            // lanes to stop at their next iteration via the flag — do NOT
            // mutate the shared retryQueue's length here, which would race a
            // sibling's in-flight shift() into yielding undefined. The
            // remaining victims are emitted after all lanes settle (below).
            retryAborted = true;
            break;
          }
          child = spawnChild();
          const again = await waitReady(child);
          if (again.ok) {
            initFailures = 0;
          } else {
            handleError(
              new Error(again.language === null
                ? "retry child failed init"
                : `retry child failed init while loading ${again.language}`),
              { module: "intelligence-process-farm", operation: "waitReady" },
            );
            if (!dropPoisonLanguage(again.language)) initFailures += 1;
            killChild(child);
            child = null;
            continue;
          }
        }
        // Defensive re-check: another lane may have drained the last victim
        // while this lane was awaiting its child. Never shift from an empty
        // queue (would send an undefined file to the child).
        if (retryQueue.length === 0) break;
        const live = child;
        const input = retryQueue.shift()!;
        const result = await processSingle(live, input);
        results.set(input.path, result);
        // Authoritative re-emission of a crash-marked file (deferred by the main
        // loop). Dedup so a file is never streamed twice.
        if (!reported.has(input.path)) {
          reported.add(input.path);
          options.onResult?.(result);
        }
      }
      if (child !== null) killChild(child);
    };
    // A few parallel retry lanes so genuine hangs don't serialize the pass.
    const retryLanes = Math.min(4, victims.length);
    await Promise.all(Array.from({ length: retryLanes }, () => runRetryLoop()));
    // If a lane aborted on persistent init failure, the victims it left in the
    // shared queue were never retried. They keep their main-loop ParserCrash
    // verdict (accurate), but the main loop DEFERRED their onResult emission
    // (expecting the retry pass to re-emit) — so emit it here, exactly once,
    // to keep the every-file-streamed-exactly-once contract. This drains after
    // all lanes settle, so it never races a lane's shift().
    if (retryAborted) {
      for (const v of retryQueue) {
        const existing = results.get(v.path);
        if (existing !== undefined && !reported.has(v.path)) {
          reported.add(v.path);
          options.onResult?.(existing);
        }
      }
      retryQueue.length = 0;
    }
  }

  const ordered = files.map((f) => results.get(f.path)!).filter((r) => r !== undefined);
  return Object.freeze(ordered);
}
