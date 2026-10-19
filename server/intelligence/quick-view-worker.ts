/**
 * Quick-view index worker thread entry point.
 *
 * Runs the CPU-heavy `QuickViewIndex` build (which walks + babel-parses every
 * JS/TS source file in a project) OFF the Node main event loop so the HTTP
 * server never blocks — the same wedge class as the HTTP 502 chat-run fix
 * (repository-map-worker.ts). The quick-view index is triggered by an LLM
 * `quick_view` tool call; building it synchronously on a cache miss wedged
 * the single-threaded server for seconds on a 475+ module codebase.
 *
 * The parent thread (intelligence-bridge.ts) spawns this worker on a cache
 * miss, sends `{ projectPath }` via `workerData`, and awaits the `message`
 * event. The worker builds the index, exports its serializable built state
 * via `toBuiltState` (drops the heavy AST cache — query only needs the
 * index Maps), and posts back either `{ ok: true, state }` or
 * `{ ok: false, error }`. The main thread rehydrates the index from the
 * state via `QuickViewIndex.fromBuiltState` so the index's `query`
 * method works on the main thread (structured clone cannot transfer class
 * instances with their prototype methods, hence the state round-trip).
 *
 * Built-in `node:worker_threads` — no new runtime dependency.
 */
import { parentPort, workerData } from "node:worker_threads";
import { QuickViewIndex, type QuickViewBuiltState } from "../../engine/src/intelligence/quick-view.ts";
import { postWorkerResult } from "../run/worker-ipc.ts";

type WorkerOk = Readonly<{ ok: true; state: QuickViewBuiltState }>;
type WorkerErr = Readonly<{ ok: false; error: Readonly<{ message: string; code?: string }> }>;
type WorkerResult = WorkerOk | WorkerErr;

// (No Scattered Helpers): the local `post` helper is removed —
// `postWorkerResult` (server/worker-ipc.ts) is the single owner of the
// worker→parent IPC forward, shared with the other worker entry points.
// The `satisfies WorkerResult` checks keep the payload type aliases used
// (noUnusedLocals) + type-check the posted shape.

if (parentPort === null) {
  // Spawned without a parent port (e.g. run directly) — nothing to do.
  process.exit(1);
}

const input = workerData as Readonly<{ projectPath: string }> | undefined;
if (input === undefined || typeof input.projectPath !== "string" || input.projectPath.length === 0) {
  postWorkerResult({ ok: false, error: { message: "Worker requires a non-empty projectPath.", code: "quick_view_worker_bad_input" } } satisfies WorkerResult);
} else {
  try {
    const index = new QuickViewIndex(input.projectPath);
    postWorkerResult({ ok: true, state: index.toBuiltState() } satisfies WorkerResult);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: string } | null)?.code;
    postWorkerResult({ ok: false, error: { message, ...(code !== undefined ? { code } : {}) } } satisfies WorkerResult);
  }
}
